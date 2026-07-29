import { createHash } from "node:crypto";
import posixPath from "node:path/posix";
import { Client as SshClient } from "ssh2";
import { CodexAppServer } from "./codex-server.js";
import { codexModel, codexReasoningEffort, sshProfilePath } from "./config.js";
import { readJsonFile, updateJsonFile } from "./json-file.js";
import { SshExecTransport } from "./transport/ssh.js";
import { mimeType } from "./utils.js";

let sshConnection = null;
const activeTransports = new Set();
const controlAppServers = new Map();

function sshError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function shellQuote(value = "") {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function sshConnectorId(target = "") {
  const parsed = typeof target === "string" ? parseSshTarget(target) : target;
  const identity = `${parsed.username}@${parsed.host.toLowerCase()}:${parsed.port}`;
  return `ssh_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export function isSshConnectorId(value = "") {
  return /^ssh_[a-f0-9]{20}$/.test(String(value || ""));
}

function emptyProfile() {
  return { device: null };
}

async function readProfile() {
  const value = await readJsonFile(sshProfilePath, emptyProfile);
  return value?.device && typeof value.device === "object" ? value.device : null;
}

async function saveProfile(device) {
  await updateJsonFile(sshProfilePath, emptyProfile, async () => ({ device }));
}

export function closeSshConnection() {
  for (const transport of activeTransports) {
    try { transport.kill(); } catch {}
  }
  activeTransports.clear();
  controlAppServers.clear();
  if (sshConnection?.client) {
    try { sshConnection.client.end(); } catch {}
  }
  sshConnection = null;
}

function publicSshDevice(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    name: connection.remark || connection.label,
    hostname: connection.host,
    platform: connection.platform || "linux",
    arch: connection.arch || "",
    version: "",
    codexVersion: connection.codexVersion || "",
    remark: connection.remark || "",
    registeredAt: connection.registeredAt || connection.connectedAt || "",
    lastSeen: connection.connectedAt || "",
    online: true,
    tunnelConnected: true,
    connectionType: "ssh",
    lastStatus: "connected",
    lastError: ""
  };
}

export function connectedSshDevice() {
  return publicSshDevice(sshConnection);
}

export async function savedSshDevice() {
  const profile = await readProfile();
  if (!profile?.id) return null;
  const connected = sshConnection?.id === profile.id;
  return {
    id: profile.id,
    name: profile.remark || profile.label || profile.id,
    hostname: profile.host || "",
    platform: profile.platform || "linux",
    arch: profile.arch || "",
    version: "",
    codexVersion: profile.codexVersion || "",
    remark: profile.remark || "",
    registeredAt: profile.registeredAt || "",
    lastSeen: connected ? sshConnection.connectedAt : (profile.lastConnectedAt || ""),
    online: connected,
    tunnelConnected: connected,
    connectionType: "ssh",
    lastStatus: connected ? "connected" : "disconnected",
    lastError: ""
  };
}

export function sshStatusPayload() {
  return sshConnection ? {
    connected: true,
    connectorId: sshConnection.id,
    label: sshConnection.label,
    cwd: sshConnection.cwd || sshConnection.home || ".",
    home: sshConnection.home || ".",
    codexVersion: sshConnection.codexVersion || "",
    platform: sshConnection.platform || "",
    arch: sshConnection.arch || "",
    connectedAt: sshConnection.connectedAt
  } : { connected: false };
}

function ensureSshConnection(connectorId = "") {
  if (!sshConnection?.client || !sshConnection?.sftp) throw sshError("SSH 尚未连接。", 409);
  if (connectorId && sshConnection.id !== connectorId) throw sshError("这个 SSH 设备尚未连接。", 409);
  return sshConnection;
}

export function isSshOnline(connectorId = "") {
  return Boolean(sshConnection && (!connectorId || sshConnection.id === connectorId));
}

export function parseSshTarget(input = "") {
  const cleaned = String(input || "").trim().replace(/^ssh\s+/i, "");
  const match = cleaned.match(/^([^@\s]+)@(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
  if (!match) throw sshError("SSH 用户格式应为：用户名@主机名");
  const username = match[1];
  const host = match[2].replace(/^\[|\]$/g, "");
  const port = Number(match[3] || 22);
  if (!username || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw sshError("SSH 用户格式应为：用户名@主机名");
  }
  return { username, host, port, label: `${username}@${host}${port === 22 ? "" : `:${port}`}` };
}

function sshRealpath(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.realpath(remotePath || ".", (error, resolved) => error ? reject(error) : resolve(resolved)));
}
function sshReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.readdir(remotePath || ".", (error, rows) => error ? reject(error) : resolve(rows || [])));
}
function sshStat(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.stat(remotePath, (error, stats) => error ? reject(error) : resolve(stats)));
}
function sshReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.readFile(remotePath, (error, data) => error ? reject(error) : resolve(data)));
}
function sshWriteFile(sftp, remotePath, content = "") {
  return new Promise((resolve, reject) => sftp.writeFile(remotePath, content, "utf8", (error) => error ? reject(error) : resolve()));
}
function sshMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.mkdir(remotePath, (error) => error ? reject(error) : resolve()));
}
function sshUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.unlink(remotePath, (error) => error ? reject(error) : resolve()));
}
function sshRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.rmdir(remotePath, (error) => error ? reject(error) : resolve()));
}
function sshRename(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => sftp.rename(oldPath, newPath, (error) => error ? reject(error) : resolve()));
}
function sshFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()));
}

function execChannel(client, command) {
  return new Promise((resolve, reject) => client.exec(command, { pty: false }, (error, channel) => error ? reject(error) : resolve(channel)));
}

async function execText(client, command, timeoutMs = 15000) {
  const channel = await execChannel(client, command);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const timer = setTimeout(() => {
      try { channel.close(); } catch {}
      reject(sshError("SSH 命令执行超时。", 504));
    }, timeoutMs);
    channel.on("data", (chunk) => { stdout += chunk.toString(); });
    channel.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    channel.on("exit", (code) => { if (Number.isInteger(code)) exitCode = code; });
    channel.on("error", (error) => { clearTimeout(timer); reject(error); });
    channel.on("close", () => {
      clearTimeout(timer);
      if (exitCode) reject(sshError(stderr.trim() || `SSH 命令退出：${exitCode}`, 502));
      else resolve(stdout.trim());
    });
  });
}

async function probeCodex(client) {
  const candidates = ["codex", "$HOME/.local/bin/codex", "$HOME/.npm-global/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex"];
  const command = `for c in ${candidates.join(" ")}; do p=$(command -v "$c" 2>/dev/null || true); if [ -n "$p" ] && [ -x "$p" ]; then readlink -f "$p" 2>/dev/null || printf '%s\\n' "$p"; break; fi; done`;
  const codexPath = await execText(client, command);
  if (!codexPath || !codexPath.startsWith("/")) {
    throw sshError("远程电脑未找到 Codex CLI。请先安装 Codex，并确保 codex 命令可用。", 409);
  }
  const [codexVersion, system, arch] = await Promise.all([
    execText(client, `${shellQuote(codexPath)} --version`),
    execText(client, "uname -s"),
    execText(client, "uname -m")
  ]);
  if (!/^linux$/i.test(system)) throw sshError(`首版 SSH Codex 仅支持 Linux，远端系统是 ${system || "未知"}。`, 409);
  return { codexPath, codexVersion, platform: system.toLowerCase(), arch };
}

export async function sshConnect({ target = "", password = "" } = {}) {
  const config = parseSshTarget(target);
  const secret = String(password || "");
  if (!secret) throw sshError("请输入 SSH 密码。");
  closeSshConnection();
  const saved = await readProfile();
  const id = sshConnectorId(config);
  const client = new SshClient();
  let observedFingerprint = "";
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
          const [home, probe] = await Promise.all([sshRealpath(sftp, "."), probeCodex(client)]);
          const connectedAt = new Date().toISOString();
          const profile = {
            id, ...config, ...probe,
            hostFingerprint: observedFingerprint,
            remark: saved?.id === id ? (saved.remark || "") : "",
            registeredAt: saved?.id === id && saved.registeredAt ? saved.registeredAt : connectedAt,
            lastConnectedAt: connectedAt
          };
          sshConnection = { client, sftp, ...profile, home, cwd: home, connectedAt };
          client.on("close", () => { if (sshConnection?.client === client) sshConnection = null; });
          await saveProfile(profile);
          settled = true;
          resolve(sshStatusPayload());
        } catch (readError) {
          fail(readError);
        }
      });
    });
    client.once("error", fail);
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: secret,
      readyTimeout: 15000,
      tryKeyboard: false,
      hostHash: "sha256",
      hostVerifier(hash) {
        observedFingerprint = hash;
        return !(saved?.id === id && saved.hostFingerprint && saved.hostFingerprint !== hash);
      }
    });
  });
}

export async function setSshRemark(connectorId, remark = "") {
  const profile = await readProfile();
  if (!profile || profile.id !== connectorId) throw sshError("SSH 设备不存在。", 404);
  profile.remark = String(remark || "").trim().slice(0, 120);
  if (sshConnection?.id === connectorId) sshConnection.remark = profile.remark;
  await saveProfile(profile);
  return { ok: true, id: connectorId, remark: profile.remark };
}

export function createSshAppServer(connectorId) {
  const connection = ensureSshConnection(connectorId);
  const command = `exec ${shellQuote(connection.codexPath)} app-server --stdio`;
  const transport = new SshExecTransport({
    label: `SSH Codex ${connection.label}`,
    openChannel: () => execChannel(ensureSshConnection(connectorId).client, command),
    onDispose: (item) => activeTransports.delete(item)
  });
  activeTransports.add(transport);
  const server = new CodexAppServer(transport, {
    model: codexModel,
    reasoningEffort: codexReasoningEffort,
    isRemote: true,
    resolveCwd: (state = {}) => String(state.cwd || connection.home)
  });
  server.connectorId = connectorId;
  return server;
}

export function getSshAppServer(connectorId) {
  let server = controlAppServers.get(connectorId);
  if (!server) {
    server = createSshAppServer(connectorId);
    controlAppServers.set(connectorId, server);
  }
  return server;
}

function safeSshName(name = "") {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw sshError("名称不能为空。");
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\0")) {
    throw sshError("名称不能包含路径分隔符。");
  }
  return trimmed.slice(0, 180);
}

export async function listSshFiles(dir = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const cwd = await sshRealpath(connection.sftp, dir || connection.cwd || ".");
  const rows = await sshReaddir(connection.sftp, cwd);
  const entries = rows.filter((row) => row.filename !== "." && row.filename !== "..").map((row) => {
    const itemPath = posixPath.join(cwd, row.filename);
    const isDir = row.longname?.startsWith("d") || row.attrs?.isDirectory?.();
    return {
      name: row.filename, path: itemPath, type: isDir ? "dir" : "file",
      size: Number(row.attrs?.size) || 0,
      mtime: row.attrs?.mtime ? new Date(row.attrs.mtime * 1000).toISOString() : ""
    };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  connection.cwd = cwd;
  return { connected: true, label: connection.label, cwd, absoluteCwd: cwd, parent: cwd === "/" ? "/" : posixPath.dirname(cwd), entries };
}

export async function readSshFile(remotePath = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const file = await sshRealpath(connection.sftp, remotePath);
  const info = await sshStat(connection.sftp, file);
  if (!info.isFile()) throw sshError("只能预览文件。");
  const mime = mimeType(file);
  if (/^image\//.test(mime)) {
    return {
      type: "image",
      path: file,
      size: Number(info.size) || 0,
      mime,
      url: `/api/remote/download?connector=${encodeURIComponent(connectorId || connection.id)}&p=${encodeURIComponent(file)}&inline=1`
    };
  }
  if (info.size > 1024 * 1024) throw sshError("文件超过 1MB，可直接下载。");
  const buffer = await sshReadFile(connection.sftp, file);
  if (buffer.includes(0)) throw sshError("二进制文件不能文本预览。");
  return { type: "text", path: file, size: info.size, mime, text: buffer.toString("utf8") };
}

export async function createSshFolder(dir = "", name = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const parent = await sshRealpath(connection.sftp, dir || connection.cwd || ".");
  await sshMkdir(connection.sftp, posixPath.join(parent, safeSshName(name)));
  return listSshFiles(parent, connectorId);
}

export async function createSshFile(dir = "", name = "", content = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const parent = await sshRealpath(connection.sftp, dir || connection.cwd || ".");
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw sshError("文件内容不能超过 1MB。");
  await sshWriteFile(connection.sftp, posixPath.join(parent, safeSshName(name)), text);
  return listSshFiles(parent, connectorId);
}

export async function writeSshFile(remotePath = "", content = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const file = await sshRealpath(connection.sftp, remotePath);
  const info = await sshStat(connection.sftp, file);
  if (!info.isFile()) throw sshError("只能编辑文件。");
  const text = String(content || "");
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw sshError("文件内容不能超过 1MB。");
  await sshWriteFile(connection.sftp, file, text);
  return { ok: true, ...await readSshFile(file, connectorId) };
}

async function deleteSshDirectoryRecursive(sftp, remotePath) {
  for (const row of await sshReaddir(sftp, remotePath)) {
    if (row.filename === "." || row.filename === "..") continue;
    const child = posixPath.join(remotePath, row.filename);
    if (row.longname?.startsWith("d") || row.attrs?.isDirectory?.()) await deleteSshDirectoryRecursive(sftp, child);
    else await sshUnlink(sftp, child);
  }
  await sshRmdir(sftp, remotePath);
}

export async function deleteSshPath(remotePath = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const target = await sshRealpath(connection.sftp, remotePath);
  if (target === "/") throw sshError("不能删除远程根目录。");
  const info = await sshStat(connection.sftp, target);
  const parent = posixPath.dirname(target);
  if (info.isDirectory()) await deleteSshDirectoryRecursive(connection.sftp, target);
  else await sshUnlink(connection.sftp, target);
  return listSshFiles(parent, connectorId);
}

export async function renameSshPath(remotePath = "", name = "", connectorId = "") {
  const connection = ensureSshConnection(connectorId);
  const target = await sshRealpath(connection.sftp, remotePath);
  const parent = posixPath.dirname(target);
  await sshRename(connection.sftp, target, posixPath.join(parent, safeSshName(name)));
  return listSshFiles(parent, connectorId);
}

export async function sshFileOp(connectorId, op, params = {}) {
  if (op === "list") return listSshFiles(params.dir, connectorId);
  if (op === "read") return readSshFile(params.path, connectorId);
  if (op === "mkdir") return createSshFolder(params.dir, params.name, connectorId);
  if (op === "createFile") return createSshFile(params.dir, params.name, params.content, connectorId);
  if (op === "write") return writeSshFile(params.path, params.content, connectorId);
  if (op === "delete") return deleteSshPath(params.path, connectorId);
  if (op === "rename") return renameSshPath(params.path, params.name, connectorId);
  throw sshError(`不支持的 SSH 文件操作：${op}`);
}

async function walkSessionFiles(sftp, dir, output) {
  let rows;
  try { rows = await sshReaddir(sftp, dir); } catch (error) {
    if (error?.code === 2) return;
    throw error;
  }
  for (const row of rows) {
    if (row.filename === "." || row.filename === "..") continue;
    const file = posixPath.join(dir, row.filename);
    if (row.longname?.startsWith("d") || row.attrs?.isDirectory?.()) await walkSessionFiles(sftp, file, output);
    else if (row.filename.endsWith(".jsonl")) output.push({ file, mtimeMs: Number(row.attrs?.mtime || 0) * 1000 });
  }
}

export function sshSessionProvider(connectorId) {
  return {
    async listFiles() {
      const connection = ensureSshConnection(connectorId);
      const rows = [];
      await walkSessionFiles(connection.sftp, posixPath.join(connection.home, ".codex", "sessions"), rows);
      return rows;
    },
    async readFile(file) {
      return (await sshReadFile(ensureSshConnection(connectorId).sftp, file)).toString("utf8");
    },
    async deleteFile(file) {
      await sshUnlink(ensureSshConnection(connectorId).sftp, file);
    }
  };
}

async function mkdirRecursive(sftp, remotePath) {
  if (!remotePath || remotePath === "/") return;
  const parent = posixPath.dirname(remotePath);
  if (parent !== remotePath) await mkdirRecursive(sftp, parent);
  try { await sshMkdir(sftp, remotePath); }
  catch (error) {
    if (error?.code !== 4) throw error;
    const info = await sshStat(sftp, remotePath).catch(() => null);
    if (!info?.isDirectory?.()) throw error;
  }
}

export async function uploadSshProject(connectorId, dir, staged) {
  const connection = ensureSshConnection(connectorId);
  const destination = await sshRealpath(connection.sftp, dir || connection.home);
  const conflicts = [];
  for (const row of staged.rows) {
    row.remotePath = posixPath.join(destination, ...row.relative.split("/"));
    try { await sshStat(connection.sftp, row.remotePath); conflicts.push(row.relative); }
    catch (error) { if (error?.code !== 2) throw error; }
  }
  if (conflicts.length) throw sshError(`已有同名文件：${conflicts.slice(0, 3).join("、")}。为避免覆盖，本次未上传任何文件。`, 409);
  const uploaded = [];
  try {
    for (const row of staged.rows) {
      await mkdirRecursive(connection.sftp, posixPath.dirname(row.remotePath));
      await sshFastPut(connection.sftp, row.stagedFile, row.remotePath);
      uploaded.push(row.remotePath);
    }
  } catch (error) {
    await Promise.all(uploaded.map((file) => sshUnlink(connection.sftp, file).catch(() => {})));
    throw error;
  }
  const dirs = new Set();
  for (const row of staged.rows) {
    const parts = row.relative.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    ok: true, cwd: destination, uploaded: staged.rows.length, directories: dirs.size,
    bytes: staged.rows.reduce((sum, row) => sum + row.size, 0),
    files: staged.rows.map((row) => ({ name: posixPath.basename(row.relative), path: row.remotePath, relativePath: row.relative, size: row.size }))
  };
}

export async function uploadSshAttachments(connectorId, files = []) {
  const connection = ensureSshConnection(connectorId);
  const destination = posixPath.join(
    connection.home,
    ".codex",
    "remote-uploads",
    new Date().toISOString().replace(/[:.]/g, "-")
  );
  await mkdirRecursive(connection.sftp, destination);
  const uploaded = [];
  for (const file of files) {
    const remotePath = posixPath.join(destination, safeSshName(file.name));
    await sshFastPut(connection.sftp, file.path, remotePath);
    uploaded.push({
      name: file.name,
      path: remotePath,
      size: file.size,
      url: `/api/remote/download?connector=${encodeURIComponent(connectorId)}&p=${encodeURIComponent(remotePath)}`
    });
  }
  return uploaded;
}

export async function sshDownloadTarget(connectorId, remotePath, expectedType = "") {
  const connection = ensureSshConnection(connectorId);
  const target = await sshRealpath(connection.sftp, remotePath);
  const info = await sshStat(connection.sftp, target);
  const type = info.isDirectory() ? "dir" : info.isFile() ? "file" : "";
  if (!type) throw sshError("只能下载文件或文件夹。");
  if (expectedType && expectedType !== type) throw sshError("文件类型已经变化，请刷新文件面板后重试。", 409);
  return {
    type, path: target, name: posixPath.basename(target) || "download", size: Number(info.size) || 0,
    stream: () => connection.sftp.createReadStream(target)
  };
}

export async function appendSshFolderToArchive(connectorId, archive, folder, archiveRoot) {
  const connection = ensureSshConnection(connectorId);
  for (const row of await sshReaddir(connection.sftp, folder)) {
    if (row.filename === "." || row.filename === "..") continue;
    const remote = posixPath.join(folder, row.filename);
    const archivePath = posixPath.join(archiveRoot, row.filename);
    if (row.longname?.startsWith("d") || row.attrs?.isDirectory?.()) {
      archive.append(Buffer.alloc(0), { name: `${archivePath}/` });
      await appendSshFolderToArchive(connectorId, archive, remote, archivePath);
    } else {
      archive.append(connection.sftp.createReadStream(remote), { name: archivePath });
    }
  }
}
