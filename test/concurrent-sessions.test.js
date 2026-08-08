import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunner,
  executionConflictForState,
  isRunnerSelected,
  listedThreadRuntime,
  liveMessagesFor,
  pendingApprovalsPayload,
  rememberRunnerThread,
  respondToRemoteApproval,
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

test("a loaded idle runtime overrides a missing JSONL completion record", async () => {
  const idleRunner = { running: false, state: { threadId: "thread-finished", inflight: null } };
  const parsed = {
    threadId: "thread-finished",
    taskRunning: true,
    taskStartedAt: new Date().toISOString()
  };
  const reconciled = [];

  assert.deepEqual(await listedThreadRuntime(
    idleRunner,
    null,
    parsed,
    Date.now(),
    "",
    async (state, snapshot) => {
      reconciled.push({ state, snapshot });
      return { ...snapshot, running: false, externalRunning: false };
    }
  ), {
    externalRunning: false,
    running: false
  });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].state.threadId, "thread-finished");
  assert.equal(reconciled[0].snapshot.running, true);
});

test("an unowned recent JSONL task remains externally running when no live idle state exists", async () => {
  const parsed = {
    threadId: "thread-external",
    taskRunning: true,
    taskStartedAt: new Date().toISOString()
  };

  assert.deepEqual(await listedThreadRuntime(
    null,
    null,
    parsed,
    Date.now(),
    "",
    async (_state, snapshot) => snapshot
  ), {
    externalRunning: true,
    running: true
  });
});

test("global pending approvals include every conversation and keep colliding request ids separate", async (t) => {
  resetRunners();
  t.after(resetRunners);
  const decisions = [];
  const appServer = (approvalScope, connectorId, threadId) => ({
    approvalScope,
    pendingApprovalRequests() {
      return [{ requestId: "1", approvalScope, connectorId, threadId, turnId: `turn-${threadId}`, method: "item/commandExecution/requestApproval", startedAtMs: approvalScope === "scope-a" ? 1 : 2 }];
    },
    hasPendingServerRequest(requestId) { return String(requestId) === "1"; },
    respondToApprovalRequest(body) {
      decisions.push({ approvalScope, body });
      return { ok: true, approvalScope };
    }
  });
  runners.set("first", { key: "first", connectorId: "", appServer: appServer("scope-a", "", "thread-a") });
  runners.set("second", { key: "second", connectorId: "remote-a", appServer: appServer("scope-b", "remote-a", "thread-b") });

  assert.deepEqual(pendingApprovalsPayload().map((row) => `${row.approvalScope}:${row.requestId}`), [
    "scope-a:1",
    "scope-b:1"
  ]);
  assert.deepEqual(pendingApprovalsPayload("").map((row) => row.approvalScope), ["scope-a"]);

  assert.deepEqual(await respondToRemoteApproval({
    requestId: "1",
    approvalScope: "scope-b",
    decision: "accept"
  }), { ok: true, approvalScope: "scope-b" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approvalScope, "scope-b");

  assert.deepEqual(await respondToRemoteApproval({
    requestId: "1",
    approvalScope: "scope-before-reconnect",
    threadId: "thread-a",
    turnId: "turn-thread-a",
    method: "item/commandExecution/requestApproval",
    decision: "accept"
  }), { ok: true, approvalScope: "scope-a" });
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].approvalScope, "scope-a");
});

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
