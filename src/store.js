import { createHash } from "node:crypto";
import path from "node:path";
import {
  dataDir, statePath, draftsPath, followModesPath, messageMetaPath,
  threadNamesPath, threadCompletionsPath, connectorsViewStatePath, threadModelSettingsPath,
  liveVoiceTranscriptsPath, threadNoticesPath
} from "./config.js";
import { cleanText } from "./utils.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json-file.js";

export function connectorPrefix(connectorId = "") {
  return connectorId ? `${connectorId}:` : "";
}

export function statePathFor(connectorId = "") {
  return connectorId ? path.join(dataDir, `remote-state-${connectorId}.json`) : statePath;
}

async function readJson(file, fallback) {
  return readJsonFile(file, fallback);
}

async function writeJson(file, data) {
  await writeJsonFile(file, data);
}

async function updateJson(file, fallback, update) {
  return updateJsonFile(file, fallback, update);
}

export const liveVoiceTranscriptPrefix = "语音对话：";
const liveVoiceTranscriptLimit = 500;

export function labelLiveVoiceTranscript(content = "") {
  const text = cleanText(content, 20000).trim();
  if (!text) return "";
  return text.startsWith(liveVoiceTranscriptPrefix)
    ? text
    : `${liveVoiceTranscriptPrefix}${text}`;
}

function storedLiveVoiceTranscript(message = {}) {
  const role = String(message.role || "").toLowerCase();
  const content = labelLiveVoiceTranscript(message.content || "");
  if ((role !== "user" && role !== "assistant") || !content) return null;
  return {
    role,
    content,
    at: String(message.at || new Date().toISOString()),
    liveVoiceTranscript: true
  };
}

/**
 * Live Voice transcript events can arrive after the web UI switches threads.
 * Keep them in a separate, thread-keyed file so ordinary state refreshes can
 * never overwrite a completed voice turn.
 */
export async function appendLiveVoiceTranscript(threadId = "", message = {}) {
  const id = String(threadId || "").trim();
  const next = storedLiveVoiceTranscript(message);
  if (!id || !next) return { added: false, message: null };
  let result = { added: false, message: null };
  await updateJson(liveVoiceTranscriptsPath, {}, (all) => {
    const rows = Array.isArray(all[id]) ? all[id] : [];
    const last = rows.at(-1);
    if (last?.role === next.role && last?.content === next.content) {
      result = { added: false, message: last };
      return all;
    }
    all[id] = [...rows, next].slice(-liveVoiceTranscriptLimit);
    result = { added: true, message: next };
    return all;
  });
  return result;
}

export async function readLiveVoiceTranscripts(threadId = "") {
  const id = String(threadId || "").trim();
  if (!id) return [];
  const all = await readJson(liveVoiceTranscriptsPath, {});
  const rows = Array.isArray(all?.[id]) ? all[id] : [];
  return rows.map(storedLiveVoiceTranscript).filter(Boolean);
}

export async function deleteLiveVoiceTranscripts(threadId = "") {
  const id = String(threadId || "").trim();
  if (!id) return;
  await updateJson(liveVoiceTranscriptsPath, {}, (all) => {
    delete all[id];
    return all;
  });
}

const threadNoticeLimit = 200;

function threadNoticeKey(threadId = "", connectorId = "") {
  const id = String(threadId || "").trim();
  return id ? `${connectorPrefix(connectorId)}${id}` : "";
}

function storedThreadNotice(message = {}) {
  const role = String(message.role || "assistant").toLowerCase();
  const content = cleanText(message.content || "", 20000).trim();
  if ((role !== "user" && role !== "assistant") || !content) return null;
  return {
    role,
    content,
    at: String(message.at || new Date().toISOString()),
    threadNotice: true,
    ...(message.taskFailed ? { taskFailed: true } : {}),
    ...(Number.isFinite(message.taskDurationMs) ? { taskDurationMs: message.taskDurationMs } : {})
  };
}

