import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir, restartScript, codexConnectWaitMs, codexConnectTimeoutMs, codexTurnTimeoutMs, codexWorkDir } from "./config.js";
import { cleanText } from "./utils.js";
import { broadcast } from "./sse.js";
import {
  readState, writeState, draftForState, saveDraftForState,
  followModeForState, saveFollowModeForState, rememberMessageMeta,
  readThreadNames, threadName,
  readThreadCompletions, setThreadCompletion, syncLoadedCounts,
  modelSettingsForThread, saveThreadModelSettings, deleteThreadModelSettings,
  updateStateModelSettings
} from "./store.js";
import { stateAbsoluteCwd, safeStateCwdValue, stateCwdValue, assertProjectDirectory } from "./paths.js";
import {
  threadTitle, loadThreadFromProvider, deleteThreadFromProvider,
  localSessionProvider, listSessionEntries, mergeLocalMessageMeta,
  freshContextUsage, assistantBubbleText
} from "./threads.js";
import { createLocalAppServer } from "./codex-server.js";
import {
  connectorSupportsConcurrentAppServers, createConnectorAppServer,
  connectorThreadSummaries, getConnectorAppServer, remoteSessionProvider, isConnectorOnline
} from "./connectors.js";
import {
  completionMessage, failureNotificationMessage, notifyWechatTaskDone, sendWebPushTaskDone
} from "./webpush.js";
import { sendNativeTaskDone } from "./native-notifications.js";
import {
  activeLiveVoiceThreadSnapshots,
  interruptLiveVoiceThreadTask,
  isLiveVoiceThreadActive,
  liveVoiceThreadSnapshot,
  sendLiveVoiceThreadInput
} from "./live-voice/leases.js";
import {
  externalRunningSnapshots, externalSessionSnapshot, externalSnapshotFromThread,
  isExternalTaskRunning, monitorExternalSession, refreshExternalSession,
  stopExternalSessionMonitor
} from "./external-sessions.js";

export const runners = new Map();
const runnerCreations = new Map();
export let selectedRunnerKey = "";
export let followMode = "queue";
export let contextUsage = null;

const reasoningEffortLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra"
};

function reasoningEffortLabel(value) {
  return reasoningEffortLabels[String(value || "").toLowerCase()] || String(value || "");
}

function fastModeLabel(status = null) {
  if (!status) return "未知";
  if (status.enabled) return "已开启";
  if (!status.featureEnabled) return "不可用（fast_mode 已禁用）";
  if (!status.supported) return "当前模型不支持";
  return "已关闭";
}

function fastModeStatusMessage(status = {}) {
  const serviceTier = status.serviceTier || "标准";
  const rows = [
    `Fast 模式：**${fastModeLabel(status)}**`,
    "",
    `- 当前模型：\`${status.model || "默认"}\``,
    `- 当前服务层：\`${serviceTier}\``,
    `- 模型支持 Fast：${status.supported ? "是" : "否"}`,
    `- 后续会话默认：${status.configuredEnabled ? "Fast" : "标准"}`
  ];
  if (status.enabled) {
    rows.push("- Fast 模式会提高响应速度，但会更快消耗使用额度。");
  }
  rows.push("", "用法：`/fast`（切换）、`/fast on`、`/fast off`、`/fast status`");
  return rows.join("\n");
}

const modelDescriptionsZh = {
  "gemini-3.6-flash-high": "Gemini 3.6 Flash 高强度快速模型，适合需要快速响应的任务。",
  "mimo-v2.5-pro": "mimo-v2.5-pro 自定义模型，适合需要深度推理与开发的任务。",
  "gpt-5.6-sol": "最新的前沿智能体编程模型，适合复杂任务。",
  "gpt-5.6-terra": "能力与速度均衡，适合日常开发工作。",
  "gpt-5.6-luna": "快速且经济，适合较轻量的编程任务。",
  "gpt-5.5": "适合复杂编程、研究和综合工作的前沿模型。",
  "gpt-5.4": "能力稳定，适合常规编程任务。",
  "gpt-5.4-mini": "小型、快速且成本较低，适合简单任务。"
};

const reasoningEffortDescriptionsZh = {
  low: "响应更快，使用较少推理。",
  medium: "在速度和推理深度之间取得平衡。",
  high: "提供更深入的推理，适合复杂问题。",
  xhigh: "使用超高推理深度处理复杂问题。",
  max: "使用最大推理深度处理高难度问题。",
  ultra: "最大推理强度，并可自动分派任务。"
};

export function setSelectedRunnerKey(key) { selectedRunnerKey = key; }
export function setFollowMode(mode) { followMode = mode; }

let localAppServer = null;
const settingsBoundServers = new WeakSet();

async function applyAppServerThreadSettings(update = {}, connectorId = "") {
  if (!update.threadId || !update.model) return;
  const settings = {
    model: update.model,
    reasoningEffort: update.reasoningEffort || "",
    updatedAt: update.updatedAt || new Date().toISOString(),
    source: update.source || "app-server"
  };
  for (const runner of uniqueRunners()) {
    if ((runner.connectorId || "") !== connectorId || runner.state.threadId !== update.threadId) continue;
    runner.state.model = settings.model;
    runner.state.reasoningEffort = settings.reasoningEffort;
    runner.state.modelSettingsUpdatedAt = settings.updatedAt;
    runner.state.modelSettingsSource = settings.source;
  }
  broadcast({
    type: "model_settings_update",
    connectorId,
    threadId: update.threadId,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    modelSettingsUpdatedAt: settings.updatedAt,
    modelSettingsSource: settings.source
  });
  await saveThreadModelSettings(update.threadId, settings, connectorId);
}

function bindAppServerSettings(server, connectorId = "") {
  if (!server || settingsBoundServers.has(server)) return server;
  settingsBoundServers.add(server);
  server.onThreadSettingsUpdate = (update) => applyAppServerThreadSettings(update, connectorId);
  return server;
}

function getLocalAppServer() {
  if (!localAppServer) localAppServer = bindAppServerSettings(createLocalAppServer(), "");
  return localAppServer;
}

export function appServerForState(state = {}) {
  if (state.connectorId) return bindAppServerSettings(getConnectorAppServer(state.connectorId), state.connectorId);
  return getLocalAppServer();
}

// A CodexAppServer tracks exactly one active turn. Keep the singleton above as
// an idle control channel, but give every local conversation its own client
// connection so different threads can run at the same time. Connector agents
// currently expose one app-server channel, so they continue to share it.
export function runnerAppServerForState(state = {}) {
  if (state.connectorId) {
    return bindAppServerSettings(
      connectorSupportsConcurrentAppServers(state.connectorId)
        ? createConnectorAppServer(state.connectorId)
        : getConnectorAppServer(state.connectorId),
      state.connectorId
    );
  }
  return bindAppServerSettings(createLocalAppServer(), "");
}

async function sessionModelSettings(state = {}) {
  if (state.threadId) {
    const saved = await modelSettingsForThread(state.threadId, state.connectorId || "");
    if (saved?.model) return saved;
    const provider = state.connectorId ? remoteSessionProvider(state.connectorId) : localSessionProvider;
    const thread = await loadThreadFromProvider(state.threadId, provider).catch(() => null);
    if (thread?.model) {
      const inferred = {
        model: thread.model,
        reasoningEffort: thread.reasoningEffort || "",
        updatedAt: thread.settingsUpdatedAt || thread.updatedAt || new Date().toISOString(),
        source: "session"
      };
      await saveThreadModelSettings(state.threadId, inferred, state.connectorId || "");
      return inferred;
    }
  }
  const server = appServerForState(state);
  const cwd = state.connectorId ? String(state.cwd || "") : stateAbsoluteCwd(state.cwd || "");
  return server.configuredModelSettings(cwd);
}

