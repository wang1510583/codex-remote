import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import {
  isTrustedVoiceOrigin,
  isVoiceRequestAuthenticated
} from "../src/live-voice/auth.js";
import { LiveVoiceGateway } from "../src/live-voice/gateway.js";
import {
  acquireLiveVoiceThread,
  activeLiveVoiceThreadSnapshots,
  clearLiveVoiceThreadsForTest,
  interruptLiveVoiceThreadTask,
  isLiveVoiceThreadActive,
  liveVoiceThreadSnapshot,
  sendLiveVoiceThreadInput
} from "../src/live-voice/leases.js";
import { CodexLiveVoiceRuntime } from "../src/live-voice/runtime.js";
import { CodexRemoteThreadAdapter } from "../src/live-voice/thread-adapter.js";
import { mergePersistentLiveVoiceMessages } from "../src/runner.js";
import { LiveVoiceTicketStore } from "../src/live-voice/tickets.js";
import {
  codexLiveVoiceOrDefault,
  normalizeCodexLiveVoiceVoice
} from "../src/live-voice/voices.js";

afterEach(() => {
  clearLiveVoiceThreadsForTest();
});

function voiceHeaders(token = "secret") {
  return {
    authorization: `Basic ${Buffer.from(`android:${token}`).toString("base64")}`,
    origin: "https://voice.example.test",
    "sec-fetch-site": "same-origin"
  };
}

function requestJson(port, method, path, body, token = "secret") {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = import("node:http").then(({ request }) => request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        ...voiceHeaders(token),
        ...(payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload)
            }
          : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    }));
    req.then((value) => {
      value.on("error", reject);
      if (payload) value.write(payload);
      value.end();
    }, reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function nextSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.once("error", reject);
  });
}

test("Live Voice Basic auth and same-origin headers match the Android client", () => {
  const req = { headers: voiceHeaders() };
  assert.equal(isVoiceRequestAuthenticated(req, "secret"), true);
  assert.equal(isVoiceRequestAuthenticated(req, "wrong"), false);
  assert.equal(isTrustedVoiceOrigin(req), true);
  assert.equal(
    isTrustedVoiceOrigin({
      headers: { ...voiceHeaders(), "sec-fetch-site": "cross-site" }
    }),
    false
  );
});

test("Live Voice voice catalog normalizes supported ids and protects the default", () => {
  assert.equal(normalizeCodexLiveVoiceVoice("  EMBER "), "ember");
  assert.equal(normalizeCodexLiveVoiceVoice("unknown"), null);
  assert.equal(codexLiveVoiceOrDefault("unknown"), "cove");
});

test("Live Voice tickets are session-bound, one-time, and expiring", () => {
  let now = 1_000;
  let counter = 0;
  const tickets = new LiveVoiceTicketStore({
    ttlMs: 100,
    now: () => now,
    random: () => Buffer.from(`ticket-${++counter}`)
  });
  const first = tickets.issue("thread-a");
  assert.equal(tickets.consume("thread-b", first), false);
  assert.equal(tickets.consume("thread-a", first), false);

  const second = tickets.issue("thread-a");
  assert.equal(tickets.consume("thread-a", second), true);
  assert.equal(tickets.consume("thread-a", second), false);

  const expired = tickets.issue("thread-a");
  now += 101;
  assert.equal(tickets.consume("thread-a", expired), false);
});

