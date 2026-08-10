import { createLocalAppServer } from "../codex-server.js";
import { liveVoiceThreadSnapshot } from "./leases.js";
import { absoluteStateCwd } from "../paths.js";
import { loadThreadPage, runningThreads } from "../runner.js";
import { broadcast } from "../sse.js";
import { isInternalMessage } from "../threads.js";
import {
  appendLiveVoiceTranscript,
  labelLiveVoiceTranscript,
  readLiveVoiceTranscripts,
  readState,
  syncLoadedCounts,
  writeState
} from "../store.js";

const RECENT_CONVERSATION_LIMIT = 10;

export function liveVoiceHttpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function safeLiveVoiceSessionId(raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(raw || "")).trim();
  } catch {
    throw liveVoiceHttpError("Live Voice 会话 ID 格式无效。", 400);
  }
  if (!decoded || decoded.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(decoded)) {
    throw liveVoiceHttpError("Live Voice 会话 ID 格式无效。", 400);
  }
  return decoded;
}

function sessionPayload(state) {
  return {
    id: state.threadId,
    session_id: state.threadId,
    codex_thread_id: state.threadId,
    project_id: null,
    cwd: state.cwd || "",
    status: "active"
  };
}

function conversationKey(message = {}) {
  const role = String(message.role || "").toLowerCase();
  const text = String(message.content || "").trim()
    .replace(/^[✅🤔]\s*/u, "");
  return `${role}\n${text}`;
}

function visibleConversationEntry(message = {}) {
  const role = String(message.role || "").toLowerCase();
  const text = String(message.content || "").trim();
  if ((role !== "user" && role !== "assistant") || !text) return null;
  if (role === "user" && isInternalMessage(text)) return null;
  // The web UI labels unfinished assistant bubbles with 🤔. The Android
  // recent-history panel should restore only completed Codex replies.
  if (role === "assistant" && /^🤔\s*/u.test(text)) return null;
  return {
    role,
    text,
    channel: "final",
    at: String(message.at || "")
  };
}

function recentConversation(threadMessages = [], stateMessages = []) {
  const rows = [];
  const indices = new Map();
  for (const rawMessage of [...threadMessages, ...stateMessages]) {
    const message = rawMessage?.liveVoiceTranscript
      ? { ...rawMessage, content: labelLiveVoiceTranscript(rawMessage.content) }
      : rawMessage;
    const entry = visibleConversationEntry(message);
    if (!entry) continue;
    const key = conversationKey(message);
    const existingIndex = indices.get(key);
    if (existingIndex === undefined) {
      indices.set(key, rows.length);
      rows.push(entry);
    } else if (!rows[existingIndex].at && entry.at) {
      rows[existingIndex] = entry;
    }
  }
  rows.sort((left, right) => {
    const leftTime = Date.parse(left.at);
    const rightTime = Date.parse(right.at);
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return 0;
  });
  return rows.slice(-RECENT_CONVERSATION_LIMIT).map(({ at, ...entry }) => entry);
}

export class CodexRemoteThreadAdapter {
  constructor({
    readStateFn = readState,
    writeStateFn = writeState,
    appServerFactory = createLocalAppServer,
    runningThreadsFn = runningThreads,
    broadcastFn = broadcast,
    loadThreadPageFn = loadThreadPage,
    appendLiveVoiceTranscriptFn = appendLiveVoiceTranscript,
    readLiveVoiceTranscriptsFn = readLiveVoiceTranscripts
  } = {}) {
    this.readState = readStateFn;
    this.writeState = writeStateFn;
    this.appServerFactory = appServerFactory;
    this.runningThreads = runningThreadsFn;
    this.broadcast = broadcastFn;
    this.loadThreadPage = loadThreadPageFn;
    this.appendLiveVoiceTranscript = appendLiveVoiceTranscriptFn;
    this.readLiveVoiceTranscripts = readLiveVoiceTranscriptsFn;
    this.creating = null;
  }

  async localState() {
    return this.readState("");
  }

  async currentSession() {
    const state = await this.localState();
    return state.threadId ? sessionPayload(state) : null;
  }

  async getSession(rawSessionId) {
    const sessionId = safeLiveVoiceSessionId(rawSessionId);
    const active = liveVoiceThreadSnapshot(sessionId);
    if (active) {
      return sessionPayload({
        threadId: sessionId,
        cwd: active.cwd || ""
      });
    }
    const state = await this.localState();
    if (!state.threadId || state.threadId !== sessionId) {
      throw liveVoiceHttpError("该 Live Voice 会话不是网页当前选择的会话。", 404);
    }
    return sessionPayload(state);
  }

  /**
   * Returns the persisted, visible bubbles for the thread currently selected
   * in the Codex Remote web UI. This deliberately does not create a thread or
   * allow Android to browse other local Codex history.
   */
  async currentSessionConversation(rawSessionId) {
    const sessionId = safeLiveVoiceSessionId(rawSessionId);
    const state = await this.localState();
    if (!state.threadId || state.threadId !== sessionId) {
      throw liveVoiceHttpError("该 Live Voice 会话不是网页当前选择的会话。", 404);
    }

    let threadMessages = [];
    try {
      const thread = await this.loadThreadPage(sessionId, "");
      threadMessages = Array.isArray(thread?.messages) ? thread.messages : [];
    } catch {
      // A newly created thread may not have a JSONL file yet. In that case,
      // state.messages can still contain recent Live Voice transcript bubbles.
    }
    let voiceMessages = [];
    try {
      voiceMessages = await this.readLiveVoiceTranscripts(sessionId);
    } catch {
      // Current thread history is still useful if an older deployment has not
      // created the separate Live Voice transcript file yet.
    }
    return recentConversation(threadMessages, [...(state.messages || []), ...voiceMessages]);
  }