function settingsTime(value = "") {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function observedModelSettings(thread = null) {
  if (!thread?.model) return null;
  return {
    model: thread.model,
    reasoningEffort: thread.reasoningEffort || "",
    updatedAt: thread.settingsUpdatedAt || "",
    source: "session"
  };
}

export function preferredModelSettings(saved = null, observed = null) {
  if (!saved?.model) return observed;
  if (!observed?.model) return saved;
  const savedAt = settingsTime(saved.updatedAt);
  const observedAt = settingsTime(observed.updatedAt);
  if (!observedAt) return saved;
  if (!savedAt || observedAt >= savedAt) return observed;
  return saved;
}

export async function ensureStateModelSettings(state = {}, observedThread = null) {
  const connectorId = state.connectorId || "";
  if (state.threadId) {
    const saved = await modelSettingsForThread(state.threadId, connectorId);
    const observed = observedModelSettings(observedThread);
    const preferred = preferredModelSettings(saved, observed);
    if (preferred?.model) {
      state.model = preferred.model;
      state.reasoningEffort = preferred.reasoningEffort || "";
      state.modelSettingsUpdatedAt = preferred.updatedAt || "";
      state.modelSettingsSource = preferred.source || "";
      if (preferred === observed && (
        saved?.model !== observed.model
        || saved?.reasoningEffort !== observed.reasoningEffort
        || saved?.updatedAt !== observed.updatedAt
      )) {
        await saveThreadModelSettings(state.threadId, observed, connectorId);
      }
      return state;
    }
  }
  if (state.model) {
    if (!state.modelSettingsUpdatedAt) state.modelSettingsUpdatedAt = new Date(0).toISOString();
    state.modelSettingsSource = state.modelSettingsSource || "legacy-state";
    if (state.threadId) await saveThreadModelSettings(state.threadId, {
      ...state,
      updatedAt: state.modelSettingsUpdatedAt,
      source: state.modelSettingsSource
    }, connectorId);
    return state;
  }
  const settings = await sessionModelSettings(state);
  state.model = state.model || settings.model || "";
  state.reasoningEffort = state.reasoningEffort || settings.reasoningEffort || "";
  state.modelSettingsUpdatedAt = state.modelSettingsUpdatedAt || settings.updatedAt || "";
  state.modelSettingsSource = state.modelSettingsSource || settings.source || "config";
  return state;
}

export async function syncSharedThreadSettings(state = {}) {
  if (state.connectorId || !state.threadId) return state;
  const server = appServerForState(state);
  const socketPath = server.transport?.preferred?.socketPath;
  if (!socketPath || !existsSync(socketPath)) return state;
  await server.ensureStarted();
  if (!server.usingSharedAppServer || server.turn) return state;
  const live = await server.readThreadSettings(
    state.threadId,
    stateAbsoluteCwd(state.cwd || ""),
    { model: state.model || "", reasoningEffort: state.reasoningEffort || "" }
  );
  if (!live?.model) return state;
  if (live.model === state.model && (live.reasoningEffort || "") === (state.reasoningEffort || "")) return state;
  state.model = live.model;
  state.reasoningEffort = live.reasoningEffort || "";
  state.modelSettingsUpdatedAt = new Date().toISOString();
  state.modelSettingsSource = "app-server";
  await saveThreadModelSettings(state.threadId, {
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    updatedAt: state.modelSettingsUpdatedAt,
    source: state.modelSettingsSource
  }, "");
  return state;
}

async function saveStateModelSettings(state = {}, runner = null, options = {}) {
  const updatedAt = options.updatedAt || new Date().toISOString();
  const source = options.source || "web";
  state.modelSettingsUpdatedAt = updatedAt;
  state.modelSettingsSource = source;
  if (state.threadId) await saveThreadModelSettings(state.threadId, {
    ...state,
    updatedAt,
    source
  }, state.connectorId || "");
  if (runner) {
    runner.state.model = state.model || "";
    runner.state.reasoningEffort = state.reasoningEffort || "";
    runner.state.modelSettingsUpdatedAt = updatedAt;
    runner.state.modelSettingsSource = source;
  }
  await updateStateModelSettings(state, {
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    updatedAt,
    source
  }, state.connectorId || "");
}

function publicModelSettings(state = {}, models = [], running = false) {
  return {
    threadId: state.threadId || "",
    model: state.model || "",
    reasoningEffort: state.reasoningEffort || "",
    modelSettingsUpdatedAt: state.modelSettingsUpdatedAt || "",
    modelSettingsSource: state.modelSettingsSource || "",
    running,
    models: models.map((item) => ({
      id: item.id || item.model,
      model: item.model || item.id,
      displayName: item.displayName || item.model || item.id,
      description: modelDescriptionsZh[item.model || item.id] || "Codex CLI 当前可用的模型。",
      defaultReasoningEffort: item.defaultReasoningEffort || "",
      supportedReasoningEfforts: (item.supportedReasoningEfforts || []).map((option) => ({
        reasoningEffort: option.reasoningEffort,
        label: reasoningEffortLabel(option.reasoningEffort),
        description: reasoningEffortDescriptionsZh[option.reasoningEffort] || ""
      }))
    }))
  };
}

export async function sessionModelSettingsPayload(connectorId = "") {
  const state = await readState(connectorId);
  state.connectorId = state.connectorId || connectorId;
  const runner = await runnerForState(state, false);
  const liveVoice = !connectorId && state.threadId
    ? liveVoiceThreadSnapshot(state.threadId)
    : null;
  const external = runner?.running || liveVoice
    ? null
    : await externalStatusForState(state, true);
  const running = Boolean(runner?.running || liveVoice || external?.running);
  const selectedState = runner?.state || state;
  await ensureStateModelSettings(selectedState, external);
  const server = runner?.appServer || appServerForState(selectedState);
  const models = await server.modelOptions();
  if (!connectorId && selectedState.threadId && server.usingSharedAppServer && !server.turn) {
    const cwd = stateAbsoluteCwd(selectedState.cwd || "");
    const live = await server.readThreadSettings(selectedState.threadId, cwd, {
      model: selectedState.model || "",
      reasoningEffort: selectedState.reasoningEffort || ""
    }).catch(() => null);
    if (live?.model && (
      live.model !== selectedState.model
      || (live.reasoningEffort || "") !== (selectedState.reasoningEffort || "")
    )) {
      selectedState.model = live.model;
      selectedState.reasoningEffort = live.reasoningEffort || "";
      selectedState.modelSettingsUpdatedAt = new Date().toISOString();
      selectedState.modelSettingsSource = "app-server";
      await saveThreadModelSettings(selectedState.threadId, {
        model: selectedState.model,
        reasoningEffort: selectedState.reasoningEffort,
        updatedAt: selectedState.modelSettingsUpdatedAt,
        source: selectedState.modelSettingsSource
      }, "");
    }
  }
  if (!runner?.running) {
    await updateStateModelSettings(selectedState, {
      model: selectedState.model,
      reasoningEffort: selectedState.reasoningEffort,
      updatedAt: selectedState.modelSettingsUpdatedAt,
      source: selectedState.modelSettingsSource
    }, connectorId);
  }
  return publicModelSettings(selectedState, models, running);
}

export async function updateSessionModelSettings(update = {}, connectorId = "") {
  const state = await readState(connectorId);
  state.connectorId = state.connectorId || connectorId;
  const runner = await runnerForState(state, false);
  if (runner?.running) throw Object.assign(new Error("当前会话正在处理，请结束或中断后再切换。"), { statusCode: 409 });
  if (!connectorId && state.threadId && isLiveVoiceThreadActive(state.threadId)) {
    throw Object.assign(
      new Error("当前会话正在由 Live Voice 使用，请关闭语音并等待任务结束后再切换模型。"),
      { statusCode: 409 }
    );
  }
  const observed = await assertExternalSessionIdle(state);
  await ensureStateModelSettings(state, observed);
  const server = runner?.appServer || appServerForState(state);
  const cwd = state.connectorId ? String(state.cwd || "") : stateAbsoluteCwd(state.cwd || "");
  if (update.model) {
    const result = await server.selectModel(update.model, state.reasoningEffort, state.threadId, cwd);
    state.model = result.model || result.selected.model || result.selected.id;
    state.reasoningEffort = result.effort;
  }
  if (update.reasoningEffort) {
    const result = await server.selectReasoningEffort(update.reasoningEffort, state.model, state.threadId, cwd);
    state.model = result.model || result.selected.model || result.selected.id;
    state.reasoningEffort = result.option.reasoningEffort;
  }
  if (!update.model && !update.reasoningEffort) {
    throw Object.assign(new Error("请选择模型或思考强度。"), { statusCode: 400 });
  }
  await saveStateModelSettings(state, runner);
  return publicModelSettings(state, await server.modelOptions(), false);
}

function publicUsagePayload(result = {}) {
  const limits = result.rateLimits || {};
  const resetCredits = result.rateLimitResetCredits || {};
  const credits = Array.isArray(resetCredits.credits) ? resetCredits.credits : [];
  return {
    planType: limits.planType || "",
    primary: limits.primary || null,
    secondary: limits.secondary || null,
    resetCredits: {
      availableCount: Number(resetCredits.availableCount) || 0,
      credits: credits.map((credit) => ({
        id: credit.id || "",
        title: credit.title || "",
        description: credit.description || "",
        expiresAt: Number(credit.expiresAt) || 0,
        status: credit.status || ""
      }))
    }
  };
}

export async function usagePayload(connectorId = "") {
  const state = await readState(connectorId);
  state.connectorId = state.connectorId || connectorId;
  const runner = await runnerForState(state, false);
  const server = runner?.appServer || appServerForState(state);
  return publicUsagePayload(await server.readRateLimits());
}

export async function resetUsageLimit(creditId = "", connectorId = "") {
  const state = await readState(connectorId);
  state.connectorId = state.connectorId || connectorId;
  const runner = await runnerForState(state, false);
  const server = runner?.appServer || appServerForState(state);
  const before = await server.readRateLimits();
  const credits = before.rateLimitResetCredits?.credits || [];
  const credit = credits.find((item) => item.id === creditId && item.status === "available")
    || credits.find((item) => item.status === "available");
  if (!credit) throw Object.assign(new Error("没有可用的使用限额重置次数。"), { statusCode: 409 });
  await server.consumeRateLimitResetCredit(credit.id);
  return publicUsagePayload(await server.readRateLimits());
}

function resolveAbsoluteCwd(state = {}) {
  return state.connectorId ? String(state.cwd || "") : stateAbsoluteCwd(state.cwd || "");
}

export function runnerKeyForState(state = {}) {
  const c = state.connectorId || "";
  const base = state.threadId
    ? `thread:${state.threadId}`
    : state.runtimeId
      ? `runtime:${state.runtimeId}`
      : `cwd:${state.cwd || ""}`;
  return c ? `${c}:${base}` : base;
}

export function uniqueRunners() {
  return [...new Set(runners.values())];
}

export function runningThreads() {
  const internal = uniqueRunners()
    .filter((runner) => runner.running)
    .map((runner) => ({
      runnerKey: runner.key,
      connectorId: runner.connectorId || "",
      threadId: runner.state.threadId || "",
      cwd: runner.cwd || "",
      title: threadTitle(runner.state.messages || [], runner.cwd ? `/${runner.cwd}` : "根目录会话"),
      messageCount: runner.state.messages?.length || 0,
      queueLength: runner.messageQueue.length,
      externalRunning: false
    }));
  const internalKeys = new Set(internal.map((item) => `${item.connectorId || ""}:${item.threadId || ""}`));
  const liveVoice = activeLiveVoiceThreadSnapshots()
    .filter((snapshot) => snapshot.threadId && !internalKeys.has(`:${snapshot.threadId}`))
    .map((snapshot) => ({
      runnerKey: `live-voice:${snapshot.threadId}`,
      connectorId: "",
      threadId: snapshot.threadId,
      cwd: snapshot.cwd || "",
      title: snapshot.cwd ? `Live Voice · ${snapshot.cwd}` : "Live Voice 会话",
      messageCount: 0,
      queueLength: 0,
      externalRunning: false,
      liveVoiceRunning: true,
      liveVoiceConnected: Boolean(snapshot.connected),
      liveVoiceTaskRunning: Boolean(snapshot.taskRunning)
    }));
  const ownedKeys = new Set([
    ...internalKeys,
    ...liveVoice.map((item) => `:${item.threadId}`)
  ]);
  const external = externalRunningSnapshots()
    .filter((snapshot) => snapshot.threadId && !ownedKeys.has(`${snapshot.connectorId || ""}:${snapshot.threadId}`))
    .map((snapshot) => ({
      runnerKey: `external:${snapshot.connectorId || "local"}:${snapshot.threadId}`,
      connectorId: snapshot.connectorId || "",
      threadId: snapshot.threadId,
      cwd: snapshot.cwd || "",
      title: threadTitle(snapshot.messages || [], snapshot.cwd ? `/${snapshot.cwd}` : "Codex CLI 外部会话"),
      messageCount: snapshot.messageCount || snapshot.messages?.length || 0,
      queueLength: 0,
      externalRunning: true
    }));
  return [...internal, ...liveVoice, ...external];
}

export function isRunnerSelected(runner) {
  if (!runner) return false;
  return runners.get(selectedRunnerKey) === runner || selectedRunnerKey === runner.key || (runner.state.threadId && selectedRunnerKey === runnerKeyForState({ threadId: runner.state.threadId, connectorId: runner.connectorId }));
}

export async function writeRunnerStateIfSelected(runner) {
  if (!isRunnerSelected(runner)) return false;
  await writeState(syncLoadedCounts(runner.state), runner.connectorId || "");
  return true;
}

function releaseRunnerAppServerIfIdle(runner) {
  if (!runner?.ownsAppServer
    || runner.running
    || runner.messageQueue.length
    || runner.appServer?.turn
    || runner.appServer?.pending?.size
    || runner.appServer?.starting
    || runner.appServer?.settingsUpdatePromise) return false;
  runner.appServer.transport?.kill?.();
  runner.appServer.initialized = false;
  runner.appServer.activeThreadId = "";
  runner.appServer.activeCwd = "";
  return true;
}

export function broadcastRunner(runner, event) {
  broadcast({ type: "runner_status", runningThreads: runningThreads() });
  if (isRunnerSelected(runner)) broadcast({ ...event, connectorId: runner.connectorId || "" });
}

export function selectedRunner() {
  return runners.get(selectedRunnerKey) || null;
}

export function queueMessagesFor(runner) {
  return (runner?.messageQueue || []).map((item, index) => ({ index: index + 1, message: cleanText(item.message, 30000) }));
}

export function steerMessagesFor(runner) {
  return (runner?.steerMessages || []).map((item, index) => ({ index: index + 1, message: cleanText(item.message, 30000), at: item.at }));
}

export function statusPayload(runner = selectedRunner(), isRunning = Boolean(runner?.running)) {
  return {
    type: "status",
    running: isRunning,
    queueLength: runner?.messageQueue.length || 0,
    queueMessages: queueMessagesFor(runner),
    steerLength: runner?.steerMessages.length || 0,
    steerMessages: steerMessagesFor(runner),
    followMode: runner?.followMode || followMode,
    contextUsage: runner?.contextUsage || contextUsage,
    reconnecting: Boolean(runner?.reconnecting),
    externalRunning: false,
    runningThreads: runningThreads()
  };
}

export function liveMessagesFor(runner) {
  const turn = runner?.appServer?.turn;
  if (!runner?.running || !turn) return [];
  const messages = Array.isArray(turn.answerMessages) && turn.answerMessages.length
    ? turn.answerMessages.map((message) => ({ role: "assistant", ...message }))
    : turn.answers.map((content, index) => ({ role: "assistant", content, messageId: `live-answer-${index}`, final: true }));
  if (turn.currentMessage?.text) {
    messages.push({ role: "assistant", content: assistantBubbleText(turn.currentMessage.text, turn.currentMessage.phase), messageId: turn.currentMessage.id || "assistant", transient: true });
  }
  return messages;
}

export function liveFullMessagesFor(runner) {
  const turn = runner?.appServer?.turn;
  if (!runner?.running || !turn?.fullReplyMessages) return [];
  return [...turn.fullReplyMessages.values()];
}

export function runnerStatePayload(runner, extra = {}) {
  const status = statusPayload(runner);
  delete status.type;
  return {
    ...runner.state,
    ...extra,
    absoluteCwd: resolveAbsoluteCwd({ ...runner.state, ...extra }),
    ...status,
    liveMessages: liveMessagesFor(runner)
  };
}

export async function createRunner(state = {}) {
  await ensureStateModelSettings(state);
  const key = runnerKeyForState(state);
  const appServer = runnerAppServerForState(state);
  const runner = {
    key,
    connectorId: state.connectorId || "",
    cwd: state.cwd || "",
    state: syncLoadedCounts({
      threadId: state.threadId || "",
      runtimeId: state.runtimeId || "",
      connectorId: state.connectorId || "",
      cwd: state.cwd || "",
      model: state.model || "",
      reasoningEffort: state.reasoningEffort || "",
      modelSettingsUpdatedAt: state.modelSettingsUpdatedAt || "",
      modelSettingsSource: state.modelSettingsSource || "",
      messages: Array.isArray(state.messages) ? state.messages : [],
      inflight: state.inflight || null
    }),
    appServer,
    running: false,
    followMode: await followModeForState(state, state.connectorId || ""),
    messageQueue: [],
    steerMessages: [],
    contextUsage: contextUsage || null,
    reconnecting: false,
    ownsAppServer: !state.connectorId || connectorSupportsConcurrentAppServers(state.connectorId),
    emit: null
  };
  runner.emit = (event) => broadcastRunner(runner, event);
  runner.appServer.runner = runner;
  runner.appServer.onContextUpdate = () => broadcast(statusPayload(runner));
  runners.set(key, runner);
  if (runner.state.threadId) runners.set(`${runner.connectorId ? `${runner.connectorId}:` : ""}thread:${runner.state.threadId}`, runner);
  return runner;
}

export async function runnerForState(state = {}, create = false) {
  const key = runnerKeyForState(state);
  let runner = runners.get(key);
  if (!runner && state.threadId) runner = runners.get(`${state.connectorId ? `${state.connectorId}:` : ""}thread:${state.threadId}`);
  if (!runner && create) {
    let creation = runnerCreations.get(key);
    if (!creation) {
      creation = createRunner(state).finally(() => {
        if (runnerCreations.get(key) === creation) runnerCreations.delete(key);
      });
      runnerCreations.set(key, creation);
    }
    runner = await creation;
  }
  if (runner) runner.followMode = await followModeForState(runner.state, runner.connectorId || "");
  return runner || null;
}

export async function rememberRunnerThread(runner, state = runner.state) {
  if (!runner || !state.threadId) return;
  runner.state.threadId = state.threadId;
  runner.state.runtimeId = "";
  await saveThreadModelSettings(state.threadId, {
    model: runner.state.model,
    reasoningEffort: runner.state.reasoningEffort,
    updatedAt: runner.state.modelSettingsUpdatedAt,
    source: runner.state.modelSettingsSource
  }, runner.connectorId || "");
  const nextKey = runnerKeyForState({ connectorId: runner.connectorId, threadId: state.threadId });
  if (runner.key !== nextKey) {
    const wasSelected = isRunnerSelected(runner);
    for (const [key, value] of runners) {
      if (value === runner) runners.delete(key);
    }
    runner.key = nextKey;
    runners.set(nextKey, runner);
    if (wasSelected) selectedRunnerKey = nextKey;
  } else {
    runners.set(nextKey, runner);
  }
}

export async function runnerForIncomingState(state = {}) {
  const cwd = state.cwd || "";
  const selected = await runnerForState(state, false);
  if (selected) return selected;
  // Legacy state files had no runtimeId. A cwd fallback is safe only when it
  // identifies exactly one task; otherwise it would select an arbitrary
  // conversation now that same-folder tasks may run concurrently.
  if (state.threadId || state.runtimeId) return null;
  const matches = uniqueRunners().filter((runner) => runner.running
    && runner.cwd === cwd
    && (runner.connectorId || "") === (state.connectorId || ""));
  return matches.length === 1 ? matches[0] : null;
}

export function executionConflictForState(state = {}, exceptRunner = null) {
  const connectorId = state.connectorId || "";
  if (!connectorId || connectorSupportsConcurrentAppServers(connectorId)) return null;
  return uniqueRunners().find((runner) => runner.running
    && (runner.connectorId || "") === connectorId
    && runner !== exceptRunner) || null;
}

function externalTaskLabel(connectorId = "") {
  return connectorId ? "被控电脑上的 Codex" : "本机 Codex Desktop/CLI";
}

export async function externalStatusForState(state = {}, refresh = false) {
  if (!state.threadId) return null;
  const connectorId = state.connectorId || "";
  if (refresh) {
    try {
      return await refreshExternalSession(state.threadId, connectorId);
    } catch {
      // A cached running status is safer than allowing a second writer when a
      // connector or session read has a transient failure.
    }
  }
  return externalSessionSnapshot(state.threadId, connectorId);
}

export async function assertExternalSessionIdle(state = {}) {
  const snapshot = await externalStatusForState(state, true);
  if (!snapshot?.running) return snapshot;
  throw Object.assign(
    new Error(`${externalTaskLabel(state.connectorId || "")} 正在执行这个会话，网页端已进入只读实时同步，请等任务结束后再发送。`),
    { statusCode: 409, externalRunning: true }
  );
}

function scheduleServiceRestart() {
  if (!existsSync(restartScript)) throw new Error(`重启脚本不存在：${restartScript}`);
  const child = spawn("cmd.exe", ["/c", restartScript], { cwd: rootDir, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function taskFailureMessage(error) {
  const detail = String(error?.message || "Codex 调用失败");
  if (/Selected model is at capacity/i.test(detail)) {
    return [
      cleanText(error?.partialAnswer || "", 20000).trim(),
      "❌ 当前模型暂时无可用容量，请切换模型后重试。",
      `Codex 提示：${detail}`
    ].filter(Boolean).join("\n\n");
  }
  return [
    cleanText(error?.partialAnswer || "", 20000).trim(),
    `❌ 执行失败：${detail}`
  ].filter(Boolean).join("\n\n");
}

export function dispatchTaskTerminalNotification(text, channels = {}) {
  const content = String(text || "").trim();
  if (!content) return false;
  const notifyWechat = channels.notifyWechat || notifyWechatTaskDone;
  const sendWebPush = channels.sendWebPush || sendWebPushTaskDone;
  const sendNative = channels.sendNative || sendNativeTaskDone;
  const logger = channels.logger || console;
  try {
    notifyWechat(content);
  } catch (error) {
    logger.error("wechat task notification failed", error?.message || error);
  }
  try {
    Promise.resolve(sendWebPush(content))
      .catch((error) => logger.error("web push task notification failed", error?.message || error));
  } catch (error) {
    logger.error("web push task notification failed", error?.message || error);
  }
  try {
    sendNative(content);
  } catch (error) {
    logger.error("native task notification failed", error?.message || error);
  }
  return true;
}

async function localCommandResponse(message, connectorId = "") {
  const raw = message.trim();
  const command = raw.toLowerCase();
  const state = await readState(connectorId);
  const currentCwd = state.connectorId ? state.cwd : stateAbsoluteCwd(state.cwd);
  const currentCwdLabel = state.connectorId ? state.cwd : stateAbsoluteCwd(state.cwd);
  const currentRunner = await runnerForState(state, false);
  const commandServer = currentRunner?.appServer || appServerForState({ connectorId });
  if (command === "/help") {
    return [
      "可用 Codex 命令：", "",
      "- `/help`：显示命令列表",
      "- `/status`：读取当前 app-server/线程状态",
      "- `/model`：通过 `model/list` 查看当前可用模型",
      "- `/model <模型ID>`：切换到 Codex CLI 提供的模型",
      "- `/effort`：查看当前模型支持的思考强度",
      "- `/effort <强度>`：切换思考强度（`/reasoning` 是别名）",
      "- `/fast`：切换当前模型的 Fast 服务层并持久化选择",
      "- `/fast on|off|status`：开启、关闭或查看 Fast 模式",
      "- `/diff`：通过 `gitDiffToRemote` 查看当前 Git diff",
      "- `/compact`：通过 `thread/compact/start` 压缩当前线程上下文",
      "- `/stop`：通过 `turn/interrupt` 中断当前回合；无回合时重启 app-server",
      "- `/follow queue`：运行中收到新消息时加入队列",
      "- `/follow steer`：运行中收到新消息时引导当前回合",
      "- `/steer <消息>`：立即引导当前正在运行的回合",
      "- `/new`：新建线程，等同顶部 new 按钮",
      "- `/resume`：列出可切换的最近线程，等同“会话”列表",
      "",
      "未列出的 `/xxx` 不会再假装成内置命令；会提示未支持。"
    ].join("\n");
  }
  if (command === "/status") {
    await ensureStateModelSettings(state);
    const fastStatus = await commandServer.fastModeStatus(
      state.model,
      currentRunner?.running ? "" : state.threadId,
      currentCwd
    ).catch(() => null);
    return [
      "当前状态：", "",
      `- Web 服务 PID：${process.pid}`,
      `- Codex app-server PID：${commandServer.transport?.alive ? "已连接" : "未连接"}`,
      `- 当前线程：${state.threadId || commandServer.activeThreadId || "未加载"}`,
      `- 正在处理：${currentRunner?.running ? "是" : "否"}`,
      `- 跟随模式：${(currentRunner?.followMode || followMode) === "steer" ? "引导" : "队列"}`,
      `- 工作目录：${currentCwdLabel}`,
      `- 被控端：${state.connectorId || "本机"}`,
      `- 模型：${state.model || "默认"}`,
      `- 思考强度：${reasoningEffortLabel(state.reasoningEffort) || "默认"}`,
      `- Fast 模式：${fastModeLabel(fastStatus)}`
    ].join("\n");
  }
  if (command === "/model") {
    await ensureStateModelSettings(state);
    const options = await commandServer.modelOptions();
    const models = options.slice(0, 30).map((item, index) => {
      const marker = [item.model, item.id].includes(state.model) ? " ← 当前" : "";
      return `${index + 1}. ${item.model || item.id}${marker}`;
    });
    return ["可用模型（来自 Codex CLI `model/list`）：", "", ...models, "", "切换用法：`/model <模型ID>`"].join("\n");
  }
  if (/^\/model\s+/i.test(raw)) {
    if (currentRunner?.running) return "Codex 正在处理，请结束或中断后再切换模型。";
    const requestedModel = raw.replace(/^\/model\s+/i, "").trim();
    await ensureStateModelSettings(state);
    const previousEffort = state.reasoningEffort;
    try {
      const { selected, effort } = await commandServer.selectModel(requestedModel, state.reasoningEffort, state.threadId, currentCwd);
      state.model = selected.model || selected.id;
      state.reasoningEffort = effort;
      await saveStateModelSettings(state, currentRunner);
      const effortNote = effort !== previousEffort ? `\n思考强度已自动调整为该模型的可用选项：\`${reasoningEffortLabel(effort)}\`` : "";
      return `已切换模型：\`${selected.model || selected.id}\`${effortNote}`;
    } catch (error) {
      const options = await commandServer.modelOptions().catch(() => []);
      const available = options.map((item) => item.model || item.id).filter(Boolean).join("、");
      return [`切换模型失败：${error.message || error}`, available ? `可用选项：${available}` : ""].filter(Boolean).join("\n\n");
    }
  }
  if (command === "/effort" || command === "/reasoning") {
    await ensureStateModelSettings(state);
    const options = await commandServer.modelOptions();
    const selected = options.find((item) => [item.model, item.id].includes(state.model))
      || options.find((item) => item.isDefault)
      || options[0];
    const efforts = (selected?.supportedReasoningEfforts || []).map((item, index) => {
      const markers = [];
      if (item.reasoningEffort === selected?.defaultReasoningEffort) markers.push("默认");
      if (item.reasoningEffort === state.reasoningEffort) markers.push("当前");
      return `${index + 1}. ${reasoningEffortLabel(item.reasoningEffort)}${markers.length ? ` (${markers.join("、")})` : ""}`;
    });
    return [
      `模型 \`${selected?.model || state.model}\` 可用的思考强度（来自 Codex CLI \`model/list\`）：`,
      "", ...efforts, "", "切换用法：`/effort <强度>`"
    ].join("\n");
  }
  if (/^\/(?:effort|reasoning)\s+/i.test(raw)) {
    if (currentRunner?.running) return "Codex 正在处理，请结束或中断后再切换思考强度。";
    const requestedEffort = raw.replace(/^\/(?:effort|reasoning)\s+/i, "").trim();
    await ensureStateModelSettings(state);
    try {
      const { selected, option } = await commandServer.selectReasoningEffort(requestedEffort, state.model, state.threadId, currentCwd);
      state.model = selected.model || selected.id;
      state.reasoningEffort = option.reasoningEffort;
      await saveStateModelSettings(state, currentRunner);
      return `已将模型 \`${selected.model || selected.id}\` 的思考强度切换为：\`${reasoningEffortLabel(option.reasoningEffort)}\``;
    } catch (error) {
      const options = await commandServer.modelOptions().catch(() => []);
      const selected = options.find((item) => [item.model, item.id].includes(state.model));
      const available = (selected?.supportedReasoningEfforts || []).map((item) => reasoningEffortLabel(item.reasoningEffort)).filter(Boolean).join("、");
      return [`切换思考强度失败：${error.message || error}`, available ? `可用选项：${available}` : ""].filter(Boolean).join("\n\n");
    }
  }
  const fastMatch = raw.match(/^\/fast(?:\s+(on|off|status))?\s*$/i);
  if (fastMatch) {
    const action = String(fastMatch[1] || "").toLowerCase();
    if (currentRunner?.running && action !== "status") {
      return "Codex 正在处理，请结束或中断后再切换 Fast 模式。";
    }
    try {
      const status = await commandServer.fastModeStatus(
        state.model,
        currentRunner?.running ? "" : state.threadId,
        currentCwd
      );
      if (action === "status") return fastModeStatusMessage(status);
      const enabled = action === "on"
        ? true
        : action === "off"
          ? false
          : !(status.enabled || (!status.supported && status.configuredEnabled));
      const updated = await commandServer.setFastMode(
        enabled,
        state.model,
        state.threadId,
        currentCwd
      );
      return [
        `Fast 模式已${enabled ? "开启" : "关闭"}。`,
        "",
        fastModeStatusMessage(updated)
      ].join("\n");
    } catch (error) {
      return [
        `Fast 模式切换失败：${error.message || error}`,
        "",
        "用法：`/fast`、`/fast on`、`/fast off`、`/fast status`"
      ].join("\n");
    }
  }
  if (command.startsWith("/fast")) {
    return "Fast 命令格式不正确。\n\n用法：`/fast`、`/fast on`、`/fast off`、`/fast status`";
  }
  if (command === "/diff") {
    const result = await commandServer.gitDiff(currentCwd).catch((error) => { throw error; });
    const diff = (result.diff || "").trim();
    return diff ? `当前 Git diff（${currentCwdLabel}）：\n\n${diff}` : `当前没有 Git diff（${currentCwdLabel}）。`;
  }
  if (command === "/compact") {
    if (currentRunner?.running) return "Codex 正在处理，当前不能压缩上下文。";
    const threadId = await commandServer.compactCurrentThread(state.threadId, currentCwd);
    return `已调用 thread/compact/start 压缩当前线程：${threadId}`;
  }
  if (command === "/restart") {
    scheduleServiceRestart();
    return ["已开始重启服务。", "", "- Caddy 端口：5566", "- Codex Remote 后端：5567", "", "网页会短暂断开，约 5-10 秒后恢复。"].join("\n");
  }
  if (command === "/stop") {
    const interrupted = await commandServer.interruptCurrentTurn().catch(() => false);
    if (!interrupted && commandServer.transport?.alive) commandServer.transport.kill?.();
    if (currentRunner) {
      currentRunner.messageQueue.length = 0;
      currentRunner.steerMessages = [];
      currentRunner.running = false;
    }
    commandServer.turn = null;
    commandServer.activeThreadId = "";
    commandServer.activeCwd = "";
    broadcast(statusPayload(currentRunner, false));
    return interrupted
      ? "已通过 turn/interrupt 中断当前 Codex 回合。"
      : "没有可中断的活跃回合，已重启 Codex app-server 状态。";
  }
  if (command === "/follow queue" || command === "/follow steer") {
    const nextMode = command.endsWith("steer") ? "steer" : "queue";
    if (currentRunner) currentRunner.followMode = nextMode;
    else followMode = nextMode;
    await saveFollowModeForState(currentRunner?.state || state, nextMode, (currentRunner?.connectorId || connectorId || ""));
    broadcast(statusPayload(currentRunner));
    return `Follow behavior switched to \`${nextMode}\`.`;
  }
  if (command === "/follow") {
    return `当前 follow 模式：${currentRunner?.followMode || followMode}\n\n用法：\`/follow queue\` 或 \`/follow steer\``;
  }
  if (command === "/result") {
    return "网页端 `/result` 是本地显示开关，用于隐藏或显示思考过程气泡。";
  }
  if (command.startsWith("/steer")) {
    const steerMessage = raw.replace(/^\/steer\s*/i, "").trim();
    if (!steerMessage) return "Usage: `/steer <message>`";
    try {
      await commandServer.steerCurrentTurn(steerMessage);
      return "Steer delivered to the running task.";
    } catch (error) {
      return `Failed to steer running task: ${error.message || error}`;
    }
  }
  if (command === "/new") {
    if (currentRunner?.running) return "Codex 正在处理，当前不能新建线程。";
    commandServer.activeThreadId = "";
    commandServer.activeCwd = "";
    contextUsage = freshContextUsage();
    const defaults = await commandServer.configuredModelSettings(currentCwd);
    const nextState = { threadId: "", runtimeId: randomUUID(), connectorId: state.connectorId || "", cwd: state.cwd || "", model: defaults.model || "", reasoningEffort: defaults.reasoningEffort || "", messages: [] };
    await writeState(nextState, state.connectorId || "");
    broadcast({ type: "state", ...nextState, absoluteCwd: stateAbsoluteCwd(state.cwd), contextUsage });
    return "已新建线程。";
  }
  if (command === "/resume") {
    const threads = (await listThreads(state.connectorId || "")).slice(0, 12);
    if (!threads.length) return "没有找到可恢复的线程。";
    return ["最近线程：", "", ...threads.map((thread, index) => `${index + 1}. ${thread.title}\n   ${thread.threadId}`)].join("\n");
  }
  if (command.startsWith("/")) {
    return `未支持的 Codex 命令：${command}\n\n点 / 按钮查看当前网页端已经接入真实 app-server API 的命令。`;
  }
  return "";
}

export async function runRemoteTask(message, runner) {
  const state = runner.state;
  const runnerStartedAtMs = Number(runner.taskStartedAtMs);
  const connectionMessageId = `codex-connection-${Date.now()}`;
  let taskOk = false;
  let connected = false;
  let waitTimer = null;
  let timeoutTimer = null;
  let turnTimeoutTimer = null;
  let terminalNotificationSent = false;
  const notifyTaskTerminalOnce = (text) => {
    if (terminalNotificationSent || !text) return false;
    terminalNotificationSent = dispatchTaskTerminalNotification(text, runner.notificationChannels || {});
    return terminalNotificationSent;
  };
  const clearConnectionTimers = () => { if (waitTimer) clearTimeout(waitTimer); if (timeoutTimer) clearTimeout(timeoutTimer); waitTimer = null; timeoutTimer = null; };
  const clearTurnTimeout = () => { if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer); turnTimeoutTimer = null; };
  let rejectTurnTimeout = null;
  const armTurnTimeout = () => {
    clearTurnTimeout();
    turnTimeoutTimer = setTimeout(() => {
      const error = new Error(`Codex 连续 ${Math.round(codexTurnTimeoutMs / 60000)} 分钟没有活动，已自动中断。`);
      error.turnTimeout = true;
      rejectTurnTimeout?.(error);
    }, Math.max(1000, codexTurnTimeoutMs));
  };
  const markConnected = () => { connected = true; clearConnectionTimers(); };
  try {
    let ok = true;
    let answers = [];
    try {
      waitTimer = setTimeout(() => {
        if (connected || !runner.running) return;
        broadcastRunner(runner, { type: "message", role: "assistant", content: "⏳ 正在等待 Codex 连接...", messageId: connectionMessageId, transient: true });
      }, Math.max(0, codexConnectWaitMs));
      const connectionTimeout = new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => {
          if (connected) return;
          const error = new Error("Codex 连接超时，请稍后重试。");
          error.connectionTimeout = true;
          reject(error);
        }, Math.max(1000, codexConnectTimeoutMs));
      });
      const turnTimeout = new Promise((_, reject) => { rejectTurnTimeout = reject; });
      armTurnTimeout();
      answers = await Promise.race([
        runner.appServer.runTurn(message, state, {
          model: runner.state.model,
          reasoningEffort: runner.state.reasoningEffort,
          onActivity: armTurnTimeout,
          onConnected: markConnected,
          onThreadReady: async (st) => {
            runner.state.threadId = st.threadId;
            await rememberRunnerThread(runner, st);
            await writeRunnerStateIfSelected(runner);
            broadcastRunner(runner, {
              type: "state",
              ...runner.state,
              running: runner.running,
              contextUsage: runner.contextUsage,
              threadName: st.threadId ? await threadName(st.threadId) : "",
              followMode: runner.followMode,
              runningThreads: runningThreads()
            });
          }
        }),
        connectionTimeout,
        turnTimeout
      ]);
      markConnected();
      clearTurnTimeout();
      await rememberRunnerThread(runner, state);
    } catch (error) {
      clearConnectionTimers();
      clearTurnTimeout();
      if (error.connectionTimeout) {
        runner.appServer.rejectAll(error);
        answers = [`❌ 连接失败：${error.message}`];
        broadcastRunner(runner, { type: "message", role: "assistant", content: `❌ 连接失败：${error.message}`, messageId: connectionMessageId, final: true });
      } else {
        if (error.turnTimeout) await runner.appServer.abortCurrentTurn(error);
        answers = [taskFailureMessage(error)];
      }
      ok = false;
    }
    if (ok && !completionMessage(answers)) {
      answers = [
        ...answers,
        "❌ Codex 任务已经停止，但没有返回完整的最终回复。"
      ];
      ok = false;
    }
    taskOk = ok;
    const savedAnswers = answers.length ? answers : ["Codex 没有返回文本。"];
    const inflightStartedAtMs = state.inflight?.startedAt ? Date.parse(state.inflight.startedAt) : NaN;
    const startedAtMs = Number.isFinite(runnerStartedAtMs) ? runnerStartedAtMs : inflightStartedAtMs;
    const taskDurationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null;
    const completionIndex = savedAnswers.reduce((lastIndex, answer, index) => (/^✅\s/.test(answer || "") ? index : lastIndex), -1);
    const terminalIndex = ok ? completionIndex : savedAnswers.length - 1;
    const savedMessages = [];
    for (const [index, answer] of savedAnswers.entries()) {
      const msg = { role: "assistant", content: answer, at: new Date().toISOString() };
      if (index === terminalIndex && taskDurationMs !== null) msg.taskDurationMs = taskDurationMs;
      savedMessages.push(msg);
      state.messages.push(msg);
    }
    state.messages = state.messages.slice(-80);
    state.inflight = null;
    runner.state = syncLoadedCounts(state);
    await rememberMessageMeta(runner.state.threadId, savedMessages);
    await writeRunnerStateIfSelected(runner);
    broadcastRunner(runner, { type: "state_saved", threadId: runner.state.threadId });
    if (!ok) {
      const notificationText = failureNotificationMessage(savedAnswers);
      savedAnswers.forEach((answer, index) => {
        const payload = { type: "message", role: "assistant", content: answer, messageId: `task-failed-${Date.now()}-${index}`, final: true };
        if (index === terminalIndex && taskDurationMs !== null) payload.taskDurationMs = taskDurationMs;
        if (index === terminalIndex) {
          payload.taskFailed = true;
          payload.notificationText = notificationText;
        }
        broadcastRunner(runner, payload);
      });
    }
    const terminalMessage = ok
      ? completionMessage(savedAnswers)
      : failureNotificationMessage(savedAnswers);
    notifyTaskTerminalOnce(terminalMessage);
  } catch (error) {
    console.error("remote task failed", error);
    taskOk = false;
    const failureMessage = taskFailureMessage(error);
    const notificationText = failureNotificationMessage([failureMessage]);
    notifyTaskTerminalOnce(notificationText);
    state.inflight = null;
    state.messages.push({ role: "assistant", content: failureMessage, at: new Date().toISOString(), taskDurationMs: Number.isFinite(runnerStartedAtMs) ? Math.max(0, Date.now() - runnerStartedAtMs) : undefined });
    state.messages = state.messages.slice(-80);
    runner.state = syncLoadedCounts(state);
    await rememberMessageMeta(runner.state.threadId, runner.state.messages)
      .catch((metaError) => console.error("failed to save task failure metadata", metaError));
    await writeRunnerStateIfSelected(runner).catch((writeError) => console.error("failed to save task failure", writeError));
    const failurePayload = {
      type: "message",
      role: "assistant",
      content: failureMessage,
      messageId: `task-failed-${Date.now()}`,
      final: true,
      taskFailed: true,
      notificationText
    };
    if (Number.isFinite(runnerStartedAtMs)) failurePayload.taskDurationMs = Math.max(0, Date.now() - runnerStartedAtMs);
    broadcastRunner(runner, failurePayload);
  } finally {
    // Reflect the terminal state before emitting done. Previously done first
    // emitted a runner_status that still contained this finished thread, so a
    // browser refresh could restore the stale red running state. A queued turn
    // keeps the overall session running while it is handed to the next task.
    const willContinue = runner.messageQueue.length > 0;
    runner.running = willContinue;
    runner.reconnecting = false;
    runner.taskStartedAtMs = null;
    runner.steerMessages = [];
    broadcastRunner(runner, { type: "done", ok: taskOk, threadId: runner.state.threadId });
    if (!willContinue) {
      await markThreadCompletedUnread(runner.state.threadId, runner).catch((markError) => console.error("failed to mark completed thread", markError));
    }
    processNextQueuedMessage(runner);
  }
}

