import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

export class LocalTransport {
  constructor({ bin, args = [], cwd, env, spawnImpl = spawn, platform = process.platform }) {
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.child = null;
    this._onMessage = null;
    this._onError = null;
    this._onClose = null;
    this._buffer = "";
  }

  async start() {
    if (this.child && !this.child.killed) return;
    this._buffer = "";
    const child = this.spawnImpl(this.bin, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env || process.env,
      shell: this.platform === "win32"
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this._onStdout(chunk, child));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(text);
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) this._onError?.(error);
    });
    child.on("error", (error) => {
      if (this.child === child) this._onError?.(error);
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this._onClose?.(code);
    });
  }

  _onStdout(chunk, child = this.child) {
    if (this.child !== child) return;
    this._buffer += chunk.toString();
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this._onMessage?.(line);
    }
  }

  send(line) {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("transport not started");
    }
    child.stdin.write(`${line}\n`);
  }

  onMessage(cb) { this._onMessage = cb; }
  onError(cb) { this._onError = cb; }
  onClose(cb) { this._onClose = cb; }

  kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill("SIGTERM"); } catch {}
  }

  get alive() {
    return Boolean(this.child && !this.child.killed);
  }
}

export class UnixWebSocketTransport {
  constructor({ socketPath, openTimeoutMs = 1500, WebSocketClass = WebSocket }) {
    this.socketPath = socketPath;
    this.openTimeoutMs = openTimeoutMs;
    this.WebSocketClass = WebSocketClass;
    this.socket = null;
    this._starting = null;
    this._onMessage = null;
    this._onError = null;
    this._onClose = null;
  }

  async start() {
    if (this.alive) return;
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      const socket = new this.WebSocketClass(`ws+unix://${this.socketPath}:/`, {
        perMessageDeflate: false,
        handshakeTimeout: this.openTimeoutMs
      });
      this.socket = socket;
      let opened = false;
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error("连接共享 Codex app-server 超时。"));
      }, this.openTimeoutMs);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        try { socket.terminate?.(); } catch {}
        reject(error);
      };

      socket.once("open", () => {
        if (settled) return;
        opened = true;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        this._onMessage?.(data.toString());
      });
      socket.on("error", (error) => {
        if (!opened) fail(error);
        else if (this.socket === socket) this._onError?.(error);
      });
      socket.on("close", (code) => {
        const wasCurrent = this.socket === socket;
        if (wasCurrent) this.socket = null;
        if (!opened) {
          fail(new Error(`共享 Codex app-server 连接已关闭：${code}`));
        } else if (wasCurrent) {
          this._onClose?.(code);
        }
      });
    });
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  send(line) {
    if (!this.alive) throw new Error("transport not started");
    this.socket.send(line);
  }

  onMessage(cb) { this._onMessage = cb; }
  onError(cb) { this._onError = cb; }
  onClose(cb) { this._onClose = cb; }

  kill() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try { socket.close(); } catch {}
    try { socket.terminate?.(); } catch {}
  }

  get alive() {
    const open = this.WebSocketClass.OPEN ?? 1;
    return Boolean(this.socket && this.socket.readyState === open);
  }
}

export class FallbackTransport {
  constructor({ preferred, fallback, onFallback = null }) {
    this.preferred = preferred;
    this.fallback = fallback;
    this.onFallback = onFallback;
    this.active = null;
    this.mode = "";
    this._starting = null;
    this._onMessage = null;
    this._onError = null;
    this._onClose = null;
  }

  bind(transport) {
    transport.onMessage((line) => {
      if (this.active === transport) this._onMessage?.(line);
    });
    transport.onError((error) => {
      if (this.active === transport) this._onError?.(error);
    });
    transport.onClose((code) => {
      if (this.active !== transport) return;
      this.active = null;
      this._onClose?.(code);
    });
  }

  async activate(transport, mode) {
    this.bind(transport);
    await transport.start();
    if (!transport.alive) throw new Error(`Codex ${mode} transport 启动后已关闭。`);
    this.active = transport;
    this.mode = mode;
  }

  async start() {
    if (this.alive) return;
    if (this._starting) return this._starting;
    const starting = this.startPreferredOrFallback();
    this._starting = starting;
    try {
      await starting;
    } finally {
      if (this._starting === starting) this._starting = null;
    }
  }

  async startPreferredOrFallback() {
    this.active = null;
    this.mode = "";
    try {
      await this.activate(this.preferred, "shared");
      return;
    } catch (error) {
      try { this.preferred.kill?.(); } catch {}
      this.onFallback?.(error);
    }
    await this.activate(this.fallback, "standalone");
  }

  async fallbackToStandalone() {
    if (this.active === this.fallback && this.fallback.alive) return false;
    const previous = this.active;
    this.active = null;
    this.mode = "";
    try { previous?.kill?.(); } catch {}
    await this.activate(this.fallback, "standalone");
    return true;
  }

  send(line) {
    if (!this.active) throw new Error("transport not started");
    this.active.send(line);
  }

  onMessage(cb) { this._onMessage = cb; }
  onError(cb) { this._onError = cb; }
  onClose(cb) { this._onClose = cb; }

  kill() {
    const active = this.active;
    this.active = null;
    this.mode = "";
    try { active?.kill?.(); } catch {}
  }

  get alive() { return Boolean(this.active?.alive); }
  get usingShared() { return this.mode === "shared" && this.alive; }
}

function sharedSocketPath(env = process.env) {
  if (env.CODEX_APP_SERVER_SOCKET) return env.CODEX_APP_SERVER_SOCKET;
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  return path.join(codexHome, "app-server-control", "app-server-control.sock");
}

function sharedTransportEnabled(env = process.env) {
  if (process.platform === "win32") return false;
  return !/^(0|false|no|off)$/i.test(String(env.CODEX_REMOTE_SHARED_APP_SERVER ?? "true"));
}

export function createLocalAppServerTransport({ bin, model, reasoningEffort, cwd, env }) {
  const args = ["app-server", "--stdio"];
  if (model) args.push("-c", `model="${model}"`);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  const standalone = new LocalTransport({
    bin,
    args,
    cwd,
    env
  });
  if (!sharedTransportEnabled(env)) return standalone;
  const preferred = new UnixWebSocketTransport({ socketPath: sharedSocketPath(env) });
  return new FallbackTransport({
    preferred,
    fallback: standalone,
    onFallback: (error) => {
      console.warn(`共享 Codex app-server 不可用，已回退到独立进程：${error?.message || error}`);
    }
  });
}
