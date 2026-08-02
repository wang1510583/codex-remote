import { WebSocket, WebSocketServer } from "ws";
import { readBody } from "../utils.js";
import {
  isTrustedVoiceOrigin,
  isVoiceRequestAuthenticated
} from "./auth.js";
import { acquireLiveVoiceThread } from "./leases.js";
import { safeLiveVoiceSessionId } from "./thread-adapter.js";
import {
  codexLiveVoiceOrDefault,
  normalizeCodexLiveVoiceVoice
} from "./voices.js";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SDP_BYTES = 192 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function messageByteLength(raw) {
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return raw.byteLength;
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendSessionError(socket, message, recoverable = false) {
  send(socket, { type: "session.error", message, recoverable });
}

function upgradeError(socket, status, text) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
  } catch {}
  socket.destroy();
}

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export class LiveVoiceGateway {
  constructor({
    token,
    enabled = true,
    voice = "cove",
    authTimeoutMs = 5_000,
    reconnectGraceMs = 60_000,
    taskRetentionMs = 30 * 60_000,
    taskStatusPollMs = 2_000,
    ticketStore,
    threadAdapter,
    runtimeFactory,
    normalizePath = (pathname) => pathname,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  }) {
    this.token = token;
    this.enabled = enabled;
    this.voice = codexLiveVoiceOrDefault(voice);
    this.authTimeoutMs = positiveMs(authTimeoutMs, 5_000);
    this.reconnectGraceMs = positiveMs(reconnectGraceMs, 60_000);
    this.taskRetentionMs = positiveMs(taskRetentionMs, 30 * 60_000);
    this.taskStatusPollMs = positiveMs(taskStatusPollMs, 2_000);
    this.ticketStore = ticketStore;
    this.threadAdapter = threadAdapter;
    this.runtimeFactory = runtimeFactory;
    this.normalizePath = normalizePath;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.wss = null;
    // A session outlives an individual Android WebSocket. Its app-server stays
    // here while a delegated turn runs or during the reconnect grace window.
    this.activeSessions = new Map();
  }

  voicePath(pathname) {
    return this.normalizePath(pathname);
  }

  authorizeHttp(req, res) {
    if (!this.enabled) {
      jsonResponse(res, 503, {
        success: false,
        message: "Codex Live Voice 未启用或本机 Codex 已禁用。"
      });
      return false;
    }
    if (!isVoiceRequestAuthenticated(req, this.token)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Codex Remote Live Voice"');
      jsonResponse(res, 401, { success: false, message: "Live Voice 鉴权失败。" });
      return false;
    }
    if (!isTrustedVoiceOrigin(req)) {
      jsonResponse(res, 403, {
        success: false,
        message: "Live Voice 请求来源无效；请使用安卓应用中的同源服务器地址。"
      });
      return false;
    }
    return true;
  }

  async handleHttp(req, res, url) {
    const pathname = this.voicePath(url.pathname);
    if (!pathname.startsWith("/api/voice-agent/")) return false;
    if (!this.authorizeHttp(req, res)) return true;
    try {
      if (pathname === "/api/voice-agent/current-session") {
        if (req.method === "GET") {
          const session = await this.threadAdapter.currentSession();
          jsonResponse(res, 200, {
            success: true,
            data: { session_id: session?.session_id || null }
          });
          return true;
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          const session = await this.threadAdapter.setCurrentSession(body.session_id);
          jsonResponse(res, 200, {
            success: true,
            message: "当前 Live Voice 会话已确认。",
            data: session
          });
          return true;
        }
        jsonResponse(res, 405, { success: false, message: "Method not allowed" });
        return true;
      }

      if (pathname === "/api/voice-agent/sessions") {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { success: false, message: "Method not allowed" });
          return true;
        }
        await readBody(req);
        const session = await this.threadAdapter.createSession();
        jsonResponse(res, 200, {
          success: true,
          message: "Live Voice 会话已准备。",
          data: session
        });
        return true;
      }

      const ticketMatch = pathname.match(
        /^\/api\/voice-agent\/sessions\/([^/]+)\/live-ticket$/
      );
      if (ticketMatch) {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { success: false, message: "Method not allowed" });
          return true;
        }
        const sessionId = safeLiveVoiceSessionId(ticketMatch[1]);
        await this.threadAdapter.getSession(sessionId);
        const ticket = this.ticketStore.issue(sessionId);
        jsonResponse(res, 200, {
          success: true,
          message: "Live Voice 临时票据已签发。",
          data: {
            ticket,
            expires_in_ms: this.ticketStore.ttlMs
          }
        });
        return true;
      }

      const conversationMatch = pathname.match(
        /^\/api\/voice-agent\/sessions\/([^/]+)\/conversation$/
      );
      if (conversationMatch) {
        if (req.method !== "GET") {
          jsonResponse(res, 405, { success: false, message: "Method not allowed" });
          return true;
        }
        const conversation = await this.threadAdapter.currentSessionConversation(
          conversationMatch[1]
        );
        jsonResponse(res, 200, { success: true, data: { conversation } });
        return true;
      }

      const sessionMatch = pathname.match(
        /^\/api\/voice-agent\/sessions\/([^/]+)$/
      );
      if (sessionMatch) {
        if (req.method !== "GET") {
          jsonResponse(res, 405, { success: false, message: "Method not allowed" });
          return true;
        }
        const session = await this.threadAdapter.getSession(sessionMatch[1]);
        jsonResponse(res, 200, { success: true, data: session });
        return true;
      }

      jsonResponse(res, 404, { success: false, message: "Live Voice API 不存在。" });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      jsonResponse(res, status, {
        success: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  }

  attach(server) {
    if (this.wss) return this.wss;
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES
    });
    this.wss = wss;

    server.on("upgrade", (req, socket, head) => {
      const rawPath = new URL(req.url || "/", "http://localhost").pathname;
      const pathname = this.voicePath(rawPath);
      const match = pathname.match(
        /^\/api\/voice-agent\/sessions\/([^/]+)\/live$/
      );
      if (!match) return;
      if (!this.enabled) {
        upgradeError(socket, 503, "Service Unavailable");
        return;
      }
      if (!isVoiceRequestAuthenticated(req, this.token)) {
        upgradeError(socket, 401, "Unauthorized");
        return;
      }
      if (!isTrustedVoiceOrigin(req)) {
        upgradeError(socket, 403, "Forbidden");
        return;
      }
      try {
        safeLiveVoiceSessionId(match[1]);
      } catch {
        upgradeError(socket, 400, "Bad Request");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (socket, req) => this.handleSocket(socket, req));
    server.once("close", () => {
      for (const session of [...this.activeSessions.values()]) {
        void this.destroySession(session);
      }
      this.ticketStore.clear();
      wss.close();
      this.wss = null;
    });
    return wss;
  }

  runtimeStatus(session) {
    const status = session.runtime?.status?.() || {};
    return {
      realtimeActive: status.realtimeActive ?? session.realtimeActive,
      taskRunning: status.taskRunning ?? session.taskRunning,
      turnId: status.turnId ?? session.turnId
    };
  }

  syncLease(session, patch = {}) {
    const runtime = this.runtimeStatus(session);
    session.realtimeActive = Boolean(runtime.realtimeActive);
    session.taskRunning = Boolean(runtime.taskRunning);
    session.turnId = String(runtime.turnId || "");
    const updated = session.lease.update({
      cwd: session.cwd,
      connected: Boolean(session.socket?.readyState === WebSocket.OPEN),
      realtimeActive: session.realtimeActive,
      taskRunning: session.taskRunning,
      turnId: session.turnId,
      detachedAt: session.detachedAt,
      explicitStop: session.explicitStop,
      ...patch
    });
    return updated || {
      threadId: session.threadId,
      connected: false,
      realtimeActive: false,
      taskRunning: false,
      turnId: ""
    };
  }

  publishStatus(session, patch = {}) {
    const current = this.activeSessions.get(session.threadId);
    const status = current === session
      ? this.syncLease(session, patch)
      : {
          threadId: session.threadId,
          cwd: session.cwd,
          connected: false,
          realtimeActive: false,
          taskRunning: false,
          turnId: "",
          ended: true
        };
    const pending = this.threadAdapter.publishLiveVoiceStatus?.(status);
    if (pending && typeof pending.catch === "function") {
      pending.catch((error) => console.error("Live Voice status publish failed", error));
    }
    return status;
  }

  handleRuntimeEvent(session, event) {
    if (this.activeSessions.get(session.threadId) !== session) return;
    if (event.type === "session.started") session.realtimeActive = true;
    if (event.type === "session.closed") session.realtimeActive = false;
    if (event.type === "manager.turn.started") {
      session.taskRunning = true;
      session.turnId = String(event.turn_id || "");
    }
    if (event.type === "manager.turn.completed") {
      session.taskRunning = false;
      session.turnId = "";
    }
    send(session.socket, event);

    if (event.type === "transcript.done" && event.text) {
      const pending = this.threadAdapter.recordLiveVoiceTranscript?.(
        session.threadId,
        event.role,
        event.text
      );
      if (pending && typeof pending.catch === "function") {
        pending.catch((error) => console.error("Live Voice transcript publish failed", error));
      }
    }

    this.publishStatus(session);
    if (
      event.type === "manager.turn.completed"
      && !session.socket
      && (session.explicitStop || session.graceExpired)
    ) {
      void this.destroySession(session);
    }
  }

  clearSessionTimers(session) {
    if (session.detachTimer) this.clearTimeoutFn(session.detachTimer);
    if (session.retentionTimer) this.clearTimeoutFn(session.retentionTimer);
    if (session.taskStatusTimer) this.clearTimeoutFn(session.taskStatusTimer);
    session.detachTimer = null;
    session.retentionTimer = null;
    session.taskStatusTimer = null;
  }

  scheduleTaskRetention(session) {
    if (session.retentionTimer || this.activeSessions.get(session.threadId) !== session) return;
    session.retentionTimer = this.setTimeoutFn(() => {
      session.retentionTimer = null;
      void this.destroySession(session);
    }, this.taskRetentionMs);
    session.retentionTimer?.unref?.();
  }

  scheduleTaskStatusPoll(session) {
    if (
      session.taskStatusTimer
      || session.socket
      || this.activeSessions.get(session.threadId) !== session
    ) return;
    session.taskStatusTimer = this.setTimeoutFn(async () => {
      session.taskStatusTimer = null;
      if (session.socket || this.activeSessions.get(session.threadId) !== session) return;
      try {
        await session.runtime.reconcileTaskStatus?.();
      } catch (error) {
        console.warn(`Live Voice task status check failed: ${error?.message || error}`);
      }
      if (this.activeSessions.get(session.threadId) !== session) return;
      const status = this.runtimeStatus(session);
      this.publishStatus(session);
      if (status.taskRunning) this.scheduleTaskStatusPoll(session);
      else await this.destroySession(session);
    }, this.taskStatusPollMs);
    session.taskStatusTimer?.unref?.();
  }

  scheduleReconnectCleanup(session) {
    if (session.detachTimer || this.activeSessions.get(session.threadId) !== session) return;
    session.detachTimer = this.setTimeoutFn(async () => {
      session.detachTimer = null;
      if (session.socket || this.activeSessions.get(session.threadId) !== session) return;
      session.graceExpired = true;
      await session.runtime.stopRealtime?.();
      this.publishStatus(session);
      if (this.runtimeStatus(session).taskRunning) {
        this.scheduleTaskRetention(session);
        this.scheduleTaskStatusPoll(session);
      } else {
        await this.destroySession(session);
      }
    }, this.reconnectGraceMs);
    session.detachTimer?.unref?.();
  }

  async detachSession(session, socket, explicitStop) {
    if (
      this.activeSessions.get(session.threadId) !== session
      || (session.socket && session.socket !== socket)
    ) return;
    session.socket = null;
    session.detachedAt = new Date().toISOString();
    session.explicitStop = Boolean(explicitStop);
    session.graceExpired = Boolean(explicitStop);
    this.publishStatus(session, { connected: false });

    if (!explicitStop) {
      this.scheduleReconnectCleanup(session);
      return;
    }

    await session.runtime.stopRealtime?.();
    if (this.activeSessions.get(session.threadId) !== session) return;
    this.publishStatus(session, { connected: false, realtimeActive: false });
    if (this.runtimeStatus(session).taskRunning) {
      this.scheduleTaskRetention(session);
      this.scheduleTaskStatusPoll(session);
    } else {
      await this.destroySession(session);
    }
  }

  async destroySession(session) {
    if (!session || session.destroying) return session?.destroyPromise;
    if (this.activeSessions.get(session.threadId) !== session) return;
    session.destroying = true;
    this.clearSessionTimers(session);
    this.activeSessions.delete(session.threadId);
    session.lease.release();
    session.destroyPromise = Promise.resolve(session.runtime.stop?.({
      interruptTask: false
    })).catch((error) => {
      console.error("Live Voice runtime cleanup failed", error);
    }).finally(() => {
      this.publishStatus(session);
    });
    return session.destroyPromise;
  }

  async createSession(sessionId, socket, sdp, voice) {
    // Check genuine web/external conflicts before this gateway acquires its own
    // lease; otherwise its new lease would mask the conflict it is checking.
    const context = await this.threadAdapter.runtimeContext(sessionId);
    const lease = acquireLiveVoiceThread(sessionId, { gateway: this });
    if (!lease) throw new Error("该 Codex thread 已有一个 Live Voice 连接。");
    const session = {
      threadId: sessionId,
      cwd: context.cwd || "",
      socket,
      lease,
      runtime: null,
      realtimeActive: false,
      taskRunning: false,
      turnId: "",
      detachedAt: "",
      explicitStop: false,
      graceExpired: false,
      detachTimer: null,
      retentionTimer: null,
      taskStatusTimer: null,
      destroying: false,
      destroyPromise: null
    };
    session.runtime = this.runtimeFactory({
      ...context,
      voice,
      onEvent: (event) => this.handleRuntimeEvent(session, event)
    });
    lease.setController({
      sendText: async (text) => await session.runtime.appendText(text),
      interruptTask: async () => await session.runtime.interruptTask?.()
    });
    this.activeSessions.set(sessionId, session);
    this.publishStatus(session, { connected: true });
    try {
      await session.runtime.start(sdp, { voice });
      session.realtimeActive = true;
      this.publishStatus(session);
      return session;
    } catch (error) {
      await this.destroySession(session);
      throw error;
    }
  }

  async reconnectSession(session, socket, sdp, voice) {
    const currentSocket = session.socket;
    if (
      currentSocket
      && currentSocket !== socket
      && currentSocket.readyState === WebSocket.OPEN
    ) {
      throw new Error("该 Codex thread 已有一个 Live Voice 连接。");
    }
    this.clearSessionTimers(session);
    session.socket = socket;
    session.detachedAt = "";
    session.explicitStop = false;
    session.graceExpired = false;
    session.runtime.setEventHandler?.((event) => this.handleRuntimeEvent(session, event));
    session.runtime.setVoice?.(voice);
    this.publishStatus(session, { connected: true });
    try {
      await session.runtime.start(sdp, { voice });
      session.realtimeActive = true;
      this.publishStatus(session);
      return session;
    } catch (error) {
      session.socket = null;
      session.detachedAt = new Date().toISOString();
      this.publishStatus(session, { connected: false });
      if (this.runtimeStatus(session).taskRunning) this.scheduleTaskRetention(session);
      else await this.destroySession(session);
      throw error;
    }
  }

  handleSocket(socket, req) {
    const rawPath = new URL(req.url || "/", "http://localhost").pathname;
    const pathname = this.voicePath(rawPath);
    const match = pathname.match(
      /^\/api\/voice-agent\/sessions\/([^/]+)\/live$/
    );
    const sessionId = safeLiveVoiceSessionId(match?.[1]);
    let authenticated = false;
    let attachedSession = null;
    let explicitClose = false;
    let handling = Promise.resolve();

    const authTimer = this.setTimeoutFn(() => {
      if (!authenticated) socket.close(4401, "Live Voice authentication timed out");
    }, this.authTimeoutMs);
    authTimer?.unref?.();

    socket.on("message", (raw, isBinary) => {
      handling = handling.then(async () => {
        if (isBinary || messageByteLength(raw) > MAX_MESSAGE_BYTES) {
          socket.close(4400, "Invalid Live Voice message");
          return;
        }
        let message;
        try {
          message = JSON.parse(raw.toString());
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            throw new Error();
          }
        } catch {
          sendSessionError(socket, "Live Voice 消息格式无效。", true);
          return;
        }
        const type = String(message.type || "");
        if (!authenticated) {
          const ticket = type === "authenticate" && typeof message.ticket === "string"
            ? message.ticket
            : "";
          if (!ticket || !this.ticketStore.consume(sessionId, ticket)) {
            socket.close(4401, "Live Voice authentication failed");
            return;
          }
          authenticated = true;
          this.clearTimeoutFn(authTimer);
          send(socket, { type: "ready", session_id: sessionId });
          return;
        }

        if (type === "start") {
          if (attachedSession) {
            sendSessionError(socket, "Live Voice 已经启动。", true);
            return;
          }
          const sdp = typeof message.sdp === "string" ? message.sdp : "";
          if (!sdp || Buffer.byteLength(sdp, "utf8") > MAX_SDP_BYTES) {
            sendSessionError(socket, "WebRTC SDP offer 无效。");
            return;
          }
          let requestedVoice = this.voice;
          if (message.voice !== undefined && message.voice !== null) {
            const normalizedVoice = normalizeCodexLiveVoiceVoice(message.voice);
            if (!normalizedVoice) {
              sendSessionError(
                socket,
                "不支持的 Codex Live Voice 音色。",
                true
              );
              return;
            }
            requestedVoice = normalizedVoice;
          }
          try {
            const existing = this.activeSessions.get(sessionId);
            attachedSession = existing
              ? await this.reconnectSession(existing, socket, sdp, requestedVoice)
              : await this.createSession(sessionId, socket, sdp, requestedVoice);
          } catch (error) {
            attachedSession = null;
            sendSessionError(
              socket,
              error instanceof Error ? error.message : String(error)
            );
          }
          return;
        }

        if (type === "text") {
          if (!attachedSession) {
            sendSessionError(socket, "Live Voice 尚未启动。");
            return;
          }
          const text = typeof message.text === "string" ? message.text.trim() : "";
          if (!text || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
            sendSessionError(socket, "Live Voice 文字输入无效。", true);
            return;
          }
          await attachedSession.runtime.appendText(text);
          return;
        }

        if (type === "mute") {
          send(socket, { type: "session.muted", muted: message.muted === true });
          return;
        }

        if (type === "stop") {
          const session = attachedSession;
          attachedSession = null;
          explicitClose = true;
          send(socket, { type: "session.closed", reason: "requested" });
          socket.close(1000, "Live Voice stopped");
          if (session) await this.detachSession(session, socket, true);
          return;
        }

        sendSessionError(socket, `不支持的 Live Voice 消息：${type}`, true);
      }).catch((error) => {
        sendSessionError(
          socket,
          error instanceof Error ? error.message : String(error)
        );
      });
    });

    const cleanup = () => {
      this.clearTimeoutFn(authTimer);
      const session = attachedSession;
      attachedSession = null;
      if (session && !explicitClose) {
        void this.detachSession(session, socket, false);
      }
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  }
}