export async function appendThreadNotice(threadId = "", message = {}, connectorId = "") {
  const key = threadNoticeKey(threadId, connectorId);
  const next = storedThreadNotice(message);
  if (!key || !next) return { added: false, message: null };
  let result = { added: false, message: null };
  await updateJson(threadNoticesPath, {}, (all) => {
    const rows = Array.isArray(all[key]) ? all[key] : [];
    const duplicate = rows.at(-1)?.role === next.role
      && rows.at(-1)?.content === next.content
      ? rows.at(-1)
      : null;
    if (duplicate) {
      result = { added: false, message: duplicate };
      return all;
    }
    all[key] = [...rows, next].slice(-threadNoticeLimit);
    result = { added: true, message: next };
    return all;
  });
  return result;
}

export async function readThreadNotices(threadId = "", connectorId = "") {
  const key = threadNoticeKey(threadId, connectorId);
  if (!key) return [];
  const all = await readJson(threadNoticesPath, {});
  const rows = Array.isArray(all?.[key]) ? all[key] : [];
  return rows.map(storedThreadNotice).filter(Boolean);
}

export async function deleteThreadNotices(threadId = "", connectorId = "") {
  const key = threadNoticeKey(threadId, connectorId);
  if (!key) return;
  await updateJson(threadNoticesPath, {}, (all) => {
    delete all[key];
    return all;
  });
}

export async function readState(connectorId = "") {
  const parsed = await readJson(statePathFor(connectorId), null);
  if (!parsed) return {
    threadId: "", runtimeId: "", connectorId, cwd: "", model: "", reasoningEffort: "",
    modelSettingsUpdatedAt: "", modelSettingsSource: "", messages: [], inflight: null
  };
  return {
    threadId: typeof parsed.threadId === "string" ? parsed.threadId : "",
    runtimeId: typeof parsed.runtimeId === "string" ? parsed.runtimeId : "",
    connectorId: connectorId || (typeof parsed.connectorId === "string" ? parsed.connectorId : ""),
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
    reasoningEffort: typeof parsed.reasoningEffort === "string" ? parsed.reasoningEffort : "",
    modelSettingsUpdatedAt: typeof parsed.modelSettingsUpdatedAt === "string" ? parsed.modelSettingsUpdatedAt : "",
    modelSettingsSource: typeof parsed.modelSettingsSource === "string" ? parsed.modelSettingsSource : "",
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    inflight: parsed.inflight && typeof parsed.inflight === "object" ? parsed.inflight : null
  };
}

export async function writeState(state, connectorId = "") {
  await writeJson(statePathFor(connectorId), state);
}

export async function writeStateIfIdle(state, connectorId = "") {
  await updateJson(statePathFor(connectorId), {}, (current) => {
    const currentThreadId = typeof current.threadId === "string" ? current.threadId : "";
    if (currentThreadId !== String(state.threadId || "") || current.inflight) return current;
    if (!currentThreadId && state.runtimeId) {
      const currentRuntimeId = typeof current.runtimeId === "string" ? current.runtimeId : "";
      if (currentRuntimeId !== String(state.runtimeId)) return current;
    }
    const currentSettingsTime = Date.parse(current.modelSettingsUpdatedAt || "");
    const nextSettingsTime = Date.parse(state.modelSettingsUpdatedAt || "");
    if (Number.isFinite(currentSettingsTime) && (!Number.isFinite(nextSettingsTime) || currentSettingsTime > nextSettingsTime)) {
      return {
        ...state,
        model: current.model || "",
        reasoningEffort: current.reasoningEffort || "",
        modelSettingsUpdatedAt: current.modelSettingsUpdatedAt || "",
        modelSettingsSource: current.modelSettingsSource || ""
      };
    }
    return state;
  });
}

