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
    "<realtime_delegation>",
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

export const fullReplyItemTextLimit = 6000;
export const fullReplyHistoryLimit = 400;
export const fullReplyHistoryTextBudget = 512000;

function fullReplyValueText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^[{[]/.test(trimmed)) {
      try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    const textItems = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        return "";
      })
      .filter(Boolean);
    if (textItems.length === value.length && textItems.length) return textItems.join("\n");
  }
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

export function truncateFullReplyText(value, limit = fullReplyItemTextLimit) {
  const text = fullReplyValueText(value).trim();
  if (!text) return "";
  const max = Math.max(200, Number(limit) || fullReplyItemTextLimit);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（该条 CLI 输出过长，已截断）`;
}

function fullReplyCode(value) {
  const text = truncateFullReplyText(value);
  if (!text) return "";
  return `\`\`\`text\n${text.replace(/```/g, "` ` `")}\n\`\`\``;
}

function fullReplyMessage(kind, title, body = "", options = {}) {
  const content = [`#### ${title}`, body].filter(Boolean).join("\n\n");
  if (!content) return null;
  return {
    role: "assistant",
    content,
    at: options.at || "",
    fullKind: kind,
    messageId: options.messageId || "",
    _turnId: options.turnId || "",
    _phase: options.phase || ""
  };
}

function responseItemTurnId(payload = {}) {
  return payload.internal_chat_message_metadata_passthrough?.turn_id || "";
}

function fullReasoningText(payload = {}) {
  const parts = [...(payload.summary || []), ...(payload.content || [])]
    .map((item) => typeof item === "string" ? item : item?.text || "")
    .filter(Boolean);
  return truncateFullReplyText(parts.join("\n\n"));
}

/**
 * Convert a persisted Responses API item into the same display shape used by
 * app-server live items. Empty/encrypted reasoning is intentionally represented
 * only by its available summary; private chain-of-thought is never fabricated.
 */
export function fullReplyMessageFromResponseItem(payload = {}, at = "", callLabels = new Map()) {
  const type = payload.type || "";
  const turnId = responseItemTurnId(payload);
  const baseId = payload.id || payload.call_id || `${type}-${at}`;
  if (type === "message") {
    const role = payload.role;
    const text = messageText(payload);
    if ((role !== "user" && role !== "assistant") || !text) return null;
    if (role === "user" && isInternalMessage(text)) return null;
    return {
      role,
      content: role === "assistant" ? assistantBubbleText(text, payload.phase) : cleanText(text, 20000),
      at,
      fullKind: role === "assistant" ? "assistant" : "",
      messageId: payload.id || "",
      _turnId: turnId,
      _phase: payload.phase || ""
    };
  }
  if (type === "agent_message") {
    const text = fullReplyValueText(payload.content);
    if (!text) return null;
    const route = [payload.author, payload.recipient].filter(Boolean).join(" → ");
    return fullReplyMessage("collaboration", `🤝 协作消息${route ? ` · ${route}` : ""}`, truncateFullReplyText(text), {
      at, turnId, messageId: `cli-${baseId}`
    });
  }
  if (type === "reasoning") {
    const text = fullReasoningText(payload);
    if (!text) return null;
    return fullReplyMessage("reasoning", "🧠 推理摘要", text, {
      at, turnId, messageId: `cli-${baseId}`
    });
  }
  if (type === "custom_tool_call" || type === "function_call") {
    const name = [payload.namespace, payload.name].filter(Boolean).join(".") || "tool";
    if (payload.call_id) callLabels.set(payload.call_id, name);
    return fullReplyMessage("tool-call", `🔧 工具调用 · ${name}`, fullReplyCode(payload.input ?? payload.arguments), {
      at, turnId, messageId: `cli-${baseId}-call`
    });
  }
  if (type === "custom_tool_call_output" || type === "function_call_output") {
    const name = payload.name || callLabels.get(payload.call_id) || "tool";
    return fullReplyMessage("tool-output", `↳ 工具结果 · ${name}`, fullReplyCode(payload.output), {
      at, turnId, messageId: `cli-${baseId}-output`
    });
  }
  if (type === "tool_search_call") {
    const label = payload.execution || "工具搜索";
    if (payload.call_id) callLabels.set(payload.call_id, label);
    return fullReplyMessage("tool-call", `🔎 ${label}`, fullReplyCode(payload.arguments), {
      at, turnId, messageId: `cli-${baseId}-call`
    });
  }
  if (type === "tool_search_output") {
    const label = callLabels.get(payload.call_id) || payload.execution || "工具搜索";
    return fullReplyMessage("tool-output", `↳ ${label}结果`, fullReplyCode(payload.tools), {
      at, turnId, messageId: `cli-${baseId}-output`
    });
  }
  if (type === "local_shell_call") {
    const action = payload.action || {};
    const command = action.command || action.cmd || action;
    if (payload.call_id) callLabels.set(payload.call_id, "shell");
    return fullReplyMessage("tool-call", "⌨️ 终端命令", fullReplyCode(command), {
      at, turnId, messageId: `cli-${baseId}-call`
    });
  }
  if (type === "web_search_call") {
    return fullReplyMessage("tool-call", "🌐 网页搜索", fullReplyCode(payload.action || payload.status || ""), {
      at, turnId, messageId: `cli-${baseId}`
    });
  }
  if (["compaction", "compaction_trigger", "context_compaction"].includes(type)) {
    return fullReplyMessage("system", "🗜️ 上下文压缩", "Codex 已压缩当前会话上下文。", {
      at, turnId, messageId: `cli-${baseId}`
    });
  }
  return null;
}

