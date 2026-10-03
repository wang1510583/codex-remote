import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./config.js";
import { readJsonFile, updateJsonFile } from "./json-file.js";
import { CodexAppServer } from "./codex-server.js";
import { RemoteWebSocketTransport } from "./transport/remote.js";
import { LocalTransport } from "./transport/local.js";
import { assistantBubbleText, fullReplyMessageFromThreadItem, limitFullReplyMessages } from "./threads.js";
import { broadcast, currentEventSeq } from "./sse.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const iso = (seconds) => Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : "";

export function validateHost(input, id = randomUUID()) {
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw fail("请输入电脑名称。");
  let url;
  try { url = new URL(String(input.url || "")); } catch { throw fail("请输入有效的 Codex WebSocket 地址。"); }
  if (url.protocol === "ssh:") {
    const target = `${url.username ? `${decodeURIComponent(url.username)}@` : ""}${decodeURIComponent(url.hostname)}`;
    if (!/^[\p{L}\p{N}_.@-]+$/u.test(target) || target.startsWith("-") || url.password || url.hash || url.search || !["", "/"].includes(url.pathname)) {
      throw fail("SSH 地址应为 ssh://用户名@主机 或 ssh://SSH别名。");
    }
    const port = url.port ? Number(url.port) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw fail("SSH 端口无效。");
    return { id, name, url: url.toString(), transport: "ssh", target, port };
  }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw fail("连接地址必须使用 ws:// 或 wss://，认证令牌请单独填写。");
  }
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw fail("跨电脑直连请使用 wss://；SSH 隧道可使用 ws://127.0.0.1:端口。");
  }
  const token = String(input.token || "").trim();
  if (/[\r\n]/.test(token) || token.length > 8192) throw fail("认证令牌格式无效。");
  return { id, name, url: url.toString(), token };
}

export function remoteThreadView(thread = {}, { full = false, limit = 1000 } = {}) {
  const messages = [];
  const fullMessages = [];
  for (const turn of thread.turns || []) {
    const at = iso(turn.startedAt) || iso(thread.updatedAt);
    for (const item of turn.items || []) {
      let message;
      if (item.type === "userMessage") {
        const content = (item.content || []).map((part) => part.text || (part.type === "image" || part.type === "localImage" ? "[图片]" : "")).filter(Boolean).join("\n");
        message = { role: "user", content, at, messageId: item.id };
      } else if (item.type === "agentMessage") {
        message = { role: "assistant", content: assistantBubbleText(item.text || "", item.phase), at, messageId: item.id };
      }
      if (message?.content) { messages.push(message); fullMessages.push(message); }
      else {
        const detail = fullReplyMessageFromThreadItem(item, { at, final: turn.status !== "inProgress" });
        if (detail) fullMessages.push(detail);
      }
    }
  }
  const activeTurn = (thread.turns || []).findLast((turn) => turn.status === "inProgress");
  const running = thread.status?.type === "active" || Boolean(activeTurn);
  return {
    threadId: thread.id, cwd: thread.cwd || "", absoluteCwd: thread.cwd || "",
    threadName: thread.name || "", model: thread.model || "", reasoningEffort: "",
    messages: messages.slice(-limit), loadedCount: Math.min(messages.length, limit), messageCount: messages.length,
    ...(full ? { fullMessages: limitFullReplyMessages(fullMessages), fullMessageCount: fullMessages.length } : {}),
    running, externalRunning: running, activeTurnId: activeTurn?.id || "",
    updatedAt: iso(thread.updatedAt), fileLinkRoots: [],
    followMode: "steer", queueLength: 0, queueMessages: [], steerLength: 0, steerMessages: []
  };
}

function makeServer(host) {
  const transport = host.transport === "ssh"
    ? new LocalTransport({
      bin: "ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", ...(host.port ? ["-p", String(host.port)] : []), "--", host.target, "codex app-server --listen stdio://"],
      platform: "linux"
    })
    : new RemoteWebSocketTransport(host);
  const server = new CodexAppServer(transport, {
    isRemote: true, resolveCwd: (state) => state.cwd || ""
  });
  // Read/resume the existing remote thread without overriding its permissions,
  // provider or working directory with this web server's local configuration.
  server.ensureThread = async (threadId) => {
    await server.ensureStarted();
    if (!threadId) throw fail("请先选择远端会话。");
    if (server.activeThreadId !== threadId) {
      const result = await server.request("thread/resume", { threadId });
      server.activeThreadId = result.thread.id;
      server.activeCwd = result.thread.cwd || "";
    }
    return server.activeThreadId;
  };
  const request = server.request.bind(server);
  server.request = (method, params, onResult, timeout = 15000) => {
    // Preserve the remote thread's approval policy when continuing it.
    if (method === "turn/start") {
      const { approvalPolicy, ...rest } = params;
      params = rest;
    }
    return request(method, params, onResult, timeout);
  };
  return server;
}

