import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("external session updates stay running, refresh progress, and allow web controls", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const setRunning = source.slice(source.indexOf("function setRunning("), source.indexOf("function updateMeta()"));
  const externalHandler = source.slice(
    source.indexOf('if (data.type === "external_session_update")'),
    source.indexOf('if (data.type === "status")')
  );
  const send = source.slice(source.indexOf("async function sendMessage"), source.indexOf("els.form.addEventListener"));

  assert.match(setRunning, /els\.sendQueue\.disabled\s*=\s*false/);
  assert.match(setRunning, /els\.sendSteer\.disabled\s*=\s*false/);
  assert.match(externalHandler, /scheduleExternalSessionRefresh/);
  assert.doesNotMatch(send, /if \(state\.externalRunning\)/);
  assert.match(send, /false, state\.externalRunning\)/);
  assert.match(source, /Codex 正在处理 · 网页可引导或排队/);
  assert.match(source, /className = "remoteStatusIcon status-running"/);
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

test("model settings requests discard responses after thread changes", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const open = source.slice(source.indexOf("async function openModelSettings"), source.indexOf("async function changeModelSettings"));
  const change = source.slice(source.indexOf("async function changeModelSettings"), source.indexOf("function usageResetTime"));
  assert.match(open, /const threadId = state\.threadId/);
  assert.match(open, /threadId !== state\.threadId/);
  assert.match(change, /const threadId = state\.threadId/);
  assert.match(change, /threadId !== state\.threadId/);
});

test("usage is embedded in the model settings panel and toggles beside close", async () => {
  const [source, html] = await Promise.all([
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.html", import.meta.url), "utf8")
  ]);
  const panel = html.slice(html.indexOf('id="modelSettingsPanel"'), html.indexOf('id="threadPanel"'));
  assert.doesNotMatch(html, /id="usageRemote"|id="usagePanel"|id="closeUsage"/);
  assert.match(panel, /id="modelUsageToggle"[\s\S]*?id="closeModelSettings"/);
  assert.match(panel, /id="modelSettingsView"[\s\S]*?id="modelUsageView"[\s\S]*?id="usageContent"/);
  assert.match(source, /function setModelSettingsView\(view = "model"\)/);
  assert.match(source, /els\.modelUsageToggle\.addEventListener\("click"/);
  assert.match(source, /openUsageInModelSettings\(\)/);
});

test("the thread panel uses its cached list until manual refresh", async () => {
  const [source, html] = await Promise.all([
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.html", import.meta.url), "utf8")
  ]);
  const handler = source.slice(
    source.indexOf("function handleRemoteEvent"),
    source.indexOf("async function resyncEvents")
  );
  const openThreads = source.slice(
    source.indexOf("async function openThreads"),
    source.indexOf("function setThreadView")
  );

  const toggle = source.slice(source.indexOf("function toggleThreadPanel"), source.indexOf("function setThreadView"));
  assert.doesNotMatch(source, /scheduleThreadListRefresh|threadListRefreshTimer/);
  assert.match(html, /id="refreshThreads" type="button">刷新<\/button>/);
  assert.match(html, /id="threadList" class="threadList"><div class="remoteEvent">点击刷新加载会话<\/div>/);
  assert.match(toggle, /openThreads\(\{ load: false \}\)/);
  assert.match(source, /els\.refreshThreads\.addEventListener\("click"[\s\S]*?openThreads\(\)\.finally/);
  assert.match(source, /localStorage\.setItem\("codex-remote-thread-list-cache"/);
  assert.match(source, /els\.refreshThreads\.hidden = showNew \|\| showFiles/);
  assert.doesNotMatch(handler, /scheduleThreadListRefresh/);
  assert.match(openThreads, /requestGeneration !== threadListRequestGeneration/);
  assert.match(openThreads, /load \? await request\("\/api\/remote\/threads"\) : state\.threadListCache/);
});

test("removed remote-control modules leave no startup calls that abort local initialization", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /loadSshStatus|updateSshStatus|openConnectors|loadConnectors/);
  assert.match(source, /syncAutoApprovalNotificationPreference\(\)[\s\S]*?\.then\(loadState\)[\s\S]*?\.then\(connectEvents\)/);
});

test("the session button opens synchronously and stops the document click from closing it", async () => {
  const [source, html] = await Promise.all([
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.html", import.meta.url), "utf8")
  ]);
  const toggle = source.slice(source.indexOf("function toggleThreadPanel"), source.indexOf("function setThreadView"));
  assert.match(toggle, /event\?\.stopPropagation\(\)/);
  assert.match(toggle, /els\.threadPanel\.hidden = false/);
  assert.match(toggle, /openThreads\(\{ load: false \}\)\.catch/);
  assert.match(source, /els\.threadButton\.addEventListener\("click", toggleThreadPanel\)/);
  assert.match(source, /let threadListRequestGeneration = 0/);
  assert.match(html, /id="threadRemote"[\s\S]*?aria-controls="threadPanel"[\s\S]*?aria-expanded="false"/);
});

test("project files are embedded in the session panel and toggle beside close", async () => {
  const [source, html] = await Promise.all([
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.html", import.meta.url), "utf8")
  ]);
  const panel = html.slice(html.indexOf('id="threadPanel"'), html.indexOf('class="remoteLogWrap"'));
  assert.doesNotMatch(html, /id="filesRemote"|id="filePanel"|id="closeFiles"/);
  assert.match(panel, /id="threadFilesToggle"[\s\S]*?id="closeThreads"/);
  assert.match(panel, /id="threadExistingView"[\s\S]*?id="threadNewView"[\s\S]*?id="threadFilesView"[\s\S]*?id="fileList"/);
  assert.match(source, /function setThreadView\(view = "existing"\)[\s\S]*?view === "files"/);
  assert.match(source, /els\.threadFilesToggle\.addEventListener\("click"/);
  assert.match(source, /setThreadView\("files"\)/);
});

test("module panel close buttons stay hidden while outside click and Escape remain available", async () => {
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");
  assert.match(html, /id="closeModelSettings" type="button" hidden>关闭<\/button>/);
  assert.match(html, /id="closeThreads" type="button" hidden>关闭<\/button>/);
});

test("new-session and project views can independently hide dot-prefixed folders", async () => {
  const [source, html, styles] = await Promise.all([
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="newDotFolderFilter"[\s\S]*?>筛选：关<\/button>/);
  assert.match(html, /id="projectDotFolderFilter"[\s\S]*?>筛选：关<\/button>/);
  assert.match(source, /item\.type === "dir" && String\(item\.name \|\| ""\)\.startsWith\("\."\)/);
  assert.match(source, /row\.dataset\.dotFolder = String\(isDotFolder\(item\)\)/);
  assert.match(source, /state\.hideProjectDotFolders = !state\.hideProjectDotFolders/);
  assert.match(source, /state\.hideNewSessionDotFolders = !state\.hideNewSessionDotFolders/);
  assert.match(styles, /\.fileItem\[hidden\][\s\S]*?display:\s*none/);
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