export async function startRemoteTask(message, state, runner = null, options = {}) {
  runner = runner || await runnerForState(state, false);
  const conflict = executionConflictForState(state, runner);
  if (conflict) throw new Error("当前被控端只提供一个 Codex 执行通道，已有会话正在运行。");
  runner = runner || await runnerForState(state, true);
  stopExternalSessionMonitor(runner.connectorId || "");
  runner.running = true;
  runner.reconnecting = false;
  runner.steerMessages = [];
  runner.cwd = state.cwd || "";
  runner.state = syncLoadedCounts({ ...state, cwd: runner.cwd, messages: Array.isArray(state.messages) ? state.messages : [], inflight: state.inflight || null });
  if (!options.skipUserMessage) runner.state.messages.push({ role: "user", content: message, at: new Date().toISOString() });
  runner.state.messages = runner.state.messages.slice(-80);
  runner.taskStartedAtMs = Date.now();
  runner.state.inflight = { message, cwd: runner.cwd, startedAt: new Date(runner.taskStartedAtMs).toISOString() };
  runner.appServer.runner = runner;
  runner.appServer.onContextUpdate = () => broadcast(statusPayload(runner));
  await writeRunnerStateIfSelected(runner);
  if (!options.skipUserMessage) {
    const savedUserMessage = runner.state.messages[runner.state.messages.length - 1];
    broadcastRunner(runner, { type: "message", ...savedUserMessage });
  }
  broadcastRunner(runner, statusPayload(runner, true));
  runRemoteTask(message, runner);
}

