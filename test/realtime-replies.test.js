import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { currentEventSeq, sendSnapshot } from "../src/sse.js";

test("SSE connection snapshots do not consume replay sequence numbers", () => {
  const writes = [];
  const response = {
    destroyed: false,
    writableEnded: false,
    write(value) { writes.push(value); }
  };
  const before = currentEventSeq();

  sendSnapshot(response, { type: "status", running: true, seq: before + 100 });

  assert.equal(currentEventSeq(), before);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /"seq"\s*:/);
});

test("stale HTTP state snapshots cannot replace newer SSE-rendered replies", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function isCurrentStateSnapshot"),
    source.indexOf("async function loadState")
  );
  const context = {
    state: { lastEventSeq: 20 }
  };
  vm.createContext(context);
  vm.runInContext(`let stateLoadGeneration = 4; ${helper}`, context);

  assert.equal(vm.runInContext("isCurrentStateSnapshot(3, 20)", context), false);
  assert.equal(vm.runInContext("isCurrentStateSnapshot(4, 19)", context), false);
  assert.equal(vm.runInContext("isCurrentStateSnapshot(4, 20)", context), true);
  assert.equal(vm.runInContext("isCurrentStateSnapshot(4, undefined)", context), true);
});

test("completed assistant bubbles are not reused by a later reply with the same fallback id", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function assistantBubbleByMessageId"),
    source.indexOf("function localNoticeContext")
  );
  const active = { dataset: { messageId: "assistant", final: "false" } };
  const completed = { dataset: { messageId: "assistant", final: "true" } };
  const context = {
    els: { log: { querySelectorAll: () => [completed, active] } }
  };
  vm.createContext(context);
  vm.runInContext(helper, context);

  assert.equal(vm.runInContext('assistantBubbleByMessageId("assistant")', context), active);
  context.els.log.querySelectorAll = () => [completed];
  assert.equal(vm.runInContext('assistantBubbleByMessageId("assistant")', context), null);
  assert.equal(vm.runInContext('assistantBubbleByMessageId("assistant", true)', context), completed);
});

test("a stable completed message id is idempotent across Android replay", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function stableAssistantMessageId"),
    source.indexOf("function closeCommandMenu")
  );
  const completed = {
    dataset: { messageId: "msg-stable-1", final: "true" },
    isConnected: true
  };
  let appendCount = 0;
  let updateCount = 0;
  const context = {
    state: { assistantBubbles: new Map(), localNotices: [], threadId: "thread-1", cwd: "project", selectedConnectorId: "" },
    els: { log: { querySelectorAll: () => [completed] } },
    setMessageContent() { updateCount += 1; },
    appendMessage() {
      appendCount += 1;
      return { dataset: {}, isConnected: true };
    },
    isNearBottom: () => true,
    scrollToLatest() {},
    requestAnimationFrame() {},
    request: async () => ({})
  };
  vm.createContext(context);
  vm.runInContext(helper, context);

  vm.runInContext('upsertAssistantMessage("🤔 同一条", true, "msg-stable-1", { type: "message" })', context);
  vm.runInContext('upsertAssistantMessage("🤔 迟到的片段", false, "msg-stable-1", { type: "message" })', context);

  assert.equal(appendCount, 0);
  assert.equal(updateCount, 1);
});

test("EventSource open always replays the state-to-stream gap and buffers live events", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const connect = source.slice(source.indexOf("function connectEvents"), source.indexOf("function resyncWhenActive"));
  const resync = source.slice(source.indexOf("async function resyncEvents"), source.indexOf("function connectEvents"));
  const router = await readFile(new URL("../src/router.js", import.meta.url), "utf8");

  assert.match(connect, /source\.onopen[\s\S]*?resyncEvents\(\)/);
  assert.doesNotMatch(connect, /if \(shouldResync\)/);
  assert.match(connect, /state\.resyncingEvents && remoteEventSequence\(data\)[\s\S]*?pendingRemoteEvents\.push\(data\)/);
  assert.match(resync, /processRemoteEvents\(\[\.\.\.\(data\.events \|\| \[\]\), \.\.\.buffered\]\)/);
  assert.match(router, /const snapshotEventSeq = currentEventSeq\(\)/);
  assert.match(router, /eventSeq:\s*snapshotEventSeq/);
});

test("running tasks have a lightweight replay fallback for silent Android EventSource stalls", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const setRunning = source.slice(source.indexOf("function setRunning"), source.indexOf("function updateMeta"));
  const reconcile = source.slice(source.indexOf("function updateRealtimeReconcile"), source.indexOf("function connectEvents"));

  assert.match(setRunning, /updateRealtimeReconcile\(\)/);
  assert.match(reconcile, /if \(!state\.running\)[\s\S]*?clearTimeout\(realtimeReconcileTimer\)/);
  assert.match(reconcile, /setTimeout\(async \(\) =>[\s\S]*?resyncEvents\(\)[\s\S]*?, 3000\)/);
});
