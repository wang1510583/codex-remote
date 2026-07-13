import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { sessionsDir, generatedImageDir, defaultMessageLimit } from "./config.js";
import { cleanText, safeName } from "./utils.js";
import { readMessageMeta, readThreadNames, readThreadCompletions, messageMetaKey, setThreadName } from "./store.js";

export function threadIdFromFile(file = "") {
  const match = path.basename(file).match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : "";
}

export function isInternalMessage(text = "") {
  const trimmed = text.trim();
  const internalPrefixes = [
    "<recommended_plugins>",
    "<environment_context>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<skills_instructions>",
    "<apps_instructions>",
    "<plugins_instructions>",
    "# AGENTS.md instructions"
  ];
  return !trimmed || internalPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

export function messageText(payload = {}) {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.map((item) => item?.text || "").filter(Boolean).join("\n").trim();
}

export function assistantBubbleText(text, phase) {
  if (/^[✅🤔]\s/.test(text)) return text;
  const icon = phase === "final_answer" ? "✅" : "🤔";
  return `${icon} ${text}`;
}

export function threadTitle(messages = [], fallback = "未命名会话") {
  const firstUser = messages.find((message) => message.role === "user")?.content || "";
  return cleanText(firstUser.replace(/\s+/g, " ").trim(), 60) || fallback;
}

export function latestUserAndCompletion(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const message = rows[index];
    if (message?.role !== "user") continue;
    const completion = rows.slice(index + 1).reverse().find((item) => item?.role === "assistant" && /^✅\s/.test(item.content || ""));
    return { user: message, completion: completion || null };
  }
  return { user: null, completion: null };
}

function contextUsageFromTokenInfo(info = {}, threadId = "", at = new Date().toISOString()) {
  if (!info || typeof info !== "object") return null;
  const usage = info.last_token_usage || info.total_token_usage || {};
  const used = Number(usage.input_tokens || usage.total_tokens) || 0;
  const window = Number(info.model_context_window) || 0;
  if (!used || !window) return null;
  const remainingPercent = Math.max(0, Math.min(100, Math.round(((window - used) / window) * 100)));
  return { threadId, used, window, remainingPercent, at };
}

export function freshContextUsage() {
  return { threadId: "", used: 0, window: 0, remainingPercent: 100, at: new Date().toISOString() };
}

export async function saveGeneratedImage(item = {}, threadId = "") {
  const result = typeof item.result === "string" ? item.result : "";
  const match = result.match(/^data:image\/(\w+);base64,(.+)$/);
  const ext = match ? match[1].replace("jpeg", "jpg") : "png";
  const base64 = match ? match[2] : result;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64) || base64.length < 1000) return "";
  const safeThread = safeName(threadId || "thread");
  const dir = path.join(generatedImageDir, safeThread);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${safeName(item.id || "image")}.${ext}`);
  await writeFile(file, Buffer.from(base64.replace(/\s/g, ""), "base64"));
  return file;
}

function saveGeneratedImageSync(item = {}, threadId = "") {
  const result = typeof item.result === "string" ? item.result : "";
  const match = result.match(/^data:image\/(\w+);base64,(.+)$/);
  const ext = match ? match[1].replace("jpeg", "jpg") : "png";
  const base64 = match ? match[2] : result;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64) || base64.length < 1000) return "";
  const safeThread = safeName(threadId || "thread");
  const dir = path.join(generatedImageDir, safeThread);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(item.id || "image")}.${ext}`);
  if (!existsSync(file)) writeFileSync(file, Buffer.from(base64.replace(/\s/g, ""), "base64"));
  return file;
}

export function parseSessionFile(text, file = "", limit = defaultMessageLimit) {
  const messages = [];
  const taskDurations = new Map();
  const meta = {
    threadId: threadIdFromFile(file),
    cwd: "",
    updatedAt: "",
    contextUsage: null,
    model: "",
    reasoningEffort: "",
    taskRunning: false,
    activeTurnId: "",
    taskStartedAt: "",
    taskCompletedAt: ""
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "session_meta") {
      meta.threadId = row.payload?.id || meta.threadId;
      meta.cwd = row.payload?.cwd || meta.cwd;
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "event_msg" && row.payload?.type === "token_count") {
      const usage = contextUsageFromTokenInfo(row.payload.info, meta.threadId, row.timestamp || meta.updatedAt);
      if (usage) meta.contextUsage = usage;
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "event_msg" && row.payload?.type === "task_started") {
      meta.taskRunning = true;
      meta.activeTurnId = row.payload.turn_id || "";
      meta.taskStartedAt = row.timestamp || (row.payload.started_at ? new Date(Number(row.payload.started_at) * 1000).toISOString() : "");
      meta.taskCompletedAt = "";
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "event_msg" && row.payload?.type === "task_complete") {
      const completedTurnId = row.payload.turn_id || "";
      if (!meta.activeTurnId || !completedTurnId || completedTurnId === meta.activeTurnId) {
        meta.taskRunning = false;
        meta.activeTurnId = "";
        meta.taskCompletedAt = row.timestamp || (row.payload.completed_at ? new Date(Number(row.payload.completed_at) * 1000).toISOString() : "");
      }
      if (completedTurnId && Number.isFinite(Number(row.payload.duration_ms))) {
        taskDurations.set(completedTurnId, Number(row.payload.duration_ms));
      }
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "turn_context") {
      meta.model = row.payload?.model || row.payload?.collaboration_mode?.settings?.model || meta.model;
      meta.reasoningEffort = row.payload?.effort || row.payload?.reasoning_effort || row.payload?.collaboration_mode?.settings?.reasoning_effort || meta.reasoningEffort;
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "response_item" && row.payload?.type === "image_generation_call") {
      const imageFile = saveGeneratedImageSync(row.payload, meta.threadId);
      if (imageFile) {
        messages.push({ role: "assistant", content: assistantBubbleText(imageFile, "final_answer"), at: row.timestamp || "" });
        meta.updatedAt = row.timestamp || meta.updatedAt;
      }
      continue;
    }
    if (row.type !== "response_item" || row.payload?.type !== "message") continue;
    const role = row.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = messageText(row.payload);
    if (role === "user" && isInternalMessage(content)) continue;
    if (!content) continue;
    const displayContent = role === "assistant" ? assistantBubbleText(content, row.payload.phase) : content;
    messages.push({
      role,
      content: cleanText(displayContent, 20000),
      at: row.timestamp || "",
      _turnId: row.payload.internal_chat_message_metadata_passthrough?.turn_id || meta.activeTurnId || "",
      _phase: row.payload.phase || ""
    });
    meta.updatedAt = row.timestamp || meta.updatedAt;
  }
  const publicMessages = messages.map(({ _turnId, _phase, ...message }) => {
    const taskDurationMs = _phase === "final_answer" ? taskDurations.get(_turnId) : null;
    return taskDurationMs === undefined || taskDurationMs === null ? message : { ...message, taskDurationMs };
  });
  return { ...meta, messageCount: publicMessages.length, messages: publicMessages.slice(-limit) };
}

