const state = {
  running: false,
  threadId: "",
  threadName: "",
  cwd: "",
  absoluteCwd: "",
  fileCwd: "",
  fileCwdConnectorId: "",
  newCwd: "",
  newCwdConnectorId: "",
  loadedCount: 0,
  messageCount: 0,
  activeAssistant: null,
  assistantBubbles: new Map(),
  replyDone: false,
  queueLength: 0,
  queueMessages: [],
  runningThreads: [],
  steerLength: 0,
  steerMessages: [],
  followMode: "queue",
  contextUsage: null,
  uploads: [],
  connected: false,
  draftKey: "",
  sshConnected: false,
  sshLabel: "",
  sshCwd: "",
  eventDisconnected: false,
  lastEventSeq: 0,
  resyncingEvents: false,
  notifiedMessages: new Set(),
  currentTaskStartedAtMs: null,
  pushSubscribed: false,
  hideThoughts: localStorage.getItem("codex-remote-hide-thoughts") === "1",
  onlyMine: localStorage.getItem("codex-remote-only-mine") === "1",
  completedUnreadThreads: new Set(),
  connectors: [],
  connectorJobs: [],
  selectedConnectorId: "",
  disableLocal: false
};
const basePath = ["/codexremote", "/codex-remote"].find((path) => location.pathname === path || location.pathname.startsWith(`${path}/`)) || "";
const draftPrefix = "codex-remote-draft:";
let draftTimer = 0;
const slashCommands = [
  { command: "/help", title: "帮助", detail: "显示当前已接入的 Codex 命令" },
  { command: "/status", title: "状态", detail: "读取 app-server、线程、模型和目录状态" },
  { command: "/model", title: "模型", detail: "通过 model/list 查看可用模型" },
  { command: "/diff", title: "改动", detail: "通过 gitDiffToRemote 查看当前 Git diff" },
  { command: "/compact", title: "压缩上下文", detail: "通过 thread/compact/start 压缩当前线程" },
  { command: "/restart", title: "重启服务", detail: "重启 Caddy 端口和 Codex Remote 后端服务" },
  { command: "/follow queue", title: "队列模式", detail: "运行中发送的新消息进入队列" },
  { command: "/follow steer", title: "引导模式", detail: "运行中发送的新消息引导当前任务" },
  { command: "/steer ", title: "立即引导", detail: "把后续文字发送给当前正在运行的任务" },
  { command: "/notify", title: "通知", detail: notificationDetail, action: requestNotifications },
  { command: "/result", title: "只看结果", detail: () => state.hideThoughts ? "当前只显示用户气泡和 ✅ 气泡，点击后显示全部" : "隐藏思考过程气泡，只显示用户气泡和 ✅ 气泡", action: toggleResultOnly },
  { command: "/mine", title: "只看自己", detail: () => state.onlyMine ? "当前只显示自己发送的气泡，点击后显示全部" : "只显示自己发送的消息气泡", action: toggleOnlyMine },
  { command: "/stop", title: "中断", detail: "通过 turn/interrupt 中断当前回合" }
];

const els = {
  log: document.querySelector("#remoteLog"),
  logWrap: document.querySelector(".remoteLogWrap"),
  form: document.querySelector("#remoteForm"),
  input: document.querySelector("#remoteInput"),
  sendQueue: document.querySelector("#sendQueueRemote"),
  sendSteer: document.querySelector("#sendSteerRemote"),
  connectorsButton: document.querySelector("#connectorsRemote"),
  connectorPanel: document.querySelector("#connectorPanel"),
  connectorList: document.querySelector("#connectorList"),
  connectorJobs: document.querySelector("#connectorJobs"),
  connectorJobForm: document.querySelector("#connectorJobForm"),
  connectorPrompt: document.querySelector("#connectorPrompt"),
  connectorCwd: document.querySelector("#connectorCwd"),
  runConnectorJob: document.querySelector("#runConnectorJob"),
  refreshConnectors: document.querySelector("#refreshConnectors"),
  closeConnectors: document.querySelector("#closeConnectors"),
  sshConnectButton: document.querySelector("#sshConnectRemote"),
  onlyMineButton: document.querySelector("#onlyMineRemote"),
  sshConnectPanel: document.querySelector("#sshConnectPanel"),
  sshPanelTitle: document.querySelector("#sshPanelTitle"),
  toggleSshView: document.querySelector("#toggleSshView"),
  sshConnectForm: document.querySelector("#sshConnectForm"),
  sshFilesView: document.querySelector("#sshFilesView"),
  sshTarget: document.querySelector("#sshTarget"),
  sshPassword: document.querySelector("#sshPassword"),
  sshStatus: document.querySelector("#sshStatus"),
  sshDisconnect: document.querySelector("#sshDisconnect"),
  sshPath: document.querySelector("#sshPath"),
  sshList: document.querySelector("#sshList"),
  sshPreview: document.querySelector("#sshPreview"),
  createSshFolder: document.querySelector("#createSshFolder"),
  createSshFile: document.querySelector("#createSshFile"),
  closeSshConnect: document.querySelector("#closeSshConnect"),
  filesButton: document.querySelector("#filesRemote"),
  filePanel: document.querySelector("#filePanel"),
  fileList: document.querySelector("#fileList"),
  filePath: document.querySelector("#filePath"),
  filePreview: document.querySelector("#filePreview"),
  createFolder: document.querySelector("#createFolderRemote"),
  createFile: document.querySelector("#createFileRemote"),
  closeFiles: document.querySelector("#closeFiles"),
  newChat: document.querySelector("#newRemote"),
  newPath: document.querySelector("#newPath"),
  newList: document.querySelector("#newList"),
  createSession: document.querySelector("#createSessionRemote"),
  threadButton: document.querySelector("#threadRemote"),
  threadPanel: document.querySelector("#threadPanel"),
  threadPanelTitle: document.querySelector("#threadPanelTitle"),
  toggleThreadView: document.querySelector("#toggleThreadView"),
  threadExistingView: document.querySelector("#threadExistingView"),
  threadNewView: document.querySelector("#threadNewView"),
  threadList: document.querySelector("#threadList"),
  closeThreads: document.querySelector("#closeThreads"),
  loadMore: document.querySelector("#loadMoreMessages"),
  queueButton: document.querySelector("#queueRemote"),
  queuePanel: document.querySelector("#queuePanel"),
  scrollTop: document.querySelector("#scrollTopRemote"),
  scrollBottom: document.querySelector("#scrollBottomRemote"),
  slashButton: document.querySelector("#slashRemote"),
  commandMenu: document.querySelector("#commandMenu"),
  commandList: document.querySelector("#commandList"),
  commandQuick: document.querySelectorAll(".commandQuick"),
  uploadButton: document.querySelector("#uploadRemote"),
  fileInput: document.querySelector("#fileRemote"),
  uploadList: document.querySelector("#uploadList"),
  statusIcon: document.querySelector("#remoteStatusIcon"),
  meta: document.querySelector("#remoteMeta"),
  mode: document.querySelector("#remoteMode")
};

function notificationPermission() {
  return "Notification" in window ? Notification.permission : "unsupported";
}

function notificationDetail() {
  const permission = notificationPermission();
  if (permission === "granted") return state.pushSubscribed ? "已开启，后台也会收到任务完成通知" : "已开启，Codex 最终回复会发到系统通知栏";
  if (permission === "denied") return "通知已被浏览器阻止，请到 Chrome/系统通知设置里放开";
  if (permission === "unsupported") return "当前浏览器不支持网页通知";
  return "点击后向浏览器申请通知权限";
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

async function subscribeWebPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const data = await request("/api/remote/push/key");
    if (!data.publicKey) return false;
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey)
    });
  }
  await request("/api/remote/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription })
  });
  state.pushSubscribed = true;
  return true;
}

function webPushSubscribeErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (/push service error/i.test(message)) {
    return [
      "通知订阅失败：当前手机浏览器无法连接系统 Push 服务。",
      "这通常不是服务器问题，而是 Chrome/Google Play 服务/FCM 在这台手机或当前网络下不可用。可以尝试更新 Chrome、放开 Chrome 通知权限、关闭省电限制，或换一个能访问 FCM 的网络后再点 /notify。"
    ].join("\n");
  }
  if (/permission/i.test(message)) return "通知订阅失败：浏览器没有通知权限，请到 Chrome 或系统通知设置里允许。";
  return `通知订阅失败：${message}`;
}

