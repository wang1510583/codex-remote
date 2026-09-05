import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadThreadFromProvider } from "../src/threads.js";

const threadId = "11111111-1111-4111-8111-111111111111";
const sessionFile = `/tmp/rollout-test-${threadId}.jsonl`;

function sessionWithMessages(count) {
  const rows = [{
    timestamp: "2026-08-06T00:00:00.000Z",
    type: "session_meta",
    payload: { id: threadId, cwd: "/tmp/project" }
  }];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      timestamp: `2026-08-06T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `message-${index}` }]
      }
    });
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("history provider can page beyond the former 1000-message ceiling", async () => {
  const text = sessionWithMessages(1005);
  const provider = {
    async listFiles() { return [{ file: sessionFile, mtimeMs: Date.now() }]; },
    async readFile() { return text; }
  };

  const thread = await loadThreadFromProvider(threadId, provider, 1005);

  assert.equal(thread.messageCount, 1005);
  assert.equal(thread.messages.length, 1005);
  assert.equal(thread.messages[0].content, "message-0");
});

test("load-more UI prevents duplicate requests and guards thread switches", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const router = await readFile(new URL("../src/router.js", import.meta.url), "utf8");

  assert.match(source, /state\.running \|\| state\.loadingMore/);
  assert.match(source, /JSON\.stringify\(\{ threadId \}\)/);
  assert.match(source, /threadId !== state\.threadId/);
  assert.match(source, /state\.loadingMore = false;[\s\S]*?updateLoadMore\(\)/);
  assert.match(router, /nextLimit[\s\S]*?state\.loadedCount[\s\S]*?messagePageSize/);
  assert.match(router, /body\.threadId !== state\.threadId/);
});