function processNextQueuedMessage(runner) {
  const next = runner.messageQueue.shift();
  if (!next) {
    broadcastRunner(runner, statusPayload(runner, false));
    releaseRunnerAppServerIfIdle(runner);
    return;
  }
  startRemoteTask(next.message, runner.state, runner, { skipUserMessage: Boolean(next.displayed) })
    .catch((error) => {
      console.error("failed to start queued task", error);
      runner.running = false;
      const failureMessage = `❌ 队列任务启动失败：${error.message || "未知错误"}`;
      broadcastRunner(runner, {
        type: "error",
        text: failureMessage,
        taskFailed: true,
        messageId: `queued-task-failed-${Date.now()}`
      });
      dispatchTaskTerminalNotification(failureMessage, runner.notificationChannels || {});
      processNextQueuedMessage(runner);
    });
}

async function submitLiveVoiceMessage(text, selectedState) {
  let delivery = null;
  let localAnswer = "";
  if (text.trim().toLowerCase() === "/stop") {
    const interrupted = await interruptLiveVoiceThreadTask(selectedState.threadId)
      .catch(() => false);
    localAnswer = interrupted
      ? "已中断当前 Live Voice Codex 任务；语音连接仍然保留。"
      : "当前 Live Voice 会话没有可中断的 Codex 任务。";
  } else {
    try {
      delivery = await sendLiveVoiceThreadInput(selectedState.threadId, text);
    } catch (error) {
      if (error && typeof error === "object") {
        if (!error.statusCode) error.statusCode = 409;
        throw error;
      }
      throw Object.assign(new Error(String(error)), { statusCode: 409 });
    }
  }

  const state = await readState("");
  await saveDraftForState(state, "", "");
  if (state.threadId === selectedState.threadId) {
    const userMessage = {
      role: "user",
      content: text,
      at: new Date().toISOString(),
      liveVoiceTranscript: true
    };
    const last = state.messages?.at?.(-1);
    if (last?.role !== userMessage.role || last?.content !== userMessage.content) {
      state.messages = [...(state.messages || []), userMessage].slice(-80);
      broadcast({
        type: "message",
        connectorId: "",
        threadId: state.threadId,
        ...userMessage
      });
    }
    if (localAnswer) {
      const assistantMessage = {
        role: "assistant",
        content: localAnswer,
        at: new Date().toISOString(),
        liveVoiceTranscript: true
      };
      state.messages.push(assistantMessage);
      state.messages = state.messages.slice(-80);
      broadcast({
        type: "message",
        connectorId: "",
        threadId: state.threadId,
        ...assistantMessage,
        final: true,
        messageId: `live-voice-command-${Date.now()}`
      });
    }
    await writeState(syncLoadedCounts(state), "");
  }

  const liveVoice = liveVoiceThreadSnapshot(selectedState.threadId);
  const mode = await followModeForState(selectedState, "");
  const response = {
    ok: true,
    accepted: true,
    liveVoice: true,
    running: Boolean(liveVoice),
    externalRunning: false,
    liveVoiceRunning: Boolean(liveVoice),
    liveVoiceConnected: Boolean(liveVoice?.connected),
    liveVoiceTaskRunning: Boolean(liveVoice?.taskRunning),
    reconnecting: Boolean(liveVoice && !liveVoice.connected),
    queued: false,
    steered: delivery?.mode === "steer",
    queueLength: 0,
    queueMessages: [],
    steerLength: 0,
    steerMessages: [],
    followMode: mode,
    threadId: selectedState.threadId,
    runningThreads: runningThreads()
  };
  if (localAnswer) {
    response.local = true;
    response.answer = localAnswer;
  }
  broadcast({
    type: "status",
    connectorId: "",
    ...response
  });
  return response;
}

