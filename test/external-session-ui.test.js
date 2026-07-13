import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
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

test("app-server model setting notifications update the selected web session", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf("function applyIncomingModelSettings"),
    source.indexOf('if (data.type === "status")')
  );
  assert.match(handler, /data\.type === "model_settings_update"/);
  assert.match(handler, /data\.threadId !== state\.threadId/);
  assert.match(handler, /state\.model\s*=\s*data\.model/);
  assert.match(handler, /state\.reasoningEffort\s*=\s*data\.reasoningEffort/);
  assert.match(handler, /renderModelSettings/);
});

test("older or unversioned HTTP settings cannot overwrite a newer SSE setting", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function settingsResponseIsCurrent"),
    source.indexOf("function renderState")
  );
  const context = {
    state: { modelSettingsUpdatedAt: "2026-07-13T02:00:00.000Z" }
  };
  vm.createContext(context);
  vm.runInContext(helper, context);

  assert.equal(vm.runInContext("settingsResponseIsCurrent('2026-07-13T01:59:59.000Z')", context), false);
  assert.equal(vm.runInContext("settingsResponseIsCurrent('')", context), false);
  assert.equal(vm.runInContext("settingsResponseIsCurrent('2026-07-13T02:00:01.000Z')", context), true);
});

test("model settings requests discard responses after connector or thread changes", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const open = source.slice(source.indexOf("async function openModelSettings"), source.indexOf("async function changeModelSettings"));
  const change = source.slice(source.indexOf("async function changeModelSettings"), source.indexOf("function usageResetTime"));
  assert.match(open, /const threadId = state\.threadId/);
  assert.match(open, /connectorId !== currentConnectorId\(\) \|\| threadId !== state\.threadId/);
  assert.match(change, /const threadId = state\.threadId/);
  assert.match(change, /connectorId !== currentConnectorId\(\) \|\| threadId !== state\.threadId/);
});

test("an open thread panel refreshes when running state reaches a terminal event", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const scheduler = source.slice(
    source.indexOf("function scheduleThreadListRefresh"),
    source.indexOf("async function openThreads")
  );
  const handler = source.slice(
    source.indexOf("function handleRemoteEvent"),
    source.indexOf("async function resyncEvents")
  );
  const openThreads = source.slice(
    source.indexOf("async function openThreads"),
    source.indexOf("function setThreadView")
  );

  assert.match(scheduler, /threadPanel\.hidden \|\| els\.threadExistingView\.hidden/);
  assert.match(handler, /data\.type === "runner_status"[\s\S]*?scheduleThreadListRefresh/);
  assert.match(handler, /data\.type === "done"[\s\S]*?scheduleThreadListRefresh/);
  assert.match(handler, /data\.type === "external_session_update"[\s\S]*?scheduleThreadListRefresh/);
  assert.match(openThreads, /requestGeneration !== threadListRequestGeneration/);
});

test("current, running, and unread thread states remain independently identifiable", async () => {
  const remoteSource = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(remoteSource, /threadSubtitle\(thread, isActive\)/);
  assert.match(remoteSource, /isActive \? "当前会话"/);
  assert.match(remoteSource, /else state\.completedUnreadThreads\.delete\(thread\.threadId\)/);
  assert.match(styles, /\.threadItem\.running\.active[\s\S]*?border-color:\s*#60a5fa/);
});

test("done is broadcast only after the runner leaves the finished turn", async () => {
  const source = await readFile(new URL("../src/runner.js", import.meta.url), "utf8");
  const runTask = source.slice(
    source.indexOf("export async function runRemoteTask"),
    source.indexOf("export async function startRemoteTask")
  );
  const terminalStateIndex = runTask.indexOf("runner.running = willContinue");
  const doneIndex = runTask.indexOf('broadcastRunner(runner, { type: "done"');

  assert.ok(terminalStateIndex >= 0);
  assert.ok(doneIndex > terminalStateIndex);
  assert.equal(runTask.slice(0, terminalStateIndex).includes('broadcastRunner(runner, { type: "done"'), false);
});
