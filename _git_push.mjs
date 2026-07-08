import { Client } from "ssh2";
import { readdir, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import posix from "node:path/posix";

const HOST = "192.168.31.84", USER = "wangjiafeng", PWD = "1130";
const HOME = "/home/wangjiafeng";
const SERVER_LOCAL = "E:/codex项目/codex远程网页连接";
const SERVER_REMOTE = `${HOME}/codex-remote-main`;
const CONN_LOCAL = "E:/codex项目/codex-remote-connector";
const CONN_REMOTE = `${HOME}/codex-remote-connector`;
const EXCLUDE = new Set([".git", "node_modules", "data", ".workbuddy", ".env"]);

async function walk(dir, base, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) await walk(full, base, out);
    else out.push({ local: full, remote: rel });
  }
  return out;
}

function exec(conn, cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("exec timeout: " + cmd.slice(0, 60))), timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); return reject(err); }
      let out = "", errOut = "";
      stream.on("data", (d) => out += d.toString());
      stream.stderr.on("data", (d) => errOut += d.toString());
      stream.on("close", (code) => { clearTimeout(t); resolve({ code, out, errOut }); });
    });
  });
}

function ensureDir(sftp, dir) {
  return new Promise(async (resolve) => {
    if (!dir || dir === "." || dir === "/") return resolve();
    const parent = posix.dirname(dir);
    await ensureDir(sftp, parent);
    sftp.mkdir(dir, () => resolve());
  });
}

function uploadFile(sftp, localPath, remotePath) {
  return new Promise(async (resolve, reject) => {
    await ensureDir(sftp, posix.dirname(remotePath));
    sftp.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve());
  });
}

async function uploadDir(sftp, localBase, remoteBase, label) {
  const files = await walk(localBase, localBase);
  console.log(`[${label}] 上传 ${files.length} 个文件...`);
  for (const f of files) {
    await uploadFile(sftp, f.local, `${remoteBase}/${f.remote}`);
  }
  console.log(`[${label}] 上传完成`);
}

const conn = new Client();
conn.on("ready", async () => {
  try {
    const sftp = await new Promise((resolve, reject) => conn.sftp((err, s) => err ? reject(err) : resolve(s)));

    // ===== 总控端 =====
    console.log("=== 总控端：清理旧文件（保留 .git）===");
    let r = await exec(conn, `cd ${HOME} && find ${SERVER_REMOTE} -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +`);
    if (r.errOut) console.log("clean stderr:", r.errOut.slice(0, 200));

    await uploadDir(sftp, SERVER_LOCAL, SERVER_REMOTE, "总控端");

    console.log("=== 总控端：git commit + force push ===");
    r = await exec(conn, `cd ${SERVER_REMOTE} && git add -A && git -c user.name=wang1510583 -c user.email=1345914523@qq.com commit -q -m "refactor: 模块化拆分 server.js + 被控端交互式控制 + 备注名 + README" && git push -f origin HEAD:main 2>&1`);
    console.log("总控端 push:", r.out.trim() || r.errOut.trim() || "done");

    // ===== 被控端 =====
    console.log("=== 被控端：新建目录 + git init + remote ===");
    r = await exec(conn, `cd ${HOME} && rm -rf ${CONN_REMOTE} && mkdir -p ${CONN_REMOTE} && cd ${CONN_REMOTE} && git init -q && git remote add origin git@github.com:wang1510583/codex-remote-connector.git`);
    if (r.errOut) console.log("init stderr:", r.errOut.slice(0, 200));

    await uploadDir(sftp, CONN_LOCAL, CONN_REMOTE, "被控端");

    console.log("=== 被控端：git commit + force push ===");
    r = await exec(conn, `cd ${CONN_REMOTE} && git add -A && git -c user.name=wang1510583 -c user.email=1345914523@qq.com commit -q -m "init: connector v0.2.0 WebSocket 隧道 + 自动注册 install + README" && git push -f origin HEAD:main 2>&1`);
    console.log("被控端 push:", r.out.trim() || r.errOut.trim() || "done");

    conn.end();
    process.exit(0);
  } catch (error) {
    console.error("FAILED:", error.message || error);
    conn.end();
    process.exit(1);
  }
});
conn.on("error", (error) => { console.error("ssh error:", error.message); process.exit(1); });
conn.connect({ host: HOST, port: 22, username: USER, password: PWD, readyTimeout: 15000 });
