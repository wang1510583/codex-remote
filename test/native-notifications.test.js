import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
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

test("WebToApp notification websocket authenticates and receives task completion", async (t) => {
  const server = createServer((_req, res) => res.end("ok"));
  const hub = createNativeNotificationHub({
    token: "test-notification-token",
    clickUrl: "https://example.test/codex-remote/",
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
  assert.equal(message.url, "https://example.test/codex-remote/");
});

test("WebToApp notification websocket rejects an invalid token", async (t) => {
  const server = createServer((_req, res) => res.end("ok"));
  const hub = createNativeNotificationHub({
    token: "correct-token",
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
