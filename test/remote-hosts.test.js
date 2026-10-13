import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RemoteHosts, remoteThreadView, validateHost } from "../src/remote-hosts.js";
import { handleRemoteHostHttp } from "../src/remote-host-routes.js";

async function fixture(t, behavior = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-remote-hosts-"));
  const requests = [];
  const sockets = new Set();
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(ws, "listening");
  const thread = {
    id: "same-thread-id", cwd: "C:\\Users\\User\\project", name: "Windows 会话", updatedAt: 1700000000,
    status: { type: "idle" },
    turns: [{ id: "old-turn", status: "completed", items: [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "旧问题" }] },
      { type: "agentMessage", id: "a1", text: "旧回复", phase: "final_answer" }
    ] }]
  };
  let authorization;
  if (behavior.longHistory) thread.turns = Array.from({ length: 60 }, (_, index) => ({
    id: `turn-${index}`, status: "completed", items: [
      { type: "userMessage", id: `u-${index}`, content: [{ type: "text", text: `question-${index}` }] },
      { type: "agentMessage", id: `a-${index}`, text: `answer-${index}`, phase: "final_answer" }
    ]
  }));
  ws.on("connection", (socket, req) => {
    sockets.add(socket);
    authorization = req.headers.authorization;
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const request = JSON.parse(raw);
      requests.push(request);
      const { id, method, params } = request;
      if (!id) return;
      let result = {};
      if (behavior.unmaterialized && method === "thread/turns/list" && !thread.turns.length) {
        socket.send(JSON.stringify({ id, error: { code: -32600, message: `thread ${thread.id} is not materialized yet; thread/turns/list is unavailable before first user message` } })); return;
      }
      if (behavior.writerLocked && method === "thread/resume") {
        socket.send(JSON.stringify({ id, error: { code: -32600, message: "thread already has an active writer" } })); return;
      }
      if (behavior.emptyReadUnsupported && method === "thread/read" && params.includeTurns && !thread.turns.length) {
        socket.send(JSON.stringify({ id, error: { code: -32600, message: "list_turns is not supported yet" } })); return;
      }
      if (method === "thread/start") result = { thread };
      if (method === "model/list") result = { data: [
        { model: "remote-model", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], defaultReasoningEffort: "medium" },
        { model: "other-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }
      ] };
      if (method === "thread/settings/update") {
        if (params.model) thread.model = params.model;
        if (params.effort) thread.reasoningEffort = params.effort;
      }
      if (method === "thread/list") {
        const otherProviderThread = { ...thread, id: "other-provider-thread", modelProvider: "cli_proxy_api" };
        result = { data: behavior.multipleProviders && Array.isArray(params.modelProviders) && !params.modelProviders.length ? [thread, otherProviderThread] : [thread], nextCursor: null };
      }
      if (behavior.paginated && method === "thread/turns/list") {
        const ordered = params.sortDirection === "desc" ? [...thread.turns].reverse() : thread.turns;
        const offset = Number(params.cursor || 0);
        result = { data: ordered.slice(offset, offset + params.limit).map(turn => ({ ...turn, itemsView: "full" })), nextCursor: offset + params.limit < ordered.length ? String(offset + params.limit) : null };
      }
      if (method === "thread/read" || method === "thread/resume") result = { thread };
      if (method === "turn/start") result = { turn: { id: "new-turn" } };
      socket.send(JSON.stringify({ id, result }));
      if (method === "turn/start") {
        socket.send(JSON.stringify({ method: "item/completed", params: { threadId: params.threadId, turnId: "new-turn", item: { type: "agentMessage", id: "a2", text: "远端回复", phase: "final_answer" } } }));
        socket.send(JSON.stringify({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: "new-turn", status: "completed" } } }));
      }
    });
  });
  const events = [];
  const hosts = new RemoteHosts({ directory, emit: (event) => events.push(event) });
  t.after(async () => {
    hosts.close();
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const host = await hosts.add({ name: "Windows", url: `ws://127.0.0.1:${ws.address().port}`, token: "test-secret" });
  return { hosts, host, directory, requests, events, thread, sockets, authorization: () => authorization };
}

test("unmaterialized remote threads can be created, selected and deleted", async t => {
  const { hosts, host, thread, requests } = await fixture(t, { unmaterialized: true });
  thread.turns = [];
  const created = await hosts.createThread(host.id, { cwd: "C:\\project" });
  assert.equal(created.threadId, thread.id);
  assert.deepEqual(created.messages, []);
  assert.equal(created.cwd, thread.cwd);
  // Also handle empty threads found via another connection, without a fresh writer.
  hosts.writers.get(`${host.id}:${thread.id}`).server.close();
  hosts.writers.clear();
  assert.deepEqual((await hosts.select(host.id, thread.id)).messages, []);
  await hosts.deleteThread(host.id, thread.id);
  assert.ok(requests.some(r => r.method === "thread/delete"));
  assert.equal((await hosts.saved(host.id)).threadId, "");
  assert.equal(requests.some(r => r.method === "thread/read" && r.params.includeTurns), false);
});

test("remote thread list includes conversations from previous model providers", async t => {
  const { hosts, host } = await fixture(t, { multipleProviders: true });
  const list = await hosts.threads(host.id);
  assert.deepEqual(list.threads.map(thread => thread.threadId), ["same-thread-id", "other-provider-thread"]);
});

test("host validation rejects unsafe URLs and accepts SSH targets without shell commands", () => {
  for (const url of ["https://host", "ws://remote.example:4500", "wss://user:pass@host", "wss://host?token=x", "ssh://-oProxyCommand=bad", "ssh://user@host/command"]) {
    assert.throws(() => validateHost({ name: "test", url }));
  }
  const ssh = validateHost({ name: "公司", url: "ssh://User@100.106.210.18:2222" });
  assert.equal(ssh.target, "User@100.106.210.18");
  assert.equal(ssh.port, 2222);
  assert.equal(ssh.transport, "ssh");
  assert.equal(validateHost({ name: "alias", url: "ssh://windows-home" }).target, "windows-home");
  assert.equal(validateHost({ name: "alias", url: "ssh://阿里云" }).target, "阿里云");
  assert.equal(validateHost({ name: "alias", url: "ssh://windows-home" }).port, null);
});

test("remote host credentials stay server-side and the file is owner-readable only", async (t) => {
  const { hosts, host, directory } = await fixture(t);
  const listed = await hosts.list();
  assert.equal(listed[0].hasToken, true);
  assert.equal(JSON.stringify(listed).includes("test-secret"), false);
  assert.equal(JSON.stringify(host).includes("test-secret"), false);
  assert.equal((await stat(path.join(directory, "remote-hosts.json"))).mode & 0o777, 0o600);
});

test("real WebSocket RPC lists and reads remote threads and isolates identical IDs across hosts", async (t) => {
  const { hosts, host, authorization } = await fixture(t);
  const second = await hosts.add({ name: "second", url: host.url });
  const list = await hosts.threads(host.id);
  assert.equal(authorization(), "Bearer test-secret");
  assert.equal(list.threads[0].cwd, "C:\\Users\\User\\project");
  await hosts.select(host.id, "same-thread-id");
  await hosts.draft(host.id, { threadId: "same-thread-id", text: "第一台电脑的草稿" });
  assert.equal((await hosts.state(second.id)).threadId, "");
  await hosts.select(second.id, "same-thread-id");
  assert.equal((await hosts.state(second.id)).draft, "");
  const state = await hosts.state(host.id);
  assert.equal(state.messages.length, 2);
  assert.equal(state.draft, "第一台电脑的草稿");
  assert.equal(state.connectorId, host.id);
});

test("remote history uses paginated turns without full thread hydration", async (t) => {
  const { hosts, host, requests } = await fixture(t, { paginated: true });
  await hosts.select(host.id, "same-thread-id");
  const state = await hosts.state(host.id);
  assert.equal(state.messages.length, 2);
  assert.ok(requests.some(request => request.method === "thread/turns/list"));
  assert.equal(requests.some(request => request.method === "thread/read" && request.params.includeTurns === true), false);
});
test("entering a remote thread loads one recent page once and more expands history", async t => {
  const { hosts, host, requests } = await fixture(t, { paginated: true, longHistory: true });
  const state = await hosts.select(host.id, "same-thread-id", { full: true });
  assert.equal(state.messages.length, 10);
  assert.equal(state.messages[0].content, "question-55");
  assert.equal(state.hasMore, true);
  assert.equal(state.fullMessages.length, 10);
  const pages = requests.filter(request => request.method === "thread/turns/list");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].params.limit, 10);
  assert.equal(pages[0].params.sortDirection, "desc");
  const more = await hosts.more(host.id, { threadId: "same-thread-id" });
  assert.equal(more.messages.length, 20);
  assert.equal(more.messages[0].content, "question-50");
  assert.equal((await hosts.state(host.id)).messages.length, 20);
  await assert.rejects(hosts.more(host.id, { threadId: "other" }), /会话已经切换/);
});