export class RemoteHosts {
  constructor({ directory = dataDir, serverFactory = makeServer, emit = broadcast } = {}) {
    this.hostsFile = path.join(directory, "remote-hosts.json");
    this.stateFile = path.join(directory, "remote-host-state.json");
    this.serverFactory = serverFactory;
    this.emit = emit;
    this.controls = new Map();
    this.runs = new Map();
    this.starting = new Set();
  }
  async hosts() { return readJsonFile(this.hostsFile, []); }
  async list() { return (await this.hosts()).map(({ token, ...host }) => ({ ...host, hasToken: Boolean(token) })); }
  async host(id) {
    const host = (await this.hosts()).find((item) => item.id === id);
    if (!host) throw fail("找不到这台电脑，请重新选择。", 404);
    return host;
  }
  async add(input) {
    const host = validateHost(input);
    await updateJsonFile(this.hostsFile, [], (hosts) => {
      if (hosts.length >= 20) throw fail("最多配置 20 台远端电脑。");
      return [...hosts, host];
    });
    const { token, ...publicHost } = host;
    return publicHost;
  }
  async remove(id) {
    await this.host(id);
    if ([...this.runs.values()].some((run) => run.hostId === id && run.running) || [...this.starting].some((key) => key.startsWith(`${id}:`))) {
      throw fail("这台电脑还有任务运行，请结束后移除。", 409);
    }
    await updateJsonFile(this.hostsFile, [], (hosts) => hosts.filter((host) => host.id !== id));
    this.controls.get(id)?.close();
    this.controls.delete(id);
    for (const [key, run] of this.runs) if (run.hostId === id) { run.server.close(); this.runs.delete(key); }
    await updateJsonFile(this.stateFile, {}, (all) => { delete all[id]; return all; });
  }
  async control(id) {
    const host = await this.host(id);
    if (!this.controls.has(id)) {
      const server = this.serverFactory(host);
      server.runner = { connectorId: id, emit: () => {} };
      this.controls.set(id, server);
    }
    const server = this.controls.get(id);
    try { await server.ensureStarted(); return server; }
    catch (error) { server.close(); throw error; }
  }
  async saved(id) { return (await readJsonFile(this.stateFile, {}))[id] || { threadId: "", drafts: {} }; }
  async save(id, update) {
    await updateJsonFile(this.stateFile, {}, (all) => {
      all[id] = { ...(all[id] || {}), ...update };
      return all;
    });
  }
  approvals(id) {
    return [...this.runs.values()].filter((run) => run.hostId === id).flatMap((run) => run.server.pendingApprovalRequests());
  }
  async threads(id) {
    const server = await this.control(id);
    const threads = [];
    let cursor = null;
    const seen = new Set();
    const cursors = new Set();
    do {
      const result = await server.request("thread/list", { limit: 100, cursor, archived: false, sourceKinds: [] });
      for (const thread of result.data || []) {
        if (seen.has(thread.id) || (typeof thread.source === "object" && thread.source?.subAgent)) continue;
        seen.add(thread.id);
        threads.push({ threadId: thread.id, title: thread.name || thread.preview || "未命名会话", name: thread.name || "", cwd: thread.cwd || "", updatedAt: iso(thread.updatedAt), running: thread.status?.type === "active" || Boolean(this.runs.get(`${id}:${thread.id}`)?.running), connectorId: id });
      }
      if (!result.nextCursor || cursors.has(result.nextCursor)) { cursor = null; break; }
      cursor = result.nextCursor;
      cursors.add(cursor);
    } while (threads.length < 1000 && cursors.size < 10);
    return { threads, truncated: Boolean(cursor), connectorId: id };
  }
  async read(id, threadId, options = {}) {
    const server = await this.control(id);
    const result = await server.request("thread/read", { threadId, includeTurns: true });
    return remoteThreadView(result.thread, options);
  }
  async state(id, options = {}) {
    const eventSeq = currentEventSeq();
    await this.host(id);
    const saved = await this.saved(id);
    const view = saved.threadId ? await this.read(id, saved.threadId, options) : { threadId: "", messages: [], running: false, followMode: "steer" };
    const run = this.runs.get(`${id}:${saved.threadId}`);
    if (run?.running) {
      view.running = true;
      view.externalRunning = false;
      view.liveMessages = [...run.liveMessages.values()];
      view.inflight = { startedAt: run.startedAt };
      view.contextUsage = run.server.contextUsage;
    }
    if (run?.error) view.messages.push({ role: "assistant", content: run.error, taskFailed: true });
    return { ...view, connectorId: id, eventSeq, pendingApprovals: this.approvals(id), draft: saved.drafts?.[saved.threadId] || "" };
  }
  async select(id, threadId) {
    if (!threadId || typeof threadId !== "string") throw fail("无效的会话 ID。");
    await this.read(id, threadId);
    await this.save(id, { threadId });
    return this.state(id);
  }
  async draft(id, body) {
    await updateJsonFile(this.stateFile, {}, (all) => {
      const saved = all[id] || {};
      all[id] = { ...saved, drafts: { ...saved.drafts, [String(body.threadId || "")]: String(body.text || "").slice(0, 30000) } };
      return all;
    });
    return { ok: true };
  }
  async send(id, body) {
    const saved = await this.saved(id);
    const threadId = saved.threadId;
    if (!threadId) throw fail("请先选择远端会话。");
    if (body.threadId && body.threadId !== threadId) throw fail("会话已切换，请重新发送。", 409);
    const text = String(body.message || "").trim();
    if (!text || text.length > 30000) throw fail("消息为空或超过 30000 字符。");
    const key = `${id}:${threadId}`;
    if (this.starting.has(key)) throw fail("远端会话正在连接，请稍后再发。", 409);
    this.starting.add(key);
    try {
      const view = await this.read(id, threadId);
      const existing = this.runs.get(key);
      if (text === "/stop") {
        if (existing?.running) {
          if (!existing.server.turn?.turnId) throw fail("远端回合正在启动，请稍后再中断。", 409);
          await existing.server.interruptCurrentTurn();
        }
        else if (view.activeTurnId) await (await this.control(id)).request("turn/interrupt", { threadId, turnId: view.activeTurnId });
        else if (view.running) throw fail("尚未取得远端回合 ID，请在对应电脑中断或稍后重试。", 409);
        return { ok: true, accepted: true, threadId };
      }
      if (text.startsWith("/")) throw fail("远端会话目前支持普通消息和 /stop；模型可在模型设置中查看。");
      if (existing?.running || view.running) {
        if (body.followMode !== "steer") throw fail("远端任务正在运行，请使用引导发送或等待完成。", 409);
        if (existing?.running) await existing.server.steerCurrentTurn(text);
        else if (view.activeTurnId) await (await this.control(id)).request("turn/steer", { threadId, expectedTurnId: view.activeTurnId, input: [{ type: "text", text, text_elements: [] }] });
        else throw fail("远端任务正在运行，但尚未取得回合 ID，请稍后重试。", 409);
        await this.draft(id, { threadId, text: "" });
        return { ok: true, accepted: true, steered: true, threadId };
      }
      await this.draft(id, { threadId, text: "" });
      existing?.server.close();
      const server = this.serverFactory(await this.host(id));
      const run = { hostId: id, threadId, server, running: true, startedAt: new Date().toISOString(), liveMessages: new Map() };
      this.runs.set(key, run);
      const emit = (event) => {
        if (event.type === "message" && event.messageId) run.liveMessages.set(event.messageId, event);
        this.emit({ ...event, connectorId: id, threadId });
      };
      server.runner = { connectorId: id, emit };
      emit({ type: "message", role: "user", content: text });
      emit({ type: "status", running: true });
      run.done = server.runTurn(text, view).then(() => {
        run.running = false;
        emit({ type: "done", ok: true });
      }).catch((error) => {
        run.running = false;
        run.error = `❌ ${error.message}`;
        emit({ type: "message", role: "assistant", content: run.error, final: true, taskFailed: true, messageId: `remote-error-${Date.now()}` });
        emit({ type: "done", ok: false });
      }).finally(() => {
        emit({ type: "status", running: false, followMode: "steer", contextUsage: server.contextUsage });
        run.liveMessages.clear();
        server.close();
      });
      return { ok: true, accepted: true, threadId };
    } finally { this.starting.delete(key); }
  }
  async respond(id, body) {
    const run = [...this.runs.values()].find((run) => run.hostId === id && run.server.approvalScope === body.approvalScope && run.server.hasPendingServerRequest(body.requestId));
    if (!run) throw fail("审核请求已失效。", 409);
    return run.server.respondToApprovalRequest(body);
  }
  close() {
    for (const server of this.controls.values()) server.close();
    for (const run of this.runs.values()) run.server.close();
  }
}

export const remoteHosts = new RemoteHosts();