async function requestNotifications() {
  if (notificationPermission() === "unsupported") return;
  if (Notification.permission === "default") await Notification.requestPermission();
  let enabled = false;
  if (Notification.permission === "granted") {
    await subscribeWebPush().catch((error) => {
      console.error("web push subscribe failed", error);
      upsertAssistantMessage(webPushSubscribeErrorMessage(error), true, "notify-error");
    });
    if (state.pushSubscribed) {
      enabled = true;
      const test = await request("/api/remote/push/test", { method: "POST" }).catch((error) => {
        upsertAssistantMessage(`测试通知发送失败：${error.message || error}`, true, "notify-test-error");
        return null;
      });
      if (test?.sent) appendEvent("后台通知已开启，并已发送测试通知。");
      else if (test) appendEvent("后台通知已订阅，但当前没有成功发送测试通知。");
    }
  } else if (Notification.permission === "denied") {
    upsertAssistantMessage("通知已被浏览器阻止，请到 Chrome 或系统通知设置里放开。", true, "notify-denied");
  }
  if (!enabled && Notification.permission === "granted") appendEvent("系统通知已允许，但当前浏览器没有完成后台 Push 订阅。");
  renderCommandList();
  closeCommandMenu();
}

function notificationBody(text = "") {
  return String(text)
    .replace(/^[✅🤔]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Codex 有新的回复";
}

async function notifyCodexReply(data = {}) {
  if (notificationPermission() !== "granted") return;
  if (state.pushSubscribed) return;
  const key = data.messageId || `${data.role}:${notificationBody(data.content)}`;
  if (state.notifiedMessages.has(key)) return;
  state.notifiedMessages.add(key);
  const options = {
    body: notificationBody(data.content),
    icon: "icon.svg",
    badge: "icon.svg",
    tag: `codex-reply-${key}`,
    renotify: true,
    data: { url: location.href }
  };
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification("服务器Codex", options);
      return;
    }
    new Notification("服务器Codex", options);
  } catch {
    try {
      new Notification("服务器Codex", options);
    } catch {}
  }
}

function setContextUsage(contextUsage) {
  state.contextUsage = contextUsage && Number.isFinite(Number(contextUsage.remainingPercent)) ? contextUsage : null;
}

function updateStatusIcon() {
  if (!state.connected) {
    els.statusIcon.textContent = "🔵";
    els.statusIcon.title = "断开连接，正在连接";
  } else if (state.running) {
    els.statusIcon.textContent = "🔴";
    els.statusIcon.title = "Codex 正在处理";
  } else {
    els.statusIcon.textContent = "🟢";
    els.statusIcon.title = "Codex 空闲";
  }
}

function setRunning(running, queueLength = state.queueLength, queueMessages = state.queueMessages, followMode = state.followMode, steerLength = state.steerLength, steerMessages = state.steerMessages, contextUsage = state.contextUsage, runningThreads = state.runningThreads) {
  state.running = Boolean(running);
  state.queueLength = Number(queueLength) || 0;
  state.queueMessages = Array.isArray(queueMessages) ? queueMessages : [];
  state.runningThreads = Array.isArray(runningThreads) ? runningThreads : [];
  state.steerLength = Number(steerLength) || 0;
  state.steerMessages = Array.isArray(steerMessages) ? steerMessages : [];
  state.followMode = followMode === "steer" ? "steer" : "queue";
  setContextUsage(contextUsage);
  if (state.running) state.replyDone = false;
  els.sendQueue.disabled = false;
  els.sendSteer.disabled = false;
  if (els.newChat) els.newChat.disabled = state.running;
  els.threadButton.disabled = false;
  updateMeta();
  renderQueuePanel();
  updateStatusIcon();
}

function updateMeta() {
  const connectorTag = state.selectedConnectorId ? `[${currentConnectorLabel()}] ` : "";
  const title = state.threadId ? (state.threadName || `会话 ${state.threadId.slice(0, 8)}`) : "新会话";
  const mode = state.followMode === "steer" ? "引导模式" : "队列模式";
  const percent = state.contextUsage ? Math.max(0, Math.min(100, Math.round(Number(state.contextUsage.remainingPercent)))) : null;
  const modeText = Number.isFinite(percent) ? `${mode} · 上下文 ${percent}%` : mode;
  els.meta.textContent = `${connectorTag}${title}`;
  els.meta.title = `${connectorTag}${title}`;
  els.mode.textContent = modeText;
  els.mode.title = modeText;
}

function autosizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
  updateVisualViewport();
}

function updateVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  document.documentElement.style.setProperty("--keyboard-offset", `${keyboardOffset}px`);
  document.documentElement.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
}

function draftKeyFor(threadId = state.threadId, cwd = state.cwd) {
  return `${draftPrefix}${threadId || `new:${cwd || "root"}`}`;
}

function saveDraft() {
  const key = state.draftKey || draftKeyFor();
  const value = els.input.value;
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
  scheduleServerDraft(value, state.threadId, state.cwd);
}

function clearDraft() {
  localStorage.removeItem(state.draftKey || draftKeyFor());
  saveServerDraft("", state.threadId, state.cwd);
}

function restoreDraftForCurrentState(serverDraft) {
  const nextKey = draftKeyFor();
  if (state.draftKey === nextKey) return;
  state.draftKey = nextKey;
  els.input.value = typeof serverDraft === "string" ? serverDraft : (localStorage.getItem(nextKey) || "");
  autosizeInput();
}

function scheduleServerDraft(text, threadId, cwd) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveServerDraft(text, threadId, cwd), 400);
}

async function saveServerDraft(text, threadId, cwd) {
  clearTimeout(draftTimer);
  try {
    await request("/api/remote/draft", {
      method: "POST",
      body: JSON.stringify({ text, threadId, cwd })
    });
  } catch {
    // Local draft remains as fallback when the network is unavailable.
  }
}

function updateScrollJumps() {
  const maxScroll = Math.max(0, els.logWrap.scrollHeight - els.logWrap.clientHeight);
  const top = els.logWrap.scrollTop;
  const inMiddle = top > 4 && maxScroll - top > 4;
  els.scrollTop.hidden = !inMiddle;
  els.scrollBottom.hidden = !inMiddle;
}

function isNearBottom() {
  const maxScroll = Math.max(0, els.logWrap.scrollHeight - els.logWrap.clientHeight);
  return maxScroll - els.logWrap.scrollTop < 80;
}

function renderQueuePanel() {
  const showingSteer = state.steerLength > 0 && (state.followMode === "steer" || !state.queueLength);
  const items = showingSteer ? state.steerMessages : state.queueMessages;
  const count = showingSteer ? state.steerLength : state.queueLength;
  const hasItems = count > 0;
  els.queueButton.hidden = !hasItems;
  els.queueButton.textContent = showingSteer ? `引导 ${count}` : `队列 ${count}`;
  if (!hasItems) {
    els.queuePanel.hidden = true;
    els.queuePanel.innerHTML = "";
    return;
  }
  els.queuePanel.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "queueItem";
    const index = document.createElement("span");
    index.className = "queueIndex";
    index.textContent = `${item.index || ""}.`;
    const message = document.createElement("span");
    message.textContent = item.message || "";
    row.append(index, message);
    els.queuePanel.appendChild(row);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function downloadUrl(file) {
  return `${basePath}/api/remote/download?p=${encodeURIComponent(file)}`;
}

function inlineUrl(file) {
  return `${downloadUrl(file)}&inline=1`;
}

function isImageFile(file) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(file);
}

function renderFileLink(file, label = file) {
  const href = downloadUrl(file);
  if (isImageFile(file)) {
    return `<a class="imageLink" href="${href}" target="_blank" rel="noopener noreferrer" download title="打开或保存图片"><img class="messageImage" src="${inlineUrl(file)}" alt="${escapeHtml(label)}"></a>`;
  }
  return `<a href="${href}" target="_blank" rel="noopener noreferrer" download>${escapeHtml(label)}</a>`;
}

