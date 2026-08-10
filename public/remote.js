const state = {
  running: false,
  reconnecting: false,
  externalRunning: false,
  liveVoiceRunning: false,
  liveVoiceConnected: false,
  liveVoiceTaskRunning: false,
  externalTaskStartedAt: "",
  threadId: "",
  threadName: "",
  cwd: "",
  absoluteCwd: "",
  fileLinkRoots: [],
  fileCwd: "",
  newCwd: "",
  hideProjectDotFolders: false,
  hideNewSessionDotFolders: false,
  loadedCount: 0,
  messageCount: 0,
  loadingMore: false,
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
  eventDisconnected: false,
  lastEventSeq: 0,
  resyncingEvents: false,
  notifiedMessages: new Set(),
  currentTaskStartedAtMs: null,
  currentTaskDetail: "",
  currentTaskDetailKind: "",
  currentTaskDetailAtMs: null,
  pushSubscribed: false,
  nativeNotificationConnected: false,
  autoApprove: localStorage.getItem("codex-remote-auto-approve") === "1",
  autoSpeech: localStorage.getItem("codex-remote-auto-speech") === "1",
  spokenMessageIds: new Set(),
  speechUtterances: new Set(),
  hideThoughts: localStorage.getItem("codex-remote-hide-thoughts") === "1",
  onlyMine: localStorage.getItem("codex-remote-only-mine") === "1",
  showFullReplies: localStorage.getItem("codex-remote-show-full-replies") === "1",
  fullMessageCount: 0,
  completedUnreadThreads: new Set(),
  threadListCache: (() => {
    try {
      const cached = JSON.parse(localStorage.getItem("codex-remote-thread-list-cache") || "null");
      return Array.isArray(cached?.threads) ? cached : null;
    } catch {
      return null;
    }
  })(),
  model: "",
  reasoningEffort: "",
  modelSettingsUpdatedAt: "",
  modelOptions: [],
  localNotices: [],
  pendingApproval: null,
  pendingApprovalQueue: [],
  pendingApprovalSubmitting: false
};
const basePath = ["/codexremote", "/codex-remote"].find((path) => location.pathname === path || location.pathname.startsWith(`${path}/`)) || "";
const draftPrefix = "codex-remote-draft:";
let draftTimer = 0;
let modelSettingsChanging = false;
let stateLoadGeneration = 0;
let realtimeReconcileTimer = 0;
let taskExecutionStatusTimer = 0;
let taskInterruptPending = false;
const processedEventSeqs = new Set();
const pendingRemoteEvents = [];
const slashCommands = [
  { group: "Codex 命令", command: "/help", title: "帮助", detail: "显示当前已接入的 Codex 命令" },
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
  { command: "/autoapprove", title: "自动确认审核", detail: autoApprovalDetail, action: toggleAutoApproval, active: () => state.autoApprove },
  { command: "/tts", title: "自动语音朗读", detail: speechDetail, action: toggleAutoSpeech },
  { command: "/full", title: "显示Codex完整回复", detail: fullRepliesDetail, action: toggleFullReplies },
  { command: "/result", title: "只看结果", detail: () => state.hideThoughts ? "当前只显示用户气泡和 ✅ 气泡，点击后显示全部" : "隐藏思考过程气泡，只显示用户气泡和 ✅ 气泡", action: toggleResultOnly },
  { command: "/mine", title: "只看自己", detail: () => state.onlyMine ? "当前只显示自己发送的气泡，点击后显示全部" : "只显示自己发送的消息气泡", action: toggleOnlyMine },
  { command: "/stop", title: "中断", detail: "通过 turn/interrupt 中断当前回合" },
  { group: "Mem0 记忆技能", command: "$mem0:onboard", title: "初始化", detail: "新项目首次使用、更新 API Key 或重新配置时运行", execute: true },
  { command: "$mem0:health", title: "健康检查", detail: "连接、搜索或写入异常时诊断；可附加 --deep 检查记忆质量", execute: true },
  { command: "$mem0:remember", title: "记住内容", detail: "保存重要决定、偏好、规范或经验；输入框文字会作为记忆内容", execute: true },
  { command: "$mem0:peek", title: "快速搜索", detail: "按关键词或记忆 ID 快速查找；输入框文字会作为查询", execute: true },
  { command: "$mem0:tour", title: "浏览记忆", detail: "查看当前项目的全部记忆；可附加 --all-projects", execute: true },
  { command: "$mem0:stats", title: "记忆统计", detail: "查看数量、分类、时间分布和延迟；可附加 --weekly", execute: true },
  { command: "$mem0:list-projects", title: "项目列表", detail: "查看云端有哪些记忆项目、数量和最近活动", execute: true },
  { command: "$mem0:switch-project", title: "切换项目", detail: "覆盖当前目录的项目范围；输入项目名，或使用 --global / --no-global", execute: true },
  { command: "$mem0:pin", title: "固定记忆", detail: "保护关键记忆不被清理；输入关键词、记忆 ID 或 unpin 指令", execute: true },
  { command: "$mem0:forget", title: "删除记忆", detail: "查找并删除错误、过期或敏感记忆，实际删除前仍会确认", execute: true },
  { command: "$mem0:memory-reviewer", title: "质量审查", detail: "只读检查重复、矛盾和陈旧记忆，不会修改数据", execute: true },
  { command: "$mem0:dream", title: "整理记忆", detail: "合并重复、处理矛盾并清理陈旧记忆，应用前会显示差异并确认", execute: true },
  { command: "$mem0:export", title: "导出备份", detail: "把当前项目全部记忆导出为 Markdown 文件", execute: true },
  { command: "$mem0:import", title: "导入记忆", detail: "从 Mem0 导出文件或 MEMORY.md 恢复；输入框可填写文件路径", execute: true },
  { command: "$mem0:context-loader", title: "加载上下文", detail: "开始复杂任务或切换模块时，预先加载相关历史决定和规范", execute: true },
  { command: "$mem0:mem0", title: "SDK 帮助", detail: "编写 Python/TypeScript Mem0 API 集成代码时查看 SDK 用法", execute: true }
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
  usageContent: document.querySelector("#usageContent"),
  usageStatus: document.querySelector("#usageStatus"),
  modelSettingsButton: document.querySelector("#modelSettingsRemote"),
  modelSettingsPanel: document.querySelector("#modelSettingsPanel"),
  modelSettingsTitle: document.querySelector("#modelSettingsTitle"),
  modelUsageToggle: document.querySelector("#modelUsageToggle"),
  modelSettingsView: document.querySelector("#modelSettingsView"),
  modelUsageView: document.querySelector("#modelUsageView"),
  closeModelSettings: document.querySelector("#closeModelSettings"),
  modelSettingsCurrent: document.querySelector("#modelSettingsCurrent"),
  modelSettingsModels: document.querySelector("#modelSettingsModels"),
  modelSettingsEfforts: document.querySelector("#modelSettingsEfforts"),
  modelSettingsStatus: document.querySelector("#modelSettingsStatus"),
  onlyMineButton: document.querySelector("#onlyMineRemote"),
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
  projectDotFolderFilter: document.querySelector("#projectDotFolderFilter"),
  newChat: document.querySelector("#newRemote"),
  newPath: document.querySelector("#newPath"),
  newList: document.querySelector("#newList"),
  newDotFolderFilter: document.querySelector("#newDotFolderFilter"),
  createSession: document.querySelector("#createSessionRemote"),
  threadButton: document.querySelector("#threadRemote"),
  threadPanel: document.querySelector("#threadPanel"),
  threadPanelTitle: document.querySelector("#threadPanelTitle"),
  refreshThreads: document.querySelector("#refreshThreads"),
  toggleThreadView: document.querySelector("#toggleThreadView"),
  threadFilesToggle: document.querySelector("#threadFilesToggle"),
  threadExistingView: document.querySelector("#threadExistingView"),
  threadNewView: document.querySelector("#threadNewView"),
  threadFilesView: document.querySelector("#threadFilesView"),
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
  mode: document.querySelector("#remoteMode"),
  approvalModal: document.querySelector("#approvalModal"),
  approvalKind: document.querySelector("#approvalKind"),
  approvalTitle: document.querySelector("#approvalTitle"),
  approvalMeta: document.querySelector("#approvalMeta"),
  approvalBody: document.querySelector("#approvalBody"),
  approvalActions: document.querySelector("#approvalActions"),
  approvalStatus: document.querySelector("#approvalStatus")
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
  return `${state.threadId || state.cwd || "new"}\n${messagePart}`;
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
    els.statusIcon.className = "remoteStatusIcon status-running";
    els.statusIcon.title = state.externalRunning
      ? "Codex 正在处理，网页端可以引导、排队或中断"
      : state.liveVoiceRunning
        ? (state.liveVoiceConnected
            ? (state.liveVoiceTaskRunning ? "Live Voice 已连接，Codex 任务执行中" : "Live Voice 已连接")
            : (state.liveVoiceTaskRunning ? "Live Voice 已断线，Codex 任务仍在后台执行" : "Live Voice 已断线，等待自动重连"))
        : (state.reconnecting ? "Codex 正在重新连接，任务继续等待" : "Codex 正在处理");
  } else {
    els.statusIcon.className = "remoteStatusIcon status-idle";
    els.statusIcon.title = "Codex 空闲";
  }
}