function patchChangesText(changes = {}) {
  if (!changes || typeof changes !== "object") return "";
  if (Array.isArray(changes)) return fullReplyValueText(changes);
  const sections = [];
  for (const [file, change] of Object.entries(changes)) {
    const diff = change?.unified_diff || change?.diff || "";
    sections.push([file, diff || fullReplyValueText(change)].filter(Boolean).join("\n"));
  }
  return sections.join("\n\n");
}

export function fullReplyMessageFromEvent(payload = {}, at = "") {
  const type = payload.type || "";
  const turnId = payload.turn_id || "";
  if (type === "patch_apply_end") {
    const status = payload.success === false ? "失败" : "完成";
    const detail = [
      patchChangesText(payload.changes),
      payload.stdout || "",
      payload.stderr || ""
    ].filter(Boolean).join("\n\n");
    return fullReplyMessage("patch", `📝 文件修改 · ${status}`, fullReplyCode(detail || payload.status || status), {
      at, turnId, messageId: `cli-${payload.call_id || `${type}-${at}`}`
    });
  }
  if (type === "mcp_tool_call_end") {
    const invocation = payload.invocation || {};
    const name = payload.app_name || payload.action_name
      ? [payload.app_name, payload.action_name].filter(Boolean).join(" · ")
      : [invocation.server, invocation.tool].filter(Boolean).join(".") || "MCP";
    const detail = {
      arguments: invocation.arguments,
      result: payload.result
    };
    return fullReplyMessage("mcp", `🔌 MCP 调用 · ${name}`, fullReplyCode(detail), {
      at, turnId, messageId: `cli-${payload.call_id || `${type}-${at}`}`
    });
  }
  if (type === "context_compacted") {
    return fullReplyMessage("system", "🗜️ 上下文压缩", "Codex 已压缩当前会话上下文。", {
      at, turnId, messageId: `cli-${type}-${at}`
    });
  }
  if (type === "turn_aborted") {
    return fullReplyMessage("system", "⛔ 回合已中断", truncateFullReplyText(payload.reason || ""), {
      at, turnId, messageId: `cli-${type}-${turnId || at}`
    });
  }
  return null;
}

function fileChangeText(changes = []) {
  if (!Array.isArray(changes)) return fullReplyValueText(changes);
  return changes.map((change) => {
    const pathValue = change?.path || change?.file || change?.name || "文件";
    const detail = change?.diff || change?.unifiedDiff || change?.unified_diff || fullReplyValueText(change);
    return [pathValue, detail].filter(Boolean).join("\n");
  }).join("\n\n");
}

/**
 * Format a v2 app-server ThreadItem. The returned message id is stable so a
 * started item and its streamed/completed form update one bubble in place.
 */
