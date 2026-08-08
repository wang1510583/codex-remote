import assert from "node:assert/strict";
import test from "node:test";
import { createCliApprovalBroker } from "../src/cli-approvals.js";

test("a Codex CLI permission hook is broadcast and waits for the matching web decision", async () => {
  const events = [];
  const notifications = [];
  const broker = createCliApprovalBroker({
    broadcastFn(event) { events.push(event); },
    notifyFn(request) { notifications.push(request); },
    timeoutMs: 60_000
  });

  const waiting = broker.request({
    session_id: "cli-thread-1",
    turn_id: "turn-1",
    cwd: "/workspace",
    tool_name: "Bash",
    tool_input: { command: "npm test", description: "运行测试" }
  });
  const [pending] = broker.pendingPayload();

  assert.equal(pending.approvalScope, "cli:cli-thread-1");
  assert.equal(pending.kind, "command");
  assert.equal(pending.command, "npm test");
  assert.equal(events[0].type, "approval_request");
  assert.equal(notifications.length, 1);
  assert.deepEqual(broker.respond({
    requestId: pending.requestId,
    approvalScope: pending.approvalScope,
    decision: "accept"
  }), { decision: "allow", source: "cli-hook" });
  assert.deepEqual(await waiting, { behavior: "allow" });
  assert.equal(broker.pendingPayload().length, 0);
  assert.equal(events.at(-1).type, "approval_resolved");
});

test("a mismatched CLI approval scope cannot resolve another session", async () => {
  const broker = createCliApprovalBroker({ broadcastFn() {}, notifyFn() {}, timeoutMs: 60_000 });
  const waiting = broker.request({ session_id: "owner", tool_name: "Bash", tool_input: { command: "id" } });
  const [pending] = broker.pendingPayload();

  assert.equal(broker.respond({ requestId: pending.requestId, approvalScope: "cli:other", decision: "accept" }), false);
  assert.equal(broker.pendingPayload().length, 1);
  broker.respond({ requestId: pending.requestId, approvalScope: pending.approvalScope, decision: "decline" });
  assert.deepEqual(await waiting, { behavior: "deny" });
});
