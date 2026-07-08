import { codexBin, codexModel, codexReasoningEffort, codexWorkDir } from "./config.js";
import { broadcast } from "./sse.js";
import { rpcErrorMessage } from "./utils.js";
import { projectPath, absoluteStateCwd } from "./paths.js";
import { assistantBubbleText, saveGeneratedImage, contextUsageFromEvent } from "./threads.js";
import { createLocalAppServerTransport } from "./transport/local.js";

export class CodexAppServer {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.model = options.model || codexModel;
    this.reasoningEffort = options.reasoningEffort || codexReasoningEffort;
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
    await this.request("initialize", {
      clientInfo: { name: "codex-remote-web", title: "Codex Remote Web", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.initialized = true;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.turn) this.turn.reject(error);
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
    if (this.updateContextUsage(payload)) {
      this.emit({ type: "status" });
      return;
    }
    if (!this.runner && this.updateContextUsage(payload)) {
      broadcast({ type: "status" });
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
    if (method === "turn/completed" && this.turn && params.turn?.id === this.turn.turnId) {
      const turn = this.turn;
      Promise.allSettled(turn.pendingImages)
        .then(() => {
          const answers = turn.answers.length ? turn.answers : [turn.currentMessage?.text || ""].filter(Boolean);
          if (this.turn === turn) this.turn = null;
          turn.resolve(answers.map((answer) => answer.trim()).filter(Boolean));
        })
        .catch((error) => {
          if (this.turn === turn) this.turn = null;
          turn.reject(error);
        });
      return;
    }
    if (method === "error" && this.turn) {
      const error = new Error(rpcErrorMessage(params.error));
      error.partialAnswer = this.turn.answers.concat(this.turn.currentMessage?.text || "").filter(Boolean).join("\n\n").trim();
      const reject = this.turn.reject;
      this.turn = null;
      reject(error);
    }
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

  async ensureThread(threadId, cwd = codexWorkDir) {
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    if (threadId && threadId === this.activeThreadId && resolvedCwd === this.activeCwd) return threadId;
    const params = {
      cwd: resolvedCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { model: this.model, model_reasoning_effort: this.reasoningEffort }
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
    state.threadId = await this.ensureThread(state.threadId, cwd);
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
        resolve,
        reject
      };
      this.turn = turn;
      this.request("turn/start", {
        threadId: state.threadId,
        cwd,
        input: [{ type: "text", text: message, text_elements: [] }]
      }, (result) => {
        turn.turnId = result.turn.id;
      }).catch((error) => {
        if (this.turn === turn) this.turn = null;
        reject(error);
      });
    });
  }

  async listModels() {
    await this.ensureStarted();
    return await this.request("model/list", { limit: 30, includeHidden: false });
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