test("continuing a remote thread preserves its cwd and permissions and scopes streaming events", async (t) => {
  const { hosts, host, requests, events } = await fixture(t);
  await hosts.select(host.id, "same-thread-id");
  const response = await hosts.send(host.id, { threadId: "same-thread-id", message: "继续" });
  assert.equal(response.accepted, true);
  const run = hosts.runs.get(`${host.id}:same-thread-id`);
  await run.done;
  const resume = requests.find((request) => request.method === "thread/resume");
  assert.deepEqual(resume.params, { threadId: "same-thread-id" });
  const turn = requests.find((request) => request.method === "turn/start");
  assert.equal(turn.params.cwd, "C:\\Users\\User\\project");
  assert.equal(turn.params.approvalPolicy, undefined);
  assert.equal(turn.params.input[0].text, "继续");
  assert.ok(events.some((event) => event.type === "message" && event.content.includes("远端回复")));
  assert.ok(events.every((event) => event.connectorId === host.id && event.threadId === "same-thread-id"));
  assert.equal(run.running, false);
  assert.equal(events.at(-1).type, "status");
  assert.equal(events.at(-1).running, false);
});

test("a stale browser cannot send to a newly selected remote thread", async (t) => {
  const { hosts, host, requests } = await fixture(t);
  await hosts.select(host.id, "same-thread-id");
  await assert.rejects(hosts.send(host.id, { threadId: "other-thread", message: "hello" }), /会话已切换/);
  assert.equal(requests.some((request) => request.method === "turn/start"), false);
});

