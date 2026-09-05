import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const remoteJsUrl = new URL("../public/remote.js", import.meta.url);
const remoteHtmlUrl = new URL("../public/remote.html", import.meta.url);

test("slash panel exposes every installed Mem0 skill with direct execution", async () => {
  const source = await readFile(remoteJsUrl, "utf8");
  const skills = [
    "onboard",
    "health",
    "remember",
    "peek",
    "tour",
    "stats",
    "list-projects",
    "switch-project",
    "pin",
    "forget",
    "memory-reviewer",
    "dream",
    "export",
    "import",
    "context-loader",
    "mem0"
  ];

  for (const skill of skills) {
    assert.match(source, new RegExp(`command:\\s*"\\$mem0:${skill.replace("-", "\\-")}"[\\s\\S]*?execute:\\s*true`));
  }
  assert.match(source, /else if \(item\.execute\) executeSkillCommand\(item\.command\)/);
  assert.match(source, /sendMessage\("steer"\)/);
});

test("slash panel explains that Mem0 items execute immediately", async () => {
  const source = await readFile(remoteHtmlUrl, "utf8");
  assert.match(source, /Codex \/ 命令与 Mem0/);
  assert.match(source, /Mem0 技能点击后直接执行/);
});
