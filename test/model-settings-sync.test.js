import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CodexAppServer } from "../src/codex-server.js";
import { externalSnapshotFromThread } from "../src/external-sessions.js";
import { preferredModelSettings } from "../src/runner.js";
import { shouldReplaceThreadModelSettings } from "../src/store.js";
import { parseSessionFile } from "../src/threads.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("thread_settings_applied exposes the session model and reasoning effort", () => {
  const parsed = parseSessionFile(jsonl([
    {
      timestamp: "2026-07-13T01:00:00.000Z",
      type: "session_meta",
      payload: { id: "11111111-1111-4111-8111-111111111111", cwd: "/workspace" }
    },
    {
      timestamp: "2026-07-13T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.5", reasoning_effort: "high" }
      }
    }
  ]), "/tmp/rollout-settings-11111111-1111-4111-8111-111111111111.jsonl");

  assert.equal(parsed.model, "gpt-5.5");
  assert.equal(parsed.reasoningEffort, "high");
  assert.equal(parsed.settingsUpdatedAt, "2026-07-13T01:00:01.000Z");
});

test("a later turn_context replaces older applied thread settings", () => {
  const parsed = parseSessionFile(jsonl([
    {
      timestamp: "2026-07-13T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.5", reasoning_effort: "high" }
      }
    },
    {
      timestamp: "2026-07-13T01:00:02.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", effort: "ultra" }
    }
  ]), "/tmp/rollout-settings-22222222-2222-4222-8222-222222222222.jsonl");

  assert.equal(parsed.model, "gpt-5.6-sol");
  assert.equal(parsed.reasoningEffort, "ultra");
  assert.equal(parsed.settingsUpdatedAt, "2026-07-13T01:00:02.000Z");
});

test("the newest timestamp wins between web-saved and observed session settings", () => {
  const saved = {
    model: "gpt-5.5",
    reasoningEffort: "medium",
    updatedAt: "2026-07-13T01:00:01.000Z",
    source: "web"
  };
  const observed = {
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    updatedAt: "2026-07-13T01:00:02.000Z",
    source: "session"
  };

  const tiedObserved = { ...observed, updatedAt: saved.updatedAt };
  assert.equal(preferredModelSettings(saved, observed), observed);
  assert.equal(preferredModelSettings({ ...saved, updatedAt: "2026-07-13T01:00:03.000Z" }, observed).model, "gpt-5.5");
  assert.equal(preferredModelSettings(saved, tiedObserved), tiedObserved);
  assert.equal(preferredModelSettings(saved, { ...observed, updatedAt: "" }), saved);
});

test("thread model setting persistence rejects a later-arriving older value", () => {
  const current = { updatedAt: "2026-07-13T02:00:00.000Z" };
  assert.equal(shouldReplaceThreadModelSettings(current, { updatedAt: "2026-07-13T01:59:59.000Z" }), false);
  assert.equal(shouldReplaceThreadModelSettings(current, { updatedAt: "2026-07-13T02:00:00.000Z" }), true);
  assert.equal(shouldReplaceThreadModelSettings(current, { updatedAt: "2026-07-13T02:00:01.000Z" }), true);
});

test("updating a thread uses thread/settings/update and waits for the applied notification", async () => {
  const calls = [];
  const server = new CodexAppServer({}, { isRemote: true });
  server.ensureStarted = async () => {};
  server.readThreadSettings = async () => ({ model: "gpt-5.5", reasoningEffort: "medium" });
  server.waitForThreadSettingsUpdate = () => ({
    promise: Promise.resolve({
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra"
    }),
    cancel() {}
  });
  server.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  const result = await server.updateThreadModelSettings({
    threadId: "thread-1",
    cwd: "/workspace",
    model: "gpt-5.6-sol",
    effort: "ultra"
  });

  assert.deepEqual(calls, [{
    method: "thread/settings/update",
    params: {
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      effort: "ultra"
    }
  }]);
  assert.deepEqual(result, { model: "gpt-5.6-sol", effort: "ultra" });
});

test("unsupported settings methods fail instead of claiming an ignored resume override", async () => {
  const calls = [];
  let cancelled = false;
  const server = new CodexAppServer({}, { isRemote: true });
  server.ensureStarted = async () => {};
  server.readThreadSettings = async () => ({ model: "gpt-5.5", reasoningEffort: "medium" });
  server.waitForThreadSettingsUpdate = () => ({ promise: Promise.resolve(null), cancel() { cancelled = true; } });
  server.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/settings/update") throw new Error("Method not found: thread/settings/update");
    throw new Error(`unexpected fallback: ${method}`);
  };

  await assert.rejects(server.updateThreadModelSettings({
    threadId: "thread-1",
    cwd: "/workspace",
    model: "gpt-5.6-sol",
    effort: "ultra"
  }), /Method not found/);

  assert.equal(cancelled, true);
  assert.deepEqual(calls.map((call) => call.method), ["thread/settings/update"]);
});

test("ordinary settings update failures are propagated", async () => {
  const calls = [];
  const server = new CodexAppServer({}, { isRemote: true });
  server.ensureStarted = async () => {};
  server.readThreadSettings = async () => ({ model: "gpt-5.5", reasoningEffort: "medium" });
  server.waitForThreadSettingsUpdate = () => ({ promise: Promise.resolve(null), cancel() {} });
  server.request = async (method) => {
    calls.push(method);
    throw new Error("connection reset");
  };

  await assert.rejects(server.updateThreadModelSettings({
    threadId: "thread-1",
    cwd: "/workspace",
    model: "gpt-5.6-sol",
    effort: "ultra"
  }), /connection reset/);
  assert.deepEqual(calls, ["thread/settings/update"]);
});

test("external session snapshots and SSE updates carry model settings", async () => {
  const snapshot = externalSnapshotFromThread({
    threadId: "thread-1",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    settingsUpdatedAt: "2026-07-13T01:00:02.000Z"
  });

  assert.equal(snapshot.model, "gpt-5.6-sol");
  assert.equal(snapshot.reasoningEffort, "ultra");
  assert.equal(snapshot.settingsUpdatedAt, "2026-07-13T01:00:02.000Z");

  const source = await readFile(new URL("../src/external-sessions.js", import.meta.url), "utf8");
  const pollMonitor = source.slice(
    source.indexOf("async function pollMonitor"),
    source.indexOf("export function monitorExternalSession")
  );
  assert.match(pollMonitor, /model:\s*next\.model/);
  assert.match(pollMonitor, /reasoningEffort:\s*next\.reasoningEffort/);
  assert.match(pollMonitor, /settingsUpdatedAt:\s*next\.settingsUpdatedAt/);
});