export async function updateStateModelSettings(expectedState = {}, value = {}, connectorId = "") {
  await updateJson(statePathFor(connectorId), {}, (current) => {
    const expectedThreadId = String(expectedState.threadId || "");
    const currentThreadId = typeof current.threadId === "string" ? current.threadId : "";
    if (currentThreadId !== expectedThreadId) return current;
    if (!expectedThreadId) {
      const expectedRuntimeId = String(expectedState.runtimeId || "");
      const currentRuntimeId = typeof current.runtimeId === "string" ? current.runtimeId : "";
      if (expectedRuntimeId && currentRuntimeId !== expectedRuntimeId) return current;
      const expectedCwd = String(expectedState.cwd || "");
      const currentCwd = typeof current.cwd === "string" ? current.cwd : "";
      if (currentCwd && currentCwd !== expectedCwd) return current;
    }
    return {
      ...current,
      model: String(value.model || ""),
      reasoningEffort: String(value.reasoningEffort || ""),
      modelSettingsUpdatedAt: String(value.updatedAt || value.modelSettingsUpdatedAt || ""),
      modelSettingsSource: String(value.source || value.modelSettingsSource || "")
    };
  });
}

export function draftKeyFor(threadId = "", cwd = "") {
  return threadId ? `thread:${threadId}` : `new:${cwd || "root"}`;
}

export function stateKeyFor(state = {}) {
  if (state.threadId) return `thread:${state.threadId}`;
  if (state.runtimeId) return `runtime:${state.runtimeId}`;
  return `cwd:${state.cwd || ""}`;
}

