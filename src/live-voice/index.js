import {
  codexLiveVoiceAuthTimeoutMs,
  codexLiveVoiceEnabled,
  codexLiveVoiceReconnectGraceMs,
  codexLiveVoiceTaskRetentionMs,
  codexLiveVoiceTicketTtlMs,
  codexLiveVoiceToken,
  codexLiveVoiceVoice
} from "../config.js";
import { routePath } from "../auth.js";
import { LiveVoiceGateway } from "./gateway.js";
import { CodexLiveVoiceRuntime } from "./runtime.js";
import { CodexRemoteThreadAdapter } from "./thread-adapter.js";
import { LiveVoiceTicketStore } from "./tickets.js";

const gateway = new LiveVoiceGateway({
  token: codexLiveVoiceToken,
  enabled: codexLiveVoiceEnabled,
  voice: codexLiveVoiceVoice,
  authTimeoutMs: codexLiveVoiceAuthTimeoutMs,
  reconnectGraceMs: codexLiveVoiceReconnectGraceMs,
  taskRetentionMs: codexLiveVoiceTaskRetentionMs,
  ticketStore: new LiveVoiceTicketStore({
    ttlMs: codexLiveVoiceTicketTtlMs
  }),
  threadAdapter: new CodexRemoteThreadAdapter(),
  runtimeFactory: (options) => new CodexLiveVoiceRuntime(options),
  normalizePath: routePath
});

export function handleLiveVoiceHttp(req, res, url) {
  return gateway.handleHttp(req, res, url);
}

export function attachLiveVoiceWebSocket(server) {
  return gateway.attach(server);
}

export function liveVoiceGatewayStatus() {
  return {
    enabled: codexLiveVoiceEnabled,
    activeThreadIds: [...gateway.activeSessions.keys()]
  };
}