test("remote history renders images, tools and busy state without reading local paths", () => {
  const state = remoteThreadView({ id: "t", status: { type: "active" }, turns: [{ id: "turn", status: "inProgress", items: [
    { type: "userMessage", content: [{ type: "localImage", path: "C:\\private.png" }] },
    { type: "commandExecution", id: "cmd", command: "dir", aggregatedOutput: "hello", exitCode: 0 }
  ] }] }, { full: true });
  assert.equal(state.running, true);
  assert.equal(state.activeTurnId, "turn");
  assert.equal(state.messages[0].content, "[图片]");
  assert.equal(state.fullMessages.length, 2);
  assert.deepEqual(state.fileLinkRoots, []);
});

test("unsupported or missing remote host requests never fall through to local handlers", async (t) => {
  const { hosts, host } = await fixture(t);
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const handled = await handleRemoteHostHttp({ method: "GET" }, response, new URL(`http://localhost/api/remote/project-download?connectorId=${host.id}`), hosts);
  assert.equal(handled, true);
  assert.equal(response.status, 400);
  await assert.rejects(handleRemoteHostHttp({ method: "GET" }, response, new URL("http://localhost/api/remote/state?connectorId=missing"), hosts), /找不到/);
});

test("removing a connection cleans its selection but does not delete remote conversations", async (t) => {
  const { hosts, host, requests, directory } = await fixture(t);
  await hosts.select(host.id, "same-thread-id");
  await hosts.remove(host.id);
  assert.deepEqual(await hosts.list(), []);
  assert.equal(requests.some((request) => request.method === "thread/delete"), false);
  const saved = JSON.parse(await readFile(path.join(directory, "remote-host-state.json"), "utf8"));
  assert.equal(saved[host.id], undefined);
});

