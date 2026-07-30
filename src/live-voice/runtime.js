import { createLocalAppServer } from "../codex-server.js";

function turnRecord(params = {}) {
  return params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
    ? params.turn
    : {};
}

function itemRecord(params = {}) {
  const item = params.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return {};
  return item.root && typeof item.root === "object" && !Array.isArray(item.root)
    ? item.root
    : item;
}

function eventErrorMessage(params = {}) {
  if (typeof params.message === "string" && params.message) return params.message;
  if (params.error && typeof params.error === "object" && typeof params.error.message === "string") {
    return params.error.message;
  }
  return "Codex Live Voice 运行出错。";
}

function notificationThreadId(params = {}) {
  const turn = turnRecord(params);
  return String(
    params.threadId
      || params.thread_id
      || params.thread?.id
      || turn.threadId
      || turn.thread_id
      || ""
  );
}

/**
 * Owns one long-lived app-server connection for a Codex thread.
 *
 * Audio can be stopped and renegotiated without destroying the app-server or
 * interrupting a delegated Codex turn. This is the key boundary that lets an
 * Android WebRTC/WebSocket reconnect happen independently from task execution.
 */
export class CodexLiveVoiceRuntime {
  constructor({
    threadId,
    cwd,
    model = "",
    reasoningEffort = "",
    voice = "cove",
    onEvent = () => {},
    // RealtimeConversation is captured when Codex loads a thread. A shared
    // daemon may already have loaded that thread before the experimental
    // feature was enabled, in which case realtime/start rejects it even if the
    // daemon config has since changed. Keep voice on a coordinator-owned,
    // explicitly feature-enabled app-server; the lease layer still guarantees
    // that web and Android never write the thread concurrently.
    appServerFactory = () => createLocalAppServer({
      realtime: true,
      useShared: false
    })
  }) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.voice = voice;
    this.onEvent = onEvent;
    this.appServerFactory = appServerFactory;
    this.appServer = null;
    this.unsubscribe = null;
    this.answerSdp = null;
    this.destroyed = false;
    this.realtimeActive = false;
    this.taskRunning = false;
    this.activeTurnId = "";
    this.agentMessageDeltas = new Map();
    this.audioOperation = Promise.resolve();
  }

  setEventHandler(handler) {
    this.onEvent = typeof handler === "function" ? handler : () => {};
  }

  setVoice(voice) {
    const value = String(voice || "").trim();
    if (value) this.voice = value;
  }

  status() {
    return {
      realtimeActive: this.realtimeActive,
      taskRunning: this.taskRunning,
      turnId: this.activeTurnId
    };
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      console.error("Live Voice event handler failed", error);
    }
  }

  queueAudioOperation(operation) {
    const next = this.audioOperation
      .catch(() => {})
      .then(operation);
    this.audioOperation = next.catch(() => {});
    return next;
  }

  async ensureAppServer() {
    if (this.destroyed) throw new Error("Live Voice 运行时已经关闭。");
    if (this.appServer) return this.appServer;
    const appServer = this.appServerFactory();
    this.appServer = appServer;
    this.unsubscribe = appServer.onRawNotification((message) => {
      this.handleNotification(message);
    });
    try {
      const resumedThreadId = await appServer.ensureThread(
        this.threadId,
        this.cwd,
        {
          model: this.model,
          reasoningEffort: this.reasoningEffort
        }
      );
      if (resumedThreadId !== this.threadId) {
        throw new Error("Codex 恢复后的 thread ID 与网页当前会话不一致。");
      }
      return appServer;
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.appServer = null;
      appServer.close?.();
      throw error;
    }
  }

  async start(offerSdp, options = {}) {
    // SDP is a line-oriented wire format. In particular, Android WebRTC emits
    // a trailing CRLF that Codex's SDP parser expects. Use trim only to reject
    // an empty value; forward the browser/device-generated offer byte-for-byte.
    const offer = String(offerSdp || "");
    if (!offer.trim()) throw new Error("Live Voice 缺少 WebRTC SDP offer。");
    if (options.voice) this.setVoice(options.voice);
    return this.queueAudioOperation(async () => {
      const appServer = await this.ensureAppServer();
      if (this.realtimeActive || this.answerSdp) {
        await this.stopRealtimeNow();
      }

      const sdpPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.answerSdp?.timer === timer) this.answerSdp = null;
          reject(new Error("等待 Codex Live Voice SDP answer 超时。"));
        }, 45_000);
        timer.unref?.();
        this.answerSdp = { resolve, reject, timer };
      });
      try {
        const startRequest = appServer.request("thread/realtime/start", {
          threadId: this.threadId,
          version: "v3",
          outputModality: "audio",
          transport: { type: "webrtc", sdp: offer },
          includeStartupContext: true,
          flushTranscriptTailOnSessionEnd: false,
          clientManagedHandoffs: false,
          codexResponseHandoffMode: "bemTags",
          ...(this.voice ? { voice: this.voice } : {})
        }, null, 60_000);
        const [, answerSdp] = await Promise.all([startRequest, sdpPromise]);
        this.realtimeActive = true;
        return answerSdp;
      } catch (error) {
        this.realtimeActive = false;
        if (this.answerSdp) {
          const pending = this.answerSdp;
          this.answerSdp = null;
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        throw error;
      }
    });
  }

  async appendText(text) {
    const value = String(text || "").trim();
    if (!value) return;
    const appServer = await this.ensureAppServer();
    if (this.realtimeActive) {
      await appServer.request("thread/realtime/appendText", {
        threadId: this.threadId,
        role: "user",
        text: value
      }, null, 30_000);
      return { mode: "realtime" };
    }
    if (this.taskRunning && this.activeTurnId) {
      await this.steerTask(value);
      return { mode: "steer" };
    }
    throw new Error("Live Voice 正在等待安卓端重新连接，当前没有可引导的任务。");
  }

  async steerTask(text) {
    const value = String(text || "").trim();
    if (!value) return;
    if (!this.taskRunning || !this.activeTurnId) {
      throw new Error("当前没有正在执行的 Live Voice Codex 任务。");
    }
    const appServer = await this.ensureAppServer();
    await appServer.request("turn/steer", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: "text", text: value, text_elements: [] }]
    }, null, 30_000);
  }

  async interruptTask() {
    if (!this.taskRunning || !this.activeTurnId || !this.appServer) return false;
    await this.appServer.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurnId
    }, null, 10_000);
    return true;
  }

  async stopRealtime() {
    return this.queueAudioOperation(() => this.stopRealtimeNow());
  }

  async stopRealtimeNow() {
    if (this.answerSdp) {
      const pending = this.answerSdp;
      this.answerSdp = null;
      clearTimeout(pending.timer);
      pending.reject(new Error("Live Voice 在协商完成前已停止。"));
    }
    const appServer = this.appServer;
    if (!appServer) {
      this.realtimeActive = false;
      return;
    }
    if (this.realtimeActive) {
      try {
        await appServer.request(
          "thread/realtime/stop",
          { threadId: this.threadId },
          null,
          5_000
        );
      } catch {}
    }
    this.realtimeActive = false;
  }

  async stop(options = {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.queueAudioOperation(() => this.stopRealtimeNow());
    const appServer = this.appServer;
    this.appServer = null;
    if (options.interruptTask === true && appServer && this.taskRunning && this.activeTurnId) {
      try {
        await appServer.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId
        }, null, 5_000);
      } catch {}
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (appServer) {
      try {
        await appServer.request(
          "thread/unsubscribe",
          { threadId: this.threadId },
          null,
          5_000
        );
      } catch {}
      appServer.close?.();
    }
    this.realtimeActive = false;
    this.taskRunning = false;
    this.activeTurnId = "";
  }

  handleNotification(message = {}) {
    const method = message.method;
    const params = message.params || {};
    const eventThreadId = notificationThreadId(params);
    if (eventThreadId && eventThreadId !== this.threadId) return;
    switch (method) {
      case "thread/realtime/started":
        this.realtimeActive = true;
        this.emit({
          type: "session.started",
          thread_id: String(params.threadId || this.threadId),
          realtime_session_id: typeof params.realtimeSessionId === "string"
            ? params.realtimeSessionId
            : undefined,
          version: String(params.version || "v3")
        });
        break;
      case "thread/realtime/sdp": {
        const sdp = typeof params.sdp === "string" ? params.sdp : "";
        if (!sdp) break;
        if (this.answerSdp) {
          const pending = this.answerSdp;
          this.answerSdp = null;
          clearTimeout(pending.timer);
          pending.resolve(sdp);
        }
        this.emit({ type: "session.sdp", sdp });
        break;
      }
      case "thread/realtime/transcript/delta":
        this.emit({
          type: "transcript.delta",
          role: String(params.role || ""),
          delta: String(params.delta || "")
        });
        break;
      case "thread/realtime/transcript/done":
        this.emit({
          type: "transcript.done",
          role: String(params.role || ""),
          text: String(params.text || "")
        });
        break;
      case "thread/realtime/itemAdded": {
        const type = params.item && typeof params.item === "object"
          ? String(params.item.type || "")
          : "";
        if (type.includes("handoff") || type.includes("delegation")) {
          this.emit({ type: "handoff" });
        }
        break;
      }
      case "turn/started": {
        const turn = turnRecord(params);
        this.taskRunning = true;
        this.activeTurnId = typeof turn.id === "string"
          ? turn.id
          : String(params.turnId || "");
        this.emit({
          type: "manager.turn.started",
          turn_id: this.activeTurnId || undefined
        });
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = String(params.itemId || "");
        const delta = String(params.delta || "");
        if (itemId && delta) {
          const parts = this.agentMessageDeltas.get(itemId) || [];
          parts.push(delta);
          this.agentMessageDeltas.set(itemId, parts);
        }
        break;
      }
      case "item/completed": {
        const item = itemRecord(params);
        if (item.type !== "agentMessage") break;
        const itemId = String(item.id || "");
        const text = typeof item.text === "string"
          ? item.text
          : (this.agentMessageDeltas.get(itemId) || []).join("");
        this.agentMessageDeltas.delete(itemId);
        if (item.phase === "commentary" && text.trim()) {
          this.emit({ type: "manager.progress", text: text.trim() });
        }
        break;
      }
      case "turn/completed": {
        const turn = turnRecord(params);
        const completedTurnId = typeof turn.id === "string"
          ? turn.id
          : String(params.turnId || "");
        if (
          !this.taskRunning
          || (completedTurnId && this.activeTurnId && completedTurnId !== this.activeTurnId)
        ) break;
        this.taskRunning = false;
        this.activeTurnId = "";
        this.emit({
          type: "manager.turn.completed",
          status: typeof turn.status === "string" ? turn.status : undefined
        });
        break;
      }
      case "thread/realtime/error":
      case "error": {
        const errorMessage = eventErrorMessage(params);
        if (this.answerSdp) {
          const pending = this.answerSdp;
          this.answerSdp = null;
          clearTimeout(pending.timer);
          pending.reject(new Error(errorMessage));
        }
        if (method === "thread/realtime/error") this.realtimeActive = false;
        this.emit({
          type: "session.error",
          message: errorMessage,
          recoverable: false
        });
        break;
      }
      case "thread/realtime/closed": {
        this.realtimeActive = false;
        const reason = typeof params.reason === "string" ? params.reason : undefined;
        if (this.answerSdp) {
          const pending = this.answerSdp;
          this.answerSdp = null;
          clearTimeout(pending.timer);
          pending.reject(new Error(
            reason
              ? `Codex Live Voice 在 SDP 协商前关闭：${reason}`
              : "Codex Live Voice 在 SDP 协商前关闭。"
          ));
        }
        this.emit({ type: "session.closed", reason });
        break;
      }
    }
  }
}