function renderInlineMarkdown(text) {
  const placeholders = [];
  const nextPlaceholder = (html) => {
    const key = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push({ key, html });
    return key;
  };
  let source = String(text);
  source = source.replace(/`([^`]+)`/g, (_, code) => nextPlaceholder(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/!\[([^\]]*)\]\((\/root\/codex项目2\/[^)]+)\)/g, (_, label, file) => nextPlaceholder(renderFileLink(file, label || file)));
  source = source.replace(/\[([^\]]+)\]\((\/root\/codex项目2\/[^)]+)\)/g, (_, label, file) => nextPlaceholder(renderFileLink(file, label)));
  source = source.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = escapeHtml(href);
    return nextPlaceholder(`<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });
  source = source.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]|\[\[([^\]]+)\]\]/g, (_, _target, label, plain) => label || plain || "");
  let html = escapeHtml(source);
  html = html.replace(/(^|[\s(])((?:\/root\/codex项目2\/)[^\s<>"'，。；、)]+)/g, (_, prefix, file) => `${prefix}${renderFileLink(file)}`);
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, (_, inner) => nextPlaceholder(`<b><i>${inner}</i></b>`));
  html = html.replace(/\*\*(.+?)\*\*/g, (_, inner) => nextPlaceholder(`<b>${inner}</b>`));
  html = html.replace(/__(.+?)__/g, (_, inner) => nextPlaceholder(`<b>${inner}</b>`));
  html = html.replace(/~~(.+?)~~/g, (_, inner) => nextPlaceholder(`<s>${inner}</s>`));
  html = html.replace(/(^|[^*])\*([^*]+?)\*(?=[^*]|$)/g, (_, prefix, inner) => `${prefix}<i>${inner}</i>`);
  for (let pass = 0; pass <= placeholders.length; pass++) {
    let changed = false;
    for (const item of placeholders) {
      if (html.includes(item.key)) {
        html = html.replace(item.key, item.html);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return html;
}

function tableCellVisualWidth(cell) {
  return String(cell)
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .length;
}

function renderTable(lines) {
  const rows = lines.map((line) => {
    const trimmed = line.trim();
    const inner = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1).trim() : trimmed;
    return {
      isSeparator: /^\|[\s:|-]+\|$/.test(trimmed),
      cells: inner.split("|").map((cell) => cell.trim())
    };
  });
  const columnCount = rows.reduce((max, row) => row.isSeparator ? max : Math.max(max, row.cells.length), 0);
  const widths = Array(columnCount).fill(0);
  for (const row of rows) {
    if (row.isSeparator) continue;
    row.cells.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], tableCellVisualWidth(cell));
    });
  }
  const rendered = rows.map((row) => {
    if (row.isSeparator) return widths.map((width) => "-".repeat(width)).join("-+-");
    return widths.map((width, index) => {
      const cell = row.cells[index] || "";
      return `${renderInlineMarkdown(cell)}${" ".repeat(Math.max(0, width - tableCellVisualWidth(cell)))}`;
    }).join(" | ");
  });
  return `<pre>${rendered.join("\n")}</pre>`;
}

function formatSize(size) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function renderUploadList() {
  els.uploadList.hidden = !state.uploads.length;
  els.uploadList.innerHTML = "";
  state.uploads.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "uploadChip";
    chip.title = file.path;
    const label = document.createElement("span");
    label.className = "uploadChipText";
    label.textContent = `📎 ${file.name} ${formatSize(file.size)}`;
    const remove = document.createElement("button");
    remove.className = "uploadRemove";
    remove.type = "button";
    remove.title = "移除文件";
    remove.setAttribute("aria-label", `移除 ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.uploads.splice(index, 1);
      renderUploadList();
    });
    chip.append(label, remove);
    els.uploadList.appendChild(chip);
  });
}

async function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const [index, file] of files.entries()) {
    const name = file.name || `pasted-${Date.now()}-${index}.${file.type?.split("/")[1] || "bin"}`;
    form.append("files", file, name);
  }
  els.uploadButton.disabled = true;
  try {
    const response = await fetch(`${basePath}/api/remote/upload`, { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.uploads.push(...(data.files || []));
    renderUploadList();
  } catch (error) {
    upsertAssistantMessage(`上传失败：${error.message}`, true, "upload-error");
  } finally {
    els.uploadButton.disabled = false;
    els.fileInput.value = "";
  }
}

function pastedFiles(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return [];
  const files = [...clipboard.files];
  if (files.length) return files;
  return [...clipboard.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function messageWithUploads(message) {
  if (!state.uploads.length) return message;
  const lines = state.uploads.map((file, index) => `${index + 1}. ${file.name}\n   路径：${file.path}`);
  const prompt = message || "请读取并处理这些上传文件。";
  return `${prompt}\n\n上传文件：\n${lines.join("\n")}\n\n你可以直接读取以上本机路径中的文件。`;
}

function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let fence = null;
  let blockquote = [];
  let table = [];

  const flushBlockquote = () => {
    if (!blockquote.length) return;
    let start = 0;
    let content = "";
    const callout = blockquote[0].match(/^\[!(\w+)\]\s*(.*)$/);
    if (callout) {
      content += callout[2] ? `<b>${escapeHtml(callout[1])}: ${escapeHtml(callout[2])}</b>` : `<b>${escapeHtml(callout[1])}</b>`;
      start = 1;
      if (start < blockquote.length) content += "\n";
    }
    content += blockquote.slice(start).map(renderInlineMarkdown).join("\n");
    html.push(`<blockquote>${content}</blockquote>`);
    blockquote = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    html.push(renderTable(table));
    table = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushBlockquote();
      flushTable();
      if (!fence) {
        fence = { lang: trimmed.slice(3).trim(), lines: [] };
      } else {
        const lang = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : "";
        html.push(`<pre><code${lang}>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
        fence = null;
      }
      continue;
    }
    if (fence) {
      fence.lines.push(line);
      continue;
    }

    const isQuote = trimmed.startsWith("> ") || trimmed === ">";
    const isTable = trimmed.length > 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
    if (!isQuote) flushBlockquote();
    if (!isTable) flushTable();
    if (isQuote) {
      blockquote.push(trimmed === ">" ? "" : trimmed.replace(/^>\s?/, ""));
      continue;
    }
    if (isTable) {
      table.push(trimmed);
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) html.push(`<b>${renderInlineMarkdown(heading[1])}</b>`);
    else if (/^[-*_]{3,}$/.test(trimmed)) html.push("——————————");
    else {
      const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
      const ordered = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (bullet) {
        html.push(`${"  ".repeat(Math.floor(bullet[1].length / 2))}• ${renderInlineMarkdown(bullet[2])}`);
      } else if (ordered) {
        const marker = line.slice(0, line.length - ordered[2].length).trim();
        html.push(`${"  ".repeat(Math.floor(ordered[1].length / 2))}${escapeHtml(marker)} ${renderInlineMarkdown(ordered[2])}`);
      } else {
        html.push(renderInlineMarkdown(line));
      }
    }
  }

  flushBlockquote();
  flushTable();
  if (fence) html.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  return html.join("\n");
}

function setMessageContent(element, text) {
  element.innerHTML = renderMarkdown(text);
  if (element.classList.contains("assistant")) {
    element.classList.toggle("completion", /^✅\s/.test(text || ""));
  }
}

function scrollToLatest(force = false) {
  if (!force && !isNearBottom()) {
    requestAnimationFrame(updateScrollJumps);
    return;
  }
  els.logWrap.scrollTop = els.logWrap.scrollHeight;
  requestAnimationFrame(updateScrollJumps);
}

function applyMessageFilter() {
  els.log.classList.toggle("hideThoughts", state.hideThoughts);
  els.log.classList.toggle("onlyMine", state.onlyMine);
  if (els.onlyMineButton) {
    els.onlyMineButton.classList.toggle("active", state.onlyMine);
    els.onlyMineButton.title = state.onlyMine ? "显示全部消息" : "只看自己发送";
    els.onlyMineButton.setAttribute("aria-pressed", state.onlyMine ? "true" : "false");
  }
}

function toggleResultOnly() {
  state.hideThoughts = !state.hideThoughts;
  localStorage.setItem("codex-remote-hide-thoughts", state.hideThoughts ? "1" : "0");
  applyMessageFilter();
  renderCommandList();
  closeCommandMenu();
  scrollToLatest(true);
}

function toggleOnlyMine() {
  state.onlyMine = !state.onlyMine;
  localStorage.setItem("codex-remote-only-mine", state.onlyMine ? "1" : "0");
  applyMessageFilter();
  renderCommandList();
  closeCommandMenu();
  scrollToLatest(true);
}

function formatBubbleTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `本次任务工作了 ${hours}小时${minutes}分${seconds}秒`;
  if (minutes) return `本次任务工作了 ${minutes}分${seconds}秒`;
  return `本次任务工作了 ${seconds}秒`;
}

