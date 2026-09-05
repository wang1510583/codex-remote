import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the latest bubble is followed by a live Codex execution status", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const renderer = source.slice(
    source.indexOf("function formatWorkingElapsed("),
    source.indexOf("function appendMessage(")
  );
  const appendMessage = source.slice(
    source.indexOf("function appendMessage("),
    source.indexOf("function appendEvent(")
  );

  assert.match(renderer, /taskExecutionLabel\(\)/);
  assert.match(renderer, /Waiting for approval/);
  assert.match(renderer, /Reconnecting/);
  assert.match(renderer, /Working via Live Voice/);
  assert.match(renderer, /Esc to interrupt/);
  assert.match(renderer, /setInterval\(renderTaskExecutionStatus, 1000\)/);
  assert.match(renderer, /els\.log\.appendChild\(status\)/);
  assert.match(renderer, /taskExecutionDetailText\(\)/);
  assert.match(renderer, /等待 Codex 返回新进展/);
  assert.match(renderer, /最后更新 \$\{ageSeconds\}s 前/);
  assert.match(appendMessage, /els\.log\.appendChild\(wrapper\);\s*renderTaskExecutionStatus\(\)/);
});

test("real Codex stream events supply analysis, tool, patch, and blocked-stage details", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const detailFunctions = source.slice(
    source.indexOf("function compactTaskDetail("),
    source.indexOf("function taskExecutionCanInterrupt(")
  );
  const events = source.slice(
    source.indexOf("function handleRemoteEvent("),
    source.indexOf("function connectEvents(")
  );

  assert.match(detailFunctions, /正在分析/);
  assert.match(detailFunctions, /正在修改代码/);
  assert.match(detailFunctions, /正在调用工具/);
  assert.match(detailFunctions, /正在检查工具结果/);
  assert.match(detailFunctions, /等待批准/);
  assert.match(events, /data\.type === "cli_message"[\s\S]*?cliTaskDetail\(data\)/);
  assert.match(events, /data\.type === "reconnecting"[\s\S]*?连接异常/);
  assert.match(events, /data\.type === "message"[\s\S]*?正在分析/);
});

test("the live execution status supports click and Escape interruption", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const interrupt = source.slice(
    source.indexOf("async function interruptCurrentTask("),
    source.indexOf('els.form.addEventListener("submit"')
  );
  const escapeHandler = source.slice(
    source.indexOf('document.addEventListener("keydown", (event) => {'),
    source.indexOf("if (window.visualViewport)")
  );

  assert.match(interrupt, /message: "\/stop"/);
  assert.match(interrupt, /taskInterruptPending/);
  assert.match(escapeHandler, /!dismissedOverlay && taskExecutionCanInterrupt\(\)/);
  assert.match(escapeHandler, /interruptCurrentTask\(\)/);
});

test("execution status styling is subtle and respects reduced motion", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.taskExecutionStatus\s*\{[\s\S]*?font-family:[\s\S]*?font-size: 12px/);
  assert.match(css, /@keyframes taskExecutionPulse/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.taskExecutionStatus \{ animation: none; \}/);
});