  async createSession() {
    if (this.creating) return this.creating;
    const creating = this.createOrReuseSession();
    this.creating = creating;
    try {
      return await creating;
    } finally {
      if (this.creating === creating) this.creating = null;
    }
  }

  async createOrReuseSession() {
    const state = await this.localState();
    if (state.threadId) return sessionPayload(state);
    const cwd = absoluteStateCwd(state);
    const appServer = this.appServerFactory();
    let threadId;
    try {
      threadId = await appServer.ensureThread("", cwd, {
        model: state.model || "",
        reasoningEffort: state.reasoningEffort || ""
      });
    } finally {
      appServer.close?.();
    }
    if (!threadId) {
      throw liveVoiceHttpError("Codex 没有返回新会话 ID。", 502);
    }
    const next = syncLoadedCounts({
      ...state,
      threadId,
      runtimeId: "",
      connectorId: "",
      messages: [],
      inflight: null
    });
    await this.writeState(next, "");
    this.broadcast({
      type: "state",
      ...next,
      absoluteCwd: cwd
    });
    return sessionPayload(next);
  }

  async setCurrentSession(rawSessionId) {
    const sessionId = safeLiveVoiceSessionId(rawSessionId);
    const active = liveVoiceThreadSnapshot(sessionId);
    if (active) {
      return sessionPayload({
        threadId: sessionId,
        cwd: active.cwd || ""
      });
    }
    const state = await this.localState();
    if (state.threadId !== sessionId) {
      throw liveVoiceHttpError(
        "安卓端只能继续网页当前选择的会话；请先在网页中选择该会话后重试。",
        409
      );
    }
    return sessionPayload(state);
  }

  async runtimeContext(rawSessionId) {
    const session = await this.getSession(rawSessionId);
    const state = await this.localState();
    if (state.threadId !== session.session_id) {
      throw liveVoiceHttpError("网页当前会话已切换，请在安卓端重新连接语音。", 409);
    }
    if (state.inflight) {
      throw liveVoiceHttpError("当前 Codex 会话正在执行文字任务，请等待任务结束后再开启语音。", 409);
    }
    const running = this.runningThreads().some((item) => (
      !item.connectorId && item.threadId === session.session_id
    ));
    if (running) {
      throw liveVoiceHttpError("当前 Codex 会话正在其他客户端执行任务，请稍后再开启语音。", 409);
    }
    return {
      threadId: session.session_id,
      cwd: absoluteStateCwd(state),
      model: state.model || "",
      reasoningEffort: state.reasoningEffort || ""
    };
  }

  async publishLiveVoiceStatus(status = {}) {
    const threadId = safeLiveVoiceSessionId(status.threadId);
    const running = status.ended !== true;
    const runningRows = this.runningThreads();
    this.broadcast({
      type: "runner_status",
      connectorId: "",
      runningThreads: runningRows
    });
    const state = await this.readState("");
    if (state.threadId !== threadId) return;
    this.broadcast({
      type: "status",
      connectorId: "",
      threadId,
      running,
      externalRunning: false,
      liveVoiceRunning: running,
      liveVoiceConnected: running && Boolean(status.connected),
      liveVoiceTaskRunning: running && Boolean(status.taskRunning),
      reconnecting: running && !status.connected,
      queueLength: 0,
      queueMessages: [],
      steerLength: 0,
      steerMessages: [],
      runningThreads: runningRows
    });
  }

  async recordLiveVoiceTranscript(rawSessionId, role, text) {
    const threadId = safeLiveVoiceSessionId(rawSessionId);
    const content = String(text || "").trim();
    if (!content) return;
    const normalizedRole = String(role || "").toLowerCase() === "user"
      ? "user"
      : "assistant";
    const message = {
      role: normalizedRole,
      content: labelLiveVoiceTranscript(content),
      at: new Date().toISOString(),
      liveVoiceTranscript: true
    };
    const persisted = await this.appendLiveVoiceTranscript(threadId, message);
    if (!persisted?.added) return;
    const visibleMessage = persisted.message || message;

    // Keep the selected web page live without waiting for its next snapshot.
    // Persistence above is deliberately independent of this state array, as
    // it can be replaced while a web task refreshes or the user changes tabs.
    const state = await this.readState("");
    if (state.threadId !== threadId) return;
    const last = state.messages?.at?.(-1);
    if (last?.role !== visibleMessage.role || last?.content !== visibleMessage.content) {
      state.messages = [...(state.messages || []), visibleMessage].slice(-80);
      await this.writeState(syncLoadedCounts(state), "");
    }
    this.broadcast({
      type: "message",
      connectorId: "",
      threadId,
      ...visibleMessage,
      final: true,
      messageId: `live-voice-${normalizedRole}-${Date.now()}`
    });
  }
}
