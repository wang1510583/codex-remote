import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunner,
  executionConflictForState,
  isRunnerSelected,
  liveMessagesFor,
  rememberRunnerThread,
  runnerForIncomingState,
  runnerForState,
  runners,
  runningThreads,
  setSelectedRunnerKey,
  writeRunnerStateIfSelected
} from "../src/runner.js";

function localState(runtimeId, cwd = "same-project") {
  return {
    threadId: "",
    runtimeId,
    connectorId: "",
    cwd,
    model: "test-model",
    reasoningEffort: "medium",
    messages: []
  };
}

function resetRunners() {
  for (const runner of new Set(runners.values())) runner.appServer?.transport?.kill?.();
  runners.clear();
  setSelectedRunnerKey("");
}

test("live state snapshots preserve completed app-server message ids", () => {
  const runner = {
    running: true,
    appServer: {
      turn: {
        answers: ["🤔 已检查"],
        answerMessages: [{
          content: "🤔 已检查",
          messageId: "msg-original-1",
          final: true,
          taskDurationMs: null
        }],
        currentMessage: { id: "msg-streaming-2", text: "继续处理", phase: "commentary" }
      }
    }
  };

  assert.deepEqual(liveMessagesFor(runner), [
    {
      role: "assistant",
      content: "🤔 已检查",
      messageId: "msg-original-1",
      final: true,
      taskDurationMs: null
    },
    {
      role: "assistant",
      content: "🤔 继续处理",
      messageId: "msg-streaming-2",
      transient: true
    }
  ]);
});

test("different local conversations in the same folder own independent execution channels", async (t) => {
  resetRunners();
  t.after(resetRunners);

  const first = await createRunner(localState("runtime-a"));
  const second = await createRunner(localState("runtime-b"));

  assert.notEqual(first.key, second.key);
  assert.notEqual(first.appServer, second.appServer);
  assert.notEqual(first.appServer.transport, second.appServer.transport);
  assert.equal(executionConflictForState(first.state, second), null);

  first.running = true;
  second.running = true;
  assert.deepEqual(
    runningThreads().map((item) => item.runnerKey).sort(),
    [first.key, second.key].sort()
  );

  first.running = false;
  assert.deepEqual(runningThreads().map((item) => item.runnerKey), [second.key]);
});

test("concurrent creation requests for one conversation reuse the same runner", async (t) => {
  resetRunners();
  t.after(resetRunners);
  const state = localState("one-runtime");

  const [first, second] = await Promise.all([
    runnerForState({ ...state }, true),
    runnerForState({ ...state }, true)
  ]);

  assert.equal(first, second);
  assert.equal(new Set(runners.values()).size, 1);
});

test("a new thread is re-keyed without selecting or overwriting another conversation", async (t) => {
  resetRunners();
  t.after(resetRunners);
  const first = await createRunner(localState("runtime-a"));
  const second = await createRunner(localState("runtime-b"));
  const oldKey = first.key;
  setSelectedRunnerKey(first.key);

  first.state.threadId = "11111111-1111-4111-8111-111111111111";
  first.state.model = "";
  await rememberRunnerThread(first, first.state);

  assert.equal(first.key, "thread:11111111-1111-4111-8111-111111111111");
  assert.equal(first.state.runtimeId, "");
  assert.equal(runners.has(oldKey), false);
  assert.equal(isRunnerSelected(first), true);

  setSelectedRunnerKey(second.key);
  assert.equal(await writeRunnerStateIfSelected(first), false);
  assert.equal(isRunnerSelected(second), true);
});

test("an unrecognized new-session id is not replaced by a running same-folder task", async (t) => {
  resetRunners();
  t.after(resetRunners);
  const existing = await createRunner(localState("runtime-a"));
  existing.running = true;

  const selected = await runnerForIncomingState(localState("runtime-b"));
  assert.equal(selected, null);
});
