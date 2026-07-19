import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex-server.js";

function activeTurn(options = {}) {
  const events = [];
  const runner = {
    reconnecting: false,
    emit(event) { events.push(event); }
  };
  const server = new CodexAppServer({});
  server.runner = runner;
  let resolveTurn;
  let rejectTurn;
  const promise = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const turn = {
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: Date.now(),
    answers: options.answers || [],
    answerMessages: [],
    currentMessage: options.currentMessage || null,
    completedMessageIds: new Set(),
    imageIds: new Set(),
    pendingImages: [],
    reconnecting: false,
    reconnectMessage: "",
    lastError: null,
    onActivity: options.onActivity || null,
    resolve: resolveTurn,
    reject: rejectTurn
  };
  server.turn = turn;
  return { server, runner, turn, promise, events };
}

function errorNotification(willRetry, message = "stream disconnected") {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry,
      error: { message, codexErrorInfo: null, additionalDetails: null }
    }
  };
}

function completedNotification(status = "completed", error = null) {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status, error }
    }
  };
}

test("a retryable Codex error keeps the turn alive until turn/completed", async () => {
  const { server, runner, turn, promise, events } = activeTurn({ answers: ["✅ 任务已完成"] });
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });

  server.onNotification(errorNotification(true, "Reconnecting... 2/5"));
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(server.turn, turn);
  assert.equal(runner.reconnecting, true);
  assert.deepEqual(events.at(-1), {
    type: "reconnecting",
    reconnecting: true,
    message: "Reconnecting... 2/5",
    running: true
  });

  server.onNotification(completedNotification("completed"));
  assert.deepEqual(await promise, ["✅ 任务已完成"]);
  assert.equal(server.turn, null);
  assert.equal(runner.reconnecting, false);
  assert.equal(events.at(-1).reconnecting, false);
});

test("a non-retry error still waits for the final failed turn status", async () => {
  const { server, turn, promise } = activeTurn({ answers: ["🤔 已产生的部分回复"] });
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });

  server.onNotification(errorNotification(false, "temporary error notification"));
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(server.turn, turn);

  const finalError = { message: "final turn failure", codexErrorInfo: { kind: "stream" }, additionalDetails: null };
  server.onNotification(completedNotification("failed", finalError));
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, "final turn failure");
    assert.deepEqual(error.codexErrorInfo, { kind: "stream" });
    assert.equal(error.partialAnswer, "🤔 已产生的部分回复");
    return true;
  });
  assert.equal(server.turn, null);
});

test("activity after reconnect clears the reconnecting indicator without completing the turn", async () => {
  let activityCount = 0;
  const { server, runner, turn, promise } = activeTurn({ onActivity: () => { activityCount += 1; } });
  server.onNotification(errorNotification(true));

  server.onNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "继续执行" }
  });

  assert.equal(activityCount, 2);
  assert.equal(runner.reconnecting, false);
  assert.equal(server.turn, turn);
  server.onNotification(completedNotification("completed"));
  assert.deepEqual(await promise, ["继续执行"]);
});

test("context usage emits only the runner's complete status payload", () => {
  const { server, events } = activeTurn();
  server.onContextUpdate = (contextUsage) => server.emit({ type: "status", running: true, contextUsage });

  server.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 250 },
          model_context_window: 1000
        }
      }
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "status");
  assert.equal(events[0].running, true);
  assert.equal(events[0].contextUsage.remainingPercent, 75);
});

test("notifications from another concurrent turn are ignored", async () => {
  let activityCount = 0;
  const { server, turn, promise, events } = activeTurn({ onActivity: () => { activityCount += 1; } });

  server.onNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-2", turnId: "turn-2", itemId: "other-answer", delta: "不应串入" }
  });
  server.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-2",
      turnId: "turn-2",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 900 }, model_context_window: 1000 } }
    }
  });

  assert.equal(server.turn, turn);
  assert.equal(turn.currentMessage, null);
  assert.equal(server.contextUsage, null);
  assert.equal(activityCount, 0);
  assert.deepEqual(events, []);

  server.onNotification(completedNotification("completed"));
  assert.deepEqual(await promise, []);
});

test("a replayed completed message id is emitted and saved only once", async () => {
  const { server, turn, promise, events } = activeTurn();
  const notification = {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "msg-stable-1",
        text: "只应出现一次",
        phase: "commentary"
      }
    }
  };

  server.onNotification(notification);
  server.onNotification(notification);

  assert.deepEqual(turn.answers, ["🤔 只应出现一次"]);
  assert.deepEqual(turn.answerMessages, [{
    content: "🤔 只应出现一次",
    messageId: "msg-stable-1",
    final: true,
    taskDurationMs: null
  }]);
  assert.equal(events.filter((event) => event.type === "message").length, 1);
  assert.equal(events.filter((event) => event.type === "reply_done").length, 1);

  server.onNotification(completedNotification("completed"));
  assert.deepEqual(await promise, ["🤔 只应出现一次"]);
});