function appendMessage(role, text, meta = {}) {
  if (!text) return;
  const shouldFollow = isNearBottom();
  const isCompletion = role === "assistant" && /^✅\s/.test(text || "");
  const wrapper = document.createElement("div");
  wrapper.className = `messageBlock ${role}Block${isCompletion ? " completionBlock" : ""}`;
  const item = document.createElement("div");
  item.className = `message ${role}${isCompletion ? " completion" : ""}`;
  setMessageContent(item, text);
  wrapper.appendChild(item);
  const at = meta.at || (role === "user" ? new Date().toISOString() : "");
  const timeText = formatBubbleTime(at);
  const durationText = meta.taskDurationMs !== undefined && meta.taskDurationMs !== null ? formatDuration(meta.taskDurationMs) : "";
  const metaText = [timeText, durationText].filter(Boolean).join(" · ");
  if (role === "user" || metaText) {
    const time = document.createElement("div");
    time.className = "messageMeta messageMetaBottom";
    time.textContent = metaText || formatBubbleTime(new Date().toISOString());
    wrapper.appendChild(time);
  }
  els.log.appendChild(wrapper);
  if (shouldFollow) scrollToLatest(true);
  else requestAnimationFrame(updateScrollJumps);
  return item;
}

function appendEvent(text) {
  if (!text) return;
  const shouldFollow = isNearBottom();
  const item = document.createElement("div");
  item.className = "remoteEvent";
  item.textContent = text;
  els.log.appendChild(item);
  if (shouldFollow) scrollToLatest(true);
  else requestAnimationFrame(updateScrollJumps);
}

function appendCompletionEvent(data) {
  const messages = data.messages || [];
  const last = messages[messages.length - 1];
  if (!data.running && !data.inflight && last?.role === "assistant" && /^✅\s/.test(last.content || "")) {
    appendEvent("任务已完成");
  }
}

function upsertAssistantMessage(text, final = false, messageId = "assistant", meta = {}) {
  if (!text) return;
  let bubble = state.assistantBubbles.get(messageId);
  if (final && /^✅\s/.test(text || "")) {
    if (bubble?.isConnected) {
      const container = bubble.closest(".messageBlock") || bubble;
      container.remove();
    }
    appendMessage("assistant", text, { ...meta, at: meta.at || new Date().toISOString() });
    state.assistantBubbles.delete(messageId);
    return;
  }
  if (!bubble?.isConnected) {
    bubble = appendMessage("assistant", text);
    state.assistantBubbles.set(messageId, bubble);
  } else {
    const shouldFollow = isNearBottom();
    setMessageContent(bubble, text);
    if (shouldFollow) scrollToLatest(true);
    else requestAnimationFrame(updateScrollJumps);
  }
  if (final) state.assistantBubbles.delete(messageId);
}

function closeCommandMenu() {
  els.commandMenu.hidden = true;
}

function toggleCommandMenu() {
  els.commandMenu.hidden = !els.commandMenu.hidden;
}

function insertCommand(command) {
  const text = els.input.value;
  if (text.trim().startsWith("/")) {
    els.input.value = text.replace(/^\s*\/\S*/, command);
  } else {
    els.input.value = text ? `${command} ${text}` : command;
  }
  saveDraft();
  closeCommandMenu();
  autosizeInput();
  els.input.focus();
}

function renderCommandList() {
  els.commandList.innerHTML = "";
  for (const item of slashCommands) {
    const button = document.createElement("button");
    button.className = "commandItem";
    button.type = "button";
    button.innerHTML = "<strong></strong><span></span><small></small>";
    button.querySelector("strong").textContent = item.command;
    button.querySelector("span").textContent = item.title;
    button.querySelector("small").textContent = typeof item.detail === "function" ? item.detail() : item.detail;
    button.addEventListener("click", () => item.action ? item.action() : insertCommand(item.command));
    els.commandList.appendChild(button);
  }
}

async function request(url, options = {}) {
  const method = (options.method || (options.body ? "POST" : "GET")).toUpperCase();
  let finalUrl = url;
  const connectorParam = `connector=${encodeURIComponent(state.selectedConnectorId || "")}`;
  if (!options.body) {
    finalUrl += (url.includes("?") ? "&" : "?") + connectorParam;
  }
  let finalOptions = { ...options };
  if (options.body && method !== "GET") {
    try {
      const parsed = JSON.parse(options.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.connectorId === undefined) {
        parsed.connectorId = state.selectedConnectorId || "";
        finalOptions.body = JSON.stringify(parsed);
      }
    } catch {}
  }
  const response = await fetch(`${basePath}${finalUrl}`, {
    headers: { "Content-Type": "application/json" },
    ...finalOptions
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) location.href = `${basePath}/login.html`;
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function loadState() {
  const data = await request("/api/remote/state");
  renderState(data);
}

function renderState(data) {
  saveDraft();
  if (Array.isArray(data.connectors)) state.connectors = data.connectors;
  if (data.disableLocal !== undefined) state.disableLocal = data.disableLocal;
  const shouldFollow = isNearBottom();
  const previousTop = els.logWrap.scrollTop;
  const previousThreadId = state.threadId;
  if (Number(data.eventSeq) > state.lastEventSeq) state.lastEventSeq = Number(data.eventSeq);
  state.threadId = data.threadId || "";
  if (Object.prototype.hasOwnProperty.call(data, "threadName")) {
    state.threadName = data.threadName || "";
  } else if (state.threadId !== previousThreadId) {
    state.threadName = "";
  }
  state.cwd = data.cwd || "";
  state.absoluteCwd = data.absoluteCwd || "";
  restoreDraftForCurrentState(data.draft);
  state.loadedCount = Number(data.loadedCount || data.messages?.length || 0);
  state.messageCount = Number(data.messageCount || state.loadedCount);
  if (data.followMode === "steer" || data.followMode === "queue") {
    state.followMode = data.followMode;
  }
  state.steerLength = Number(data.steerLength || 0);
  state.steerMessages = Array.isArray(data.steerMessages) ? data.steerMessages : [];
  state.activeAssistant = null;
  state.assistantBubbles.clear();
  state.replyDone = false;
  els.log.innerHTML = "";
  applyMessageFilter();
  for (const message of data.messages || []) {
    appendMessage(message.role, message.content, message);
  }
  for (const message of data.liveMessages || []) {
    if (message.role === "assistant") {
      upsertAssistantMessage(message.content, message.final, message.messageId || "assistant", message);
    } else {
      appendMessage(message.role, message.content, message);
    }
  }
  appendCompletionEvent(data);
  if (shouldFollow) scrollToLatest(true);
  else els.logWrap.scrollTop = previousTop;
  updateLoadMore();
  setRunning(data.running, data.queueLength, data.queueMessages, data.followMode, data.steerLength, data.steerMessages, data.contextUsage, data.runningThreads);
  requestAnimationFrame(updateScrollJumps);
}

function updateLoadMore() {
  const hasMore = state.threadId && state.messageCount > state.loadedCount;
  els.loadMore.hidden = !hasMore;
  els.loadMore.textContent = hasMore ? `加载更多（${state.loadedCount}/${state.messageCount}）` : "加载更多";
}

async function loadMoreMessages() {
  if (!state.threadId || state.running) return;
  const previousHeight = els.logWrap.scrollHeight;
  const data = await request("/api/remote/more", { method: "POST" });
  renderState(data);
  els.logWrap.scrollTop = Math.max(0, els.logWrap.scrollHeight - previousHeight);
  updateScrollJumps();
}

function threadSubtitle(thread) {
  const date = thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : "";
  const status = thread.running ? `运行中${thread.queueLength ? ` · 队列 ${thread.queueLength}` : ""}` : "";
  return [status, date, `${thread.messageCount} 条`].filter(Boolean).join(" · ");
}

function fileIcon(item) {
  if (item.type === "dir") return "📁";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(item.name)) return "🖼️";
  return "📄";
}

function displayProjectPath(cwd = "", absoluteCwd = "") {
  return absoluteCwd || (cwd ? `/${cwd}` : "项目根目录");
}

async function openFiles(dir = "") {
  const connectorId = state.selectedConnectorId || "";
  if (state.fileCwdConnectorId !== connectorId) {
    state.fileCwd = "";
    state.fileCwdConnectorId = connectorId;
  }
  els.filePanel.hidden = false;
  els.filePreview.hidden = true;
  els.fileList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request(`/api/remote/files?dir=${encodeURIComponent(dir)}`);
    state.fileCwd = data.cwd || "";
    state.fileCwdConnectorId = connectorId;
    els.filePath.textContent = displayProjectPath(data.cwd, data.absoluteCwd);
    els.fileList.innerHTML = "";
    if (data.cwd) {
      const up = document.createElement("button");
      up.className = "fileItem";
      up.type = "button";
      up.dataset.type = "dir";
      up.dataset.path = data.parent || "";
      up.textContent = "↩ 上一级";
      els.fileList.appendChild(up);
    }
    for (const item of data.entries || []) {
      const row = document.createElement("div");
      row.className = "fileItem sshFileItem";
      row.role = "button";
      row.tabIndex = 0;
      row.dataset.type = item.type;
      row.dataset.path = item.path;
      row.dataset.name = item.name;
      row.innerHTML = '<span></span><div><strong></strong><small></small></div><div class="fileActions"></div>';
      row.querySelector("span").textContent = fileIcon(item);
      row.querySelector("strong").textContent = item.name;
      row.querySelector("small").textContent = item.type === "dir" ? "文件夹" : `${formatSize(item.size)} · ${new Date(item.mtime).toLocaleString()}`;
      const actions = row.querySelector(".fileActions");
      if (item.type === "file") actions.append(fileActionButton("编辑", "edit"));
      actions.append(fileActionButton("改名", "rename"), fileActionButton("删除", "delete", "danger"));
      els.fileList.appendChild(row);
    }
  } catch (error) {
    els.fileList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
  }
}

