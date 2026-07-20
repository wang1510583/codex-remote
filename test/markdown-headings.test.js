import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function markdownContext() {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function escapeHtml"),
    source.indexOf("function setMessageContent")
  );
  const context = {
    state: { fileLinkRoots: [] },
    basePath: "/codex-remote"
  };
  vm.createContext(context);
  vm.runInContext(helper, context);
  return context;
}

test("Markdown ATX headings preserve all six semantic levels", async () => {
  const context = await markdownContext();
  const markdown = [
    "# 一级标题",
    "## 二级标题",
    "### 三级标题",
    "#### 四级标题",
    "##### 五级标题",
    "###### 六级标题"
  ].join("\n");
  context.markdown = markdown;

  assert.equal(
    vm.runInContext("renderMarkdown(markdown)", context),
    [
      "<h1>一级标题</h1>",
      "<h2>二级标题</h2>",
      "<h3>三级标题</h3>",
      "<h4>四级标题</h4>",
      "<h5>五级标题</h5>",
      "<h6>六级标题</h6>"
    ].join("\n")
  );
});

test("heading content keeps inline Markdown and safely handles closing hashes", async () => {
  const context = await markdownContext();
  context.markdown = "  ### **重点** <script> ###\n####### 不是标题";

  assert.equal(
    vm.runInContext("renderMarkdown(markdown)", context),
    "<h3><b>重点</b> &lt;script&gt;</h3>\n<p>####### 不是标题</p>"
  );
});

test("message heading styles have visibly different sizes", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.message h1\s*\{[\s\S]*?font-size:\s*1\.55em/);
  assert.match(css, /\.message h2\s*\{[\s\S]*?font-size:\s*1\.38em/);
  assert.match(css, /\.message h3\s*\{[\s\S]*?font-size:\s*1\.23em/);
  assert.match(css, /\.message h4\s*\{[\s\S]*?font-size:\s*1\.12em/);
  assert.match(css, /\.message h5\s*\{[\s\S]*?font-size:\s*1\.04em/);
  assert.match(css, /\.message h6\s*\{[\s\S]*?font-size:\s*0\.96em/);
});

test("completion replies gain status, section, list, and callout structure", async () => {
  const context = await markdownContext();
  context.markdown = [
    "✅ 已完成 Markdown 优化",
    "",
    "主要调整：",
    "",
    "- **重点内容** 更醒目",
    "- `remote.js` 使用代码色",
    "",
    "> [!WARNING] 刷新后生效",
    "> 旧标签页需要重新打开",
    "",
    "1. 第一步",
    "2. 第二步"
  ].join("\n");

  const rendered = vm.runInContext("renderMarkdown(markdown)", context);
  assert.match(rendered, /<div class="messageLead messageLead-success">[\s\S]*?已完成 Markdown 优化[\s\S]*?<\/div>/);
  assert.match(rendered, /<h4 class="messageSectionTitle">主要调整：<\/h4>/);
  assert.match(rendered, /<ul class="markdownList">[\s\S]*?<li class="markdownListItem"><b>重点内容<\/b> 更醒目<\/li>/);
  assert.match(rendered, /<li class="markdownListItem"><code>remote\.js<\/code> 使用代码色<\/li>[\s\S]*?<\/ul>/);
  assert.match(rendered, /<blockquote class="markdownCallout markdownCallout-warning">[\s\S]*?刷新后生效[\s\S]*?旧标签页需要重新打开[\s\S]*?<\/blockquote>/);
  assert.match(rendered, /<ol class="markdownList">[\s\S]*?第一步[\s\S]*?第二步[\s\S]*?<\/ol>/);
});

test("rich Markdown emphasis has explicit readable colors", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.message strong,[\s\S]*?\.message b\s*\{[\s\S]*?color:\s*#fde68a;[\s\S]*?font-weight:\s*800;/);
  assert.match(css, /\.message h4\.messageSectionTitle\s*\{[\s\S]*?border-left:\s*3px solid #8b5cf6;[\s\S]*?color:\s*#c4b5fd;/);
  assert.match(css, /\.message li::marker\s*\{[\s\S]*?color:\s*#a78bfa;/);
  assert.match(css, /\.message code\s*\{[\s\S]*?color:\s*#fcd34d;/);
  assert.match(css, /\.messageLead-success\s*\{[\s\S]*?color:\s*#bbf7d0;/);
  assert.match(css, /\.message a\s*\{[\s\S]*?color:\s*#93c5fd;/);
});

test("assistant bubbles have no outer background color", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const assistant = css.slice(
    css.indexOf(".message.assistant {"),
    css.indexOf(".messageBlock", css.indexOf(".message.assistant {"))
  );

  assert.match(assistant, /\.message\.assistant\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border-color:\s*transparent;/);
  assert.match(assistant, /\.message\.assistant\.completion\s*\{[\s\S]*?background:\s*transparent;/);
  assert.doesNotMatch(assistant, /linear-gradient/);
});

test("thinking status text uses normal weight while completion stays emphasized", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");

  assert.match(css, /\.messageLeadText\s*\{[\s\S]*?font-weight:\s*800;/);
  assert.match(css, /\.messageLead-thinking \.messageLeadText\s*\{[\s\S]*?font-weight:\s*400;/);
  assert.match(css, /\.message\.assistant\.thinking\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?line-height:\s*1\.5;/);
  assert.match(css, /\.message\.assistant\.thinking \.messageLead\s*\{[\s\S]*?font-size:\s*1em;/);
  assert.match(source, /classList\.toggle\("thinking", \/\^🤔\\s\/\.test\(text \|\| ""\)\)/);
});

test("assistant Markdown emphasis uses no filled green or purple backgrounds", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.message ul,[\s\S]*?\.message ol\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.message blockquote\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.message code\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.message pre\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.messageLead\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.messageLead-success\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.messageLead-thinking\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.markdownCallout-tip\s*\{[\s\S]*?background:\s*transparent !important;/);
  assert.match(css, /\.markdownCallout-important\s*\{[\s\S]*?background:\s*transparent !important;/);
});
