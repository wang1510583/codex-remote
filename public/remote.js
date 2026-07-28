const state = {
  running: false,
  reconnecting: false,
  externalRunning: false,
  externalTaskStartedAt: "",
  threadId: "",
  threadName: "",
  cwd: "",
  absoluteCwd: "",
  fileLinkRoots: [],
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
  nativeNotificationConnected: false,
  autoSpeech: localStorage.getItem("codex-remote-auto-speech") === "1",
  spokenMessageIds: new Set(),
  speechUtterances: new Set(),
  hideThoughts: localStorage.getItem("codex-remote-hide-thoughts") === "1",
  onlyMine: localStorage.getItem("codex-remote-only-mine") === "1",
  showFullReplies: localStorage.getItem("codex-remote-show-full-replies") === "1",
  fullMessageCount: 0,
  completedUnreadThreads: new Set(),
  connectors: [],
  connectorJobs: [],
  selectedConnectorId: "",
  model: "",
  reasoningEffort: "",
  modelSettingsUpdatedAt: "",
  modelOptions: [],
  localConnectorRemark: "",
  disableLocal: false,
  localNotices: []
};
const basePath = ["/codexremote", "/codex-remote"].find((path) => location.pathname === path || location.pathname.startsWith(`${path}/`)) || "";
const draftPrefix = "codex-remote-draft:";
let draftTimer = 0;
let modelSettingsChanging = false;
let stateLoadGeneration = 0;
let realtimeReconcileTimer = 0;
const processedEventSeqs = new Set();
const pendingRemoteEvents = [];
const slashCommands = [
  { command: "/help", title: "帮助", detail: "显示当前已接入的 Codex 命令" },
  { command: "/status", title: "状态", detail: "读取 app-server、线程、模型和目录状态" },
  { command: "/model", title: "查看模型", detail: "通过 Codex CLI model/list 查看可用模型" },
  { command: "/model ", title: "切换模型", detail: "输入 /model <模型ID>，只接受 CLI 返回的可用选项" },
  { command: "/effort", title: "查看思考强度", detail: "查看当前模型在 Codex CLI 中支持的强度" },
  { command: "/effort ", title: "切换思考强度", detail: "输入 /effort <强度>，只接受当前模型支持的选项" },
  { command: "/fast", title: "Fast 快速模式", detail: "切换当前模型的 Fast 服务层并保存；响应更快，但会更快消耗使用额度" },
  { command: "/diff", title: "改动", detail: "通过 gitDiffToRemote 查看当前 Git diff" },
  { command: "/compact", title: "压缩上下文", detail: "通过 thread/compact/start 压缩当前线程" },
  { command: "/restart", title: "重启服务", detail: "重启 Caddy 端口和 Codex Remote 后端服务" },
  { command: "/follow queue", title: "队列模式", detail: "运行中发送的新消息进入队列" },
  { command: "/follow steer", title: "引导模式", detail: "运行中发送的新消息引导当前任务" },
  { command: "/steer ", title: "立即引导", detail: "把后续文字发送给当前正在运行的任务" },
  { command: "/notify", title: "通知", detail: notificationDetail, action: requestNotifications },
  { command: "/tts", title: "自动语音朗读", detail: speechDetail, action: toggleAutoSpeech },
  { command: "/full", title: "显示Codex完整回复", detail: fullRepliesDetail, action: toggleFullReplies },
  { command: "/result", title: "只看结果", detail: () => state.hideThoughts ? "当前只显示用户气泡和 ✅ 气泡，点击后显示全部" : "隐藏思考过程气泡，只显示用户气泡和 ✅ 气泡", action: toggleResultOnly },
  { command: "/mine", title: "只看自己", detail: () => state.onlyMine ? "当前只显示自己发送的气泡，点击后显示全部" : "只显示自己发送的消息气泡", action: toggleOnlyMine },
  { command: "/stop", title: "中断", detail: "通过 turn/interrupt 中断当前回合" }
];

function reasoningEffortLabel(value = "") {
  return ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" })[String(value).toLowerCase()] || String(value);
}

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
  usageButton: document.querySelector("#usageRemote"),
  usagePanel: document.querySelector("#usagePanel"),
  closeUsage: document.querySelector("#closeUsage"),
  usageContent: document.querySelector("#usageContent"),
  usageStatus: document.querySelector("#usageStatus"),
  modelSettingsButton: document.querySelector("#modelSettingsRemote"),
  modelSettingsPanel: document.querySelector("#modelSettingsPanel"),
  closeModelSettings: document.querySelector("#closeModelSettings"),
  modelSettingsCurrent: document.querySelector("#modelSettingsCurrent"),
  modelSettingsModels: document.querySelector("#modelSettingsModels"),
  modelSettingsEfforts: document.querySelector("#modelSettingsEfforts"),
  modelSettingsStatus: document.querySelector("#modelSettingsStatus"),
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
  projectUploadButton: document.querySelector("#uploadProjectRemote"),
  projectUploadMenu: document.querySelector("#projectUploadMenu"),
  projectFilesButton: document.querySelector("#selectProjectFilesRemote"),
  projectFolderButton: document.querySelector("#selectProjectFolderRemote"),
  projectFilesInput: document.querySelector("#projectFilesRemote"),
  projectFolderInput: document.querySelector("#projectFolderRemote"),
  projectUploadStatus: document.querySelector("#projectUploadStatus"),
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
  if (state.nativeNotificationConnected) return "WebToApp 原生后台通知通道已连接";
  const permission = notificationPermission();
  if (permission === "granted") return state.pushSubscribed ? "已开启，后台也会收到任务完成通知" : "已开启，Codex 最终回复会发到系统通知栏";
  if (permission === "denied") return "通知已被浏览器阻止，请到 Chrome/系统通知设置里放开";
  if (permission === "unsupported") return "当前浏览器不支持网页通知";
  return "点击后向浏览器申请通知权限";
}

function speechEngine() {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
}

function speechSupported() {
  return Boolean(speechEngine() && typeof window.SpeechSynthesisUtterance === "function");
}

function speechDetail() {
  if (!speechSupported()) return "当前浏览器或 WebView 不支持系统语音朗读";
  return state.autoSpeech ? "已开启，点击后关闭并停止当前朗读" : "点击开启，助手的每个完整消息气泡将自动朗读";
}

function fullRepliesDetail() {
  return state.showFullReplies
    ? "已开启，点击后恢复普通消息视图"
    : "显示 Codex CLI 的推理、工具调用、命令输出和文件修改，并实时同步";
}

function stopSpeech() {
  const engine = speechEngine();
  try { engine?.cancel(); } catch {}
  state.speechUtterances.clear();
}

