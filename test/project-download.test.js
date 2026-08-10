import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexWorkDir } from "../src/config.js";
import { createProjectFolderZip, projectDownloadTarget } from "../src/files.js";
import { relativeProjectPath } from "../src/paths.js";

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

test("project files and folders resolve only inside the project root", async (t) => {
  const projectFixture = await mkdtemp(path.join(codexWorkDir, ".project-download-test-"));
  const outsideFixture = await mkdtemp(path.join(os.tmpdir(), "project-download-outside-"));
  t.after(async () => {
    await rm(projectFixture, { recursive: true, force: true });
    await rm(outsideFixture, { recursive: true, force: true });
  });

  const folder = path.join(projectFixture, "资料 文件夹");
  const file = path.join(folder, "说明.txt");
  await mkdir(folder);
  await writeFile(file, "streamed download", "utf8");

  const folderTarget = await projectDownloadTarget(relativeProjectPath(folder));
  const fileTarget = await projectDownloadTarget(relativeProjectPath(file));
  assert.equal(folderTarget.type, "dir");
  assert.equal(folderTarget.name, "资料 文件夹");
  assert.equal(fileTarget.type, "file");
  assert.equal(fileTarget.name, "说明.txt");
  assert.equal(fileTarget.size, Buffer.byteLength("streamed download"));

  const outsideLink = path.join(projectFixture, "outside-link");
  await symlink(outsideFixture, outsideLink, "dir");
  await assert.rejects(
    projectDownloadTarget(relativeProjectPath(outsideLink)),
    /下载路径超出项目范围/
  );
  await assert.rejects(projectDownloadTarget(outsideFixture), /路径超出项目范围/);
});

test("folder ZIP is generated as a stream without leaving an archive on disk", async (t) => {
  const projectFixture = await mkdtemp(path.join(codexWorkDir, ".project-zip-test-"));
  t.after(() => rm(projectFixture, { recursive: true, force: true }));
  const folder = path.join(projectFixture, "download-folder");
  await mkdir(path.join(folder, "nested"), { recursive: true });
  await writeFile(path.join(folder, "nested", "note.txt"), "hello", "utf8");

  const archive = createProjectFolderZip(folder, "download-folder");
  const outputPromise = collectStream(archive);
  await archive.finalize();
  const output = await outputPromise;

  assert.equal(output.subarray(0, 2).toString("ascii"), "PK");
  assert.equal(output.includes(Buffer.from("download-folder/nested/note.txt")), true);
  assert.deepEqual(await readdir(projectFixture), ["download-folder"]);
});

test("project panel provides download buttons for files and streamed folder ZIPs", async () => {
  const [source, styles, router] = await Promise.all([
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/router.js", import.meta.url), "utf8")
  ]);

  assert.match(source, /actions\.append\(fileActionButton\("下载", "download"\)\)/);
  assert.match(source, /action === "download"\)\s+downloadProjectItem\(file, name, row\.dataset\.type/);
  assert.match(source, /\/api\/remote\/project-download\?/);
  assert.match(source, /itemType === "dir" \? `\$\{baseName\}\.zip` : baseName/);
  assert.match(styles, /\.fileActions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(router, /createProjectFolderZip\(folder, archiveName\)/);
  assert.match(router, /const abort = \(\) => \{[\s\S]*?archive\.abort\(\)/);
  assert.match(router, /req\.on\("aborted", \(\) => \{[\s\S]*?abort\(\)/);
  assert.doesNotMatch(router, /writeFile\([^)]*\.zip/);
});