test("thread adapter reuses the web-selected thread and creates only when empty", async () => {
  let state = {
    threadId: "",
    runtimeId: "new-runtime",
    connectorId: "",
    cwd: "",
    model: "",
    reasoningEffort: "",
    messages: [{ role: "user", content: "draft" }],
    inflight: null
  };
  let ensureCalls = 0;
  let closed = false;
  const adapter = new CodexRemoteThreadAdapter({
    readStateFn: async () => ({ ...state }),
    writeStateFn: async (next) => { state = { ...next }; },
    readViewStateFn: async () => ({ selectedConnectorId: "" }),
    appServerFactory: () => ({
      ensureThread: async (threadId) => {
        ensureCalls += 1;
        assert.equal(threadId, "");
        return "thread-created";
      },
      close: () => { closed = true; }
    }),
    runningThreadsFn: () => [],
    broadcastFn: () => {},
    localDisabled: false
  });

  assert.equal(await adapter.currentSession(), null);
  const created = await adapter.createSession();
  assert.equal(created.session_id, "thread-created");
  assert.equal(state.threadId, "thread-created");
  assert.deepEqual(state.messages, []);
  assert.equal(ensureCalls, 1);
  assert.equal(closed, true);

  const reused = await adapter.createSession();
  assert.equal(reused.session_id, "thread-created");
  assert.equal(ensureCalls, 1);
  assert.equal((await adapter.runtimeContext("thread-created")).threadId, "thread-created");
});

test("thread adapter restores completed bubbles from the web-selected Codex thread", async () => {
  const adapter = new CodexRemoteThreadAdapter({
    readStateFn: async () => ({
      threadId: "thread-web",
      connectorId: "",
      cwd: "/project",
      messages: [
        { role: "assistant", content: "✅ 已推送到主分支。", at: "2026-08-02T08:03:00.000Z" }
      ],
      inflight: null
    }),
    readViewStateFn: async () => ({ selectedConnectorId: "" }),
    runningThreadsFn: () => [],
    broadcastFn: () => {},
    loadThreadPageFn: async (threadId, connectorId) => {
      assert.equal(threadId, "thread-web");
      assert.equal(connectorId, "");
      return {
        messages: [
          { role: "user", content: "请修改安卓软件", at: "2026-08-02T08:00:00.000Z" },
          { role: "assistant", content: "🤔 正在构建", at: "2026-08-02T08:01:00.000Z" },
          { role: "assistant", content: "✅ 新的 APK 已生成。", at: "2026-08-02T08:02:00.000Z" },
          { role: "user", content: "<environment_context>hidden", at: "2026-08-02T08:02:30.000Z" }
        ]
      };
    },
    localDisabled: false
  });

  assert.deepEqual(await adapter.currentSessionConversation("thread-web"), [
    { role: "user", text: "请修改安卓软件", channel: "final" },
    { role: "assistant", text: "✅ 新的 APK 已生成。", channel: "final" },
    { role: "assistant", text: "✅ 已推送到主分支。", channel: "final" }
  ]);
});

test("thread selection restores persistent Live Voice bubbles without duplicates", () => {
  const voiceMessage = {
    role: "assistant",
    content: "语音对话：已经完成。",
    at: "2026-08-02T11:00:02.000Z",
    liveVoiceTranscript: true
  };
  const messages = mergePersistentLiveVoiceMessages([
    { role: "user", content: "普通消息", at: "2026-08-02T11:00:01.000Z" },
    voiceMessage
  ], [
    voiceMessage,
    {
      role: "user",
      content: "切回来还能看到吗",
      at: "2026-08-02T11:00:03.000Z",
      liveVoiceTranscript: true
    }
  ]);

  assert.deepEqual(messages.map((message) => message.content), [
    "普通消息",
    "语音对话：已经完成。",
    "语音对话：切回来还能看到吗"
  ]);
});

