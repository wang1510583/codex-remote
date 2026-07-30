import http from "node:http";
import https from "node:https";
import WebSocket from "ws";
import {
  codexLiveVoiceToken,
  host,
  port,
  routePrefix
} from "../src/config.js";

const requestedBase = process.argv[2]
  || `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}${routePrefix}`;
const baseUrl = new URL(requestedBase);
if (!["http:", "https:"].includes(baseUrl.protocol)) {
  throw new Error("Live Voice verification URL must use http or https.");
}
if (!codexLiveVoiceToken) {
  throw new Error("CODEX_REMOTE_VOICE_TOKEN or CODEX_REMOTE_PASSWORD is required.");
}

baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
baseUrl.search = "";
baseUrl.hash = "";
const authorization = `Basic ${Buffer.from(`verify:${codexLiveVoiceToken}`).toString("base64")}`;
const origin = baseUrl.origin;

function endpoint(pathname) {
  const url = new URL(baseUrl);
  url.pathname = `${baseUrl.pathname}${pathname}`;
  return url;
}

function requestJson(method, pathname, body) {
  const url = endpoint(pathname);
  const payload = body === undefined ? "" : JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers: {
        Authorization: authorization,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            }
          : {})
      },
      timeout: 10_000
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`Live Voice HTTP ${res.statusCode} returned non-JSON data.`));
          return;
        }
        if ((res.statusCode || 500) >= 400 || parsed.success !== true) {
          reject(new Error(
            parsed.message || `Live Voice HTTP verification failed with ${res.statusCode}.`
          ));
          return;
        }
        resolve(parsed);
      });
    });
    req.once("timeout", () => req.destroy(new Error("Live Voice HTTP verification timed out.")));
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForSocket(socket, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Live Voice WebSocket ${event} timed out.`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off("error", onError);
    };
    socket.once(event, onEvent);
    socket.once("error", onError);
  });
}

async function verify() {
  const current = await requestJson("GET", "/api/voice-agent/current-session");
  const sessionId = String(current.data?.session_id || "");
  if (!sessionId) {
    return {
      ok: true,
      base_url: baseUrl.toString(),
      http: "ready",
      websocket: "skipped_no_current_thread"
    };
  }
  const ticketResult = await requestJson(
    "POST",
    `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/live-ticket`,
    {}
  );
  const ticket = String(ticketResult.data?.ticket || "");
  if (!ticket) throw new Error("Live Voice ticket response was empty.");

  const socketUrl = endpoint(
    `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/live`
  );
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl, {
    headers: {
      Authorization: authorization,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin"
    },
    handshakeTimeout: 10_000
  });
  await waitForSocket(socket, "open");

  const readyPromise = waitForSocket(socket, "message");
  socket.send(JSON.stringify({ type: "authenticate", ticket }));
  const [readyRaw] = await readyPromise;
  const ready = JSON.parse(readyRaw.toString());
  if (ready.type !== "ready") throw new Error("Live Voice WebSocket did not become ready.");

  const validationPromise = waitForSocket(socket, "message");
  socket.send(JSON.stringify({
    type: "start",
    sdp: "verification-offer",
    voice: "__invalid_voice__"
  }));
  const [validationRaw] = await validationPromise;
  const validation = JSON.parse(validationRaw.toString());
  if (
    validation.type !== "session.error"
    || validation.recoverable !== true
    || !String(validation.message || "").includes("音色")
  ) {
    throw new Error("Live Voice voice override validation is not active.");
  }

  const closedPromise = waitForSocket(socket, "message");
  socket.send(JSON.stringify({ type: "stop" }));
  const [closedRaw] = await closedPromise;
  const closed = JSON.parse(closedRaw.toString());
  if (closed.type !== "session.closed") {
    throw new Error("Live Voice WebSocket did not acknowledge stop.");
  }
  socket.close();
  return {
    ok: true,
    base_url: baseUrl.toString(),
    http: "ready",
    websocket: "ready",
    voice_validation: "ready"
  };
}

try {
  console.log(JSON.stringify(await verify()));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    base_url: baseUrl.toString(),
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exitCode = 1;
}
