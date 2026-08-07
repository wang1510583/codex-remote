import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex-server.js";

function createServer() {
  const sent = [];
  const server = new CodexAppServer({
    send(line) { sent.push(JSON.parse(line)); }
  }, { isRemote: true });
  return { server, sent };
}

function serverRequest(id, method, params = {}) {
  return JSON.stringify({ id, method, params });
}

function responseFor(sent, id) {
  return sent.find((message) => message.id === id);
}

test("command approval is held until the user responds", () => {
  const { server, sent } = createServer();
  server.onLine(serverRequest(1, "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    command: "echo hello"
  }));

  assert.equal(server.hasPendingServerRequest(1), true);
  const display = server.pendingApprovalRequests()[0];
  assert.equal(display.kind, "command");
  assert.equal(display.command, "echo hello");

  const result = server.respondToApprovalRequest({ requestId: 1, decision: "accept" });
  assert.equal(result.ok, true);
  assert.deepEqual(responseFor(sent, 1), { id: 1, result: { decision: "accept" } });
  assert.equal(server.hasPendingServerRequest(1), false);
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
