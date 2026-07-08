import posixPath from "node:path/posix";
import { Client as SshClient } from "ssh2";

let sshConnection = null;

export function closeSshConnection() {
  if (sshConnection?.client) {
    try { sshConnection.client.end(); } catch {}
  }
  sshConnection = null;
}

export function sshStatusPayload() {
  return sshConnection ? {
    connected: true,
    label: sshConnection.label,
    cwd: sshConnection.cwd || sshConnection.home || ".",
    home: sshConnection.home || ".",
    connectedAt: sshConnection.connectedAt
  } : { connected: false };
}

function ensureSshConnection() {
  if (!sshConnection?.client || !sshConnection?.sftp) {
    throw Object.assign(new Error("SSH 尚未连接。"), { statusCode: 400 });
  }
  return sshConnection;
}

function parseSshTarget(input = "") {
  const cleaned = String(input || "").trim().replace(/^ssh\s+/i, "");
  const match = cleaned.match(/^([^@\s]+)@(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
  if (!match) throw Object.assign(new Error("SSH 用户格式应为：ssh 用户名@主机名"), { statusCode: 400 });
  const username = match[1];
  const host = match[2].replace(/^\[|\]$/g, "");
  const port = Number(match[3] || 22);
  if (!username || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("SSH 用户格式应为：ssh 用户名@主机名"), { statusCode: 400 });
  }
  return { username, host, port, label: `${username}@${host}${port === 22 ? "" : `:${port}`}` };
}

function sshRealpath(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.realpath(remotePath || ".", (error, resolved) => error ? reject(error) : resolve(resolved)); });
}
function sshReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.readdir(remotePath || ".", (error, rows) => error ? reject(error) : resolve(rows || [])); });
}
function sshStat(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.stat(remotePath, (error, stats) => error ? reject(error) : resolve(stats)); });
}
function sshReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.readFile(remotePath, (error, data) => error ? reject(error) : resolve(data)); });
}
function sshWriteFile(sftp, remotePath, content = "") {
  return new Promise((resolve, reject) => { sftp.writeFile(remotePath, content, "utf8", (error) => error ? reject(error) : resolve()); });
}
function sshMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.mkdir(remotePath, (error) => error ? reject(error) : resolve()); });
}
function sshUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.unlink(remotePath, (error) => error ? reject(error) : resolve()); });
}
function sshRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => { sftp.rmdir(remotePath, (error) => error ? reject(error) : resolve()); });
}
function sshRename(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => { sftp.rename(oldPath, newPath, (error) => error ? reject(error) : resolve()); });
}

function safeSshName(name = "") {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw Object.assign(new Error("名称不能为空。"), { statusCode: 400 });
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\0")) {
    throw Object.assign(new Error("名称不能包含路径分隔符。"), { statusCode: 400 });
  }
  return trimmed.slice(0, 180);
}

export function sshConnect({ target = "", password = "" } = {}) {
  const config = parseSshTarget(target);
  const secret = String(password || "");
  if (!secret) throw Object.assign(new Error("请输入 SSH 密码。"), { statusCode: 400 });
  closeSshConnection();
  const client = new SshClient();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch {}
      reject(error instanceof Error ? error : new Error(String(error || "SSH 连接失败")));
    };
    client.once("ready", () => {
      client.sftp(async (error, sftp) => {
        if (error) return fail(error);
        try {
          const home = await sshRealpath(sftp, ".");
          sshConnection = { client, sftp, ...config, home, cwd: home, connectedAt: new Date().toISOString() };
          client.on("close", () => { if (sshConnection?.client === client) sshConnection = null; });
          settled = true;
          resolve(sshStatusPayload());
        } catch (readError) {
          fail(readError);
        }
      });
    });
    client.once("error", fail);
    client.connect({ host: config.host, port: config.port, username: config.username, password: secret, readyTimeout: 15000, tryKeyboard: false });
  });
}

