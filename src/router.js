import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  publicDir, messagePageSize, remotePassword, authToken, codexWorkDir,
  cliApprovalHookToken
} from "./config.js";
import { json, readBody, mimeType, safeCompare, cleanText } from "./utils.js";
import { isAuthenticated, routePath, routeBase, isPublicPath, redirectToLogin, authCookie } from "./auth.js";
import { clients, broadcast, sendSnapshot, changesSince, currentEventSeq } from "./sse.js";
import {
  readState, writeState, saveDraftForState, draftForState, syncLoadedCounts,
  setThreadName, writeStateIfIdle,
  labelLiveVoiceTranscript, readLiveVoiceTranscripts,
  appendThreadNotice, readThreadNotices
} from "./store.js";
import {
  submitRemoteMessage, selectRemoteThread, createRemoteSession, loadThreadPage,
  listThreads, deleteThread, runnerForIncomingState, statusPayload, runnerForState,
  selectedRunner, setSelectedRunnerKey, clearThreadCompletedUnread, markInterruptedInflight,
  runningThreads, runnerKeyForState, ensureStateModelSettings,
  runnerStatePayload, sessionModelSettingsPayload, updateSessionModelSettings, usagePayload, resetUsageLimit,
  syncSharedThreadSettings, liveFullMessagesFor, reconcileExternalSessionStatus,
  pendingApprovalsPayload, respondToRemoteApproval
} from "./runner.js";
import {
  isInternalMessage, mergeLocalMessageMeta, limitFullReplyMessages
} from "./threads.js";
import {
  listProjectFiles, createProjectFolder, deleteProjectFolder, createProjectFile,
  deleteProjectFile, writeProjectFile, renameProjectPath, saveUploadedFiles,
  projectDownloadTarget, createProjectFolderZip, saveProjectUploads
} from "./files.js";
import { projectPath, relativeProjectPath, isAllowedDownload, allowedDownloadRoots } from "./paths.js";
import { webPushPublicKey, savePushSubscription, sendWebPushTaskDone } from "./webpush.js";
import {
  nativeNotificationStatus, sendNativeTaskDone, setApprovalNotificationsSuppressed
} from "./native-notifications.js";
import { followModeForState } from "./store.js";
import { threadName } from "./store.js";
import {
  externalSessionSnapshot, externalSnapshotFromThread,
  monitorExternalSession, stopExternalSessionMonitor
} from "./external-sessions.js";
import { handleLiveVoiceHttp } from "./live-voice/index.js";
import { requestCliApproval } from "./cli-approvals.js";
import {
  isLiveVoiceThreadActive,
  liveVoiceThreadSnapshot
} from "./live-voice/leases.js";

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

function cleanConnectorIdValue(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

function messageMergeKey(message = {}) {
  let content = String(message.content || "").trim();
  if (message.role === "assistant") {
    content = content.replace(/^[🤔✅]\s*/u, "");
  }
  return [message.role || "", content].join("\n");
}

function mergeStateMessages(sessionMessages = [], stateMessages = []) {
  const byKey = new Map();
  const order = [];
  const hasSession = Array.isArray(sessionMessages) && sessionMessages.length > 0;
  for (const rawMessage of sessionMessages) {
    const message = rawMessage?.liveVoiceTranscript
      ? { ...rawMessage, content: labelLiveVoiceTranscript(rawMessage.content) }
      : rawMessage;
    if (!message?.role || !message?.content) continue;
    if (message.role === "user" && isInternalMessage(message.content)) continue;
    const key = messageMergeKey(message);
    if (!byKey.has(key)) {
      byKey.set(key, message);
      order.push(key);
    }
  }
  for (const rawMessage of stateMessages) {
    const message = rawMessage?.liveVoiceTranscript
      ? { ...rawMessage, content: labelLiveVoiceTranscript(rawMessage.content) }
      : rawMessage;
    if (!message?.role || !message?.content) continue;
    if (message.role === "user" && isInternalMessage(message.content)) continue;
    const key = messageMergeKey(message);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, message);
      order.push(key);
    } else if (!hasSession) {
      if (/^✅\s/u.test(message.content) && !/^✅\s/u.test(existing.content)) {
        byKey.set(key, message);
      } else if (message.taskDurationMs !== undefined && existing.taskDurationMs === undefined) {
        byKey.set(key, { ...existing, ...message });
      }
    } else {
      if (message.taskDurationMs !== undefined && existing.taskDurationMs === undefined) {
        byKey.set(key, { ...existing, taskDurationMs: message.taskDurationMs });
      }
    }
  }
  const rows = order.map((key) => byKey.get(key));
  rows.sort((left, right) => {
    const leftTime = left.at ? Date.parse(left.at) : 0;
    const rightTime = right.at ? Date.parse(right.at) : 0;
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return 0;
  });
  return rows.slice(-80);
}