export async function submitRemoteMessage(message, requestedFollowMode = "", connectorId = "") {
  const text = cleanText(message, 30000).trim();
  if (!text) throw Object.assign(new Error("请先输入内容。"), { statusCode: 400 });
  const oneShotFollowMode = requestedFollowMode === "steer" ? "steer" : requestedFollowMode === "queue" ? "queue" : "";
  const selectedState = await readState(connectorId);
  selectedState.connectorId = selectedState.connectorId || connectorId;
  if (!connectorId && selectedState.threadId && isLiveVoiceThreadActive(selectedState.threadId)) {
    return submitLiveVoiceMessage(text, selectedState);
  }
  const selectedRunner = await runnerForState(selectedState, false);
  if (!selectedRunner?.running) {
    const observed = await assertExternalSessionIdle(selectedState);
    await ensureStateModelSettings(selectedState, observed);
    await writeState(syncLoadedCounts(selectedState), connectorId);
  }
  const localAnswer = await localCommandResponse(text, connectorId);
  if (localAnswer) {
    const state = await readState(connectorId);
    await saveDraftForState(state, "", connectorId);
    const runner = await runnerForState(state, false);
    if (text.trim().toLowerCase() === "/stop") state.inflight = null;
    const userMessage = { role: "user", content: text, at: new Date().toISOString() };
    const assistantMessage = { role: "assistant", content: localAnswer, at: new Date().toISOString() };
    state.messages.push(userMessage);
    state.messages.push(assistantMessage);
    state.messages = state.messages.slice(-80);
    await writeState(syncLoadedCounts(state), connectorId);
    broadcast({ type: "message", connectorId, ...userMessage });
    broadcast({ type: "message", connectorId, ...assistantMessage, final: true });
    broadcast({ ...statusPayload(runner), connectorId });
    broadcast({ type: "done", ok: true, local: true, connectorId, threadId: state.threadId });
    return {
      ok: true, local: true, answer: localAnswer, running: Boolean(runner?.running),
      queueLength: runner?.messageQueue.length || 0, queueMessages: queueMessagesFor(runner),
      steerLength: runner?.steerMessages.length || 0, steerMessages: steerMessagesFor(runner),
      followMode: runner?.followMode || await followModeForState(state, connectorId),
      contextUsage: runner?.contextUsage || contextUsage, reconnecting: Boolean(runner?.reconnecting),
      threadId: state.threadId, runningThreads: runningThreads()
    };
  }
  const state = await readState(connectorId);
  await saveDraftForState(state, "", connectorId);
  selectedRunnerKey = runnerKeyForState(state);
  let runner = await runnerForState(state, false);
  const conflict = executionConflictForState(state, runner);
  if (conflict) throw Object.assign(new Error("当前被控端只提供一个 Codex 执行通道，请等待正在运行的会话结束。"), { statusCode: 409 });
  runner = runner || await runnerForState(state, true);
  if (runner.running) {
    const effectiveFollowMode = oneShotFollowMode || runner.followMode;
    if (effectiveFollowMode === "steer") {
      const steerItem = { message: text, at: new Date().toISOString() };
      runner.steerMessages.push(steerItem);
      broadcastRunner(runner, statusPayload(runner, true));
      try {
        await runner.appServer.steerCurrentTurn(text);
        runner.steerMessages = runner.steerMessages.filter((item) => item !== steerItem);
        const userMessage = { role: "user", content: text, at: new Date().toISOString() };
        runner.state.messages.push(userMessage);
        runner.state.messages = runner.state.messages.slice(-80);
        if (isRunnerSelected(runner)) await writeState(syncLoadedCounts(runner.state), runner.connectorId || "");
        broadcastRunner(runner, { type: "message", ...userMessage });
        broadcastRunner(runner, statusPayload(runner, true));
        return { ok: true, accepted: true, steered: true, queueLength: runner.messageQueue.length, queueMessages: queueMessagesFor(runner), steerLength: runner.steerMessages.length, steerMessages: steerMessagesFor(runner), followMode: runner.followMode, reconnecting: Boolean(runner.reconnecting), threadId: runner.state.threadId, runningThreads: runningThreads() };
      } catch (error) {
        console.error("steer failed, fallback to queue", error);
        runner.steerMessages = runner.steerMessages.filter((item) => item !== steerItem);
      }
    }
    runner.messageQueue.push({ message: text, displayed: true });
    const userMessage = { role: "user", content: text, at: new Date().toISOString() };
    runner.state.messages.push(userMessage);
    runner.state.messages = runner.state.messages.slice(-80);
    if (isRunnerSelected(runner)) await writeState(syncLoadedCounts(runner.state), runner.connectorId || "");
    broadcastRunner(runner, { type: "message", ...userMessage });
    broadcastRunner(runner, statusPayload(runner, true));
    return { ok: true, accepted: true, queued: true, queueLength: runner.messageQueue.length, queueMessages: queueMessagesFor(runner), followMode: runner.followMode, reconnecting: Boolean(runner.reconnecting), threadId: runner.state.threadId, runningThreads: runningThreads() };
  }
  await startRemoteTask(text, state, runner);
  return { ok: true, accepted: true, queued: false, threadId: runner.state.threadId, runningThreads: runningThreads() };
}

