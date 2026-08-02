import { externalSessionPollMs, externalSessionStaleMs } from "./config.js";
import { remoteSessionProvider } from "./connectors.js";
import { isLiveVoiceThreadActive } from "./live-voice/leases.js";
import { broadcast } from "./sse.js";
import {
  localSessionProvider, parseSessionFile, threadIdFromFile
} from "./threads.js";

const monitors = new Map();
const snapshots = new Map();
const updateListeners = new Set();

export function onExternalSessionUpdate(listener) {
  if (typeof listener !== "function") return () => {};
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

async function notifyExternalSessionUpdate(next, previous) {
  const results = await Promise.allSettled(
    [...updateListeners].map((listener) => listener(next, previous))
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn(`external session update listener failed: ${result.reason?.message || result.reason}`);
    }
  }
}

function scopeKey(connectorId = "") {
  return connectorId || "local";
}

function snapshotKey(threadId = "", connectorId = "") {
  return `${scopeKey(connectorId)}:${threadId}`;
}

function providerFor(connectorId = "") {
  return connectorId ? remoteSessionProvider(connectorId) : localSessionProvider;
}

function normalizedMtime(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function isExternalTaskRunning(thread = {}, mtimeMs = thread.mtimeMs) {
  if (!thread?.taskRunning) return false;
  const modifiedAt = normalizedMtime(mtimeMs);
  if (!modifiedAt || !Number.isFinite(externalSessionStaleMs) || externalSessionStaleMs <= 0) return true;
  return Date.now() - modifiedAt <= externalSessionStaleMs;
}

export function externalSnapshotFromThread(thread = {}, connectorId = "") {
  const mtimeMs = normalizedMtime(thread.mtimeMs);
  const running = isExternalTaskRunning(thread, mtimeMs);
  return {
    threadId: thread.threadId || "",
    connectorId: connectorId || "",
    file: thread.file || "",
    mtimeMs,
    taskRunning: Boolean(thread.taskRunning),
    running,
    externalRunning: running,
    externalTurnId: thread.activeTurnId || "",
    externalTaskStartedAt: thread.taskStartedAt || "",
    externalTaskCompletedAt: thread.taskCompletedAt || "",
    cwd: thread.cwd || "",
    model: thread.model || "",
    reasoningEffort: thread.reasoningEffort || "",
    settingsUpdatedAt: thread.settingsUpdatedAt || "",
    contextUsage: thread.contextUsage || null,
    messages: Array.isArray(thread.messages) ? thread.messages : [],
    messageCount: Number(thread.messageCount) || 0,
    fullMessages: Array.isArray(thread.fullMessages) ? thread.fullMessages : [],
    fullMessageCount: Number(thread.fullMessageCount) || 0,
    updatedAt: thread.updatedAt || ""
  };
}

function snapshotSignature(snapshot = {}) {
  const lastMessage = snapshot.messages?.at(-1) || {};
  const lastFullMessage = snapshot.fullMessages?.at(-1) || {};
  return JSON.stringify([
    snapshot.running,
    snapshot.messageCount,
    lastMessage.role || "",
    lastMessage.content || "",
    lastMessage.at || "",
    snapshot.fullMessageCount,
    lastFullMessage.messageId || "",
    lastFullMessage.content || "",
    lastFullMessage.at || "",
    snapshot.contextUsage?.used || 0,
    snapshot.contextUsage?.window || 0,
    snapshot.model || "",
    snapshot.reasoningEffort || "",
    snapshot.settingsUpdatedAt || ""
  ]);
}

async function readSnapshot(threadId, connectorId = "", previous = null) {
  const provider = providerFor(connectorId);
  const files = await provider.listFiles();
  const hit = files.find((item) => threadIdFromFile(item.file) === threadId);
  if (!hit) throw Object.assign(new Error("没有找到这个 Codex 会话。"), { statusCode: 404 });
  const mtimeMs = normalizedMtime(hit.mtimeMs);
  if (previous?.file === hit.file && previous.mtimeMs === mtimeMs) {
    const running = isExternalTaskRunning(previous, mtimeMs);
    return { ...previous, running, externalRunning: running };
  }
  const parsed = parseSessionFile(await provider.readFile(hit.file), hit.file, 1000);
  return externalSnapshotFromThread({ ...parsed, file: hit.file, mtimeMs }, connectorId);
}

export function externalSessionSnapshot(threadId = "", connectorId = "") {
  if (!connectorId && isLiveVoiceThreadActive(threadId)) return null;
  const snapshot = snapshots.get(snapshotKey(threadId, connectorId)) || null;
  if (!snapshot) return null;
  const running = isExternalTaskRunning(snapshot, snapshot.mtimeMs);
  return { ...snapshot, running, externalRunning: running };
}

export async function refreshExternalSession(threadId = "", connectorId = "") {
  if (!threadId) return null;
  if (!connectorId && isLiveVoiceThreadActive(threadId)) {
    stopExternalSessionMonitor(connectorId);
    return null;
  }
  const key = snapshotKey(threadId, connectorId);
  const snapshot = await readSnapshot(threadId, connectorId, snapshots.get(key));
  snapshots.set(key, snapshot);
  return snapshot;
}

async function pollMonitor(monitor) {
  if (monitor.polling) return;
  if (!monitor.connectorId && isLiveVoiceThreadActive(monitor.threadId)) {
    stopExternalSessionMonitor(monitor.connectorId);
    return;
  }
  monitor.polling = true;
  try {
    const previous = snapshots.get(monitor.snapshotKey) || null;
    const next = await readSnapshot(monitor.threadId, monitor.connectorId, previous);
    snapshots.set(monitor.snapshotKey, next);
    const signature = snapshotSignature(next);
    if (monitor.ready && signature !== monitor.signature) {
      broadcast({
        type: "external_session_update",
        connectorId: monitor.connectorId,
        threadId: monitor.threadId,
        running: next.running,
        externalRunning: next.running,
        externalTaskStartedAt: next.externalTaskStartedAt,
        model: next.model,
        reasoningEffort: next.reasoningEffort,
        settingsUpdatedAt: next.settingsUpdatedAt,
        contextUsage: next.contextUsage,
        messageCount: next.messageCount,
        fullMessageCount: next.fullMessageCount,
        updatedAt: next.updatedAt
      });
      await notifyExternalSessionUpdate(next, previous);
    }
    monitor.signature = signature;
    monitor.ready = true;
    monitor.lastError = "";
  } catch (error) {
    const detail = String(error?.message || error);
    if (detail !== monitor.lastError) {
      console.warn(`external session monitor failed (${monitor.connectorId || "local"}:${monitor.threadId}): ${detail}`);
      monitor.lastError = detail;
    }
  } finally {
    monitor.polling = false;
  }
}

export function monitorExternalSession(threadId = "", connectorId = "", initialSnapshot = null) {
  if (!threadId) return null;
  if (!connectorId && isLiveVoiceThreadActive(threadId)) {
    stopExternalSessionMonitor(connectorId);
    return null;
  }
  const scope = scopeKey(connectorId);
  const existing = monitors.get(scope);
  if (existing?.threadId === threadId) {
    if (initialSnapshot) {
      snapshots.set(existing.snapshotKey, initialSnapshot);
      existing.signature = snapshotSignature(initialSnapshot);
      existing.ready = true;
    }
    return existing;
  }
  stopExternalSessionMonitor(connectorId);
  const key = snapshotKey(threadId, connectorId);
  if (initialSnapshot) snapshots.set(key, initialSnapshot);
  const monitor = {
    connectorId: connectorId || "",
    threadId,
    snapshotKey: key,
    signature: initialSnapshot ? snapshotSignature(initialSnapshot) : "",
    ready: Boolean(initialSnapshot),
    polling: false,
    lastError: "",
    timer: null
  };
  const intervalMs = Math.max(500, Number(externalSessionPollMs) || 1000);
  monitor.timer = setInterval(() => pollMonitor(monitor), intervalMs);
  monitor.timer.unref?.();
  monitors.set(scope, monitor);
  pollMonitor(monitor);
  return monitor;
}

export function stopExternalSessionMonitor(connectorId = "") {
  const scope = scopeKey(connectorId);
  const monitor = monitors.get(scope);
  if (!monitor) return;
  if (monitor.timer) clearInterval(monitor.timer);
  monitors.delete(scope);
}

export function externalRunningSnapshots() {
  return [...snapshots.values()]
    .map((snapshot) => {
      const running = isExternalTaskRunning(snapshot, snapshot.mtimeMs);
      return { ...snapshot, running, externalRunning: running };
    })
    .filter((snapshot) => (
      snapshot.running
      && (snapshot.connectorId || !isLiveVoiceThreadActive(snapshot.threadId))
    ));
}
