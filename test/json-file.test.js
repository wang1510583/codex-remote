import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonFile, updateJsonFile, writeJsonFile } from "../src/json-file.js";

test("concurrent JSON updates do not overwrite each other", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-remote-json-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");

  await writeJsonFile(file, { count: 0, values: [] });
  await Promise.all(Array.from({ length: 100 }, (_, value) => (
    updateJsonFile(file, { count: 0, values: [] }, async (state) => {
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      state.count += 1;
      state.values.push(value);
      return state;
    })
  )));

  const state = await readJsonFile(file, {});
  assert.equal(state.count, 100);
  assert.equal(state.values.length, 100);
  assert.deepEqual([...state.values].sort((a, b) => a - b), Array.from({ length: 100 }, (_, index) => index));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), state);
});

test("a failed update releases the file lock", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-remote-json-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");

  await writeJsonFile(file, { value: 1 });
  await assert.rejects(
    updateJsonFile(file, {}, () => { throw new Error("expected failure"); }),
    /expected failure/
  );
  await updateJsonFile(file, {}, (state) => ({ ...state, value: 2 }));

  assert.deepEqual(await readJsonFile(file, {}), { value: 2 });
});
