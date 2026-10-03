import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RemoteHosts, remoteThreadView, validateHost } from "../src/remote-hosts.js";
import { handleRemoteHostHttp } from "../src/remote-host-routes.js";

async function fixture(t) {
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
      if (method === "thread/list") result = { data: [thread], nextCursor: null };
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
  const handled = await handleRemoteHostHttp({ method: "GET" }, response, new URL(`http://localhost/api/remote/files?connectorId=${host.id}`), hosts);
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