function fileActionButton(text, action, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.fileAction = action;
  button.className = extraClass;
  button.textContent = text;
  return button;
}

async function createFolderInCurrentFilePanel() {
  const name = prompt("请输入文件夹名称");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    alert("文件夹名称不能为空。");
    return;
  }
  const data = await request("/api/remote/folders", {
    method: "POST",
    body: JSON.stringify({ dir: state.fileCwd || "", name: trimmed })
  });
  state.fileCwd = data.cwd || state.fileCwd || "";
  await openFiles(state.fileCwd);
}

async function createFileInCurrentFilePanel() {
  const name = prompt("请输入文件名");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    alert("文件名不能为空。");
    return;
  }
  const content = prompt("请输入初始内容，可留空", "");
  if (content === null) return;
  const data = await request("/api/remote/files", {
    method: "POST",
    body: JSON.stringify({ dir: state.fileCwd || "", name: trimmed, content })
  });
  state.fileCwd = data.cwd || state.fileCwd || "";
  await openFiles(state.fileCwd);
}

async function renameProjectItem(file, oldName = "") {
  const name = prompt("请输入新名称", oldName || "");
  if (name === null) return;
  const data = await request("/api/remote/path/rename", {
    method: "POST",
    body: JSON.stringify({ path: file, name })
  });
  state.fileCwd = data.cwd || state.fileCwd || "";
  await openFiles(state.fileCwd);
}

async function deleteProjectItem(file = "", name = "", type = "") {
  if (!file) return;
  const label = name || file;
  const isDir = type === "dir";
  if (!confirm(`确定删除${isDir ? "文件夹" : "文件"}“${label}”${isDir ? "及其中所有内容" : ""}吗？`)) return;
  const url = isDir ? "/api/remote/folders/delete" : "/api/remote/files/delete";
  const data = await request(url, {
    method: "POST",
    body: JSON.stringify({ path: file })
  });
  state.fileCwd = data.cwd || state.fileCwd || "";
  els.filePreview.hidden = true;
  await openFiles(state.fileCwd);
}

async function openNewSessionPicker(dir = undefined) {
  const connectorId = state.selectedConnectorId || "";
  if (state.newCwdConnectorId !== connectorId) {
    state.newCwd = "";
    state.newCwdConnectorId = connectorId;
  }
  const nextDir = dir === undefined ? (state.newCwd || state.cwd || "") : dir;
  state.newCwd = nextDir || "";
  els.threadPanel.hidden = false;
  setThreadView("new");
  els.newList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request(`/api/remote/files?dir=${encodeURIComponent(state.newCwd)}`);
    state.newCwd = data.cwd || "";
    els.newPath.textContent = data.absoluteCwd || displayProjectPath(state.newCwd);
    els.newList.innerHTML = "";
    if (data.cwd) {
      const up = document.createElement("button");
      up.className = "fileItem";
      up.type = "button";
      up.dataset.type = "dir";
      up.dataset.path = data.parent || "";
      up.textContent = "↩ 上一级";
      els.newList.appendChild(up);
    }
    const dirs = (data.entries || []).filter((item) => item.type === "dir");
    if (!dirs.length && !data.cwd) {
      els.newList.innerHTML = '<div class="remoteEvent">没有可进入的文件夹</div>';
    }
    for (const item of dirs) {
      const row = document.createElement("button");
      row.className = "fileItem";
      row.type = "button";
      row.dataset.type = item.type;
      row.dataset.path = item.path;
      row.innerHTML = '<span></span><strong></strong><small></small>';
      row.querySelector("span").textContent = "📁";
      row.querySelector("strong").textContent = item.name;
      row.querySelector("small").textContent = "文件夹";
      els.newList.appendChild(row);
    }
  } catch (error) {
    els.newList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
  }
}

async function createSessionInSelectedFolder() {
  if (state.running) return;
  const data = await request("/api/remote/new", {
    method: "POST",
    body: JSON.stringify({ cwd: state.newCwd || "" })
  });
  renderState(data);
  els.threadPanel.hidden = true;
}

async function previewFile(file) {
  els.filePreview.hidden = false;
  els.filePreview.innerHTML = '<div class="remoteEvent">加载中...</div>';
  const download = downloadUrl(file);
  try {
    const data = await request(`/api/remote/file?path=${encodeURIComponent(file)}`);
    if (data.type === "image") {
      els.filePreview.innerHTML = `<div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><a href="${download}" download>下载</a></div><img src="${basePath}${data.url}" alt="${escapeHtml(data.path)}">`;
    } else {
      els.filePreview.innerHTML = `
        <div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><div class="panelActions"><button type="button" data-save-project-file>保存</button><a href="${download}" download>下载</a></div></div>
        <div class="sshEditor"><textarea id="projectEditorText" spellcheck="false">${escapeHtml(data.text)}</textarea></div>
      `;
      els.filePreview.querySelector("[data-save-project-file]").addEventListener("click", () => saveProjectFile(data.path));
    }
  } catch (error) {
    els.filePreview.innerHTML = `<div class="filePreviewTop"><strong>${escapeHtml(file)}</strong><a href="${download}" download>下载</a></div><div class="remoteEvent">${escapeHtml(error.message)}</div>`;
  }
}

async function saveProjectFile(file) {
  const editor = els.filePreview.querySelector("#projectEditorText");
  if (!editor) return;
  await request("/api/remote/file/write", {
    method: "POST",
    body: JSON.stringify({ path: file, content: editor.value })
  });
  await previewFile(file);
}

function updateSshStatus(data = {}) {
  state.sshConnected = Boolean(data.connected);
  state.sshLabel = data.label || state.sshLabel || "";
  state.sshCwd = data.cwd || state.sshCwd || "";
  els.sshStatus.textContent = state.sshConnected ? `已连接：${state.sshLabel}` : "未连接";
}

function setSshView(view = "config") {
  const showFiles = view === "files";
  els.sshConnectForm.hidden = showFiles;
  els.sshFilesView.hidden = !showFiles;
  els.sshPanelTitle.textContent = showFiles ? "ssh电脑" : "ssh连接";
  els.toggleSshView.textContent = showFiles ? "ssh连接" : "ssh电脑";
}

async function loadSshStatus() {
  const data = await request("/api/remote/ssh/status");
  updateSshStatus(data);
  return data;
}

async function openSshConnect() {
  els.sshConnectPanel.hidden = false;
  setSshView("config");
  try {
    updateSshStatus(await loadSshStatus());
  } catch (error) {
    els.sshStatus.textContent = `状态读取失败：${error.message}`;
  }
}

async function connectSsh() {
  const target = els.sshTarget.value.trim();
  const password = els.sshPassword.value;
  els.sshStatus.textContent = "连接中...";
  const data = await request("/api/remote/ssh/connect", {
    method: "POST",
    body: JSON.stringify({ target, password })
  });
  els.sshPassword.value = "";
  updateSshStatus(data);
  await openSshComputer(data.cwd || "");
}

async function disconnectSsh() {
  await request("/api/remote/ssh/disconnect", { method: "POST" });
  updateSshStatus({ connected: false });
  els.sshList.innerHTML = "";
  els.sshPath.textContent = "";
  els.sshPreview.hidden = true;
}