test("remote model settings read metadata without acquiring the desktop writer lock", async (t) => {
  const { hosts, host, requests, thread } = await fixture(t);
  Object.assign(thread, { model: "remote-model", reasoningEffort: "medium", serviceTier: null });
  await hosts.select(host.id, thread.id);
  const server = await hosts.control(host.id);
  server.readThreadSettings = async () => { throw new Error("thread already has an active writer"); };
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handleRemoteHostHttp({ method: "GET" }, response, new URL(`http://localhost/api/remote/model-settings?connectorId=${host.id}`), hosts);
  assert.equal(response.status, 200);
  assert.equal(response.body.model, "remote-model");
  assert.equal(response.body.reasoningEffort, "medium");
  assert.equal(response.body.serviceTier, null);
  assert.ok(requests.some(r => r.method === "model/list"));
  assert.equal(requests.some(r => r.method === "thread/resume" || r.method === "config/read"), false);
  delete thread.model;
  delete thread.reasoningEffort;
  await handleRemoteHostHttp({ method: "GET" }, response, new URL(`http://localhost/api/remote/model-settings?connectorId=${host.id}`), hosts);
  assert.equal(response.body.model, "");
  assert.equal(response.body.reasoningEffort, "");
  assert.equal(requests.some(r => r.method === "thread/resume"), false);
});


test("remote settings validate catalog, update then verify without affecting another host", async t => {
  const { hosts, host, thread, requests } = await fixture(t);
  Object.assign(thread, { model: "remote-model", reasoningEffort: "medium" });
  await hosts.select(host.id, thread.id);
  await assert.rejects(hosts.updateModelSettings(host.id, { threadId: "stale", model: "other-model" }), /会话已切换/);
  await assert.rejects(hosts.updateModelSettings(host.id, { model: "unknown" }), /未返回该模型/);
  await assert.rejects(hosts.updateModelSettings(host.id, { reasoningEffort: "invalid" }), /不支持/);
  assert.equal(requests.some(r => r.method === "thread/settings/update"), false);
  const result = await hosts.updateModelSettings(host.id, { threadId: thread.id, model: "other-model" });
  assert.equal(result.model, "other-model");
  assert.equal(result.reasoningEffort, "high");
  const update = requests.find(r => r.method === "thread/settings/update");
  assert.deepEqual(update.params, { threadId: thread.id, model: "other-model", effort: "high" });
});

test("desktop writer lock is reported without changing settings or terminating desktop", async t => {
  const { hosts, host, thread, requests } = await fixture(t, { writerLocked: true });
  Object.assign(thread, { model: "remote-model", reasoningEffort: "medium" });
  await hosts.select(host.id, thread.id);
  await assert.rejects(hosts.updateModelSettings(host.id, { reasoningEffort: "high" }), e => e.statusCode === 409 && /桌面端占用/.test(e.message));
  assert.equal(requests.some(r => r.method === "thread/settings/update"), false);
  assert.equal(hosts.starting.size, 0);
});

