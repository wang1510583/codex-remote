import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadThreadFromProvider, localSessionProvider } from "../src/threads.js";

const threadId = "11111111-1111-4111-8111-111111111111";
const sessionFile = `/tmp/rollout-test-${threadId}.jsonl`;
test("local history reads a file tail and expands it only when requested", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recent-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, path.basename(sessionFile));
  const text = sessionWithMessages(6000);
  await writeFile(file, text);
  const provider = {
    listFiles: async () => [{ file }],
    readRecentFile: localSessionProvider.readRecentFile,
    readFile: async () => { throw new Error('must not read the entire file'); }
  };
  const recent = await provider.readRecentFile(file, 10);
  assert.ok(Buffer.byteLength(recent.text) < Buffer.byteLength(text) / 2);
  const initial = await loadThreadFromProvider(threadId, provider);
  assert.equal(initial.messages.length, 10);
  assert.equal(initial.messages[0].content, 'message-5990');
  assert.equal(initial.cwd, '/tmp/project');
  assert.equal(initial.hasMore, true);
  assert.equal(initial.fullMessages.length, 10);
  const expanded = await loadThreadFromProvider(threadId, provider, 6000);
  assert.equal(expanded.messages.length, 6000);
  assert.equal(expanded.hasMore, false);
});

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
