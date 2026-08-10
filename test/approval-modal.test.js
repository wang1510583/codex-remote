import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { CodexAppServer } from "../src/codex-server.js";

function createServer() {
  const sent = [];
  const approvalNotifications = [];
  const server = new CodexAppServer({
    send(line) { sent.push(JSON.parse(line)); }
  }, {
    isRemote: true,
    notifyApprovalRequired(request) { approvalNotifications.push(request); }
  });
  return { server, sent, approvalNotifications };
}

function serverRequest(id, method, params = {}) {
  return JSON.stringify({ id, method, params });
}

function responseFor(sent, id) {
  return sent.find((message) => message.id === id);
}

test("command approval is held until the user responds", () => {
  const { server, sent, approvalNotifications } = createServer();
  server.onLine(serverRequest(1, "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    command: "echo hello"
  }));

  assert.equal(server.hasPendingServerRequest(1), true);
  const display = server.pendingApprovalRequests()[0];
  assert.equal(display.kind, "command");
  assert.equal(display.command, "echo hello");
  assert.equal(approvalNotifications.length, 1);
  assert.equal(approvalNotifications[0].requestId, "1");
  assert.equal(approvalNotifications[0].title, "命令执行确认");

  const result = server.respondToApprovalRequest({ requestId: 1, decision: "accept" });
  assert.equal(result.ok, true);
  assert.deepEqual(responseFor(sent, 1), { id: 1, result: { decision: "accept" } });
  assert.equal(server.hasPendingServerRequest(1), false);
});

test("a repeated pending approval request notifies the APK only once", () => {
  const { server, approvalNotifications } = createServer();
  const request = serverRequest(10, "item/commandExecution/requestApproval", {
    command: "npm test"
  });

  server.onLine(request);
  server.onLine(request);

  assert.equal(server.pendingApprovalRequests().length, 1);
  assert.equal(approvalNotifications.length, 1);
  assert.equal(approvalNotifications[0].command, "npm test");
});

test("file change approval can be declined", () => {
  const { server, sent } = createServer();
  server.onLine(serverRequest(2, "item/fileChange/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    reason: "update source"
  }));

  server.respondToApprovalRequest({ requestId: 2, decision: "decline" });
  assert.deepEqual(responseFor(sent, 2), { id: 2, result: { decision: "decline" } });
  assert.equal(server.hasPendingServerRequest(2), false);
});

test("permission approval returns turn scope by default and session scope on request", () => {
  const { server, sent } = createServer();
  const permissions = { fileSystem: { read: ["/workspace"] }, network: { enabled: true } };
  server.onLine(serverRequest(3, "item/permissions/requestApproval", { permissions }));
  server.onLine(serverRequest(4, "item/permissions/requestApproval", { permissions }));

  server.respondToApprovalRequest({ requestId: 3, decision: "accept" });
  server.respondToApprovalRequest({ requestId: 4, decision: "acceptForSession" });

  assert.deepEqual(responseFor(sent, 3).result, { permissions, scope: "turn" });
  assert.deepEqual(responseFor(sent, 4).result, { permissions, scope: "session" });
});

test("user input approval submits answers", () => {
  const { server, sent } = createServer();
  server.onLine(serverRequest(5, "item/tool/requestUserInput", {
    questions: [{ id: "q1", header: "Continue?" }]
  }));

  server.respondToApprovalRequest({
    requestId: 5,
    decision: "accept",
    answers: { q1: { answers: ["yes"] } }
  });

  assert.deepEqual(responseFor(sent, 5).result, { answers: { q1: { answers: ["yes"] } } });
});

test("MCP elicitation approval includes the filled form", () => {
  const { server, sent } = createServer();
  server.onLine(serverRequest(6, "mcpServer/elicitation/request", {
    message: "Fill the form",
    requestedSchema: { properties: { name: { type: "string" } } }
  }));

  server.respondToApprovalRequest({
    requestId: 6,
    decision: "accept",
    content: { name: "hello" }
  });

  assert.deepEqual(responseFor(sent, 6).result, { action: "accept", content: { name: "hello" } });
});

