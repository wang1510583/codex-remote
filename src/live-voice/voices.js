export const CODEX_LIVE_VOICE_V3_VOICES = Object.freeze([
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove"
]);

export const DEFAULT_CODEX_LIVE_VOICE_V3_VOICE = "cove";

const supportedVoices = new Set(CODEX_LIVE_VOICE_V3_VOICES);

export function normalizeCodexLiveVoiceVoice(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return supportedVoices.has(normalized) ? normalized : null;
}

export function codexLiveVoiceOrDefault(value) {
  return normalizeCodexLiveVoiceVoice(value)
    || DEFAULT_CODEX_LIVE_VOICE_V3_VOICE;
}
