import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import {
  connectorStatePath, connectorPairToken, codexModel, codexReasoningEffort,
  connectorHeartbeatTimeoutMs, dataDir
} from "./config.js";
import { cleanText, safeCompare, hashSecret, connectorNow } from "./utils.js";
import { broadcast } from "./sse.js";
import { CodexAppServer } from "./codex-server.js";
import { RemoteTransport } from "./transport/remote.js";

const tunnels = new Map();

function connectorId() {
  return `conn_${randomBytes(9).toString("hex")}`;
}

function cleanConnectorId(value) {
  return cleanText(value, 80).replace(/[^A-Za-z0-9_-]/g, "");
}

export function publicConnectorDevice(device) {
  const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0;
  return {
    id: device.id,
    name: device.name || device.hostname || device.id,
    hostname: device.hostname || "",
    platform: device.platform || "",
    arch: device.arch || "",
    version: device.version || "",
    codexVersion: device.codexVersion || "",
    remark: device.remark || "",
    registeredAt: device.registeredAt || "",
    lastSeen: device.lastSeen || "",
    online: lastSeenMs > 0 && Date.now() - lastSeenMs < 30000,
    lastStatus: device.lastStatus || "",
    lastError: device.lastError || ""
  };
}

async function readConnectorState() {
  try {
    const parsed = JSON.parse(await readFile(connectorStatePath, "utf8"));
    return {
      devices: parsed && typeof parsed.devices === "object" && !Array.isArray(parsed.devices) ? parsed.devices : {},
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
      localRemark: typeof parsed?.localRemark === "string" ? parsed.localRemark : ""
    };
  } catch (error) {
    if (error.code === "ENOENT") return { devices: {}, jobs: [], localRemark: "" };
    if (error instanceof SyntaxError) {
      console.error(`failed to parse ${connectorStatePath}; resetting connector state`, error.message);
      return { devices: {}, jobs: [], localRemark: "" };
    }
    throw error;
  }
}

async function writeConnectorState(state) {
  await mkdir(dataDir, { recursive: true });
  const jobs = Array.isArray(state.jobs) ? state.jobs.slice(-200) : [];
  await writeFile(connectorStatePath, `${JSON.stringify({ devices: state.devices || {}, jobs, localRemark: state.localRemark || "" }, null, 2)}\n`, { mode: 0o600 });
}

async function authenticateConnectorById(id, token) {
  if (!id || !token) return null;
  const state = await readConnectorState();
  const device = state.devices[id];
  if (!device?.tokenHash || !safeCompare(hashSecret(token), device.tokenHash)) return null;
  return { id, device, state };
}

export async function registerConnector(body) {
  const pairToken = cleanText(body.token, 500);
  if (!connectorPairToken) {
    const error = new Error("Connector pairing token is not configured.");
    error.statusCode = 500;
    throw error;
  }
  if (!safeCompare(pairToken, connectorPairToken)) {
    const error = new Error("Invalid connector pairing token.");
    error.statusCode = 401;
    throw error;
  }
  const state = await readConnectorState();
  const id = connectorId();
  const token = randomBytes(32).toString("hex");
  const now = connectorNow();
  state.devices[id] = {
    id,
    tokenHash: hashSecret(token),
    name: cleanText(body.name, 120).trim() || cleanText(body.hostname, 120).trim() || id,
    hostname: cleanText(body.hostname, 120).trim(),
    platform: cleanText(body.platform, 40).trim(),
    arch: cleanText(body.arch, 40).trim(),
    version: cleanText(body.version, 40).trim(),
    codexVersion: cleanText(body.codexVersion, 120).trim(),
    registeredAt: now,
    lastSeen: now,
    lastStatus: "registered"
  };
  await writeConnectorState(state);
  return { connectorId: id, connectorToken: token, device: publicConnectorDevice(state.devices[id]) };
}

export async function remoteConnectorsPayload() {
  const state = await readConnectorState();
  const devices = Object.values(state.devices).map(publicConnectorDevice).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  for (const device of devices) {
    device.tunnelConnected = tunnels.has(device.id);
  }
  return { devices, jobs: [], localRemark: state.localRemark || "" };
}

export async function setConnectorRemark(connectorIdValue, remarkValue) {
  const id = cleanConnectorId(connectorIdValue);
  const state = await readConnectorState();
  const remark = cleanText(remarkValue, 120).trim();
  if (id) {
    const device = state.devices[id];
    if (!device) {
      const error = new Error("被控端不存在。");
      error.statusCode = 404;
      throw error;
    }
    device.remark = remark;
  } else {
    state.localRemark = remark;
  }
  await writeConnectorState(state);
  broadcast({ type: "connectors_changed" });
  return { ok: true, id, remark };
}

export function isConnectorOnline(connectorId) {
  return tunnels.has(cleanConnectorId(connectorId));
}

export async function listConnectorDevices() {
  const state = await readConnectorState();
  return Object.values(state.devices).map(publicConnectorDevice);
}

function getTunnel(id) {
  return tunnels.get(cleanConnectorId(id)) || null;
}

function makeChannel(tunnel) {
  return {
    send(obj) {
      if (tunnel.ws.readyState !== 1) throw new Error("被控端连接已断开");
      tunnel.ws.send(JSON.stringify(obj));
    },
    onMessage(cb) { tunnel.onTransportMessage = cb; },
    get alive() { return tunnel.ws.readyState === 1; },
    close() { try { tunnel.ws.close(); } catch {} }
  };
}

