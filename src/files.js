import {
  link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile
} from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import Busboy from "busboy";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { codexWorkDir, uploadDir } from "./config.js";
import { isPreviewText, mimeType, safeFolderName, safeName, safeProjectFileName, readRawBody } from "./utils.js";
import { projectPath, relativeProjectPath } from "./paths.js";

const maxProjectUploadBytes = 512 * 1024 * 1024;
const maxProjectUploadRequestBytes = maxProjectUploadBytes + 8 * 1024 * 1024;
const maxProjectUploadFiles = 5000;

function isInsidePath(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function fileError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeProjectUploadPath(filename = "") {
  const raw = String(filename || "").normalize("NFC").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw fileError("上传文件路径无效。");
  }
  const parts = raw.split("/");
  if (
    parts.length > 100
    || parts.some((part) => !part || part === "." || part === "..")
    || parts[0].startsWith(".codex-project-upload-")
    || Buffer.byteLength(raw, "utf8") > 2048
  ) {
    throw fileError("上传文件路径无效或层级过深。");
  }
  parts.forEach((part, index) => {
    if (index === parts.length - 1) safeProjectFileName(part);
    else safeFolderName(part);
  });
  return parts.join("/");
}

async function receiveProjectUpload(req, stagingDir) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxProjectUploadRequestBytes) {
    throw fileError("单次上传总大小不能超过 512MB。", 413);
  }

  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        preservePath: true,
        defParamCharset: "utf8",
        limits: {
          fileSize: maxProjectUploadBytes,
          files: maxProjectUploadFiles,
          parts: maxProjectUploadFiles + 20
        }
      });
    } catch {
      reject(fileError("上传格式错误。"));
      return;
    }

    const rows = [];
    const seen = new Set();
    const tasks = [];
    let totalBytes = 0;
    let failure = null;
    let finishing = false;
    const fail = (error) => {
      if (!failure) failure = error?.statusCode ? error : fileError(error?.message || "上传失败。");
    };
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      await Promise.all(tasks);
      if (failure) reject(failure);
      else if (!rows.length) reject(fileError("没有收到可上传的文件。"));
      else resolve(rows);
    };

    parser.on("file", (field, stream, info = {}) => {
      if (field !== "files" || !info.filename) {
        stream.resume();
        return;
      }
      let relative;
      try {
        relative = normalizeProjectUploadPath(info.filename);
        if (seen.has(relative)) throw fileError(`上传内容中存在重复路径：${relative}`);
        seen.add(relative);
      } catch (error) {
        fail(error);
        stream.resume();
        return;
      }

      const stagedFile = path.join(stagingDir, ...relative.split("/"));
      const row = { relative, stagedFile, size: 0 };
      rows.push(row);
      let truncated = false;
      stream.on("limit", () => {
        truncated = true;
        fail(fileError(`文件过大：${relative}`, 413));
      });
      const task = (async () => {
        await mkdir(path.dirname(stagedFile), { recursive: true });
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            row.size += chunk.length;
            totalBytes += chunk.length;
            if (totalBytes > maxProjectUploadBytes) {
              fail(fileError("单次上传总大小不能超过 512MB。", 413));
            }
            callback(null, chunk);
          }
        });
        await pipeline(stream, counter, createWriteStream(stagedFile, { flags: "wx" }));
        if (truncated) throw fileError(`文件过大：${relative}`, 413);
      })().catch(fail);
      tasks.push(task);
    });
    parser.on("filesLimit", () => fail(fileError(`单次最多上传 ${maxProjectUploadFiles} 个文件。`, 413)));
    parser.on("partsLimit", () => fail(fileError("上传内容的项目数量过多。", 413)));
    parser.on("error", (error) => {
      fail(error);
      finish();
    });
    parser.on("close", finish);
    req.on("aborted", () => {
      fail(fileError("上传已取消。", 499));
      finish();
    });
    req.pipe(parser);
  });
}

async function realExistingDirectory(target) {
  let current = target;
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw fileError(`上传目标的父路径不是文件夹：${path.basename(current)}`, 409);
      }
      return realpath(current);
    } catch (error) {
      if (error?.code === "ENOTDIR") {
        throw fileError(`上传目标的父路径不是文件夹：${path.basename(current)}`, 409);
      }
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function uploadDirectoryCount(rows = []) {
  const directories = new Set();
  for (const row of rows) {
    const parts = row.relative.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return directories.size;
}

export async function saveProjectUploads(req, dirParam = "") {
  const requestedDir = projectPath(dirParam);
  const [realRoot, destination] = await Promise.all([
    realpath(projectPath("")),
    realpath(requestedDir)
  ]);
  if (!isInsidePath(realRoot, destination)) throw fileError("上传路径超出项目范围。", 403);
  const destinationInfo = await stat(destination);
  if (!destinationInfo.isDirectory()) throw fileError("请选择要上传到的文件夹。");

  const stagingDir = await mkdtemp(path.join(destination, ".codex-project-upload-"));
  const createdTargets = [];
  try {
    const rows = await receiveProjectUpload(req, stagingDir);
    const uploadPaths = new Set(rows.map((row) => row.relative));
    for (const row of rows) {
      const parts = row.relative.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const parentPath = parts.slice(0, index).join("/");
        if (uploadPaths.has(parentPath)) {
          throw fileError(`上传路径同时被用作文件和文件夹：${parentPath}`);
        }
      }
    }

    const conflicts = [];
    for (const row of rows) {
      const target = path.resolve(destination, ...row.relative.split("/"));
      if (!isInsidePath(destination, target)) throw fileError("上传路径超出当前文件夹。", 403);
      const realParent = await realExistingDirectory(path.dirname(target));
      if (!isInsidePath(destination, realParent)) throw fileError("上传路径经过了项目外的符号链接。", 403);
      try {
        await lstat(target);
        conflicts.push(row.relative);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      row.target = target;
    }
    if (conflicts.length) {
      const shown = conflicts.slice(0, 3).join("、");
      const remaining = conflicts.length > 3 ? `等 ${conflicts.length} 个文件` : "";
      throw fileError(`已有同名文件：${shown}${remaining}。为避免覆盖，本次未上传任何文件。`, 409);
    }

    try {
      for (const row of rows) {
        await mkdir(path.dirname(row.target), { recursive: true });
        await link(row.stagedFile, row.target);
        createdTargets.push(row.target);
      }
    } catch (error) {
      await Promise.all(createdTargets.map((file) => unlink(file).catch(() => {})));
      throw error;
    }

    return {
      ok: true,
      cwd: relativeProjectPath(requestedDir),
      uploaded: rows.length,
      directories: uploadDirectoryCount(rows),
      bytes: rows.reduce((total, row) => total + row.size, 0),
      files: rows.map((row) => ({
        name: path.basename(row.relative),
        path: relativeProjectPath(path.join(requestedDir, ...row.relative.split("/"))),
        relativePath: row.relative,
        size: row.size
      }))
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
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