async function openSshComputer(dir = state.sshCwd || "") {
  els.sshConnectPanel.hidden = false;
  setSshView("files");
  els.sshPreview.hidden = true;
  els.sshList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request(`/api/remote/ssh/files?dir=${encodeURIComponent(dir || "")}`);
    updateSshStatus(data);
    state.sshCwd = data.cwd || "";
    els.sshPath.textContent = `${data.label || state.sshLabel || "ssh"}:${data.cwd || "/"}`;
    els.sshList.innerHTML = "";
    if (data.cwd && data.cwd !== "/") {
      const up = document.createElement("button");
      up.className = "fileItem";
      up.type = "button";
      up.dataset.type = "dir";
      up.dataset.path = data.parent || "/";
      up.textContent = "↩ 上一级";
      els.sshList.appendChild(up);
    }
    if (!data.entries?.length) {
      els.sshList.innerHTML = '<div class="remoteEvent">没有文件或文件夹</div>';
    }
    for (const item of data.entries || []) {
      const row = document.createElement("div");
      row.className = "fileItem sshFileItem";
      row.role = "button";
      row.tabIndex = 0;
      row.dataset.type = item.type;
      row.dataset.path = item.path;
      row.dataset.name = item.name;
      row.innerHTML = '<span></span><div><strong></strong><small></small></div><div class="fileActions"></div>';
      row.querySelector("span").textContent = fileIcon(item);
      row.querySelector("strong").textContent = item.name;
      row.querySelector("small").textContent = item.type === "dir" ? "文件夹" : `${formatSize(item.size)} · ${item.mtime ? new Date(item.mtime).toLocaleString() : ""}`;
      const actions = row.querySelector(".fileActions");
      if (item.type === "file") actions.append(sshActionButton("编辑", "edit"));
      actions.append(sshActionButton("改名", "rename"), sshActionButton("删除", "delete", "danger"));
      els.sshList.appendChild(row);
    }
  } catch (error) {
    els.sshList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
    updateSshStatus({ connected: false });
  }
}

function sshActionButton(text, action, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.sshAction = action;
  button.className = extraClass;
  button.textContent = text;
  return button;
}

async function createSshFolderInCurrentDir() {
  const name = prompt("请输入远程文件夹名称");
  if (name === null) return;
  const data = await request("/api/remote/ssh/folders", {
    method: "POST",
    body: JSON.stringify({ dir: state.sshCwd || "", name })
  });
  await openSshComputer(data.cwd || state.sshCwd);
}

async function createSshFileInCurrentDir() {
  const name = prompt("请输入远程文件名");
  if (name === null) return;
  const content = prompt("请输入初始内容，可留空", "");
  if (content === null) return;
  const data = await request("/api/remote/ssh/files", {
    method: "POST",
    body: JSON.stringify({ dir: state.sshCwd || "", name, content })
  });
  await openSshComputer(data.cwd || state.sshCwd);
}

async function renameSshItem(file, oldName = "") {
  const name = prompt("请输入新名称", oldName || "");
  if (name === null) return;
  const data = await request("/api/remote/ssh/rename", {
    method: "POST",
    body: JSON.stringify({ path: file, name })
  });
  await openSshComputer(data.cwd || state.sshCwd);
}

async function deleteSshItem(file, name = "") {
  if (!confirm(`确定删除“${name || file}”吗？文件夹会递归删除。`)) return;
  const data = await request("/api/remote/ssh/delete", {
    method: "POST",
    body: JSON.stringify({ path: file })
  });
  els.sshPreview.hidden = true;
  await openSshComputer(data.cwd || state.sshCwd);
}

async function previewSshFile(file) {
  els.sshPreview.hidden = false;
  els.sshPreview.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request(`/api/remote/ssh/file?path=${encodeURIComponent(file)}`);
    els.sshPreview.innerHTML = `
      <div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><button type="button" data-save-ssh-file>保存</button></div>
      <div class="sshEditor"><textarea id="sshEditorText" spellcheck="false">${escapeHtml(data.text)}</textarea></div>
    `;
    els.sshPreview.querySelector("[data-save-ssh-file]").addEventListener("click", () => saveSshFile(data.path));
  } catch (error) {
    els.sshPreview.innerHTML = `<div class="filePreviewTop"><strong>${escapeHtml(file)}</strong></div><div class="remoteEvent">${escapeHtml(error.message)}</div>`;
  }
}

async function saveSshFile(file) {
  const editor = els.sshPreview.querySelector("#sshEditorText");
  if (!editor) return;
  await request("/api/remote/ssh/file/write", {
    method: "POST",
    body: JSON.stringify({ path: file, content: editor.value })
  });
  await previewSshFile(file);
}

function connectorTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function selectedConnector() {
  return state.connectors.find((device) => device.id === state.selectedConnectorId) || null;
}

function currentConnectorLabel() {
  if (!state.selectedConnectorId) {
    const localRemark = connectorRemark("");
    return localRemark || "本机";
  }
  const device = selectedConnector();
  if (device) {
    const remark = connectorRemark(device.id);
    if (remark) return remark;
  }
  return device?.name || device?.hostname || state.selectedConnectorId;
}

function connectorRemark(id = "") {
  try { return localStorage.getItem(`codex-remote-connector-remark:${id}`) || ""; } catch { return ""; }
}

function promptConnectorRemark(device) {
  const current = connectorRemark(device.id);
  const input = prompt(`为「${device.name || device.hostname || device.id}」设置备注名：`, current);
  if (input === null) return;
  const trimmed = input.trim();
  try {
    if (trimmed) localStorage.setItem(`codex-remote-connector-remark:${device.id}`, trimmed);
    else localStorage.removeItem(`codex-remote-connector-remark:${device.id}`);
  } catch {}
  renderConnectors();
  updateMeta();
}

function connectorSubtitle(device) {
  return [device.hostname, device.platform, device.arch].filter(Boolean).join(" · ");
}

function connectorStatusText(device) {
  return `${device.online ? "在线" : "离线"}${device.tunnelConnected ? " · 已连接" : ""}${device.lastSeen ? ` · ${connectorTime(device.lastSeen)}` : ""}`;
}

function appendConnectorRow(device) {
  const row = document.createElement("div");
  row.className = "connectorRow";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `connectorItem${device.id === state.selectedConnectorId ? " active" : ""}${device.online ? " online" : ""}`;
  button.dataset.connectorId = device.id;
  button.innerHTML = '<span class="connectorDot"></span><strong></strong><small></small><small></small>';
  const remark = connectorRemark(device.id);
  button.querySelector("strong").textContent = remark || device.name || device.hostname || device.id;
  button.querySelectorAll("small")[0].textContent = connectorSubtitle(device);
  button.querySelectorAll("small")[1].textContent = connectorStatusText(device);
  row.appendChild(button);

  const remarkBtn = document.createElement("button");
  remarkBtn.type = "button";
  remarkBtn.className = "connectorRemarkBtn";
  remarkBtn.title = "设置备注名";
  remarkBtn.textContent = "备注";
  remarkBtn.dataset.connectorId = device.id;
  remarkBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    promptConnectorRemark(device);
  });
  row.appendChild(remarkBtn);
  els.connectorList.appendChild(row);
}

function renderConnectors() {
  if (!els.connectorList) return;
  els.connectorList.innerHTML = "";
  if (!state.disableLocal) {
    appendConnectorRow({
      id: "",
      name: "本机",
      hostname: "local",
      platform: "Codex",
      arch: "",
      online: true
    });
  }
  if (!state.connectors.length) {
    const hint = document.createElement("div");
    hint.className = "remoteEvent";
    hint.textContent = state.disableLocal ? "还没有接入被控电脑。请在一台电脑上安装被控端（codex-remote-connector）后刷新。" : "还没有接入被控电脑。";
    els.connectorList.appendChild(hint);
  } else {
    for (const device of state.connectors) {
      appendConnectorRow(device);
    }
  }
}

async function loadConnectors() {
  if (!els.connectorPanel) return;
  const data = await request("/api/remote/connectors");
  state.connectors = Array.isArray(data.devices) ? data.devices : [];
  renderConnectors();
  updateMeta();
}

async function openConnectors() {
  els.connectorPanel.hidden = false;
  els.filePanel.hidden = true;
  els.threadPanel.hidden = true;
  els.sshConnectPanel.hidden = true;
  await loadConnectors();
}

