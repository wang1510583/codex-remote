import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Live Voice ownership is excluded from external-session read-only detection", async () => {
  const source = await readFile(
    new URL("../src/external-sessions.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /isLiveVoiceThreadActive/);
  assert.match(
    source,
    /externalSessionSnapshot[\s\S]*?!connectorId && isLiveVoiceThreadActive\(threadId\)[\s\S]*?return null/
  );
  assert.match(
    source,
    /monitorExternalSession[\s\S]*?!connectorId && isLiveVoiceThreadActive\(threadId\)/
  );
});

test("web messages are routed to the existing Live Voice owner before starting a runner", async () => {
  const source = await readFile(
    new URL("../src/runner.js", import.meta.url),
    "utf8"
  );
  const submit = source.slice(
    source.indexOf("export async function submitRemoteMessage"),
    source.indexOf("export async function mapWithConcurrency")
  );
  assert.match(submit, /isLiveVoiceThreadActive\(selectedState\.threadId\)/);
  assert.match(submit, /return submitLiveVoiceMessage\(text, selectedState\)/);
  assert.ok(
    submit.indexOf("submitLiveVoiceMessage(text, selectedState)")
      < submit.indexOf("externalStatusForState(selectedState, true)")
  );

  const coordinator = source.slice(
    source.indexOf("async function submitLiveVoiceMessage"),
    source.indexOf("export async function submitRemoteMessage")
  );
  assert.match(coordinator, /sendLiveVoiceThreadInput/);
  assert.match(coordinator, /interruptLiveVoiceThreadTask/);
  assert.match(coordinator, /externalRunning:\s*false/);
});

test("browser status distinguishes connected voice, detached voice task, and external tasks", async () => {
  const source = await readFile(
    new URL("../public/remote.js", import.meta.url),
    "utf8"
  );
  const setRunning = source.slice(
    source.indexOf("function setRunning("),
    source.indexOf("function updateMeta()")
  );
  assert.match(setRunning, /state\.liveVoiceRunning/);
  assert.match(setRunning, /state\.externalRunning\s*=\s*state\.running\s*&&\s*!state\.liveVoiceRunning/);
  assert.match(setRunning, /els\.sendSteer\.disabled\s*=\s*false/);
  assert.match(source, /Live Voice 已断线 · 后台任务继续执行 · 等待重连/);
});

test("Live Voice owns a dedicated feature-enabled app-server", async () => {
  const runtimeSource = await readFile(
    new URL("../src/live-voice/runtime.js", import.meta.url),
    "utf8"
  );
  assert.match(
    runtimeSource,
    /appServerFactory\s*=\s*\(\)\s*=>\s*createLocalAppServer\(\{[\s\S]*?realtime:\s*true,[\s\S]*?useShared:\s*false[\s\S]*?\}\)/
  );

  const serverSource = await readFile(
    new URL("../src/codex-server.js", import.meta.url),
    "utf8"
  );
  const factory = serverSource.slice(serverSource.indexOf("export function createLocalAppServer"));
  assert.match(factory, /extraArgs:\s*realtime\s*\?\s*\["--enable", "realtime_conversation"\]/);
  assert.match(factory, /useShared:\s*options\.useShared !== false/);
});
