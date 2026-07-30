import { disableLocal } from "../config.js";
import { createLocalAppServer } from "../codex-server.js";
import { liveVoiceThreadSnapshot } from "./leases.js";
import { absoluteStateCwd } from "../paths.js";
import { runningThreads } from "../runner.js";
import { broadcast } from "../sse.js";
import {
  readConnectorViewState,
  readState,
  syncLoadedCounts,
  writeState
} from "../store.js";

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

export class CodexRemoteThreadAdapter {
  constructor({
    readStateFn = readState,
    writeStateFn = writeState,
    readViewStateFn = readConnectorViewState,
    appServerFactory = createLocalAppServer,
    runningThreadsFn = runningThreads,
    broadcastFn = broadcast,
    localDisabled = disableLocal
  } = {}) {
    this.readState = readStateFn;
    this.writeState = writeStateFn;
    this.readViewState = readViewStateFn;
    this.appServerFactory = appServerFactory;
    this.runningThreads = runningThreadsFn;
    this.broadcast = broadcastFn;
    this.localDisabled = localDisabled;
    this.creating = null;
  }

  async localState() {
    if (this.localDisabled) {
      throw liveVoiceHttpError("该服务已禁用本机 Codex，无法使用本机 Live Voice。", 503);
    }
    const view = await this.readViewState();
    if (view.selectedConnectorId) {
      throw liveVoiceHttpError(
        "当前网页选择的是被控端。Live Voice 暂只支持总控服务器上的本机会话。",
        409
      );
    }
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
    const state = await this.readState("");
    if (state.threadId !== threadId) return;
    const last = state.messages?.at?.(-1);
    if (last?.role === normalizedRole && last?.content === content) return;
    const message = {
      role: normalizedRole,
      content,
      at: new Date().toISOString(),
      liveVoiceTranscript: true
    };
    state.messages = [...(state.messages || []), message].slice(-80);
    await this.writeState(syncLoadedCounts(state), "");
    this.broadcast({
      type: "message",
      connectorId: "",
      threadId,
      ...message,
      final: true,
      messageId: `live-voice-${normalizedRole}-${Date.now()}`
    });
  }
}
