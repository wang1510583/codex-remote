import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function speechContext(options = {}) {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function speechEngine"),
    source.indexOf("function urlBase64ToUint8Array")
  );
  const spoken = [];
  let cancelCount = 0;
  const voice = { lang: "zh-CN", default: true, name: "Chinese" };
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const engine = {
    paused: false,
    getVoices: () => [voice],
    speak: (utterance) => spoken.push(utterance),
    cancel: () => { cancelCount += 1; },
    resume() { this.paused = false; }
  };
  const storage = new Map();
  const context = {
    window: options.unsupported ? {} : {
      speechSynthesis: engine,
      SpeechSynthesisUtterance: FakeUtterance
    },
    state: {
      autoSpeech: Boolean(options.enabled),
      spokenMessageIds: new Set(),
      speechUtterances: new Set(),
      threadId: "thread-1",
      cwd: "project"
    },
    currentConnectorId: () => "",
    localStorage: {
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    closeCommandMenu() {},
    appendEvent() {},
    renderCommandList() {},
    els: { log: { contains: () => true } },
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout() {}
  };
  vm.createContext(context);
  vm.runInContext(helper, context);
  return { context, engine, spoken, storage, voice, cancelCount: () => cancelCount };
}

function fakeClassList(...initial) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name)
  };
}

function fakeMessageBlock(role, text = "") {
  const bubble = {
    dataset: { speechText: text },
    textContent: text,
    classList: fakeClassList("message", role)
  };
  const block = {
    role,
    bubble,
    nextElementSibling: null,
    classList: fakeClassList("messageBlock", `${role}Block`),
    matches: (selector) => role === "user" && selector.includes(".messageBlock.userBlock"),
    querySelectorAll: (selector) => role === "assistant" && selector === ".message.assistant" ? [bubble] : []
  };
  bubble.closest = (selector) => selector === ".messageBlock.userBlock" && role === "user" ? block : null;
  return block;
}

function linkBlocks(...blocks) {
  blocks.forEach((block, index) => { block.nextElementSibling = blocks[index + 1] || null; });
  return blocks;
}

test("speech text removes visual-only Markdown and code", async () => {
  const { context } = await speechContext();
  const result = vm.runInContext(`speechTextFromMessage(${JSON.stringify([
    "✅ **已经完成** [查看文件](https://example.com/file)",
    "```js",
    "console.log('not spoken')",
    "```"
  ].join("\n"))})`, context);

  assert.equal(result, "已经完成 查看文件 代码内容已省略。");
});

test("long replies are split into Android-friendly utterances", async () => {
  const { context } = await speechContext();
  const chunks = vm.runInContext(`speechChunks(${JSON.stringify(`${"甲".repeat(600)}。${"乙".repeat(600)}。`)}, 1000)`, context);

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.equal(chunks.join(""), `${"甲".repeat(600)}。${"乙".repeat(600)}。`);
});

test("each completed assistant message id is spoken only once", async () => {
  const { context, spoken, voice } = await speechContext({ enabled: true });
  const event = {
    role: "assistant",
    content: "🤔 正在处理",
    messageId: "msg-stable-1",
    final: true
  };
  context.event = event;

  assert.equal(vm.runInContext("speakCompletedAssistantMessage(event)", context), true);
  assert.equal(vm.runInContext("speakCompletedAssistantMessage(event)", context), false);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "正在处理");
  assert.equal(spoken[0].lang, "zh-CN");
  assert.equal(spoken[0].voice, voice);
  assert.equal(context.state.spokenMessageIds.size, 1);
});

test("the slash-panel toggle persists state and cancels queued speech", async () => {
  const { context, spoken, storage, cancelCount } = await speechContext();

  vm.runInContext("toggleAutoSpeech()", context);
  assert.equal(context.state.autoSpeech, true);
  assert.equal(storage.get("codex-remote-auto-speech"), "1");
  assert.equal(spoken[0].text, "自动语音朗读已开启");

  vm.runInContext("toggleAutoSpeech()", context);
  assert.equal(context.state.autoSpeech, false);
  assert.equal(storage.get("codex-remote-auto-speech"), "0");
  assert.equal(cancelCount(), 2);
});

test("clicking a user bubble speaks only its following assistant replies", async () => {
  const { context, spoken, cancelCount } = await speechContext();
  const [firstUser, firstReply, eventRow, secondReply, nextUser, laterReply] = linkBlocks(
    fakeMessageBlock("user", "第一个问题"),
    fakeMessageBlock("assistant", "**第一条回复**"),
    fakeMessageBlock("event"),
    fakeMessageBlock("assistant", "[第二条回复](https://example.com)"),
    fakeMessageBlock("user", "第二个问题"),
    fakeMessageBlock("assistant", "不应朗读")
  );
  context.userBubble = firstUser.bubble;

  assert.equal(vm.runInContext("speakRepliesAfterUserBubble(userBubble)", context), 2);
  assert.equal(context.state.autoSpeech, false, "manual speech must work with /tts disabled");
  assert.equal(cancelCount(), 1, "a manual selection cancels the previous speech queue first");
  assert.deepEqual(spoken.map((item) => item.text), ["第一条回复", "第二条回复"]);
  assert.equal(laterReply.bubble.dataset.speechText, "不应朗读");
});

test("clicking a user bubble without a reply only cancels existing speech", async () => {
  const { context, spoken, cancelCount } = await speechContext();
  const [firstUser] = linkBlocks(fakeMessageBlock("user", "尚未回复"));
  context.userBubble = firstUser.bubble;

  assert.equal(vm.runInContext("speakRepliesAfterUserBubble(userBubble)", context), 0);
  assert.equal(cancelCount(), 1);
  assert.equal(spoken.length, 0);
});

test("only final assistant SSE bubbles trigger auto speech", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf("function handleRemoteEvent"),
    source.indexOf("async function resyncEvents")
  );
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");

  assert.match(source, /command:\s*"\/tts"[\s\S]*?action:\s*toggleAutoSpeech/);
  assert.match(handler, /upsertAssistantMessage\([^;]+\);\s*if \(data\.final\) speakCompletedAssistantMessage\(data\)/);
  assert.match(source, /element\.dataset\.speechText\s*=\s*String\(text \|\| ""\)/);
  assert.match(source, /els\.log\.addEventListener\("click", handleUserBubbleSpeechInteraction\)/);
  assert.match(html, /remote\.js\?v=20260721-compact-thinking/);
  assert.match(html, /styles\.css\?v=20260721-compact-thinking/);
});
