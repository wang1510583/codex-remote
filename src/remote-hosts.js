import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, defaultMessageLimit, messagePageSize } from "./config.js";
import { readJsonFile, updateJsonFile } from "./json-file.js";
import { CodexAppServer } from "./codex-server.js";
import { RemoteWebSocketTransport } from "./transport/remote.js";
import { LocalTransport } from "./transport/local.js";
import { assistantBubbleText, fullReplyMessageFromThreadItem, limitFullReplyMessages } from "./threads.js";
import { broadcast, currentEventSeq } from "./sse.js";
import { mimeType } from "./utils.js";

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

export function remoteThreadView(thread = {}, { full = false, limit = defaultMessageLimit } = {}) {
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
        if (Array.isArray(item.questions) && item.questions.length) message.inputQuestions = item.questions;
      }
      if (message?.content) { messages.push(message); fullMessages.push(message); }
      else {
        const detail = fullReplyMessageFromThreadItem(item, { at, final: turn.status !== "inProgress" });
        if (detail) fullMessages.push(detail);
      }
    }
  }
  const activeTurn = (thread.turns || []).findLast((turn) => turn.status === "inProgress");
  let laterUserMessage = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") laterUserMessage = true;
    if (messages[index].inputQuestions) messages[index].inputResolved = laterUserMessage;
  }
  const running = thread.status?.type === "active" || Boolean(activeTurn);
  const visibleMessages = messages.slice(-limit);
  const fullStart = fullMessages.indexOf(visibleMessages[0]);
  const visibleFullMessages = fullStart >= 0 ? fullMessages.slice(fullStart) : fullMessages;
  return {
    threadId: thread.id, cwd: thread.cwd || "", absoluteCwd: thread.cwd || "",
    threadName: thread.name || "", model: thread.model || "", reasoningEffort: thread.reasoningEffort || "",
    ...(Object.hasOwn(thread, "serviceTier") ? { serviceTier: thread.serviceTier } : {}),
    messages: messages.slice(-limit), loadedCount: Math.min(messages.length, limit), messageCount: messages.length,
    hasMore: Boolean(thread.hasMore) || messages.length > limit,
    ...(full ? { fullMessages: limitFullReplyMessages(visibleFullMessages), fullMessageCount: visibleFullMessages.length } : {}),
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

const paginationUnsupported = (error) => /(?:thread\/(?:turns\/list|items\/list).*?(?:not supported|not implemented|unknown|method)|(?:unknown|unsupported|not found).*?thread\/(?:turns\/list|items\/list)|method.*?(?:not found|unknown|unsupported))/i.test(String(error?.message || error));

async function readPaginatedThread(server, threadId, limit = defaultMessageLimit) {
  const metadata = await server.request("thread/read", { threadId, includeTurns: false }, null, 15_000);
  const thread = { ...(metadata.thread || {}), turns: [] };
  let cursor = null;
  const cursors = new Set();
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    let page;
    try {
      page = await server.request("thread/turns/list", {
        threadId,
        cursor,
        limit: Math.min(100, Math.max(1, limit - thread.turns.length)),
        sortDirection: "desc",
        itemsView: "full"
      }, null, 60_000);
    } catch (error) {
      // A newly-created thread has metadata but no rollout yet. Preserve the
      // metadata so callers can still select, configure, or delete it.
      if (pageNumber === 0 && /not materialized yet; thread\/turns\/list is unavailable before first user message/i.test(error.message)) return { thread };
      throw error;
    }
    if (!Array.isArray(page.data)) throw new Error("thread/turns/list is not supported");
    for (const turn of page.data || []) {
      if (turn && typeof turn.id === "string") thread.turns.push(turn);
    }
    thread.hasMore = Boolean(page.nextCursor);
    if (!page.nextCursor || cursors.has(page.nextCursor) || thread.turns.length >= limit) break;
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  thread.turns.reverse();
  for (const turn of thread.turns) {
    if (turn.itemsView === "full") continue;
    const items = [];
    let itemCursor = null;
    const itemCursors = new Set();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await server.request("thread/items/list", {
        threadId,
        turnId: turn.id,
        cursor: itemCursor,
        limit: 100,
        sortDirection: "asc"
      }, null, 60_000);
      if (!Array.isArray(page.data)) throw new Error("thread/items/list is not supported");
      for (const entry of page.data) if (entry?.item) items.push(entry.item);
      if (!page.nextCursor || itemCursors.has(page.nextCursor)) break;
      itemCursors.add(page.nextCursor);
      itemCursor = page.nextCursor;
    }
    turn.items = items;
    turn.itemsView = "full";
  }
  return { thread };
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
    this.writers = new Map();
  }
  async hosts() { return readJsonFile(this.hostsFile, []); }
  async probe(host) {
    const existing = this.controls.get(host.id);
    const reuse = existing?.transport?.alive && existing.initialized;
    const server = reuse ? existing : this.serverFactory(host);
    let timer;
    try {
      await Promise.race([
        reuse ? server.request("thread/loaded/list", {}, null, 5000) : server.ensureStarted(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("probe timeout")), 6000); })
      ]);
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); if (!reuse) server.close(); }
  }
  async list() {
    const hosts = await this.hosts();
    return await Promise.all(hosts.map(async host => {
      const online = await this.probe(host);
      const { token, ...publicHost } = host;
      return { ...publicHost, hasToken: Boolean(token), online };
    }));
  }
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
    for (const [key, writer] of this.writers) if (key.startsWith(`${id}:`)) { writer.server.close(); this.writers.delete(key); }
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
  async files(id, directory = "") {
    return this.folders(id, directory, { includeFiles: true });
  }
  async file(id, filePath) {
    if (typeof filePath !== "string" || filePath.includes("\0") || !(path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath))) throw fail("请选择远端文件的绝对路径。");
    const server = await this.control(id);
    const metadata = await server.request("fs/getMetadata", { path: filePath });
    if (!metadata.isFile) throw fail("只能预览文件。");
    const result = await server.request("fs/readFile", { path: filePath });
    if (typeof result.dataBase64 !== "string") throw fail("远端返回了无效的文件内容。");
    const mime = mimeType(filePath);
    const isImage = /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime);
    const maxBytes = (isImage ? 8 : 1) * 1024 * 1024;
    if (result.dataBase64.length > Math.ceil(maxBytes / 3) * 4) throw fail(`文件超过 ${isImage ? 8 : 1}MB，无法预览。`);
    const buffer = Buffer.from(result.dataBase64, "base64");
    if (buffer.length > maxBytes) throw fail(`文件超过 ${isImage ? 8 : 1}MB，无法预览。`);
    if (isImage) return { type: "image", path: filePath, mime, url: `data:${mime};base64,${buffer.toString("base64")}` };
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (text.includes("\0")) throw new Error("binary");
    } catch { throw fail("该文件不是 UTF-8 文本或受支持的图片，无法预览。"); }
    return { type: "text", path: filePath, mime, text };
  }
  async folders(id, directory = "", { includeFiles = false } = {}) {
    const server = await this.control(id);
    if (!directory) {
      // Fixed commands only: directory names are never interpolated into a shell.
      const drives = await server.request("command/exec", {
        command: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root }) | ConvertTo-Json -Compress"],
        timeoutMs: 10000
      }).catch(() => null);
      if (drives?.exitCode === 0) {
        const parsed = JSON.parse(drives.stdout.replace(/^\uFEFF/, "").trim());
        const roots = (Array.isArray(parsed) ? parsed : [parsed]).filter(value => typeof value === "string" && path.win32.isAbsolute(value));
        if (roots.length) return { cwd: "", absoluteCwd: "此电脑", parent: null, selectable: false,
          entries: roots.map(root => ({ name: root, path: root, type: "dir" })) };
      }
      directory = "/";
    }
    if (typeof directory !== "string" || directory.includes("\0")) throw fail("目录路径无效。");
    const windows = /^[a-z]:[\\/]/i.test(directory) || directory.startsWith("\\\\");
    const paths = windows ? path.win32 : path.posix;
    if (!paths.isAbsolute(directory)) throw fail("请选择远端电脑的绝对路径。");
    const cwd = paths.normalize(directory);
    const result = await server.request("fs/readDirectory", { path: cwd });
    const entries = (result.entries || []).filter(item => (includeFiles || item.isDirectory)
      && typeof item.fileName === "string" && item.fileName !== "." && item.fileName !== ".."
      && !/[\\/]/.test(item.fileName)).map(item => ({ name: item.fileName, path: paths.join(cwd, item.fileName), type: item.isDirectory ? "dir" : "file" }));
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : a.type === "dir" ? -1 : 1);
    const parent = paths.dirname(cwd);
    return { cwd, absoluteCwd: cwd, parent: parent === cwd ? (windows ? "" : null) : parent, selectable: true, entries };
  }
  async threads(id) {
    const server = await this.control(id);
    const threads = [];
    let cursor = null;
    const seen = new Set();
    const cursors = new Set();
    do {
      // An omitted provider filter defaults to the remote CLI's current
      // provider, hiding conversations created before a provider switch.
      const result = await server.request("thread/list", { limit: 100, cursor, archived: false, sourceKinds: [], modelProviders: [] });
      for (const thread of result.data || []) {
        if (seen.has(thread.id) || (typeof thread.source === "object" && thread.source?.subAgent)) continue;
        seen.add(thread.id);
        threads.push({ threadId: thread.id, title: thread.name || thread.preview || "未命名会话", name: thread.name || "", cwd: thread.cwd || "", updatedAt: iso(thread.updatedAt), running: thread.status?.type === "active" || Boolean(this.runs.get(`${id}:${thread.id}`)?.running), connectorId: id });
      }
      if (!result.nextCursor || cursors.has(result.nextCursor)) { cursor = null; break; }
      cursor = result.nextCursor;
      cursors.add(cursor);
    } while (threads.length < 1000 && cursors.size < 10);
    for (const [key, writer] of this.writers) {
      if (key.startsWith(`${id}:`) && writer.fresh && !threads.some(t => t.threadId === writer.thread.id)) {
        threads.unshift({ threadId: writer.thread.id, title: "新会话", cwd: writer.thread.cwd, running: false, connectorId: id });
      }
    }
    return { threads, truncated: Boolean(cursor), connectorId: id };
  }
  async read(id, threadId, options = {}) {
    const writer = this.writers.get(`${id}:${threadId}`);
    const server = writer?.server || await this.control(id);
    // A cached writer can outlive a dropped SSH/WebSocket transport. Restart
    // the app-server connection before issuing the history request.
    await server.ensureStarted();
    let result;
    try {
      // Newer Codex app-servers keep history paginated. Asking thread/read to
      // hydrate every turn can block for minutes on a large Windows rollout.
      result = await readPaginatedThread(server, threadId, options.limit || defaultMessageLimit);
    } catch (error) {
      if (!paginationUnsupported(error)) {
        if (!writer?.fresh || !/thread not loaded|no rollout found/i.test(error.message)) throw error;
        result = { thread: { ...writer.thread, turns: [] } };
      } else {
        // Keep compatibility with older app-servers that predate the paging
        // methods. This path is deliberately bounded and is no longer used by
        // current remote Codex versions.
        try { result = await server.request("thread/read", { threadId, includeTurns: true }, null, 60_000); }
        catch (legacyError) {
          if (!writer?.fresh || !/thread not loaded|no rollout found|list_turns is not supported/i.test(legacyError.message)) throw legacyError;
          result = { thread: { ...writer.thread, turns: [] } };
        }
      }
    }
    return remoteThreadView(result.thread, options);
  }
  async state(id, options = {}) {
    const eventSeq = currentEventSeq();
    await this.host(id);
    const saved = await this.saved(id);
    const view = options.view || (saved.threadId ? await this.read(id, saved.threadId, { ...options, limit: options.limit || saved.historyLimit || defaultMessageLimit }) : { threadId: "", messages: [], running: false, followMode: "steer" });
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
  async select(id, threadId, options = {}) {
    if (!threadId || typeof threadId !== "string") throw fail("无效的会话 ID。");
    const view = await this.read(id, threadId, { ...options, limit: defaultMessageLimit });
    await this.save(id, { threadId, historyLimit: defaultMessageLimit });
    return this.state(id, { ...options, view });
  }
  async more(id, body, options = {}) {
    const saved = await this.saved(id);
    if (!saved.threadId || (body.threadId && body.threadId !== saved.threadId)) throw fail("会话已经切换，请重新点击加载更多。", 409);
    const limit = Math.min(10000, (saved.historyLimit || defaultMessageLimit) + messagePageSize);
    const view = await this.read(id, saved.threadId, { ...options, limit });
    await this.save(id, { historyLimit: limit });
    return this.state(id, { ...options, view });
  }
  async draft(id, body) {
    await updateJsonFile(this.stateFile, {}, (all) => {
      const saved = all[id] || {};
      all[id] = { ...saved, drafts: { ...saved.drafts, [String(body.threadId || "")]: String(body.text || "").slice(0, 30000) } };
      return all;
    });
    return { ok: true };
  }
  async createThread(id, body) {
    const cwd = String(body.cwd || "").trim();
    if (cwd.length > 4096 || !(path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd))) throw fail("请输入远端项目的绝对路径。");
    if (this.writers.size >= 32) throw fail("打开的远端会话过多，请关闭部分连接后重试。", 409);
    const server = this.serverFactory(await this.host(id));
    try {
      await server.ensureStarted();
      const created = await server.request("thread/start", { cwd });
      const thread = { ...created.thread, model: created.model || created.thread.model, reasoningEffort: created.reasoningEffort || created.thread.reasoningEffort };
      server.activeThreadId = thread.id;
      server.activeCwd = thread.cwd;
      this.writers.set(`${id}:${thread.id}`, { server, thread, fresh: true });
      await this.save(id, { threadId: thread.id });
      return this.state(id);
    } catch (error) { if (![...this.writers.values()].some(w => w.server === server)) server.close(); throw error; }
  }
  async updateModelSettings(id, body) {
    const threadId = (await this.saved(id)).threadId;
    if (!threadId) throw fail("请先选择远端会话。");
    if (body.threadId && body.threadId !== threadId) throw fail("会话已切换，请重新选择模型。", 409);
    const key = `${id}:${threadId}`;
    if (this.starting.has(key)) throw fail("会话正在操作，请稍后重试。", 409);
    this.starting.add(key);
    let temporary;
    try {
      const view = await this.read(id, threadId);
      if (view.running || this.runs.get(key)?.running) throw fail("请先结束或中断当前回合，再修改模型。", 409);
      const models = await (await this.control(id)).modelOptions();
      const model = String(body.model || "").trim();
      let effort = String(body.reasoningEffort || "").trim();
      if (!model && !effort) throw fail("请选择模型或思考强度。");
      const selected = models.find(m => [m.model, m.id].includes(model || view.model));
      if (!selected) throw fail("远端未返回该模型，请刷新模型列表。");
      const efforts = (selected.supportedReasoningEfforts || []).map(e => e.reasoningEffort);
      if (effort && !efforts.includes(effort)) throw fail("该模型不支持所选思考强度。");
      if (model && !effort && !efforts.includes(view.reasoningEffort)) effort = selected.defaultReasoningEffort || efforts[0] || "";
      const writer = this.writers.get(key);
      const server = writer?.server || (temporary = this.serverFactory(await this.host(id)));
      await server.ensureStarted();
      if (!writer) {
        await server.request("thread/resume", { threadId, excludeTurns: true });
      }
      const params = { threadId };
      if (model) params.model = selected.model || selected.id;
      if (effort) params.effort = effort;
      await server.request("thread/settings/update", params);
      const { thread } = await server.request("thread/read", { threadId, includeTurns: false });
      if ((params.model && thread.model !== params.model) || (params.effort && thread.reasoningEffort !== params.effort)) throw fail("远端尚未确认模型设置，请刷新后重试。", 409);
      if (writer) writer.thread = thread;
      return { ...view, model: thread.model || "", reasoningEffort: thread.reasoningEffort || "", models, ok: true };
    } catch (error) {
      if (/active writer/i.test(error.message)) throw fail("该会话正由远端 Codex 桌面端占用。请在那台电脑关闭此会话或退出 Codex 桌面端后重试；网页无法强行夺取写入锁。", 409);
      throw error;
    } finally { temporary?.close(); this.starting.delete(key); }
  }
  async deleteThread(id, threadId) {
    if (!threadId || typeof threadId !== "string") throw fail("无效的会话 ID。");
    const key = `${id}:${threadId}`;
    if (this.starting.has(key)) throw fail("会话正在操作，请稍后重试。", 409);
    this.starting.add(key);
    try {
      const view = await this.read(id, threadId);
      if (view.running || this.runs.get(key)?.running) throw fail("运行中的会话不能删除，请先中断。", 409);
      const writer = this.writers.get(key);
      const server = writer?.server || await this.control(id);
      await server.request("thread/delete", { threadId });
      writer?.server.close();
      this.writers.delete(key);
      this.runs.get(key)?.server.close();
      this.runs.delete(key);
      await updateJsonFile(this.stateFile, {}, all => {
        const saved = all[id];
        if (saved) { if (saved.threadId === threadId) saved.threadId = ""; if (saved.drafts) delete saved.drafts[threadId]; }
        return all;
      });
    } finally { this.starting.delete(key); }
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
      if (text.startsWith("/")) throw fail("远端会话目前支持普通消息和 /stop；模型可在模型设置中修改。");
      if (existing?.running || view.running) {
        if (body.followMode !== "steer") throw fail("远端任务正在运行，请使用引导发送或等待完成。", 409);
        if (existing?.running) await existing.server.steerCurrentTurn(text);
        else if (view.activeTurnId) await (await this.control(id)).request("turn/steer", { threadId, expectedTurnId: view.activeTurnId, input: [{ type: "text", text, text_elements: [] }] });
        else throw fail("远端任务正在运行，但尚未取得回合 ID，请稍后重试。", 409);
        await this.draft(id, { threadId, text: "" });
        return { ok: true, accepted: true, steered: true, threadId };
      }
      await this.draft(id, { threadId, text: "" });
      const writer = this.writers.get(key);
      if (!writer) existing?.server.close();
      const server = writer?.server || this.serverFactory(await this.host(id));
      if (writer) writer.fresh = false;
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
        if (!this.writers.has(key)) server.close();
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
    for (const writer of this.writers.values()) writer.server.close();
    for (const server of this.controls.values()) server.close();
    for (const run of this.runs.values()) run.server.close();
  }
}

export const remoteHosts = new RemoteHosts();