function setRunning(running, queueLength = state.queueLength, queueMessages = state.queueMessages, followMode = state.followMode, steerLength = state.steerLength, steerMessages = state.steerMessages, contextUsage = state.contextUsage, runningThreads = state.runningThreads, reconnecting = false, externalRunning = false, liveVoiceRunning = state.liveVoiceRunning, liveVoiceConnected = state.liveVoiceConnected, liveVoiceTaskRunning = state.liveVoiceTaskRunning) {
  const wasRunning = state.running;
  state.running = Boolean(running);
  state.liveVoiceRunning = state.running && Boolean(liveVoiceRunning);
  state.liveVoiceConnected = state.liveVoiceRunning && Boolean(liveVoiceConnected);
  state.liveVoiceTaskRunning = state.liveVoiceRunning && Boolean(liveVoiceTaskRunning);
  state.externalRunning = state.running && !state.liveVoiceRunning && Boolean(externalRunning);
  state.reconnecting = state.running && !state.externalRunning && Boolean(reconnecting);
  state.queueLength = Number(queueLength) || 0;
  state.queueMessages = Array.isArray(queueMessages) ? queueMessages : [];
  state.runningThreads = Array.isArray(runningThreads) ? runningThreads : [];
  state.steerLength = Number(steerLength) || 0;
  state.steerMessages = Array.isArray(steerMessages) ? steerMessages : [];
  state.followMode = followMode === "steer" ? "steer" : "queue";
  setContextUsage(contextUsage);
  if (state.running) {
    state.replyDone = false;
    if (!Number.isFinite(state.currentTaskStartedAtMs)) {
      const externalStartedAtMs = state.externalTaskStartedAt ? Date.parse(state.externalTaskStartedAt) : NaN;
      state.currentTaskStartedAtMs = Number.isFinite(externalStartedAtMs) ? externalStartedAtMs : Date.now();
    }
    if (!wasRunning && !state.currentTaskDetail) {
      updateTaskExecutionDetail("正在连接 Codex，等待第一个执行事件", "connecting");
    }
  } else {
    state.currentTaskStartedAtMs = null;
    clearTaskExecutionDetail();
  }
  els.sendQueue.disabled = false;
  els.sendSteer.disabled = false;
  els.sendQueue.title = state.externalRunning ? "等当前 Codex 回合结束后继续执行" : "队列模式发送（备用）";
  els.sendSteer.title = state.externalRunning ? "引导当前 Codex 回合（默认，Ctrl+Enter）" : "引导模式发送（默认，Ctrl+Enter）";
  if (els.newChat) els.newChat.disabled = false;
  els.threadButton.disabled = false;
  updateMeta();
  renderQueuePanel();
  updateStatusIcon();
  syncTaskExecutionStatus();
  updateRealtimeReconcile();
  updateLoadMore();
}

