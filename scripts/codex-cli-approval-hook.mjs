#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function projectEnv() {
  try {
    const values = {};
    for (const line of readFileSync(path.join(rootDir, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const env = projectEnv();
const token = process.env.CODEX_REMOTE_CLI_HOOK_TOKEN
  || env.CODEX_REMOTE_CLI_HOOK_TOKEN
  || env.CODEX_REMOTE_NOTIFICATION_TOKEN
  || "";
const port = process.env.CODEX_REMOTE_CLI_HOOK_PORT || env.PORT || "5566";
const prefix = (process.env.CODEX_REMOTE_CLI_HOOK_PREFIX || env.CODEX_REMOTE_ROUTE_PREFIX || "/codex-remote").replace(/\/+$/, "");
const endpoint = process.env.CODEX_REMOTE_CLI_HOOK_URL || `http://127.0.0.1:${port}${prefix}/api/remote/cli/approval`;

try {
  const payload = JSON.parse(await readStdin());
  if (!token) throw new Error("CODEX_REMOTE_CLI_HOOK_TOKEN / CODEX_REMOTE_NOTIFICATION_TOKEN is not configured");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(590_000)
  });
  if (!response.ok) throw new Error(`Codex Remote returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.behavior === "allow" || result.behavior === "deny") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: result.behavior }
      }
    }));
  } else {
    process.stdout.write("{}");
  }
} catch (error) {
  // Fail open to Codex's normal local confirmation UI. A broken remote link
  // must never silently approve or deny a CLI command.
  process.stderr.write(`Codex Remote approval hook unavailable: ${error?.message || error}\n`);
  process.stdout.write("{}");
}
