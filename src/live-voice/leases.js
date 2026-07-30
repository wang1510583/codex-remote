const liveVoiceThreads = new Map();

function cleanThreadId(threadId) {
  return String(threadId || "").trim();
}

function snapshot(record) {
  if (!record) return null;
  return {
    threadId: record.threadId,
    acquiredAt: record.acquiredAt,
    updatedAt: record.updatedAt,
    cwd: record.cwd || "",
    connected: Boolean(record.connected),
    realtimeActive: Boolean(record.realtimeActive),
    taskRunning: Boolean(record.taskRunning),
    turnId: record.turnId || "",
    detachedAt: record.detachedAt || "",
    explicitStop: Boolean(record.explicitStop)
  };
}

export function acquireLiveVoiceThread(threadId, owner = {}) {
  const key = cleanThreadId(threadId);
  if (!key || liveVoiceThreads.has(key)) return null;
  const now = new Date().toISOString();
  const record = {
    threadId: key,
    owner,
    controller: null,
    acquiredAt: now,
    updatedAt: now,
    cwd: "",
    connected: false,
    realtimeActive: false,
    taskRunning: false,
    turnId: "",
    detachedAt: "",
    explicitStop: false
  };
  liveVoiceThreads.set(key, record);
  let released = false;
  return {
    threadId: key,
    update(patch = {}) {
      if (released || liveVoiceThreads.get(key) !== record) return null;
      for (const field of [
        "cwd",
        "connected",
        "realtimeActive",
        "taskRunning",
        "turnId",
        "detachedAt",
        "explicitStop"
      ]) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
          record[field] = patch[field];
        }
      }
      record.updatedAt = new Date().toISOString();
      return snapshot(record);
    },
    setController(controller) {
      if (released || liveVoiceThreads.get(key) !== record) return false;
      record.controller = controller && typeof controller === "object"
        ? controller
        : null;
      record.updatedAt = new Date().toISOString();
      return true;
    },
    snapshot() {
      return released ? null : snapshot(record);
    },
    release() {
      if (released) return;
      released = true;
      if (liveVoiceThreads.get(key) === record) liveVoiceThreads.delete(key);
    }
  };
}

export function isLiveVoiceThreadActive(threadId) {
  return liveVoiceThreads.has(cleanThreadId(threadId));
}

export function liveVoiceThreadSnapshot(threadId) {
  return snapshot(liveVoiceThreads.get(cleanThreadId(threadId)));
}

export function activeLiveVoiceThreadIds() {
  return [...liveVoiceThreads.keys()];
}

export function activeLiveVoiceThreadSnapshots() {
  return [...liveVoiceThreads.values()].map(snapshot);
}

export async function sendLiveVoiceThreadInput(threadId, text, options = {}) {
  const record = liveVoiceThreads.get(cleanThreadId(threadId));
  if (!record?.controller?.sendText) {
    throw new Error("Live Voice 会话正在恢复，暂时无法接收网页输入。");
  }
  return await record.controller.sendText(text, options);
}

export async function interruptLiveVoiceThreadTask(threadId) {
  const record = liveVoiceThreads.get(cleanThreadId(threadId));
  if (!record?.controller?.interruptTask) return false;
  return Boolean(await record.controller.interruptTask());
}

export function clearLiveVoiceThreadsForTest() {
  liveVoiceThreads.clear();
}
