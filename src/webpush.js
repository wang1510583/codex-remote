import webPush from "web-push";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, pushVapidPath, pushSubscriptionsPath, externalBasePath, wechatGatewayUrl, wechatGatewayToken, wechatTarget, wechatSource } from "./config.js";
import { cleanText } from "./utils.js";

export let webPushPublicKey = "";

function pushNotificationBody(text = "") {
  return String(text)
    .replace(/^[✅🤔]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Codex 有新的回复";
}

export function completionMessage(answers = []) {
  return [...answers]
    .reverse()
    .map((answer) => String(answer || "").trim())
    .find((answer) => /^✅\s/.test(answer)) || "";
}

async function readPushVapid() {
  if (process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY) {
    return { publicKey: process.env.WEB_PUSH_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_PRIVATE_KEY };
  }
  try {
    const parsed = JSON.parse(await readFile(pushVapidPath, "utf8"));
    if (parsed?.publicKey && parsed?.privateKey) return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const keys = webPush.generateVAPIDKeys();
  await mkdir(dataDir, { recursive: true });
  await writeFile(pushVapidPath, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return keys;
}

export async function setupWebPush() {
  const keys = await readPushVapid();
  webPushPublicKey = keys.publicKey;
  webPush.setVapidDetails(process.env.WEB_PUSH_SUBJECT || "mailto:admin@lempet.top", keys.publicKey, keys.privateKey);
}

async function readPushSubscriptions() {
  try {
    const parsed = JSON.parse(await readFile(pushSubscriptionsPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    if (error instanceof SyntaxError) {
      console.error(`failed to parse ${pushSubscriptionsPath}; resetting saved push subscriptions`, error.message);
      return [];
    }
    throw error;
  }
}

async function writePushSubscriptions(subscriptions) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(pushSubscriptionsPath, `${JSON.stringify(subscriptions, null, 2)}\n`, { mode: 0o600 });
}

function pushSubscriptionKey(subscription = {}) {
  return createHash("sha256").update(String(subscription.endpoint || "")).digest("hex");
}

export async function savePushSubscription(subscription = {}) {
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    const error = new Error("Push 订阅信息不完整。");
    error.statusCode = 400;
    throw error;
  }
  const subscriptions = await readPushSubscriptions();
  const key = pushSubscriptionKey(subscription);
  const row = { key, subscription, updatedAt: new Date().toISOString() };
  const next = [row, ...subscriptions.filter((item) => item?.key !== key)].slice(0, 20);
  await writePushSubscriptions(next);
  console.log(`web push subscription saved: ${key} (${next.length} total)`);
  return { key, count: next.length };
}

export async function sendWebPushTaskDone(text) {
  if (!webPushPublicKey || !text) return { sent: 0, removed: 0, total: 0 };
  const rows = await readPushSubscriptions();
  if (!rows.length) return { sent: 0, removed: 0, total: 0 };
  const payload = JSON.stringify({
    title: "服务器Codex",
    body: pushNotificationBody(text),
    tag: `codex-done-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    url: `${externalBasePath || "."}/`,
    icon: "icon.svg",
    badge: "icon.svg"
  });
  const kept = [];
  let sent = 0;
  for (const row of rows) {
    try {
      await webPush.sendNotification(row.subscription, payload);
      sent += 1;
      kept.push(row);
    } catch (error) {
      const status = Number(error.statusCode || error.status);
      if (status === 404 || status === 410) continue;
      console.error("web push notification failed", error.message || error);
      kept.push(row);
    }
  }
  if (kept.length !== rows.length) await writePushSubscriptions(kept);
  return { sent, removed: rows.length - kept.length, total: rows.length };
}

async function sendWechatMessage(text) {
  if (!text || !wechatGatewayUrl || !wechatGatewayToken || !wechatTarget) {
    console.error("wechat task notification skipped: missing gateway config");
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${wechatGatewayUrl}/api/wechat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${wechatGatewayToken}` },
      body: JSON.stringify({ to: wechatTarget, text, source: wechatSource }),
      signal: controller.signal
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${bodyText}`);
    console.log(`wechat task notification accepted: HTTP ${response.status} ${bodyText}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export function notifyWechatTaskDone(text) {
  console.log(`wechat task notification matched: ${cleanText(text, 80).replace(/\s+/g, " ")}`);
  sendWechatMessage(text).catch((error) => {
    console.error("wechat task notification failed", error.message || error);
  });
}