export async function listSshFiles(dir = "") {
  const connection = ensureSshConnection();
  const sftp = connection.sftp;
  const cwd = await sshRealpath(sftp, dir || connection.cwd || ".");
  const rows = await sshReaddir(sftp, cwd);
  const entries = rows
    .filter((row) => row.filename !== "." && row.filename !== "..")
    .map((row) => {
      const itemPath = posixPath.join(cwd, row.filename);
      const isDir = row.longname?.startsWith("d") || row.attrs?.isDirectory?.();
      return { name: row.filename, path: itemPath, type: isDir ? "dir" : "file", size: Number(row.attrs?.size) || 0, mtime: row.attrs?.mtime ? new Date(row.attrs.mtime * 1000).toISOString() : "" };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  connection.cwd = cwd;
  return { connected: true, label: connection.label, cwd, parent: cwd === "/" ? "/" : posixPath.dirname(cwd), entries };
}

export async function readSshFile(remotePath = "") {
  const connection = ensureSshConnection();
  const file = await sshRealpath(connection.sftp, remotePath);
  const info = await sshStat(connection.sftp, file);
  if (!info.isFile()) throw Object.assign(new Error("只能预览文件。"), { statusCode: 400 });
  if (info.size > 1024 * 1024) throw Object.assign(new Error("文件超过 1MB，暂不预览。"), { statusCode: 400 });
  const buffer = await sshReadFile(connection.sftp, file);
  if (buffer.includes(0)) throw Object.assign(new Error("二进制文件不能文本预览。"), { statusCode: 400 });
  return { type: "text", path: file, size: info.size, text: buffer.toString("utf8") };
}

export async function createSshFolder(dir = "", name = "") {
  const connection = ensureSshConnection();
  const parent = await sshRealpath(connection.sftp, dir || connection.cwd || ".");
  await sshMkdir(connection.sftp, posixPath.join(parent, safeSshName(name)));
  return listSshFiles(parent);
}

export async function createSshFile(dir = "", name = "", content = "") {
  const connection = ensureSshConnection();
  const parent = await sshRealpath(connection.sftp, dir || connection.cwd || ".");
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw Object.assign(new Error("文件内容不能超过 1MB。"), { statusCode: 400 });
  await sshWriteFile(connection.sftp, posixPath.join(parent, safeSshName(name)), text);
  return listSshFiles(parent);
}

export async function writeSshFile(remotePath = "", content = "") {
  const connection = ensureSshConnection();
  const file = await sshRealpath(connection.sftp, remotePath);
  const info = await sshStat(connection.sftp, file);
  if (!info.isFile()) throw Object.assign(new Error("只能编辑文件。"), { statusCode: 400 });
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw Object.assign(new Error("文件内容不能超过 1MB。"), { statusCode: 400 });
  await sshWriteFile(connection.sftp, file, text);
  return { ok: true, ...await readSshFile(file) };
}

async function deleteSshDirectoryRecursive(sftp, remotePath) {
  const rows = await sshReaddir(sftp, remotePath);
  for (const row of rows) {
    if (row.filename === "." || row.filename === "..") continue;
    const child = posixPath.join(remotePath, row.filename);
    if (row.longname?.startsWith("d") || row.attrs?.isDirectory?.()) await deleteSshDirectoryRecursive(sftp, child);
    else await sshUnlink(sftp, child);
  }
  await sshRmdir(sftp, remotePath);
}

export async function deleteSshPath(remotePath = "") {
  const connection = ensureSshConnection();
  const target = await sshRealpath(connection.sftp, remotePath);
  if (target === "/") throw Object.assign(new Error("不能删除远程根目录。"), { statusCode: 400 });
  const info = await sshStat(connection.sftp, target);
  const parent = target === "/" ? "/" : posixPath.dirname(target);
  if (info.isDirectory()) await deleteSshDirectoryRecursive(connection.sftp, target);
  else await sshUnlink(connection.sftp, target);
  return listSshFiles(parent);
}

export async function renameSshPath(remotePath = "", name = "") {
  const connection = ensureSshConnection();
  const target = await sshRealpath(connection.sftp, remotePath);
  const parent = target === "/" ? "/" : posixPath.dirname(target);
  await sshRename(connection.sftp, target, posixPath.join(parent, safeSshName(name)));
  return listSshFiles(parent);
}