test("dynamic tool call approval allows the call", () => {
  const { server, sent } = createServer();
  server.onLine(serverRequest(7, "item/tool/call", {
    tool: "example",
    arguments: { path: "/tmp" }
  }));

  server.respondToApprovalRequest({ requestId: 7, decision: "allow" });
  assert.deepEqual(responseFor(sent, 7).result, { success: true, contentItems: [] });
});

test("currentTime server request is answered without an approval modal", () => {
  const { server, sent } = createServer();
  server.onLine(serverRequest(8, "currentTime/read", {}));
  const response = responseFor(sent, 8);
  assert.equal(response.id, 8);
  assert.equal(typeof response.result.currentTimeAt, "number");
  assert.equal(server.hasPendingServerRequest(8), false);
});

test("serverRequest/resolved removes the pending approval", () => {
  const { server } = createServer();
  server.onLine(serverRequest(9, "item/commandExecution/requestApproval", { command: "echo" }));
  assert.equal(server.hasPendingServerRequest(9), true);

  server.onNotification({ method: "serverRequest/resolved", params: { requestId: 9 } });
  assert.equal(server.hasPendingServerRequest(9), false);
});

test("the browser distinguishes identical approval ids from different app-server scopes", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const routerSource = await readFile(new URL("../src/router.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function approvalRequestKey"),
    source.indexOf("function queueApprovalRequest")
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(helper, context);

  assert.equal(vm.runInContext("approvalRequestKey({ requestId: '1', approvalScope: 'server-a' })", context), "server-a:1");
  assert.equal(vm.runInContext("approvalRequestKey({ requestId: '1', approvalScope: 'server-b' })", context), "server-b:1");
  assert.match(routerSource, /pendingApprovalsPayload\(\)/);
  assert.match(source, /approvalScope:\s*state\.pendingApproval\.approvalScope/);
  assert.match(source, /threadId:\s*state\.pendingApproval\.threadId/);
  assert.match(source, /审批请求不存在或已处理/);
});

test("a transient approval snapshot cannot dismiss a popup before the user acts", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helpers = source.slice(
    source.indexOf("function approvalRequestKey"),
    source.indexOf("function showNextApproval")
  );
  const context = {
    state: {
      pendingApproval: { requestId: "old", approvalScope: "stale" },
      pendingApprovalQueue: [
        { requestId: "queued-old", approvalScope: "stale" },
        { requestId: "keep", approvalScope: "live", title: "old title" }
      ]
    },
    clearApprovalModal() { context.state.pendingApproval = null; },
    renderApprovalModal() {},
    showNextApproval() {}
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  vm.runInContext("syncApprovalRequests([])", context);

  assert.equal(context.state.pendingApproval.requestId, "old");
  assert.deepEqual(
    context.state.pendingApprovalQueue.map((item) => `${item.approvalScope}:${item.requestId}:${item.title || ""}`),
    ["stale:queued-old:", "live:keep:old title"]
  );

  vm.runInContext(`syncApprovalRequests([
    { requestId: "keep", approvalScope: "live", title: "fresh title" },
    { requestId: "new", approvalScope: "live" }
  ])`, context);

  assert.equal(context.state.pendingApproval.requestId, "old");
  assert.deepEqual(
    context.state.pendingApprovalQueue.map((item) => `${item.approvalScope}:${item.requestId}:${item.title || ""}`),
    ["stale:queued-old:", "live:keep:fresh title", "live:new:"]
  );
});

test("transport resolution events retain the approval scope needed to close the matching popup", async () => {
  const source = await readFile(new URL("../src/codex-server.js", import.meta.url), "utf8");
  const rejectAll = source.slice(
    source.indexOf("  rejectAll(error)"),
    source.indexOf("  onLine(line)")
  );

  assert.match(rejectAll, /type:\s*"approval_resolved"[\s\S]*?approvalScope:\s*this\.approvalScope/);
});

