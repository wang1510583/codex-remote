import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");

export function loadEnvFile(file = path.join(rootDir, ".env")) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

export const port = Number(process.env.PORT || 5566);
export const host = process.env.HOST || "0.0.0.0";
export const codexBin = process.env.CODEX_BIN || "/root/.local/bin/codex";
// Empty means "use the effective Codex CLI config". These environment variables
// are explicit overrides, not defaults: forcing them changes model/list ordering
// and makes the web UI disagree with the CLI model picker.
export const codexModel = process.env.CODEX_MODEL || "";
export const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT || "";
export const codexWorkDir = process.env.CODEX_WORK_DIR || path.dirname(rootDir);
export const publicDir = path.join(rootDir, "public");
export const routePrefix = process.env.CODEX_REMOTE_ROUTE_PREFIX || "/codex-remote";
export const externalBasePath = process.env.CODEX_REMOTE_BASE_PATH || routePrefix;

export const dataDir = path.join(rootDir, "data");
export const uploadDir = path.join(dataDir, "uploads");
export const generatedImageDir = path.join(dataDir, "generated-images");
export const restartScript = path.join(rootDir, "restart-codex-remote.cmd");
export const statePath = path.join(dataDir, "remote-state.json");
export const threadNamesPath = path.join(dataDir, "thread-names.json");
export const draftsPath = path.join(dataDir, "drafts.json");
export const followModesPath = path.join(dataDir, "follow-modes.json");
export const threadModelSettingsPath = path.join(dataDir, "thread-model-settings.json");
export const messageMetaPath = path.join(dataDir, "message-meta.json");
export const threadCompletionsPath = path.join(dataDir, "thread-completions.json");
export const pushVapidPath = path.join(dataDir, "push-vapid.json");
export const pushSubscriptionsPath = path.join(dataDir, "push-subscriptions.json");
export const connectorStatePath = path.join(dataDir, "connectors.json");
export const connectorsViewStatePath = path.join(dataDir, "connector-view.json");
export const sessionsDir = path.join(os.homedir(), ".codex", "sessions");

export const wechatGatewayUrl = (process.env.WECHAT_GATEWAY_URL || "").replace(/\/+$/, "");
export const wechatGatewayToken = process.env.WECHAT_GATEWAY_TOKEN || "";
export const wechatTarget = process.env.WECHAT_TO || "";
export const wechatSource = process.env.WECHAT_SOURCE || "codex-remote-web";

export const remotePassword = process.env.CODEX_REMOTE_PASSWORD || process.env.REMOTE_PASSWORD || (process.env.CODEX_REMOTE_PASSWORD_B64 ? Buffer.from(process.env.CODEX_REMOTE_PASSWORD_B64, "base64").toString("utf8") : "") || (process.env.REMOTE_LOGIN_B64 ? Buffer.from(process.env.REMOTE_LOGIN_B64, "base64").toString("utf8") : "");
export const connectorPairToken = process.env.CODEX_REMOTE_CONNECTOR_TOKEN || remotePassword;
export const authCookieName = "codex_remote_auth";
export const authSecret = process.env.CODEX_REMOTE_AUTH_SECRET || randomBytes(32).toString("hex");
export const authToken = createHash("sha256").update(`${remotePassword}:${authSecret}`).digest("hex");

export const defaultMessageLimit = 10;
export const messagePageSize = 10;
export const codexConnectWaitMs = Number(process.env.CODEX_CONNECT_WAIT_MS || 5000);
export const codexConnectTimeoutMs = Number(process.env.CODEX_CONNECT_TIMEOUT_MS || 60000);
// A turn can legitimately take a while, but it must not leave the web session
// permanently busy when app-server fails to emit turn/completed.
export const codexTurnTimeoutMs = Number(process.env.CODEX_TURN_TIMEOUT_MS || 20 * 60 * 1000);
export const connectorPollMs = Number(process.env.CODEX_REMOTE_CONNECTOR_POLL_MS || 3000);
export const connectorHeartbeatTimeoutMs = Number(process.env.CODEX_REMOTE_CONNECTOR_HEARTBEAT_MS || 180000);
export const disableLocal = /^(1|true|yes|on)$/i.test(process.env.CODEX_REMOTE_DISABLE_LOCAL || "");