async function switchConnector(id = "") {
  if (state.selectedConnectorId === id) {
    els.connectorPanel.hidden = true;
    return;
  }
  state.selectedConnectorId = id;
  state.threadId = "";
  state.threadName = "";
  state.cwd = "";
  state.absoluteCwd = "";
  state.fileCwd = "";
  state.fileCwdConnectorId = id;
  state.newCwd = "";
  state.newCwdConnectorId = id;
  state.messages = [];
  state.activeAssistant = null;
  state.assistantBubbles.clear();
  state.replyDone = false;
  els.log.innerHTML = "";
  els.connectorPanel.hidden = true;
  updateMeta();
  await loadState().catch((error) => upsertAssistantMessage(`切换失败：${error.message}`, true));
  if (!els.filePanel.hidden) loadFiles().catch(() => {});
}

async function openThreads() {
  els.threadPanel.hidden = false;
  setThreadView("existing");
  els.threadList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request("/api/remote/threads");
    els.threadList.innerHTML = "";
    if (!data.threads?.length) {
      els.threadList.innerHTML = '<div class="remoteEvent">没有找到会话</div>';
      return;
    }
    for (const thread of data.threads) {
      const row = document.createElement("div");
      row.className = "threadRow";

      const button = document.createElement("button");
      if (thread.completedUnread) state.completedUnreadThreads.add(thread.threadId);
      const isActive = thread.threadId === state.threadId;
      const isCompletedUnread = Boolean(thread.completedUnread || state.completedUnreadThreads.has(thread.threadId));
      button.className = `threadItem${isActive ? " active" : ""}${thread.running ? " running" : ""}${!thread.running && isCompletedUnread ? " completedUnread" : ""}`;
      button.type = "button";
      button.innerHTML = '<strong></strong><small class="threadMeta"></small><small class="threadPath"></small>';
      button.querySelector("strong").textContent = thread.name ? `📌 ${thread.title}` : thread.title;
      button.querySelector(".threadMeta").textContent = threadSubtitle(thread);
      button.querySelector(".threadPath").textContent = thread.cwd || "";
      button.addEventListener("click", () => selectThread(thread.threadId));

      const actions = document.createElement("div");
      actions.className = "threadActions";
      const nameButton = document.createElement("button");
      nameButton.type = "button";
      nameButton.className = "threadAction";
      nameButton.textContent = "备注";
      nameButton.addEventListener("click", () => renameThread(thread));
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "threadAction danger";
      deleteButton.textContent = "删除";
      deleteButton.disabled = Boolean(thread.running || thread.runtimeKey);
      deleteButton.addEventListener("click", () => deleteThread(thread));
      actions.append(nameButton, deleteButton);

      row.append(button, actions);
      els.threadList.appendChild(row);
    }
  } catch (error) {
    els.threadList.innerHTML = "";
    els.threadList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
  }
}

function setThreadView(view = "existing") {
  const showNew = view === "new";
  els.threadExistingView.hidden = showNew;
  els.threadNewView.hidden = !showNew;
  els.threadPanelTitle.textContent = showNew ? "新建会话" : "选择已有会话";
  els.toggleThreadView.textContent = showNew ? "选择已有会话" : "新建会话";
}

async function renameThread(thread) {
  const name = prompt("备注名，留空则清除备注", thread.name || "");
  if (name === null) return;
  const data = await request("/api/remote/name", {
    method: "POST",
    body: JSON.stringify({ threadId: thread.threadId, name })
  });
  if (thread.threadId === state.threadId) {
    state.threadName = data.name || "";
    updateMeta();
  }
  openThreads();
}

async function deleteThread(thread) {
  const ok = confirm(`删除会话：${thread.title}\n\n${thread.threadId}`);
  if (!ok) return;
  await request("/api/remote/delete", {
    method: "POST",
    body: JSON.stringify({ threadId: thread.threadId })
  });
  if (thread.threadId === state.threadId) {
    renderState({ threadId: "", threadName: "", messages: [], running: false });
  }
  openThreads();
}

async function selectThread(threadId) {
  const data = await request("/api/remote/select", {
    method: "POST",
    body: JSON.stringify({ threadId })
  });
  state.completedUnreadThreads.delete(threadId);
  renderState(data);
  els.threadPanel.hidden = true;
}

function handleRemoteEvent(data) {
  if (Number(data.seq) > state.lastEventSeq) state.lastEventSeq = Number(data.seq);
  if (data.type === "connectors_changed") { loadConnectors().catch(() => {}); return; }
  if (data.connectorId !== undefined && data.connectorId !== (state.selectedConnectorId || "")) {
    if (data.type === "runner_status") state.runningThreads = Array.isArray(data.runningThreads) ? data.runningThreads : state.runningThreads;
    return;
  }
  if (data.type === "status") setRunning(data.running, data.queueLength, data.queueMessages, data.followMode, data.steerLength, data.steerMessages, data.contextUsage, data.runningThreads);
  if (data.type === "runner_status") state.runningThreads = Array.isArray(data.runningThreads) ? data.runningThreads : [];
  if (data.type === "message") {
    if (data.role === "assistant" && (data.transient || data.final)) {
      if (data.final && /^✅\s/.test(data.content || "") && data.taskDurationMs === undefined && state.currentTaskStartedAtMs) {
        data.taskDurationMs = Math.max(0, Date.now() - state.currentTaskStartedAtMs);
      }
      upsertAssistantMessage(data.content, data.final, data.messageId || "assistant", data);
      if (data.final && /^✅\s/.test(data.content || "")) notifyCodexReply(data);
    } else {
      appendMessage(data.role, data.content, data);
      if (data.role === "user") {
        state.activeAssistant = null;
        state.assistantBubbles.clear();
        state.replyDone = false;
      }
    }
  }
  if (data.type === "reply_done") {
    state.replyDone = true;
    updateMeta();
  }
  if (data.type === "done") {
    state.currentTaskStartedAtMs = null;
    loadState().catch(() => appendEvent("任务已完成"));
  }
  if (data.type === "thread_completion" && data.threadId) {
    if (data.completedUnread) state.completedUnreadThreads.add(data.threadId);
    else state.completedUnreadThreads.delete(data.threadId);
    if (!els.threadPanel.hidden) openThreads();
  }
  if (data.type === "error") upsertAssistantMessage(`错误：${data.text}`, true, "error");
  if (data.type === "state") renderState(data);
  if (data.type === "thread_name" && data.threadId === state.threadId) {
    state.threadName = data.name || "";
    updateMeta();
  }
}

async function resyncEvents() {
  if (state.resyncingEvents) return;
  state.resyncingEvents = true;
  try {
    const data = await request(`/api/remote/changes?afterSeq=${encodeURIComponent(state.lastEventSeq || 0)}`);
    if (data.reset) {
      await loadState();
      return;
    }
    for (const event of data.events || []) handleRemoteEvent(event);
    if (Number(data.eventSeq) > state.lastEventSeq) state.lastEventSeq = Number(data.eventSeq);
  } finally {
    state.resyncingEvents = false;
  }
}

function connectEvents() {
  const source = new EventSource(`${basePath}/api/remote/events`);
  source.onopen = () => {
    const shouldResync = state.eventDisconnected;
    state.connected = true;
    state.eventDisconnected = false;
    updateStatusIcon();
    updateMeta();
    if (shouldResync) resyncEvents().catch(() => loadState().catch(() => {}));
  };
  source.onmessage = (event) => {
    handleRemoteEvent(JSON.parse(event.data));
  };
  source.onerror = () => {
    state.connected = false;
    state.eventDisconnected = true;
    updateStatusIcon();
    els.meta.textContent = "连接断开，正在重连...";
  };
}

function resyncWhenActive() {
  if (document.visibilityState === "hidden") return;
  loadState().catch(() => {});
}

function restorePushSubscription() {
  if (notificationPermission() !== "granted") return;
  subscribeWebPush()
    .catch((error) => console.error("web push restore failed", error))
    .finally(renderCommandList);
}