export async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function listThreads(connectorId = "") {
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  const names = await readThreadNames();
  const completions = await readThreadCompletions();
  const rows = [];
  const includedThreadIds = new Set();
  const runningByThread = new Map();
  const runningRows = [];
  const liveVoiceByThread = new Map(
    connectorId
      ? []
      : activeLiveVoiceThreadSnapshots().map((snapshot) => [snapshot.threadId, snapshot])
  );
  for (const runner of uniqueRunners().filter((item) => item.running && (item.connectorId || "") === connectorId)) {
    if (runner.state.threadId) runningByThread.set(runner.state.threadId, runner);
    else runningRows.push({
      threadId: `runtime:${runner.key}`,
      runtimeKey: runner.key,
      title: `运行中：${resolveAbsoluteCwd(runner.state)}`,
      originalTitle: threadTitle(runner.state.messages || []),
      name: "", cwd: runner.cwd, updatedAt: runner.state.inflight?.startedAt || new Date().toISOString(),
      messageCount: runner.state.messages?.length || 0, running: true, queueLength: runner.messageQueue.length
    });
  }
  if (connectorSupportsConcurrentAppServers(connectorId)) {
    try {
      const summaries = await connectorThreadSummaries(connectorId, 80);
      for (const thread of summaries || []) {
        if (!thread?.id || thread.parentThreadId || includedThreadIds.has(thread.id)) continue;
        const name = typeof names[thread.id] === "string" ? names[thread.id] : "";
        const runner = runningByThread.get(thread.id);
        const running = Boolean(runner?.running);
        includedThreadIds.add(thread.id);
        rows.push({
          threadId: thread.id,
          title: name || thread.name || thread.preview || "未命名会话",
          originalTitle: thread.name || thread.preview || "未命名会话",
          name,
          cwd: runner?.cwd || thread.cwd || "",
          updatedAt: runner?.state.inflight?.startedAt
            || (Number(thread.updatedAt) > 0 ? new Date(Number(thread.updatedAt) * 1000).toISOString() : ""),
          messageCount: runner?.state.messages?.length ?? null,
          running,
          externalRunning: false,
          completedUnread: Boolean(!running && completions[thread.id]),
          queueLength: runner?.messageQueue.length || 0
        });
      }
      for (const runner of uniqueRunners().filter((item) => item.running
        && item.state.threadId
        && (item.connectorId || "") === connectorId
        && !includedThreadIds.has(item.state.threadId))) {
        runningRows.push({
          threadId: runner.state.threadId, runtimeKey: runner.key,
          title: threadTitle(runner.state.messages || [], runner.cwd ? `/${runner.cwd}` : "根目录会话"),
          originalTitle: threadTitle(runner.state.messages || []), name: "", cwd: runner.cwd,
          updatedAt: runner.state.inflight?.startedAt || new Date().toISOString(),
          messageCount: runner.state.messages?.length || 0, running: true, queueLength: runner.messageQueue.length
        });
      }
      return [...runningRows, ...rows];
    } catch (error) {
      console.warn(`SSH Codex 会话索引读取失败，回退到日志扫描：${error?.message || error}`);
    }
  }
  const entries = await listSessionEntries(provider);
  const { parseSessionFile } = await import("./threads.js");
  const parsedEntries = await mapWithConcurrency(entries, connectorId ? 6 : 12, async (item) => {
    try {
      return {
        item,
        parsed: parseSessionFile(
          await provider.readFile(item.file),
          item.file,
          undefined,
          { includeFull: false }
        )
      };
    } catch (error) {
      console.warn(`会话文件读取失败，已跳过 ${item.file}: ${error?.message || error}`);
      return null;
    }
  });
  for (const entry of parsedEntries) {
    if (!entry) continue;
    const { item, parsed } = entry;
    if (!parsed.threadId || parsed.threadSource === "subagent" || includedThreadIds.has(parsed.threadId)) continue;
    const name = typeof names[parsed.threadId] === "string" ? names[parsed.threadId] : "";
    const runner = runningByThread.get(parsed.threadId);
    const liveVoice = liveVoiceByThread.get(parsed.threadId) || null;
    const externalRunning = !runner?.running
      && !liveVoice
      && isExternalTaskRunning(parsed, item.mtimeMs);
    const running = Boolean(runner?.running || liveVoice || externalRunning);
    includedThreadIds.add(parsed.threadId);
    rows.push({
      threadId: parsed.threadId,
      title: name || threadTitle(runner?.state.messages || parsed.messages),
      originalTitle: threadTitle(runner?.state.messages || parsed.messages),
      name, cwd: runner?.cwd || parsed.cwd,
      updatedAt: runner?.state.inflight?.startedAt || parsed.updatedAt,
      messageCount: runner?.state.messages?.length || parsed.messageCount,
      running,
      externalRunning,
      liveVoiceRunning: Boolean(liveVoice),
      liveVoiceConnected: Boolean(liveVoice?.connected),
      liveVoiceTaskRunning: Boolean(liveVoice?.taskRunning),
      completedUnread: Boolean(!running && completions[parsed.threadId]),
      queueLength: runner?.messageQueue.length || 0
    });
  }
  for (const runner of uniqueRunners().filter((item) => item.running && item.state.threadId && (item.connectorId || "") === connectorId && !includedThreadIds.has(item.state.threadId))) {
    runningRows.push({
      threadId: runner.state.threadId, runtimeKey: runner.key,
      title: threadTitle(runner.state.messages || [], runner.cwd ? `/${runner.cwd}` : "根目录会话"),
      originalTitle: threadTitle(runner.state.messages || []), name: "", cwd: runner.cwd,
      updatedAt: runner.state.inflight?.startedAt || new Date().toISOString(),
      messageCount: runner.state.messages?.length || 0, running: true, queueLength: runner.messageQueue.length
    });
  }
  for (const liveVoice of liveVoiceByThread.values()) {
    if (!liveVoice.threadId || includedThreadIds.has(liveVoice.threadId)) continue;
    runningRows.push({
      threadId: liveVoice.threadId,
      runtimeKey: `live-voice:${liveVoice.threadId}`,
      title: liveVoice.cwd ? `Live Voice · ${liveVoice.cwd}` : "Live Voice 会话",
      originalTitle: "Live Voice 会话",
      name: typeof names[liveVoice.threadId] === "string" ? names[liveVoice.threadId] : "",
      cwd: liveVoice.cwd || "",
      updatedAt: liveVoice.updatedAt || new Date().toISOString(),
      messageCount: 0,
      running: true,
      externalRunning: false,
      liveVoiceRunning: true,
      liveVoiceConnected: Boolean(liveVoice.connected),
      liveVoiceTaskRunning: Boolean(liveVoice.taskRunning),
      completedUnread: false,
      queueLength: 0
    });
  }
  return [...runningRows, ...rows];
}

