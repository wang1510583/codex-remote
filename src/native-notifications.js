import { WebSocketServer } from "ws";
import { nativeNotificationClickUrl, nativeNotificationToken } from "./config.js";
import { routePath } from "./auth.js";
import { cleanText, safeCompare } from "./utils.js";

const WEBSOCKET_PATH = "/api/notifications/ws";

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

export function createNativeNotificationHub(options = {}) {
  const token = String(options.token ?? nativeNotificationToken ?? "");
  const defaultClickUrl = String(options.clickUrl ?? nativeNotificationClickUrl ?? "");
  const logger = options.logger || console;
  const clients = new Set();
  let wss = null;
  let attachedServer = null;

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
        deviceId: cleanText(String(req.headers["x-device-id"] || ""), 160),
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
          entry.deviceId = cleanText(String(message.deviceId || entry.deviceId), 160);
          entry.appName = cleanText(String(message.appName || entry.appName), 120);
          ws.send(JSON.stringify({ type: "ack", ts: Date.now() }));
        }
      });

      const remove = () => {
        if (!clients.delete(entry)) return;
        logger.log(`native notification client disconnected (${clients.size} total)`);
      };
      ws.on("close", remove);
      ws.on("error", remove);
    });

    if (!token) {
      logger.warn("WebToApp native notifications are disabled: CODEX_REMOTE_NOTIFICATION_TOKEN is empty.");
    }
    return wss;
  }

  function sendNotification({ title = "服务器Codex", body = "", url = defaultClickUrl } = {}) {
    const payload = JSON.stringify({
      type: "notification",
      title: String(title || "服务器Codex").slice(0, 120),
      body: notificationBody(body),
      url: String(url || ""),
      ts: Date.now()
    });
    const total = clients.size;
    let sent = 0;
    for (const entry of [...clients]) {
      if (entry.ws.readyState !== 1) {
        clients.delete(entry);
        continue;
      }
      try {
        entry.ws.send(payload);
        sent += 1;
      } catch (error) {
        logger.error("native notification send failed", error?.message || error);
      }
    }
    return { configured: Boolean(token), sent, total };
  }

  function sendTaskDone(text) {
    if (!text) return { configured: Boolean(token), sent: 0, total: clients.size };
    return sendNotification({ body: text });
  }

  return { attach, sendNotification, sendTaskDone, status };
}

const nativeNotificationHub = createNativeNotificationHub();

export const attachNativeNotificationWebSocket = (server) => nativeNotificationHub.attach(server);
export const sendNativeTaskDone = (text) => nativeNotificationHub.sendTaskDone(text);
export const nativeNotificationStatus = () => nativeNotificationHub.status();