function mergeFullReplyMessages(sessionMessages = [], stateMessages = [], liveMessages = []) {
  const rows = [];
  const byMessageId = new Map();
  const byContentKey = new Map();
  const add = (message, replaceById = false) => {
    if (!message?.role || !message?.content) return;
    if (message.role === "user" && isInternalMessage(message.content)) return;
    const messageId = String(message.messageId || "");
    const contentKey = messageMergeKey(message);
    if (replaceById && messageId && byMessageId.has(messageId)) {
      const index = byMessageId.get(messageId);
      const oldKey = messageMergeKey(rows[index]);
      byContentKey.delete(oldKey);
      rows[index] = message;
      byContentKey.set(contentKey, index);
      return;
    }
    if (byContentKey.has(contentKey)) {
      const index = byContentKey.get(contentKey);
      if (/^✅\s/u.test(message.content) && !/^✅\s/u.test(rows[index].content)) {
        rows[index] = message;
      }
      return;
    }
    const index = rows.length;
    rows.push(message);
    byContentKey.set(contentKey, index);
    if (messageId) byMessageId.set(messageId, index);
  };
  for (const message of sessionMessages) add(message);
  for (const message of stateMessages) add(message);
  for (const message of liveMessages) add(message, true);
  rows.sort((left, right) => {
    const leftTime = left.at ? Date.parse(left.at) : 0;
    const rightTime = right.at ? Date.parse(right.at) : 0;
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return 0;
  });
  return limitFullReplyMessages(rows);
}

async function dispatchFileList(req, res) {
  const url = new URL(req.url, "http://localhost");
  const dir = url.searchParams.get("dir") || "";
  return json(res, 200, await listProjectFiles(dir));
}

function attachmentDisposition(filename = "download") {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function streamFolderZip(req, res, folder, archiveName) {
  const archive = createProjectFolderZip(folder, archiveName);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const abort = () => {
      try { archive.abort(); } catch {}
    };
    const fail = (error) => {
      abort();
      if (res.headersSent) {
        if (!res.destroyed) res.destroy(error);
        settle(resolve);
      } else {
        settle(reject, error);
      }
    };
    archive.on("warning", fail);
    archive.on("error", fail);
    res.on("error", fail);
    res.on("finish", () => settle(resolve));
    res.on("close", () => {
      if (!res.writableEnded) abort();
      settle(resolve);
    });
    req.on("aborted", () => {
      abort();
      settle(resolve);
    });
    archive.pipe(res);
    Promise.resolve(archive.finalize()).catch(fail);
  });
}

