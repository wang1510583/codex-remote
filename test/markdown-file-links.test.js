import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("Markdown file links use server-provided roots", async () => {
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const start = source.indexOf("function escapeHtml");
  const end = source.indexOf("function tableCellVisualWidth");
  const context = {
    state: { fileLinkRoots: ["/srv/projects", "/srv/runtime/uploads"] },
    basePath: "/codex-remote"
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const plain = vm.runInContext("renderInlineMarkdown('文件：/srv/projects/demo/readme.md')", context);
  const markdown = vm.runInContext("renderInlineMarkdown('[打开](/srv/runtime/uploads/a.png)')", context);
  const outside = vm.runInContext("renderInlineMarkdown('[外部](/etc/passwd)')", context);

  assert.match(plain, /\/api\/remote\/download\?p=%2Fsrv%2Fprojects%2Fdemo%2Freadme\.md/);
  assert.match(markdown, /\/api\/remote\/download\?p=%2Fsrv%2Fruntime%2Fuploads%2Fa\.png/);
  assert.doesNotMatch(outside, /\/api\/remote\/download/);
  assert.doesNotMatch(source, /\/root\/codex项目2/);
});
