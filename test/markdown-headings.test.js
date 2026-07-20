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
    "<h3><b>重点</b> &lt;script&gt;</h3>\n####### 不是标题"
  );
});

test("message heading styles have visibly different sizes", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.message h1\s*\{[\s\S]*?font-size:\s*1\.5em/);
  assert.match(css, /\.message h2\s*\{[\s\S]*?font-size:\s*1\.32em/);
  assert.match(css, /\.message h3\s*\{[\s\S]*?font-size:\s*1\.18em/);
  assert.match(css, /\.message h4\s*\{[\s\S]*?font-size:\s*1\.08em/);
  assert.match(css, /\.message h5\s*\{[\s\S]*?font-size:\s*1em/);
  assert.match(css, /\.message h6\s*\{[\s\S]*?font-size:\s*0\.92em/);
});
