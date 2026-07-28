import assert from "node:assert/strict";
import {
  access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile
} from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexWorkDir } from "../src/config.js";
import { normalizeProjectUploadPath, saveProjectUploads } from "../src/files.js";
import { relativeProjectPath } from "../src/paths.js";

function multipartRequest(files = []) {
  const boundary = `codex-project-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="files"; filename="${file.path}"\r\n`
      + `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
      "utf8"
    ));
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || "", "utf8"));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const req = Readable.from(body);
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length)
  };
  return req;
}

async function createProjectFixture(t, prefix = ".project-upload-test-") {
  const fixture = await mkdtemp(path.join(codexWorkDir, prefix));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const destination = path.join(fixture, "destination");
  await mkdir(destination);
  return { fixture, destination };
}

test("project upload preserves a selected folder's complete relative structure", async (t) => {
  const { destination } = await createProjectFixture(t);
  const req = multipartRequest([
    { path: "导入目录/子目录/说明.txt", content: "folder content", type: "text/plain" },
    { path: "普通.txt", content: "single file", type: "text/plain" }
  ]);

  const result = await saveProjectUploads(req, relativeProjectPath(destination));

  assert.equal(result.uploaded, 2);
  assert.equal(result.directories, 2);
  assert.equal(await readFile(path.join(destination, "导入目录", "子目录", "说明.txt"), "utf8"), "folder content");
  assert.equal(await readFile(path.join(destination, "普通.txt"), "utf8"), "single file");
  assert.deepEqual((await readdir(destination)).sort(), ["导入目录", "普通.txt"]);
  assert.equal((await readdir(destination)).some((name) => name.startsWith(".codex-project-upload-")), false);
});

test("project upload refuses conflicts without overwriting or partially importing files", async (t) => {
  const { destination } = await createProjectFixture(t);
  await writeFile(path.join(destination, "existing.txt"), "keep me", "utf8");
  const req = multipartRequest([
    { path: "new.txt", content: "should not be imported" },
    { path: "existing.txt", content: "must not overwrite" }
  ]);

  await assert.rejects(
    saveProjectUploads(req, relativeProjectPath(destination)),
    /已有同名文件/
  );
  assert.equal(await readFile(path.join(destination, "existing.txt"), "utf8"), "keep me");
  await assert.rejects(access(path.join(destination, "new.txt")), { code: "ENOENT" });
  assert.deepEqual(await readdir(destination), ["existing.txt"]);
});

test("project upload blocks traversal paths and symlinks outside the project", async (t) => {
  const { fixture, destination } = await createProjectFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "project-upload-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await assert.rejects(
    saveProjectUploads(
      multipartRequest([{ path: "../escape.txt", content: "blocked" }]),
      relativeProjectPath(destination)
    ),
    /上传文件路径无效/
  );
  await assert.rejects(access(path.join(fixture, "escape.txt")), { code: "ENOENT" });

  await symlink(outside, path.join(destination, "外链"), "dir");
  await assert.rejects(
    saveProjectUploads(
      multipartRequest([{ path: "外链/escape.txt", content: "blocked" }]),
      relativeProjectPath(destination)
    ),
    /符号链接/
  );
  assert.deepEqual(await readdir(outside), []);
});

test("project upload path normalization rejects absolute, duplicate-level, and invalid names", () => {
  assert.equal(normalizeProjectUploadPath("folder/sub/file.txt"), "folder/sub/file.txt");
  assert.equal(normalizeProjectUploadPath("资料\\说明.md"), "资料/说明.md");
  assert.throws(() => normalizeProjectUploadPath("/etc/passwd"), /路径无效/);
  assert.throws(() => normalizeProjectUploadPath("folder/../secret"), /路径无效/);
  assert.throws(() => normalizeProjectUploadPath("folder//file"), /路径无效/);
  assert.throws(() => normalizeProjectUploadPath("folder/bad:name"), /特殊路径字符/);
});

test("project panel exposes file and whole-folder upload choices before new folder", async () => {
  const [html, source, styles, router] = await Promise.all([
    readFile(new URL("../public/remote.html", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/router.js", import.meta.url), "utf8")
  ]);
  const uploadIndex = html.indexOf('id="uploadProjectRemote"');
  const createFolderIndex = html.indexOf('id="createFolderRemote"');

  assert.ok(uploadIndex >= 0 && uploadIndex < createFolderIndex);
  assert.match(html, /id="projectFilesRemote" type="file" multiple hidden/);
  assert.match(html, /id="projectFolderRemote" type="file" webkitdirectory directory multiple hidden/);
  assert.match(source, /file\?\.webkitRelativePath \|\| file\?\.name/);
  assert.match(source, /form\.append\("files", file, projectUploadRelativePath\(file, index\)\)/);
  assert.match(source, /\/api\/remote\/project-upload\?/);
  assert.match(source, /正在上传[\s\S]*?percent/);
  assert.match(styles, /\.projectUploadMenu\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(router, /saveProjectUploads\(req, url\.searchParams\.get\("dir"\) \|\| ""\)/);
  assert.match(router, /被控电脑文件上传暂不支持/);
});
