import { randomUUID } from "node:crypto";
import { codexBin, codexModel, codexReasoningEffort, codexWorkDir } from "./config.js";
import { broadcast } from "./sse.js";
import { rpcErrorMessage } from "./utils.js";
import { projectPath, absoluteStateCwd } from "./paths.js";
import {
  assistantBubbleText, saveGeneratedImage, contextUsageFromEvent,
  fullReplyItemTextLimit, fullReplyMessageFromThreadItem
} from "./threads.js";
import { createLocalAppServerTransport } from "./transport/local.js";

export const supplementalModelOptions = Object.freeze([
  Object.freeze({
    id: "gemini-3.6-flash-high",
    model: "gemini-3.6-flash-high",
    displayName: "Gemini 3.6 Flash High",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: Object.freeze([
      Object.freeze({ reasoningEffort: "high" })
    ])
  }),
  Object.freeze({
    id: "mimo-v2.5-pro",
    model: "mimo-v2.5-pro",
    displayName: "mimo-v2.5-pro",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: Object.freeze([
      Object.freeze({ reasoningEffort: "high" })
    ])
  })
]);

export function withSupplementalModelOptions(reportedModels = []) {
  const models = Array.isArray(reportedModels) ? [...reportedModels] : [];
  const reportedIds = new Set(models.flatMap((item) => [item?.id, item?.model])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  for (const option of supplementalModelOptions) {
    const aliases = [option.id, option.model].map((value) => String(value || "").toLowerCase());
    if (aliases.some((value) => reportedIds.has(value))) continue;
    models.push({
      ...option,
      supportedReasoningEfforts: option.supportedReasoningEfforts.map((item) => ({ ...item }))
    });
    for (const alias of aliases) reportedIds.add(alias);
  }
  return models;
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const compact = normalized.replace(/[\s_-]+/g, "");
  return compact === "extrahigh" || compact === "xhigh" ? "xhigh" : normalized;
}

function normalizeServiceTier(value) {
  return String(value || "").trim().toLowerCase();
}

export function fastServiceTierForModel(model = {}) {
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  const fastTier = tiers.find((tier) => normalizeServiceTier(tier?.id) === "priority")
    || tiers.find((tier) => normalizeServiceTier(tier?.id) === "fast")
    || tiers.find((tier) => normalizeServiceTier(tier?.name) === "fast");
  if (fastTier) return { ...fastTier };
  const legacyTiers = Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
  if (legacyTiers.some((tier) => normalizeServiceTier(tier) === "fast")) {
    return { id: "fast", name: "Fast", description: "" };
  }
  return null;
}

export function isFastServiceTier(value, fastTier = null) {
  const normalized = normalizeServiceTier(value);
  if (!normalized) return false;
  return new Set([
    "fast",
    "priority",
    normalizeServiceTier(fastTier?.id)
  ].filter(Boolean)).has(normalized);
}

function missingModelProviderName(error) {
  const message = String(error?.message || error || "");
  const match = message.match(/Model provider\s+([`'"]?)([^`'"\s]+)\1\s+not found/i);
  return match?.[2] || "";
}

function rejectsModelProviderOverride(error) {
  const message = String(error?.message || error || "");
  return /(?:unknown|unexpected|unrecognized)\s+field[^\n]*modelProvider/i.test(message)
    || /modelProvider[^\n]*(?:unknown|unexpected|unrecognized)\s+field/i.test(message)
    || /invalid params[^\n]*modelProvider/i.test(message);
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
    this.onThreadSettingsUpdate = null;
    this.threadSettingsWaiters = new Map();
    this.notificationListeners = new Set();
    this.starting = null;
    this.settingsUpdatePromise = null;
    this.turnStarting = false;
    this.optOutNotificationMethods = Array.isArray(options.optOutNotificationMethods)
      ? options.optOutNotificationMethods.filter(Boolean)
      : [];
  }

  emit(event) {
    if (this.runner?.emit) this.runner.emit(event);
    else broadcast(event);
  }

  onRawNotification(listener) {
    if (typeof listener !== "function") return () => {};
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async ensureStarted() {
    if (this.transport.alive && this.initialized) return;
    if (this.starting) return this.starting;
    const starting = this.startAndInitialize();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async startAndInitialize() {
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

    const initialize = () => this.request("initialize", {
        clientInfo: { name: "codex-remote-web", title: "Codex Remote Web", version: "1.0.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          ...(this.optOutNotificationMethods.length
            ? { optOutNotificationMethods: this.optOutNotificationMethods }
            : {})
        }
      }, null, this.transport.mode === "shared" ? 3000 : 15000);
    await this.transport.start();
    try {
      await initialize();
    } catch (error) {
      if (/already initialized/i.test(error?.message || "")) {
        // A few older app-server builds initialize the process rather than the
        // connection. Reusing that process is still safe.
      } else if (this.transport.mode === "shared" && typeof this.transport.fallbackToStandalone === "function") {
        console.warn(`共享 Codex app-server 初始化失败，已回退到独立进程：${error?.message || error}`);
        await this.transport.fallbackToStandalone();
        await initialize();
      } else {
        throw error;
      }
    }
    this.initialized = true;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.threadSettingsWaiters.values()) {
      for (const waiter of waiters) waiter.finish(null);
    }
    this.threadSettingsWaiters.clear();
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
        const error = new Error(rpcErrorMessage(message.error));
        error.rpcError = message.error;
        pending.reject(error);
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

  notificationTime(value) {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return new Date().toISOString();
    try { return new Date(time).toISOString(); }
    catch { return new Date().toISOString(); }
  }

  rememberFullItem(item = {}) {
    if (!this.turn || !item?.type) return null;
    const fullItems = this.turn.fullItems || (this.turn.fullItems = new Map());
    const id = item.id || `full-${item.type}-${fullItems.size}`;
    const remembered = { ...item, id };
    fullItems.set(id, remembered);
    return remembered;
  }

  currentFullItem(itemId = "", fallbackType = "") {
    if (!this.turn) return null;
    const fullItems = this.turn.fullItems || (this.turn.fullItems = new Map());
    const id = itemId || `full-${fallbackType || "item"}`;
    let item = fullItems.get(id);
    if (!item && fallbackType) {
      item = { id, type: fallbackType };
      fullItems.set(id, item);
    }
    return item || null;
  }

  appendFullItemText(current = "", delta = "") {
    const next = `${current || ""}${delta || ""}`;
    if (next.length <= fullReplyItemTextLimit) return next;
    const marker = "…（较早的 CLI 输出已省略）\n";
    return `${marker}${next.slice(-(fullReplyItemTextLimit - marker.length))}`;
  }

  emitFullItem(item = {}, final = false, atValue = 0) {
    if (!this.turn) return false;
    const formatted = fullReplyMessageFromThreadItem(item, {
      final,
      at: this.notificationTime(atValue)
    });
    if (!formatted?.content) return false;
    const row = {
      ...formatted,
      final: Boolean(final),
      transient: !final
    };
    const fullReplyMessages = this.turn.fullReplyMessages || (this.turn.fullReplyMessages = new Map());
    fullReplyMessages.set(row.messageId, row);
    this.emit({ type: "cli_message", ...row });
    return true;
  }

  updateFullItemFromDelta(method, params = {}) {
    if (!this.turn) return false;
    const fallbackType = method.includes("/reasoning/")
      ? "reasoning"
      : method.includes("/commandExecution/")
        ? "commandExecution"
        : method.includes("/fileChange/")
          ? "fileChange"
          : method.includes("/mcpToolCall/")
            ? "mcpToolCall"
            : method.includes("/plan/")
              ? "plan"
              : "";
    if (!fallbackType) return false;
    const item = this.currentFullItem(params.itemId, fallbackType);
    if (!item) return false;
    if (method === "item/reasoning/summaryPartAdded") {
      item.summary = [...(item.summary || [])];
      if (item.summary[params.summaryIndex] === undefined) item.summary[params.summaryIndex] = "";
    } else if (method === "item/reasoning/summaryTextDelta") {
      item.summary = [...(item.summary || [])];
      const index = Number(params.summaryIndex) || 0;
      item.summary[index] = this.appendFullItemText(item.summary[index], params.delta);
    } else if (method === "item/reasoning/textDelta") {
      item.content = [...(item.content || [])];
      const index = Number(params.contentIndex) || 0;
      item.content[index] = this.appendFullItemText(item.content[index], params.delta);
    } else if (method === "item/commandExecution/outputDelta") {
      item.aggregatedOutput = this.appendFullItemText(item.aggregatedOutput, params.delta);
    } else if (method === "item/fileChange/outputDelta") {
      item.output = this.appendFullItemText(item.output, params.delta);
    } else if (method === "item/fileChange/patchUpdated") {
      item.changes = Array.isArray(params.changes) ? params.changes : item.changes;
    } else if (method === "item/mcpToolCall/progress") {
      item.progress = this.appendFullItemText(item.progress, `${params.message || ""}\n`);
    } else if (method === "item/plan/delta") {
      item.text = this.appendFullItemText(item.text, params.delta);
    } else {
      return false;
    }
    this.emitFullItem(item, false);
    return true;
  }

  dispatchThreadSettingsUpdate(params = {}) {
    if (!params.threadId || !params.threadSettings || typeof params.threadSettings !== "object") return false;
    const update = {
      threadId: String(params.threadId),
      model: String(params.threadSettings.model || ""),
      reasoningEffort: normalizeReasoningEffort(params.threadSettings.effort),
      cwd: String(params.threadSettings.cwd || ""),
      updatedAt: new Date().toISOString(),
      source: "app-server"
    };
    if (Object.prototype.hasOwnProperty.call(params.threadSettings, "serviceTier")) {
      update.serviceTier = params.threadSettings.serviceTier === null
        ? null
        : String(params.threadSettings.serviceTier || "");
    }
    const waiters = this.threadSettingsWaiters.get(update.threadId);
    if (waiters) {
      for (const waiter of [...waiters]) {
        if (waiter.matches(update)) waiter.finish(update);
      }
    }
    try {
      const pending = this.onThreadSettingsUpdate?.(update);
      if (pending && typeof pending.catch === "function") {
        pending.catch((error) => console.error("failed to handle thread settings update", error));
      }
    } catch (error) {
      console.error("failed to handle thread settings update", error);
    }
    return true;
  }

  waitForThreadSettingsUpdate(threadId, predicate = () => true, timeoutMs = 5000) {
    if (typeof predicate === "number") {
      timeoutMs = predicate;
      predicate = () => true;
    }
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const waiter = {
      matches: (update) => {
        try { return predicate(update); }
        catch { return false; }
      },
      finish: (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.threadSettingsWaiters.get(threadId);
        if (waiters) {
          waiters.delete(waiter);
          if (!waiters.size) this.threadSettingsWaiters.delete(threadId);
        }
        resolvePromise(value);
      }
    };
    const timer = setTimeout(() => waiter.finish(null), timeoutMs);
    const waiters = this.threadSettingsWaiters.get(threadId) || new Set();
    waiters.add(waiter);
    this.threadSettingsWaiters.set(threadId, waiters);
    return { promise, cancel: () => waiter.finish(null) };
  }

  onNotification(message) {
    for (const listener of [...this.notificationListeners]) {
      try {
        const pending = listener(message);
        if (pending && typeof pending.catch === "function") {
          pending.catch((error) => console.error("raw Codex notification listener failed", error));
        }
      } catch (error) {
        console.error("raw Codex notification listener failed", error);
      }
    }
    const method = message.method;
    const params = message.params || {};
    const payload = params.payload || params.event || params;
    if (method === "thread/settings/updated") this.dispatchThreadSettingsUpdate(params);
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
    if (notificationMatchesTurn && this.updateContextUsage(payload)) {
      // A runner's onContextUpdate callback emits a complete status payload.
      // Do not emit a second, incomplete status event: the browser would read
      // its missing `running` field as false and appear to end the task.
      return;
    }
    if (method === "thread/status/changed" || method === "turn/started") return;
    if (notificationMatchesTurn && this.updateFullItemFromDelta(method, params)) return;
    if (method === "item/started" && params.item?.type) {
      if (params.item.type === "agentMessage" && notificationMatchesTurn) {
        this.turn.currentMessage = {
          id: params.item.id || `assistant-${Date.now()}`,
          text: "",
          phase: params.item.phase || null
        };
      } else if (notificationMatchesTurn) {
        const item = this.rememberFullItem(params.item);
        if (item) this.emitFullItem(item, false, params.startedAtMs);
      }
      return;
    }
    if (method === "item/agentMessage/delta" && notificationMatchesTurn) {
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
    if (method === "item/completed" && params.item?.type === "agentMessage" && notificationMatchesTurn) {
      const messageId = params.item.id || this.turn.currentMessage?.id || `assistant-${Date.now()}`;
      const completedMessageIds = this.turn.completedMessageIds
        || (this.turn.completedMessageIds = new Set());
      if (completedMessageIds.has(messageId)) return;
      const text = params.item.text || this.turn.currentMessage?.text || "";
      const phase = params.item.phase || this.turn.currentMessage?.phase || null;
      if (text) {
        completedMessageIds.add(messageId);
        const content = assistantBubbleText(text, phase);
        const taskDurationMs = /^✅\s/.test(content) ? Math.max(0, Date.now() - this.turn.startedAtMs) : null;
        this.turn.answers.push(content);
        (this.turn.answerPhases || (this.turn.answerPhases = [])).push(phase);
        const answerMessages = this.turn.answerMessages || (this.turn.answerMessages = []);
        answerMessages.push({ content, messageId, final: true, taskDurationMs });
        this.emit({ type: "message", role: "assistant", content, messageId, final: true, taskDurationMs });
        this.emit({ type: "reply_done" });
      }
      this.turn.currentMessage = null;
      return;
    }
    if (method === "item/completed" && params.item?.type === "image_generation_call" && notificationMatchesTurn) {
      const turn = this.turn;
      const imageId = params.item.id || `image-${Date.now()}`;
      if (turn.imageIds.has(imageId)) return;
      turn.imageIds.add(imageId);
      const pending = saveGeneratedImage(params.item, turn.threadId)
        .then((file) => {
          if (!file) return;
          const content = assistantBubbleText(file, "final_answer");
          turn.answers.push(content);
          const answerMessages = turn.answerMessages || (turn.answerMessages = []);
          answerMessages.push({ content, messageId: imageId, final: true });
          this.emit({ type: "message", role: "assistant", content, messageId: imageId, final: true });
          this.emit({ type: "reply_done" });
        })
        .catch((error) => console.error("failed to save generated image", error));
      turn.pendingImages.push(pending);
      return;
    }
    if (method === "item/completed"
      && params.item?.type
      && !["agentMessage", "image_generation_call"].includes(params.item.type)
      && notificationMatchesTurn) {
      const item = this.rememberFullItem(params.item);
      if (item) this.emitFullItem(item, true, params.completedAtMs);
      return;
    }
    if (method === "turn/completed" && notificationMatchesTurn) {
      const turn = this.turn;
      const status = params.turn?.status || "completed";
      if (status === "inProgress") return;
      Promise.allSettled(turn.pendingImages)
        .then(() => {
          const answers = turn.answers.length
            ? turn.answers
            : (turn.currentMessage?.text ? [assistantBubbleText(turn.currentMessage.text, turn.currentMessage.phase)] : []);
          if (this.turn === turn) this.turn = null;
          this.setTurnReconnecting(turn, false);
          if (status === "completed") {
            if (answers.length) {
              const lastIdx = answers.length - 1;
              const lastPhase = turn.answerPhases?.[lastIdx] || turn.currentMessage?.phase || null;
              if (lastPhase !== "commentary" && !/^✅\s/u.test(answers[lastIdx])) {
                answers[lastIdx] = answers[lastIdx].replace(/^[🤔]\s*/u, "✅ ");
                if (!/^✅\s/u.test(answers[lastIdx])) {
                  answers[lastIdx] = `✅ ${answers[lastIdx]}`;
                }
                if (turn.answerMessages && turn.answerMessages[lastIdx]) {
                  turn.answerMessages[lastIdx].content = answers[lastIdx];
                }
              }
            }
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

  request(method, params, onResult = null, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求 ${method} 超时。`));
      }, timeoutMs) : null;
      const finishResolve = (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const finishReject = (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      };
      this.pending.set(id, { resolve: finishResolve, reject: finishReject, onResult });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        finishReject(error);
      }
    });
  }

  async resumeThreadWithProviderFallback(threadId, resolvedCwd, params = {}, fallbackSettings = {}) {
    const resumeParams = { ...params, threadId, cwd: resolvedCwd };
    try {
      return await this.request("thread/resume", resumeParams);
    } catch (error) {
      const missingProvider = missingModelProviderName(error);
      if (!missingProvider) throw error;

      const configured = await this.configuredModelSettings(resolvedCwd);
      const model = fallbackSettings.model || resumeParams.model || configured.model || "";
      const reasoningEffort = normalizeReasoningEffort(
        fallbackSettings.reasoningEffort
          || resumeParams.config?.model_reasoning_effort
          || configured.reasoningEffort
          || ""
      );
      const config = { ...(resumeParams.config || {}) };
      if (reasoningEffort) config.model_reasoning_effort = reasoningEffort;
      const retryParams = {
        ...resumeParams,
        model: model || undefined,
        modelProvider: configured.modelProvider || undefined,
        config: Object.values(config).some((value) => value !== undefined && value !== null && value !== "")
          ? config
          : undefined
      };
      if (!retryParams.model && !retryParams.modelProvider && !retryParams.config) throw error;

      console.warn(
        `会话 ${threadId} 引用了已移除的模型提供方 ${missingProvider}，正在使用当前提供方 ${configured.modelProvider || "(默认)"} 恢复。`
      );
      let result;
      if (retryParams.modelProvider) {
        try {
          result = await this.request("thread/resume", retryParams);
        } catch (retryError) {
          if (!retryParams.model || !rejectsModelProviderOverride(retryError)) throw retryError;
          const { modelProvider: _unsupported, ...modelOnlyParams } = retryParams;
          result = await this.request("thread/resume", modelOnlyParams);
        }
      } else {
        result = await this.request("thread/resume", retryParams);
      }

      if (configured.modelProvider && result?.modelProvider
        && result.modelProvider !== configured.modelProvider) {
        throw new Error(
          `旧会话仍在使用模型提供方 ${result.modelProvider}，当前提供方 ${configured.modelProvider} 的强制恢复未生效。请先结束该会话在其他 Codex 客户端中的运行后重试。`
        );
      }
      return result;
    }
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
      modelProvider: configured.modelProvider || undefined,
      config: { model_reasoning_effort: configured.reasoningEffort || undefined }
    };
    const result = threadId
      ? await this.resumeThreadWithProviderFallback(threadId, resolvedCwd, params, configured)
      : await this.request("thread/start", params);
    this.activeThreadId = result.thread.id;
    this.activeCwd = resolvedCwd;
    return this.activeThreadId;
  }

  async runTurn(message, state, options = {}) {
    if (this.settingsUpdatePromise) await this.settingsUpdatePromise.catch(() => {});
    if (this.turn) throw new Error("Codex 正在处理上一条消息。");
    this.turnStarting = true;
    try {
      const cwd = this.resolveCwd(state);
      const settings = {
        model: options.model || state.model || "",
        reasoningEffort: options.reasoningEffort || state.reasoningEffort || ""
      };
      state.threadId = await this.ensureThread(state.threadId, cwd, settings);
      if (typeof options.onConnected === "function") options.onConnected();
      if (typeof options.onThreadReady === "function") await options.onThreadReady(state);
      const running = new Promise((resolve, reject) => {
        const turn = {
          threadId: state.threadId,
          turnId: "",
          startedAtMs: Date.now(),
          answers: [],
          answerMessages: [],
          currentMessage: null,
          completedMessageIds: new Set(),
          imageIds: new Set(),
          pendingImages: [],
          fullItems: new Map(),
          fullReplyMessages: new Map(),
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
      this.turnStarting = false;
      return await running;
    } catch (error) {
      this.turnStarting = false;
      throw error;
    }
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
    const settings = {
      model: result?.config?.model || this.model || "",
      modelProvider: result?.config?.model_provider || result?.config?.modelProvider || "",
      reasoningEffort: result?.config?.model_reasoning_effort || this.reasoningEffort || ""
    };
    if (Object.prototype.hasOwnProperty.call(result?.config || {}, "service_tier")) {
      settings.serviceTier = result.config.service_tier;
    }
    return settings;
  }

  async modelOptions() {
    const result = await this.listModels();
    return withSupplementalModelOptions(result?.data);
  }

  async readThreadSettings(threadId, cwd = codexWorkDir, fallbackSettings = {}) {
    if (!threadId) return null;
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    const result = await this.resumeThreadWithProviderFallback(
      threadId,
      resolvedCwd,
      {},
      fallbackSettings
    );
    this.activeThreadId = result.thread.id;
    this.activeCwd = resolvedCwd;
    const settings = {
      model: result.model || "",
      reasoningEffort: result.reasoningEffort || ""
    };
    if (Object.prototype.hasOwnProperty.call(result || {}, "serviceTier")) {
      settings.serviceTier = result.serviceTier;
    }
    return settings;
  }

  async updateThreadModelSettings(update = {}) {
    const previous = this.settingsUpdatePromise;
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      if (this.turn || this.turnStarting) throw new Error("当前回合正在运行，请结束或中断后再切换模型设置。");
      return await this.applyThreadModelSettingsUpdate(update);
    })();
    this.settingsUpdatePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.settingsUpdatePromise === operation) this.settingsUpdatePromise = null;
    }
  }

  async applyThreadModelSettingsUpdate(update = {}) {
    const { model, effort, threadId = "", cwd = codexWorkDir } = update;
    const hasModel = Object.prototype.hasOwnProperty.call(update, "model") && Boolean(model);
    const hasEffort = Object.prototype.hasOwnProperty.call(update, "effort") && Boolean(effort);
    if (!threadId) return { model, effort };
    if (!hasModel && !hasEffort) throw new Error("请选择模型或思考强度。");
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    const current = await this.readThreadSettings(threadId, resolvedCwd, {
      model: hasModel ? String(model) : "",
      reasoningEffort: hasEffort ? normalizeReasoningEffort(effort) : ""
    });
    const desiredModel = hasModel ? String(model) : (current?.model || "");
    const desiredEffort = hasEffort
      ? normalizeReasoningEffort(effort)
      : normalizeReasoningEffort(current?.reasoningEffort || "");
    const matchesDesired = (settings = {}) => (
      (!hasModel || settings.model === desiredModel)
      && (!hasEffort || normalizeReasoningEffort(settings.reasoningEffort) === desiredEffort)
    );
    if (matchesDesired(current)) {
      return { model: current.model, effort: current.reasoningEffort };
    }

    const waiter = this.waitForThreadSettingsUpdate(threadId, matchesDesired);
    try {
      const params = { threadId };
      if (hasModel) params.model = desiredModel;
      if (hasEffort) params.effort = desiredEffort;
      await this.request("thread/settings/update", params);
      const notified = await waiter.promise;
      if (notified && matchesDesired(notified)) {
        return { model: notified.model, effort: notified.reasoningEffort };
      }
      const verified = await this.readThreadSettings(threadId, resolvedCwd);
      if (verified && matchesDesired(verified)) {
        return { model: verified.model, effort: verified.reasoningEffort };
      }
      throw new Error("Codex 没有确认模型设置已应用，请稍后重试。");
    } catch (error) {
      waiter.cancel();
      throw error;
    }
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
    const fallbackEffort = efforts.includes(currentEffort)
      ? currentEffort
      : (selected.defaultReasoningEffort || efforts[0] || currentEffort);
    const live = threadId ? await this.readThreadSettings(threadId, cwd, {
      model: selected.model || selected.id,
      reasoningEffort: fallbackEffort
    }) : null;
    const baseEffort = live?.reasoningEffort || currentEffort;
    const effort = efforts.includes(baseEffort)
      ? baseEffort
      : (selected.defaultReasoningEffort || efforts[0] || baseEffort);
    const patch = { model: selected.model || selected.id, threadId, cwd };
    if (effort !== baseEffort) patch.effort = effort;
    const applied = await this.updateThreadModelSettings(patch);
    const appliedEffort = applied.effort || effort;
    return {
      selected,
      model: applied.model || selected.model || selected.id,
      effort: appliedEffort,
      effortChanged: appliedEffort !== currentEffort
    };
  }

  async selectReasoningEffort(requestedEffort, currentModel = "", threadId = "", cwd = codexWorkDir) {
    const models = await this.modelOptions();
    const live = threadId ? await this.readThreadSettings(threadId, cwd, { model: currentModel }) : null;
    const liveModel = live?.model || currentModel;
    const selected = models.find((item) => [item.model, item.id].includes(liveModel))
      || models.find((item) => item.isDefault)
      || models[0];
    if (!selected) throw new Error("当前 Codex CLI 没有返回可用模型。");
    const wanted = normalizeReasoningEffort(requestedEffort);
    const option = (selected.supportedReasoningEfforts || []).find(
      (item) => String(item.reasoningEffort || "").toLowerCase() === wanted
    );
    if (!option) throw new Error(`模型 ${selected.model || selected.id} 不支持思考强度：${requestedEffort}`);
    const applied = await this.updateThreadModelSettings({
      effort: option.reasoningEffort,
      threadId,
      cwd
    });
    return {
      selected,
      model: applied.model || selected.model || selected.id,
      option: { ...option, reasoningEffort: applied.effort || option.reasoningEffort }
    };
  }

  async fastModeStatus(currentModel = "", threadId = "", cwd = codexWorkDir) {
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    const live = threadId
      ? await this.readThreadSettings(threadId, resolvedCwd, { model: currentModel })
      : null;
    const [configResult, models] = await Promise.all([
      this.readConfig(resolvedCwd),
      this.modelOptions()
    ]);
    const config = configResult?.config || {};
    const modelId = live?.model || currentModel || config.model || this.model || "";
    const wanted = String(modelId).trim().toLowerCase();
    const selected = models.find((item) =>
      [item?.model, item?.id].some((value) => String(value || "").trim().toLowerCase() === wanted)
    ) || null;
    const fastTier = fastServiceTierForModel(selected || {});
    const configuredServiceTier = config.service_tier ?? null;
    const hasLiveServiceTier = Boolean(live
      && Object.prototype.hasOwnProperty.call(live, "serviceTier"));
    const serviceTier = hasLiveServiceTier ? live.serviceTier : configuredServiceTier;
    const featureEnabled = config.features?.fast_mode !== false;
    return {
      model: selected?.model || selected?.id || modelId,
      supported: Boolean(featureEnabled && fastTier),
      featureEnabled,
      enabled: isFastServiceTier(serviceTier, fastTier),
      configuredEnabled: isFastServiceTier(configuredServiceTier, fastTier),
      serviceTier,
      configuredServiceTier,
      requestServiceTier: fastTier?.id || "",
      fastTier
    };
  }

  async updateThreadServiceTier(threadId, serviceTier, cwd = codexWorkDir) {
    if (!threadId) return serviceTier;
    await this.ensureStarted();
    const resolvedCwd = this.isRemote ? String(cwd || "") : projectPath(cwd || "");
    const desired = serviceTier === null ? null : String(serviceTier || "");
    const matchesDesired = (settings = {}) => (
      Object.prototype.hasOwnProperty.call(settings, "serviceTier")
      && normalizeServiceTier(settings.serviceTier) === normalizeServiceTier(desired)
    );
    const current = await this.readThreadSettings(threadId, resolvedCwd);
    if (matchesDesired(current)) return current.serviceTier;

    const waiter = this.waitForThreadSettingsUpdate(threadId, matchesDesired);
    try {
      await this.request("thread/settings/update", { threadId, serviceTier: desired });
      const notified = await waiter.promise;
      if (notified && matchesDesired(notified)) return notified.serviceTier;
      const verified = await this.readThreadSettings(threadId, resolvedCwd);
      if (verified && matchesDesired(verified)) return verified.serviceTier;
      throw new Error("Codex 没有确认 Fast 模式已应用，请稍后重试。");
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async setFastMode(enabled, currentModel = "", threadId = "", cwd = codexWorkDir) {
    const previous = this.settingsUpdatePromise;
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      if (this.turn || this.turnStarting) throw new Error("当前回合正在运行，请结束或中断后再切换 Fast 模式。");
      return await this.applyFastModeUpdate(Boolean(enabled), currentModel, threadId, cwd);
    })();
    this.settingsUpdatePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.settingsUpdatePromise === operation) this.settingsUpdatePromise = null;
    }
  }

  async applyFastModeUpdate(enabled, currentModel = "", threadId = "", cwd = codexWorkDir) {
    const before = await this.fastModeStatus(currentModel, threadId, cwd);
    if (enabled && !before.featureEnabled) {
      throw new Error("Codex 配置已禁用 `features.fast_mode`，无法开启 Fast 模式。");
    }
    if (enabled && !before.fastTier) {
      throw new Error(`当前模型 ${before.model || "(默认)"} 不提供 Fast 服务层。`);
    }

    const desiredConfigTier = enabled ? "fast" : null;
    const desiredThreadTier = enabled ? before.fastTier.id : null;
    const previousConfigTier = before.configuredServiceTier ?? null;
    let configWritten = false;
    try {
      await this.request("config/batchWrite", {
        edits: [{
          keyPath: "service_tier",
          value: desiredConfigTier,
          mergeStrategy: "upsert"
        }],
        reloadUserConfig: true
      });
      configWritten = true;
      if (threadId) await this.updateThreadServiceTier(threadId, desiredThreadTier, cwd);
    } catch (error) {
      if (configWritten) {
        await this.request("config/batchWrite", {
          edits: [{
            keyPath: "service_tier",
            value: previousConfigTier,
            mergeStrategy: "upsert"
          }],
          reloadUserConfig: true
        }).catch(() => {});
      }
      throw error;
    }
    return await this.fastModeStatus(currentModel, threadId, cwd);
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

  get usingSharedAppServer() {
    return Boolean(this.transport?.usingShared);
  }

  close() {
    const error = new Error("Codex app-server connection closed.");
    try { this.transport.kill?.(); } catch {}
    this.rejectAll(error);
    this.initialized = false;
    this.activeThreadId = "";
    this.activeCwd = "";
    this.notificationListeners.clear();
  }
}

export function createLocalAppServer(options = {}) {
  const realtime = Boolean(options.realtime);
  const transport = createLocalAppServerTransport({
    bin: codexBin,
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    cwd: codexWorkDir,
    env: process.env,
    extraArgs: realtime ? ["--enable", "realtime_conversation"] : [],
    // Callers can opt out of the shared daemon when a capability must be fixed
    // at process/thread load time (Live Voice does this for realtime).
    // FallbackTransport starts the same explicitly feature-enabled standalone
    // process whenever shared transport is disabled or unavailable.
    useShared: options.useShared !== false
  });
  return new CodexAppServer(transport, {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    isRemote: false,
    resolveCwd: (state = {}) => absoluteStateCwd(state),
    optOutNotificationMethods: realtime
      ? ["thread/realtime/outputAudio/delta"]
      : []
  });
}
