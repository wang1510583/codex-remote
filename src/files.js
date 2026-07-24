import { mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import { codexWorkDir, uploadDir } from "./config.js";
import { isPreviewText, mimeType, safeFolderName, safeName, safeProjectFileName, readRawBody } from "./utils.js";
import { projectPath, relativeProjectPath } from "./paths.js";

function isInsidePath(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function projectDownloadTarget(pathParam = "") {
  const requested = projectPath(pathParam);
  const [realRoot, resolved] = await Promise.all([
    realpath(projectPath("")),
    realpath(requested)
  ]);
  if (!isInsidePath(realRoot, resolved)) {
    throw Object.assign(new Error("下载路径超出项目范围。"), { statusCode: 403 });
  }
  const info = await stat(resolved);
  if (!info.isFile() && !info.isDirectory()) {
    throw Object.assign(new Error("只能下载文件或文件夹。"), { statusCode: 400 });
  }
  return {
    file: resolved,
    name: path.basename(requested) || path.basename(realRoot),
    type: info.isDirectory() ? "dir" : "file",
    size: info.isFile() ? info.size : 0,
    mime: info.isFile() ? mimeType(resolved) : "application/zip"
  };
}

export function createProjectFolderZip(folder, archiveName = path.basename(folder)) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.directory(folder, safeName(archiveName || path.basename(folder)));
  return archive;
}

export async function listProjectFiles(dirParam = "") {
  const dir = projectPath(dirParam);
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error("不是文件夹。");
  const rows = await readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const row of rows) {
    const file = path.join(dir, row.name);
    const item = await stat(file);
    entries.push({
      name: row.name,
      path: relativeProjectPath(file),
      type: item.isDirectory() ? "dir" : "file",
      size: item.isFile() ? item.size : 0,
      mtime: item.mtime.toISOString(),
      preview: item.isFile() && (isPreviewText(file) || /^image\//.test(mimeType(file)))
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return {
    cwd: relativeProjectPath(dir),
    absoluteCwd: dir,
    parent: dir === path.resolve(codexWorkDir) ? "" : relativeProjectPath(path.dirname(dir)),
    absoluteParent: dir === path.resolve(codexWorkDir) ? "" : path.dirname(dir),
    entries
  };
}

export async function createProjectFolder(dirParam = "", name = "") {
  const parent = projectPath(dirParam);
  const info = await stat(parent);
  if (!info.isDirectory()) throw Object.assign(new Error("父路径不是文件夹。"), { statusCode: 400 });
  const folderName = safeFolderName(name);
  const folder = projectPath(path.join(relativeProjectPath(parent), folderName));
  if (existsSync(folder)) throw Object.assign(new Error("同名文件或文件夹已存在。"), { statusCode: 409 });
  await mkdir(folder);
  return listProjectFiles(parent);
}

export async function deleteProjectFolder(dirParam = "") {
  const folder = projectPath(dirParam);
  const root = path.resolve(codexWorkDir);
  if (folder === root) throw Object.assign(new Error("不能删除项目根目录。"), { statusCode: 400 });
  const info = await stat(folder);
  if (!info.isDirectory()) throw Object.assign(new Error("只能删除文件夹。"), { statusCode: 400 });
  const parent = path.dirname(folder);
  await rm(folder, { recursive: true, force: false });
  return listProjectFiles(parent);
}

export async function createProjectFile(dirParam = "", name = "", content = "") {
  const parent = projectPath(dirParam);
  const info = await stat(parent);
  if (!info.isDirectory()) throw Object.assign(new Error("父路径不是文件夹。"), { statusCode: 400 });
  const fileName = safeProjectFileName(name);
  const file = projectPath(path.join(relativeProjectPath(parent), fileName));
  if (existsSync(file)) throw Object.assign(new Error("同名文件或文件夹已存在。"), { statusCode: 409 });
  await writeFile(file, String(content || ""), "utf8");
  return listProjectFiles(parent);
}

export async function deleteProjectFile(fileParam = "") {
  const file = projectPath(fileParam);
  const root = path.resolve(codexWorkDir);
  if (file === root) throw Object.assign(new Error("不能删除项目根目录。"), { statusCode: 400 });
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error("只能删除文件。"), { statusCode: 400 });
  const parent = path.dirname(file);
  await unlink(file);
  return listProjectFiles(parent);
}

export async function writeProjectFile(fileParam = "", content = "") {
  const file = projectPath(fileParam);
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error("只能编辑文件。"), { statusCode: 400 });
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw Object.assign(new Error("文件内容不能超过 1MB。"), { statusCode: 400 });
  await writeFile(file, text, "utf8");
  return { ok: true, type: "text", path: relativeProjectPath(file), mime: mimeType(file), text };
}

export async function renameProjectPath(pathParam = "", name = "") {
  const source = projectPath(pathParam);
  const root = path.resolve(codexWorkDir);
  if (source === root) throw Object.assign(new Error("不能重命名项目根目录。"), { statusCode: 400 });
  const info = await stat(source);
  const newName = info.isDirectory() ? safeFolderName(name) : safeProjectFileName(name);
  const target = projectPath(path.join(relativeProjectPath(path.dirname(source)), newName));
  if (existsSync(target)) throw Object.assign(new Error("同名文件或文件夹已存在。"), { statusCode: 409 });
  await rename(source, target);
  return listProjectFiles(path.dirname(target));
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const files = [];
  let start = buffer.indexOf(delimiter);
  while (start !== -1) {
    start += delimiter.length;
    if (buffer.slice(start, start + 2).toString() === "--") break;
    if (buffer.slice(start, start + 2).toString() === "\r\n") start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const header = buffer.slice(start, headerEnd).toString("latin1");
    let contentStart = headerEnd + 4;
    let next = buffer.indexOf(delimiter, contentStart);
    if (next === -1) break;
    let contentEnd = next;
    if (buffer.slice(contentEnd - 2, contentEnd).toString() === "\r\n") contentEnd -= 2;
    const rawFilename = header.match(/filename="([^"]*)"/i)?.[1];
    const filename = rawFilename ? Buffer.from(rawFilename, "latin1").toString("utf8") : "";
    if (filename) files.push({ name: safeName(filename), content: buffer.slice(contentStart, contentEnd) });
    start = next;
  }
  return files;
}

export async function saveUploadedFiles(req) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error("上传格式错误。");
  const parts = parseMultipart(await readRawBody(req), boundary);
  if (!parts.length) throw new Error("没有收到文件。");
  const dir = path.join(uploadDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  const files = [];
  for (const part of parts.slice(0, 20)) {
    const file = path.join(dir, part.name);
    await writeFile(file, part.content);
    files.push({ name: part.name, path: file, size: part.content.length, url: `/api/remote/download?p=${encodeURIComponent(file)}` });
  }
  return files;
}