test("voice transcripts persist with their originating thread after the web switches away", async () => {
  let state = {
    threadId: "thread-other",
    connectorId: "",
    cwd: "/other-project",
    messages: [],
    inflight: null
  };
  const transcripts = new Map();
  const broadcasts = [];
  const adapter = new CodexRemoteThreadAdapter({
    readStateFn: async () => ({ ...state, messages: [...state.messages] }),
    writeStateFn: async (next) => { state = { ...next, messages: [...next.messages] }; },
    readViewStateFn: async () => ({ selectedConnectorId: "" }),
    runningThreadsFn: () => [],
    broadcastFn: (event) => broadcasts.push(event),
    loadThreadPageFn: async () => ({ messages: [] }),
    appendLiveVoiceTranscriptFn: async (threadId, message) => {
      const rows = transcripts.get(threadId) || [];
      if (rows.at(-1)?.role === message.role && rows.at(-1)?.content === message.content) {
        return { added: false, message: rows.at(-1) };
      }
      rows.push(message);
      transcripts.set(threadId, rows);
      return { added: true, message };
    },
    readLiveVoiceTranscriptsFn: async (threadId) => transcripts.get(threadId) || [],
    localDisabled: false
  });

  await adapter.recordLiveVoiceTranscript("thread-voice", "assistant", "我已经完成修改。");
  assert.deepEqual(state.messages, []);
  assert.equal(broadcasts.length, 0);

  state = { ...state, threadId: "thread-voice", cwd: "/voice-project" };
  assert.deepEqual(await adapter.currentSessionConversation("thread-voice"), [
    {
      role: "assistant",
      text: "语音对话：我已经完成修改。",
      channel: "final"
    }
  ]);
});

test("an active Live Voice session can obtain a reconnect ticket after the web switches threads", async () => {
  const lease = acquireLiveVoiceThread("thread-speaking");
  lease.update({ cwd: "/speaking", connected: false, taskRunning: true });
  const adapter = new CodexRemoteThreadAdapter({
    readStateFn: async () => ({
      threadId: "thread-now-selected",
      connectorId: "",
      cwd: "/selected",
      messages: [],
      inflight: null
    }),
    readViewStateFn: async () => ({ selectedConnectorId: "remote-device" }),
    runningThreadsFn: () => [],
    broadcastFn: () => {},
    localDisabled: false
  });

  assert.equal(
    (await adapter.getSession("thread-speaking")).session_id,
    "thread-speaking"
  );
  assert.equal(
    (await adapter.setCurrentSession("thread-speaking")).cwd,
    "/speaking"
  );
  await assert.rejects(
    () => adapter.getSession("thread-unknown"),
    /当前网页选择的是被控端/
  );
  lease.release();
});

test("Live Voice lease exposes ownership and routes web input to its controller", async () => {
  const delivered = [];
  let interrupted = 0;
  const lease = acquireLiveVoiceThread("thread-owned", { source: "test" });
  assert.ok(lease);
  lease.update({
    cwd: "/workspace",
    connected: true,
    realtimeActive: true,
    taskRunning: true,
    turnId: "turn-owned"
  });
  lease.setController({
    sendText: async (text, options) => {
      delivered.push({ text, options });
      return { mode: "steer" };
    },
    interruptTask: async () => {
      interrupted += 1;
      return true;
    }
  });

  assert.equal(acquireLiveVoiceThread("thread-owned"), null);
  assert.deepEqual(liveVoiceThreadSnapshot("thread-owned"), {
    threadId: "thread-owned",
    acquiredAt: lease.snapshot().acquiredAt,
    updatedAt: lease.snapshot().updatedAt,
    cwd: "/workspace",
    connected: true,
    realtimeActive: true,
    taskRunning: true,
    turnId: "turn-owned",
    detachedAt: "",
    explicitStop: false
  });
  assert.equal(activeLiveVoiceThreadSnapshots().length, 1);
  assert.deepEqual(
    await sendLiveVoiceThreadInput("thread-owned", "继续执行", { followMode: "steer" }),
    { mode: "steer" }
  );
  assert.deepEqual(delivered, [{
    text: "继续执行",
    options: { followMode: "steer" }
  }]);
  assert.equal(await interruptLiveVoiceThreadTask("thread-owned"), true);
  assert.equal(interrupted, 1);

  lease.release();
  assert.equal(isLiveVoiceThreadActive("thread-owned"), false);
});

