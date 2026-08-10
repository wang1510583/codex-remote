import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createNativeNotificationHub } from "../src/native-notifications.js";

function matchingMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

async function temporaryQueuePath(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-remote-native-notification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "queue.json");
}

function noMatchingMessage(ws, predicate, timeoutMs = 120) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (!predicate(message)) return;
      cleanup();
      reject(new Error(`unexpected websocket message: ${JSON.stringify(message)}`));
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

test("WebToApp notification websocket receives task completion, terminal errors, and approval requests", async (t) => {
  const server = createServer((_req, res) => res.end("ok"));
  const queuePath = await temporaryQueuePath(t);
  const hub = createNativeNotificationHub({
    token: "test-notification-token",
    queuePath,
    logger: { log() {}, warn() {}, error() {} }
  });
  const wss = hub.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/codex-remote/api/notifications/ws`, {
    headers: {
      Authorization: "Bearer test-notification-token",
      "X-Device-Id": "android-test",
      "X-App-Name": "Codex APK"
    }
  });

  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await once(ws, "open");
  assert.deepEqual(hub.status(), { configured: true, connected: 1 });

  const received = matchingMessage(ws, (message) => message.type === "notification");
  const result = hub.sendTaskDone("✅ 已完成代码修改");
  const message = await received;

  assert.deepEqual(result, { configured: true, sent: 1, total: 1 });
  assert.equal(message.title, "服务器Codex");
  assert.equal(message.body, "已完成代码修改");
  assert.equal("url" in message, false);

  const receivedError = matchingMessage(ws, (next) => next.type === "notification" && next.id !== message.id);
  const errorResult = hub.sendTaskDone("❌ 执行失败：模型连接中断");
  const errorMessage = await receivedError;

  assert.deepEqual(errorResult, { configured: true, sent: 1, total: 1 });
  assert.equal(errorMessage.title, "Codex任务出错");
  assert.equal(errorMessage.body, "❌ 执行失败：模型连接中断");

  const receivedApproval = matchingMessage(ws, (next) => next.type === "notification" && next.id !== errorMessage.id);
  const approvalResult = hub.sendApprovalRequired({
    title: "命令执行确认",
    summary: "npm test"
  });
  const approvalMessage = await receivedApproval;

  assert.deepEqual(approvalResult, { configured: true, sent: 1, total: 1 });
  assert.equal(approvalMessage.title, "Codex等待审核");
  assert.equal(approvalMessage.body, "⚠️ 命令执行确认：npm test。请打开 Codex 网页手动确认。");
});

test("WebToApp notification websocket rejects an invalid token", async (t) => {
  const server = createServer((_req, res) => res.end("ok"));
  const queuePath = await temporaryQueuePath(t);
  const hub = createNativeNotificationHub({
    token: "correct-token",
    queuePath,
    logger: { log() {}, warn() {}, error() {} }
  });
  const wss = hub.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/notifications/ws`, {
    headers: { Authorization: "Bearer wrong-token" }
  });
  ws.on("error", () => {});

  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const [, response] = await once(ws, "unexpected-response");
  assert.equal(response.statusCode, 401);
  response.resume();
  assert.deepEqual(hub.status(), { configured: true, connected: 0 });
});

