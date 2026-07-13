import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { externalSnapshotFromThread, isExternalTaskRunning } from "../src/external-sessions.js";
import { parseSessionFile } from "../src/threads.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("session JSONL exposes external task lifecycle and final duration", () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const turnId = "22222222-2222-4222-8222-222222222222";
  const parsed = parseSessionFile(jsonl([
    { timestamp: "2026-07-13T01:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: "/workspace" } },
    { timestamp: "2026-07-13T01:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId, started_at: 1783904401 } },
    { timestamp: "2026-07-13T01:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在检查" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
    { timestamp: "2026-07-13T01:00:04.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "已完成" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
    { timestamp: "2026-07-13T01:00:05.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId, completed_at: 1783904405, duration_ms: 4000 } }
  ]), `/tmp/rollout-test-${threadId}.jsonl`, 20);

  assert.equal(parsed.threadId, threadId);
  assert.equal(parsed.cwd, "/workspace");
  assert.equal(parsed.taskRunning, false);
  assert.equal(parsed.activeTurnId, "");
  assert.equal(parsed.taskStartedAt, "2026-07-13T01:00:01.000Z");
  assert.equal(parsed.taskCompletedAt, "2026-07-13T01:00:05.000Z");
  assert.deepEqual(parsed.messages.map((message) => message.content), ["🤔 正在检查", "✅ 已完成"]);
  assert.equal(parsed.messages[1].taskDurationMs, 4000);
});

test("an unmatched recent task_started is externally running", () => {
  const threadId = "33333333-3333-4333-8333-333333333333";
  const turnId = "44444444-4444-4444-8444-444444444444";
  const parsed = parseSessionFile(jsonl([
    { timestamp: new Date().toISOString(), type: "session_meta", payload: { id: threadId, cwd: "/workspace" } },
    { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: turnId } }
  ]), `/tmp/rollout-test-${threadId}.jsonl`);
  const snapshot = externalSnapshotFromThread({ ...parsed, file: `/tmp/${threadId}.jsonl`, mtimeMs: Date.now() }, "");

  assert.equal(snapshot.running, true);
  assert.equal(snapshot.externalRunning, true);
  assert.equal(snapshot.externalTurnId, turnId);
});

test("a fork keeps its canonical file id instead of copied parent session metadata", () => {
  const childId = "55555555-5555-4555-8555-555555555555";
  const parentId = "66666666-6666-4666-8666-666666666666";
  const parsed = parseSessionFile(jsonl([
    {
      timestamp: "2026-07-13T01:00:00.000Z",
      type: "session_meta",
      payload: { id: childId, parent_thread_id: parentId, thread_source: "subagent", cwd: "/child" }
    },
    {
      timestamp: "2026-07-13T00:00:00.000Z",
      type: "session_meta",
      payload: { id: parentId, thread_source: "user", cwd: "/parent" }
    }
  ]), `/tmp/rollout-test-${childId}.jsonl`);

  assert.equal(parsed.threadId, childId);
  assert.equal(parsed.threadSource, "subagent");
  assert.equal(parsed.parentThreadId, parentId);
  assert.equal(parsed.cwd, "/child");
});

test("turn_aborted ends an externally observed task", () => {
  const threadId = "77777777-7777-4777-8777-777777777777";
  const turnId = "88888888-8888-4888-8888-888888888888";
  const parsed = parseSessionFile(jsonl([
    { timestamp: "2026-07-13T01:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: "/workspace" } },
    { timestamp: "2026-07-13T01:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-07-13T01:00:05.000Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted", completed_at: 1783904405, duration_ms: 4000 } }
  ]), `/tmp/rollout-test-${threadId}.jsonl`);

  assert.equal(parsed.taskRunning, false);
  assert.equal(parsed.activeTurnId, "");
  assert.equal(parsed.taskCompletedAt, "2026-07-13T01:00:05.000Z");
  assert.equal(isExternalTaskRunning(parsed, Date.now()), false);
});

test("an abandoned task_started becomes idle after the stale window", () => {
  assert.equal(isExternalTaskRunning({ taskRunning: true }, Date.now() - (3 * 60 * 60 * 1000)), false);
  assert.equal(isExternalTaskRunning({ taskRunning: false }, Date.now()), false);
});

test("external session monitor supports local and connector session providers", async () => {
  const source = await readFile(new URL("../src/external-sessions.js", import.meta.url), "utf8");
  assert.match(source, /connectorId\s*\?\s*remoteSessionProvider\(connectorId\)\s*:\s*localSessionProvider/);
  assert.match(source, /provider\.listFiles\(\)/);
  assert.match(source, /provider\.readFile\(hit\.file\)/);
});

test("sending is rejected before a second writer starts on an external session", async () => {
  const source = await readFile(new URL("../src/runner.js", import.meta.url), "utf8");
  const submit = source.slice(
    source.indexOf("export async function submitRemoteMessage"),
    source.indexOf("export async function listThreads")
  );
  assert.match(submit, /if \(!selectedRunner\?\.running\)\s*\{[\s\S]*?await assertExternalSessionIdle\(selectedState\)/);
  assert.ok(submit.indexOf("assertExternalSessionIdle(selectedState)") < submit.indexOf("localCommandResponse(text, connectorId)"));
});