export function fullReplyMessageFromThreadItem(item = {}, options = {}) {
  const at = options.at || "";
  const final = Boolean(options.final);
  const id = `cli-${item.id || `${item.type || "item"}-${at}`}`;
  const messageOptions = { at, messageId: id };
  switch (item.type) {
    case "reasoning": {
      const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join("\n\n");
      return fullReplyMessage("reasoning", "🧠 推理摘要", truncateFullReplyText(text) || (final ? "推理已完成。" : "正在推理…"), messageOptions);
    }
    case "plan":
      return fullReplyMessage("plan", "📋 执行计划", truncateFullReplyText(item.text) || (final ? "计划已完成。" : "正在制定计划…"), messageOptions);
    case "commandExecution": {
      const status = final
        ? (item.status === "failed" || Number(item.exitCode) > 0 ? "失败" : "完成")
        : "执行中";
      const detail = [
        item.command ? `$ ${item.command}` : "",
        item.aggregatedOutput || "",
        item.exitCode === null || item.exitCode === undefined ? "" : `退出码：${item.exitCode}`
      ].filter(Boolean).join("\n\n");
      return fullReplyMessage("tool-output", `⌨️ 终端命令 · ${status}`, fullReplyCode(detail || "等待终端输出…"), messageOptions);
    }
    case "fileChange": {
      const status = final ? (item.status === "failed" ? "失败" : "完成") : "处理中";
      const detail = [fileChangeText(item.changes), item.output || ""].filter(Boolean).join("\n\n");
      return fullReplyMessage("patch", `📝 文件修改 · ${status}`, fullReplyCode(detail || "等待补丁内容…"), messageOptions);
    }
    case "mcpToolCall": {
      const name = [item.server, item.tool].filter(Boolean).join(".") || "MCP";
      const detail = { arguments: item.arguments };
      if (item.progress) detail.progress = item.progress;
      if (item.result !== null && item.result !== undefined) detail.result = item.result;
      if (item.error !== null && item.error !== undefined) detail.error = item.error;
      return fullReplyMessage("mcp", `🔌 MCP 调用 · ${name}`, fullReplyCode(detail), messageOptions);
    }
    case "dynamicToolCall": {
      const name = [item.namespace, item.tool].filter(Boolean).join(".") || "tool";
      const detail = { arguments: item.arguments };
      if (item.contentItems !== null && item.contentItems !== undefined) detail.result = item.contentItems;
      return fullReplyMessage(item.contentItems ? "tool-output" : "tool-call", `🔧 工具调用 · ${name}`, fullReplyCode(detail), messageOptions);
    }
    case "collabAgentToolCall": {
      const detail = {
        prompt: item.prompt,
        receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates
      };
      return fullReplyMessage("collaboration", `🤝 协作任务 · ${fullReplyValueText(item.tool) || "agent"}`, fullReplyCode(detail), messageOptions);
    }
    case "subAgentActivity":
      return fullReplyMessage("collaboration", `🤝 子代理活动 · ${item.kind || "更新"}`, truncateFullReplyText(item.agentPath || item.agentThreadId || ""), messageOptions);
    case "webSearch":
      return fullReplyMessage("tool-call", "🌐 网页搜索", fullReplyCode(item), messageOptions);
    case "imageView":
      return fullReplyMessage("tool-call", "🖼️ 查看图片", fullReplyCode(item.path || ""), messageOptions);
    case "imageGeneration":
      return fullReplyMessage("tool-call", `🎨 图片生成${final ? " · 完成" : ""}`, truncateFullReplyText(item.revisedPrompt || item.prompt || "正在生成图片…"), messageOptions);
    case "sleep":
      return fullReplyMessage("system", "⏱️ 等待", `${Number(item.durationMs) || 0} 毫秒`, messageOptions);
    case "enteredReviewMode":
    case "exitedReviewMode":
      return fullReplyMessage("system", item.type === "enteredReviewMode" ? "🔍 进入审查模式" : "🔍 退出审查模式", truncateFullReplyText(item.review || ""), messageOptions);
    case "contextCompaction":
      return fullReplyMessage("system", "🗜️ 上下文压缩", final ? "上下文压缩已完成。" : "正在压缩上下文…", messageOptions);
    default:
      return null;
  }
}