export async function selectRemoteThread(rawThreadId, connectorId = "") {
  const threadId = cleanText(rawThreadId, 120).trim();
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  if (threadId.startsWith("runtime:")) {
    const runner = runners.get(threadId.slice("runtime:".length));
    if (!runner) throw Object.assign(new Error("这个运行中会话已经结束。"), { statusCode: 404 });
    stopExternalSessionMonitor(connectorId);
    selectedRunnerKey = runner.key;
    await writeState(runner.state, runner.connectorId || "");
    const payload = runnerStatePayload(runner, { threadName: "" });
    payload.draft = await draftForState(runner.state, runner.connectorId || "");
    broadcast({ type: "state", connectorId, ...payload });
    return payload;
  }
  const existingRunner = runners.get(`${connectorId ? `${connectorId}:` : ""}thread:${threadId}`);
  if (existingRunner?.running) {
    stopExternalSessionMonitor(connectorId);
    await clearThreadCompletedUnread(threadId);
    selectedRunnerKey = existingRunner.key;
    await writeState(existingRunner.state, existingRunner.connectorId || "");
    const name = existingRunner.state.threadId ? await threadName(existingRunner.state.threadId) : "";
    const payload = runnerStatePayload(existingRunner, { threadName: name });
    payload.draft = await draftForState(existingRunner.state, existingRunner.connectorId || "");
    broadcast({ type: "state", connectorId, ...payload });
    return payload;
  }
  const thread = await loadThreadFromProvider(threadId, provider);
  const liveVoice = !connectorId ? liveVoiceThreadSnapshot(threadId) : null;
  const external = liveVoice ? null : externalSnapshotFromThread(thread, connectorId);
  if (liveVoice) stopExternalSessionMonitor(connectorId);
  else monitorExternalSession(threadId, connectorId, external);
  await clearThreadCompletedUnread(threadId);
  const messages = await mergeLocalMessageMeta(thread.threadId, thread.messages, []);
  const state = { threadId: thread.threadId, connectorId, cwd: thread.cwd || "", model: thread.model || "", reasoningEffort: thread.reasoningEffort || "", messages, loadedCount: messages.length, messageCount: thread.messageCount, inflight: null };
  await ensureStateModelSettings(state, thread);
  selectedRunnerKey = runnerKeyForState(state);
  contextUsage = thread.contextUsage || null;
  const name = await threadName(thread.threadId);
  await writeState(state, connectorId);
  const draft = await draftForState(state, connectorId);
  const mode = await followModeForState(state, connectorId);
  const payload = {
    ...state,
    absoluteCwd: resolveAbsoluteCwd(state),
    threadName: name,
    draft,
    followMode: mode,
    contextUsage,
    running: Boolean(liveVoice || external?.running),
    externalRunning: Boolean(external?.running),
    externalTaskStartedAt: external?.externalTaskStartedAt || "",
    liveVoiceRunning: Boolean(liveVoice),
    liveVoiceConnected: Boolean(liveVoice?.connected),
    liveVoiceTaskRunning: Boolean(liveVoice?.taskRunning),
    reconnecting: Boolean(liveVoice && !liveVoice.connected),
    runningThreads: runningThreads()
  };
  broadcast({ type: "state", connectorId, ...payload });
  return payload;
}

