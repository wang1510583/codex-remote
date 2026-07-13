import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  FallbackTransport, LocalTransport, UnixWebSocketTransport, createLocalAppServerTransport
} from "../src/transport/local.js";

class FakeTransport {
  constructor({ error = null } = {}) {
    this.error = error;
    this.started = 0;
    this.killed = 0;
    this.alive = false;
    this.sent = [];
  }

  async start() {
    this.started += 1;
    if (this.error) throw this.error;
    this.alive = true;
  }

  send(line) { this.sent.push(line); }
  onMessage(cb) { this.message = cb; }
  onError(cb) { this.errorHandler = cb; }
  onClose(cb) { this.closeHandler = cb; }
  kill() { this.killed += 1; this.alive = false; }
}

test("Unix WebSocket transport connects to the shared app-server socket", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-remote-ws-"));
  const socketPath = path.join(dir, "app-server.sock");
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
    await rm(dir, { recursive: true, force: true });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");
  wss.on("connection", (socket, request) => {
    assert.equal(request.headers["sec-websocket-extensions"], undefined);
    socket.on("message", (data) => socket.send(data.toString()));
  });

  const transport = new UnixWebSocketTransport({ socketPath, openTimeoutMs: 2000 });
  const received = new Promise((resolve) => transport.onMessage(resolve));
  await transport.start();
  assert.equal(transport.alive, true);
  transport.send('{"id":1,"method":"initialize"}');
  assert.equal(await received, '{"id":1,"method":"initialize"}');
  transport.kill();
  assert.equal(transport.alive, false);
});

test("fallback transport starts standalone when the shared socket is unavailable", async () => {
  const preferred = new FakeTransport({ error: new Error("missing socket") });
  const fallback = new FakeTransport();
  const errors = [];
  const transport = new FallbackTransport({
    preferred,
    fallback,
    onFallback: (error) => errors.push(error.message)
  });

  await transport.start();
  assert.equal(transport.mode, "standalone");
  assert.equal(transport.usingShared, false);
  assert.equal(preferred.started, 1);
  assert.equal(preferred.killed, 1);
  assert.equal(fallback.started, 1);
  assert.deepEqual(errors, ["missing socket"]);
});

test("a previous standalone child cannot clear a newly started child", async () => {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", 0));
    };
    children.push(child);
    return child;
  };
  const transport = new LocalTransport({ bin: "codex", spawnImpl, platform: "linux" });

  await transport.start();
  const first = transport.child;
  transport.kill();
  await transport.start();
  const second = transport.child;
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(first, second);
  assert.equal(transport.child, second);
  assert.equal(transport.alive, true);
  transport.kill();
});

test("standalone stdin errors are reported without crashing the controller", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const transport = new LocalTransport({
    bin: "codex",
    spawnImpl: () => child,
    platform: "linux"
  });
  let received = null;
  transport.onError((error) => { received = error; });

  await transport.start();
  child.stdin.emit("error", new Error("EPIPE"));

  assert.equal(received?.message, "EPIPE");
  transport.kill();
});

test("local app-server transport keeps standalone overrides as its fallback", () => {
  const transport = createLocalAppServerTransport({
    bin: "/opt/codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    cwd: "/workspace",
    env: { HOME: "/home/tester" }
  });

  assert.ok(transport instanceof FallbackTransport);
  assert.equal(
    transport.preferred.socketPath,
    "/home/tester/.codex/app-server-control/app-server-control.sock"
  );
  assert.deepEqual(transport.fallback.args, [
    "app-server", "--stdio",
    "-c", 'model="gpt-5.6-sol"',
    "-c", 'model_reasoning_effort="ultra"'
  ]);
});
