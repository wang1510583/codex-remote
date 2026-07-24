import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CodexAppServer } from "../src/codex-server.js";
import {
  fullReplyItemTextLimit, fullReplyMessageFromThreadItem,
  parseSessionFile, truncateFullReplyText
} from "../src/threads.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("session history exposes assistant, reasoning, tool, patch, and MCP output separately", () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const turnId = "22222222-2222-4222-8222-222222222222";
  const parsed = parseSessionFile(jsonl([
    { timestamp: "2026-07-23T01:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: "/workspace" } },
    {
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查项目" }] }
    },
    {
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "reason-1",
        summary: [{ type: "summary_text", text: "先定位相关文件" }],
        content: [],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    },
    {
      timestamp: "2026-07-23T01:00:03.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "tool-1",
        call_id: "call-1",
        name: "exec",
        input: "find . -type f",
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    },
    {
      timestamp: "2026-07-23T01:00:04.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: [{ type: "input_text", text: "src/app.js" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    },
    {
      timestamp: "2026-07-23T01:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        turn_id: turnId,
        call_id: "patch-1",
        success: true,
        changes: { "src/app.js": { unified_diff: "@@ -1 +1 @@\n-old\n+new" } }
      }
    },
    {
      timestamp: "2026-07-23T01:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        turn_id: turnId,
        call_id: "mcp-1",
        app_name: "GitHub",
        action_name: "search",
        invocation: { arguments: { query: "codex" } },
        result: { Ok: { content: [{ type: "text", text: "Action completed." }] } }
      }
    },
    {
      timestamp: "2026-07-23T01:00:07.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "answer-1",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "检查完成" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    },
    {
      timestamp: "2026-07-23T01:00:08.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId, duration_ms: 7000 }
    }
  ]), `/tmp/rollout-test-${threadId}.jsonl`, 20);

  assert.deepEqual(parsed.messages.map((message) => message.content), ["检查项目", "✅ 检查完成"]);
  assert.equal(parsed.messages[1].taskDurationMs, 7000);
  assert.equal(parsed.fullMessageCount, 7);
  assert.deepEqual(parsed.fullMessages.map((message) => message.fullKind), [
    "", "reasoning", "tool-call", "tool-output", "patch", "mcp", "assistant"
  ]);
  assert.match(parsed.fullMessages[1].content, /先定位相关文件/);
  assert.match(parsed.fullMessages[3].content, /src\/app\.js/);
  assert.match(parsed.fullMessages[4].content, /@@ -1 \+1 @@/);
  assert.match(parsed.fullMessages[5].content, /GitHub · search/);
});

test("full CLI output has a per-item mobile safety limit", () => {
  const text = truncateFullReplyText("x".repeat(fullReplyItemTextLimit + 100));
  assert.ok(text.length < fullReplyItemTextLimit + 100);
  assert.match(text, /已截断/);

  const message = fullReplyMessageFromThreadItem({
    type: "commandExecution",
    id: "command-1",
    command: "printf test",
    aggregatedOutput: "y".repeat(fullReplyItemTextLimit + 100),
    exitCode: 0,
    status: "completed"
  }, { final: true, at: "2026-07-23T01:00:00.000Z" });
  assert.match(message.content, /终端命令 · 完成/);
  assert.match(message.content, /已截断/);
});

test("app-server reasoning and command output stream as stable CLI bubbles", () => {
  const events = [];
  const server = new CodexAppServer({});
  server.runner = { emit(event) { events.push(event); } };
  server.turn = {
    threadId: "thread-1",
    turnId: "turn-1",
    fullItems: new Map(),
    fullReplyMessages: new Map(),
    onActivity() {}
  };

  server.onNotification({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1784768400000,
      item: { type: "reasoning", id: "reason-1", summary: [], content: [] }
    }
  });
  server.onNotification({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reason-1",
      summaryIndex: 0,
      delta: "正在检查"
    }
  });
  server.onNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1784768401000,
      item: { type: "reasoning", id: "reason-1", summary: ["正在检查"], content: [] }
    }
  });
  server.onNotification({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "npm test",
        aggregatedOutput: "",
        exitCode: null,
        status: "inProgress"
      }
    }
  });
  server.onNotification({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      delta: "tests passed"
    }
  });

  const cliEvents = events.filter((event) => event.type === "cli_message");
  assert.ok(cliEvents.length >= 5);
  assert.equal(cliEvents[0].messageId, "cli-reason-1");
  assert.equal(cliEvents[1].messageId, "cli-reason-1");
  assert.match(cliEvents[1].content, /正在检查/);
  assert.equal(cliEvents[2].final, true);
  assert.equal(cliEvents.at(-1).messageId, "cli-command-1");
  assert.match(cliEvents.at(-1).content, /tests passed/);
  assert.equal(server.turn.fullReplyMessages.size, 2);
});

test("/full is persistent, requests full state, and renders live CLI events only when enabled", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const router = await readFile(new URL("../src/router.js", import.meta.url), "utf8");
  const external = await readFile(new URL("../src/external-sessions.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(source, /command:\s*"\/full"[\s\S]*?title:\s*"显示Codex完整回复"/);
  assert.match(source, /codex-remote-show-full-replies/);
  assert.match(source, /state\.showFullReplies\s*\?\s*"\/api\/remote\/state\?full=1"/);
  assert.match(source, /data\.type === "cli_message"[\s\S]*?state\.showFullReplies[\s\S]*?upsertAssistantMessage/);
  assert.match(source, /Array\.isArray\(data\.fullMessages\)[\s\S]*?data\.fullMessages/);
  assert.match(router, /url\.searchParams\.get\("full"\)\s*===\s*"1"/);
  assert.match(router, /liveFullMessagesFor\(runner\)/);
  assert.match(external, /snapshot\.fullMessageCount/);
  assert.match(external, /lastFullMessage\.content/);
  assert.match(styles, /\.message\.assistant\.fullReply[\s\S]*?background:\s*transparent/);
});
