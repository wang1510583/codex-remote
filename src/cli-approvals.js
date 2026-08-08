import { randomUUID } from "node:crypto";
import { cliApprovalTimeoutMs } from "./config.js";
import { sendNativeApprovalRequired } from "./native-notifications.js";
import { broadcast } from "./sse.js";
import { cleanText } from "./utils.js";

function cliApprovalDisplay(input = {}, requestId = randomUUID()) {
  const tool = cleanText(String(input.tool_name || ""), 160);
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const isCommand = tool === "Bash";
  const isFile = ["apply_patch", "Edit", "Write"].includes(tool);
  const command = cleanText(String(toolInput.command || ""), 30000);
  const summary = cleanText(String(toolInput.description || command || tool || "Codex CLI 权限请求"), 240);
  return {
    type: "approval_request",
    requestId,
    approvalScope: `cli:${cleanText(String(input.session_id || "external"), 160)}`,
    method: "cli/permissionRequest",
    kind: isCommand ? "command" : (isFile ? "file" : "tool"),
    title: isCommand ? "Codex CLI 命令确认" : (isFile ? "Codex CLI 文件修改确认" : "Codex CLI 工具确认"),
    threadId: cleanText(String(input.session_id || ""), 160),
    turnId: cleanText(String(input.turn_id || ""), 160),
    tool,
    command: isCommand ? command : "",
    arguments: isCommand ? undefined : toolInput,
    summary,
    reason: cleanText(String(toolInput.description || ""), 500),
    cwd: cleanText(String(input.cwd || ""), 2000),
    canAcceptForSession: false,
    startedAtMs: Date.now()
  };
}

function decisionBehavior(decision = "") {
  return ["accept", "acceptForSession", "allow"].includes(String(decision)) ? "allow" : "deny";
}

export function createCliApprovalBroker(options = {}) {
  const pending = new Map();
  const broadcastFn = options.broadcastFn || broadcast;
  const notifyFn = options.notifyFn || sendNativeApprovalRequired;
  const timeoutMs = Number(options.timeoutMs ?? cliApprovalTimeoutMs);
  const setTimer = options.setTimeoutFn || setTimeout;
  const clearTimer = options.clearTimeoutFn || clearTimeout;

  function keyFor(request = {}) {
    return `${request.approvalScope || ""}:${request.requestId || ""}`;
  }

  function pendingPayload() {
    return [...pending.values()]
      .map((entry) => entry.display)
      .sort((left, right) => Number(left.startedAtMs || 0) - Number(right.startedAtMs || 0));
  }

  function request(input = {}) {
    const display = cliApprovalDisplay(input);
    const key = keyFor(display);
    return new Promise((resolve) => {
      const finish = (behavior = "prompt") => {
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        clearTimer(entry.timer);
        broadcastFn({
          type: "approval_resolved",
          requestId: display.requestId,
          approvalScope: display.approvalScope,
          method: display.method
        });
        resolve({ behavior });
      };
      const timer = setTimer(() => finish("prompt"), Math.max(1000, timeoutMs));
      timer?.unref?.();
      pending.set(key, { display, finish, timer });
      broadcastFn(display);
      try {
        notifyFn(display);
      } catch (error) {
        console.error("native CLI approval notification failed", error?.message || error);
      }
    });
  }

  function respond(body = {}) {
    const key = keyFor(body);
    const entry = pending.get(key);
    if (!entry) return false;
    const behavior = decisionBehavior(body.decision);
    entry.finish(behavior);
    return { decision: behavior, source: "cli-hook" };
  }

  return { pendingPayload, request, respond };
}

const cliApprovalBroker = createCliApprovalBroker();

export const pendingCliApprovalsPayload = () => cliApprovalBroker.pendingPayload();
export const requestCliApproval = (input) => cliApprovalBroker.request(input);
export const respondToCliApproval = (body) => cliApprovalBroker.respond(body);