async function sendMessage(mode = "queue") {
  const message = els.input.value.trim();
  if (!message && !state.uploads.length) return;
  if (state.disableLocal && !state.selectedConnectorId) {
    upsertAssistantMessage("当前为纯控制中心模式，请先在「PC 被控电脑」面板添加并切换到一台被控电脑。", true);
    return;
  }
  const outgoingMessage = messageWithUploads(message);
  const sendMode = mode === "steer" ? "steer" : "queue";
  els.input.value = "";
  clearDraft();
  autosizeInput();
  state.replyDone = false;
  state.currentTaskStartedAtMs = Date.now();
  const followMatch = outgoingMessage.trim().toLowerCase().match(/^\/follow\s+(queue|steer)$/);
  setRunning(true, state.queueLength, state.queueMessages, followMatch ? followMatch[1] : state.followMode, state.steerLength, state.steerMessages, state.contextUsage, state.runningThreads);
  try {
    const result = await request("/api/remote/send", {
      method: "POST",
      body: JSON.stringify({ message: outgoingMessage, followMode: sendMode })
    });
    state.uploads = [];
    renderUploadList();
    if (result?.local) setRunning(result.running, result.queueLength, result.queueMessages, result.followMode, result.steerLength, result.steerMessages, result.contextUsage, result.runningThreads);
    if (result?.queued || result?.steered) setRunning(true, result.queueLength, result.queueMessages, result.followMode, result.steerLength, result.steerMessages, result.contextUsage, result.runningThreads);
  } catch (error) {
    upsertAssistantMessage(`错误：${error.message}`, true);
    setRunning(false);
  }
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage("queue");
});

els.sendSteer.addEventListener("click", () => {
  sendMessage("steer");
});

if (els.onlyMineButton) {
  els.onlyMineButton.addEventListener("click", toggleOnlyMine);
}

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});

els.input.addEventListener("input", () => {
  autosizeInput();
  saveDraft();
});
els.input.addEventListener("paste", (event) => {
  const files = pastedFiles(event);
  if (!files.length) return;
  event.preventDefault();
  uploadFiles(files);
});
els.uploadButton.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => uploadFiles([...els.fileInput.files]));

els.slashButton.addEventListener("click", () => {
  toggleCommandMenu();
});

for (const button of els.commandQuick) {
  button.addEventListener("click", () => insertCommand(button.dataset.command || "/"));
}

document.addEventListener("click", (event) => {
  if (!els.commandMenu.hidden && !event.target.closest(".commandPicker")) {
    closeCommandMenu();
  }
  if (!els.queuePanel.hidden && !event.target.closest(".queueWrap")) {
    els.queuePanel.hidden = true;
  }
  if (
    !els.threadPanel.hidden &&
    !event.target.closest("#threadPanel") &&
    !event.target.closest("#threadRemote")
  ) {
    els.threadPanel.hidden = true;
  }
  if (
    !els.filePanel.hidden &&
    !event.target.closest("#filePanel") &&
    !event.target.closest("#filesRemote")
  ) {
    els.filePanel.hidden = true;
  }
  if (
    !els.sshConnectPanel.hidden &&
    !event.target.closest("#sshConnectPanel") &&
    !event.target.closest("#sshConnectRemote")
  ) {
    els.sshConnectPanel.hidden = true;
  }
  if (
    !els.connectorPanel.hidden &&
    !event.target.closest("#connectorPanel") &&
    !event.target.closest("#connectorsRemote")
  ) {
    els.connectorPanel.hidden = true;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeCommandMenu();
    els.threadPanel.hidden = true;
    els.filePanel.hidden = true;
    els.sshConnectPanel.hidden = true;
    els.connectorPanel.hidden = true;
    els.queuePanel.hidden = true;
  }
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateVisualViewport);
  window.visualViewport.addEventListener("scroll", updateVisualViewport);
  updateVisualViewport();
}

els.filesButton.addEventListener("click", () => openFiles());
els.connectorsButton?.addEventListener("click", () => {
  openConnectors().catch((error) => upsertAssistantMessage(`被控电脑错误： ${error.message}`, true));
});
els.closeConnectors?.addEventListener("click", () => {
  els.connectorPanel.hidden = true;
});
els.refreshConnectors?.addEventListener("click", () => {
  loadConnectors().catch((error) => upsertAssistantMessage(`被控电脑错误： ${error.message}`, true));
});
els.connectorList?.addEventListener("click", (event) => {
  const row = event.target.closest(".connectorItem");
  if (!row) return;
  const id = row.dataset.connectorId || "";
  switchConnector(id).catch((error) => upsertAssistantMessage(`切换失败：${error.message}`, true));
});
els.sshConnectButton.addEventListener("click", () => openSshConnect());
els.closeSshConnect.addEventListener("click", () => {
  els.sshConnectPanel.hidden = true;
});
els.toggleSshView.addEventListener("click", () => {
  if (els.sshFilesView.hidden) openSshComputer().catch((error) => {
    els.sshList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
  });
  else setSshView("config");
});
els.sshConnectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectSsh().catch((error) => {
    els.sshStatus.textContent = `连接失败：${error.message}`;
  });
});
els.sshDisconnect.addEventListener("click", () => {
  disconnectSsh().catch((error) => {
    els.sshStatus.textContent = `断开失败：${error.message}`;
  });
});
els.createSshFolder.addEventListener("click", () => {
  createSshFolderInCurrentDir().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});
els.createSshFile.addEventListener("click", () => {
  createSshFileInCurrentDir().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});
els.sshList.addEventListener("click", (event) => {
  event.stopPropagation();
  const actionButton = event.target.closest("[data-ssh-action]");
  const row = event.target.closest(".fileItem");
  if (!row) return;
  const file = row.dataset.path || "";
  const name = row.dataset.name || "";
  if (actionButton) {
    const action = actionButton.dataset.sshAction;
    if (action === "edit") previewSshFile(file);
    if (action === "rename") renameSshItem(file, name).catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
    if (action === "delete") deleteSshItem(file, name).catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
    return;
  }
  if (row.dataset.type === "dir") openSshComputer(file);
  else previewSshFile(file);
});

els.createFolder.addEventListener("click", () => {
  createFolderInCurrentFilePanel().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});
els.createFile.addEventListener("click", () => {
  createFileInCurrentFilePanel().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});

els.closeFiles.addEventListener("click", () => {
  els.filePanel.hidden = true;
});

els.fileList.addEventListener("click", (event) => {
  event.stopPropagation();
  const actionButton = event.target.closest("[data-file-action]");
  const row = event.target.closest(".fileItem");
  if (!row) return;
  const file = row.dataset.path || "";
  const name = row.dataset.name || "";
  if (actionButton) {
    const action = actionButton.dataset.fileAction;
    if (action === "edit") previewFile(file);
    if (action === "rename") renameProjectItem(file, name).catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
    if (action === "delete") deleteProjectItem(file, name, row.dataset.type || "").catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
    return;
  }
  if (row.dataset.type === "dir") openFiles(file);
  else previewFile(file);
});

els.filePreview.addEventListener("click", (event) => {
  event.stopPropagation();
});

els.newList.addEventListener("click", (event) => {
  event.stopPropagation();
  const row = event.target.closest(".fileItem");
  if (!row) return;
  openNewSessionPicker(row.dataset.path || "");
});

els.createSession.addEventListener("click", () => {
  createSessionInSelectedFolder().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});

els.threadButton.addEventListener("click", () => {
  openThreads();
});

els.closeThreads.addEventListener("click", () => {
  els.threadPanel.hidden = true;
});
els.toggleThreadView.addEventListener("click", () => {
  if (els.threadNewView.hidden) openNewSessionPicker();
  else openThreads();
});

els.loadMore.addEventListener("click", () => {
  loadMoreMessages().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});

els.queueButton.addEventListener("click", () => {
  if (!state.queueLength && !state.steerLength) return;
  els.queuePanel.hidden = !els.queuePanel.hidden;
});

els.scrollTop.addEventListener("click", () => {
  els.logWrap.scrollTo({ top: 0, behavior: "smooth" });
});

els.scrollBottom.addEventListener("click", () => {
  els.logWrap.scrollTo({ top: els.logWrap.scrollHeight, behavior: "smooth" });
});

els.logWrap.addEventListener("scroll", updateScrollJumps);
document.addEventListener("visibilitychange", resyncWhenActive);
window.addEventListener("pageshow", resyncWhenActive);
window.addEventListener("focus", resyncWhenActive);
window.addEventListener("online", resyncWhenActive);

els.newChat?.addEventListener("click", () => {
  if (state.running) return;
  openNewSessionPicker();
});

renderCommandList();
loadSshStatus().catch(() => updateSshStatus({ connected: false }));
loadState().then(connectEvents).catch((error) => {
  els.meta.textContent = error.message;
});
restorePushSubscription();
autosizeInput();
updateScrollJumps();