test("Realtime runtime keeps one app-server while audio reconnects and a task continues", async () => {
  let notification;
  let closed = false;
  let unsubscribed = false;
  let ensureCalls = 0;
  const calls = [];
  const events = [];
  const appServer = {
    onRawNotification(listener) {
      notification = listener;
      return () => {
        unsubscribed = true;
        notification = null;
      };
    },
    async ensureThread(threadId, cwd, settings) {
      ensureCalls += 1;
      calls.push({ method: "ensureThread", threadId, cwd, settings });
      return threadId;
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/realtime/start") {
        queueMicrotask(() => {
          notification({
            method: "thread/realtime/sdp",
            params: { sdp: "answer-sdp" }
          });
        });
      }
      return {};
    },
    close() {
      closed = true;
    }
  };
  const runtime = new CodexLiveVoiceRuntime({
    threadId: "thread-existing",
    cwd: "/workspace",
    model: "model-current",
    reasoningEffort: "high",
    voice: "cove",
    onEvent: (event) => events.push(event),
    appServerFactory: () => appServer
  });

  const androidOffer = [
    "v=0",
    "o=- 123 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    ""
  ].join("\r\n");
  assert.equal(await runtime.start(androidOffer), "answer-sdp");
  const start = calls.find((call) => call.method === "thread/realtime/start");
  assert.equal(start.params.threadId, "thread-existing");
  assert.equal(start.params.includeStartupContext, true);
  assert.equal(
    start.params.transport.sdp,
    androidOffer,
    "Android SDP must retain its final CRLF when forwarded to Codex"
  );
  assert.equal(start.params.voice, "cove");
  assert.equal(ensureCalls, 1);

  notification({
    method: "thread/realtime/transcript/done",
    params: { role: "user", text: "继续之前的任务" }
  });
  assert.deepEqual(events.at(-1), {
    type: "transcript.done",
    role: "user",
    text: "继续之前的任务"
  });

  notification({
    method: "turn/started",
    params: {
      threadId: "thread-someone-else",
      turn: { id: "turn-foreign" }
    }
  });
  assert.equal(runtime.status().taskRunning, false);

  notification({
    method: "turn/started",
    params: {
      threadId: "thread-existing",
      turn: { id: "turn-live" }
    }
  });
  assert.deepEqual(runtime.status(), {
    realtimeActive: true,
    taskRunning: true,
    turnId: "turn-live"
  });

  await runtime.stopRealtime();
  assert.equal(closed, false, "stopping audio must not close the app-server");
  assert.equal(unsubscribed, false);
  assert.equal(runtime.status().taskRunning, true);

  const delivery = await runtime.appendText("继续检查测试");
  assert.equal(delivery.mode, "steer");
  assert.equal(
    calls.some((call) => call.method === "turn/steer"
      && call.params.turnId === "turn-live"
      && call.params.input[0].text === "继续检查测试"),
    true
  );

  assert.equal(await runtime.start("offer-sdp-2", { voice: "ember" }), "answer-sdp");
  assert.equal(ensureCalls, 1, "audio reconnect must reuse the same app-server connection");
  const starts = calls.filter((call) => call.method === "thread/realtime/start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.transport.sdp, "offer-sdp-2");
  assert.equal(starts[1].params.voice, "ember");

  notification({
    method: "turn/completed",
    params: {
      threadId: "thread-existing",
      turn: { id: "turn-foreign", status: "completed" }
    }
  });
  assert.equal(runtime.status().taskRunning, true);

  notification({
    method: "turn/completed",
    params: {
      threadId: "thread-existing",
      turn: { id: "turn-live", status: "completed" }
    }
  });
  assert.equal(runtime.status().taskRunning, false);

  await runtime.stop();
  assert.equal(closed, true);
  assert.equal(unsubscribed, true);
  assert.equal(
    calls.some((call) => call.method === "thread/realtime/stop"),
    true
  );
});

