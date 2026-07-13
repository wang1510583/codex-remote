import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CodexAppServer } from "../src/codex-server.js";
import { UnixWebSocketTransport } from "../src/transport/local.js";

test("two shared app-server clients synchronize model settings in both directions", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-remote-shared-"));
  const socketPath = path.join(dir, "app-server.sock");
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
  const threadId = "11111111-1111-4111-8111-111111111111";
  const settings = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  let updateCount = 0;
  const updateParams = [];

  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
    await rm(dir, { recursive: true, force: true });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  function send(socket, message) {
    socket.send(JSON.stringify(message));
  }

  function broadcastSettings() {
    const notification = {
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: {
          cwd: "/workspace",
          model: settings.model,
          effort: settings.reasoningEffort
        }
      }
    };
    for (const client of wss.clients) send(client, notification);
  }

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === "initialize") {
        send(socket, { id: request.id, result: { userAgent: "fake-shared-app-server" } });
        return;
      }
      if (request.method === "thread/resume") {
        send(socket, {
          id: request.id,
          result: {
            thread: { id: threadId },
            model: settings.model,
            reasoningEffort: settings.reasoningEffort
          }
        });
        return;
      }
      if (request.method === "thread/settings/update") {
        updateParams.push(request.params);
        settings.model = request.params.model || settings.model;
        settings.reasoningEffort = request.params.effort || settings.reasoningEffort;
        updateCount += 1;
        if (updateCount === 1) {
          broadcastSettings();
          send(socket, { id: request.id, result: {} });
        } else {
          send(socket, { id: request.id, result: {} });
          setImmediate(broadcastSettings);
        }
      }
    });
  });

  const desktop = new CodexAppServer(new UnixWebSocketTransport({ socketPath, openTimeoutMs: 2000 }), { isRemote: true });
  const web = new CodexAppServer(new UnixWebSocketTransport({ socketPath, openTimeoutMs: 2000 }), { isRemote: true });
  t.after(() => {
    desktop.transport.kill();
    web.transport.kill();
  });
  const desktopUpdates = [];
  const webUpdates = [];
  desktop.onThreadSettingsUpdate = (update) => desktopUpdates.push(update);
  web.onThreadSettingsUpdate = (update) => webUpdates.push(update);

  await desktop.readThreadSettings(threadId, "/workspace");
  await web.readThreadSettings(threadId, "/workspace");

  const fromWeb = await web.updateThreadModelSettings({
    threadId,
    cwd: "/workspace",
    effort: "high"
  });
  assert.deepEqual(fromWeb, { model: "gpt-5.6-sol", effort: "high" });
  assert.equal(Object.prototype.hasOwnProperty.call(updateParams[0], "model"), false);
  assert.equal(desktopUpdates.at(-1).reasoningEffort, "high");

  const fromDesktop = await desktop.updateThreadModelSettings({
    threadId,
    cwd: "/workspace",
    model: "gpt-5.6-terra"
  });
  assert.deepEqual(fromDesktop, { model: "gpt-5.6-terra", effort: "high" });
  assert.equal(Object.prototype.hasOwnProperty.call(updateParams[1], "effort"), false);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && webUpdates.at(-1)?.model !== "gpt-5.6-terra") {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(webUpdates.at(-1).model, "gpt-5.6-terra");
  assert.equal(webUpdates.at(-1).reasoningEffort, "high");
});
