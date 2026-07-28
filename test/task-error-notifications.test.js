import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  dispatchTaskTerminalNotification,
  runRemoteTask
} from "../src/runner.js";
import {
  failureNotificationMessage
} from "../src/webpush.js";
import { taskNotificationTitle } from "../src/utils.js";

function notificationChannels(received) {
  return {
    notifyWechat(text) { received.wechat.push(text); },
    async sendWebPush(text) { received.webPush.push(text); },
    sendNative(text) { received.native.push(text); },
    logger: { error(...args) { received.errors.push(args); } }
  };
}

function fakeRunner(runTurn, received) {
  const startedAt = Date.now() - 50;
  return {
    key: `notification-test-${Math.random()}`,
    connectorId: "",
    cwd: "",
    running: true,
    reconnecting: false,
    taskStartedAtMs: startedAt,
    messageQueue: [],
    steerMessages: [],
    followMode: "steer",
    contextUsage: null,
    ownsAppServer: false,
    notificationChannels: notificationChannels(received),
    state: {
      threadId: "",
      runtimeId: `runtime-${Math.random()}`,
      connectorId: "",
      cwd: "",
      messages: [],
      inflight: {
        message: "测试任务",
        cwd: "",
        startedAt: new Date(startedAt).toISOString()
      }
    },
    appServer: {
      runTurn,
      rejectAll() {},
      async abortCurrentTurn() {},
      turn: null,
      pending: new Map(),
      starting: false,
      settingsUpdatePromise: null
    }
  };
}

test("failure notification extracts the terminal error instead of preceding partial output", () => {
  const text = failureNotificationMessage([
    "🤔 已经完成一部分分析\n\n❌ 执行失败：模型服务断开\n错误代码：upstream_closed"
  ]);

  assert.equal(text, "❌ 执行失败：模型服务断开 错误代码：upstream_closed");
  assert.equal(taskNotificationTitle(text), "Codex任务出错");
  assert.equal(taskNotificationTitle("✅ 修改完成"), "服务器Codex");
});

test("terminal notification dispatcher sends errors through every configured channel", async () => {
  const received = { wechat: [], webPush: [], native: [], errors: [] };
  const text = "❌ 执行失败：连接超时";

  assert.equal(dispatchTaskTerminalNotification(text, notificationChannels(received)), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received.wechat, [text]);
  assert.deepEqual(received.webPush, [text]);
  assert.deepEqual(received.native, [text]);
  assert.deepEqual(received.errors, []);
});

test("a failed Codex turn sends one terminal error notification through all channels", async () => {
  const received = { wechat: [], webPush: [], native: [], errors: [] };
  const runner = fakeRunner(async () => {
    throw new Error("上游模型连接已经断开");
  }, received);

  await runRemoteTask("执行测试", runner);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runner.running, false);
  assert.equal(runner.state.inflight, null);
  assert.match(runner.state.messages.at(-1).content, /❌ 执行失败：上游模型连接已经断开/);
  assert.equal(received.wechat.length, 1);
  assert.deepEqual(received.webPush, received.wechat);
  assert.deepEqual(received.native, received.wechat);
  assert.match(received.native[0], /^❌ 执行失败/);
});

test("a stopped turn without a final answer is treated as an error and sends notification", async () => {
  const received = { wechat: [], webPush: [], native: [], errors: [] };
  const runner = fakeRunner(async () => ["🤔 只有思考过程，没有最终回复"], received);

  await runRemoteTask("执行测试", runner);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runner.running, false);
  assert.match(runner.state.messages.at(-1).content, /没有返回完整的最终回复/);
  assert.equal(received.native.length, 1);
  assert.match(received.native[0], /^❌/);
});

test("runner and browser mark only terminal failures, while retryable errors still wait", async () => {
  const [runnerSource, browserSource, serverSource, startupSource] = await Promise.all([
    readFile(new URL("../src/runner.js", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../src/codex-server.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8")
  ]);
  const runTask = runnerSource.slice(
    runnerSource.indexOf("export async function runRemoteTask"),
    runnerSource.indexOf("export async function startRemoteTask")
  );

  assert.match(runTask, /if \(ok && !completionMessage\(answers\)\)/);
  assert.match(runTask, /payload\.taskFailed = true/);
  assert.match(runTask, /payload\.notificationText = notificationText/);
  assert.match(runTask, /taskOk = false;[\s\S]*?notifyTaskTerminalOnce\(notificationText\)/);
  assert.match(runnerSource, /队列任务启动失败[\s\S]*?dispatchTaskTerminalNotification\(failureMessage/);
  assert.match(runnerSource, /type: "error",[\s\S]*?taskFailed: true/);
  assert.match(runnerSource, /markInterruptedInflight[\s\S]*?dispatchTaskTerminalNotification\(failureMessage\)/);
  assert.match(browserSource, /data\.final && \(\/\^✅\\s\/\.test\(data\.content \|\| ""\) \|\| data\.taskFailed\)/);
  assert.match(browserSource, /data\.notificationText \? \{ \.\.\.data, content: data\.notificationText \} : data/);
  assert.match(browserSource, /data\.type === "error"[\s\S]*?if \(data\.taskFailed\)[\s\S]*?notifyCodexReply/);
  assert.match(serverSource, /if \(params\.willRetry\)[\s\S]*?turn\/completed/);
  assert.ok(startupSource.indexOf("setupWebPush()") < startupSource.indexOf('markInterruptedInflight("")'));
});
