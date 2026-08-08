import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import {
  nativeNotificationQueuePath,
  nativeNotificationToken
} from "./config.js";
import { routePath } from "./auth.js";
import { cleanText, safeCompare, taskNotificationTitle } from "./utils.js";

const WEBSOCKET_PATH = "/api/notifications/ws";
const MAX_STORED_NOTIFICATIONS = 200;
const MAX_ACKNOWLEDGEMENTS_PER_DEVICE = 240;
const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function notificationBody(text = "") {
  return String(text)
    .replace(/^[✅🤔]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Codex 有新的回复";
}

function bearerToken(req) {
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function rejectUpgrade(socket, statusCode, statusText) {
  if (socket.destroyed) return;
  socket.write([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    "Connection: close",
    "Content-Length: 0",
    "",
    ""
  ].join("\r\n"));
  socket.destroy();
}

function safeDeviceId(value = "") {
  return cleanText(String(value || ""), 160);
}

function emptyDeliveryStore() {
  return { version: 1, notifications: [], acknowledgements: {} };
}

function normalizeDeliveryStore(value) {
  const source = value && typeof value === "object" ? value : {};
  const notifications = (Array.isArray(source.notifications) ? source.notifications : [])
    .map((item) => ({
      id: cleanText(String(item?.id || ""), 160),
      title: cleanText(String(item?.title || "服务器Codex"), 120) || "服务器Codex",
      body: notificationBody(item?.body),
      ts: Number(item?.ts) || 0
    }))
    .filter((item) => item.id && item.ts > 0);
  const acknowledgements = {};
  const rawAcknowledgements = source.acknowledgements && typeof source.acknowledgements === "object"
    ? source.acknowledgements
    : {};
  for (const [rawDeviceId, rawIds] of Object.entries(rawAcknowledgements)) {
    const deviceId = safeDeviceId(rawDeviceId);
    if (!deviceId || !Array.isArray(rawIds)) continue;
    acknowledgements[deviceId] = [...new Set(rawIds
      .map((id) => cleanText(String(id || ""), 160))
      .filter(Boolean))]
      .slice(-MAX_ACKNOWLEDGEMENTS_PER_DEVICE);
  }
  return { version: 1, notifications, acknowledgements };
}

function readDeliveryStore(file, logger) {
  if (!file || !existsSync(file)) return emptyDeliveryStore();
  try {
    return normalizeDeliveryStore(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    logger.error("failed to read native notification queue", error?.message || error);
    return emptyDeliveryStore();
  }
}

function websocketReason(reason) {
  return cleanText(Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""), 120);
}

export function createNativeNotificationHub(options = {}) {
  const token = String(options.token ?? nativeNotificationToken ?? "");
  const logger = options.logger || console;
  const queuePath = options.queuePath ?? nativeNotificationQueuePath;
  const clients = new Set();
  let deliveryStore = readDeliveryStore(queuePath, logger);
  let approvalNotificationsSuppressed = Boolean(options.approvalNotificationsSuppressed);
  let wss = null;
  let attachedServer = null;

  function pruneDeliveryStore() {
    const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
    deliveryStore.notifications = deliveryStore.notifications
      .filter((item) => item.ts >= cutoff)
      .slice(-MAX_STORED_NOTIFICATIONS);
    const knownIds = new Set(deliveryStore.notifications.map((item) => item.id));
    for (const [deviceId, ids] of Object.entries(deliveryStore.acknowledgements)) {
      const remaining = ids.filter((id) => knownIds.has(id)).slice(-MAX_ACKNOWLEDGEMENTS_PER_DEVICE);
      if (remaining.length) deliveryStore.acknowledgements[deviceId] = remaining;
      else delete deliveryStore.acknowledgements[deviceId];
    }
  }

  function persistDeliveryStore() {
    if (!queuePath) return;
    pruneDeliveryStore();
    try {
      mkdirSync(path.dirname(queuePath), { recursive: true });
      const temporaryPath = `${queuePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(deliveryStore, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, queuePath);
    } catch (error) {
      logger.error("failed to persist native notification queue", error?.message || error);
    }
  }

  function notificationPayload(notification) {
    return JSON.stringify({
      type: "notification",
      id: notification.id,
      title: notification.title,
      body: notification.body,
      ts: notification.ts
    });
  }

  function sendToClient(entry, notification) {
    if (entry.ws.readyState !== 1) return false;
    try {
      entry.ws.send(notificationPayload(notification));
      return true;
    } catch (error) {
      logger.error("native notification send failed", error?.message || error);
      return false;
    }
  }

  function replayPending(entry) {
    const deviceId = safeDeviceId(entry.deviceId);
    if (!deviceId) return 0;
    pruneDeliveryStore();
    const acknowledged = new Set(deliveryStore.acknowledgements[deviceId] || []);
    let sent = 0;
    for (const notification of deliveryStore.notifications) {
      if (acknowledged.has(notification.id)) continue;
      if (sendToClient(entry, notification)) sent += 1;
    }
    if (sent) logger.log(`native notification client replayed ${sent} queued notification(s)`);
    return sent;
  }

  function acknowledge(entry, id) {
    const deviceId = safeDeviceId(entry.deviceId);
    const notificationId = cleanText(String(id || ""), 160);
    if (!deviceId || !notificationId) return;
    if (!deliveryStore.notifications.some((item) => item.id === notificationId)) return;
    const ids = new Set(deliveryStore.acknowledgements[deviceId] || []);
    if (ids.has(notificationId)) return;
    ids.add(notificationId);
    deliveryStore.acknowledgements[deviceId] = [...ids].slice(-MAX_ACKNOWLEDGEMENTS_PER_DEVICE);
    persistDeliveryStore();
  }

  function status() {
    return {
      configured: Boolean(token),
      connected: clients.size
    };
  }

  function attach(server) {
    if (attachedServer === server && wss) return wss;
    if (attachedServer && attachedServer !== server) {
      throw new Error("Native notification hub is already attached to another server.");
    }
    attachedServer = server;
    wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://localhost");
      // Accept both the configured route prefix and a prefix preserved by a
      // reverse proxy. Deployments in the wild use both /codexremote and
      // /codex-remote, while the endpoint suffix itself stays stable.
      if (routePath(url.pathname) !== WEBSOCKET_PATH && !url.pathname.endsWith(WEBSOCKET_PATH)) return;
      if (!token) {
        rejectUpgrade(socket, 503, "Notification Token Not Configured");
        return;
      }
      // WebToApp sends its authToken as an Authorization header. Do not accept
      // query-string credentials because reverse proxies commonly log URLs.
      const suppliedToken = bearerToken(req);
      if (!safeCompare(suppliedToken, token)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    wss.on("connection", (ws, req) => {
      const entry = {
        ws,
        deviceId: safeDeviceId(req.headers["x-device-id"]),
        appName: cleanText(String(req.headers["x-app-name"] || ""), 120),
        connectedAt: new Date().toISOString()
      };
      clients.add(entry);
      logger.log(`native notification client connected (${clients.size} total)`);

      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          return;
        }
        if (message?.type === "hello") {
          entry.deviceId = safeDeviceId(message.deviceId || entry.deviceId);
          entry.appName = cleanText(String(message.appName || entry.appName), 120);
          ws.send(JSON.stringify({ type: "ack", ts: Date.now() }));
          replayPending(entry);
          return;
        }
        if (message?.type === "notification_ack") {
          acknowledge(entry, message.id);
        }
      });

      const remove = (code = 1006, reason = "") => {
        if (!clients.delete(entry)) return;
        const detail = websocketReason(reason);
        logger.log(
          `native notification client disconnected (${clients.size} total; code ${code}${detail ? `, ${detail}` : ""})`
        );
      };
      ws.on("close", remove);
      ws.on("error", (error) => remove(1006, error?.message || "socket error"));
    });

    if (!token) {
      logger.warn("WebToApp native notifications are disabled: CODEX_REMOTE_NOTIFICATION_TOKEN is empty.");
    }
    return wss;
  }

  function sendNotification({ title = "服务器Codex", body = "" } = {}) {
    const notification = {
      id: randomUUID(),
      title: String(title || "服务器Codex").slice(0, 120),
      body: notificationBody(body),
      ts: Date.now()
    };
    deliveryStore.notifications.push(notification);
    persistDeliveryStore();

    const total = clients.size;
    let sent = 0;
    for (const entry of [...clients]) {
      if (entry.ws.readyState !== 1) {
        clients.delete(entry);
        continue;
      }
      if (sendToClient(entry, notification)) sent += 1;
    }
    return { configured: Boolean(token), sent, total };
  }

  function sendTaskDone(text) {
    if (!text) return { configured: Boolean(token), sent: 0, total: clients.size };
    return sendNotification({ title: taskNotificationTitle(text), body: text });
  }

  function sendApprovalRequired(request = {}) {
    if (approvalNotificationsSuppressed) {
      return { configured: Boolean(token), sent: 0, total: clients.size, suppressed: true };
    }
    const requestTitle = cleanText(String(request.title || "Codex 请求确认"), 120) || "Codex 请求确认";
    const summary = cleanText(String(request.summary || request.reason || ""), 240).trim();
    const detail = summary && summary !== requestTitle ? `：${summary}` : "";
    return sendNotification({
      title: "Codex等待审核",
      body: `⚠️ ${requestTitle}${detail}。请打开 Codex 网页手动确认。`
    });
  }

  function setApprovalNotificationsSuppressed(suppressed = false) {
    approvalNotificationsSuppressed = Boolean(suppressed);
    return { approvalNotificationsSuppressed };
  }

  function approvalNotificationPreference() {
    return { approvalNotificationsSuppressed };
  }

  return {
    attach,
    sendNotification,
    sendTaskDone,
    sendApprovalRequired,
    setApprovalNotificationsSuppressed,
    approvalNotificationPreference,
    status
  };
}

const nativeNotificationHub = createNativeNotificationHub();

export const attachNativeNotificationWebSocket = (server) => nativeNotificationHub.attach(server);
export const sendNativeTaskDone = (text) => nativeNotificationHub.sendTaskDone(text);
export const sendNativeApprovalRequired = (request) => nativeNotificationHub.sendApprovalRequired(request);
export const setApprovalNotificationsSuppressed = (suppressed) => nativeNotificationHub.setApprovalNotificationsSuppressed(suppressed);
export const approvalNotificationPreference = () => nativeNotificationHub.approvalNotificationPreference();
export const nativeNotificationStatus = () => nativeNotificationHub.status();
