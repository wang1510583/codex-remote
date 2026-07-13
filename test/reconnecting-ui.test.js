import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("state refresh preserves the server reconnecting state", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const renderState = source.slice(
    source.indexOf("function renderState(data)"),
    source.indexOf("function renderModelSettings")
  );
  assert.match(renderState, /setRunning\([^;]+data\.runningThreads,\s*data\.reconnecting,\s*data\.externalRunning\)/);
});

test("reconnecting remains a running state in the browser", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const setRunning = source.slice(
    source.indexOf("function setRunning("),
    source.indexOf("function updateMeta()")
  );
  assert.match(setRunning, /state\.reconnecting\s*=\s*state\.running\s*&&\s*!state\.externalRunning\s*&&\s*Boolean\(reconnecting\)/);
  assert.match(source, /Codex 正在重新连接 · 任务继续等待/);
});