export function contextUsageFromEvent(payload = {}, threadId = "") {
  if (payload.type !== "token_count") return null;
  return contextUsageFromTokenInfo(payload.info, threadId, new Date().toISOString());
}

async function listLocalSessionFiles(dir = sessionsDir, out = []) {
  let rows;
  try { rows = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (["ENOENT", "EPERM", "EACCES"].includes(error.code)) return out;
    throw error;
  }
  for (const row of rows) {
    const file = path.join(dir, row.name);
    if (row.isDirectory()) await listLocalSessionFiles(file, out);
    else if (row.isFile() && row.name.endsWith(".jsonl")) {
      try {
        const info = await stat(file);
        out.push({ file, mtimeMs: info.mtimeMs });
      } catch (error) {
        if (!["ENOENT", "EPERM", "EACCES"].includes(error.code)) throw error;
      }
    }
  }
  return out;
}

export const localSessionProvider = {
  async listFiles() { return listLocalSessionFiles(); },
  async readFile(file) { return readFile(file, "utf8"); },
  async deleteFile(file) { return unlink(file); }
};

export async function listSessionEntries(provider = localSessionProvider) {
  const files = await provider.listFiles();
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 80);
}

export async function loadThreadFromProvider(threadId, provider = localSessionProvider, limit = defaultMessageLimit) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("无效的会话 ID。");
  }
  const files = await provider.listFiles();
  const hit = files.find((item) => threadIdFromFile(item.file) === threadId);
  if (!hit) throw new Error("没有找到这个 Codex 会话。");
  return {
    ...parseSessionFile(await provider.readFile(hit.file), hit.file, Math.max(defaultMessageLimit, Math.min(Number(limit) || defaultMessageLimit, 1000))),
    file: hit.file,
    mtimeMs: Number(hit.mtimeMs) || 0
  };
}

export async function deleteThreadFromProvider(threadId, provider = localSessionProvider) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("无效的会话 ID。");
  }
  if (!provider.deleteFile) throw new Error("该会话源不支持删除。");
  const files = await provider.listFiles();
  const hits = files.filter((item) => threadIdFromFile(item.file) === threadId);
  if (!hits.length) throw new Error("没有找到这个 Codex 会话。");
  for (const hit of hits) await provider.deleteFile(hit.file);
  await setThreadName(threadId, "");
}

export async function mergeLocalMessageMeta(threadId = "", messages = [], previousMessages = []) {
  const byContent = new Map();
  for (const message of previousMessages || []) {
    if (message?.taskDurationMs === undefined || message?.taskDurationMs === null) continue;
    const key = `${message.role || ""}\n${message.content || ""}`;
    const rows = byContent.get(key) || [];
    rows.push({ taskDurationMs: message.taskDurationMs });
    byContent.set(key, rows);
  }
  if (threadId) {
    const threadMeta = (await readMessageMeta())[threadId] || {};
    for (const [hash, items] of Object.entries(threadMeta)) {
      if (!Array.isArray(items)) continue;
      const rows = byContent.get(hash) || [];
      for (const item of items) {
        if (item?.taskDurationMs !== undefined && item?.taskDurationMs !== null) rows.push({ taskDurationMs: item.taskDurationMs });
      }
      byContent.set(hash, rows);
    }
  }
  return (messages || []).map((message) => {
    if (message?.taskDurationMs !== undefined && message?.taskDurationMs === null) return message;
    const localKey = `${message.role || ""}\n${message.content || ""}`;
    const rows = byContent.get(localKey) || byContent.get(messageMetaKey(message));
    const meta = rows?.shift();
    return meta ? { ...message, taskDurationMs: meta.taskDurationMs } : message;
  });
}

export { contextUsageFromTokenInfo };
