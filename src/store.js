import { createHash } from "node:crypto";
import path from "node:path";
import {
  dataDir, statePath, draftsPath, followModesPath, messageMetaPath,
  threadNamesPath, threadCompletionsPath, connectorsViewStatePath, threadModelSettingsPath
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

export async function readState(connectorId = "") {
  const parsed = await readJson(statePathFor(connectorId), null);
  if (!parsed) return { threadId: "", connectorId, cwd: "", model: "", reasoningEffort: "", messages: [], inflight: null };
  return {
    threadId: typeof parsed.threadId === "string" ? parsed.threadId : "",
    connectorId: connectorId || (typeof parsed.connectorId === "string" ? parsed.connectorId : ""),
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
    reasoningEffort: typeof parsed.reasoningEffort === "string" ? parsed.reasoningEffort : "",
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    inflight: parsed.inflight && typeof parsed.inflight === "object" ? parsed.inflight : null
  };
}

export async function writeState(state, connectorId = "") {
  await writeJson(statePathFor(connectorId), state);
}

export function draftKeyFor(threadId = "", cwd = "") {
  return threadId ? `thread:${threadId}` : `new:${cwd || "root"}`;
}

export function stateKeyFor(state = {}) {
  return state.threadId ? `thread:${state.threadId}` : `cwd:${state.cwd || ""}`;
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
  return model ? { model, reasoningEffort } : null;
}

export async function saveThreadModelSettings(threadId = "", value = {}, connectorId = "") {
  if (!threadId || !value.model) return;
  const key = `${connectorPrefix(connectorId)}${threadId}`;
  await updateJson(threadModelSettingsPath, {}, (settings) => {
    settings[key] = {
      model: String(value.model),
      reasoningEffort: String(value.reasoningEffort || ""),
      updatedAt: new Date().toISOString()
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
