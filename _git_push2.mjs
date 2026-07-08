import { Client } from "ssh2";
import { readdir } from "node:fs/promises";
import path from "node:path";
import posix from "node:path/posix";

const HOST = "192.168.31.84", USER = "wangjiafeng", PWD = "1130";
const HOME = "/home/wangjiafeng";
const LOCAL = "E:/codex项目/codex远程网页连接";
const REMOTE = `${HOME}/codex-remote-main`;
const ORIGIN = "git@github.com:wang1510583/codex-remote.git";
const EXCLUDE = new Set([".git", "node_modules", "data", ".workbuddy", ".env"]);

async function walk(dir, base, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push({ local: full, remote: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}
function exec(conn, cmd, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
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
    await ensureDir(sftp, posix.dirname(dir));
    sftp.mkdir(dir, () => resolve());
  });
}
function uploadFile(sftp, localPath, remotePath) {
  return new Promise(async (resolve, reject) => {
    await ensureDir(sftp, posix.dirname(remotePath));
    sftp.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve());
  });
}

const conn = new Client();
conn.on("ready", async () => {
  try {
    const sftp = await new Promise((resolve, reject) => conn.sftp((err, s) => err ? reject(err) : resolve(s)));

    console.log("=== 清理 + git init + remote ===");
    let r = await exec(conn, `cd ${HOME} && rm -rf ${REMOTE} && mkdir -p ${REMOTE} && cd ${REMOTE} && git init -q && git remote add origin ${ORIGIN} && git ls-remote origin 2>&1 | head -5`);
    console.log("远程仓库分支:", r.out.trim() || r.errOut.trim());

    const files = await walk(LOCAL, LOCAL);
    console.log(`=== 上传 ${files.length} 个文件 ===`);
    for (const f of files) await uploadFile(sftp, f.local, `${REMOTE}/${f.remote}`);
    console.log("上传完成");

    console.log("=== commit + force push main ===");
    r = await exec(conn, `cd ${REMOTE} && git add -A && git -c user.name=wang1510583 -c user.email=1345914523@qq.com commit -q -m "refactor: 模块化拆分 server.js + 被控端交互式控制 + 备注名 + README" && git push -f origin HEAD:main 2>&1`);
    console.log("push main:", (r.out + r.errOut).trim());

    // 若远程默认是 master，也同步覆盖
    r = await exec(conn, `cd ${REMOTE} && git ls-remote origin 2>&1`);
    const branches = r.out;
    if (branches.includes("refs/heads/master")) {
      console.log("=== 检测到 master 分支，一并 force push 覆盖 ===");
      r = await exec(conn, `cd ${REMOTE} && git push -f origin HEAD:master 2>&1`);
      console.log("push master:", (r.out + r.errOut).trim());
    }

    console.log("\n=== 最终远程分支 ===");
    r = await exec(conn, `cd ${REMOTE} && git ls-remote origin 2>&1`);
    console.log(r.out.trim());

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