function speechTextFromMessage(text = "") {
  return String(text || "")
    .replace(/```[^\n]*\n?[\s\S]*?```/g, " 代码内容已省略。 ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+/gi, " 链接 ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:#{1,6}|>|[-+*])\s*/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[|*_~]+/g, " ")
    .replace(/^[✅🤔❌⏳]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

function speechChunks(text, maxLength = 1000) {
  const chunks = [];
  let remaining = String(text || "").trim();
  while (remaining.length > maxLength) {
    const windowText = remaining.slice(0, maxLength + 1);
    const punctuationMatches = [...windowText.matchAll(/[。！？!?；;]\s*/g)];
    const punctuation = punctuationMatches[punctuationMatches.length - 1];
    let splitAt = punctuation ? punctuation.index + punctuation[0].length : -1;
    if (splitAt < Math.floor(maxLength * 0.45)) {
      const spaceAt = windowText.lastIndexOf(" ");
      splitAt = spaceAt >= Math.floor(maxLength * 0.45) ? spaceAt + 1 : maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function preferredSpeechVoice(engine) {
  const voices = typeof engine?.getVoices === "function" ? engine.getVoices() : [];
  return voices.find((voice) => /^zh[-_]CN$/i.test(voice.lang || ""))
    || voices.find((voice) => /^zh/i.test(voice.lang || ""))
    || voices.find((voice) => voice.default)
    || null;
}

function enqueueSpeech(text) {
  if (!speechSupported()) return false;
  const content = speechTextFromMessage(text);
  if (!content) return false;
  const engine = speechEngine();
  const voice = preferredSpeechVoice(engine);
  let queued = 0;
  if (engine.paused) engine.resume();
  for (const chunk of speechChunks(content)) {
    const utterance = new window.SpeechSynthesisUtterance(chunk);
    utterance.lang = voice?.lang || "zh-CN";
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    const release = () => state.speechUtterances.delete(utterance);
    utterance.onend = release;
    utterance.onerror = release;
    state.speechUtterances.add(utterance);
    try {
      engine.speak(utterance);
      queued += 1;
    } catch {
      release();
    }
  }
  return queued > 0;
}

function speechMessageKey(data = {}) {
  const rawId = String(data.messageId || "");
  const messagePart = rawId && rawId !== "assistant"
    ? rawId
    : `content:${String(data.content || "")}`;
  return `${currentConnectorId()}\n${state.threadId || state.cwd || "new"}\n${messagePart}`;
}

function speakCompletedAssistantMessage(data = {}) {
  if (!state.autoSpeech || !data.final || data.role !== "assistant") return false;
  const key = speechMessageKey(data);
  if (state.spokenMessageIds.has(key)) return false;
  if (!enqueueSpeech(data.content || "")) return false;
  state.spokenMessageIds.add(key);
  while (state.spokenMessageIds.size > 500) {
    state.spokenMessageIds.delete(state.spokenMessageIds.values().next().value);
  }
  return true;
}

function toggleAutoSpeech() {
  closeCommandMenu();
  if (!speechSupported()) {
    state.autoSpeech = false;
    localStorage.removeItem("codex-remote-auto-speech");
    appendEvent("当前浏览器或 WebView 不支持系统语音朗读，请检查 Android 系统 TTS 引擎。");
    renderCommandList();
    return;
  }
  state.autoSpeech = !state.autoSpeech;
  localStorage.setItem("codex-remote-auto-speech", state.autoSpeech ? "1" : "0");
  stopSpeech();
  appendEvent(state.autoSpeech ? "自动语音朗读已开启" : "自动语音朗读已关闭");
  if (state.autoSpeech) enqueueSpeech("自动语音朗读已开启");
  renderCommandList();
}

function assistantSpeechTextsAfterUserBubble(userBubble) {
  const userBlock = userBubble?.closest?.(".messageBlock.userBlock") || userBubble;
  if (!userBlock) return [];
  const replies = [];
  for (let node = userBlock.nextElementSibling; node; node = node.nextElementSibling) {
    if (node.matches?.(".messageBlock.userBlock, .message.user") || node.classList?.contains("userBlock")) break;
    const bubbles = [];
    if (node.matches?.(".message.assistant")) bubbles.push(node);
    if (typeof node.querySelectorAll === "function") bubbles.push(...node.querySelectorAll(".message.assistant"));
    for (const bubble of bubbles) {
      const text = bubble.dataset?.speechText ?? bubble.textContent ?? "";
      if (speechTextFromMessage(text)) replies.push(text);
    }
  }
  return replies;
}

function showSpeechFeedback(text) {
  if (typeof document === "undefined" || !text) return;
  let feedback = document.querySelector(".speechFeedback");
  if (!feedback) {
    feedback = document.createElement("div");
    feedback.className = "speechFeedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    document.body.appendChild(feedback);
  }
  feedback.textContent = text;
  clearTimeout(showSpeechFeedback.removeTimer);
  showSpeechFeedback.removeTimer = setTimeout(() => feedback.remove(), 2400);
}

function markUserBubbleSpeechSelection(userBubble) {
  if (!userBubble?.classList) return;
  userBubble.classList.add("speechSelected");
  setTimeout(() => userBubble.classList.remove("speechSelected"), 550);
}

function speakRepliesAfterUserBubble(userBubble) {
  markUserBubbleSpeechSelection(userBubble);
  stopSpeech();
  if (!speechSupported()) {
    showSpeechFeedback("当前浏览器或 WebView 不支持系统语音朗读");
    return 0;
  }
  const replies = assistantSpeechTextsAfterUserBubble(userBubble);
  let queued = 0;
  for (const reply of replies) {
    if (enqueueSpeech(reply)) queued += 1;
  }
  showSpeechFeedback(queued
    ? `正在朗读这条消息后的 ${queued} 条 Codex 回复`
    : "该消息后暂时没有可朗读的 Codex 回复");
  return queued;
}

function handleUserBubbleSpeechInteraction(event) {
  if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
  const target = event.target;
  const userBubble = target?.closest?.(".message.user");
  if (!userBubble || !els.log.contains(userBubble)) return;
  if (target !== userBubble && target?.closest?.("a, button, input, textarea, select")) return;
  if (event.type === "keydown") event.preventDefault();
  speakRepliesAfterUserBubble(userBubble);
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
  let enabled = false;
  const nativeTest = await request("/api/remote/notifications/test", { method: "POST" }).catch((error) => {
    console.error("native notification test failed", error);
    return null;
  });
  state.nativeNotificationConnected = Number(nativeTest?.sent || 0) > 0;
  if (state.nativeNotificationConnected) {
    enabled = true;
    appendEvent(`WebToApp 原生后台通知已连接，并已发送 ${nativeTest.sent} 条测试通知。`);
  }
  if (notificationPermission() === "unsupported") {
    if (!enabled) {
      const message = nativeTest?.configured
        ? "当前浏览器不支持网页通知，且没有检测到已连接的 WebToApp 后台通道。请检查 APK 的 WebSocket 通知配置与后台运行权限。"
        : "当前浏览器不支持网页通知，服务端也没有配置 CODEX_REMOTE_NOTIFICATION_TOKEN。";
      upsertAssistantMessage(message, true, "notify-native-error");
    }
    renderCommandList();
    closeCommandMenu();
    return;
  }
  if (Notification.permission === "default") await Notification.requestPermission();
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
  const title = data.taskFailed || /^\s*❌/.test(data.content || "")
    ? "Codex任务出错"
    : "服务器Codex";
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
      await registration.showNotification(title, options);
      return;
    }
    new Notification(title, options);
  } catch {
    try {
      new Notification(title, options);
    } catch {}
  }
}

function setContextUsage(contextUsage) {
  state.contextUsage = contextUsage && Number.isFinite(Number(contextUsage.remainingPercent)) ? contextUsage : null;
}

function updateStatusIcon() {
  if (!state.connected) {
    els.statusIcon.className = "remoteStatusIcon status-connecting";
    els.statusIcon.title = "断开连接，正在连接";
  } else if (state.running) {
    els.statusIcon.className = `remoteStatusIcon ${state.externalRunning ? "status-external" : "status-running"}`;
    els.statusIcon.title = state.externalRunning
      ? "Codex Desktop/CLI 正在执行，网页端正在实时同步"
      : (state.reconnecting ? "Codex 正在重新连接，任务继续等待" : "Codex 正在处理");
  } else {
    els.statusIcon.className = "remoteStatusIcon status-idle";
    els.statusIcon.title = "Codex 空闲";
  }
}

function setRunning(running, queueLength = state.queueLength, queueMessages = state.queueMessages, followMode = state.followMode, steerLength = state.steerLength, steerMessages = state.steerMessages, contextUsage = state.contextUsage, runningThreads = state.runningThreads, reconnecting = false, externalRunning = false) {
  const wasRunning = state.running;
  const wasExternalRunning = state.externalRunning;
  const previousRunningThreads = runningThreadsSignature(state.runningThreads);
  state.running = Boolean(running);
  state.externalRunning = state.running && Boolean(externalRunning);
  state.reconnecting = state.running && !state.externalRunning && Boolean(reconnecting);
  state.queueLength = Number(queueLength) || 0;
  state.queueMessages = Array.isArray(queueMessages) ? queueMessages : [];
  state.runningThreads = Array.isArray(runningThreads) ? runningThreads : [];
  state.steerLength = Number(steerLength) || 0;
  state.steerMessages = Array.isArray(steerMessages) ? steerMessages : [];
  state.followMode = followMode === "steer" ? "steer" : "queue";
  setContextUsage(contextUsage);
  if (state.running) state.replyDone = false;
  els.sendQueue.disabled = state.externalRunning;
  els.sendSteer.disabled = state.externalRunning;
  els.sendQueue.title = state.externalRunning ? "Codex Desktop/CLI 正在执行，网页端当前为只读同步" : "队列模式发送（备用）";
  els.sendSteer.title = state.externalRunning ? "外部 Codex 任务不能从网页端引导" : "引导模式发送（默认，Ctrl+Enter）";
  if (els.newChat) els.newChat.disabled = state.running;
  els.threadButton.disabled = false;
  updateMeta();
  renderQueuePanel();
  updateStatusIcon();
  updateRealtimeReconcile();
  if (
    wasRunning !== state.running
    || wasExternalRunning !== state.externalRunning
    || previousRunningThreads !== runningThreadsSignature(state.runningThreads)
  ) scheduleThreadListRefresh();
}

function updateMeta() {
  const connectorTag = state.selectedConnectorId ? `[${currentConnectorLabel()}] ` : "";
  const title = state.threadId ? (state.threadName || `会话 ${state.threadId.slice(0, 8)}`) : "新会话";
  const mode = state.followMode === "steer" ? "引导模式" : "队列模式";
  const percent = state.contextUsage ? Math.max(0, Math.min(100, Math.round(Number(state.contextUsage.remainingPercent)))) : null;
  const normalModeText = Number.isFinite(percent) ? `${mode} · 上下文 ${percent}%` : mode;
  const externalLabel = state.selectedConnectorId ? "被控电脑 Codex 正在执行 · 实时同步中" : "本机 Codex Desktop/CLI 正在执行 · 实时同步中";
  const modeText = state.externalRunning
    ? externalLabel
    : (state.reconnecting ? "Codex 正在重新连接 · 任务继续等待" : normalModeText);
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

// Android's IME "send" and "newline" actions can both arrive as Enter key
// events. Keep a zero-width probe immediately before a collapsed native caret
// so the action can still be recognized without leaving the textarea in a
// selected-text state. The probe is removed before drafts or messages are read.
const androidImeActionProbe = "\u2060";
const androidImeNewlineWindowMs = 750;
const androidImeEnterDecisionMs = 60;
const androidImeProcessPreludeWindowMs = 50;
let androidImeComposing = false;
let androidImeNewlineUntil = 0;
let androidImeProbeTimer = 0;
let androidImeEnterTimer = 0;
let pendingAndroidImeEnter = null;
let androidImeProcessKeyCandidate = null;
let androidImeNewlinePreludeUntil = 0;

function isAndroidImeClient(userAgent = navigator.userAgent) {
  const value = String(userAgent || "");
  return /Android/i.test(value) && /Chrome|Chromium|EdgA|OPR|SamsungBrowser/i.test(value);
}

function composerText(value = els.input.value) {
  return String(value || "").split(androidImeActionProbe).join("");
}

function isAndroidImeProbeArmed(input = els.input) {
  const start = Number(input?.selectionStart);
  const end = Number(input?.selectionEnd);
  return Number.isInteger(start)
    && start === end
    && start >= androidImeActionProbe.length
    && String(input.value || "").slice(start - androidImeActionProbe.length, start) === androidImeActionProbe;
}

function isAndroidImeProcessKey(event = {}) {
  return Number(event.keyCode) === 229 || Number(event.which) === 229;
}

function rememberAndroidImeProcessKey(event = {}, input = els.input) {
  if (!isAndroidImeProcessKey(event) || !isAndroidImeProbeArmed(input)) {
    androidImeProcessKeyCandidate = null;
    return false;
  }
  androidImeProcessKeyCandidate = {
    at: Date.now(),
    text: composerText(input.value),
    selectionStart: Number(input.selectionStart),
    selectionEnd: Number(input.selectionEnd)
  };
  return true;
}

function finishAndroidImeProcessKey(event = {}, input = els.input) {
  if (!isAndroidImeProcessKey(event)) return false;
  const candidate = androidImeProcessKeyCandidate;
  androidImeProcessKeyCandidate = null;
  if (
    !candidate
    || Date.now() - candidate.at > androidImeProcessPreludeWindowMs
    || candidate.text !== composerText(input.value)
    || candidate.selectionStart !== Number(input.selectionStart)
    || candidate.selectionEnd !== Number(input.selectionEnd)
    || !isAndroidImeProbeArmed(input)
  ) return false;
  androidImeNewlinePreludeUntil = Date.now() + androidImeProcessPreludeWindowMs;
  return true;
}

function hasAndroidImeNewlinePrelude() {
  return androidImeNewlinePreludeUntil >= Date.now();
}

function clearAndroidImeProcessKeyState() {
  androidImeProcessKeyCandidate = null;
  androidImeNewlinePreludeUntil = 0;
}

function isAndroidImeCompositionKey(event = {}) {
  return Boolean(event.isComposing || isAndroidImeProcessKey(event));
}

function isAndroidImeTextNewline(event = {}) {
  const inputType = String(event.inputType || "");
  const data = event.data;
  return (inputType === "insertText" || inputType === "insertCompositionText")
    && (data === "" || data === "\n" || data === "\r\n");
}

function isAndroidBrowserLineBreak(event = {}) {
  return event.inputType === "insertLineBreak" || event.inputType === "insertParagraph";
}

function cancelPendingAndroidImeEnter() {
  clearTimeout(androidImeEnterTimer);
  androidImeEnterTimer = 0;
  pendingAndroidImeEnter = null;
}

function finishPendingAndroidImeSend() {
  if (!pendingAndroidImeEnter) return false;
  cancelPendingAndroidImeEnter();
  androidImeNewlineUntil = 0;
  removeAndroidImeProbe();
  sendMessage("steer");
  scheduleAndroidImeProbe();
  return true;
}

function queueAndroidImeSendDecision() {
  cancelPendingAndroidImeEnter();
  pendingAndroidImeEnter = {
    text: composerText(),
    selectionStart: Number(els.input.selectionStart),
    selectionEnd: Number(els.input.selectionEnd)
  };
  androidImeEnterTimer = setTimeout(finishPendingAndroidImeSend, androidImeEnterDecisionMs);
}

function removeAndroidImeProbe(input = els.input) {
  const value = String(input?.value || "");
  if (!value.includes(androidImeActionProbe)) return;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const direction = input.selectionDirection || "none";
  const offsetWithoutProbe = (offset) => value.slice(0, offset).split(androidImeActionProbe).join("").length;
  input.value = composerText(value);
  input.setSelectionRange(offsetWithoutProbe(start), offsetWithoutProbe(end), direction);
}

function deleteComposerTextBesideProbe(input = els.input, direction = "backward") {
  if (!isAndroidImeProbeArmed(input)) return false;
  const value = composerText(input.value);
  const caret = String(input.value || "").slice(0, input.selectionStart).split(androidImeActionProbe).join("").length;
  let deleteStart = caret;
  let deleteEnd = caret;
  if (direction === "forward") {
    const nextCharacter = Array.from(value.slice(caret))[0] || "";
    deleteEnd += nextCharacter.length;
  } else {
    const previousCharacter = Array.from(value.slice(0, caret)).pop() || "";
    deleteStart -= previousCharacter.length;
  }
  input.value = `${value.slice(0, deleteStart)}${value.slice(deleteEnd)}`;
  input.setSelectionRange(deleteStart, deleteStart);
  return true;
}

function armAndroidImeProbe() {
  clearTimeout(androidImeProbeTimer);
  androidImeProbeTimer = 0;
  if (!isAndroidImeClient() || androidImeComposing || document.activeElement !== els.input) return;
  const remaining = androidImeNewlineUntil - Date.now();
  if (remaining > 0) {
    scheduleAndroidImeProbe(remaining + 20);
    return;
  }
  removeAndroidImeProbe();
  const start = Number.isInteger(els.input.selectionStart) ? els.input.selectionStart : els.input.value.length;
  const end = Number.isInteger(els.input.selectionEnd) ? els.input.selectionEnd : start;
  if (start !== end) return;
  // "end" keeps selectionStart === selectionEnd, so Chromium draws its real
  // blinking caret and the IME remains in normal text-composition mode.
  els.input.setRangeText(androidImeActionProbe, start, end, "end");
}

function scheduleAndroidImeProbe(delay = 0) {
  if (!isAndroidImeClient()) return;
  clearTimeout(androidImeProbeTimer);
  androidImeProbeTimer = setTimeout(armAndroidImeProbe, Math.max(0, delay));
}

function markAndroidImeNewlineCommit() {
  androidImeNewlineUntil = Date.now() + androidImeNewlineWindowMs;
  scheduleAndroidImeProbe(androidImeNewlineWindowMs + 20);
}

function hasPendingAndroidImeNewline() {
  return isAndroidImeClient() && androidImeNewlineUntil >= Date.now();
}

function updateVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const viewportTop = Math.max(0, Number(viewport.offsetTop) || 0);
  const viewportHeight = Math.max(1, Number(viewport.height) || window.innerHeight);
  const keyboardOffset = Math.max(0, window.innerHeight - viewportHeight - viewportTop);
  const composerHeight = Math.max(0, els.form.getBoundingClientRect().height || 0);
  document.documentElement.style.setProperty("--keyboard-offset", `${keyboardOffset}px`);
  document.documentElement.style.setProperty("--visual-viewport-top", `${viewportTop}px`);
  document.documentElement.style.setProperty("--visual-viewport-height", `${viewportHeight}px`);
  if (composerHeight) document.documentElement.style.setProperty("--mobile-composer-height", `${composerHeight}px`);
}

function draftKeyFor(threadId = state.threadId, cwd = state.cwd) {
  return `${draftPrefix}${threadId || `new:${cwd || "root"}`}`;
}

function saveDraft() {
  const key = state.draftKey || draftKeyFor();
  const value = composerText();
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
  scheduleServerDraft(value, state.threadId, state.cwd);
}

function clearDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  localStorage.removeItem(state.draftKey || draftKeyFor());
  saveServerDraft("", state.threadId, state.cwd);
}

function restoreDraftForCurrentState(serverDraft) {
  const nextKey = draftKeyFor();
  if (state.draftKey === nextKey) return;
  state.draftKey = nextKey;
  els.input.value = composerText(typeof serverDraft === "string" ? serverDraft : (localStorage.getItem(nextKey) || ""));
  autosizeInput();
  scheduleAndroidImeProbe();
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

function normalizedFilePath(value = "") {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function isLinkableFilePath(file = "") {
  const candidate = normalizedFilePath(file);
  if (!candidate) return false;
  return state.fileLinkRoots.some((root) => {
    const normalizedRoot = normalizedFilePath(root);
    if (!normalizedRoot) return false;
    if (normalizedRoot === "/") return candidate.startsWith("/");
    return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
  });
}

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePlainFilePaths(source, nextPlaceholder) {
  const roots = state.fileLinkRoots
    .map(normalizedFilePath)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  if (!roots.length) return source;
  const pattern = new RegExp(`(^|[\\s(（【「：:])((?:${roots.join("|")})(?:[/\\\\][^\\s<>"'，。；、)]*)?)`, "g");
  return source.replace(pattern, (_, prefix, file) => `${prefix}${nextPlaceholder(renderFileLink(file))}`);
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
  source = source.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, label, file) => (
    isLinkableFilePath(file) ? nextPlaceholder(renderFileLink(file, label || file)) : match
  ));
  source = source.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (isLinkableFilePath(href)) return nextPlaceholder(renderFileLink(href, label));
    const safeHref = escapeHtml(href);
    return nextPlaceholder(`<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });
  source = source.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]|\[\[([^\]]+)\]\]/g, (_, _target, label, plain) => label || plain || "");
  source = replacePlainFilePaths(source, nextPlaceholder);
  let html = escapeHtml(source);
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
  return `<pre class="markdownTable">${rendered.join("\n")}</pre>`;
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
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list?.items.length) {
      list = null;
      return;
    }
    const tag = list.ordered ? "ol" : "ul";
    const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
    const items = list.items.map((item) => {
      const depth = Math.min(3, Math.max(0, item.depth));
      const depthClass = depth ? ` markdownListDepth${depth}` : "";
      const value = list.ordered && item.value !== null ? ` value="${item.value}"` : "";
      const task = item.content.match(/^\[([ xX])\]\s+(.*)$/);
      const taskClass = task ? " markdownTaskItem" : "";
      const taskMark = task
        ? `<span class="markdownTaskMark${task[1].toLowerCase() === "x" ? " checked" : ""}" aria-hidden="true">${task[1].toLowerCase() === "x" ? "✓" : ""}</span>`
        : "";
      const content = task ? task[2] : item.content;
      return `<li class="markdownListItem${depthClass}${taskClass}"${value}>${taskMark}${renderInlineMarkdown(content)}</li>`;
    }).join("");
    html.push(`<${tag} class="markdownList"${start}>${items}</${tag}>`);
    list = null;
  };

  const flushBlockquote = () => {
    if (!blockquote.length) return;
    let start = 0;
    let content = "";
    const callout = blockquote[0].match(/^\[!(\w+)\]\s*(.*)$/);
    let className = "";
    if (callout) {
      const calloutKinds = new Set(["note", "tip", "important", "warning", "caution"]);
      const requestedKind = callout[1].toLowerCase();
      const kind = calloutKinds.has(requestedKind) ? requestedKind : "note";
      const defaultTitles = { note: "提示", tip: "建议", important: "重要", warning: "警告", caution: "注意" };
      const title = callout[2] || defaultTitles[kind];
      className = ` class="markdownCallout markdownCallout-${kind}"`;
      content += `<div class="markdownCalloutTitle">${renderInlineMarkdown(title)}</div>`;
      start = 1;
    }
    const body = blockquote.slice(start).map(renderInlineMarkdown).join("<br>");
    if (body) content += `<div class="markdownCalloutBody">${body}</div>`;
    html.push(`<blockquote${className}>${content}</blockquote>`);
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
      flushParagraph();
      flushList();
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
      flushParagraph();
      flushList();
      blockquote.push(trimmed === ">" ? "" : trimmed.replace(/^>\s?/, ""));
      continue;
    }
    if (isTable) {
      flushParagraph();
      flushList();
      table.push(trimmed);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = heading[2].replace(/[ \t]+#+[ \t]*$/, "");
      html.push(`<h${level}>${renderInlineMarkdown(content)}</h${level}>`);
    }
    else if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr class="markdownDivider">');
    }
    else {
      const bullet = line.match(/^(\s*)[-+*]\s+(.*)$/);
      const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (list?.ordered) flushList();
        if (!list) list = { ordered: false, start: 1, items: [] };
        list.items.push({
          depth: Math.floor(bullet[1].replaceAll("\t", "  ").length / 2),
          value: null,
          content: bullet[2]
        });
      } else if (ordered) {
        flushParagraph();
        if (list && !list.ordered) flushList();
        const value = Number(ordered[2]);
        if (!list) list = { ordered: true, start: value, items: [] };
        list.items.push({
          depth: Math.floor(ordered[1].replaceAll("\t", "  ").length / 2),
          value,
          content: ordered[3]
        });
      } else {
        flushList();
        const status = trimmed.match(/^(✅|🤔|❌|⏳|⚠️?|ℹ️?)\s+(.+)$/u);
        if (status) {
          flushParagraph();
          const icon = status[1];
          const kind = icon.startsWith("✅")
            ? "success"
            : (icon.startsWith("🤔") || icon.startsWith("⏳")
              ? "thinking"
              : (icon.startsWith("❌") || icon.startsWith("⚠") ? "warning" : "info"));
          html.push(`<div class="messageLead messageLead-${kind}"><span class="messageLeadIcon" aria-hidden="true">${icon}</span><span class="messageLeadText">${renderInlineMarkdown(status[2])}</span></div>`);
        } else if (/^[^：:\n]{1,32}[：:]$/u.test(trimmed)) {
          flushParagraph();
          html.push(`<h4 class="messageSectionTitle">${renderInlineMarkdown(trimmed)}</h4>`);
        } else {
          paragraph.push(line);
        }
      }
    }
  }

  flushParagraph();
  flushList();
  flushBlockquote();
  flushTable();
  if (fence) html.push(`<pre><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`);
  return html.join("\n");
}

function setMessageContent(element, text) {
  element.dataset.speechText = String(text || "");
  element.innerHTML = renderMarkdown(text);
  if (element.classList.contains("assistant")) {
    element.classList.toggle("completion", /^✅\s/.test(text || ""));
    element.classList.toggle("thinking", /^🤔\s/.test(text || ""));
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
  els.log.classList.toggle("hideThoughts", state.hideThoughts && !state.showFullReplies);
  els.log.classList.toggle("onlyMine", state.onlyMine && !state.showFullReplies);
  els.log.classList.toggle("showFullReplies", state.showFullReplies);
  if (els.onlyMineButton) {
    els.onlyMineButton.classList.toggle("active", state.onlyMine);
    els.onlyMineButton.title = state.onlyMine ? "显示全部消息" : "只看自己发送";
    els.onlyMineButton.setAttribute("aria-pressed", state.onlyMine ? "true" : "false");
  }
}

async function toggleFullReplies() {
  state.showFullReplies = !state.showFullReplies;
  localStorage.setItem("codex-remote-show-full-replies", state.showFullReplies ? "1" : "0");
  if (state.showFullReplies) {
    state.hideThoughts = false;
    state.onlyMine = false;
    localStorage.setItem("codex-remote-hide-thoughts", "0");
    localStorage.setItem("codex-remote-only-mine", "0");
  }
  applyMessageFilter();
  renderCommandList();
  closeCommandMenu();
  try {
    await loadState();
    scrollToLatest(true);
  } catch (error) {
    upsertAssistantMessage(`读取 Codex 完整回复失败：${error.message}`, true, "full-replies-error", { persist: false });
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
  const fullKind = String(meta.fullKind || "").replace(/[^a-z-]/gi, "");
  if (fullKind) {
    wrapper.classList.add("fullReplyBlock", `fullReply-${fullKind}`);
    item.classList.add("fullReply");
    item.dataset.fullKind = fullKind;
  }
  if (meta.messageId) {
    item.dataset.messageId = String(meta.messageId);
    item.dataset.final = meta.final ? "true" : "false";
  }
  if (role === "user") {
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", "朗读这条消息之后的 Codex 回复");
    item.title = "点击朗读这条消息之后的 Codex 回复";
  }
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

function renderedMessageKey(message = {}) {
  return `${message.role || ""}\n${message.content || ""}`;
}

function shouldPersistLocalAssistantBubble(final, meta = {}) {
  if (!final || meta.persist === false) return false;
  if (meta.type === "message" || meta.seq !== undefined || meta.at) return false;
  return true;
}

function persistAssistantNotice(text, messageId) {
  rememberLocalNotice(text, messageId);
  request("/api/remote/notice", {
    method: "POST",
    body: JSON.stringify({ message: text, messageId })
  }).then(() => {
    requestAnimationFrame(() => replayLocalNotices());
  }).catch((error) => console.error("failed to persist assistant notice", error));
}

function stableAssistantMessageId(messageId) {
  const id = String(messageId || "");
  return Boolean(id && id !== "assistant");
}

function assistantBubbleByMessageId(messageId, includeFinal = false) {
  if (!messageId) return null;
  return [...els.log.querySelectorAll(".message.assistant")]
    .find((item) => item.dataset.messageId === String(messageId)
      && (includeFinal || item.dataset.final !== "true")) || null;
}

function localNoticeContext() {
  return {
    connectorId: currentConnectorId(),
    threadId: state.threadId || "",
    cwd: state.cwd || ""
  };
}

function sameNoticeContext(left = {}, right = localNoticeContext()) {
  return (left.connectorId || "") === (right.connectorId || "") &&
    (left.threadId || "") === (right.threadId || "") &&
    (left.cwd || "") === (right.cwd || "");
}

function rememberLocalNotice(text, messageId) {
  const id = String(messageId || `notice-${Date.now()}`);
  const existing = state.localNotices.find((item) => item.messageId === id);
  const row = {
    ...localNoticeContext(),
    messageId: id,
    content: text,
    at: new Date().toISOString()
  };
  if (existing) Object.assign(existing, row);
  else state.localNotices.push(row);
  state.localNotices = state.localNotices.slice(-40);
}

function replayLocalNotices(messages = []) {
  const current = localNoticeContext();
  const persisted = new Set((messages || []).map((message) => `${message.role || ""}\n${message.content || ""}`));
  for (const notice of state.localNotices) {
    if (!sameNoticeContext(notice, current)) continue;
    if (persisted.has(`assistant\n${notice.content || ""}`)) continue;
    upsertAssistantMessage(notice.content, true, notice.messageId, { at: notice.at, persist: false });
  }
}

function upsertAssistantMessage(text, final = false, messageId = "assistant", meta = {}) {
  if (!text) return;
  const stableMessageId = stableAssistantMessageId(messageId);
  let bubble = state.assistantBubbles.get(messageId)
    || assistantBubbleByMessageId(messageId, stableMessageId);
  if (stableMessageId && bubble?.dataset.final === "true") {
    // Android WebView can replay an already completed SSE message with a new
    // event sequence after reconnecting. A real app-server item id is stable,
    // so this is the same bubble rather than a new reply. Ignore late deltas
    // and only accept a repeated final payload as an idempotent content update.
    if (final) setMessageContent(bubble, text);
    return bubble;
  }
  if (final && /^✅\s/.test(text || "")) {
    if (bubble?.isConnected) {
      const container = bubble.closest(".messageBlock") || bubble;
      container.remove();
    }
    const nextBubble = appendMessage("assistant", text, { ...meta, at: meta.at || new Date().toISOString() });
    if (nextBubble) {
      nextBubble.dataset.messageId = String(messageId);
      nextBubble.dataset.final = "true";
    }
    state.assistantBubbles.delete(messageId);
    if (shouldPersistLocalAssistantBubble(final, meta)) persistAssistantNotice(text, messageId);
    return;
  }
  if (!bubble?.isConnected) {
    bubble = appendMessage("assistant", text, meta);
    if (bubble) {
      bubble.dataset.messageId = String(messageId);
      bubble.dataset.final = "false";
    }
    state.assistantBubbles.set(messageId, bubble);
  } else {
    const shouldFollow = isNearBottom();
    setMessageContent(bubble, text);
    if (shouldFollow) scrollToLatest(true);
    else requestAnimationFrame(updateScrollJumps);
  }
  if (final) {
    if (bubble) bubble.dataset.final = "true";
    if (shouldPersistLocalAssistantBubble(final, meta)) persistAssistantNotice(text, messageId);
    state.assistantBubbles.delete(messageId);
  }
}

function closeCommandMenu() {
  els.commandMenu.hidden = true;
}

function toggleCommandMenu() {
  els.commandMenu.hidden = !els.commandMenu.hidden;
}

function insertCommand(command) {
  const text = composerText();
  if (text.trim().startsWith("/")) {
    els.input.value = text.replace(/^\s*\/\S*/, command);
  } else {
    els.input.value = text ? `${command} ${text}` : command;
  }
  saveDraft();
  closeCommandMenu();
  autosizeInput();
  els.input.focus();
  scheduleAndroidImeProbe();
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

function currentConnectorId() {
  return state.selectedConnectorId || "";
}

function connectorMatchesCurrent(data = {}) {
  return data.connectorId === undefined || data.connectorId === currentConnectorId();
}

async function request(url, options = {}) {
  const method = (options.method || (options.body ? "POST" : "GET")).toUpperCase();
  let finalUrl = url;
  const requestConnectorId = options.connectorId !== undefined ? options.connectorId || "" : currentConnectorId();
  const connectorParam = `connector=${encodeURIComponent(requestConnectorId)}`;
  if (!options.body) {
    finalUrl += (url.includes("?") ? "&" : "?") + connectorParam;
  }
  let finalOptions = { ...options };
  delete finalOptions.connectorId;
  if (options.body && method !== "GET") {
    try {
      const parsed = JSON.parse(options.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.connectorId === undefined) {
        parsed.connectorId = requestConnectorId;
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

function isCurrentStateSnapshot(generation, snapshotEventSeq) {
  if (generation !== stateLoadGeneration) return false;
  const sequence = Number(snapshotEventSeq);
  return !Number.isFinite(sequence) || sequence >= state.lastEventSeq;
}

async function loadState(connectorId = currentConnectorId()) {
  const generation = ++stateLoadGeneration;
  const stateUrl = state.showFullReplies ? "/api/remote/state?full=1" : "/api/remote/state";
  const data = await request(stateUrl, { connectorId });
  if (connectorId !== currentConnectorId()) return;
  if (!isCurrentStateSnapshot(generation, data.eventSeq)) return false;
  renderState(data);
  return true;
}

function settingsResponseIsCurrent(updatedAt = "") {
  const currentTime = state.modelSettingsUpdatedAt ? Date.parse(state.modelSettingsUpdatedAt) : NaN;
  if (!Number.isFinite(currentTime)) return true;
  const incomingTime = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(incomingTime) && incomingTime >= currentTime;
}

function renderState(data) {
  if (!connectorMatchesCurrent(data)) return;
  // Any direct state render (thread selection, SSE state event, pagination)
  // supersedes older /state requests that may still be in flight.
  stateLoadGeneration += 1;
  saveDraft();
  const previousConnectorId = state.selectedConnectorId || "";
  if (data.connectorId !== undefined) state.selectedConnectorId = data.connectorId || "";
  if (Array.isArray(data.connectors)) state.connectors = data.connectors;
  if (data.localRemark !== undefined) state.localConnectorRemark = data.localRemark || "";
  if (data.disableLocal !== undefined) state.disableLocal = data.disableLocal;
  const shouldFollow = isNearBottom();
  const previousTop = els.logWrap.scrollTop;
  const previousThreadId = state.threadId;
  const nextThreadId = data.threadId || "";
  if (nextThreadId !== previousThreadId || (state.selectedConnectorId || "") !== previousConnectorId) stopSpeech();
  const applySettings = nextThreadId !== previousThreadId
    || settingsResponseIsCurrent(data.modelSettingsUpdatedAt || "");
  if (Number(data.eventSeq) > state.lastEventSeq) state.lastEventSeq = Number(data.eventSeq);
  state.threadId = nextThreadId;
  if (Object.prototype.hasOwnProperty.call(data, "threadName")) {
    state.threadName = data.threadName || "";
  } else if (state.threadId !== previousThreadId) {
    state.threadName = "";
  }
  state.cwd = data.cwd || "";
  state.absoluteCwd = data.absoluteCwd || "";
  if (data.externalTaskStartedAt !== undefined) state.externalTaskStartedAt = data.externalTaskStartedAt || "";
  if (Array.isArray(data.fileLinkRoots)) state.fileLinkRoots = data.fileLinkRoots.filter((root) => typeof root === "string" && root);
  if (applySettings) {
    if (nextThreadId !== previousThreadId || data.model !== undefined) state.model = data.model || "";
    if (nextThreadId !== previousThreadId || data.reasoningEffort !== undefined) state.reasoningEffort = data.reasoningEffort || "";
    state.modelSettingsUpdatedAt = data.modelSettingsUpdatedAt || "";
  }
  restoreDraftForCurrentState(data.draft);
  state.loadedCount = Number(data.loadedCount || data.messages?.length || 0);
  state.messageCount = Number(data.messageCount || state.loadedCount);
  state.fullMessageCount = Number(data.fullMessageCount || 0);
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
  const renderedMessages = new Set();
  const historyMessages = state.showFullReplies && Array.isArray(data.fullMessages)
    ? data.fullMessages
    : (data.messages || []);
  if (state.showFullReplies && state.fullMessageCount > historyMessages.length) {
    appendEvent(`完整输出共 ${state.fullMessageCount} 条；为保证手机页面流畅，当前显示最近 ${historyMessages.length} 条。`);
  }
  for (const message of historyMessages) {
    appendMessage(message.role, message.content, message);
    renderedMessages.add(renderedMessageKey(message));
  }
  for (const message of data.liveMessages || []) {
    if (message.final && renderedMessages.has(renderedMessageKey(message))) continue;
    if (message.role === "assistant") {
      upsertAssistantMessage(message.content, message.final, message.messageId || "assistant", message);
    } else {
      appendMessage(message.role, message.content, message);
    }
  }
  replayLocalNotices(data.messages || []);
  appendCompletionEvent(data);
  if (shouldFollow) scrollToLatest(true);
  else els.logWrap.scrollTop = previousTop;
  updateLoadMore();
  setRunning(data.running, data.queueLength, data.queueMessages, data.followMode, data.steerLength, data.steerMessages, data.contextUsage, data.runningThreads, data.reconnecting, data.externalRunning);
  const taskStartedAt = state.externalRunning ? state.externalTaskStartedAt : data.inflight?.startedAt;
  if (state.running && taskStartedAt) {
    const startedAtMs = Date.parse(taskStartedAt);
    if (Number.isFinite(startedAtMs)) state.currentTaskStartedAtMs = startedAtMs;
  } else if (!state.running) {
    state.currentTaskStartedAtMs = null;
  }
  if (!els.modelSettingsPanel.hidden && state.threadId !== previousThreadId) {
    queueMicrotask(() => openModelSettings().catch((error) => {
      els.modelSettingsStatus.textContent = `读取失败：${error.message}`;
    }));
  }
  requestAnimationFrame(updateScrollJumps);
}

function renderModelSettings(data = {}) {
  if (data.threadId !== undefined && (data.threadId || "") !== state.threadId) return false;
  if (settingsResponseIsCurrent(data.modelSettingsUpdatedAt || "")) {
    state.model = data.model || "";
    state.reasoningEffort = data.reasoningEffort || "";
    state.modelSettingsUpdatedAt = data.modelSettingsUpdatedAt || state.modelSettingsUpdatedAt || "";
  }
  state.modelOptions = Array.isArray(data.models) ? data.models : [];
  const selected = state.modelOptions.find((item) => item.model === state.model || item.id === state.model);
  const sessionLabel = data.threadId ? "当前会话" : "新会话";
  els.modelSettingsCurrent.textContent = `${sessionLabel}：${state.model || "默认模型"} · ${reasoningEffortLabel(state.reasoningEffort) || "默认强度"}`;
  els.modelSettingsModels.innerHTML = "";
  for (const item of state.modelOptions) {
    const button = document.createElement("button");
    const active = item.model === state.model || item.id === state.model;
    button.className = `modelOption${active ? " active" : ""}`;
    button.type = "button";
    button.dataset.model = item.model || item.id || "";
    button.disabled = Boolean(data.running || active);
    button.innerHTML = "<strong></strong><small></small>";
    button.querySelector("strong").textContent = item.displayName || item.model || item.id;
    button.querySelector("small").textContent = item.description || item.model || item.id;
    button.addEventListener("click", () => changeModelSettings({ model: button.dataset.model }));
    els.modelSettingsModels.appendChild(button);
  }
  els.modelSettingsEfforts.innerHTML = "";
  for (const option of selected?.supportedReasoningEfforts || []) {
    const button = document.createElement("button");
    const active = option.reasoningEffort === state.reasoningEffort;
    const isDefault = option.reasoningEffort === selected.defaultReasoningEffort;
    button.className = `effortOption${active ? " active" : ""}`;
    button.type = "button";
    button.dataset.effort = option.reasoningEffort || "";
    button.disabled = Boolean(data.running || active);
    button.textContent = `${option.label || reasoningEffortLabel(option.reasoningEffort)}${isDefault ? " · 默认" : ""}`;
    button.title = option.description || "";
    button.addEventListener("click", () => changeModelSettings({ reasoningEffort: button.dataset.effort }));
    els.modelSettingsEfforts.appendChild(button);
  }
  els.modelSettingsStatus.textContent = data.running ? "当前会话正在处理，结束或中断后可切换。" : "";
  return true;
}

async function openModelSettings() {
  const connectorId = currentConnectorId();
  const threadId = state.threadId;
  els.modelSettingsPanel.hidden = false;
  els.usagePanel.hidden = true;
  els.filePanel.hidden = true;
  els.threadPanel.hidden = true;
  els.sshConnectPanel.hidden = true;
  els.connectorPanel.hidden = true;
  els.modelSettingsCurrent.textContent = "正在读取当前会话...";
  els.modelSettingsModels.innerHTML = "";
  els.modelSettingsEfforts.innerHTML = "";
  els.modelSettingsStatus.textContent = "";
  const data = await request("/api/remote/model-settings", { connectorId });
  if (connectorId !== currentConnectorId() || threadId !== state.threadId) return;
  renderModelSettings(data);
}

async function changeModelSettings(update = {}) {
  if (modelSettingsChanging) return;
  modelSettingsChanging = true;
  const connectorId = currentConnectorId();
  const threadId = state.threadId;
  els.modelSettingsStatus.textContent = "正在切换...";
  for (const button of els.modelSettingsPanel.querySelectorAll(".modelOption, .effortOption")) button.disabled = true;
  try {
    const data = await request("/api/remote/model-settings", {
      method: "POST",
      connectorId,
      body: JSON.stringify(update)
    });
    if (connectorId !== currentConnectorId() || threadId !== state.threadId) return;
    renderModelSettings(data);
    els.modelSettingsStatus.textContent = "已为当前会话保存。";
  } catch (error) {
    els.modelSettingsStatus.textContent = `切换失败：${error.message}`;
    for (const button of els.modelSettingsPanel.querySelectorAll(".modelOption, .effortOption")) {
      button.disabled = button.classList.contains("active");
    }
  } finally {
    modelSettingsChanging = false;
  }
}

function usageResetTime(value = 0) {
  const time = Number(value) * 1000;
  if (!Number.isFinite(time) || time <= 0) return "重置时间未知";
  const date = new Date(time);
  const now = new Date();
  const timeText = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? `将于 ${timeText} 重置` : `将于 ${date.getMonth() + 1}月${date.getDate()}日 ${timeText} 重置`;
}

function usageQuotaTitle(limit = {}) {
  const minutes = Math.round(Number(limit.windowDurationMins));
  if (!Number.isFinite(minutes) || minutes <= 0) return "使用限额";
  if (minutes % (7 * 24 * 60) === 0) return minutes === 7 * 24 * 60 ? "每周使用限额" : `${minutes / (7 * 24 * 60)} 周使用限额`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天使用限额`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时使用限制`;
  return `${minutes} 分钟使用限制`;
}

function usageQuotaItem(limit = {}) {
  const used = Math.max(0, Math.min(100, Number(limit.usedPercent) || 0));
  const item = document.createElement("section");
  item.className = "usageQuota";
  const heading = document.createElement("strong");
  heading.textContent = usageQuotaTitle(limit);
  const row = document.createElement("div");
  row.className = "usageQuotaRow";
  const reset = document.createElement("span");
  reset.textContent = usageResetTime(limit.resetsAt);
  const progress = document.createElement("div");
  progress.className = "usageProgress";
  const fill = document.createElement("span");
  fill.style.width = `${100 - used}%`;
  progress.appendChild(fill);
  const remaining = document.createElement("span");
  remaining.className = "usageRemaining";
  remaining.textContent = `剩余 ${100 - used}%`;
  row.append(reset, progress, remaining);
  item.append(heading, row);
  return item;
}

function renderUsage(data = {}) {
  els.usageContent.innerHTML = "";
  const quotaCard = document.createElement("div");
  quotaCard.className = "usageCard";
  if (data.primary) quotaCard.appendChild(usageQuotaItem(data.primary));
  if (data.secondary) quotaCard.appendChild(usageQuotaItem(data.secondary));
  if (!quotaCard.childElementCount) quotaCard.textContent = "暂时无法读取使用限额。";
  els.usageContent.appendChild(quotaCard);

  const resetCard = document.createElement("details");
  resetCard.className = "usageCard usageResetCard";
  const head = document.createElement("summary");
  head.className = "usageResetHead";
  const title = document.createElement("strong");
  title.textContent = "重置次数";
  const count = Number(data.resetCredits?.availableCount) || 0;
  const badge = document.createElement("span");
  badge.className = "usageBadge";
  badge.textContent = count ? `可用 ${count} 次` : "暂无可用次数";
  head.append(title, badge);
  resetCard.appendChild(head);
  const credits = Array.isArray(data.resetCredits?.credits) ? data.resetCredits.credits : [];
  const body = document.createElement("div");
  body.className = credits.length ? "usageResetBody usageResetList" : "usageResetBody";
  if (!credits.length) {
    body.textContent = "没有可用的重置额度";
  }
  for (const [index, credit] of credits.entries()) {
    const row = document.createElement("div");
    row.className = "usageResetItem";
    const detail = document.createElement("div");
    const creditTitle = document.createElement("strong");
    creditTitle.textContent = credit.title || `重置额度 ${index + 1}`;
    const expires = document.createElement("small");
    const expiresAt = Number(credit.expiresAt) * 1000;
    expires.textContent = Number.isFinite(expiresAt) && expiresAt > 0
      ? `到期：${new Date(expiresAt).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`
      : "到期时间未知";
    detail.append(creditTitle, expires);
    const button = document.createElement("button");
    button.className = "usageResetButton";
    button.type = "button";
    button.textContent = "使用重置";
    button.disabled = credit.status !== "available";
    button.addEventListener("click", () => resetUsageCredit(credit));
    row.append(detail, button);
    body.appendChild(row);
  }
  resetCard.appendChild(body);
  els.usageContent.appendChild(resetCard);
}

async function openUsagePanel() {
  els.usagePanel.hidden = false;
  els.modelSettingsPanel.hidden = true;
  els.filePanel.hidden = true;
  els.threadPanel.hidden = true;
  els.sshConnectPanel.hidden = true;
  els.connectorPanel.hidden = true;
  els.usageContent.innerHTML = '<div class="remoteEvent">正在刷新使用量...</div>';
  els.usageStatus.textContent = "";
  renderUsage(await request("/api/remote/usage"));
}

async function resetUsageCredit(credit = {}) {
  if (!credit.id) return;
  if (!confirm("确定使用这一次完整额度重置吗？这会重置当前全部使用额度。")) return;
  els.usageStatus.textContent = "正在重置...";
  try {
    const data = await request("/api/remote/usage/reset", {
      method: "POST",
      body: JSON.stringify({ creditId: credit.id })
    });
    renderUsage(data);
    els.usageStatus.textContent = "使用额度已重置。";
  } catch (error) {
    els.usageStatus.textContent = `重置失败：${error.message}`;
  }
}

function updateLoadMore() {
  if (state.showFullReplies) {
    els.loadMore.hidden = true;
    return;
  }
  const hasMore = state.threadId && state.messageCount > state.loadedCount;
  els.loadMore.hidden = !hasMore;
  els.loadMore.textContent = hasMore ? `加载更多（${state.loadedCount}/${state.messageCount}）` : "加载更多";
}

async function loadMoreMessages() {
  if (!state.threadId || state.running) return;
  const connectorId = currentConnectorId();
  const previousHeight = els.logWrap.scrollHeight;
  const data = await request("/api/remote/more", { method: "POST", connectorId });
  if (connectorId !== currentConnectorId()) return;
  renderState(data);
  els.logWrap.scrollTop = Math.max(0, els.logWrap.scrollHeight - previousHeight);
  updateScrollJumps();
}

function threadSubtitle(thread, isActive = false) {
  const date = thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : "";
  const status = thread.externalRunning
    ? "Codex Desktop/CLI 运行中 · 只读同步"
    : (thread.running ? `运行中${thread.queueLength ? ` · 队列 ${thread.queueLength}` : ""}` : "");
  return [isActive ? "当前会话" : "", status, date, `${thread.messageCount} 条`].filter(Boolean).join(" · ");
}

function fileIcon(item) {
  if (item.type === "dir") return "📁";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(item.name)) return "🖼️";
  return "📄";
}

function displayProjectPath(cwd = "", absoluteCwd = "") {
  return absoluteCwd || (cwd ? `/${cwd}` : "项目根目录");
}

function setProjectUploadStatus(message = "", type = "") {
  if (!els.projectUploadStatus) return;
  els.projectUploadStatus.hidden = !message;
  els.projectUploadStatus.textContent = message;
  els.projectUploadStatus.className = `projectUploadStatus${type ? ` ${type}` : ""}`;
}

function closeProjectUploadMenu() {
  if (!els.projectUploadMenu) return;
  els.projectUploadMenu.hidden = true;
  els.projectUploadButton?.setAttribute("aria-expanded", "false");
}

function toggleProjectUploadMenu() {
  if (!els.projectUploadMenu) return;
  const willOpen = els.projectUploadMenu.hidden;
  els.projectUploadMenu.hidden = !willOpen;
  els.projectUploadButton?.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function projectUploadRelativePath(file, index = 0) {
  return String(file?.webkitRelativePath || file?.name || `upload-${Date.now()}-${index}`)
    .replaceAll("\\", "/");
}

function sendProjectUploadRequest(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(Math.max(0, Math.min(100, Math.round(event.loaded / event.total * 100))));
      }
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status === 401) {
        location.href = `${basePath}/login.html`;
        reject(new Error("登录已失效。"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `HTTP ${xhr.status}`));
        return;
      }
      resolve(data);
    });
    xhr.addEventListener("error", () => reject(new Error("网络连接失败。")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消。")));
    xhr.send(form);
  });
}

async function uploadProjectItems(files = [], selectionType = "files") {
  closeProjectUploadMenu();
  if (!files.length) {
    if (selectionType === "folder") {
      setProjectUploadStatus("没有选到可上传的文件；浏览器无法导入完全空的文件夹。", "error");
    }
    return;
  }
  if (currentConnectorId()) {
    setProjectUploadStatus("被控电脑文件上传暂不支持，请先切换到本机项目。", "error");
    return;
  }
  if (files.length > 5000) {
    setProjectUploadStatus("单次最多上传 5000 个文件。", "error");
    return;
  }
  const totalBytes = files.reduce((total, file) => total + (Number(file.size) || 0), 0);
  if (totalBytes > 512 * 1024 * 1024) {
    setProjectUploadStatus("单次上传总大小不能超过 512MB。", "error");
    return;
  }

  const cwd = state.fileCwd || "";
  const connectorId = currentConnectorId();
  const form = new FormData();
  files.forEach((file, index) => {
    form.append("files", file, projectUploadRelativePath(file, index));
  });
  const params = new URLSearchParams({ dir: cwd });
  if (connectorId) params.set("connector", connectorId);
  const buttons = [els.projectUploadButton, els.projectFilesButton, els.projectFolderButton].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  setProjectUploadStatus(`正在上传 ${files.length} 个文件（${formatSize(totalBytes)}）…`);
  try {
    const data = await sendProjectUploadRequest(
      `${basePath}/api/remote/project-upload?${params.toString()}`,
      form,
      (percent) => setProjectUploadStatus(`正在上传 ${files.length} 个文件（${formatSize(totalBytes)}）… ${percent}%`)
    );
    if (connectorId === currentConnectorId() && cwd === state.fileCwd) {
      await openFiles(data.cwd ?? cwd);
    }
    const folderText = Number(data.directories) > 0 ? `，保留 ${data.directories} 个文件夹层级` : "";
    setProjectUploadStatus(`上传完成：${data.uploaded || files.length} 个文件${folderText}。`, "success");
  } catch (error) {
    setProjectUploadStatus(`上传失败：${error.message}`, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    if (els.projectFilesInput) els.projectFilesInput.value = "";
    if (els.projectFolderInput) els.projectFolderInput.value = "";
  }
}

function projectItemName(file = "", fallback = "download") {
  const parts = String(file || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || fallback;
}

function projectDownloadUrl(file = "", type = "file") {
  const params = new URLSearchParams({
    path: String(file || ""),
    type: type === "dir" ? "dir" : "file"
  });
  const connectorId = currentConnectorId();
  if (connectorId) params.set("connector", connectorId);
  return `${basePath}/api/remote/project-download?${params.toString()}`;
}

function downloadProjectItem(file = "", name = "", type = "file") {
  if (currentConnectorId()) {
    upsertAssistantMessage(
      "被控电脑文件下载暂不支持，请先切换到本机项目。",
      true,
      "project-download-unsupported"
    );
    return false;
  }
  const itemType = type === "dir" ? "dir" : "file";
  const baseName = name || projectItemName(file);
  const link = document.createElement("a");
  link.href = projectDownloadUrl(file, itemType);
  link.download = itemType === "dir" ? `${baseName}.zip` : baseName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

async function openFiles(dir = "") {
  const connectorId = state.selectedConnectorId || "";
  if (state.fileCwdConnectorId !== connectorId) {
    state.fileCwd = "";
    state.fileCwdConnectorId = connectorId;
  }
  els.modelSettingsPanel.hidden = true;
  els.usagePanel.hidden = true;
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
      actions.append(fileActionButton("下载", "download"));
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
  const nextDir = dir === undefined ? (state.newCwd || (connectorId ? "" : (state.cwd || ""))) : dir;
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
  const connectorId = currentConnectorId();
  const data = await request("/api/remote/new", {
    method: "POST",
    connectorId,
    body: JSON.stringify({ cwd: state.newCwd || "" })
  });
  if (connectorId !== currentConnectorId()) return;
  renderState(data);
  els.threadPanel.hidden = true;
}

async function previewFile(file) {
  els.filePreview.hidden = false;
  els.filePreview.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request(`/api/remote/file?path=${encodeURIComponent(file)}`);
    if (data.type === "image") {
      els.filePreview.innerHTML = `<div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><button type="button" data-download-project-file>下载</button></div><img src="${basePath}${data.url}" alt="${escapeHtml(data.path)}">`;
    } else {
      els.filePreview.innerHTML = `
        <div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><div class="panelActions"><button type="button" data-save-project-file>保存</button><button type="button" data-download-project-file>下载</button></div></div>
        <div class="sshEditor"><textarea id="projectEditorText" spellcheck="false">${escapeHtml(data.text)}</textarea></div>
      `;
      els.filePreview.querySelector("[data-save-project-file]").addEventListener("click", () => saveProjectFile(data.path));
    }
    els.filePreview.querySelector("[data-download-project-file]")?.addEventListener("click", () => {
      downloadProjectItem(data.path || file, projectItemName(data.path || file), "file");
    });
  } catch (error) {
    els.filePreview.innerHTML = `<div class="filePreviewTop"><strong>${escapeHtml(file)}</strong><button type="button" data-download-project-file>下载</button></div><div class="remoteEvent">${escapeHtml(error.message)}</div>`;
    els.filePreview.querySelector("[data-download-project-file]")?.addEventListener("click", () => {
      downloadProjectItem(file, projectItemName(file), "file");
    });
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
  els.modelSettingsPanel.hidden = true;
  els.usagePanel.hidden = true;
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
  if (!id) return state.localConnectorRemark || "";
  const device = state.connectors.find((item) => item.id === id);
  return device?.remark || "";
}

async function promptConnectorRemark(device) {
  const current = connectorRemark(device.id);
  const input = prompt(`为「${device.name || device.hostname || device.id}」设置备注名：`, current);
  if (input === null) return;
  const trimmed = input.trim();
  const data = await request("/api/remote/connectors/remark", {
    method: "POST",
    body: JSON.stringify({ connectorId: device.id || "", remark: trimmed })
  });
  if (device.id) {
    const target = state.connectors.find((item) => item.id === device.id);
    if (target) target.remark = data.remark || "";
  } else {
    state.localConnectorRemark = data.remark || "";
  }
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
    promptConnectorRemark(device).catch((error) => upsertAssistantMessage(`备注保存失败：${error.message}`, true));
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
  if (data.selectedConnectorId !== undefined) state.selectedConnectorId = data.selectedConnectorId || "";
  state.localConnectorRemark = data.localRemark || "";
  renderConnectors();
  updateMeta();
}

async function openConnectors() {
  els.modelSettingsPanel.hidden = true;
  els.usagePanel.hidden = true;
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
  await request("/api/remote/connectors/select", {
    method: "POST",
    connectorId: id,
    body: JSON.stringify({ connectorId: id })
  });
  await applyConnectorSelection(id, { closePanel: true });
}

async function applyConnectorSelection(id = "", options = {}) {
  state.selectedConnectorId = id;
  state.externalRunning = false;
  state.externalTaskStartedAt = "";
  state.threadId = "";
  state.threadName = "";
  state.cwd = "";
  state.absoluteCwd = "";
  state.model = "";
  state.reasoningEffort = "";
  state.modelSettingsUpdatedAt = "";
  state.modelOptions = [];
  state.fileCwd = "";
  state.fileCwdConnectorId = id;
  state.newCwd = "";
  state.newCwdConnectorId = id;
  state.messages = [];
  state.activeAssistant = null;
  state.assistantBubbles.clear();
  state.replyDone = false;
  els.log.innerHTML = "";
  els.modelSettingsPanel.hidden = true;
  els.usagePanel.hidden = true;
  if (options.closePanel) els.connectorPanel.hidden = true;
  updateMeta();
  await loadState(id).catch((error) => upsertAssistantMessage(`切换失败：${error.message}`, true));
  if (!els.filePanel.hidden) loadFiles().catch(() => {});
  if (!els.threadPanel.hidden) openThreads().catch(() => {});
  if (!els.connectorPanel.hidden) renderConnectors();
}

let threadListRequestGeneration = 0;
let threadListRefreshTimer = null;

function runningThreadsSignature(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => `${item.connectorId || ""}:${item.threadId || item.runnerKey || ""}:${item.externalRunning ? 1 : 0}`)
    .sort()
    .join("|");
}

function scheduleThreadListRefresh(delay = 150) {
  if (els.threadPanel.hidden || els.threadExistingView.hidden) return;
  clearTimeout(threadListRefreshTimer);
  threadListRefreshTimer = setTimeout(() => {
    threadListRefreshTimer = null;
    if (els.threadPanel.hidden || els.threadExistingView.hidden) return;
    openThreads().catch((error) => console.warn("会话列表刷新失败", error));
  }, Math.max(0, Number(delay) || 0));
}

async function openThreads() {
  els.modelSettingsPanel.hidden = true;
  els.usagePanel.hidden = true;
  const connectorId = currentConnectorId();
  const requestGeneration = ++threadListRequestGeneration;
  els.threadPanel.hidden = false;
  setThreadView("existing");
  els.threadList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request("/api/remote/threads", { connectorId });
    if (connectorId !== currentConnectorId() || requestGeneration !== threadListRequestGeneration) return;
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
      else state.completedUnreadThreads.delete(thread.threadId);
      const isActive = thread.threadId === state.threadId;
      const isCompletedUnread = Boolean(thread.completedUnread || state.completedUnreadThreads.has(thread.threadId));
      button.className = `threadItem${isActive ? " active" : ""}${thread.running ? " running" : ""}${!thread.running && isCompletedUnread ? " completedUnread" : ""}`;
      button.type = "button";
      button.innerHTML = '<strong></strong><small class="threadMeta"></small><small class="threadPath"></small>';
      button.querySelector("strong").textContent = thread.name ? `📌 ${thread.title}` : thread.title;
      button.querySelector(".threadMeta").textContent = threadSubtitle(thread, isActive);
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
    if (connectorId !== currentConnectorId() || requestGeneration !== threadListRequestGeneration) return;
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
  const connectorId = currentConnectorId();
  const data = await request("/api/remote/select", {
    method: "POST",
    connectorId,
    body: JSON.stringify({ threadId })
  });
  if (connectorId !== currentConnectorId()) return;
  state.completedUnreadThreads.delete(threadId);
  if (state.showFullReplies) await loadState(connectorId);
  else renderState(data);
  els.threadPanel.hidden = true;
}

let externalSessionRefreshTimer = null;

function scheduleExternalSessionRefresh(connectorId = currentConnectorId()) {
  clearTimeout(externalSessionRefreshTimer);
  externalSessionRefreshTimer = setTimeout(() => {
    loadState(connectorId).catch((error) => console.warn("外部 Codex 会话刷新失败", error));
  }, 150);
}

function applyIncomingModelSettings(data = {}, running = state.running) {
  const nextUpdatedAt = data.modelSettingsUpdatedAt || data.settingsUpdatedAt || "";
  if (!settingsResponseIsCurrent(nextUpdatedAt)) return false;
  const settingsChanged = Boolean(
    (Object.prototype.hasOwnProperty.call(data, "model") && data.model !== state.model)
    || (Object.prototype.hasOwnProperty.call(data, "reasoningEffort") && data.reasoningEffort !== state.reasoningEffort)
  );
  if (Object.prototype.hasOwnProperty.call(data, "model")) state.model = data.model || "";
  if (Object.prototype.hasOwnProperty.call(data, "reasoningEffort")) state.reasoningEffort = data.reasoningEffort || "";
  if (nextUpdatedAt) state.modelSettingsUpdatedAt = nextUpdatedAt;
  if (settingsChanged && !els.modelSettingsPanel.hidden) {
    renderModelSettings({
      threadId: state.threadId,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      modelSettingsUpdatedAt: state.modelSettingsUpdatedAt,
      models: state.modelOptions,
      running
    });
  }
  return settingsChanged;
}

function remoteEventSequence(data = {}) {
  const sequence = Number(data.seq);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

function rememberRemoteEvent(data = {}) {
  const sequence = remoteEventSequence(data);
  if (!sequence) return true;
  if (processedEventSeqs.has(sequence)) return false;
  processedEventSeqs.add(sequence);
  while (processedEventSeqs.size > 1000) {
    processedEventSeqs.delete(processedEventSeqs.values().next().value);
  }
  if (sequence > state.lastEventSeq) state.lastEventSeq = sequence;
  return true;
}

function processRemoteEvents(events = [], floorSequence = 0) {
  const ordered = events
    .map((event, index) => ({ event, index, sequence: remoteEventSequence(event) }))
    .sort((left, right) => {
      if (left.sequence && right.sequence && left.sequence !== right.sequence) return left.sequence - right.sequence;
      if (left.sequence !== right.sequence) return left.sequence ? 1 : -1;
      return left.index - right.index;
    });
  for (const { event, sequence } of ordered) {
    if (floorSequence && sequence && sequence <= floorSequence) continue;
    handleRemoteEvent(event);
  }
}

function handleRemoteEvent(data) {
  if (!rememberRemoteEvent(data)) return;
  if (data.type === "connectors_changed") { loadConnectors().catch(() => {}); return; }
  if (data.type === "connector_selected") {
    const nextId = data.selectedConnectorId || "";
    if (nextId !== state.selectedConnectorId) {
      applyConnectorSelection(nextId).catch((error) => upsertAssistantMessage(`同步被控电脑失败：${error.message}`, true));
    } else {
      renderConnectors();
    }
    return;
  }
  if (data.connectorId !== undefined && data.connectorId !== (state.selectedConnectorId || "")) {
    if (data.type === "runner_status") state.runningThreads = Array.isArray(data.runningThreads) ? data.runningThreads : state.runningThreads;
    return;
  }
  if (data.type === "model_settings_update") {
    if (data.threadId !== state.threadId) return;
    applyIncomingModelSettings(data);
    return;
  }
  if (data.type === "external_session_update") {
    if (data.threadId !== state.threadId) return;
    applyIncomingModelSettings(data, Boolean(data.running));
    state.externalTaskStartedAt = data.externalTaskStartedAt || state.externalTaskStartedAt || "";
    setRunning(
      data.running,
      state.queueLength,
      state.queueMessages,
      state.followMode,
      state.steerLength,
      state.steerMessages,
      data.contextUsage || state.contextUsage,
      state.runningThreads,
      false,
      data.externalRunning
    );
    scheduleExternalSessionRefresh(currentConnectorId());
    scheduleThreadListRefresh();
    return;
  }
  if (data.type === "status") setRunning(data.running, data.queueLength, data.queueMessages, data.followMode, data.steerLength, data.steerMessages, data.contextUsage, data.runningThreads, data.reconnecting, data.externalRunning);
  if (data.type === "reconnecting") {
    state.reconnecting = Boolean(data.reconnecting);
    updateMeta();
    updateStatusIcon();
  }
  if (data.type === "runner_status") {
    const previousSignature = runningThreadsSignature(state.runningThreads);
    state.runningThreads = Array.isArray(data.runningThreads) ? data.runningThreads : [];
    if (previousSignature !== runningThreadsSignature(state.runningThreads)) scheduleThreadListRefresh();
  }
  if (data.type === "message") {
    if (data.role === "assistant" && (data.transient || data.final)) {
      if (data.final && /^✅\s/.test(data.content || "") && data.taskDurationMs === undefined && state.currentTaskStartedAtMs) {
        data.taskDurationMs = Math.max(0, Date.now() - state.currentTaskStartedAtMs);
      }
      upsertAssistantMessage(data.content, data.final, data.messageId || "assistant", data);
      if (data.final) speakCompletedAssistantMessage(data);
      if (data.final && (/^✅\s/.test(data.content || "") || data.taskFailed)) {
        notifyCodexReply(data.notificationText ? { ...data, content: data.notificationText } : data);
      }
    } else {
      appendMessage(data.role, data.content, data);
      if (data.role === "user") {
        state.activeAssistant = null;
        state.assistantBubbles.clear();
        state.replyDone = false;
      }
    }
  }
  if (data.type === "cli_message") {
    if (state.showFullReplies && data.role === "assistant") {
      upsertAssistantMessage(data.content, data.final, data.messageId || "cli-message", data);
    }
    return;
  }
  if (data.type === "reply_done") {
    state.replyDone = true;
    updateMeta();
  }
  if (data.type === "done") {
    state.currentTaskStartedAtMs = null;
    // The final message has already been rendered from the preceding SSE
    // event. Rebuilding the message list here can replace that live bubble
    // with a lagging thread snapshot, making a short reply such as "ok"
    // disappear until the conversation is reopened. The following status
    // event updates the running state without touching the rendered messages.
    scheduleThreadListRefresh(250);
  }
  if (data.type === "thread_completion" && data.threadId) {
    if (data.completedUnread) state.completedUnreadThreads.add(data.threadId);
    else state.completedUnreadThreads.delete(data.threadId);
    scheduleThreadListRefresh();
  }
  if (data.type === "error") {
    upsertAssistantMessage(`错误：${data.text}`, true, data.messageId || "error");
    if (data.taskFailed) {
      notifyCodexReply({
        role: "assistant",
        content: data.text,
        messageId: data.messageId || `task-error-${Date.now()}`,
        taskFailed: true
      });
    }
  }
  if (data.type === "state") {
    if (state.showFullReplies && data.threadId && !Array.isArray(data.fullMessages)) {
      loadState(currentConnectorId()).catch((error) => console.warn("读取 Codex 完整回复失败", error));
    } else {
      renderState(data);
    }
  }
  if (data.type === "thread_name" && data.threadId === state.threadId) {
    state.threadName = data.name || "";
    updateMeta();
  }
}

async function resyncEvents() {
  if (state.resyncingEvents) return;
  state.resyncingEvents = true;
  let snapshotFloorSequence = 0;
  try {
    const data = await request(`/api/remote/changes?afterSeq=${encodeURIComponent(state.lastEventSeq || 0)}`);
    if (data.reset) {
      await loadState();
      snapshotFloorSequence = state.lastEventSeq;
    } else {
      const buffered = pendingRemoteEvents.splice(0);
      processRemoteEvents([...(data.events || []), ...buffered]);
      if (Number(data.eventSeq) > state.lastEventSeq) state.lastEventSeq = Number(data.eventSeq);
    }
  } finally {
    const buffered = pendingRemoteEvents.splice(0);
    state.resyncingEvents = false;
    processRemoteEvents(buffered, snapshotFloorSequence);
  }
}

function updateRealtimeReconcile() {
  if (!state.running) {
    clearTimeout(realtimeReconcileTimer);
    realtimeReconcileTimer = 0;
    return;
  }
  if (realtimeReconcileTimer) return;
  realtimeReconcileTimer = setTimeout(async () => {
    realtimeReconcileTimer = 0;
    if (document.visibilityState !== "hidden") {
      await resyncEvents().catch(() => loadState().catch(() => {}));
    }
    updateRealtimeReconcile();
  }, 3000);
}

function connectEvents() {
  const source = new EventSource(`${basePath}/api/remote/events`);
  source.onopen = () => {
    state.connected = true;
    state.eventDisconnected = false;
    updateStatusIcon();
    updateMeta();
    // Always close the race between the preceding /state response and this
    // EventSource connection. This also repairs Android WebView reconnects.
    resyncEvents().catch(() => loadState().catch(() => {}));
  };
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (state.resyncingEvents && remoteEventSequence(data)) pendingRemoteEvents.push(data);
    else handleRemoteEvent(data);
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
  // Replaying missed events preserves the live DOM bubbles. A full state
  // rebuild is only the fallback (or is requested by resyncEvents when the
  // replay window has expired).
  resyncEvents().catch(() => loadState().catch(() => {}));
}

function restorePushSubscription() {
  if (notificationPermission() !== "granted") return;
  subscribeWebPush()
    .catch((error) => console.error("web push restore failed", error))
    .finally(renderCommandList);
}

async function refreshNativeNotificationStatus() {
  const status = await request("/api/remote/notifications/status");
  state.nativeNotificationConnected = Number(status?.connected || 0) > 0;
  renderCommandList();
}

async function sendMessage(mode = "steer") {
  cancelPendingAndroidImeEnter();
  const connectorId = currentConnectorId();
  const message = composerText().trim();
  if (!message && !state.uploads.length) return;
  if (state.externalRunning) {
    upsertAssistantMessage("Codex Desktop/CLI 正在执行这个会话，网页端当前为只读实时同步。请等任务结束后再发送。", true, "external-session-readonly", { persist: false });
    return;
  }
  if (state.disableLocal && !connectorId) {
    upsertAssistantMessage("当前为纯控制中心模式，请先在「PC 被控电脑」面板添加并切换到一台被控电脑。", true);
    return;
  }
  const outgoingMessage = messageWithUploads(message);
  const sendMode = mode === "steer" ? "steer" : "queue";
  els.input.value = "";
  clearDraft();
  autosizeInput();
  scheduleAndroidImeProbe();
  state.replyDone = false;
  state.currentTaskStartedAtMs = Date.now();
  const followMatch = outgoingMessage.trim().toLowerCase().match(/^\/follow\s+(queue|steer)$/);
  setRunning(true, state.queueLength, state.queueMessages, followMatch ? followMatch[1] : state.followMode, state.steerLength, state.steerMessages, state.contextUsage, state.runningThreads, false, false);
  try {
    const result = await request("/api/remote/send", {
      method: "POST",
      connectorId,
      body: JSON.stringify({ message: outgoingMessage, followMode: sendMode })
    });
    if (connectorId !== currentConnectorId()) return;
    state.uploads = [];
    renderUploadList();
    if (result?.local) setRunning(result.running, result.queueLength, result.queueMessages, result.followMode, result.steerLength, result.steerMessages, result.contextUsage, result.runningThreads, result.reconnecting, result.externalRunning);
    if (result?.queued || result?.steered) setRunning(true, result.queueLength, result.queueMessages, result.followMode, result.steerLength, result.steerMessages, result.contextUsage, result.runningThreads, result.reconnecting, result.externalRunning);
  } catch (error) {
    upsertAssistantMessage(`错误：${error.message}`, true);
    setRunning(false);
  }
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage("steer");
});

els.sendQueue.addEventListener("click", () => {
  sendMessage("queue");
});

if (els.onlyMineButton) {
  els.onlyMineButton.addEventListener("click", toggleOnlyMine);
}

function shouldSendMessageFromKeydown(event = {}, androidImeActionReady = false, androidImeNewlinePending = false) {
  if (event.key !== "Enter") return false;
  if ((event.ctrlKey || event.metaKey) && !event.isComposing) return true;
  return Boolean(
    androidImeActionReady
    && !androidImeNewlinePending
    && !isAndroidImeCompositionKey(event)
    && !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
  );
}

els.input.addEventListener("keydown", (event) => {
  if (isAndroidImeClient() && isAndroidImeProcessKey(event)) rememberAndroidImeProcessKey(event);
  if (
    isAndroidImeClient()
    && isAndroidImeProbeArmed()
    && (event.key === "Backspace" || event.key === "Delete")
  ) {
    // Let the browser perform its normal deletion against the real text, not
    // against the zero-width action probe immediately before the caret.
    removeAndroidImeProbe();
    return;
  }
  const processKeyNewline = hasAndroidImeNewlinePrelude();
  const pendingNewline = hasPendingAndroidImeNewline() || processKeyNewline;
  const androidImeActionReady = isAndroidImeClient()
    && (isAndroidImeProbeArmed() || event.isComposing);
  if (!shouldSendMessageFromKeydown(event, androidImeActionReady, pendingNewline)) {
    if (event.key === "Enter" && pendingNewline) {
      androidImeNewlineUntil = 0;
      androidImeNewlinePreludeUntil = 0;
    }
    return;
  }
  if (androidImeActionReady && !event.ctrlKey && !event.metaKey) {
    // Do not cancel Enter yet. Android emits beforeinput immediately after
    // keydown; insertText means the dedicated newline button, while the
    // editor's insertLineBreak is the keyboard Send action. Waiting for that
    // event preserves the native caret and still lets both keys be distinct.
    queueAndroidImeSendDecision();
    return;
  }
  event.preventDefault();
  androidImeNewlineUntil = 0;
  removeAndroidImeProbe();
  sendMessage("steer");
  // Re-arm as well when sendMessage exits early (for example, empty text or a
  // temporarily read-only conversation).
  scheduleAndroidImeProbe();
});

els.input.addEventListener("beforeinput", (event) => {
  if (!isAndroidImeClient()) return;
  const probeArmed = isAndroidImeProbeArmed();
  const deletionDirection = event.inputType === "deleteContentBackward"
    ? "backward"
    : (event.inputType === "deleteContentForward" ? "forward" : "");
  if (probeArmed && deletionDirection) {
    cancelPendingAndroidImeEnter();
    if (event.cancelable) {
      event.preventDefault();
      deleteComposerTextBesideProbe(els.input, deletionDirection);
      androidImeNewlineUntil = 0;
      autosizeInput();
      saveDraft();
      scheduleAndroidImeProbe();
    } else {
      removeAndroidImeProbe();
    }
    return;
  }
  const textNewline = isAndroidImeTextNewline(event);
  const browserLineBreak = isAndroidBrowserLineBreak(event);
  if (pendingAndroidImeEnter) {
    if (textNewline || androidImeComposing) {
      cancelPendingAndroidImeEnter();
      markAndroidImeNewlineCommit();
      return;
    }
    if (browserLineBreak) {
      if (!event.cancelable) {
        cancelPendingAndroidImeEnter();
        markAndroidImeNewlineCommit();
        return;
      }
      event.preventDefault();
      finishPendingAndroidImeSend();
      return;
    }
    cancelPendingAndroidImeEnter();
  }
  if (browserLineBreak || (textNewline && (probeArmed || androidImeComposing))) {
    markAndroidImeNewlineCommit();
  }
});

els.input.addEventListener("compositionstart", () => {
  clearAndroidImeProcessKeyState();
  cancelPendingAndroidImeEnter();
  androidImeComposing = true;
});

els.input.addEventListener("compositionend", (event) => {
  androidImeComposing = false;
  if (isAndroidImeClient() && event.data === "") markAndroidImeNewlineCommit();
  else scheduleAndroidImeProbe();
});

els.input.addEventListener("input", (event) => {
  clearAndroidImeProcessKeyState();
  if (pendingAndroidImeEnter && composerText() !== pendingAndroidImeEnter.text) {
    cancelPendingAndroidImeEnter();
  }
  autosizeInput();
  saveDraft();
  if (!event.isComposing && !androidImeComposing) scheduleAndroidImeProbe();
});
els.input.addEventListener("keyup", (event) => {
  if (isAndroidImeClient() && isAndroidImeProcessKey(event)) finishAndroidImeProcessKey(event);
});
els.input.addEventListener("focus", () => scheduleAndroidImeProbe());
els.input.addEventListener("blur", () => {
  clearAndroidImeProcessKeyState();
  cancelPendingAndroidImeEnter();
  removeAndroidImeProbe();
});
els.input.addEventListener("pointerdown", () => {
  clearAndroidImeProcessKeyState();
  cancelPendingAndroidImeEnter();
  removeAndroidImeProbe();
});
els.input.addEventListener("pointerup", () => scheduleAndroidImeProbe());
els.input.addEventListener("select", () => {
  if (!isAndroidImeClient()) return;
  if (isAndroidImeProbeArmed()) return;
  removeAndroidImeProbe();
  if (els.input.selectionStart === els.input.selectionEnd) scheduleAndroidImeProbe();
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
  if (!els.projectUploadMenu?.hidden && !event.target.closest(".projectUploadPicker")) {
    closeProjectUploadMenu();
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
    !els.usagePanel.hidden &&
    !event.target.closest("#usagePanel") &&
    !event.target.closest("#usageRemote")
  ) {
    els.usagePanel.hidden = true;
  }
  if (
    !els.modelSettingsPanel.hidden &&
    !event.target.closest("#modelSettingsPanel") &&
    !event.target.closest("#modelSettingsRemote")
  ) {
    els.modelSettingsPanel.hidden = true;
    els.usagePanel.hidden = true;
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
    closeProjectUploadMenu();
    els.threadPanel.hidden = true;
    els.filePanel.hidden = true;
    els.sshConnectPanel.hidden = true;
    els.connectorPanel.hidden = true;
    els.modelSettingsPanel.hidden = true;
    els.queuePanel.hidden = true;
  }
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateVisualViewport);
  window.visualViewport.addEventListener("scroll", updateVisualViewport);
  updateVisualViewport();
}

els.filesButton.addEventListener("click", () => openFiles());
els.usageButton.addEventListener("click", () => {
  openUsagePanel().catch((error) => {
    els.usageContent.innerHTML = "";
    els.usageStatus.textContent = `读取失败：${error.message}`;
  });
});
els.closeUsage.addEventListener("click", () => {
  els.usagePanel.hidden = true;
});
els.modelSettingsButton.addEventListener("click", () => {
  openModelSettings().catch((error) => {
    els.modelSettingsStatus.textContent = `读取失败：${error.message}`;
  });
});
els.closeModelSettings.addEventListener("click", () => {
  els.modelSettingsPanel.hidden = true;
});
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
els.projectUploadButton.addEventListener("click", toggleProjectUploadMenu);
els.projectFilesButton.addEventListener("click", () => {
  closeProjectUploadMenu();
  els.projectFilesInput.value = "";
  els.projectFilesInput.click();
});
els.projectFolderButton.addEventListener("click", () => {
  closeProjectUploadMenu();
  els.projectFolderInput.value = "";
  els.projectFolderInput.click();
});
els.projectFilesInput.addEventListener("change", () => {
  uploadProjectItems([...els.projectFilesInput.files], "files");
});
els.projectFolderInput.addEventListener("change", () => {
  uploadProjectItems([...els.projectFolderInput.files], "folder");
});

els.closeFiles.addEventListener("click", () => {
  closeProjectUploadMenu();
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
    if (action === "download") downloadProjectItem(file, name, row.dataset.type || "file");
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
els.log.addEventListener("click", handleUserBubbleSpeechInteraction);
els.log.addEventListener("keydown", handleUserBubbleSpeechInteraction);
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
refreshNativeNotificationStatus().catch(() => {});
autosizeInput();
updateScrollJumps();