export function getConnectorAppServer(connectorIdValue) {
  const id = cleanConnectorId(connectorIdValue);
  let tunnel = tunnels.get(id);
  if (!tunnel) throw Object.assign(new Error("被控端未连接。"), { statusCode: 409 });
  if (tunnel.appServer) return tunnel.appServer;
  const channel = makeChannel(tunnel);
  const transport = new RemoteTransport({ channel, connectorId: id });
  tunnel.appServer = new CodexAppServer(transport, {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    isRemote: true,
    resolveCwd: (state = {}) => String(state.cwd || "")
  });
  tunnel.appServer.connectorId = id;
  return tunnel.appServer;
}

async function tunnelRequest(tunnel, type, op, params, timeoutMs = 30000) {
  const reqId = `r_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnel.pending.delete(reqId);
      reject(Object.assign(new Error("被控端响应超时。"), { statusCode: 504 }));
    }, timeoutMs);
    tunnel.pending.set(reqId, { resolve, reject, timer });
    try {
      tunnel.ws.send(JSON.stringify({ type, reqId, op, params }));
    } catch (error) {
      clearTimeout(timer);
      tunnel.pending.delete(reqId);
      reject(error);
    }
  });
}

export async function connectorFileOp(connectorId, op, params, timeoutMs) {
  const tunnel = getTunnel(connectorId);
  if (!tunnel) throw Object.assign(new Error("被控端未连接。"), { statusCode: 409 });
  return tunnelRequest(tunnel, "file/request", op, params, timeoutMs);
}

export function remoteSessionProvider(connectorIdValue) {
  const id = cleanConnectorId(connectorIdValue);
  return {
    async listFiles() {
      const tunnel = getTunnel(id);
      if (!tunnel) throw Object.assign(new Error("被控端未连接。"), { statusCode: 409 });
      const result = await tunnelRequest(tunnel, "session/request", "list", {});
      return Array.isArray(result) ? result : [];
    },
    async readFile(file) {
      const tunnel = getTunnel(id);
      if (!tunnel) throw Object.assign(new Error("被控端未连接。"), { statusCode: 409 });
      const result = await tunnelRequest(tunnel, "session/request", "read", { file });
      return typeof result === "string" ? result : "";
    },
    async deleteFile(file) {
      const tunnel = getTunnel(id);
      if (!tunnel) throw Object.assign(new Error("被控端未连接。"), { statusCode: 409 });
      await tunnelRequest(tunnel, "session/request", "delete", { file });
    }
  };
}

async function updateDeviceOnline(id, online, status = "") {
  const state = await readConnectorState();
  if (!state.devices[id]) return;
  state.devices[id].lastSeen = connectorNow();
  state.devices[id].lastStatus = online ? (status || "connected") : "disconnected";
  await writeConnectorState(state);
  broadcast({ type: "connectors_changed" });
}

export function attachConnectorWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.endsWith("/api/connectors/ws")) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const id = cleanConnectorId(url.searchParams.get("id") || "");
    const token = url.searchParams.get("token") || "";
    const auth = await authenticateConnectorById(id, token);
    if (!auth) { ws.close(4001, "unauthorized"); return; }
    const tunnel = {
      id,
      ws,
      appServer: null,
      pending: new Map(),
      onTransportMessage: null,
      lastHeartbeat: Date.now()
    };
    tunnels.set(id, tunnel);
    await updateDeviceOnline(id, true, "connected");
    console.log(`connector ${id} connected`);

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }
      tunnel.lastHeartbeat = Date.now();
      if (msg.type === "rpc" || msg.type === "appserver/ready" || msg.type === "appserver/start_failed" ||
          msg.type === "appserver/closed" || msg.type === "appserver/error" || msg.type === "appserver/stderr") {
        tunnel.onTransportMessage?.(msg);
        return;
      }
      if (msg.type === "heartbeat") {
        await updateDeviceOnline(id, true, msg.status || "idle");
        return;
      }
      if (msg.type === "file/response" || msg.type === "session/response") {
        const entry = tunnel.pending.get(msg.reqId);
        if (!entry) return;
        clearTimeout(entry.timer);
        tunnel.pending.delete(msg.reqId);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(Object.assign(new Error(msg.error || "被控端操作失败"), { statusCode: 502 }));
        return;
      }
    });

    ws.on("close", async () => {
      const isCurrentTunnel = tunnels.get(id) === tunnel;
      if (isCurrentTunnel) tunnels.delete(id);
      if (tunnel.appServer) {
        try { tunnel.appServer.rejectAll(new Error("被控端连接断开")); } catch {}
      }
      if (isCurrentTunnel) await updateDeviceOnline(id, false, "disconnected");
      console.log(`connector ${id} disconnected`);
    });

    ws.on("error", () => { try { ws.close(); } catch {} });

    const hbTimer = setInterval(() => {
      if (Date.now() - tunnel.lastHeartbeat > connectorHeartbeatTimeoutMs) {
        try { ws.close(); } catch {}
      }
    }, 15000);
    ws.on("close", () => clearInterval(hbTimer));
  });
  return wss;
}