function gatewayLifecycleHarness() {
  const timers = [];
  const statuses = [];
  const transcripts = [];
  const runtimeState = {
    realtimeActive: false,
    taskRunning: false,
    turnId: ""
  };
  const runtimeCalls = {
    starts: [],
    stopRealtime: 0,
    stops: 0
  };
  const runtime = {
    status: () => ({ ...runtimeState }),
    async start(offer, options) {
      runtimeCalls.starts.push({ offer, options });
      runtimeState.realtimeActive = true;
    },
    async stopRealtime() {
      runtimeCalls.stopRealtime += 1;
      runtimeState.realtimeActive = false;
    },
    async stop() {
      runtimeCalls.stops += 1;
      runtimeState.realtimeActive = false;
      runtimeState.taskRunning = false;
      runtimeState.turnId = "";
    },
    async appendText() {
      return { mode: runtimeState.realtimeActive ? "realtime" : "steer" };
    },
    async interruptTask() {
      return runtimeState.taskRunning;
    },
    setEventHandler() {},
    setVoice() {}
  };
  const gateway = new LiveVoiceGateway({
    token: "secret",
    ticketStore: new LiveVoiceTicketStore(),
    threadAdapter: {
      async runtimeContext(threadId) {
        return { threadId, cwd: "/workspace", model: "", reasoningEffort: "" };
      },
      publishLiveVoiceStatus(status) {
        statuses.push(status);
      },
      recordLiveVoiceTranscript(threadId, role, text) {
        transcripts.push({ threadId, role, text });
      }
    },
    runtimeFactory: () => runtime,
    reconnectGraceMs: 100,
    taskRetentionMs: 1_000,
    setTimeoutFn(fn, ms) {
      const timer = {
        fn,
        ms,
        cleared: false,
        unref() {}
      };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      if (timer) timer.cleared = true;
    }
  });
  return { gateway, runtime, runtimeState, runtimeCalls, statuses, transcripts, timers };
}

function fakeOpenSocket() {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    send(value) {
      this.sent.push(value);
    }
  };
}

test("connected Live Voice records every completed user and assistant transcript on its bound thread", async () => {
  const { gateway, transcripts } = gatewayLifecycleHarness();
  const session = await gateway.createSession(
    "thread-conversation",
    fakeOpenSocket(),
    "offer",
    "cove"
  );

  gateway.handleRuntimeEvent(session, {
    type: "transcript.done",
    role: "user",
    text: "你好，先聊两句"
  });
  gateway.handleRuntimeEvent(session, {
    type: "transcript.done",
    role: "assistant",
    text: "可以，我们已经连通了。"
  });

  assert.deepEqual(transcripts, [
    { threadId: "thread-conversation", role: "user", text: "你好，先聊两句" },
    { threadId: "thread-conversation", role: "assistant", text: "可以，我们已经连通了。" }
  ]);
});