test("auto approval suppresses only approval notifications and restores them when disabled", async (t) => {
  const server = createServer((_req, res) => res.end("ok"));
  const queuePath = await temporaryQueuePath(t);
  const hub = createNativeNotificationHub({
    token: "suppression-token",
    queuePath,
    logger: { log() {}, warn() {}, error() {} }
  });
  const wss = hub.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/notifications/ws`, {
    headers: { Authorization: "Bearer suppression-token", "X-Device-Id": "suppression-test" }
  });

  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await once(ws, "open");
  hub.setApprovalNotificationsSuppressed(true);
  const noApproval = noMatchingMessage(ws, (message) => message.title === "Codex等待审核");
  assert.deepEqual(hub.sendApprovalRequired({ title: "命令执行确认" }), {
    configured: true,
    sent: 0,
    total: 1,
    suppressed: true
  });
  await noApproval;

  const taskReceived = matchingMessage(ws, (message) => message.title === "服务器Codex");
  hub.sendTaskDone("✅ 自动确认期间任务完成");
  assert.equal((await taskReceived).body, "自动确认期间任务完成");

  hub.setApprovalNotificationsSuppressed(false);
  const approvalReceived = matchingMessage(ws, (message) => message.title === "Codex等待审核");
  hub.sendApprovalRequired({ title: "文件修改确认" });
  assert.equal((await approvalReceived).title, "Codex等待审核");
});

test("approval suppression persists across restarts and purges queued approval notifications", async (t) => {
  const queuePath = await temporaryQueuePath(t);
  const options = {
    token: "persistent-suppression-token",
    queuePath,
    logger: { log() {}, warn() {}, error() {} }
  };
  const firstHub = createNativeNotificationHub(options);
  assert.deepEqual(firstHub.sendApprovalRequired({ title: "待清理审核" }), {
    configured: true,
    sent: 0,
    total: 0
  });
  assert.deepEqual(firstHub.setApprovalNotificationsSuppressed(true), {
    approvalNotificationsSuppressed: true,
    purgedApprovalNotifications: 1
  });

  const stored = JSON.parse(await readFile(queuePath, "utf8"));
  assert.equal(stored.approvalNotificationsSuppressed, true);
  assert.equal(stored.notifications.some((item) => item.title === "Codex等待审核"), false);

  stored.notifications.push({
    id: "legacy-queued-approval",
    title: "Codex等待审核",
    body: "旧版本遗留的审核通知",
    ts: Date.now()
  });
  await writeFile(queuePath, `${JSON.stringify(stored, null, 2)}\n`);

  const restartedHub = createNativeNotificationHub(options);
  assert.deepEqual(restartedHub.approvalNotificationPreference(), {
    approvalNotificationsSuppressed: true
  });
  assert.deepEqual(restartedHub.sendApprovalRequired({ title: "重启后的审核" }), {
    configured: true,
    sent: 0,
    total: 0,
    suppressed: true
  });
  const restartedStore = JSON.parse(await readFile(queuePath, "utf8"));
  assert.equal(restartedStore.notifications.some((item) => item.title === "Codex等待审核"), false);
});

test("WebToApp replays an offline notification and stops after device acknowledgement", async (t) => {
  const server = createServer((_req, res) => res.end("ok"));
  const queuePath = await temporaryQueuePath(t);
  const hub = createNativeNotificationHub({
    token: "queue-token",
    queuePath,
    logger: { log() {}, warn() {}, error() {} }
  });
  const wss = hub.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  const queued = hub.sendTaskDone("✅ 离线时完成的任务");
  assert.deepEqual(queued, { configured: true, sent: 0, total: 0 });

  const createClient = () => new WebSocket(`ws://127.0.0.1:${port}/api/notifications/ws`, {
    headers: {
      Authorization: "Bearer queue-token",
      "X-Device-Id": "android-offline-test",
      "X-App-Name": "NotificationHub"
    }
  });
  let firstClient = createClient();
  let secondClient = null;
  t.after(async () => {
    for (const client of [firstClient, secondClient]) {
      if (client?.readyState === WebSocket.OPEN || client?.readyState === WebSocket.CONNECTING) {
        client.terminate();
      }
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await once(firstClient, "open");
  const replayed = matchingMessage(firstClient, (message) => message.type === "notification");
  firstClient.send(JSON.stringify({ type: "hello", deviceId: "android-offline-test" }));
  const message = await replayed;
  assert.equal(message.body, "离线时完成的任务");
  assert.ok(message.id);

  firstClient.send(JSON.stringify({ type: "notification_ack", id: message.id }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const persisted = JSON.parse(await readFile(queuePath, "utf8"));
  assert.deepEqual(persisted.acknowledgements["android-offline-test"], [message.id]);

  firstClient.close();
  await once(firstClient, "close");
  secondClient = createClient();
  await once(secondClient, "open");
  const noReplay = noMatchingMessage(secondClient, (next) => next.type === "notification");
  secondClient.send(JSON.stringify({ type: "hello", deviceId: "android-offline-test" }));
  await noReplay;
});
