import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function keyboardHelper() {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const processStart = source.indexOf("function isAndroidImeProcessKey");
  const processEnd = source.indexOf("function rememberAndroidImeProcessKey", processStart);
  const compositionStart = source.indexOf("function isAndroidImeCompositionKey");
  const compositionEnd = source.indexOf("function isAndroidImeTextNewline", compositionStart);
  const start = source.indexOf("function shouldSendMessageFromKeydown");
  const end = source.indexOf('els.input.addEventListener("keydown"', start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source.slice(processStart, processEnd)}\n${source.slice(compositionStart, compositionEnd)}\n${source.slice(start, end)}`, context);
  return { context, source };
}

test("plain Enter and Shift+Enter remain textarea newlines", async () => {
  const { context } = await keyboardHelper();
  context.plainEnter = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false };
  context.shiftEnter = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: true, isComposing: false };

  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(plainEnter)", context), false);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(shiftEnter)", context), false);
});

test("Ctrl+Enter and Command+Enter remain explicit desktop send shortcuts", async () => {
  const { context } = await keyboardHelper();
  context.ctrlEnter = { key: "Enter", ctrlKey: true, metaKey: false, isComposing: false };
  context.commandEnter = { key: "Enter", ctrlKey: false, metaKey: true, isComposing: false };
  context.composingEnter = { key: "Enter", ctrlKey: true, metaKey: false, isComposing: true };

  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(ctrlEnter)", context), true);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(commandEnter)", context), true);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(composingEnter)", context), false);
});

test("Android IME send is intercepted only while the collapsed action probe is armed", async () => {
  const { context } = await keyboardHelper();
  context.androidEnter = { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false };
  context.composingEnter = { ...context.androidEnter, isComposing: true };
  context.processEnter = { ...context.androidEnter, keyCode: 229 };

  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(androidEnter)", context), false);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(androidEnter, true, false)", context), true);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(androidEnter, true, true)", context), false);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(composingEnter, true, false)", context), false);
  assert.equal(vm.runInContext("shouldSendMessageFromKeydown(processEnter, true, false)", context), false);
});

test("Android beforeinput distinguishes the IME newline button from Send", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const start = source.indexOf("function isAndroidImeCompositionKey");
  const end = source.indexOf("function cancelPendingAndroidImeEnter", start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.imeNewline = { inputType: "insertText", data: "\n" };
  context.emptyImeNewline = { inputType: "insertCompositionText", data: "" };
  context.sendLineBreak = { inputType: "insertLineBreak", data: null };

  assert.equal(vm.runInContext("isAndroidImeTextNewline(imeNewline)", context), true);
  assert.equal(vm.runInContext("isAndroidImeTextNewline(emptyImeNewline)", context), true);
  assert.equal(vm.runInContext("isAndroidImeTextNewline(sendLineBreak)", context), false);
  assert.equal(vm.runInContext("isAndroidBrowserLineBreak(sendLineBreak)", context), true);
});

test("WeChat IME newline uses its unchanged 229-key prelude", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const start = source.indexOf("function isAndroidImeProcessKey");
  const end = source.indexOf("function isAndroidImeCompositionKey", start);
  const context = {
    androidImeActionProbe: "\u2060",
    androidImeProcessPreludeWindowMs: 50,
    androidImeProcessKeyCandidate: null,
    androidImeNewlinePreludeUntil: 0,
    now: 1000,
    Date: { now() { return context.now; } },
    els: { input: null },
    composerText(value = "") { return String(value).split("\u2060").join(""); },
    isAndroidImeProbeArmed(input) {
      return input.selectionStart === input.selectionEnd
        && input.value.slice(input.selectionStart - 1, input.selectionStart) === "\u2060";
    }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.input = { value: `1\u2060`, selectionStart: 2, selectionEnd: 2 };
  context.els.input = context.input;
  context.processKey = { key: "Unidentified", keyCode: 229, which: 229 };

  assert.equal(vm.runInContext("rememberAndroidImeProcessKey(processKey, input)", context), true);
  context.now += 3;
  assert.equal(vm.runInContext("finishAndroidImeProcessKey(processKey, input)", context), true);
  assert.equal(vm.runInContext("hasAndroidImeNewlinePrelude()", context), true);

  context.now += 60;
  assert.equal(vm.runInContext("hasAndroidImeNewlinePrelude()", context), false);
  context.now += 1;
  assert.equal(vm.runInContext("rememberAndroidImeProcessKey(processKey, input)", context), true);
  context.input.value = `12\u2060`;
  context.input.selectionStart = 3;
  context.input.selectionEnd = 3;
  assert.equal(vm.runInContext("finishAndroidImeProcessKey(processKey, input)", context), false);

  const handler = source.slice(
    source.indexOf('els.input.addEventListener("keydown"'),
    source.indexOf('els.input.addEventListener("beforeinput"')
  );
  assert.match(handler, /hasPendingAndroidImeNewline\(\) \|\| processKeyNewline/);
});

test("the Android IME action probe is removed from drafts and outgoing text", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const start = source.indexOf("const androidImeActionProbe");
  const end = source.indexOf("function isAndroidImeProbeArmed", start);
  const context = {
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile" },
    els: { input: { value: "" } }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  context.probedText = `你\u2060好\u2060`;
  assert.equal(vm.runInContext("isAndroidImeClient()", context), true);
  assert.equal(vm.runInContext("isAndroidImeClient('Mozilla/5.0 Android Firefox/142.0')", context), false);
  assert.equal(vm.runInContext("composerText(probedText)", context), "你好");
  assert.match(source, /function saveDraft\(\)[\s\S]*?const value = composerText\(\)/);
  assert.match(source, /async function sendMessage\(mode = "steer"\)[\s\S]*?const message = composerText\(\)\.trim\(\)/);
});

test("Backspace deletes the real newline before the Android IME action probe", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const start = source.indexOf("const androidImeActionProbe");
  const end = source.indexOf("function armAndroidImeProbe", start);
  const context = {
    navigator: { userAgent: "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile" },
    els: { input: { value: "" } }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.input = {
    value: `第一行\n\u2060`,
    selectionStart: 5,
    selectionEnd: 5,
    selectionDirection: "none",
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  };

  assert.equal(vm.runInContext("deleteComposerTextBesideProbe(input, 'backward')", context), true);
  assert.equal(context.input.value, "第一行");
  assert.equal(context.input.selectionStart, 3);
  assert.equal(context.input.selectionEnd, 3);
});

test("the Android IME probe keeps a collapsed native blinking caret", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");
  const armProbe = source.slice(
    source.indexOf("function armAndroidImeProbe"),
    source.indexOf("function scheduleAndroidImeProbe")
  );
  const helperStart = source.indexOf("function isAndroidImeProbeArmed");
  const helperEnd = source.indexOf("function removeAndroidImeProbe", helperStart);
  const context = { androidImeActionProbe: "\u2060" };
  vm.createContext(context);
  vm.runInContext(source.slice(helperStart, helperEnd), context);
  context.armedInput = { value: `文本\u2060`, selectionStart: 3, selectionEnd: 3 };
  context.selectedInput = { value: `文本\u2060`, selectionStart: 2, selectionEnd: 3 };

  assert.equal(vm.runInContext("isAndroidImeProbeArmed(armedInput)", context), true);
  assert.equal(vm.runInContext("isAndroidImeProbeArmed(selectedInput)", context), false);
  assert.match(armProbe, /setRangeText\(androidImeActionProbe, start, end, "end"\)/);
  assert.match(styles, /\.remoteComposer textarea\s*\{[\s\S]*?caret-color:\s*#f3f0e8/);
  assert.doesNotMatch(html, /remoteInputCaret/);
});

test("composer send actions default to steer while retaining an explicit queue button", async () => {
  const { source } = await keyboardHelper();
  const handler = source.slice(
    source.indexOf('els.input.addEventListener("keydown"'),
    source.indexOf('els.input.addEventListener("input"')
  );
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");

  assert.match(handler, /shouldSendMessageFromKeydown\(event, androidImeActionReady, pendingNewline\)/);
  assert.match(handler, /queueAndroidImeSendDecision\(\)/);
  assert.match(handler, /event\.preventDefault\(\);[\s\S]*?finishPendingAndroidImeSend\(\)/);
  assert.match(handler, /const textNewline = isAndroidImeTextNewline\(event\)/);
  assert.match(handler, /event\.inputType === "deleteContentBackward"[\s\S]*?deleteComposerTextBesideProbe/);
  const submitHandlers = source.slice(
    source.indexOf("async function sendMessage"),
    source.indexOf('els.input.addEventListener("keydown"')
  );

  assert.match(source, /async function sendMessage\(mode = "steer"\)/);
  assert.match(submitHandlers, /els\.form\.addEventListener\("submit"[\s\S]*?sendMessage\("steer"\)/);
  assert.match(submitHandlers, /els\.sendQueue\.addEventListener\("click"[\s\S]*?sendMessage\("queue"\)/);
  assert.match(source, /const androidImeActionProbe = "\\u2060"/);
  assert.match(html, /inputmode="text" enterkeyhint="send"/);
  assert.doesNotMatch(html, /id="remoteInput"[^>]*placeholder=/);
  assert.match(html, /id="sendQueueRemote" class="iconButton" type="button"/);
  assert.match(html, /id="sendSteerRemote" class="iconButton primary" type="submit"/);
  assert.match(html, /remote\.js\?v=20260810-persistent-approval-suppression/);
});
