import WebSocket from "ws";

// Remote connections must never fall back to a local Codex process.
export class RemoteWebSocketTransport {
  constructor({ url, token = "", timeoutMs = 10000 }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.socket = null;
  }

  async start() {
    if (this.alive) return;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        handshakeTimeout: this.timeoutMs,
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
      });
      this.socket = socket;
      let opened = false;
      socket.once("open", () => { opened = true; resolve(); });
      socket.on("message", (data) => {
        if (this.socket === socket) this.messageHandler?.(data.toString());
      });
      socket.on("error", () => {
        const error = new Error("远端 Codex 连接失败，请检查地址、认证和网络。");
        reject(error);
        if (this.socket === socket) this.errorHandler?.(error);
      });
      socket.on("close", (code) => {
        if (!opened) reject(new Error("远端 Codex 在连接建立前断开。"));
        if (this.socket !== socket) return;
        this.socket = null;
        this.closeHandler?.(code);
      });
    });
  }

  onMessage(fn) { this.messageHandler = fn; }
  onError(fn) { this.errorHandler = fn; }
  onClose(fn) { this.closeHandler = fn; }
  get alive() { return this.socket?.readyState === WebSocket.OPEN; }
  send(line) {
    if (!this.alive) throw new Error("远端 Codex 未连接。");
    this.socket.send(line);
  }
  kill() {
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }
}
