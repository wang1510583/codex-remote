import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  dataDir, statePath, draftsPath, followModesPath, messageMetaPath,
  threadNamesPath, threadCompletionsPath
} from "./config.js";
import { cleanText } from "./utils.js";

export function connectorPrefix(connectorId = "") {
  return connectorId ? `${connectorId}:` : "";
}

export function statePathFor(connectorId = "") {
  return connectorId ? path.join(dataDir, `remote-state-${connectorId}.json`) : statePath;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      console.error(`failed to parse ${file}; resetting`, error.message);
      return fallback;
    }
    throw error;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export async function readState(connectorId = "") {
  const parsed = await readJson(statePathFor(connectorId), null);
  if (!parsed) return { threadId: "", connectorId, cwd: "", messages: [], inflight: null };
  return {
    threadId: typeof parsed.threadId === "string" ? parsed.threadId : "",
    connectorId: connectorId || (typeof parsed.connectorId === "string" ? parsed.connectorId : ""),
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
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

async function writeDrafts(drafts) {
  await writeJson(draftsPath, drafts);
}

export async function draftForState(state = {}, connectorId = "") {
  const drafts = await readDrafts();
  const prefix = connectorPrefix(connectorId);
  const item = drafts[`${prefix}${draftKeyFor(state.threadId || "", state.cwd || "")}`];
  return typeof item?.text === "string" ? item.text : "";
}

export async function saveDraftForState(state = {}, text = "", connectorId = "") {
  const drafts = await readDrafts();
  const prefix = connectorPrefix(connectorId);
  const key = `${prefix}${draftKeyFor(state.threadId || "", state.cwd || "")}`;
  if (text) drafts[key] = { text, updatedAt: new Date().toISOString() };
  else delete drafts[key];
  await writeDrafts(drafts);
}

async function readFollowModes() {
  const parsed = await readJson(followModesPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function writeFollowModes(modes) {
  await writeJson(followModesPath, modes);
}

export async function followModeForState(state = {}, connectorId = "") {
  const modes = await readFollowModes();
  const mode = modes[`${connectorPrefix(connectorId)}${stateKeyFor(state)}`];
  return mode === "steer" ? "steer" : "queue";
}

export async function saveFollowModeForState(state = {}, mode = "queue", connectorId = "") {
  const modes = await readFollowModes();
  modes[`${connectorPrefix(connectorId)}${stateKeyFor(state)}`] = mode === "steer" ? "steer" : "queue";
  await writeFollowModes(modes);
}

export async function readMessageMeta() {
  const parsed = await readJson(messageMetaPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function writeMessageMeta(meta) {
  await writeJson(messageMetaPath, meta);
}

export function messageMetaKey(message = {}) {
  return createHash("sha256").update(`${message.role || ""}\n${message.content || ""}`).digest("hex");
}

export async function rememberMessageMeta(threadId = "", messages = []) {
  if (!threadId) return;
  const rows = (messages || []).filter((message) => message?.taskDurationMs !== undefined && message?.taskDurationMs !== null);
  if (!rows.length) return;
  const meta = await readMessageMeta();
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
  await writeMessageMeta(meta);
}

export async function readThreadNames() {
  const parsed = await readJson(threadNamesPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function writeThreadNames(names) {
  await writeJson(threadNamesPath, names);
}

export async function threadName(threadId) {
  const names = await readThreadNames();
  return typeof names[threadId] === "string" ? names[threadId] : "";
}

export async function readThreadCompletions() {
  const parsed = await readJson(threadCompletionsPath, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function writeThreadCompletions(completions) {
  await writeJson(threadCompletionsPath, completions);
}

export function syncLoadedCounts(state) {
  state.loadedCount = Array.isArray(state.messages) ? state.messages.length : 0;
  state.messageCount = Math.max(Number(state.messageCount) || 0, state.loadedCount);
  return state;
}
