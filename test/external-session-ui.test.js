import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("external session updates stay running, refresh progress, and disable writes", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const setRunning = source.slice(source.indexOf("function setRunning("), source.indexOf("function updateMeta()"));
  const externalHandler = source.slice(
    source.indexOf('if (data.type === "external_session_update")'),
    source.indexOf('if (data.type === "status")')
  );
  const send = source.slice(source.indexOf("async function sendMessage"), source.indexOf("els.form.addEventListener"));

  assert.match(setRunning, /els\.sendQueue\.disabled\s*=\s*state\.externalRunning/);
  assert.match(setRunning, /els\.sendSteer\.disabled\s*=\s*state\.externalRunning/);
  assert.match(externalHandler, /scheduleExternalSessionRefresh/);
  assert.match(send, /if \(state\.externalRunning\)/);
  assert.match(source, /本机 Codex Desktop\/CLI 正在执行 · 实时同步中/);
});

test("the initial SSE status preserves a selected external task", async () => {
  const source = await readFile(new URL("../src/router.js", import.meta.url), "utf8");
  const eventsRoute = source.slice(
    source.indexOf('url.pathname === "/api/remote/events"'),
    source.indexOf('url.pathname === "/api/remote/upload"')
  );
  assert.match(eventsRoute, /externalSessionSnapshot/);
  assert.match(eventsRoute, /initialStatus\.externalRunning\s*=\s*true/);
});