test("the slash menu persists auto approval and automatically accepts safe approval dialogs", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(source, /autoApprove:\s*localStorage\.getItem\("codex-remote-auto-approve"\) === "1"/);
  assert.match(source, /command:\s*"\/autoapprove"[\s\S]*?action:\s*toggleAutoApproval/);
  assert.match(source, /localStorage\.setItem\("codex-remote-auto-approve", state\.autoApprove \? "1" : "0"\)/);
  assert.match(source, /\/api\/remote\/notifications\/approval-preference/);
  assert.match(source, /JSON\.stringify\(\{ autoApprove: state\.autoApprove \}\)/);
  assert.match(source, /state\.autoApprove \? syncAutoApprovalNotificationPreference\(\) : Promise\.resolve\(\)/);
  assert.match(source, /submitApproval\(automaticSubmission\.decision, automaticSubmission\.payload, \{ automatic: true \}\)/);
  assert.match(styles, /\.commandItemActive\s*\{/);

  const helper = source.slice(
    source.indexOf("function automaticElicitationContent"),
    source.indexOf("function autoApprovalDetail")
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(helper, context);

  assert.equal(vm.runInContext("automaticApprovalSubmission({ kind: 'command' }).decision", context), "accept");
  assert.equal(vm.runInContext("automaticApprovalSubmission({ kind: 'tool' }).decision", context), "allow");
  assert.equal(vm.runInContext("automaticApprovalSubmission({ kind: 'input' })", context), null);
  assert.equal(
    vm.runInContext("JSON.stringify(automaticApprovalSubmission({ kind: 'elicitation', schema: { properties: {} } }))", context),
    JSON.stringify({ decision: "accept", payload: { content: {} } })
  );
  assert.equal(
    vm.runInContext(`JSON.stringify(automaticApprovalSubmission({
      kind: "elicitation",
      schema: {
        required: ["enabled", "choice"],
        properties: {
          enabled: { type: "boolean" },
          choice: { enum: ["first", "second"] },
          optional: { type: "string" }
        }
      }
    }))`, context),
    JSON.stringify({ decision: "accept", payload: { content: { enabled: false, choice: "first" } } })
  );
  assert.equal(
    vm.runInContext(`automaticApprovalSubmission({
      kind: "elicitation",
      schema: { required: ["name"], properties: { name: { type: "string" } } }
    })`, context),
    null
  );

  const behavior = source.slice(
    source.indexOf("function automaticElicitationContent"),
    source.indexOf("function clearApprovalModal")
  );
  const submitted = [];
  const behaviorContext = {
    state: {
      autoApprove: true,
      pendingApproval: null,
      pendingApprovalQueue: [{ requestId: "auto-1", kind: "command" }],
      pendingApprovalSubmitting: false
    },
    els: {
      approvalModal: { hidden: false },
      approvalActions: { querySelector() { return null; } }
    },
    updateTaskExecutionDetail() {},
    approvalTaskDetail() { return "approval"; },
    renderTaskExecutionStatus() {},
    renderApprovalModal() {},
    submitApproval(...args) { submitted.push(args); },
    requestAnimationFrame(callback) { callback(); },
    localStorage: { setItem() {} },
    closeCommandMenu() {},
    appendEvent() {},
    renderCommandList() {}
  };
  vm.createContext(behaviorContext);
  vm.runInContext(behavior, behaviorContext);
  vm.runInContext("showNextApproval()", behaviorContext);

  assert.equal(behaviorContext.els.approvalModal.hidden, true);
  assert.equal(behaviorContext.state.pendingApproval.requestId, "auto-1");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0][0], "accept");
  assert.equal(submitted[0][2].automatic, true);
});