export async function handle(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const basePath = routeBase(url.pathname, req);
    url.pathname = routePath(url.pathname);

    if (await handleLiveVoiceHttp(req, res, url)) return;

    if (req.method === "POST" && url.pathname === "/api/remote/cli/approval") {
      const header = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization || "";
      const suppliedToken = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
      if (!cliApprovalHookToken || !safeCompare(suppliedToken, cliApprovalHookToken)) {
        return json(res, 401, { error: "Codex CLI 审核钩子鉴权失败。" });
      }
      const body = await readBody(req, 1024 * 1024);
      return json(res, 200, await requestCliApproval(body));
    }

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

    if (req.method === "POST" && url.pathname === "/api/remote/notifications/approval-preference") {
      const body = await readBody(req, 8 * 1024);
      return json(res, 200, {
        ok: true,
        ...setApprovalNotificationsSuppressed(Boolean(body.autoApprove))
      });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/state") {
      const snapshotEventSeq = currentEventSeq();
      const wantsFullReplies = url.searchParams.get("full") === "1";
      const connectorId = "";
      let state = await readState(connectorId);
      state.connectorId = state.connectorId || connectorId;
      const persistentVoiceMessages = !connectorId && state.threadId
        ? await readLiveVoiceTranscripts(state.threadId).catch(() => [])
        : [];
      const persistentNotices = state.threadId
        ? await readThreadNotices(state.threadId, connectorId).catch(() => [])
        : [];
      let loadedThread = null;
      let external = null;
      let runner = await runnerForIncomingState(state);
      const liveVoice = !connectorId && state.threadId
        ? liveVoiceThreadSnapshot(state.threadId)
        : null;
      if (runner?.running) {
        if (!runner.externalTurn) stopExternalSessionMonitor(connectorId);
        state = runner.state;
        if (wantsFullReplies && state.threadId) {
          loadedThread = await loadThreadPage(state.threadId, connectorId).catch(() => null);
        }
        if (persistentVoiceMessages.length || persistentNotices.length) {
          state = {
            ...state,
            messages: mergeStateMessages([], [
              ...(state.messages || []),
              ...persistentVoiceMessages,
              ...persistentNotices
            ])
          };
        }
      } else if (state.threadId) {
        const thread = await loadThreadPage(state.threadId, connectorId).catch(() => null);
        if (thread) {
          loadedThread = thread;
          if (liveVoice) {
            stopExternalSessionMonitor(connectorId);
          } else {
            external = externalSnapshotFromThread(thread, connectorId);
            monitorExternalSession(state.threadId, connectorId, external);
            external = await reconcileExternalSessionStatus(state, external);
          }
          const sessionMessages = await mergeLocalMessageMeta(state.threadId, thread.messages, state.messages);
          const messages = mergeStateMessages(sessionMessages, [
            ...(state.messages || []),
            ...persistentVoiceMessages,
            ...persistentNotices
          ]);
          state = { ...state, cwd: connectorId ? (state.cwd || "") : (thread.cwd || state.cwd || ""), messages, loadedCount: messages.length, messageCount: Math.max(thread.messageCount, messages.length), inflight: null };
        } else if (persistentVoiceMessages.length || persistentNotices.length) {
          const messages = mergeStateMessages([], [
            ...(state.messages || []),
            ...persistentVoiceMessages,
            ...persistentNotices
          ]);
          state = { ...state, messages, loadedCount: messages.length, messageCount: Math.max(Number(state.messageCount) || 0, messages.length) };
        }
      } else {
        stopExternalSessionMonitor(connectorId);
      }
      state = await ensureStateModelSettings(state, loadedThread).catch(() => state);
      state = await syncSharedThreadSettings(state).catch(() => state);
      if (loadedThread && !runner?.running && !liveVoice) {
        await writeStateIfIdle(state, connectorId);
      }
      setSelectedRunnerKey(runner ? runner.key : runnerKeyForState(state));
      // A running state must include the app-server turn's current transient
      // messages. Otherwise a tab restored from the background clears the
      // live thought bubble and cannot rebuild it until the thread is reopened.
      const payload = runner?.running ? runnerStatePayload(runner) : state;
      const liveFullMessages = wantsFullReplies && runner?.running ? liveFullMessagesFor(runner) : [];
      const fullMessages = wantsFullReplies
        ? mergeFullReplyMessages(loadedThread?.fullMessages || [], payload.messages || [], liveFullMessages)
        : undefined;
      const fullMessageCount = wantsFullReplies
        ? Math.max(
          Number(loadedThread?.fullMessageCount) || 0,
          fullMessages.length
        )
        : undefined;
      const pendingApprovals = pendingApprovalsPayload();
      return json(res, 200, {
        ...payload,
        fullMessages,
        fullMessageCount,
        connectorId,
        absoluteCwd: state.connectorId ? (state.cwd || "") : absoluteCwdLocal(state.cwd || ""),
        fileLinkRoots: allowedDownloadRoots(),
        threadName: state.threadId ? await threadName(state.threadId) : "",
        draft: await draftForState(state, connectorId),
        running: Boolean(runner?.running || liveVoice || external?.running),
        externalRunning: Boolean(runner?.externalTurn || (!runner?.running && !liveVoice && external?.running)),
        externalTaskStartedAt: runner?.externalTurn?.taskStartedAt || external?.externalTaskStartedAt || "",
        liveVoiceRunning: Boolean(liveVoice),
        liveVoiceConnected: Boolean(liveVoice?.connected),
        liveVoiceTaskRunning: Boolean(liveVoice?.taskRunning),
        reconnecting: Boolean(runner?.reconnecting || (liveVoice && !liveVoice.connected)),
        queueLength: runner?.messageQueue.length || 0,
        queueMessages: (runner?.messageQueue || []).map((item, i) => ({ index: i + 1, message: item.message })),
        steerLength: runner?.steerMessages.length || 0,
        followMode: runner?.followMode || await followModeForState(state, connectorId),
        contextUsage: runner?.contextUsage || external?.contextUsage || loadedThread?.contextUsage || null,
        runningThreads: runningThreads(),
        pendingApprovals,
        eventSeq: snapshotEventSeq
      });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/changes") {
      const afterSeq = Number(url.searchParams.get("afterSeq") || 0);
      return json(res, 200, changesSince(afterSeq));
    }

    if (req.method === "GET" && url.pathname === "/api/remote/model-settings") {
      const connectorId = "";
      return json(res, 200, await sessionModelSettingsPayload(connectorId));
    }

    if (req.method === "POST" && url.pathname === "/api/remote/model-settings") {
      const body = await readBody(req);
      const connectorId = "";
      return json(res, 200, { ok: true, ...await updateSessionModelSettings(body, connectorId) });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/usage") {
      const connectorId = "";
      return json(res, 200, await usagePayload(connectorId));
    }

    if (req.method === "POST" && url.pathname === "/api/remote/usage/reset") {
      const body = await readBody(req);
      const connectorId = "";
      return json(res, 200, { ok: true, ...await resetUsageLimit(body.creditId || "", connectorId) });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/threads") {
      const connectorId = "";
      return json(res, 200, { threads: await listThreads(connectorId) });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/draft") {
      const body = await readBody(req);
      const connectorId = "";
      await saveDraftForState({ threadId: body.threadId || "", cwd: body.cwd || "" }, body.text || "", connectorId);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/approval/respond") {
      const body = await readBody(req, 1024 * 1024);
      return json(res, 200, { ok: true, ...await respondToRemoteApproval(body) });
    }

    if (req.method === "GET" && url.pathname === "/api/remote/files") {
      return await dispatchFileList(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/remote/folders") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await createProjectFolder(body.dir || "", body.name || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/folders/delete") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await deleteProjectFolder(body.path || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/files") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await createProjectFile(body.dir || "", body.name || "", body.content || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/files/delete") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await deleteProjectFile(body.path || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/remote/file/write") {
      const body = await readBody(req, 1200 * 1024);
      return json(res, 200, await writeProjectFile(body.path || "", body.content || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/remote/path/rename") {
      const body = await readBody(req);
      return json(res, 200, { ok: true, ...await renameProjectPath(body.path || "", body.name || "") });
    }
    if (req.method === "GET" && url.pathname === "/api/remote/file") {
      const filePath = url.searchParams.get("path") || "";
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

    if (req.method === "GET" && url.pathname === "/api/remote/project-download") {
      const target = await projectDownloadTarget(url.searchParams.get("path") || "");
      const expectedType = url.searchParams.get("type") || "";
      if (expectedType && expectedType !== target.type) {
        return json(res, 409, { error: "文件类型已经变化，请刷新文件面板后重试。" });
      }
      if (target.type === "file") {
        res.writeHead(200, {
          "Content-Type": target.mime,
          "Content-Length": target.size,
          "Content-Disposition": attachmentDisposition(target.name),
          "Cache-Control": "private, no-store"
        });
        const stream = createReadStream(target.file);
        stream.on("error", (error) => {
          if (!res.destroyed) res.destroy(error);
        });
        stream.pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition(`${target.name}.zip`),
        "Cache-Control": "private, no-store"
      });
      await streamFolderZip(req, res, target.file, target.name);
      return;
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
        const connectorId = "";
        const state = await readState(connectorId);
        const liveVoice = !connectorId && state.threadId
          ? liveVoiceThreadSnapshot(state.threadId)
          : null;
        const external = liveVoice
          ? null
          : externalSessionSnapshot(state.threadId || "", connectorId);
        if (liveVoice) {
          initialStatus.running = true;
          initialStatus.externalRunning = false;
          initialStatus.liveVoiceRunning = true;
          initialStatus.liveVoiceConnected = Boolean(liveVoice.connected);
          initialStatus.liveVoiceTaskRunning = Boolean(liveVoice.taskRunning);
          initialStatus.reconnecting = !liveVoice.connected;
        } else if (external?.running) {
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

    if (req.method === "POST" && url.pathname === "/api/remote/project-upload") {
      const result = await saveProjectUploads(req, url.searchParams.get("dir") || "");
      return json(res, 200, result);
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
      const connectorId = "";
      const result = await submitRemoteMessage(body.message, body.followMode, connectorId);
      return json(res, result.local ? 200 : 202, result);
    }

    if (req.method === "POST" && url.pathname === "/api/remote/notice") {
      const body = await readBody(req);
      const connectorId = "";
      const content = cleanText(body.message || body.content || "", 20000).trim();
      if (!content) return json(res, 400, { error: "提示内容不能为空。" });
      const state = await readState(connectorId);
      const message = { role: "assistant", content, at: new Date().toISOString() };
      state.messages.push(message);
      state.messages = state.messages.slice(-80);
      await appendThreadNotice(state.threadId, message, connectorId);
      await writeState(syncLoadedCounts(state), connectorId);
      broadcast({ type: "message", connectorId, ...message, messageId: cleanText(body.messageId || "", 120).trim() || `notice-${Date.now()}`, final: true });
      return json(res, 200, { ok: true, message });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/select") {
      const body = await readBody(req);
      const connectorId = "";
      const payload = await selectRemoteThread(body.threadId || "", connectorId);
      return json(res, 200, { ok: true, ...payload });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/more") {
      const body = await readBody(req);
      const connectorId = "";
      const state = await readState(connectorId);
      if (!state.threadId) return json(res, 400, { error: "当前没有会话。" });
      if (body.threadId && body.threadId !== state.threadId) {
        return json(res, 409, { error: "会话已经切换，请重新点击加载更多。" });
      }
      const nextLimit = Math.max(Number(state.loadedCount) || 0, messagePageSize) + messagePageSize;
      const thread = await loadThreadPage(state.threadId, connectorId, nextLimit);
      const sessionMessages = await mergeLocalMessageMeta(state.threadId, thread.messages, state.messages);
      const persistentVoiceMessages = !connectorId
        ? await readLiveVoiceTranscripts(state.threadId).catch(() => [])
        : [];
      const persistentNotices = await readThreadNotices(state.threadId, connectorId).catch(() => []);
      const messages = mergeStateMessages(sessionMessages, [
        ...(state.messages || []),
        ...persistentVoiceMessages,
        ...persistentNotices
      ]);
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
      const connectorId = "";
      const payload = await createRemoteSession(body.cwd || "", connectorId);
      return json(res, 200, { ok: true, ...payload });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/name") {
      const body = await readBody(req);
      const threadId = cleanConnectorIdValue(body.threadId) || String(body.threadId || "");
      const name = String(body.name || "").trim();
      await setThreadName(threadId, name);
      const state = await readState("");
      if (state.threadId === threadId) broadcast({ type: "thread_name", threadId, name });
      return json(res, 200, { ok: true, threadId, name });
    }

    if (req.method === "POST" && url.pathname === "/api/remote/delete") {
      const body = await readBody(req);
      const connectorId = "";
      const threadId = String(body.threadId || "");
      const { runners } = await import("./runner.js");
      const runningRunner = runners.get(`${connectorId ? `${connectorId}:` : ""}thread:${threadId}`);
      if (runningRunner?.running) return json(res, 409, { error: "这个会话正在运行，不能删除。" });
      if (!connectorId && isLiveVoiceThreadActive(threadId)) {
        return json(res, 409, { error: "这个会话正在进行 Live Voice，不能删除。" });
      }
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
