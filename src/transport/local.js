import { spawn } from "node:child_process";

export class LocalTransport {
  constructor({ bin, args = [], cwd, env }) {
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this._onMessage = null;
    this._onError = null;
    this._onClose = null;
    this._buffer = "";
  }

  async start() {
    if (this.child && !this.child.killed) return;
    this._buffer = "";
    this.child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env || process.env,
      shell: process.platform === "win32"
    });
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(text);
    });
    this.child.on("error", (error) => this._onError?.(error));
    this.child.on("close", (code) => {
      this.child = null;
      this._onClose?.(code);
    });
  }

  _onStdout(chunk) {
    this._buffer += chunk.toString();
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this._onMessage?.(line);
    }
  }

  send(line) {
    if (!this.child?.stdin) throw new Error("transport not started");
    this.child.stdin.write(`${line}\n`);
  }

  onMessage(cb) { this._onMessage = cb; }
  onError(cb) { this._onError = cb; }
  onClose(cb) { this._onClose = cb; }

  kill() {
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch {}
      this.child = null;
    }
  }

  get alive() {
    return Boolean(this.child && !this.child.killed);
  }
}

export function createLocalAppServerTransport({ bin, model, reasoningEffort, cwd, env }) {
  return new LocalTransport({
    bin,
    args: [
      "app-server", "--stdio",
      "-c", `model="${model}"`,
      "-c", `model_reasoning_effort="${reasoningEffort}"`
    ],
    cwd,
    env
  });
}
