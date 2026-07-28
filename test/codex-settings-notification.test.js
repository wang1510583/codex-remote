import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex-server.js";

function settingsNotification(overrides = {}) {
  return {
    method: "thread/settings/updated",
    params: {
      threadId: "thread-1",
      threadSettings: {
        cwd: "/workspace/project",
        model: "gpt-5.6-sol",
        effort: "ultra",
        serviceTier: "priority",
        ...overrides
      }
    }
  };
}

test("thread settings notifications expose model and effort without an active turn", () => {
  const server = new CodexAppServer({});
  let received = null;
  server.onThreadSettingsUpdate = (settings) => { received = settings; };

  server.onNotification(settingsNotification());

  assert.equal(received.threadId, "thread-1");
  assert.equal(received.model, "gpt-5.6-sol");
  assert.equal(received.reasoningEffort, "ultra");
  assert.equal(received.serviceTier, "priority");
  assert.equal(received.cwd, "/workspace/project");
  assert.equal(received.source, "app-server");
  assert.ok(Number.isFinite(Date.parse(received.updatedAt)));
});

test("thread settings notifications are dispatched before context usage early return", () => {
  const server = new CodexAppServer({});
  let calls = 0;
  server.updateContextUsage = () => true;
  server.onThreadSettingsUpdate = () => { calls += 1; };

  server.onNotification(settingsNotification({ effort: "extra-high" }));

  assert.equal(calls, 1);
});

test("thread settings callback failures do not break notification processing", async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  try {
    const syncServer = new CodexAppServer({});
    syncServer.onThreadSettingsUpdate = () => { throw new Error("sync failure"); };
    assert.doesNotThrow(() => syncServer.onNotification(settingsNotification()));

    const asyncServer = new CodexAppServer({});
    asyncServer.onThreadSettingsUpdate = async () => { throw new Error("async failure"); };
    assert.doesNotThrow(() => asyncServer.onNotification(settingsNotification()));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(errors.length, 2);
    assert.match(errors[0][1].message, /sync failure/);
    assert.match(errors[1][1].message, /async failure/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("thread settings notifications resolve pending applied-setting waiters", async () => {
  const server = new CodexAppServer({});
  const waiter = server.waitForThreadSettingsUpdate("thread-1", 1000);

  server.onNotification(settingsNotification());

  const applied = await waiter.promise;
  assert.equal(applied.model, "gpt-5.6-sol");
  assert.equal(applied.reasoningEffort, "ultra");
  assert.equal(server.threadSettingsWaiters.size, 0);
});

test("shared app-server initialization failures retry on standalone transport", async () => {
  const transport = {
    alive: false,
    mode: "",
    onMessage() {},
    onError() {},
    onClose() {},
    async start() { this.alive = true; this.mode = "shared"; },
    async fallbackToStandalone() { this.mode = "standalone"; return true; }
  };
  const server = new CodexAppServer(transport);
  const modes = [];
  server.request = async (method) => {
    assert.equal(method, "initialize");
    modes.push(transport.mode);
    if (transport.mode === "shared") throw new Error("shared protocol mismatch");
    return {};
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await server.ensureStarted();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(modes, ["shared", "standalone"]);
  assert.equal(server.initialized, true);
});

test("concurrent callers share one app-server initialization", async () => {
  let initializeRequests = 0;
  const transport = {
    alive: false,
    mode: "shared",
    onMessage(cb) { this.message = cb; },
    onError() {},
    onClose() {},
    async start() { this.alive = true; },
    send(line) {
      const request = JSON.parse(line);
      initializeRequests += 1;
      setImmediate(() => this.message(JSON.stringify({ id: request.id, result: {} })));
    }
  };
  const server = new CodexAppServer(transport);

  await Promise.all(Array.from({ length: 20 }, () => server.ensureStarted()));

  assert.equal(initializeRequests, 1);
  assert.equal(server.pending.size, 0);
  assert.equal(server.initialized, true);
});

test("concurrent model setting mutations are serialized", async () => {
  const server = new CodexAppServer({});
  let active = 0;
  let maxActive = 0;
  const order = [];
  server.applyThreadModelSettingsUpdate = async ({ effort }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${effort}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end:${effort}`);
    active -= 1;
    return { model: "gpt-5.6-sol", effort };
  };

  await Promise.all([
    server.updateThreadModelSettings({ threadId: "thread-1", effort: "high" }),
    server.updateThreadModelSettings({ threadId: "thread-1", effort: "max" }),
    server.updateThreadModelSettings({ threadId: "thread-1", effort: "ultra" })
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    "start:high", "end:high",
    "start:max", "end:max",
    "start:ultra", "end:ultra"
  ]);
});
