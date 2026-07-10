import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { rootDir, restartScript, codexConnectWaitMs, codexConnectTimeoutMs, codexWorkDir } from "./config.js";
import { cleanText } from "./utils.js";
import { broadcast } from "./sse.js";
import {
  readState, writeState, draftForState, saveDraftForState,
  followModeForState, saveFollowModeForState, rememberMessageMeta,
  readThreadNames, writeThreadNames, threadName,
  readThreadCompletions, writeThreadCompletions, syncLoadedCounts,
  modelSettingsForThread, saveThreadModelSettings, deleteThreadModelSettings
} from "./store.js";
import { stateAbsoluteCwd, safeStateCwdValue, stateCwdValue, assertProjectDirectory } from "./paths.js";
import {
  threadTitle, loadThreadFromProvider, deleteThreadFromProvider,
  localSessionProvider, listSessionEntries, mergeLocalMessageMeta,
  freshContextUsage, assistantBubbleText
} from "./threads.js";
import { createLocalAppServer } from "./codex-server.js";
import { getConnectorAppServer, remoteSessionProvider, isConnectorOnline } from "./connectors.js";
import { completionMessage, notifyWechatTaskDone, sendWebPushTaskDone } from "./webpush.js";

export const runners = new Map();
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

const modelDescriptionsZh = {
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
function getLocalAppServer() {
  if (!localAppServer) localAppServer = createLocalAppServer();
  return localAppServer;
}

export function appServerForState(state = {}) {
  if (state.connectorId) return getConnectorAppServer(state.connectorId);
  return getLocalAppServer();
}

async function sessionModelSettings(state = {}) {
  if (state.threadId) {
    const saved = await modelSettingsForThread(state.threadId, state.connectorId || "");
    if (saved?.model) return saved;
    const provider = state.connectorId ? remoteSessionProvider(state.connectorId) : localSessionProvider;
    const thread = await loadThreadFromProvider(state.threadId, provider).catch(() => null);
    if (thread?.model) {
      const inferred = { model: thread.model, reasoningEffort: thread.reasoningEffort || "" };
      await saveThreadModelSettings(state.threadId, inferred, state.connectorId || "");
      return inferred;
    }
  }
  const server = appServerForState(state);
  const cwd = state.connectorId ? String(state.cwd || "") : stateAbsoluteCwd(state.cwd || "");
  return server.configuredModelSettings(cwd);
}

export async function ensureStateModelSettings(state = {}) {
  if (state.threadId) {
    const saved = await modelSettingsForThread(state.threadId, state.connectorId || "");
    if (saved?.model) {
      state.model = saved.model;
      state.reasoningEffort = saved.reasoningEffort || "";
      return state;
    }
  }
  if (state.model && state.reasoningEffort) {
    if (state.threadId) await saveThreadModelSettings(state.threadId, state, state.connectorId || "");
    return state;
  }
  const settings = await sessionModelSettings(state);
  state.model = state.model || settings.model || "";
  state.reasoningEffort = state.reasoningEffort || settings.reasoningEffort || "";
  return state;
}

async function saveStateModelSettings(state = {}, runner = null) {
  if (state.threadId) await saveThreadModelSettings(state.threadId, state, state.connectorId || "");
  if (runner) {
    runner.state.model = state.model || "";
    runner.state.reasoningEffort = state.reasoningEffort || "";
  }
  await writeState(syncLoadedCounts(state), state.connectorId || "");
}

function publicModelSettings(state = {}, models = [], running = false) {
  return {
    threadId: state.threadId || "",
    model: state.model || "",
    reasoningEffort: state.reasoningEffort || "",
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
  const selectedState = runner?.state || state;
  await ensureStateModelSettings(selectedState);
  const server = runner?.appServer || appServerForState(selectedState);
  return publicModelSettings(selectedState, await server.modelOptions(), Boolean(runner?.running));
}

export async function updateSessionModelSettings(update = {}, connectorId = "") {
  const state = await readState(connectorId);
  state.connectorId = state.connectorId || connectorId;
  const runner = await runnerForState(state, false);
  if (runner?.running) throw Object.assign(new Error("当前会话正在处理，请结束或中断后再切换。"), { statusCode: 409 });
  await ensureStateModelSettings(state);
  const server = runner?.appServer || appServerForState(state);
  const cwd = state.connectorId ? String(state.cwd || "") : stateAbsoluteCwd(state.cwd || "");
  if (update.model) {
    const result = await server.selectModel(update.model, state.reasoningEffort, state.threadId, cwd);
    state.model = result.selected.model || result.selected.id;
    state.reasoningEffort = result.effort;
  }
  if (update.reasoningEffort) {
    const result = await server.selectReasoningEffort(update.reasoningEffort, state.model, state.threadId, cwd);
    state.model = result.selected.model || result.selected.id;
    state.reasoningEffort = result.option.reasoningEffort;
  }
  if (!update.model && !update.reasoningEffort) {
    throw Object.assign(new Error("请选择模型或思考强度。"), { statusCode: 400 });
  }
  await saveStateModelSettings(state, runner);
  return publicModelSettings(state, await server.modelOptions(), false);
}

function resolveAbsoluteCwd(state = {}) {
  return state.connectorId ? String(state.cwd || "") : stateAbsoluteCwd(state.cwd || "");
}

export function runnerKeyForState(state = {}) {
  const c = state.connectorId || "";
  const base = state.threadId ? `thread:${state.threadId}` : `cwd:${state.cwd || ""}`;
  return c ? `${c}:${base}` : base;
}

export function uniqueRunners() {
  return [...new Set(runners.values())];
}

export function runningThreads() {
  return uniqueRunners()
    .filter((runner) => runner.running)
    .map((runner) => ({
      runnerKey: runner.key,
      connectorId: runner.connectorId || "",
      threadId: runner.state.threadId || "",
      cwd: runner.cwd || "",
      title: threadTitle(runner.state.messages || [], runner.cwd ? `/${runner.cwd}` : "根目录会话"),
      messageCount: runner.state.messages?.length || 0,
      queueLength: runner.messageQueue.length
    }));
}

export function isRunnerSelected(runner) {
  if (!runner) return false;
  return runners.get(selectedRunnerKey) === runner || selectedRunnerKey === runner.key || (runner.state.threadId && selectedRunnerKey === runnerKeyForState({ threadId: runner.state.threadId, connectorId: runner.connectorId }));
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
    runningThreads: runningThreads()
  };
}

export function liveMessagesFor(runner) {
  const turn = runner?.appServer?.turn;
  if (!runner?.running || !turn) return [];
  const messages = turn.answers.map((content, index) => ({ role: "assistant", content, messageId: `live-answer-${index}`, final: true }));
  if (turn.currentMessage?.text) {
    messages.push({ role: "assistant", content: assistantBubbleText(turn.currentMessage.text, turn.currentMessage.phase), messageId: turn.currentMessage.id || "assistant", transient: true });
  }
  return messages;
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
  const appServer = appServerForState(state);
  const runner = {
    key,
    connectorId: state.connectorId || "",
    cwd: state.cwd || "",
    state: syncLoadedCounts({ threadId: state.threadId || "", connectorId: state.connectorId || "", cwd: state.cwd || "", model: state.model || "", reasoningEffort: state.reasoningEffort || "", messages: Array.isArray(state.messages) ? state.messages : [], inflight: state.inflight || null }),
    appServer,
    running: false,
    followMode: await followModeForState(state, state.connectorId || ""),
    messageQueue: [],
    steerMessages: [],
    contextUsage: contextUsage || null,
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
  if (!runner && create) runner = await createRunner(state);
  if (runner) runner.followMode = await followModeForState(runner.state, runner.connectorId || "");
  return runner || null;
}

export async function rememberRunnerThread(runner, state = runner.state) {
  if (!runner || !state.threadId) return;
  runner.state.threadId = state.threadId;
  await saveThreadModelSettings(state.threadId, runner.state, runner.connectorId || "");
  runners.set(`${runner.connectorId ? `${runner.connectorId}:` : ""}thread:${state.threadId}`, runner);
}

export async function runnerForIncomingState(state = {}) {
  const cwd = state.cwd || "";
  const selected = await runnerForState(state, false);
  if (selected) return selected;
  return uniqueRunners().find((runner) => runner.running && runner.cwd === cwd && (runner.connectorId || "") === (state.connectorId || "")) || null;
}

export function busyRunnerForCwd(cwd = "", connectorId = "", exceptRunner = null) {
  return uniqueRunners().find((runner) => runner.running && runner.cwd === cwd && (runner.connectorId || "") === connectorId && runner !== exceptRunner) || null;
}

function scheduleServiceRestart() {
  if (!existsSync(restartScript)) throw new Error(`重启脚本不存在：${restartScript}`);
  const child = spawn("cmd.exe", ["/c", restartScript], { cwd: rootDir, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function taskFailureMessage(error) {
  return [
    cleanText(error?.partialAnswer || "", 20000).trim(),
    `❌ 执行失败：${error?.message || "Codex 调用失败"}`
  ].filter(Boolean).join("\n\n");
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
      `- 思考强度：${reasoningEffortLabel(state.reasoningEffort) || "默认"}`
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
    const nextState = { threadId: "", connectorId: state.connectorId || "", cwd: state.cwd || "", model: defaults.model || "", reasoningEffort: defaults.reasoningEffort || "", messages: [] };
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
  let connected = false;
  let waitTimer = null;
  let timeoutTimer = null;
  const clearConnectionTimers = () => { if (waitTimer) clearTimeout(waitTimer); if (timeoutTimer) clearTimeout(timeoutTimer); waitTimer = null; timeoutTimer = null; };
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
      answers = await Promise.race([
        runner.appServer.runTurn(message, state, {
          model: runner.state.model,
          reasoningEffort: runner.state.reasoningEffort,
          onConnected: markConnected,
          onThreadReady: async (st) => {
            runner.state.threadId = st.threadId;
            await rememberRunnerThread(runner, st);
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
        connectionTimeout
      ]);
      markConnected();
      await rememberRunnerThread(runner, state);
    } catch (error) {
      clearConnectionTimers();
      if (error.connectionTimeout) {
        runner.appServer.rejectAll(error);
        answers = [`❌ 连接失败：${error.message}`];
        broadcastRunner(runner, { type: "message", role: "assistant", content: `❌ 连接失败：${error.message}`, messageId: connectionMessageId, final: true });
      } else {
        answers = [taskFailureMessage(error)];
      }
      ok = false;
    }
    const savedAnswers = answers.length ? answers : ["Codex 没有返回文本。"];
    const inflightStartedAtMs = state.inflight?.startedAt ? Date.parse(state.inflight.startedAt) : NaN;
    const startedAtMs = Number.isFinite(runnerStartedAtMs) ? runnerStartedAtMs : inflightStartedAtMs;
    const taskDurationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null;
    const completionIndex = savedAnswers.reduce((lastIndex, answer, index) => (/^✅\s/.test(answer || "") ? index : lastIndex), -1);
    const savedMessages = [];
    for (const [index, answer] of savedAnswers.entries()) {
      const msg = { role: "assistant", content: answer, at: new Date().toISOString() };
      if (index === completionIndex && taskDurationMs !== null) msg.taskDurationMs = taskDurationMs;
      savedMessages.push(msg);
      state.messages.push(msg);
    }
    state.messages = state.messages.slice(-80);
    state.inflight = null;
    runner.state = syncLoadedCounts(state);
    await rememberMessageMeta(runner.state.threadId, savedMessages);
    await writeState(runner.state, runner.connectorId || "");
    broadcastRunner(runner, { type: "state_saved", threadId: runner.state.threadId });
    if (!ok) {
      savedAnswers.forEach((answer, index) => {
        const payload = { type: "message", role: "assistant", content: answer, messageId: `task-failed-${Date.now()}-${index}`, final: true };
        if (index === completionIndex && taskDurationMs !== null) payload.taskDurationMs = taskDurationMs;
        broadcastRunner(runner, payload);
      });
    }
    broadcastRunner(runner, { type: "done", ok, threadId: runner.state.threadId });
    const taskDoneMessage = completionMessage(savedAnswers);
    if (ok && taskDoneMessage) {
      notifyWechatTaskDone(taskDoneMessage);
      sendWebPushTaskDone(taskDoneMessage).catch((error) => console.error("web push task notification failed", error.message || error));
    }
  } catch (error) {
    console.error("remote task failed", error);
    const failureMessage = taskFailureMessage(error);
    state.inflight = null;
    state.messages.push({ role: "assistant", content: failureMessage, at: new Date().toISOString(), taskDurationMs: Number.isFinite(runnerStartedAtMs) ? Math.max(0, Date.now() - runnerStartedAtMs) : undefined });
    state.messages = state.messages.slice(-80);
    runner.state = syncLoadedCounts(state);
    await rememberMessageMeta(runner.state.threadId, runner.state.messages);
    await writeState(runner.state, runner.connectorId || "").catch((writeError) => console.error("failed to save task failure", writeError));
    const failurePayload = { type: "message", role: "assistant", content: failureMessage, messageId: `task-failed-${Date.now()}`, final: true };
    if (Number.isFinite(runnerStartedAtMs)) failurePayload.taskDurationMs = Math.max(0, Date.now() - runnerStartedAtMs);
    broadcastRunner(runner, failurePayload);
    broadcastRunner(runner, { type: "done", ok: false, threadId: runner.state.threadId });
  } finally {
    runner.running = false;
    runner.taskStartedAtMs = null;
    runner.steerMessages = [];
    await markThreadCompletedUnread(runner.state.threadId, runner).catch((markError) => console.error("failed to mark completed thread", markError));
    processNextQueuedMessage(runner);
  }
}

export async function startRemoteTask(message, state, runner = null, options = {}) {
  runner = runner || await runnerForState(state, true);
  const busy = busyRunnerForCwd(state.cwd || "", state.connectorId || "", runner);
  if (busy) throw new Error(`这个文件夹已有任务正在运行：/${busy.cwd || "root"}`);
  runner.running = true;
  runner.steerMessages = [];
  runner.cwd = state.cwd || "";
  runner.state = syncLoadedCounts({ ...state, cwd: runner.cwd, messages: Array.isArray(state.messages) ? state.messages : [], inflight: state.inflight || null });
  if (!options.skipUserMessage) runner.state.messages.push({ role: "user", content: message, at: new Date().toISOString() });
  runner.state.messages = runner.state.messages.slice(-80);
  runner.taskStartedAtMs = Date.now();
  runner.state.inflight = { message, cwd: runner.cwd, startedAt: new Date(runner.taskStartedAtMs).toISOString() };
  selectedRunnerKey = runner.key;
  await writeState(runner.state, runner.connectorId || "");
  if (!options.skipUserMessage) {
    const savedUserMessage = runner.state.messages[runner.state.messages.length - 1];
    broadcastRunner(runner, { type: "message", ...savedUserMessage });
  }
  broadcastRunner(runner, statusPayload(runner, true));
  runRemoteTask(message, runner);
}

function processNextQueuedMessage(runner) {
  const next = runner.messageQueue.shift();
  if (!next) { broadcastRunner(runner, statusPayload(runner, false)); return; }
  startRemoteTask(next.message, runner.state, runner, { skipUserMessage: Boolean(next.displayed) })
    .catch((error) => {
      console.error("failed to start queued task", error);
      runner.running = false;
      broadcastRunner(runner, { type: "error", text: error.message || "队列任务启动失败" });
      processNextQueuedMessage(runner);
    });
}

export async function submitRemoteMessage(message, requestedFollowMode = "", connectorId = "") {
  const text = cleanText(message, 30000).trim();
  if (!text) throw Object.assign(new Error("请先输入内容。"), { statusCode: 400 });
  const oneShotFollowMode = requestedFollowMode === "steer" ? "steer" : requestedFollowMode === "queue" ? "queue" : "";
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
      contextUsage: runner?.contextUsage || contextUsage, threadId: state.threadId, runningThreads: runningThreads()
    };
  }
  const state = await readState(connectorId);
  await saveDraftForState(state, "", connectorId);
  selectedRunnerKey = runnerKeyForState(state);
  let runner = await runnerForState(state, true);
  const busy = busyRunnerForCwd(state.cwd || "", connectorId, runner);
  if (busy) throw Object.assign(new Error(`这个文件夹已有任务正在运行，请在会话列表打开红色运行中会话：/${busy.cwd || "root"}`), { statusCode: 409 });
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
        return { ok: true, accepted: true, steered: true, queueLength: runner.messageQueue.length, queueMessages: queueMessagesFor(runner), steerLength: runner.steerMessages.length, steerMessages: steerMessagesFor(runner), followMode: runner.followMode, threadId: runner.state.threadId, runningThreads: runningThreads() };
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
    return { ok: true, accepted: true, queued: true, queueLength: runner.messageQueue.length, queueMessages: queueMessagesFor(runner), followMode: runner.followMode, threadId: runner.state.threadId, runningThreads: runningThreads() };
  }
  await startRemoteTask(text, state, runner);
  return { ok: true, accepted: true, queued: false, threadId: runner.state.threadId, runningThreads: runningThreads() };
}

export async function listThreads(connectorId = "") {
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  const entries = await listSessionEntries(provider);
  const names = await readThreadNames();
  const completions = await readThreadCompletions();
  const rows = [];
  const includedThreadIds = new Set();
  const runningByThread = new Map();
  const runningRows = [];
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
  for (const item of entries) {
    const parsed = (await import("./threads.js")).parseSessionFile(await provider.readFile(item.file), item.file);
    if (!parsed.threadId) continue;
    const name = typeof names[parsed.threadId] === "string" ? names[parsed.threadId] : "";
    const runner = runningByThread.get(parsed.threadId);
    includedThreadIds.add(parsed.threadId);
    rows.push({
      threadId: parsed.threadId,
      title: name || threadTitle(runner?.state.messages || parsed.messages),
      originalTitle: threadTitle(runner?.state.messages || parsed.messages),
      name, cwd: runner?.cwd || parsed.cwd,
      updatedAt: runner?.state.inflight?.startedAt || parsed.updatedAt,
      messageCount: runner?.state.messages?.length || parsed.messageCount,
      running: Boolean(runner?.running),
      completedUnread: Boolean(!runner?.running && completions[parsed.threadId]),
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
  return [...runningRows, ...rows];
}

export async function selectRemoteThread(rawThreadId, connectorId = "") {
  const threadId = cleanText(rawThreadId, 120).trim();
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  if (threadId.startsWith("runtime:")) {
    const runner = runners.get(threadId.slice("runtime:".length));
    if (!runner) throw Object.assign(new Error("这个运行中会话已经结束。"), { statusCode: 404 });
    selectedRunnerKey = runner.key;
    await writeState(runner.state, runner.connectorId || "");
    const payload = runnerStatePayload(runner, { threadName: "" });
    payload.draft = await draftForState(runner.state, runner.connectorId || "");
    broadcast({ type: "state", connectorId, ...payload });
    return payload;
  }
  const existingRunner = runners.get(`${connectorId ? `${connectorId}:` : ""}thread:${threadId}`);
  if (existingRunner?.running) {
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
  await clearThreadCompletedUnread(threadId);
  const messages = await mergeLocalMessageMeta(thread.threadId, thread.messages, []);
  const state = { threadId: thread.threadId, connectorId, cwd: thread.cwd || "", model: thread.model || "", reasoningEffort: thread.reasoningEffort || "", messages, loadedCount: messages.length, messageCount: thread.messageCount, inflight: null };
  await ensureStateModelSettings(state);
  selectedRunnerKey = runnerKeyForState(state);
  contextUsage = thread.contextUsage || null;
  const name = await threadName(thread.threadId);
  await writeState(state, connectorId);
  const draft = await draftForState(state, connectorId);
  const mode = await followModeForState(state, connectorId);
  const payload = { ...state, absoluteCwd: resolveAbsoluteCwd(state), threadName: name, draft, followMode: mode, contextUsage, runningThreads: runningThreads() };
  broadcast({ type: "state", connectorId, ...payload });
  return payload;
}

export async function loadThreadPage(threadId, connectorId = "") {
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  return loadThreadFromProvider(threadId, provider, 1000);
}

export async function deleteThread(threadId, connectorId = "") {
  const provider = connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
  await deleteThreadFromProvider(threadId, provider);
  await deleteThreadModelSettings(threadId, connectorId);
}

export async function createRemoteSession(rawCwd = "", connectorId = "") {
  const cwd = connectorId ? String(rawCwd || "") : stateCwdValue(rawCwd || "");
  if (!connectorId) await assertProjectDirectory(cwd);
  const busy = busyRunnerForCwd(cwd, connectorId);
  if (busy) {
    selectedRunnerKey = busy.key;
    await writeState(busy.state, busy.connectorId || "");
    const payload = runnerStatePayload(busy, { draft: await draftForState(busy.state, busy.connectorId || "") });
    broadcast({ type: "state", connectorId, ...payload });
    return payload;
  }
  const appServer = appServerForState({ connectorId });
  appServer.activeThreadId = "";
  appServer.activeCwd = "";
  contextUsage = freshContextUsage();
  const absoluteCwd = connectorId ? cwd : stateAbsoluteCwd(cwd);
  const defaults = await appServer.configuredModelSettings(absoluteCwd);
  const state = { threadId: "", connectorId, cwd, model: defaults.model || "", reasoningEffort: defaults.reasoningEffort || "", messages: [], inflight: null };
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
  const completions = await readThreadCompletions();
  completions[threadId] = { completedAt: new Date().toISOString() };
  await writeThreadCompletions(completions);
  broadcast({ type: "thread_completion", threadId, completedUnread: true });
}

export async function clearThreadCompletedUnread(threadId = "") {
  if (!threadId) return;
  const completions = await readThreadCompletions();
  if (!Object.prototype.hasOwnProperty.call(completions, threadId)) return;
  delete completions[threadId];
  await writeThreadCompletions(completions);
  broadcast({ type: "thread_completion", threadId, completedUnread: false });
}

export async function markInterruptedInflight(connectorId = "") {
  const state = await readState(connectorId);
  if (!state.inflight) return;
  const startedAt = state.inflight.startedAt ? new Date(state.inflight.startedAt).toLocaleString("zh-CN") : "";
  state.messages.push({
    role: "assistant",
    content: `上次任务因为网页后台服务重启而中断${startedAt ? `（开始于 ${startedAt}）` : ""}。请重新发送这条任务继续执行。`,
    at: new Date().toISOString()
  });
  state.messages = state.messages.slice(-80);
  state.inflight = null;
  await writeState(syncLoadedCounts(state), connectorId);
}