test("new empty remote thread can be configured and deleted on its owning connection", async t => {
  const { hosts, host, thread, requests } = await fixture(t, { emptyReadUnsupported: true });
  Object.assign(thread, { model: "remote-model", reasoningEffort: "medium", turns: [] });
  await assert.rejects(hosts.createThread(host.id, { cwd: "relative/path" }), /绝对路径/);
  const created = await hosts.createThread(host.id, { cwd: "C:\\project" });
  assert.equal(created.threadId, thread.id);
  assert.deepEqual(created.messages, []);
  const writer = hosts.writers.get(`${host.id}:${thread.id}`);
  const result = await hosts.updateModelSettings(host.id, { threadId: thread.id, model: "other-model" });
  assert.equal(result.reasoningEffort, "high");
  assert.equal(requests.some(r => r.method === "thread/resume"), false);
  assert.equal(hosts.writers.get(`${host.id}:${thread.id}`), writer);
  await hosts.draft(host.id, { threadId: thread.id, text: "draft" });
  await hosts.deleteThread(host.id, thread.id);
  assert.equal(hosts.writers.size, 0);
  assert.equal((await hosts.saved(host.id)).threadId, "");
  assert.equal((await hosts.saved(host.id)).drafts[thread.id], undefined);
  assert.ok(requests.some(r => r.method === "thread/delete"));
});

test("reading a cached remote writer reinitializes a dropped transport", async t => {
  const { hosts, host, thread } = await fixture(t);
  const created = await hosts.createThread(host.id, { cwd: "C:\\project" });
  const writer = hosts.writers.get(`${host.id}:${created.threadId}`);
  let ensured = 0;
  const ensureStarted = writer.server.ensureStarted.bind(writer.server);
  writer.server.ensureStarted = async () => { ensured += 1; return ensureStarted(); };
  await hosts.read(host.id, thread.id);
  assert.equal(ensured, 1);
});

test("remote history reads use the extended timeout", async t => {
  const { hosts, host, thread } = await fixture(t);
  const created = await hosts.createThread(host.id, { cwd: "C:\\project" });
  const writer = hosts.writers.get(`${host.id}:${created.threadId}`);
  const calls = [];
  const original = writer.server.request.bind(writer.server);
  writer.server.request = async (...args) => { calls.push(args); return original(...args); };
  await hosts.read(host.id, thread.id);
  const read = calls.filter(([method]) => method === "thread/read").at(-1);
  assert.equal(read[3], 60_000);
});

test("running remote turns block settings and delete operations", async t => {
  const { hosts, host, thread, requests } = await fixture(t);
  thread.status.type = "active";
  await hosts.select(host.id, thread.id);
  await assert.rejects(hosts.updateModelSettings(host.id, { model: "other-model" }), /中断当前回合/);
  await assert.rejects(hosts.deleteThread(host.id, thread.id), /运行中的会话/);
  assert.equal(requests.some(r => ["thread/delete", "thread/settings/update"].includes(r.method)), false);
  assert.equal(hosts.starting.size, 0);
});

test("host list reports per-host connectivity and keeps authentication secrets private", async t => {
  const { hosts, host } = await fixture(t);
  const offline = await hosts.add({ name: "离线电脑", url: "wss://offline.example", token: "private-token" });
  const factory = hosts.serverFactory;
  let closed = false;
  hosts.serverFactory = h => h.id === offline.id ? {
    ensureStarted: async () => { assert.equal(h.token, "private-token"); throw Error("offline"); },
    close: () => { closed = true; }
  } : factory(h);
  const list = await hosts.list();
  assert.equal(list.find(h => h.id === host.id).online, true);
  assert.equal(list.find(h => h.id === offline.id).online, false);
  assert.equal(closed, true);
  assert.equal(JSON.stringify(list).includes("private-token"), false);
  assert.equal(JSON.stringify(list).includes("test-secret"), false);
});

test("refresh probes an existing connection without closing its controller", async t => {
  const { hosts, host, requests } = await fixture(t);
  const server = await hosts.control(host.id);
  assert.equal((await hosts.list())[0].online, true);
  assert.ok(requests.some(r => r.method === "thread/loaded/list"));
  assert.equal(server.transport.alive, true);
  const request = server.request.bind(server);
  server.request = async method => { throw Error("network lost"); };
  assert.equal((await hosts.list())[0].online, false);
  assert.equal(server.transport.alive, true);
  server.request = request;
});
