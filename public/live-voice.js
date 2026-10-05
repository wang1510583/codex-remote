// Browser client for the existing Codex WebRTC gateway. Credentials stay in
// HttpOnly cookies; a short-lived ticket authenticates the signaling socket.
export class BrowserLiveVoice {
  constructor({ basePath = '', onStatus = () => {}, audio, env = globalThis }) {
    this.basePath = basePath;
    this.onStatus = onStatus;
    this.audio = audio;
    this.env = env;
    this.current = null;
  }
  get active() { return Boolean(this.current); }
  async start(threadId) {
    if (this.active) return;
    const e = this.env;
    if (!e.isSecureContext || !e.navigator?.mediaDevices?.getUserMedia || !e.RTCPeerConnection) {
      throw new Error('实时语音需要 HTTPS 和支持麦克风的浏览器。');
    }
    if (!threadId) throw new Error('请先创建或选择一个会话。');
    const session = { threadId, stream: null, pc: null, ws: null, muted: false };
    this.current = session;
    const alive = () => this.current === session;
    const fail = error => { if (alive()) this.stop(error?.message || String(error)); };
    this.onStatus('正在请求麦克风权限…');
    try {
      const stream = await e.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!alive()) { stream.getTracks().forEach(t => t.stop()); return; }
      session.stream = stream;
      const pc = session.pc = new e.RTCPeerConnection();
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      // Match Codex's WebRTC audio + event data channel SDP layout.
      pc.createDataChannel('oai-events');
      pc.ontrack = event => {
        if (!alive()) return;
        this.audio.srcObject = event.streams[0] || new e.MediaStream([event.track]);
        this.audio.play().catch(() => { if (alive()) this.onStatus('语音已连接，请点击播放按钮收听。'); });
      };
      pc.onconnectionstatechange = () => {
        if (!alive()) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(session.timeout);
          this.onStatus('实时语音已连接，可以开始说话。');
        }
        if (pc.connectionState === 'failed') fail(new Error('音频连接失败，请结束后重试。'));
        if (pc.connectionState === 'disconnected') this.onStatus('音频连接暂时中断…');
      };
      this.onStatus('正在连接 Codex 实时语音…');
      session.timeout = setTimeout(() => fail(new Error('实时语音连接超时，请重试。')), 60000);
      await pc.setLocalDescription(await pc.createOffer());
      if (!alive()) return;
      // Non-trickle offer: include gathered host candidates before forwarding.
      if (pc.iceGatheringState !== 'complete') await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', change); resolve(); };
        const change = () => { if (pc.iceGatheringState === 'complete') finish(); };
        const timer = setTimeout(finish, 2000);
        pc.addEventListener('icegatheringstatechange', change);
      });
      if (!alive()) return;
      session.abort = new AbortController();
      const path = `${this.basePath}/api/voice-agent/sessions/${encodeURIComponent(threadId)}`;
      const response = await e.fetch(`${path}/live-ticket`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: session.abort.signal });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || `语音连接失败 (${response.status})`);
      if (!alive()) return;
      const url = new URL(`${path}/live`, e.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = session.ws = new e.WebSocket(url.href);
      ws.onopen = () => { if (alive()) ws.send(JSON.stringify({ type: 'authenticate', ticket: result.data.ticket })); };
      ws.onerror = () => fail(new Error('语音信令连接失败。'));
      ws.onclose = () => fail(new Error('实时语音连接已关闭。'));
      let started = false;
      ws.onmessage = event => {
        if (!alive()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready' && !started) {
          started = true;
          ws.send(JSON.stringify({ type: 'start', sdp: pc.localDescription.sdp }));
        } else if (message.type === 'session.sdp') {
          pc.setRemoteDescription({ type: 'answer', sdp: message.sdp }).catch(fail);
        } else if (message.type === 'session.error') {
          fail(new Error(message.message || 'Codex 实时语音启动失败。'));
        } else if (message.type === 'session.closed') {
          this.stop('实时语音已结束');
        }
      };
    } catch (error) {
      if (!alive()) return;
      this.stop(error.name === 'NotAllowedError' ? '麦克风权限未允许，请在浏览器设置中开启。' : error.message);
    }
  }
  mute() {
    const session = this.current;
    if (!session) return false;
    session.muted = !session.muted;
    for (const track of session.stream?.getAudioTracks() || []) track.enabled = !session.muted;
    this.onStatus(session.muted ? '麦克风已静音' : '麦克风已开启');
    return session.muted;
  }
  stop(message = '实时语音已结束') {
    const session = this.current;
    this.current = null;
    if (session) {
      clearTimeout(session.timeout);
      session.abort?.abort();
      if (session.ws?.readyState === 1) session.ws.send(JSON.stringify({ type: 'stop' }));
      session.ws?.close();
      session.pc?.close();
      session.stream?.getTracks().forEach(track => track.stop());
    }
    this.audio.pause(); this.audio.srcObject = null;
    this.onStatus(message);
  }
}
