import { randomUUID } from "node:crypto";
import { codexBin, codexModel, codexReasoningEffort, codexWorkDir } from "./config.js";
import { broadcast } from "./sse.js";
import { rpcErrorMessage } from "./utils.js";
import { projectPath, absoluteStateCwd } from "./paths.js";
import { assistantBubbleText, saveGeneratedImage, contextUsageFromEvent } from "./threads.js";
import { createLocalAppServerTransport } from "./transport/local.js";

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const compact = normalized.replace(/[\s_-]+/g, "");
  return compact === "extrahigh" || compact === "xhigh" ? "xhigh" : normalized;
}

export class CodexAppServer {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.model = options.model || "";
    this.reasoningEffort = options.reasoningEffort || "";
    this.isRemote = Boolean(options.isRemote);
    this.resolveCwd = options.resolveCwd || ((state = {}) => absoluteStateCwd(state));
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.activeThreadId = "";
    this.activeCwd = "";
    this.runner = null;
    this.turn = null;
    this.contextUsage = null;
    this.onContextUpdate = null;
  }

  emit(event) {
    if (this.runner?.emit) this.runner.emit(event);
    else broadcast(event);
  }

  async ensureStarted() {
    if (this.transport.alive && this.initialized) return;
    this.pending.clear();
    this.initialized = false;
    this.activeThreadId = "";
    this.activeCwd = "";
    this.turn = null;

    this.transport.onMessage((line) => this.onLine(line));
    this.transport.onError((error) => this.rejectAll(error));
    this.transport.onClose((code) => {
      const error = new Error(`Codex app-server 已退出：${code}`);
      this.rejectAll(error);
      this.initialized = false;
      this.activeThreadId = "";
      this.activeCwd = "";
      this.turn = null;
    });

    await this.transport.start();
    try {
      await this.request("initialize", {
        clientInfo: { name: "codex-remote-web", title: "Codex Remote Web", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      });
    } catch (error) {
      if (!/already initialized/i.test(error?.message || "")) throw error;
    }
    this.initialized = true;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const turn = this.turn;
    this.turn = null;
    if (turn) {
      this.setTurnReconnecting(turn, false);
      turn.reject(error);
    }
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { console.error(line); return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(rpcErrorMessage(message.error)));
      } else {
        if (pending.onResult) pending.onResult(message.result);
        pending.resolve(message.result);
      }
      return;
    }
    this.onNotification(message);
  }

  updateContextUsage(payload = {}) {
    const next = contextUsageFromEvent(payload, this.turn?.threadId || this.activeThreadId);
    if (!next) return false;
    this.contextUsage = next;
    if (this.runner) this.runner.contextUsage = next;
    this.onContextUpdate?.(next);
    return true;
  }

  onNotification(message) {
    const method = message.method;
    const params = message.params || {};
    const payload = params.payload || params.event || params;
    const notificationTurnId = params.turnId || params.turn?.id || "";
    const notificationMatchesTurn = Boolean(this.turn
      && (!params.threadId || params.threadId === this.turn.threadId)
      && (!notificationTurnId || !this.turn.turnId || notificationTurnId === this.turn.turnId));
    if (notificationMatchesTurn && notificationTurnId && !this.turn.turnId) {
      this.turn.turnId = notificationTurnId;
    }
    if (notificationMatchesTurn) this.turn.onActivity?.();
    if (notificationMatchesTurn && this.turn.reconnecting && method !== "error" && notificationTurnId) {
      this.setTurnReconnecting(this.turn, false);
    }
    if (this.updateContextUsage(payload)) {
      // A runner's onContextUpdate callback emits a complete status payload.
      // Do not emit a second, incomplete status event: the browser would read
      // its missing `running` field as false and appear to end the task.
      return;
    }
    if (method === "thread/status/changed" || method === "turn/started") return;
    if (method === "item/started" && params.item?.type) {
      if (params.item.type === "agentMessage" && this.turn) {
        this.turn.currentMessage = {
          id: params.item.id || `assistant-${Date.now()}`,
          text: "",
          phase: params.item.phase || null
        };
      }
      return;
    }
    if (method === "item/agentMessage/delta" && this.turn) {
      const messageId = params.itemId || this.turn.currentMessage?.id || "assistant";
      const current = this.turn.currentMessage?.id === messageId
        ? this.turn.currentMessage
        : (this.turn.currentMessage = { id: messageId, text: "", phase: null });
      current.text += params.delta || "";
      if (current.text) {
        this.emit({
          type: "message",
          role: "assistant",
          content: assistantBubbleText(current.text, current.phase),
          messageId,
          transient: true
        });
      }
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage" && this.turn) {
      const messageId = params.item.id || this.turn.currentMessage?.id || `assistant-${Date.now()}`;
      const text = params.item.text || this.turn.currentMessage?.text || "";
      const phase = params.item.phase || this.turn.currentMessage?.phase || null;
      if (text) {
        const content = assistantBubbleText(text, phase);
        const taskDurationMs = /^✅\s/.test(content) ? Math.max(0, Date.now() - this.turn.startedAtMs) : null;
        this.turn.answers.push(content);
        this.emit({ type: "message", role: "assistant", content, messageId, final: true, taskDurationMs });
        this.emit({ type: "reply_done" });
      }
      this.turn.currentMessage = null;
      return;
    }
    if (method === "item/completed" && params.item?.type === "image_generation_call" && this.turn) {
      const turn = this.turn;
      const imageId = params.item.id || `image-${Date.now()}`;
      if (turn.imageIds.has(imageId)) return;
      turn.imageIds.add(imageId);
      const pending = saveGeneratedImage(params.item, turn.threadId)
        .then((file) => {
          if (!file) return;
          const content = assistantBubbleText(file, "final_answer");
          turn.answers.push(content);
          this.emit({ type: "message", role: "assistant", content, messageId: imageId, final: true });
          this.emit({ type: "reply_done" });
        })
        .catch((error) => console.error("failed to save generated image", error));
      turn.pendingImages.push(pending);
      return;
    }
    if (method === "turn/completed" && notificationMatchesTurn) {
      const turn = this.turn;
      const status = params.turn?.status || "completed";
      if (status === "inProgress") return;
      Promise.allSettled(turn.pendingImages)
        .then(() => {
          const answers = turn.answers.length ? turn.answers : [turn.currentMessage?.text || ""].filter(Boolean);
          if (this.turn === turn) this.turn = null;
          this.setTurnReconnecting(turn, false);
          if (status === "completed") {
            turn.resolve(answers.map((answer) => answer.trim()).filter(Boolean));
            return;
          }
          const detail = params.turn?.error || turn.lastError || {};
          const error = new Error(detail.message || (status === "interrupted" ? "Codex 回合已中断。" : "Codex 回合执行失败。"));
          error.codexErrorInfo = detail.codexErrorInfo || null;
          error.partialAnswer = answers.map((answer) => answer.trim()).filter(Boolean).join("\n\n");
          turn.reject(error);
        })
        .catch((error) => {
          if (this.turn === turn) this.turn = null;
          turn.reject(error);
        });
      return;
    }
    if (method === "error" && notificationMatchesTurn) {
      this.turn.lastError = params.error || null;
      if (params.willRetry) {
        this.setTurnReconnecting(this.turn, true, rpcErrorMessage(params.error));
      } else {
        this.setTurnReconnecting(this.turn, false);
      }
      // Error notifications are followed by turn/completed. In particular,
      // willRetry=true is a recoverable stream interruption, so the turn must
      // remain active until app-server reports its final status.
    }
  }

  setTurnReconnecting(turn, reconnecting, message = "") {
    if (!turn) return;
    const next = Boolean(reconnecting);
    if (turn.reconnecting === next && (!next || turn.reconnectMessage === message)) return;
    turn.reconnecting = next;
    turn.reconnectMessage = next ? String(message || "") : "";
    if (this.runner) this.runner.reconnecting = next;
    this.emit({ type: "reconnecting", reconnecting: next, message: turn.reconnectMessage, running: true });
  }

  request(method, params, onResult = null) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, onResult });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async ensureThread(threadId, cwd = codexWorkDir, settings = {}) {
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    const configured = settings.model ? settings : await this.configuredModelSettings(resolvedCwd);
    if (threadId && threadId === this.activeThreadId && resolvedCwd === this.activeCwd) return threadId;
    const params = {
      cwd: resolvedCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: configured.model || undefined,
      config: { model_reasoning_effort: configured.reasoningEffort || undefined }
    };
    const result = threadId
      ? await this.request("thread/resume", { ...params, threadId })
      : await this.request("thread/start", params);
    this.activeThreadId = result.thread.id;
    this.activeCwd = resolvedCwd;
    return this.activeThreadId;
  }

  async runTurn(message, state, options = {}) {
    if (this.turn) throw new Error("Codex 正在处理上一条消息。");
    const cwd = this.resolveCwd(state);
    const settings = {
      model: options.model || state.model || "",
      reasoningEffort: options.reasoningEffort || state.reasoningEffort || ""
    };
    state.threadId = await this.ensureThread(state.threadId, cwd, settings);
    if (typeof options.onConnected === "function") options.onConnected();
    if (typeof options.onThreadReady === "function") await options.onThreadReady(state);
    return await new Promise((resolve, reject) => {
      const turn = {
        threadId: state.threadId,
        turnId: "",
        startedAtMs: Date.now(),
        answers: [],
        currentMessage: null,
        imageIds: new Set(),
        pendingImages: [],
        reconnecting: false,
        reconnectMessage: "",
        lastError: null,
        onActivity: typeof options.onActivity === "function" ? options.onActivity : null,
        resolve,
        reject
      };
      this.turn = turn;
      this.request("turn/start", {
        threadId: state.threadId,
        cwd,
        model: settings.model || undefined,
        effort: settings.reasoningEffort || undefined,
        input: [{ type: "text", text: message, text_elements: [] }]
      }, (result) => {
        turn.turnId = result.turn.id;
      }).catch((error) => {
        if (this.turn === turn) {
          this.turn = null;
          this.setTurnReconnecting(turn, false);
        }
        reject(error);
      });
    });
  }

  async listModels() {
    await this.ensureStarted();
    return await this.request("model/list", { limit: 30, includeHidden: false });
  }

  async readRateLimits() {
    await this.ensureStarted();
    return await this.request("account/rateLimits/read");
  }

  async consumeRateLimitResetCredit(creditId = "") {
    await this.ensureStarted();
    return await this.request("account/rateLimitResetCredit/consume", {
      idempotencyKey: randomUUID(),
      creditId: creditId || null
    });
  }

  async configuredModelSettings(cwd = "") {
    await this.ensureStarted();
    const targetCwd = cwd
      ? (this.isRemote ? String(cwd) : projectPath(cwd))
      : null;
    const result = await this.request("config/read", { cwd: targetCwd, includeLayers: false });
    return {
      model: result?.config?.model || this.model || "",
      reasoningEffort: result?.config?.model_reasoning_effort || this.reasoningEffort || ""
    };
  }

  async modelOptions() {
    const result = await this.listModels();
    return Array.isArray(result?.data) ? result.data : [];
  }

  async readThreadSettings(threadId, cwd = codexWorkDir) {
    if (!threadId) return null;
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    const result = await this.request("thread/resume", { threadId, cwd: resolvedCwd });
    this.activeThreadId = result.thread.id;
    this.activeCwd = resolvedCwd;
    return {
      model: result.model || "",
      reasoningEffort: result.reasoningEffort || ""
    };
  }

  async updateThreadModelSettings({ model, effort, threadId = "", cwd = codexWorkDir }) {
    if (this.turn) throw new Error("当前回合正在运行，请结束或中断后再切换模型设置。");
    if (threadId) {
      const id = await this.ensureThread(threadId, cwd, { model, reasoningEffort: effort });
      await this.request("thread/settings/update", { threadId: id, model, effort });
    }
    return { model, effort };
  }

  async selectModel(requestedModel, currentEffort = "", threadId = "", cwd = codexWorkDir) {
    const models = await this.modelOptions();
    const wanted = String(requestedModel || "").trim().toLowerCase();
    const selected = models.find((item) =>
      [item.model, item.id].some((value) => String(value || "").toLowerCase() === wanted)
    );
    if (!selected) throw new Error(`不支持的模型：${requestedModel}`);
    const efforts = (selected.supportedReasoningEfforts || [])
      .map((item) => item.reasoningEffort)
      .filter(Boolean);
    const effort = efforts.includes(currentEffort)
      ? currentEffort
      : (selected.defaultReasoningEffort || efforts[0] || currentEffort);
    await this.updateThreadModelSettings({ model: selected.model || selected.id, effort, threadId, cwd });
    return { selected, effort, effortChanged: effort !== currentEffort };
  }

  async selectReasoningEffort(requestedEffort, currentModel = "", threadId = "", cwd = codexWorkDir) {
    const models = await this.modelOptions();
    const selected = models.find((item) => [item.model, item.id].includes(currentModel))
      || models.find((item) => item.isDefault)
      || models[0];
    if (!selected) throw new Error("当前 Codex CLI 没有返回可用模型。");
    const wanted = normalizeReasoningEffort(requestedEffort);
    const option = (selected.supportedReasoningEfforts || []).find(
      (item) => String(item.reasoningEffort || "").toLowerCase() === wanted
    );
    if (!option) throw new Error(`模型 ${selected.model || selected.id} 不支持思考强度：${requestedEffort}`);
    await this.updateThreadModelSettings({
      model: selected.model || selected.id,
      effort: option.reasoningEffort,
      threadId,
      cwd
    });
    return { selected, option };
  }

  async readConfig(cwd = codexWorkDir) {
    await this.ensureStarted();
    const targetCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    return await this.request("config/read", { cwd: targetCwd, includeLayers: false });
  }

  async gitDiff(cwd = codexWorkDir) {
    await this.ensureStarted();
    const targetCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    return await this.request("gitDiffToRemote", { cwd: targetCwd });
  }

  async compactCurrentThread(threadId, cwd = codexWorkDir) {
    const id = await this.ensureThread(threadId, cwd);
    await this.request("thread/compact/start", { threadId: id });
    return id;
  }

  async interruptCurrentTurn() {
    if (this.turn?.threadId && this.turn?.turnId) {
      await this.request("turn/interrupt", { threadId: this.turn.threadId, turnId: this.turn.turnId });
      return true;
    }
    return false;
  }

  async abortCurrentTurn(error = new Error("Codex 回合已中断。")) {
    const turn = this.turn;
    if (!turn) return false;
    this.turn = null;
    this.setTurnReconnecting(turn, false);
    turn.reject(error);

    if (!turn.threadId || !turn.turnId) {
      this.transport.kill?.();
      this.initialized = false;
      return true;
    }
    try {
      await Promise.race([
        this.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("中断请求超时")), 5000))
      ]);
    } catch {
      // A stuck app-server cannot be reused safely. It will be created again on
      // the next message instead of keeping the browser in a running state.
      this.transport.kill?.();
      this.initialized = false;
      this.activeThreadId = "";
      this.activeCwd = "";
    }
    return true;
  }

  async steerCurrentTurn(message) {
    if (!this.turn?.threadId || !this.turn?.turnId) throw new Error("no active turn to steer");
    await this.request("turn/steer", {
      threadId: this.turn.threadId,
      turnId: this.turn.turnId,
      expectedTurnId: this.turn.turnId,
      input: [{ type: "text", text: message, text_elements: [] }]
    });
    return true;
  }
}

export function createLocalAppServer() {
  const transport = createLocalAppServerTransport({
    bin: codexBin,
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    cwd: codexWorkDir,
    env: process.env
  });
  return new CodexAppServer(transport, {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    isRemote: false,
    resolveCwd: (state = {}) => absoluteStateCwd(state)
  });
}