export async function loadThreadPage(threadId, connectorId = "") {
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  return loadThreadFromProvider(threadId, provider, 1000);
}

export async function deleteThread(threadId, connectorId = "") {
  if (!connectorId && isLiveVoiceThreadActive(threadId)) {
    throw Object.assign(
      new Error("这个会话正在由 Live Voice 使用，暂时不能删除。"),
      { statusCode: 409 }
    );
  }
  await assertExternalSessionIdle({ threadId, connectorId });
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  await deleteThreadFromProvider(threadId, provider);
  await deleteThreadModelSettings(threadId, connectorId);
}

export async function createRemoteSession(rawCwd = "", connectorId = "") {
  const cwd = connectorId ? String(rawCwd || "") : stateCwdValue(rawCwd || "");
  if (!connectorId) await assertProjectDirectory(cwd);
  const busy = executionConflictForState({ cwd, connectorId });
  if (busy) {
    selectedRunnerKey = busy.key;
    await writeState(busy.state, busy.connectorId || "");
    const payload = runnerStatePayload(busy, { draft: await draftForState(busy.state, busy.connectorId || "") });
    broadcast({ type: "state", connectorId, ...payload });
    return payload;
  }
  const appServer = appServerForState({ connectorId });
  stopExternalSessionMonitor(connectorId);
  appServer.activeThreadId = "";
  appServer.activeCwd = "";
  contextUsage = freshContextUsage();
  const absoluteCwd = connectorId ? cwd : stateAbsoluteCwd(cwd);
  const defaults = await appServer.configuredModelSettings(absoluteCwd);
  const state = { threadId: "", runtimeId: randomUUID(), connectorId, cwd, model: defaults.model || "", reasoningEffort: defaults.reasoningEffort || "", messages: [], inflight: null };
  selectedRunnerKey = runnerKeyForState(state);
  await writeState(state, connectorId);
  const draft = await draftForState(state, connectorId);
  const mode = await followModeForState(state, connectorId);
  const payload = { ...state, absoluteCwd: resolveAbsoluteCwd(state), draft, followMode: mode, contextUsage, runningThreads: runningThreads() };
  broadcast({ type: "state", connectorId, ...payload });
  return payload;
}

export async function markThreadCompletedUnread(threadId = "", runner = null) {
  if (!threadId || (runner && isRunnerSelected(runner)) || selectedRunnerKey === `${runner?.connectorId ? `${runner.connectorId}:` : ""}thread:${threadId}`) return;
  await setThreadCompletion(threadId, { completedAt: new Date().toISOString() });
  broadcast({ type: "thread_completion", threadId, completedUnread: true });
}

export async function clearThreadCompletedUnread(threadId = "") {
  if (!threadId) return;
  const completions = await readThreadCompletions();
  if (!Object.prototype.hasOwnProperty.call(completions, threadId)) return;
  await setThreadCompletion(threadId, null);
  broadcast({ type: "thread_completion", threadId, completedUnread: false });
}

export async function markInterruptedInflight(connectorId = "") {
  const state = await readState(connectorId);
  if (!state.inflight) return;
  const startedAt = state.inflight.startedAt ? new Date(state.inflight.startedAt).toLocaleString("zh-CN") : "";
  const failureMessage = `❌ 上次任务因为网页后台服务重启而中断${startedAt ? `（开始于 ${startedAt}）` : ""}。请重新发送这条任务继续执行。`;
  state.messages.push({
    role: "assistant",
    content: failureMessage,
    at: new Date().toISOString()
  });
  state.messages = state.messages.slice(-80);
  state.inflight = null;
  await writeState(syncLoadedCounts(state), connectorId);
  dispatchTaskTerminalNotification(failureMessage);
}
