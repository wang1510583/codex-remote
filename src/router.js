import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { publicDir } from "./config.js";
import { json, readBody, mimeType, safeCompare, cleanText } from "./utils.js";
import { isAuthenticated, routePath, routeBase, isPublicPath, redirectToLogin, authCookie } from "./auth.js";
import { remotePassword, authToken, codexWorkDir, disableLocal } from "./config.js";
import { clients, broadcast, sendSnapshot, changesSince, currentEventSeq } from "./sse.js";
import {
  readState, writeState, saveDraftForState, draftForState, syncLoadedCounts,
  readConnectorViewState, writeConnectorViewState, setThreadName, writeStateIfIdle
} from "./store.js";
import {
  submitRemoteMessage, selectRemoteThread, createRemoteSession, loadThreadPage,
  listThreads, deleteThread, runnerForIncomingState, statusPayload, runnerForState,
  selectedRunner, setSelectedRunnerKey, clearThreadCompletedUnread, markInterruptedInflight,
  runningThreads, runnerKeyForState, ensureStateModelSettings,
  runnerStatePayload, sessionModelSettingsPayload, updateSessionModelSettings, usagePayload, resetUsageLimit,
  syncSharedThreadSettings
} from "./runner.js";
import { isInternalMessage, mergeLocalMessageMeta } from "./threads.js";
import {
  listProjectFiles, createProjectFolder, deleteProjectFolder, createProjectFile,
  deleteProjectFile, writeProjectFile, renameProjectPath, saveUploadedFiles
} from "./files.js";
import { projectPath, relativeProjectPath, isAllowedDownload, allowedDownloadRoots } from "./paths.js";
import * as ssh from "./ssh.js";
import { webPushPublicKey, savePushSubscription, sendWebPushTaskDone } from "./webpush.js";
import { nativeNotificationStatus, sendNativeTaskDone } from "./native-notifications.js";
import { registerConnector, remoteConnectorsPayload, connectorFileOp, setConnectorRemark } from "./connectors.js";
import { followModeForState } from "./store.js";
import { threadName } from "./store.js";
import {
  externalSessionSnapshot, externalSnapshotFromThread,
  monitorExternalSession, stopExternalSessionMonitor
} from "./external-sessions.js";

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const normalized = routePath(url.pathname);
  const pathname = normalized === "/" ? "/remote.html" : normalized;
  const file = path.normalize(path.join(publicDir, pathname));
  if (!file.startsWith(publicDir) || !existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const headers = { "Content-Type": mimeType(file) };
  if (/\.(html|js|css)$/i.test(file)) headers["Cache-Control"] = "no-store";
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
}

function connectorIdFrom(req, body = {}) {
  const url = new URL(req.url, "http://localhost");
  return cleanConnectorIdValue(body.connectorId || url.searchParams.get("connector") || url.searchParams.get("connectorId") || "");
}