test("an unexpected Android disconnect reuses one runtime during the reconnect grace window", async () => {
  const {
    gateway,
    runtimeState,
    runtimeCalls,
    timers
  } = gatewayLifecycleHarness();
  const firstSocket = fakeOpenSocket();
  const session = await gateway.createSession(
    "thread-reconnect",
    firstSocket,
    "offer-one",
    "cove"
  );
  runtimeState.taskRunning = true;
  runtimeState.turnId = "turn-reconnect";
  gateway.handleRuntimeEvent(session, {
    type: "manager.turn.started",
    turn_id: "turn-reconnect"
  });

  await gateway.detachSession(session, firstSocket, false);
  assert.equal(liveVoiceThreadSnapshot("thread-reconnect").connected, false);
  assert.equal(liveVoiceThreadSnapshot("thread-reconnect").taskRunning, true);
  assert.equal(runtimeCalls.stopRealtime, 0);
  const firstGrace = timers.find((timer) => timer.ms === 100 && !timer.cleared);
  assert.ok(firstGrace);

  const secondSocket = fakeOpenSocket();
  const reconnected = await gateway.reconnectSession(
    session,
    secondSocket,
    "offer-two",
    "ember"
  );
  assert.equal(reconnected, session);
  assert.equal(firstGrace.cleared, true);
  assert.equal(runtimeCalls.starts.length, 2);
  assert.deepEqual(runtimeCalls.starts.map((item) => item.offer), [
    "offer-one",
    "offer-two"
  ]);
  assert.equal(liveVoiceThreadSnapshot("thread-reconnect").connected, true);

  await gateway.detachSession(session, secondSocket, false);
  const secondGrace = timers.find((timer) => (
    timer.ms === 100 && timer !== firstGrace && !timer.cleared
  ));
  assert.ok(secondGrace);
  await secondGrace.fn();
  assert.equal(runtimeCalls.stopRealtime, 1);
  assert.equal(isLiveVoiceThreadActive("thread-reconnect"), true);
  assert.ok(timers.some((timer) => timer.ms === 1_000 && !timer.cleared));

  runtimeState.taskRunning = false;
  runtimeState.turnId = "";
  gateway.handleRuntimeEvent(session, {
    type: "manager.turn.completed",
    status: "completed"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeCalls.stops, 1);
  assert.equal(isLiveVoiceThreadActive("thread-reconnect"), false);
});

test("explicit voice stop closes audio but keeps a delegated Codex task alive", async () => {
  const {
    gateway,
    runtimeState,
    runtimeCalls,
    timers
  } = gatewayLifecycleHarness();
  const socket = fakeOpenSocket();
  const session = await gateway.createSession(
    "thread-detached-task",
    socket,
    "offer",
    "cove"
  );
  runtimeState.taskRunning = true;
  runtimeState.turnId = "turn-detached";
  gateway.handleRuntimeEvent(session, {
    type: "manager.turn.started",
    turn_id: "turn-detached"
  });

  await gateway.detachSession(session, socket, true);
  const snapshot = liveVoiceThreadSnapshot("thread-detached-task");
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.realtimeActive, false);
  assert.equal(snapshot.taskRunning, true);
  assert.equal(snapshot.explicitStop, true);
  assert.equal(runtimeCalls.stopRealtime, 1);
  assert.equal(runtimeCalls.stops, 0);
  assert.ok(timers.some((timer) => timer.ms === 1_000 && !timer.cleared));

  runtimeState.taskRunning = false;
  runtimeState.turnId = "";
  gateway.handleRuntimeEvent(session, {
    type: "manager.turn.completed",
    status: "completed"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeCalls.stops, 1);
  assert.equal(isLiveVoiceThreadActive("thread-detached-task"), false);
});

test("an idle thread status completes a detached task when turn/completed is missed", () => {
  const events = [];
  const runtime = new CodexLiveVoiceRuntime({
    threadId: "thread-idle-fallback",
    cwd: "/workspace",
    onEvent: (event) => events.push(event)
  });
  runtime.taskRunning = true;
  runtime.activeTurnId = "turn-missed-completion";

  runtime.handleNotification({
    method: "thread/status/changed",
    params: {
      threadId: "thread-idle-fallback",
      status: { type: "idle" }
    }
  });

  assert.equal(runtime.status().taskRunning, false);
  assert.deepEqual(events, [
    { type: "manager.turn.completed", status: "completed" }
  ]);
});

test("a detached task polls thread/read and releases the Live Voice lease", async () => {
  const {
    gateway,
    runtime,
    runtimeState,
    runtimeCalls,
    timers
  } = gatewayLifecycleHarness();
  const socket = fakeOpenSocket();
  const session = await gateway.createSession(
    "thread-polled-completion",
    socket,
    "offer",
    "cove"
  );
  runtimeState.taskRunning = true;
  runtimeState.turnId = "turn-polled";
  gateway.handleRuntimeEvent(session, {
    type: "manager.turn.started",
    turn_id: "turn-polled"
  });
  runtime.reconcileTaskStatus = async () => {
    runtimeState.taskRunning = false;
    runtimeState.turnId = "";
    return false;
  };

  await gateway.detachSession(session, socket, true);
  const poll = timers.find((timer) => timer.ms === 2_000 && !timer.cleared);
  assert.ok(poll);
  await poll.fn();

  assert.equal(runtimeCalls.stops, 1);
  assert.equal(isLiveVoiceThreadActive("thread-polled-completion"), false);
});

test("Android-compatible HTTP and WebSocket flow reaches the pluggable runtime", async () => {
  const sessionId = "thread-current";
  let stopped = false;
  let startedOffer = "";
  let runtimeVoice = "";
  const adapter = {
    async currentSession() {
      return { session_id: sessionId };
    },
    async getSession(id) {
      assert.equal(id, sessionId);
      return { session_id: id };
    },
    async currentSessionConversation(id) {
      assert.equal(id, sessionId);
      return [{ role: "assistant", text: "✅ Codex 任务已完成。", channel: "final" }];
    },
    async createSession() {
      return { session_id: sessionId };
    },
    async setCurrentSession(id) {
      return { session_id: id };
    },
    async runtimeContext(id) {
      return {
        threadId: id,
        cwd: "/workspace",
        model: "",
        reasoningEffort: ""
      };
    }
  };
  const tickets = new LiveVoiceTicketStore();
  const gateway = new LiveVoiceGateway({
    token: "secret",
    enabled: true,
    voice: "cove",
    ticketStore: tickets,
    threadAdapter: adapter,
    runtimeFactory: ({ voice, onEvent }) => {
      runtimeVoice = voice;
      return {
        async start(offer) {
          startedOffer = offer;
          onEvent({ type: "session.sdp", sdp: "answer-sdp" });
        },
        async appendText() {},
        async stop() {
          stopped = true;
        }
      };
    },
    normalizePath: (pathname) => pathname.startsWith("/codexremote/")
      ? pathname.slice("/codexremote".length)
      : pathname
  });
  const server = createServer(async (req, res) => {
    const handled = await gateway.handleHttp(
      req,
      res,
      new URL(req.url, "http://localhost")
    );
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  gateway.attach(server);
  const port = await listen(server);
  try {
    const current = await requestJson(
      port,
      "GET",
      "/codexremote/api/voice-agent/current-session"
    );
    assert.equal(current.status, 200);
    assert.equal(current.body.data.session_id, sessionId);

    const conversation = await requestJson(
      port,
      "GET",
      `/codexremote/api/voice-agent/sessions/${sessionId}/conversation`
    );
    assert.equal(conversation.status, 200);
    assert.deepEqual(conversation.body.data.conversation, [
      { role: "assistant", text: "✅ Codex 任务已完成。", channel: "final" }
    ]);

    const issued = await requestJson(
      port,
      "POST",
      `/codexremote/api/voice-agent/sessions/${sessionId}/live-ticket`,
      {}
    );
    assert.equal(issued.status, 200);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/codexremote/api/voice-agent/sessions/${sessionId}/live`,
      { headers: voiceHeaders() }
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.send(JSON.stringify({
      type: "authenticate",
      ticket: issued.body.data.ticket
    }));
    assert.equal((await nextSocketMessage(socket)).type, "ready");

    let responsePromise = nextSocketMessage(socket);
    socket.send(JSON.stringify({
      type: "start",
      sdp: "offer-sdp",
      voice: "not-a-voice"
    }));
    assert.deepEqual(await responsePromise, {
      type: "session.error",
      message: "不支持的 Codex Live Voice 音色。",
      recoverable: true
    });

    socket.send(JSON.stringify({
      type: "start",
      sdp: "offer-sdp",
      voice: "ember"
    }));
    assert.deepEqual(await nextSocketMessage(socket), {
      type: "session.sdp",
      sdp: "answer-sdp"
    });
    assert.equal(startedOffer, "offer-sdp");
    assert.equal(runtimeVoice, "ember");
    assert.equal(isLiveVoiceThreadActive(sessionId), true);

    socket.send(JSON.stringify({ type: "stop" }));
    assert.equal((await nextSocketMessage(socket)).type, "session.closed");
    await new Promise((resolve) => socket.once("close", resolve));
    assert.equal(stopped, true);
    assert.equal(isLiveVoiceThreadActive(sessionId), false);
  } finally {
    await closeServer(server);
  }
});
