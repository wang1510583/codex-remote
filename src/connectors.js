import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  connectorStatePath, connectorPairToken, codexModel, codexReasoningEffort,
  connectorHeartbeatTimeoutMs
} from "./config.js";
import { cleanText, safeCompare, hashSecret, connectorNow } from "./utils.js";
import { broadcast } from "./sse.js";
import { CodexAppServer } from "./codex-server.js";
import { RemoteTransport } from "./transport/remote.js";
import { readJsonFile, updateJsonFile } from "./json-file.js";
import {
  createSshAppServer, getSshAppServer, isSshConnectorId, isSshOnline, savedSshDevice,
  setSshRemark, sshFileOp, sshSessionProvider
} from "./ssh.js";

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

function emptyConnectorState() {
  return { devices: {}, jobs: [], localRemark: "" };
}

function normalizeConnectorState(parsed) {
  return {
    devices: parsed && typeof parsed.devices === "object" && !Array.isArray(parsed.devices) ? parsed.devices : {},
    jobs: Array.isArray(parsed?.jobs) ? parsed.jobs.slice(-200) : [],
    localRemark: typeof parsed?.localRemark === "string" ? parsed.localRemark : ""
  };
}

async function readConnectorState() {
  return normalizeConnectorState(await readJsonFile(connectorStatePath, emptyConnectorState));
}

async function updateConnectorState(update) {
  return updateJsonFile(connectorStatePath, emptyConnectorState, async (parsed) => {
    const state = normalizeConnectorState(parsed);
    return normalizeConnectorState(await update(state));
  });
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
  const id = connectorId();
  const token = randomBytes(32).toString("hex");
  const now = connectorNow();
  let device;
  await updateConnectorState((state) => {
    device = state.devices[id] = {
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
    return state;
  });
  return { connectorId: id, connectorToken: token, device: publicConnectorDevice(device) };
}

export async function remoteConnectorsPayload() {
  const state = await readConnectorState();
  const devices = Object.values(state.devices).map(publicConnectorDevice).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  for (const device of devices) {
    device.tunnelConnected = tunnels.has(device.id);
    device.connectionType = "connector";
  }
  const sshDevice = await savedSshDevice();
  if (sshDevice) devices.unshift(sshDevice);
  return { devices, jobs: [], localRemark: state.localRemark || "" };
}

export async function setConnectorRemark(connectorIdValue, remarkValue) {
  const id = cleanConnectorId(connectorIdValue);
  const remark = cleanText(remarkValue, 120).trim();
  if (isSshConnectorId(id)) {
    const result = await setSshRemark(id, remark);
    broadcast({ type: "connectors_changed" });
    return result;
  }
  await updateConnectorState((state) => {
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
    return state;
  });
  broadcast({ type: "connectors_changed" });
  return { ok: true, id, remark };
}

export function isConnectorOnline(connectorId) {
  const id = cleanConnectorId(connectorId);
  return isSshConnectorId(id) ? isSshOnline(id) : tunnels.has(id);
}

export function connectorSupportsConcurrentAppServers(connectorId = "") {
  return isSshConnectorId(cleanConnectorId(connectorId));
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
  if (isSshConnectorId(id)) return getSshAppServer(id);
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

export function createConnectorAppServer(connectorIdValue) {
  const id = cleanConnectorId(connectorIdValue);
  if (isSshConnectorId(id)) return createSshAppServer(id);
  return getConnectorAppServer(id);
}

export async function connectorThreadSummaries(connectorIdValue, limit = 80) {
  const id = cleanConnectorId(connectorIdValue);
  if (!isSshConnectorId(id)) return null;
  const server = getSshAppServer(id);
  await server.ensureStarted();
  const baseParams = {
    limit: Math.max(1, Math.min(Number(limit) || 80, 100)),
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: false
  };
  let result;
  try {
    result = await server.request("thread/list", { ...baseParams, useStateDbOnly: true }, null, 20000);
  } catch (error) {
    if (!/useStateDbOnly|invalid params|unknown field|unexpected field/i.test(error?.message || "")) throw error;
    result = await server.request("thread/list", baseParams, null, 20000);
  }
  return Array.isArray(result?.data) ? result.data : [];
}

async function tunnelRequest(tunnel, type, op, params, timeoutMs = 120000) {
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
  if (isSshConnectorId(cleanConnectorId(connectorId))) return sshFileOp(cleanConnectorId(connectorId), op, params);
  const tunnel = getTunnel(connectorId);
  if (!tunnel) throw Object.assign(new Error("被控端未连接。"), { statusCode: 409 });
  return tunnelRequest(tunnel, "file/request", op, params, timeoutMs);
}

export function remoteSessionProvider(connectorIdValue) {
  const id = cleanConnectorId(connectorIdValue);
  if (isSshConnectorId(id)) return sshSessionProvider(id);
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
  let updated = false;
  await updateConnectorState((state) => {
    if (!state.devices[id]) return state;
    state.devices[id].lastSeen = connectorNow();
    state.devices[id].lastStatus = online ? (status || "connected") : "disconnected";
    updated = true;
    return state;
  });
  if (!updated) return;
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

    ws.on("close", async (code, reason) => {
      const isCurrentTunnel = tunnels.get(id) === tunnel;
      if (isCurrentTunnel) tunnels.delete(id);
      if (tunnel.appServer) {
        try { tunnel.appServer.rejectAll(new Error("被控端连接断开")); } catch {}
      }
      if (isCurrentTunnel) await updateDeviceOnline(id, false, "disconnected");
      console.log(`connector ${id} disconnected (code=${code}${reason?.length ? `, reason=${reason.toString()}` : ""})`);
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