function cleanConnectorIdValue(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

function messageMergeKey(message = {}) {
  return [message.role || "", message.content || ""].join("\n");
}

function mergeStateMessages(sessionMessages = [], stateMessages = []) {
  const rows = [];
  const seen = new Set();
  for (const message of [...sessionMessages, ...stateMessages]) {
    if (!message?.role || !message?.content) continue;
    if (message.role === "user" && isInternalMessage(message.content)) continue;
    const key = messageMergeKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(message);
  }
  rows.sort((left, right) => {
    const leftTime = left.at ? Date.parse(left.at) : 0;
    const rightTime = right.at ? Date.parse(right.at) : 0;
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return 0;
  });
  return rows.slice(-80);
}

async function dispatchFileList(req, res, connectorId) {
  const url = new URL(req.url, "http://localhost");
  const dir = url.searchParams.get("dir") || "";
  if (connectorId) return json(res, 200, await connectorFileOp(connectorId, "list", { dir }));
  return json(res, 200, await listProjectFiles(dir));
}

export async function handle(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const basePath = routeBase(url.pathname, req);
    url.pathname = routePath(url.pathname);

    if (req.method === "POST" && url.pathname === "/api/remote/login") {
      if (!remotePassword) return json(res, 500, { error: "服务端没有配置登录密码。" });
      const password = (await readBody(req)).password;
      if (!safeCompare(password || "", remotePassword)) return json(res, 401, { error: "密码错误。" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": authCookie(authToken, 60 * 60 * 24 * 7) });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/remote/auth") {
      return json(res, 200, { authenticated: isAuthenticated(req) });
    }

    if (req.method === "POST" && url.pathname === "/api/connectors/register") {
      const body = await readBody(req, 80 * 1024);
      return json(res, 200, { ok: true, ...await registerConnector(body) });
    }

    if (!isAuthenticated(req) && !isPublicPath(url.pathname)) {
      if (url.pathname.startsWith("/api/remote/")) return json(res, 401, { error: "请先登录。" });
      if (req.method === "GET" || req.method === "HEAD") return redirectToLogin(res, basePath);
      return json(res, 401, { error: "请先登录。" });
    }

    if (isAuthenticated(req) && req.method === "GET" && url.pathname === "/login.html") {
      res.writeHead(302, { Location: `${basePath}/` });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/remote/push/key") {
      return json(res, 200, { publicKey: webPushPublicKey });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/push/subscribe") {
      const body = await readBody(req, 64 * 1024);
      return json(res, 200, { ok: true, ...await savePushSubscription(body.subscription || body) });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/push/test") {
      return json(res, 200, { ok: true, ...await sendWebPushTaskDone("✅ Web Push 后台测试通知") });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/notifications/status") {
      return json(res, 200, nativeNotificationStatus());
    }

    if (req.method === "POST" && url.pathname === "/api/remote/notifications/test") {
      return json(res, 200, { ok: true, ...sendNativeTaskDone("✅ WebToApp 后台测试通知") });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/state") {
      const snapshotEventSeq = currentEventSeq();
      const viewState = await readConnectorViewState();
      const requestedConnectorId = connectorIdFrom(req);
      const connectorId = requestedConnectorId || viewState.selectedConnectorId || "";
      let state = await readState(connectorId);
      state.connectorId = state.connectorId || connectorId;
      let loadedThread = null;
      let external = null;
      let runner = await runnerForIncomingState(state);
      if (runner?.running) {
        stopExternalSessionMonitor(connectorId);
        state = runner.state;
      } else if (state.threadId) {
        const thread = await loadThreadPage(state.threadId, connectorId).catch(() => null);
        if (thread) {
          loadedThread = thread;
          external = externalSnapshotFromThread(thread, connectorId);
          monitorExternalSession(state.threadId, connectorId, external);
          const sessionMessages = await mergeLocalMessageMeta(state.threadId, thread.messages, state.messages);
          const messages = mergeStateMessages(sessionMessages, state.messages);
          state = { ...state, cwd: connectorId ? (state.cwd || "") : (thread.cwd || state.cwd || ""), messages, loadedCount: messages.length, messageCount: Math.max(thread.messageCount, messages.length), inflight: null };
        }
      } else {
        stopExternalSessionMonitor(connectorId);
      }
      state = await ensureStateModelSettings(state, loadedThread).catch(() => state);
      state = await syncSharedThreadSettings(state).catch(() => state);
      if (loadedThread && !runner?.running) await writeStateIfIdle(state, connectorId);
      setSelectedRunnerKey(runner ? runner.key : runnerKeyForState(state));
      // A running state must include the app-server turn's current transient
      // messages. Otherwise a tab restored from the background clears the
      // live thought bubble and cannot rebuild it until the thread is reopened.
      const payload = runner?.running ? runnerStatePayload(runner) : state;
      const connectorsPayload = await remoteConnectorsPayload();
      return json(res, 200, {
        ...payload,
        connectorId,
        absoluteCwd: state.connectorId ? (state.cwd || "") : absoluteCwdLocal(state.cwd || ""),
        fileLinkRoots: allowedDownloadRoots(),
        threadName: state.threadId ? await threadName(state.threadId) : "",
        draft: await draftForState(state, connectorId),
        running: Boolean(runner?.running || external?.running),
        externalRunning: Boolean(!runner?.running && external?.running),
        externalTaskStartedAt: external?.externalTaskStartedAt || "",
        reconnecting: Boolean(runner?.reconnecting),
        queueLength: runner?.messageQueue.length || 0,
        queueMessages: (runner?.messageQueue || []).map((item, i) => ({ index: i + 1, message: item.message })),
        steerLength: runner?.steerMessages.length || 0,
        followMode: runner?.followMode || await followModeForState(state, connectorId),
        contextUsage: runner?.contextUsage || external?.contextUsage || loadedThread?.contextUsage || null,
        runningThreads: runningThreads(),
        connectors: connectorsPayload.devices,
        localRemark: connectorsPayload.localRemark || "",
        selectedConnectorId: connectorId,
        disableLocal,
        eventSeq: snapshotEventSeq
      });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/changes") {
      const afterSeq = Number(url.searchParams.get("afterSeq") || 0);
      return json(res, 200, changesSince(afterSeq));
    }

    if (req.method === "GET" && url.pathname === "/api/remote/model-settings") {
      const connectorId = connectorIdFrom(req);
      return json(res, 200, await sessionModelSettingsPayload(connectorId));
    }

    if (req.method === "POST" && url.pathname === "/api/remote/model-settings") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      return json(res, 200, { ok: true, ...await updateSessionModelSettings(body, connectorId) });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/usage") {
      const connectorId = connectorIdFrom(req);
      return json(res, 200, await usagePayload(connectorId));
    }

    if (req.method === "POST" && url.pathname === "/api/remote/usage/reset") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      return json(res, 200, { ok: true, ...await resetUsageLimit(body.creditId || "", connectorId) });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/connectors") {
      const viewState = await readConnectorViewState();
      return json(res, 200, { ...await remoteConnectorsPayload(), selectedConnectorId: viewState.selectedConnectorId || "" });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/connectors/select") {
      const body = await readBody(req);
      const selectedConnectorId = cleanConnectorIdValue(body.connectorId || "");
      const viewState = await writeConnectorViewState(selectedConnectorId);
      broadcast({ type: "connector_selected", selectedConnectorId: viewState.selectedConnectorId, updatedAt: viewState.updatedAt });
      return json(res, 200, { ok: true, ...viewState });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/connectors/remark") {
      const body = await readBody(req);
      return json(res, 200, await setConnectorRemark(body.connectorId || "", body.remark || ""));
    }

    if (req.method === "GET" && url.pathname === "/api/remote/threads") {
      const connectorId = connectorIdFrom(req);
      return json(res, 200, { threads: await listThreads(connectorId) });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/draft") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      await saveDraftForState({ threadId: body.threadId || "", cwd: body.cwd || "" }, body.text || "", connectorId);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/ssh/status") {
      return json(res, 200, ssh.sshStatusPayload());
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/connect") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await ssh.sshConnect({ target: body.target || "", password: body.password || "" }) });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/disconnect") {
      ssh.closeSshConnection();
      return json(res, 200, { ok: true, connected: false });
    }
    if (req.method === "GET" && url.pathname === "/api/remote/ssh/files") {
      return json(res, 200, await ssh.listSshFiles(url.searchParams.get("dir") || ""));
    }
    if (req.method === "GET" && url.pathname === "/api/remote/ssh/file") {
      return json(res, 200, await ssh.readSshFile(url.searchParams.get("path") || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/folders") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await ssh.createSshFolder(body.dir || "", body.name || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/files") {
      const body = await readBody(req, 1200 * 1024);
      return json(res, 200, { ok: true, ...await ssh.createSshFile(body.dir || "", body.name || "", body.content || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/file/write") {
      const body = await readBody(req, 1200 * 1024);
      return json(res, 200, await ssh.writeSshFile(body.path || "", body.content || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/delete") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await ssh.deleteSshPath(body.path || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/ssh/rename") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await ssh.renameSshPath(body.path || "", body.name || "") });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/files") {
      const connectorId = connectorIdFrom(req);
      return await dispatchFileList(req, res, connectorId);
    }
    if (req.method === "POST" && url.pathname === "/api/remote/folders") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      if (connectorId) return json(res, 200, { ok: true, ...await connectorFileOp(connectorId, "mkdir", { dir: body.dir || "", name: body.name || "" }) });
      return json(res, 200, { ok: true, ...await createProjectFolder(body.dir || "", body.name || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/folders/delete") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      if (connectorId) return json(res, 200, { ok: true, ...await connectorFileOp(connectorId, "delete", { path: body.path || "" }) });
      return json(res, 200, { ok: true, ...await deleteProjectFolder(body.path || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/files") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      if (connectorId) return json(res, 200, { ok: true, ...await connectorFileOp(connectorId, "createFile", { dir: body.dir || "", name: body.name || "", content: body.content || "" }) });
      return json(res, 200, { ok: true, ...await createProjectFile(body.dir || "", body.name || "", body.content || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/files/delete") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      if (connectorId) return json(res, 200, { ok: true, ...await connectorFileOp(connectorId, "delete", { path: body.path || "" }) });
      return json(res, 200, { ok: true, ...await deleteProjectFile(body.path || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/file/write") {
      const body = await readBody(req, 1200 * 1024);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      if (connectorId) return json(res, 200, await connectorFileOp(connectorId, "write", { path: body.path || "", content: body.content || "" }));
      return json(res, 200, await writeProjectFile(body.path || "", body.content || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/remote/path/rename") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      if (connectorId) return json(res, 200, { ok: true, ...await connectorFileOp(connectorId, "rename", { path: body.path || "", name: body.name || "" }) });
      return json(res, 200, { ok: true, ...await renameProjectPath(body.path || "", body.name || "") });
    }
    if (req.method === "GET" && url.pathname === "/api/remote/file") {
      const connectorId = connectorIdFrom(req);
      const filePath = url.searchParams.get("path") || "";
      if (connectorId) {
        const result = await connectorFileOp(connectorId, "read", { path: filePath });
        return json(res, 200, result);
      }
      const file = projectPath(filePath);
      const info = await stat(file);
      if (!info.isFile()) return json(res, 400, { error: "只能预览文件。" });
      const type = mimeType(file);
      if (/^image\//.test(type)) {
        return json(res, 200, { type: "image", path: relativeProjectPath(file), mime: type, url: `/api/remote/download?p=${encodeURIComponent(file)}&inline=1` });
      }
      if (info.size > 1024 * 1024) return json(res, 400, { error: "文件超过 1MB，可直接下载。" });
      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(file);
      return json(res, 200, { type: "text", path: relativeProjectPath(file), mime: type, text: buffer.toString("utf8") });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      clients.add(res);
      const heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) { clearInterval(heartbeat); clients.delete(res); return; }
        res.write(": keep-alive\n\n");
      }, 15000);
      const initialStatus = statusPayload(selectedRunner());
      if (!initialStatus.running) {
        const viewState = await readConnectorViewState();
        const connectorId = viewState.selectedConnectorId || "";
        const state = await readState(connectorId);
        const external = externalSessionSnapshot(state.threadId || "", connectorId);
        if (external?.running) {
          initialStatus.running = true;
          initialStatus.externalRunning = true;
          initialStatus.externalTaskStartedAt = external.externalTaskStartedAt || "";
          initialStatus.contextUsage = external.contextUsage || initialStatus.contextUsage;
        }
      }
      sendSnapshot(res, initialStatus);
      const cleanup = () => { clearInterval(heartbeat); clients.delete(res); };
      res.on("error", cleanup);
      req.on("close", cleanup);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/remote/upload") {
      const files = await saveUploadedFiles(req);
      return json(res, 200, { ok: true, files });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/download") {
      const requested = url.searchParams.get("p") || "";
      const file = path.resolve(path.isAbsolute(requested) ? requested : path.join(codexWorkDir, requested));
      if (!isAllowedDownload(file) || !existsSync(file)) return json(res, 404, { error: "文件不存在或不允许下载。" });
      const info = await stat(file);
      if (!info.isFile()) return json(res, 400, { error: "只能下载文件。" });
      res.writeHead(200, { "Content-Type": mimeType(file), "Content-Length": info.size, "Content-Disposition": `${url.searchParams.get("inline") === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
      createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/remote/send") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      const result = await submitRemoteMessage(body.message, body.followMode, connectorId);
      return json(res, result.local ? 200 : 202, result);
    }

    if (req.method === "POST" && url.pathname === "/api/remote/notice") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      const content = cleanText(body.message || body.content || "", 20000).trim();
      if (!content) return json(res, 400, { error: "提示内容不能为空。" });
      const state = await readState(connectorId);
      const message = { role: "assistant", content, at: new Date().toISOString() };
      state.messages.push(message);
      state.messages = state.messages.slice(-80);
      await writeState(syncLoadedCounts(state), connectorId);
      broadcast({ type: "message", connectorId, ...message, messageId: cleanText(body.messageId || "", 120).trim() || `notice-${Date.now()}`, final: true });
      return json(res, 200, { ok: true, message });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/select") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      const payload = await selectRemoteThread(body.threadId || "", connectorId);
      return json(res, 200, { ok: true, ...payload });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/more") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      const state = await readState(connectorId);
      if (!state.threadId) return json(res, 400, { error: "当前没有会话。" });
      const thread = await loadThreadPage(state.threadId, connectorId);
      const sessionMessages = await mergeLocalMessageMeta(state.threadId, thread.messages, state.messages);
      const messages = mergeStateMessages(sessionMessages, state.messages);
      const nextState = { ...state, cwd: connectorId ? (state.cwd || "") : (thread.cwd || state.cwd || ""), messages, loadedCount: messages.length, messageCount: Math.max(thread.messageCount, messages.length) };
      await writeState(nextState, connectorId);
      const name = await threadName(state.threadId);
      const draft = await draftForState(nextState, connectorId);
      const mode = await followModeForState(nextState, connectorId);
      broadcast({ type: "state", connectorId, ...nextState, absoluteCwd: connectorId ? nextState.cwd : absoluteCwdLocal(nextState.cwd), threadName: name, draft, followMode: mode });
      return json(res, 200, { ok: true, ...nextState, absoluteCwd: connectorId ? nextState.cwd : absoluteCwdLocal(nextState.cwd), threadName: name, draft, followMode: mode });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/new") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      const payload = await createRemoteSession(body.cwd || "", connectorId);
      return json(res, 200, { ok: true, ...payload });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/name") {
      const body = await readBody(req);
      const threadId = cleanConnectorIdValue(body.threadId) || String(body.threadId || "");
      const name = String(body.name || "").trim();
      await setThreadName(threadId, name);
      const state = await readState(cleanConnectorIdValue(body.connectorId || ""));
      if (state.threadId === threadId) broadcast({ type: "thread_name", threadId, name });
      return json(res, 200, { ok: true, threadId, name });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/delete") {
      const body = await readBody(req);
      const connectorId = cleanConnectorIdValue(body.connectorId || "");
      const threadId = String(body.threadId || "");
      const { runners } = await import("./runner.js");
      const runningRunner = runners.get(`${connectorId ? `${connectorId}:` : ""}thread:${threadId}`);
      if (runningRunner?.running) return json(res, 409, { error: "这个会话正在运行，不能删除。" });
      await deleteThread(threadId, connectorId);
      await clearThreadCompletedUnread(threadId);
      const state = await readState(connectorId);
      if (state.threadId === threadId) {
        const empty = { threadId: "", connectorId, cwd: "", messages: [], inflight: null };
        await writeState(empty, connectorId);
        broadcast({ type: "state", connectorId, threadId: "", cwd: "", absoluteCwd: "", messages: [], threadName: "" });
      }
      return json(res, 200, { ok: true, threadId });
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    json(res, 404, { error: "Not found" });
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      console.error("request failed after response was sent", error.message || error);
      return;
    }
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) {
      const pathname = (() => {
        try { return new URL(req.url, "http://localhost").pathname; }
        catch { return "unknown"; }
      })();
      console.error(`request failed: ${req.method || "UNKNOWN"} ${pathname}`, error.message || error);
    }
    json(res, statusCode, { error: error.message || "Server error" });
  }
}

function absoluteCwdLocal(cwd = "") {
  try { return projectPath(cwd || ""); } catch { return path.resolve(codexWorkDir); }
}
