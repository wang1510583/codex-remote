#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = path.join(rootDir, "scripts", "codex-cli-approval-hook.mjs");
const codexDir = path.join(os.homedir(), ".codex");
const hooksPath = path.join(codexDir, "hooks.json");
const command = `/usr/bin/node ${JSON.stringify(hookScript)}`;
const hook = { type: "command", command, timeout: 600, statusMessage: "等待 Codex 远程网页确认" };

mkdirSync(codexDir, { recursive: true });
let config = {};
if (existsSync(hooksPath)) config = JSON.parse(readFileSync(hooksPath, "utf8"));
if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) config.hooks = {};
if (!Array.isArray(config.hooks.PermissionRequest)) config.hooks.PermissionRequest = [];

const marker = "codex-cli-approval-hook.mjs";
config.hooks.PermissionRequest = config.hooks.PermissionRequest.filter((group) =>
  !Array.isArray(group?.hooks) || !group.hooks.some((entry) => String(entry?.command || "").includes(marker))
);
config.hooks.PermissionRequest.push({ matcher: "*", hooks: [hook] });
writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${hooksPath}\n`);