function updateMeta() {
  const title = state.threadId ? (state.threadName || `会话 ${state.threadId.slice(0, 8)}`) : "新会话";
  const mode = state.followMode === "steer" ? "引导模式" : "队列模式";
  const percent = state.contextUsage ? Math.max(0, Math.min(100, Math.round(Number(state.contextUsage.remainingPercent)))) : null;
  const normalModeText = Number.isFinite(percent) ? `${mode} · 上下文 ${percent}%` : mode;
  const externalLabel = "Codex 正在处理 · 网页可引导或排队";
  const modeText = state.externalRunning
    ? externalLabel
    : state.liveVoiceRunning
      ? (state.liveVoiceConnected
          ? (state.liveVoiceTaskRunning
              ? "Live Voice 已连接 · Codex 任务执行中 · 网页可继续引导"
              : "Live Voice 已连接 · 网页输入会进入同一会话")
          : (state.liveVoiceTaskRunning
              ? "Live Voice 已断线 · 后台任务继续执行 · 等待重连"
              : "Live Voice 已断线 · 等待安卓自动重连"))
      : (state.reconnecting ? "Codex 正在重新连接 · 任务继续等待" : normalModeText);
  els.meta.textContent = title;
  els.meta.title = title;
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
          let leadContent = String(status[2] || "").trim();
          const leadHeading = leadContent.match(/^(#{1,6})[ 	]+(.+?)[ 	]*$/);
          if (leadHeading) {
            leadContent = leadHeading[2].replace(/[ 	]+#+[ 	]*$/, "");
          }
          html.push(`<div class="messageLead messageLead-${kind}"><span class="messageLeadIcon" aria-hidden="true">${icon}</span><span class="messageLeadText">${renderInlineMarkdown(leadContent)}</span></div>`);
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

function formatWorkingElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function approvalBelongsToCurrentThread(request = state.pendingApproval) {
  if (!request) return false;
  return !request.threadId || !state.threadId || request.threadId === state.threadId;
}

function taskExecutionLabel() {
  if (taskInterruptPending) return "Interrupting";
  if (approvalBelongsToCurrentThread()) return "Waiting for approval";
  if (state.reconnecting) return "Reconnecting";
  if (state.liveVoiceRunning && !state.liveVoiceTaskRunning) return "Live Voice connected";
  if (state.liveVoiceTaskRunning) return "Working via Live Voice";
  return "Working";
}

function compactTaskDetail(value = "", limit = 180) {
  const text = String(value || "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*```[^\n]*\n?/gm, "")
    .replace(/^\s*```\s*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[✅🤔❌⏳🧠📋🔧⌨️📝🔌🌐🖼️🎨⏱️🔍🤝↳•]\s*/u, "")
    .replace(/[|*_~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function updateTaskExecutionDetail(detail = "", kind = "activity") {
  const next = compactTaskDetail(detail);
  if (!next) return false;
  state.currentTaskDetail = next;
  state.currentTaskDetailKind = kind;
  state.currentTaskDetailAtMs = Date.now();
  renderTaskExecutionStatus();
  return true;
}

function clearTaskExecutionDetail() {
  state.currentTaskDetail = "";
  state.currentTaskDetailKind = "";
  state.currentTaskDetailAtMs = null;
}

function cliTaskDetail(data = {}) {
  const content = compactTaskDetail(data.content || "", 150);
  const kind = String(data.fullKind || "");
  if (kind === "reasoning") return { kind, detail: `正在分析：${content || "等待推理摘要"}` };
  if (kind === "plan") return { kind, detail: `正在规划：${content || "制定执行步骤"}` };
  if (kind === "patch") return { kind, detail: `正在修改代码：${content || "等待补丁内容"}` };
  if (kind === "mcp") return { kind, detail: `正在调用 MCP：${content || "等待工具进展"}` };
  if (kind === "tool-call") return { kind, detail: `正在调用工具：${content || "等待工具响应"}` };
  if (kind === "tool-output") return { kind, detail: `正在检查工具结果：${content || "处理命令输出"}` };
  if (kind === "collaboration") return { kind, detail: `正在处理协作事件：${content}` };
  if (kind === "system") return { kind, detail: `正在处理：${content}` };
  return { kind: kind || "activity", detail: content };
}

function approvalTaskDetail(request = state.pendingApproval) {
  if (!request) return "";
  const file = Array.isArray(request.files) ? request.files[0]?.path : "";
  const subject = request.command || file || request.summary || request.title || request.method || "需要用户确认";
  return `等待批准：${compactTaskDetail(subject, 140)}`;
}

function taskExecutionDetailText() {
  const detail = approvalBelongsToCurrentThread()
    ? approvalTaskDetail()
    : state.currentTaskDetail;
  if (!detail) return "等待 Codex 返回新进展";
  const updatedAtMs = Number(state.currentTaskDetailAtMs);
  const ageSeconds = Number.isFinite(updatedAtMs)
    ? Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000))
    : 0;
  return ageSeconds >= 15 ? `${detail}（最后更新 ${ageSeconds}s 前）` : detail;
}

function taskExecutionCanInterrupt() {
  return state.running
    && !approvalBelongsToCurrentThread()
    && (!state.liveVoiceRunning || state.liveVoiceTaskRunning);
}

function renderTaskExecutionStatus() {
  let status = els.log.querySelector(".taskExecutionStatus");
  if (!state.running) {
    status?.remove();
    return;
  }
  if (!status) {
    status = document.createElement("button");
    status.type = "button";
    status.className = "taskExecutionStatus";
    status.addEventListener("click", () => {
      if (taskExecutionCanInterrupt()) interruptCurrentTask();
    });
  }
  const startedAtMs = Number.isFinite(state.currentTaskStartedAtMs)
    ? state.currentTaskStartedAtMs
    : Date.now();
  const elapsed = formatWorkingElapsed(Date.now() - startedAtMs);
  const canInterrupt = taskExecutionCanInterrupt();
  const suffix = canInterrupt ? " • Esc to interrupt" : "";
  status.textContent = `• ${taskExecutionLabel()} (${elapsed}${suffix}) — ${taskExecutionDetailText()}`;
  status.disabled = !canInterrupt;
  status.setAttribute("aria-live", "polite");
  status.title = canInterrupt ? "点击或按 Esc 中断当前任务" : taskExecutionLabel();
  // Appending an existing node moves it after the newest bubble. This keeps
  // the status attached to the live end of the transcript as replies stream.
  els.log.appendChild(status);
}

function syncTaskExecutionStatus() {
  renderTaskExecutionStatus();
  if (!state.running) {
    if (taskExecutionStatusTimer) clearInterval(taskExecutionStatusTimer);
    taskExecutionStatusTimer = 0;
    return;
  }
  if (!taskExecutionStatusTimer) {
    taskExecutionStatusTimer = setInterval(renderTaskExecutionStatus, 1000);
  }
}

function appendMessage(role, text, meta = {}) {
  if (!text) return;
  const shouldFollow = isNearBottom();
  const isCompletion = role === "assistant" && /^✅\s/.test(text || "");
  const isLiveVoiceAssistant = role === "assistant" && Boolean(meta.liveVoiceTranscript);
  const wrapper = document.createElement("div");
  wrapper.className = `messageBlock ${role}Block${isCompletion ? " completionBlock" : ""}${isLiveVoiceAssistant ? " liveVoiceAssistantBlock" : ""}`;
  const item = document.createElement("div");
  item.className = `message ${role}${isCompletion ? " completion" : ""}${isLiveVoiceAssistant ? " liveVoiceAssistant" : ""}`;
  if (isLiveVoiceAssistant) item.dataset.liveVoiceTranscript = "true";
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
  renderTaskExecutionStatus();
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
  let content = String(message.content || "").trim();
  if (message.role === "assistant") {
    content = content.replace(/^[🤔✅]\s*/u, "");
  }
  return `${message.role || ""}\n${content}`;
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
    threadId: state.threadId || "",
    cwd: state.cwd || ""
  };
}

function sameNoticeContext(left = {}, right = localNoticeContext()) {
  return (left.threadId || "") === (right.threadId || "") &&
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

function executeSkillCommand(command) {
  const text = composerText().trim();
  if (text.startsWith("$mem0:")) {
    els.input.value = text.replace(/^\$mem0:\S+/, command);
  } else {
    els.input.value = text ? `${command} ${text}` : command;
  }
  saveDraft();
  closeCommandMenu();
  autosizeInput();
  sendMessage("steer");
}

function renderCommandList() {
  els.commandList.innerHTML = "";
  let currentGroup = "";
  for (const item of slashCommands) {
    if (item.group && item.group !== currentGroup) {
      currentGroup = item.group;
      const heading = document.createElement("div");
      heading.className = "commandGroup";
      heading.textContent = currentGroup;
      els.commandList.appendChild(heading);
    }
    const button = document.createElement("button");
    button.className = "commandItem";
    button.type = "button";
    const active = typeof item.active === "function" && item.active();
    button.classList.toggle("commandItemActive", active);
    if (item.active) button.setAttribute("aria-pressed", active ? "true" : "false");
    button.innerHTML = "<strong></strong><span></span><small></small>";
    button.querySelector("strong").textContent = item.command;
    button.querySelector("span").textContent = item.title;
    button.querySelector("small").textContent = typeof item.detail === "function" ? item.detail() : item.detail;
    button.addEventListener("click", () => {
      if (item.action) item.action();
      else if (item.execute) executeSkillCommand(item.command);
      else insertCommand(item.command);
    });
    els.commandList.appendChild(button);
  }
}

async function request(url, options = {}) {
  const finalOptions = { ...options };
  const response = await fetch(`${basePath}${url}`, {
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

async function loadState() {
  const generation = ++stateLoadGeneration;
  const stateUrl = state.showFullReplies ? "/api/remote/state?full=1" : "/api/remote/state";
  const data = await request(stateUrl);
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
  // Any direct state render (thread selection, SSE state event, pagination)
  // supersedes older /state requests that may still be in flight.
  stateLoadGeneration += 1;
  saveDraft();
  if (Array.isArray(data.pendingApprovals)) {
    syncApprovalRequests(data.pendingApprovals);
  }
  const shouldFollow = isNearBottom();
  const previousTop = els.logWrap.scrollTop;
  const previousThreadId = state.threadId;
  const nextThreadId = data.threadId || "";
  if (nextThreadId !== previousThreadId) {
    stopSpeech();
    clearTaskExecutionDetail();
  }
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
  const taskStartedAt = data.externalRunning ? state.externalTaskStartedAt : data.inflight?.startedAt;
  if (data.running && taskStartedAt) {
    const startedAtMs = Date.parse(taskStartedAt);
    if (Number.isFinite(startedAtMs)) state.currentTaskStartedAtMs = startedAtMs;
  }
  if (data.running && !state.currentTaskDetail) {
    const liveDetail = [...(data.liveMessages || [])].reverse()
      .find((message) => message?.role === "assistant" && message.content);
    const externalDetail = data.externalRunning
      ? [...(data.messages || [])].reverse()
          .find((message) => message?.role === "assistant" && /^🤔\s/u.test(message.content || ""))
      : null;
    const detailMessage = liveDetail || externalDetail;
    if (detailMessage) {
      updateTaskExecutionDetail(`正在分析：${compactTaskDetail(detailMessage.content, 150)}`, "reasoning");
    }
  }
  setRunning(
    data.running,
    data.queueLength,
    data.queueMessages,
    data.followMode,
    data.steerLength,
    data.steerMessages,
    data.contextUsage,
    data.runningThreads,
    data.reconnecting,
    data.externalRunning,
    Boolean(data.liveVoiceRunning),
    Boolean(data.liveVoiceConnected),
    Boolean(data.liveVoiceTaskRunning)
  );
  if (!els.modelSettingsPanel.hidden && !els.modelSettingsView.hidden && state.threadId !== previousThreadId) {
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

function setModelSettingsView(view = "model") {
  const showUsage = view === "usage";
  els.modelSettingsView.hidden = showUsage;
  els.modelUsageView.hidden = !showUsage;
  els.modelSettingsTitle.textContent = showUsage ? "使用量" : "模型与思考强度";
  els.modelUsageToggle.textContent = showUsage ? "模型与思考强度" : "使用量";
  els.modelUsageToggle.setAttribute("aria-pressed", String(showUsage));
}

async function openModelSettings() {
  const threadId = state.threadId;
  els.modelSettingsPanel.hidden = false;
  setModelSettingsView("model");
  els.threadPanel.hidden = true;
  els.modelSettingsCurrent.textContent = "正在读取当前会话...";
  els.modelSettingsModels.innerHTML = "";
  els.modelSettingsEfforts.innerHTML = "";
  els.modelSettingsStatus.textContent = "";
  const data = await request("/api/remote/model-settings");
  if (threadId !== state.threadId) return;
  renderModelSettings(data);
}

async function changeModelSettings(update = {}) {
  if (modelSettingsChanging) return;
  modelSettingsChanging = true;
  const threadId = state.threadId;
  els.modelSettingsStatus.textContent = "正在切换...";
  for (const button of els.modelSettingsPanel.querySelectorAll(".modelOption, .effortOption")) button.disabled = true;
  try {
    const data = await request("/api/remote/model-settings", {
      method: "POST",
      body: JSON.stringify(update)
    });
    if (threadId !== state.threadId) return;
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

async function openUsageInModelSettings() {
  els.modelSettingsPanel.hidden = false;
  setModelSettingsView("usage");
  els.threadPanel.hidden = true;
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
  els.loadMore.disabled = Boolean(state.loadingMore || state.running);
  els.loadMore.textContent = !hasMore
    ? "加载更多"
    : state.loadingMore
      ? `正在加载（${state.loadedCount}/${state.messageCount}）...`
      : state.running
        ? `任务完成后可加载（${state.loadedCount}/${state.messageCount}）`
        : `加载更多（${state.loadedCount}/${state.messageCount}）`;
}

async function loadMoreMessages() {
  if (!state.threadId || state.running || state.loadingMore) return;
  const threadId = state.threadId;
  const previousHeight = els.logWrap.scrollHeight;
  state.loadingMore = true;
  updateLoadMore();
  try {
    const data = await request("/api/remote/more", {
      method: "POST",
      body: JSON.stringify({ threadId })
    });
    if (threadId !== state.threadId) return;
    renderState(data);
    els.logWrap.scrollTop = Math.max(0, els.logWrap.scrollHeight - previousHeight);
    updateScrollJumps();
  } finally {
    state.loadingMore = false;
    updateLoadMore();
  }
}

function threadSubtitle(thread, isActive = false) {
  const date = thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : "";
  const status = thread.externalRunning
    ? "Codex Desktop/CLI 运行中 · 只读同步"
    : thread.liveVoiceRunning
      ? (thread.liveVoiceConnected
          ? (thread.liveVoiceTaskRunning ? "Live Voice 已连接 · 任务执行中" : "Live Voice 已连接")
          : (thread.liveVoiceTaskRunning ? "Live Voice 已断线 · 后台任务执行中" : "Live Voice 等待重连"))
      : (thread.running ? `运行中${thread.queueLength ? ` · 队列 ${thread.queueLength}` : ""}` : "");
  const count = thread.messageCount !== null
    && thread.messageCount !== undefined
    && Number.isFinite(Number(thread.messageCount))
    ? `${Number(thread.messageCount)} 条`
    : "";
  return [isActive ? "当前会话" : "", status, date, count].filter(Boolean).join(" · ");
}

function fileIcon(item) {
  if (item.type === "dir") return "📁";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(item.name)) return "🖼️";
  return "📄";
}

function displayProjectPath(cwd = "", absoluteCwd = "") {
  return absoluteCwd || (cwd ? `/${cwd}` : "项目根目录");
}

function isDotFolder(item = {}) {
  return item.type === "dir" && String(item.name || "").startsWith(".");
}

function applyDotFolderFilter(list, button, hideDotFolders = false) {
  const hidden = Boolean(hideDotFolders);
  button.textContent = `筛选：${hidden ? "开" : "关"}`;
  button.setAttribute("aria-pressed", String(hidden));
  button.title = hidden ? "当前隐藏以 . 开头的文件夹" : "当前显示以 . 开头的文件夹";
  for (const row of list.querySelectorAll('[data-dot-folder="true"]')) {
    row.hidden = hidden;
  }
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
  const form = new FormData();
  files.forEach((file, index) => {
    form.append("files", file, projectUploadRelativePath(file, index));
  });
  const params = new URLSearchParams({ dir: cwd });
  const buttons = [els.projectUploadButton, els.projectFilesButton, els.projectFolderButton].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  setProjectUploadStatus(`正在上传 ${files.length} 个文件（${formatSize(totalBytes)}）…`);
  try {
    const data = await sendProjectUploadRequest(
      `${basePath}/api/remote/project-upload?${params.toString()}`,
      form,
      (percent) => setProjectUploadStatus(`正在上传 ${files.length} 个文件（${formatSize(totalBytes)}）… ${percent}%`)
    );
    if (cwd === state.fileCwd) {
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
  return `${basePath}/api/remote/project-download?${params.toString()}`;
}

function downloadProjectItem(file = "", name = "", type = "file") {
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
  els.modelSettingsPanel.hidden = true;
  els.threadPanel.hidden = false;
  els.threadButton.setAttribute("aria-expanded", "true");
  setThreadView("files");
  els.filePreview.hidden = true;
  els.fileList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  try {
    const data = await request(`/api/remote/files?dir=${encodeURIComponent(dir)}`);
    state.fileCwd = data.cwd || "";
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
      row.className = "fileItem fileItemWithActions";
      row.role = "button";
      row.tabIndex = 0;
      row.dataset.type = item.type;
      row.dataset.path = item.path;
      row.dataset.name = item.name;
      row.dataset.dotFolder = String(isDotFolder(item));
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
    applyDotFolderFilter(els.fileList, els.projectDotFolderFilter, state.hideProjectDotFolders);
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
      row.dataset.dotFolder = String(isDotFolder(item));
      row.innerHTML = '<span></span><strong></strong><small></small>';
      row.querySelector("span").textContent = "📁";
      row.querySelector("strong").textContent = item.name;
      row.querySelector("small").textContent = "文件夹";
      els.newList.appendChild(row);
    }
    applyDotFolderFilter(els.newList, els.newDotFolderFilter, state.hideNewSessionDotFolders);
  } catch (error) {
    els.newList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
  }
}

async function createSessionInSelectedFolder() {
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
  try {
    const data = await request(`/api/remote/file?path=${encodeURIComponent(file)}`);
    if (data.type === "image") {
      els.filePreview.innerHTML = `<div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><button type="button" data-download-project-file>下载</button></div><img src="${basePath}${data.url}" alt="${escapeHtml(data.path)}">`;
    } else {
      els.filePreview.innerHTML = `
        <div class="filePreviewTop"><strong>${escapeHtml(data.path)}</strong><div class="panelActions"><button type="button" data-save-project-file>保存</button><button type="button" data-download-project-file>下载</button></div></div>
        <div class="projectEditor"><textarea id="projectEditorText" spellcheck="false">${escapeHtml(data.text)}</textarea></div>
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

let threadListRequestGeneration = 0;

async function openThreads({ load = true } = {}) {
  els.modelSettingsPanel.hidden = true;
  const requestGeneration = ++threadListRequestGeneration;
  els.threadPanel.hidden = false;
  setThreadView("existing");
  if (load) {
    els.threadList.innerHTML = '<div class="remoteEvent">加载中...</div>';
  }
  try {
    const data = load ? await request("/api/remote/threads") : state.threadListCache;
    if (requestGeneration !== threadListRequestGeneration) return;
    if (!data) return;
    if (load) {
      state.threadListCache = data;
      try {
        localStorage.setItem("codex-remote-thread-list-cache", JSON.stringify(data));
      } catch {}
    }
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
    if (requestGeneration !== threadListRequestGeneration) return;
    els.threadList.innerHTML = "";
    els.threadList.innerHTML = `<div class="remoteEvent">错误：${error.message}</div>`;
  }
}

function toggleThreadPanel(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!els.threadPanel.hidden) {
    els.threadPanel.hidden = true;
    els.threadButton.setAttribute("aria-expanded", "false");
    return;
  }
  // Reveal the panel synchronously so mobile WebViews cannot close it again
  // while the same SVG-button click is still bubbling to the document.
  els.threadPanel.hidden = false;
  els.threadButton.setAttribute("aria-expanded", "true");
  openThreads({ load: false }).catch((error) => {
    els.threadList.innerHTML = `<div class="remoteEvent">错误：${escapeHtml(error.message || "无法读取会话")}</div>`;
  });
}

function setThreadView(view = "existing") {
  const showNew = view === "new";
  const showFiles = view === "files";
  els.threadExistingView.hidden = showNew || showFiles;
  els.threadNewView.hidden = !showNew;
  els.threadFilesView.hidden = !showFiles;
  els.threadPanel.classList.toggle("filesView", showFiles);
  els.threadPanelTitle.textContent = showFiles ? "项目文件夹" : (showNew ? "新建会话" : "选择已有会话");
  els.refreshThreads.hidden = showNew || showFiles;
  els.toggleThreadView.textContent = showNew ? "选择已有会话" : "新建会话";
  els.threadFilesToggle.textContent = showFiles ? "选择已有会话" : "项目文件夹";
  els.threadFilesToggle.setAttribute("aria-pressed", String(showFiles));
  if (!showFiles) closeProjectUploadMenu();
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
  if (state.threadListCache?.threads) {
    const cached = state.threadListCache.threads.find((item) => item.threadId === thread.threadId);
    if (cached) {
      cached.name = data.name || "";
      cached.title = data.title || cached.title;
    }
    try { localStorage.setItem("codex-remote-thread-list-cache", JSON.stringify(state.threadListCache)); } catch {}
    openThreads({ load: false });
  }
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
  if (state.threadListCache?.threads) {
    state.threadListCache.threads = state.threadListCache.threads.filter((item) => item.threadId !== thread.threadId);
    try { localStorage.setItem("codex-remote-thread-list-cache", JSON.stringify(state.threadListCache)); } catch {}
    openThreads({ load: false });
  }
}

async function selectThread(threadId) {
  const data = await request("/api/remote/select", {
    method: "POST",
    body: JSON.stringify({ threadId })
  });
  state.completedUnreadThreads.delete(threadId);
  if (state.showFullReplies) await loadState();
  else renderState(data);
  els.threadPanel.hidden = true;
}

let externalSessionRefreshTimer = null;

function scheduleExternalSessionRefresh() {
  clearTimeout(externalSessionRefreshTimer);
  externalSessionRefreshTimer = setTimeout(() => {
    loadState().catch((error) => console.warn("外部 Codex 会话刷新失败", error));
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
  if (settingsChanged && !els.modelSettingsPanel.hidden && !els.modelSettingsView.hidden) {
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

function approvalKindLabel(kind = "") {
  return ({
    command: "命令",
    file: "文件",
    permission: "权限",
    input: "输入",
    elicitation: "表单",
    tool: "工具",
    guardian: "安全",
    approval: "确认"
  })[kind] || "确认";
}

function approvalRequestKey(request = {}) {
  return `${request.approvalScope || ""}:${request.requestId || ""}`;
}

function syncApprovalRequests(requests = []) {
  const snapshot = new Map(
    requests
      .filter((request) => request?.requestId)
      .map((request) => [approvalRequestKey(request), request])
  );
  // A state request can briefly see no app-server approvals while Android is
  // restoring the page or the shared app-server transport is reconnecting.
  // Treat snapshots as recovery/update data, not as resolution tombstones.
  // Only an explicit approval_resolved event, a successful submission, or a
  // server 404 is allowed to dismiss a popup the user has not acted on.
  state.pendingApprovalQueue = state.pendingApprovalQueue
    .map((request) => snapshot.get(approvalRequestKey(request)) || request);
  if (state.pendingApproval) {
    const currentKey = approvalRequestKey(state.pendingApproval);
    if (snapshot.has(currentKey)) {
      state.pendingApproval = snapshot.get(currentKey);
      renderApprovalModal(state.pendingApproval);
    }
  }
  for (const request of snapshot.values()) queueApprovalRequest(request);
  showNextApproval();
}

function queueApprovalRequest(request = {}) {
  if (!request?.requestId) return;
  const key = approvalRequestKey(request);
  const alreadyQueued = state.pendingApprovalQueue.some((item) => approvalRequestKey(item) === key)
    || (state.pendingApproval && approvalRequestKey(state.pendingApproval) === key);
  if (alreadyQueued) return;
  state.pendingApprovalQueue.push(request);
  showNextApproval();
}

function automaticElicitationContent(request = {}) {
  const schema = request.schema && typeof request.schema === "object" ? request.schema : {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const content = {};
  for (const [name, propValue] of Object.entries(properties)) {
    const prop = propValue && typeof propValue === "object" ? propValue : {};
    if (Object.prototype.hasOwnProperty.call(prop, "default")) {
      content[name] = prop.default;
    } else if (prop.type === "boolean") {
      content[name] = false;
    } else if (Array.isArray(prop.enum) && prop.enum.length) {
      content[name] = prop.enum[0];
    } else if (required.has(name)) {
      return null;
    }
  }
  return content;
}

function automaticApprovalSubmission(request = {}) {
  if (request.kind === "input") return null;
  if (request.kind === "elicitation") {
    const content = automaticElicitationContent(request);
    return content === null ? null : { decision: "accept", payload: { content } };
  }
  return {
    decision: request.kind === "tool" ? "allow" : "accept",
    payload: {}
  };
}

function autoApprovalDetail() {
  return state.autoApprove
    ? "已开启：自动允许审核及可使用默认值的 MCP 表单，并暂停发送审核通知；缺少必填内容时仍会弹窗"
    : "已关闭。点击开启后将自动允许审核请求和可安全补全的 MCP 表单（高风险）";
}

async function syncAutoApprovalNotificationPreference() {
  return await request("/api/remote/notifications/approval-preference", {
    method: "POST",
    body: JSON.stringify({ autoApprove: state.autoApprove })
  });
}

function toggleAutoApproval() {
  state.autoApprove = !state.autoApprove;
  localStorage.setItem("codex-remote-auto-approve", state.autoApprove ? "1" : "0");
  closeCommandMenu();
  appendEvent(state.autoApprove ? "自动确认审核已开启" : "自动确认审核已关闭");
  renderCommandList();
  syncAutoApprovalNotificationPreference().catch((error) => {
    appendEvent(`同步审核通知设置失败：${error.message}`);
  });
  if (!state.autoApprove || !state.pendingApproval || state.pendingApprovalSubmitting) return;
  const submission = automaticApprovalSubmission(state.pendingApproval);
  if (!submission) return;
  if (els.approvalModal) els.approvalModal.hidden = true;
  submitApproval(submission.decision, submission.payload, { automatic: true });
}

function showNextApproval() {
  if (state.pendingApproval || state.pendingApprovalSubmitting || !els.approvalModal) return;
  const next = state.pendingApprovalQueue.shift();
  if (!next) return;
  state.pendingApproval = next;
  updateTaskExecutionDetail(approvalTaskDetail(next), "approval");
  renderTaskExecutionStatus();
  const automaticSubmission = state.autoApprove ? automaticApprovalSubmission(next) : null;
  if (automaticSubmission) {
    if (els.approvalModal) els.approvalModal.hidden = true;
    submitApproval(automaticSubmission.decision, automaticSubmission.payload, { automatic: true });
    return;
  }
  renderApprovalModal(next);
  els.approvalModal.hidden = false;
  requestAnimationFrame(() => {
    const primary = els.approvalActions.querySelector(".approvalPrimary");
    primary?.focus();
  });
}

function clearApprovalModal() {
  state.pendingApproval = null;
  state.pendingApprovalSubmitting = false;
  if (els.approvalModal) els.approvalModal.hidden = true;
  renderTaskExecutionStatus();
}

function resolveApprovalRequest(requestId = "", approvalScope = "") {
  const key = approvalRequestKey({ requestId, approvalScope });
  state.pendingApprovalQueue = state.pendingApprovalQueue.filter((item) => approvalRequestKey(item) !== key);
  if (state.pendingApproval && approvalRequestKey(state.pendingApproval) === key) {
    clearApprovalModal();
  }
  showNextApproval();
}

function approvalBodyHtml(request = {}) {
  const sections = [];
  const addSection = (label, html) => {
    sections.push(`<section class="approvalSection"><div class="approvalLabel">${escapeHtml(label)}</div>${html}</section>`);
  };
  if (request.summary) addSection("请求内容", `<div class="approvalSummary">${escapeHtml(request.summary)}</div>`);
  if (request.reason) addSection("原因", `<div class="approvalSummary">${escapeHtml(request.reason)}</div>`);
  if (request.cwd) addSection("目录", `<div class="approvalSummary">${escapeHtml(request.cwd)}</div>`);
  if (request.command) addSection("命令", `<pre class="approvalCode">${escapeHtml(request.command)}</pre>`);
  if (Array.isArray(request.files) && request.files.length) {
    addSection("文件", request.files.map((file) => `
      <div class="approvalFile">
        <strong title="${escapeHtml(file.path || "")}">${escapeHtml(file.path || "")}</strong>
        <small>${escapeHtml(file.type || "")}</small>
        ${file.detail ? `<pre class="approvalDiff">${escapeHtml(file.detail)}</pre>` : ""}
      </div>
    `).join(""));
  }
  if (request.permissions) addSection("权限", permissionSummaryHtml(request.permissions));
  if (Array.isArray(request.questions) && request.questions.length) {
    addSection("问题", request.questions.map((question, index) => approvalQuestionHtml(question, index)).join(""));
  }
  if (request.message) addSection("消息", `<div class="approvalSummary">${escapeHtml(request.message)}</div>`);
  if (request.schema && typeof request.schema === "object") {
    addSection("表单", elicitationFieldsHtml(request.schema));
  }
  if (request.tool) addSection("工具", `<div class="approvalSummary">${escapeHtml(request.tool)}</div>`);
  if (request.arguments !== null && request.arguments !== undefined) {
    addSection("参数", `<pre class="approvalJson">${escapeHtml(JSON.stringify(request.arguments, null, 2))}</pre>`);
  }
  if (request.event) addSection("拦截详情", `<pre class="approvalJson">${escapeHtml(JSON.stringify(request.event, null, 2))}</pre>`);
  return sections.join("");
}

function permissionSummaryHtml(permissions = {}) {
  const rows = [];
  const fileSystem = permissions.fileSystem;
  if (fileSystem) {
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : [];
    const read = Array.isArray(fileSystem.read) ? fileSystem.read : [];
    const write = Array.isArray(fileSystem.write) ? fileSystem.write : [];
    const parts = [];
    for (const entry of entries) parts.push(`${entry.access || ""} ${pathPermissionLabel(entry.path || "")}`);
    for (const item of read) parts.push(`读 ${item}`);
    for (const item of write) parts.push(`写 ${item}`);
    rows.push(`<div>文件系统：${escapeHtml(parts.join("，") || "请求文件系统权限")}</div>`);
  }
  if (permissions.network) {
    rows.push(`<div>网络：${escapeHtml(permissions.network.enabled ? "启用网络" : "受限网络")}</div>`);
  }
  return rows.join("") || "<div>未请求额外权限</div>";
}

function pathPermissionLabel(value = "") {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.path || value.pattern || value.value || "";
  return "";
}

function approvalQuestionHtml(question = {}, index = 0) {
  const questionId = question.id || `question-${index}`;
  const options = Array.isArray(question.options) ? question.options : [];
  const optionName = `approval-question-${questionId}`;
  const optionsHtml = options.map((option, optionIndex) => `
    <label class="approvalOption">
      <input type="${question.isOther ? "checkbox" : "radio"}" name="${escapeHtml(optionName)}" value="${escapeHtml(option.label || option.description || String(optionIndex))}" ${optionIndex === 0 && !question.isOther ? "checked" : ""}>
      <span>${escapeHtml(option.label || "")}${option.description ? ` <small>${escapeHtml(option.description)}</small>` : ""}</span>
    </label>
  `).join("");
  const inputHtml = question.isSecret
    ? `<input class="approvalInput" data-approval-question="${escapeHtml(questionId)}" type="password" placeholder="输入回答">`
    : `<textarea class="approvalTextarea" data-approval-question="${escapeHtml(questionId)}" placeholder="输入回答"></textarea>`;
  return `
    <div class="approvalQuestion" data-question-id="${escapeHtml(questionId)}">
      <strong>${escapeHtml(question.header || question.question || `问题 ${index + 1}`)}</strong>
      ${question.question ? `<p>${escapeHtml(question.question)}</p>` : ""}
      ${optionsHtml || inputHtml}
    </div>
  `;
}

function elicitationFieldsHtml(schema = {}) {
  const properties = schema.properties || {};
  return Object.entries(properties).map(([name, prop]) => {
    const label = prop?.title || name;
    const description = prop?.description || "";
    let control = "";
    if (prop?.type === "boolean") {
      control = `<label class="approvalOption"><input class="approvalInput" data-elicitation-field="${escapeHtml(name)}" type="checkbox" ${prop.default ? "checked" : ""}><span>${escapeHtml(prop.default ? "默认开启" : "默认关闭")}</span></label>`;
    } else if (Array.isArray(prop?.enum)) {
      control = `<select class="approvalSelect" data-elicitation-field="${escapeHtml(name)}">${prop.enum.map((option) => `<option value="${escapeHtml(option)}" ${prop.default === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
    } else {
      control = `<input class="approvalInput" data-elicitation-field="${escapeHtml(name)}" value="${escapeHtml(prop?.default ?? "")}" placeholder="${escapeHtml(prop?.format || "")}">`;
    }
    return `<div class="approvalQuestion"><strong>${escapeHtml(label)}</strong>${description ? `<p>${escapeHtml(description)}</p>` : ""}${control}</div>`;
  }).join("");
}

function renderApprovalModal(request = {}) {
  if (!els.approvalKind || !els.approvalTitle) return;
  const kindLabel = approvalKindLabel(request.kind);
  els.approvalKind.textContent = kindLabel;
  els.approvalTitle.textContent = request.title || `${kindLabel}确认`;
  els.approvalMeta.textContent = [request.threadId, request.turnId, request.method].filter(Boolean).join(" · ");
  els.approvalBody.innerHTML = approvalBodyHtml(request);
  renderApprovalActions(request);
  els.approvalStatus.textContent = "";
}

function approvalButton(label = "", decision = "", options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (options.primary) button.classList.add("approvalPrimary", "primary");
  if (options.danger) button.classList.add("danger");
  if (options.wide) button.classList.add("approvalActionWide");
  button.addEventListener("click", () => {
    if (decision === "submit") submitApprovalFromModal();
    else submitApproval(decision);
  });
  return button;
}

function renderApprovalActions(request = {}) {
  if (!els.approvalActions) return;
  els.approvalActions.innerHTML = "";
  const actions = [];
  if (request.kind === "command" || request.kind === "file") {
    actions.push(approvalButton("允许", "accept", { primary: true }));
    if (request.canAcceptForSession !== false) actions.push(approvalButton("本次会话允许", "acceptForSession"));
    actions.push(approvalButton("拒绝继续", "decline", { danger: true }));
    actions.push(approvalButton("拒绝并中断", "cancel", { danger: true, wide: true }));
  } else if (request.kind === "permission") {
    actions.push(approvalButton("允许本次", "accept", { primary: true }));
    actions.push(approvalButton("本次会话允许", "acceptForSession"));
    actions.push(approvalButton("拒绝", "decline", { danger: true }));
  } else if (request.kind === "input") {
    actions.push(approvalButton("提交回答", "submit", { primary: true }));
    actions.push(approvalButton("取消", "cancel", { danger: true }));
  } else if (request.kind === "elicitation") {
    actions.push(approvalButton("接受", "submit", { primary: true }));
    actions.push(approvalButton("拒绝", "decline", { danger: true }));
    actions.push(approvalButton("取消", "cancel", { danger: true }));
  } else if (request.kind === "tool") {
    actions.push(approvalButton("允许调用", "allow", { primary: true }));
    actions.push(approvalButton("拒绝", "decline", { danger: true }));
    actions.push(approvalButton("取消", "cancel", { danger: true, wide: true }));
  } else if (request.kind === "guardian") {
    actions.push(approvalButton("批准操作", "accept", { primary: true }));
    actions.push(approvalButton("拒绝", "decline", { danger: true }));
  } else {
    actions.push(approvalButton("允许", "accept", { primary: true }));
    actions.push(approvalButton("拒绝", "decline", { danger: true }));
  }
  for (const action of actions) els.approvalActions.appendChild(action);
}

function setApprovalStatus(message = "") {
  if (els.approvalStatus) els.approvalStatus.textContent = message;
}

function setApprovalButtonsDisabled(disabled = false) {
  for (const button of els.approvalActions?.querySelectorAll("button") || []) {
    button.disabled = disabled;
  }
}

async function submitApproval(decision = "", payload = {}, options = {}) {
  if (!state.pendingApproval || state.pendingApprovalSubmitting) return;
  state.pendingApprovalSubmitting = true;
  setApprovalStatus(options.automatic ? "正在自动确认..." : "正在提交确认...");
  setApprovalButtonsDisabled(true);
  try {
    await request("/api/remote/approval/respond", {
      method: "POST",
      body: JSON.stringify({
        requestId: state.pendingApproval.requestId,
        approvalScope: state.pendingApproval.approvalScope || "",
        threadId: state.pendingApproval.threadId || "",
        turnId: state.pendingApproval.turnId || "",
        method: state.pendingApproval.method || "",
        decision,
        ...payload
      })
    });
    const completedApproval = state.pendingApproval;
    state.pendingApprovalQueue = state.pendingApprovalQueue.filter((item) => approvalRequestKey(item) !== approvalRequestKey(completedApproval));
    clearApprovalModal();
    showNextApproval();
  } catch (error) {
    if (/审批请求不存在或已处理/.test(String(error?.message || ""))) {
      const expiredApproval = state.pendingApproval;
      resolveApprovalRequest(expiredApproval?.requestId, expiredApproval?.approvalScope);
      loadState("").catch(() => {});
      return;
    }
    state.pendingApprovalSubmitting = false;
    if (options.automatic && els.approvalModal) {
      renderApprovalModal(state.pendingApproval);
      els.approvalModal.hidden = false;
    }
    setApprovalStatus(options.automatic ? `自动确认失败：${error.message || "请手动处理。"}` : (error.message || "提交失败。"));
    setApprovalButtonsDisabled(false);
  }
}

function submitApprovalFromModal() {
  const request = state.pendingApproval;
  if (!request) return;
  const payload = {};
  if (request.kind === "input") {
    const answers = {};
    for (const root of els.approvalBody.querySelectorAll("[data-question-id]")) {
      const questionId = root.dataset.questionId;
      const selected = [...root.querySelectorAll(`input[name="${CSS.escape(`approval-question-${questionId}`)}"]:checked`)].map((input) => input.value);
      if (selected.length) {
        answers[questionId] = { answers: selected };
        continue;
      }
      const field = root.querySelector("[data-approval-question]");
      if (field && String(field.value || "").trim()) {
        answers[questionId] = { answers: [field.value.trim()] };
      }
    }
    payload.answers = answers;
    if (!Object.keys(answers).length) {
      setApprovalStatus("请至少填写一个回答。");
      return;
    }
  }
  if (request.kind === "elicitation") {
    const content = {};
    for (const field of els.approvalBody.querySelectorAll("[data-elicitation-field]")) {
      const name = field.dataset.elicitationField;
      if (field.type === "checkbox") content[name] = field.checked;
      else content[name] = field.value;
    }
    payload.content = content;
    const required = Array.isArray(request.schema?.required) ? request.schema.required : [];
    const missing = required.filter((name) => {
      const value = content[name];
      return value === undefined || value === null || String(value).trim() === "";
    });
    if (missing.length) {
      setApprovalStatus(`请填写必填项：${missing.join("、")}`);
      return;
    }
  }
  submitApproval("accept", payload);
}

function handleRemoteEvent(data) {
  if (!rememberRemoteEvent(data)) return;
  if (data.type === "approval_request") { queueApprovalRequest(data); return; }
  if (data.type === "approval_resolved") { resolveApprovalRequest(data.requestId, data.approvalScope); return; }
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
      data.externalRunning,
      false,
      false,
      false
    );
    scheduleExternalSessionRefresh("");
    return;
  }
  if (data.type === "status") {
    setRunning(
      data.running,
      data.queueLength,
      data.queueMessages,
      data.followMode,
      data.steerLength,
      data.steerMessages,
      data.contextUsage,
      data.runningThreads,
      data.reconnecting,
      data.externalRunning,
      Boolean(data.liveVoiceRunning),
      Boolean(data.liveVoiceConnected),
      Boolean(data.liveVoiceTaskRunning)
    );
  }
  if (data.type === "reconnecting") {
    state.reconnecting = Boolean(data.reconnecting);
    if (data.reconnecting) {
      updateTaskExecutionDetail(`连接异常：${compactTaskDetail(data.message || "等待 Codex 重新连接", 140)}`, "reconnecting");
    }
    updateMeta();
    updateStatusIcon();
    renderTaskExecutionStatus();
  }
  if (data.type === "runner_status") {
    state.runningThreads = Array.isArray(data.runningThreads) ? data.runningThreads : [];
  }
  if (data.type === "message") {
    if (data.role === "assistant" && (data.transient || data.final)) {
      if (state.running && (data.transient || !/^✅\s/u.test(data.content || ""))) {
        updateTaskExecutionDetail(`正在分析：${compactTaskDetail(data.content || "", 150)}`, "reasoning");
      }
      if (data.final && /^✅\s/.test(data.content || "") && data.taskDurationMs === undefined && state.currentTaskStartedAtMs) {
        data.taskDurationMs = Math.max(0, Date.now() - state.currentTaskStartedAtMs);
      }
      upsertAssistantMessage(data.content, data.final, data.messageId || "assistant", data);
      if (data.final && !data.liveVoiceTranscript) speakCompletedAssistantMessage(data);
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
    if (state.running && data.role === "assistant") {
      const activity = cliTaskDetail(data);
      if (activity.detail) updateTaskExecutionDetail(activity.detail, activity.kind);
    }
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
  }
  if (data.type === "thread_completion" && data.threadId) {
    if (data.completedUnread) state.completedUnreadThreads.add(data.threadId);
    else state.completedUnreadThreads.delete(data.threadId);
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
      loadState("").catch((error) => console.warn("读取 Codex 完整回复失败", error));
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
  const message = composerText().trim();
  if (!message && !state.uploads.length) return;
  const outgoingMessage = messageWithUploads(message);
  const sendMode = mode === "steer" ? "steer" : "queue";
  const stateBeforeSend = {
    running: state.running,
    externalRunning: state.externalRunning,
    liveVoiceRunning: state.liveVoiceRunning,
    liveVoiceConnected: state.liveVoiceConnected,
    liveVoiceTaskRunning: state.liveVoiceTaskRunning,
    reconnecting: state.reconnecting
  };
  els.input.value = "";
  clearDraft();
  autosizeInput();
  scheduleAndroidImeProbe();
  state.replyDone = false;
  state.currentTaskStartedAtMs = Date.now();
  clearTaskExecutionDetail();
  updateTaskExecutionDetail("正在将任务发送给 Codex", "connecting");
  const followMatch = outgoingMessage.trim().toLowerCase().match(/^\/follow\s+(queue|steer)$/);
  setRunning(true, state.queueLength, state.queueMessages, followMatch ? followMatch[1] : state.followMode, state.steerLength, state.steerMessages, state.contextUsage, state.runningThreads, false, state.externalRunning);
  try {
    const result = await request("/api/remote/send", {
      method: "POST",
      body: JSON.stringify({ message: outgoingMessage, followMode: sendMode })
    });
    state.uploads = [];
    renderUploadList();
    if (result?.local || result?.liveVoice) {
      setRunning(
        result.running,
        result.queueLength,
        result.queueMessages,
        result.followMode,
        result.steerLength,
        result.steerMessages,
        result.contextUsage,
        result.runningThreads,
        result.reconnecting,
        result.externalRunning,
        Boolean(result.liveVoiceRunning),
        Boolean(result.liveVoiceConnected),
        Boolean(result.liveVoiceTaskRunning)
      );
    }
    if ((result?.queued || result?.steered) && !result?.liveVoice) {
      setRunning(true, result.queueLength, result.queueMessages, result.followMode, result.steerLength, result.steerMessages, result.contextUsage, result.runningThreads, result.reconnecting, result.externalRunning);
    }
  } catch (error) {
    upsertAssistantMessage(`错误：${error.message}`, true);
    setRunning(
      stateBeforeSend.running,
      0,
      [],
      state.followMode,
      0,
      [],
      state.contextUsage,
      state.runningThreads,
      stateBeforeSend.reconnecting,
      stateBeforeSend.externalRunning,
      stateBeforeSend.liveVoiceRunning,
      stateBeforeSend.liveVoiceConnected,
      stateBeforeSend.liveVoiceTaskRunning
    );
  }
}

async function interruptCurrentTask() {
  if (!taskExecutionCanInterrupt() || taskInterruptPending) return false;
  taskInterruptPending = true;
  renderTaskExecutionStatus();
  try {
    const result = await request("/api/remote/send", {
      method: "POST",
      body: JSON.stringify({ message: "/stop", followMode: "steer" })
    });
    setRunning(
      result.running,
      result.queueLength,
      result.queueMessages,
      result.followMode,
      result.steerLength,
      result.steerMessages,
      result.contextUsage,
      result.runningThreads,
      result.reconnecting,
      result.externalRunning,
      Boolean(result.liveVoiceRunning),
      Boolean(result.liveVoiceConnected),
      Boolean(result.liveVoiceTaskRunning)
    );
    return true;
  } catch (error) {
    upsertAssistantMessage(`中断失败：${error.message}`, true, `interrupt-error-${Date.now()}`);
    return false;
  } finally {
    taskInterruptPending = false;
    renderTaskExecutionStatus();
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
    !els.modelSettingsPanel.hidden &&
    !event.target.closest("#modelSettingsPanel") &&
    !event.target.closest("#modelSettingsRemote")
  ) {
    els.modelSettingsPanel.hidden = true;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const dismissedOverlay = !els.threadPanel.hidden
      || !els.modelSettingsPanel.hidden
      || !els.queuePanel.hidden
      || !els.commandMenu.hidden;
    closeCommandMenu();
    closeProjectUploadMenu();
    els.threadPanel.hidden = true;
    els.modelSettingsPanel.hidden = true;
    els.queuePanel.hidden = true;
    if (!dismissedOverlay && taskExecutionCanInterrupt()) {
      event.preventDefault();
      interruptCurrentTask();
    }
  }
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateVisualViewport);
  window.visualViewport.addEventListener("scroll", updateVisualViewport);
  updateVisualViewport();
}

els.modelSettingsButton.addEventListener("click", () => {
  openModelSettings().catch((error) => {
    els.modelSettingsStatus.textContent = `读取失败：${error.message}`;
  });
});
els.modelUsageToggle.addEventListener("click", () => {
  if (els.modelUsageView.hidden) {
    openUsageInModelSettings().catch((error) => {
      els.usageContent.innerHTML = "";
      els.usageStatus.textContent = `读取失败：${error.message}`;
    });
    return;
  }
  openModelSettings().catch((error) => {
    els.modelSettingsStatus.textContent = `读取失败：${error.message}`;
  });
});
els.closeModelSettings.addEventListener("click", () => {
  els.modelSettingsPanel.hidden = true;
});
els.createFolder.addEventListener("click", () => {
  createFolderInCurrentFilePanel().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});
els.createFile.addEventListener("click", () => {
  createFileInCurrentFilePanel().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});
els.projectDotFolderFilter.addEventListener("click", () => {
  state.hideProjectDotFolders = !state.hideProjectDotFolders;
  applyDotFolderFilter(els.fileList, els.projectDotFolderFilter, state.hideProjectDotFolders);
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
els.newDotFolderFilter.addEventListener("click", () => {
  state.hideNewSessionDotFolders = !state.hideNewSessionDotFolders;
  applyDotFolderFilter(els.newList, els.newDotFolderFilter, state.hideNewSessionDotFolders);
});

els.createSession.addEventListener("click", () => {
  createSessionInSelectedFolder().catch((error) => upsertAssistantMessage(`错误：${error.message}`, true));
});

els.threadButton.addEventListener("click", toggleThreadPanel);

els.refreshThreads.addEventListener("click", () => {
  if (els.refreshThreads.disabled) return;
  els.refreshThreads.disabled = true;
  els.refreshThreads.textContent = "刷新中...";
  openThreads().finally(() => {
    els.refreshThreads.disabled = false;
    els.refreshThreads.textContent = "刷新";
  });
});

els.closeThreads.addEventListener("click", () => {
  els.threadPanel.hidden = true;
  els.threadButton.setAttribute("aria-expanded", "false");
});
els.toggleThreadView.addEventListener("click", () => {
  if (els.threadNewView.hidden) openNewSessionPicker();
  else openThreads({ load: false });
});
els.threadFilesToggle.addEventListener("click", () => {
  if (els.threadFilesView.hidden) {
    openFiles(state.fileCwd || "");
    return;
  }
  openThreads({ load: false });
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
  openNewSessionPicker();
});

renderCommandList();
(state.autoApprove ? syncAutoApprovalNotificationPreference() : Promise.resolve())
  .catch(() => null)
  .then(loadState)
  .then(connectEvents)
  .catch((error) => {
    els.meta.textContent = error.message;
  });
restorePushSubscription();
refreshNativeNotificationStatus().catch(() => {});
autosizeInput();
updateScrollJumps();
