export class SshExecTransport {
  constructor({ openChannel, label = "SSH Codex", onDispose = null }) {
    this.openChannel = openChannel;
    this.label = label;
    this.onDispose = onDispose;
    this.channel = null;
    this._starting = null;
    this._onMessage = null;
    this._onError = null;
    this._onClose = null;
    this._buffer = "";
    this._exitCode = 0;
    this.mode = "ssh";
  }

  async start() {
    if (this.alive) return;
    if (this._starting) return this._starting;
    const starting = (async () => {
      this._buffer = "";
      this._exitCode = 0;
      const channel = await this.openChannel();
      this.channel = channel;
      channel.on("data", (chunk) => {
        if (this.channel === channel) this._onStdout(chunk);
      });
      channel.stderr?.on("data", (chunk) => {
        if (this.channel !== channel) return;
        const text = chunk.toString().trim();
        if (text) console.error(`[${this.label}] ${text}`);
      });
      channel.on("error", (error) => {
        if (this.channel === channel) this._onError?.(error);
      });
      channel.on("exit", (code) => {
        if (Number.isInteger(code)) this._exitCode = code;
      });
      channel.on("close", (code) => {
        if (this.channel !== channel) return;
        this.channel = null;
        const exitCode = Number.isInteger(code) ? code : this._exitCode;
        this.onDispose?.(this);
        this._onClose?.(exitCode);
      });
    })();
    this._starting = starting;
    try {
      await starting;
    } finally {
      if (this._starting === starting) this._starting = null;
    }
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
    const channel = this.channel;
    if (!channel || channel.destroyed || channel.writableEnded) {
      throw new Error("SSH Codex app-server 尚未启动。");
    }
    channel.write(`${line}\n`);
  }

  onMessage(callback) { this._onMessage = callback; }
  onError(callback) { this._onError = callback; }
  onClose(callback) { this._onClose = callback; }

  kill() {
    const channel = this.channel;
    this.channel = null;
    if (!channel) return;
    this.onDispose?.(this);
    try { channel.close?.(); } catch {}
    try { channel.end?.(); } catch {}
  }

  get alive() {
    return Boolean(this.channel && !this.channel.destroyed && !this.channel.writableEnded);
  }
}
