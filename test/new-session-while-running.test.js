import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser allows opening and creating a session while the selected task runs", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const setRunning = source.slice(
    source.indexOf("function setRunning("),
    source.indexOf("function updateMeta(")
  );
  const createSession = source.slice(
    source.indexOf("async function createSessionInSelectedFolder("),
    source.indexOf("async function previewFile(")
  );
  const newChatStart = source.indexOf('els.newChat?.addEventListener("click"');
  const newChatHandler = source.slice(newChatStart, newChatStart + 180);

  assert.match(setRunning, /els\.newChat\.disabled = false/);
  assert.doesNotMatch(createSession, /if \(state\.running\) return/);
  assert.doesNotMatch(newChatHandler, /if \(state\.running\) return/);
  assert.match(newChatHandler, /openNewSessionPicker\(\)/);
});

test("creating a session preserves the busy runner instead of redirecting to it", async () => {
  const source = await readFile(new URL("../src/runner.js", import.meta.url), "utf8");
  const createSession = source.slice(
    source.indexOf("export async function createRemoteSession("),
    source.indexOf("export async function markThreadCompletedUnread(")
  );

  assert.doesNotMatch(createSession, /selectedRunnerKey = busy\.key/);
  assert.doesNotMatch(createSession, /return runnerStatePayload\(busy/);
  assert.match(createSession, /if \(!busy\) \{[\s\S]*?appServer\.activeThreadId = ""/);
  assert.match(createSession, /if \(!previousRunner\?\.externalTurn\) stopExternalSessionMonitor/);
  assert.match(createSession, /selectedRunnerKey = runnerKeyForState\(state\)/);
});

test("slash new keeps a running app-server intact and selects a fresh runtime", async () => {
  const source = await readFile(new URL("../src/runner.js", import.meta.url), "utf8");
  const command = source.slice(
    source.indexOf('if (command === "/new")'),
    source.indexOf('if (command === "/resume")')
  );

  assert.doesNotMatch(command, /当前不能新建线程/);
  assert.match(command, /if \(!currentRunner\?\.running\)/);
  assert.match(command, /selectedRunnerKey = runnerKeyForState\(nextState\)/);
  assert.match(command, /runningThreads: runningThreads\(\)/);
});