export function limitFullReplyMessages(messages = [], limit = fullReplyHistoryLimit, textBudget = fullReplyHistoryTextBudget) {
  const rows = [];
  let used = 0;
  const maxRows = Math.max(1, Number(limit) || fullReplyHistoryLimit);
  const maxText = Math.max(fullReplyItemTextLimit, Number(textBudget) || fullReplyHistoryTextBudget);
  for (let index = messages.length - 1; index >= 0 && rows.length < maxRows; index--) {
    const message = messages[index];
    const size = String(message?.content || "").length;
    if (rows.length && used + size > maxText) break;
    rows.unshift(message);
    used += size;
  }
  return rows;
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

export function parseSessionFile(text, file = "", limit = defaultMessageLimit, options = {}) {
  const messages = [];
  const fullMessages = [];
  const includeFull = options.includeFull !== false;
  let fullMessageCount = 0;
  let fullMessageTextSize = 0;
  const addFullMessage = (message) => {
    if (!includeFull || !message) return;
    if (message.role === "assistant" && message.fullKind && message.final === undefined) {
      message = { ...message, final: true };
    }
    fullMessages.push(message);
    fullMessageCount += 1;
    fullMessageTextSize += String(message.content || "").length;
    while (fullMessages.length > 1
      && (fullMessages.length > fullReplyHistoryLimit || fullMessageTextSize > fullReplyHistoryTextBudget)) {
      const removed = fullMessages.shift();
      fullMessageTextSize -= String(removed?.content || "").length;
    }
  };
  const callLabels = new Map();
  const taskDurations = new Map();
  const meta = {
    threadId: threadIdFromFile(file),
    threadSource: "",
    parentThreadId: "",
    cwd: "",
    updatedAt: "",
    contextUsage: null,
    model: "",
    reasoningEffort: "",
    settingsUpdatedAt: "",
    taskRunning: false,
    activeTurnId: "",
    taskStartedAt: "",
    taskCompletedAt: ""
  };
  let ownerMetaSeen = false;
  let parseTurnCount = 0;
  let currentTurnId = "turn-0";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "session_meta") {
      // Fork/subagent rollouts contain their own session_meta first, followed by
      // copied parent history which can include another session_meta. The file
      // name (or the first owner meta when no canonical name is available) must
      // remain authoritative; otherwise child tasks masquerade as the parent.
      if (!ownerMetaSeen) {
        const payload = row.payload || {};
        meta.threadId = meta.threadId || payload.id || "";
        meta.threadSource = payload.thread_source || (payload.source?.subagent ? "subagent" : "");
        meta.parentThreadId = payload.parent_thread_id || payload.forked_from_id || "";
        meta.cwd = payload.cwd || meta.cwd;
        meta.updatedAt = row.timestamp || meta.updatedAt;
        ownerMetaSeen = true;
      }
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
    if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(row.payload?.type)) {
      const completedTurnId = row.payload.turn_id || "";
      if (!meta.activeTurnId || !completedTurnId || completedTurnId === meta.activeTurnId) {
        meta.taskRunning = false;
        meta.activeTurnId = "";
        meta.taskCompletedAt = row.timestamp || (row.payload.completed_at ? new Date(Number(row.payload.completed_at) * 1000).toISOString() : "");
      }
      if (completedTurnId && Number.isFinite(Number(row.payload.duration_ms))) {
        taskDurations.set(completedTurnId, Number(row.payload.duration_ms));
      }
      const fullEvent = includeFull ? fullReplyMessageFromEvent(row.payload, row.timestamp || "") : null;
      addFullMessage(fullEvent);
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "event_msg" && row.payload?.type === "thread_settings_applied") {
      const settings = row.payload.thread_settings || {};
      meta.model = settings.model || settings.collaboration_mode?.settings?.model || meta.model;
      meta.reasoningEffort = settings.reasoning_effort || settings.effort || settings.collaboration_mode?.settings?.reasoning_effort || meta.reasoningEffort;
      meta.settingsUpdatedAt = row.timestamp || meta.settingsUpdatedAt;
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "turn_context") {
      meta.model = row.payload?.model || row.payload?.collaboration_mode?.settings?.model || meta.model;
      meta.reasoningEffort = row.payload?.effort || row.payload?.reasoning_effort || row.payload?.collaboration_mode?.settings?.reasoning_effort || meta.reasoningEffort;
      meta.settingsUpdatedAt = row.timestamp || meta.settingsUpdatedAt;
      meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    if (row.type === "response_item" && row.payload?.type === "image_generation_call") {
      const imageFile = saveGeneratedImageSync(row.payload, meta.threadId);
      if (imageFile) {
        const imageMessage = { role: "assistant", content: assistantBubbleText(imageFile, "final_answer"), at: row.timestamp || "" };
        messages.push(imageMessage);
        addFullMessage({ ...imageMessage, fullKind: "assistant", messageId: row.payload.id || "" });
        meta.updatedAt = row.timestamp || meta.updatedAt;
      }
      continue;
    }
    if (row.type === "event_msg") {
      const fullEvent = includeFull ? fullReplyMessageFromEvent(row.payload, row.timestamp || "") : null;
      if (fullEvent) {
        addFullMessage(fullEvent);
        meta.updatedAt = row.timestamp || meta.updatedAt;
      }
      continue;
    }
    if (row.type !== "response_item") continue;
    const fullItem = includeFull
      ? fullReplyMessageFromResponseItem(row.payload, row.timestamp || "", callLabels)
      : null;
    addFullMessage(fullItem);
    if (row.payload?.type !== "message") {
      if (fullItem) meta.updatedAt = row.timestamp || meta.updatedAt;
      continue;
    }
    const role = row.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = messageText(row.payload);
    if (role === "user" && isInternalMessage(content)) continue;
    if (!content) continue;
    if (role === "user") {
      parseTurnCount += 1;
      currentTurnId = row.payload.internal_chat_message_metadata_passthrough?.turn_id || `turn-${parseTurnCount}`;
    }
    const turnId = row.payload.internal_chat_message_metadata_passthrough?.turn_id || meta.activeTurnId || currentTurnId;
    const displayContent = role === "assistant" ? assistantBubbleText(content, row.payload.phase) : content;
    messages.push({
      role,
      content: cleanText(displayContent, 20000),
      at: row.timestamp || "",
      _turnId: turnId,
      _phase: row.payload.phase || ""
    });
    meta.updatedAt = row.timestamp || meta.updatedAt;
  }
  const turnAssistantIndices = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.content) {
      const turnKey = msg._turnId || "";
      const list = turnAssistantIndices.get(turnKey) || [];
      list.push(i);
      turnAssistantIndices.set(turnKey, list);
    }
  }
  for (const [turnId, indices] of turnAssistantIndices.entries()) {
    const isTurnComplete = !meta.taskRunning || (meta.activeTurnId && turnId !== meta.activeTurnId) || Boolean(meta.taskCompletedAt);
    const lastIndex = indices[indices.length - 1];
    for (const idx of indices) {
      const msg = messages[idx];
      if (!msg) continue;
      if (idx === lastIndex && isTurnComplete && msg._phase !== "commentary") {
        msg.content = msg.content.replace(/^[🤔]\s*/u, "✅ ");
        if (!/^✅\s/u.test(msg.content)) {
          msg.content = `✅ ${msg.content}`;
        }
      } else {
        msg.content = msg.content.replace(/^[✅]\s*/u, "🤔 ");
        if (!/^🤔\s/u.test(msg.content)) {
          msg.content = `🤔 ${msg.content}`;
        }
      }
    }
  }
  const fullTurnAssistantIndices = new Map();
  for (let i = 0; i < fullMessages.length; i++) {
    const msg = fullMessages[i];
    if (msg.role === "assistant" && msg.fullKind === "assistant" && msg.content) {
      const turnKey = msg._turnId || "";
      const list = fullTurnAssistantIndices.get(turnKey) || [];
      list.push(i);
      fullTurnAssistantIndices.set(turnKey, list);
    }
  }
  for (const [turnId, indices] of fullTurnAssistantIndices.entries()) {
    const isTurnComplete = !meta.taskRunning || (meta.activeTurnId && turnId !== meta.activeTurnId) || Boolean(meta.taskCompletedAt);
    const lastIndex = indices[indices.length - 1];
    for (const idx of indices) {
      const msg = fullMessages[idx];
      if (!msg) continue;
      if (idx === lastIndex && isTurnComplete && msg._phase !== "commentary") {
        msg.content = msg.content.replace(/^[🤔]\s*/u, "✅ ");
        if (!/^✅\s/u.test(msg.content)) {
          msg.content = `✅ ${msg.content}`;
        }
      } else {
        msg.content = msg.content.replace(/^[✅]\s*/u, "🤔 ");
        if (!/^🤔\s/u.test(msg.content)) {
          msg.content = `🤔 ${msg.content}`;
        }
      }
    }
  }
  const publicMessages = messages.map(({ _turnId, _phase, ...message }) => {
    const taskDurationMs = _phase !== "commentary" ? taskDurations.get(_turnId) : null;
    return taskDurationMs === undefined || taskDurationMs === null ? message : { ...message, taskDurationMs };
  });
  const publicFullMessages = fullMessages.map(({ _turnId, _phase, ...message }) => {
    const taskDurationMs = _phase !== "commentary" ? taskDurations.get(_turnId) : null;
    return taskDurationMs === undefined || taskDurationMs === null ? message : { ...message, taskDurationMs };
  });
  return {
    ...meta,
    messageCount: publicMessages.length,
    messages: publicMessages.slice(-limit),
    fullMessageCount,
    fullMessages: limitFullReplyMessages(publicFullMessages)
  };
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
  const requestedLimit = Math.max(defaultMessageLimit, Math.floor(Number(limit) || defaultMessageLimit));
  return {
    ...parseSessionFile(await provider.readFile(hit.file), hit.file, requestedLimit),
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