async function readDrafts() {
  const parsed = await readJson(draftsPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function draftForState(state = {}, connectorId = "") {
  const drafts = await readDrafts();
  const prefix = connectorPrefix(connectorId);
  const item = drafts[`${prefix}${draftKeyFor(state.threadId || "", state.cwd || "")}`];
  return typeof item?.text === "string" ? item.text : "";
}

export async function saveDraftForState(state = {}, text = "", connectorId = "") {
  const prefix = connectorPrefix(connectorId);
  const key = `${prefix}${draftKeyFor(state.threadId || "", state.cwd || "")}`;
  await updateJson(draftsPath, {}, (drafts) => {
    if (text) drafts[key] = { text, updatedAt: new Date().toISOString() };
    else delete drafts[key];
    return drafts;
  });
}

async function readFollowModes() {
  const parsed = await readJson(followModesPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function followModeForState(state = {}, connectorId = "") {
  const modes = await readFollowModes();
  const mode = modes[`${connectorPrefix(connectorId)}${stateKeyFor(state)}`];
  return mode === "steer" ? "steer" : "queue";
}

export async function saveFollowModeForState(state = {}, mode = "queue", connectorId = "") {
  const key = `${connectorPrefix(connectorId)}${stateKeyFor(state)}`;
  await updateJson(followModesPath, {}, (modes) => {
    modes[key] = mode === "steer" ? "steer" : "queue";
    return modes;
  });
}

async function readAllThreadModelSettings() {
  const parsed = await readJson(threadModelSettingsPath, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export async function modelSettingsForThread(threadId = "", connectorId = "") {
  if (!threadId) return null;
  const settings = await readAllThreadModelSettings();
  const value = settings[`${connectorPrefix(connectorId)}${threadId}`];
  if (!value || typeof value !== "object") return null;
  const model = typeof value.model === "string" ? value.model : "";
  const reasoningEffort = typeof value.reasoningEffort === "string" ? value.reasoningEffort : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  const source = typeof value.source === "string" ? value.source : "";
  return model ? { model, reasoningEffort, updatedAt, source } : null;
}

export function shouldReplaceThreadModelSettings(existing = {}, incoming = {}) {
  const existingTime = Date.parse(existing.updatedAt || "");
  const incomingTime = Date.parse(incoming.updatedAt || "");
  return !(Number.isFinite(existingTime) && Number.isFinite(incomingTime) && incomingTime < existingTime);
}

export async function saveThreadModelSettings(threadId = "", value = {}, connectorId = "") {
  if (!threadId || !value.model) return;
  const key = `${connectorPrefix(connectorId)}${threadId}`;
  await updateJson(threadModelSettingsPath, {}, (settings) => {
    const requestedUpdatedAt = typeof value.updatedAt === "string" && value.updatedAt
      ? value.updatedAt
      : (typeof value.modelSettingsUpdatedAt === "string" && value.modelSettingsUpdatedAt
          ? value.modelSettingsUpdatedAt
          : new Date().toISOString());
    if (!shouldReplaceThreadModelSettings(settings[key], { updatedAt: requestedUpdatedAt })) {
      return settings;
    }
    settings[key] = {
      model: String(value.model),
      reasoningEffort: String(value.reasoningEffort || ""),
      updatedAt: requestedUpdatedAt,
      source: typeof value.source === "string"
        ? value.source
        : (typeof value.modelSettingsSource === "string" ? value.modelSettingsSource : "")
    };
    return settings;
  });
}

export async function deleteThreadModelSettings(threadId = "", connectorId = "") {
  if (!threadId) return;
  const key = `${connectorPrefix(connectorId)}${threadId}`;
  await updateJson(threadModelSettingsPath, {}, (settings) => {
    delete settings[key];
    return settings;
  });
}

export async function readMessageMeta() {
  const parsed = await readJson(messageMetaPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function messageMetaKey(message = {}) {
  return createHash("sha256").update(`${message.role || ""}\n${message.content || ""}`).digest("hex");
}

export async function rememberMessageMeta(threadId = "", messages = []) {
  if (!threadId) return;
  const rows = (messages || []).filter((message) => message?.taskDurationMs !== undefined && message?.taskDurationMs !== null);
  if (!rows.length) return;
  await updateJson(messageMetaPath, {}, (meta) => {
    const threadMeta = meta[threadId] && typeof meta[threadId] === "object" ? meta[threadId] : {};
    for (const message of rows) {
      const key = messageMetaKey(message);
      const items = Array.isArray(threadMeta[key]) ? threadMeta[key] : [];
      const taskDurationMs = Number(message.taskDurationMs);
      if (!Number.isFinite(taskDurationMs)) continue;
      if (!items.some((item) => Number(item.taskDurationMs) === taskDurationMs)) {
        items.push({ taskDurationMs, updatedAt: new Date().toISOString() });
      }
      threadMeta[key] = items.slice(-20);
    }
    meta[threadId] = threadMeta;
    return meta;
  });
}

export async function readThreadNames() {
  const parsed = await readJson(threadNamesPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function setThreadName(threadId = "", name = "") {
  if (!threadId) return;
  await updateJson(threadNamesPath, {}, (names) => {
    if (name) names[threadId] = name;
    else delete names[threadId];
    return names;
  });
}

export async function threadName(threadId) {
  const names = await readThreadNames();
  return typeof names[threadId] === "string" ? names[threadId] : "";
}

export async function readThreadCompletions() {
  const parsed = await readJson(threadCompletionsPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function setThreadCompletion(threadId = "", value = null) {
  if (!threadId) return;
  await updateJson(threadCompletionsPath, {}, (completions) => {
    if (value) completions[threadId] = value;
    else delete completions[threadId];
    return completions;
  });
}

export async function readConnectorViewState() {
  const parsed = await readJson(connectorsViewStatePath, {});
  return parsed && typeof parsed === "object" ? {
    selectedConnectorId: typeof parsed.selectedConnectorId === "string" ? parsed.selectedConnectorId : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
  } : { selectedConnectorId: "", updatedAt: "" };
}

export async function writeConnectorViewState(selectedConnectorId = "") {
  const view = { selectedConnectorId: cleanText(selectedConnectorId, 80).replace(/[^A-Za-z0-9_-]/g, ""), updatedAt: new Date().toISOString() };
  await writeJson(connectorsViewStatePath, view);
  return view;
}

export function syncLoadedCounts(state) {
  state.loadedCount = Array.isArray(state.messages) ? state.messages.length : 0;
  state.messageCount = Math.max(Number(state.messageCount) || 0, state.loadedCount);
  return state;
}
