import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("WebToApp notification websocket authenticates and receives task completion", async (t) => {
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
