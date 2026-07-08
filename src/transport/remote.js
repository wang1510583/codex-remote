export class RemoteTransport {
  constructor({ channel, connectorId, startTimeoutMs = 30000 }) {
    this.channel = channel;
    this.connectorId = connectorId;
    this.startTimeoutMs = startTimeoutMs;
    this._onMessage = null;
    this._onError = null;
    this._onClose = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    if (!this.channel.alive) throw new Error("被控端未连接");
    this.channel.onMessage((msg) => this._handle(msg));
    const ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    const timer = setTimeout(() => {
      this._readyReject?.(new Error("被控端 app-server 启动超时。"));
    }, this.startTimeoutMs);
    this.channel.send({ type: "appserver/start" });
    try {
      await ready;
      this._started = true;
    } finally {
      clearTimeout(timer);
    }
  }

  _handle(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "appserver/ready") {
      this._readyResolve?.();
    } else if (msg.type === "appserver/start_failed") {
      this._readyReject?.(new Error(msg.message || "被控端 app-server 启动失败"));
    } else if (msg.type === "appserver/stderr" && msg.text) {
      console.error(`[connector:${this.connectorId}] ${msg.text}`);
    } else if (msg.type === "appserver/closed") {
      this._started = false;
      this._onClose?.(msg.code ?? 0);
    } else if (msg.type === "appserver/error") {
      this._onError?.(new Error(msg.message || "被控端 app-server 错误"));
    } else if (msg.type === "rpc" && typeof msg.line === "string") {
      this._onMessage?.(msg.line);
    }
  }

  send(line) {
    if (!this.channel.alive) throw new Error("被控端连接已断开");
    this.channel.send({ type: "rpc", line });
  }

  onMessage(cb) { this._onMessage = cb; }
  onError(cb) { this._onError = cb; }
  onClose(cb) { this._onClose = cb; }

  kill() {
    if (this.channel.alive) {
      try { this.channel.send({ type: "appserver/stop" }); } catch {}
    }
    this._started = false;
  }

  get alive() {
    return this._started && this.channel.alive;
  }
}
