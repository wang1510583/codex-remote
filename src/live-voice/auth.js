import { safeCompare } from "../utils.js";

function singleHeader(value) {
  return typeof value === "string" && value && !/[\r\n]/.test(value)
    ? value
    : "";
}

export function basicVoiceCredentials(req) {
  const header = singleHeader(req?.headers?.authorization);
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header);
  if (!match || match[1].length > 4096) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  };
}

export function isVoiceRequestAuthenticated(req, expectedToken) {
  if (!expectedToken) return false;
  const credentials = basicVoiceCredentials(req);
  return Boolean(credentials && safeCompare(credentials.password, expectedToken));
}

export function isTrustedVoiceOrigin(req) {
  const origin = singleHeader(req?.headers?.origin);
  const fetchSite = singleHeader(req?.headers?.["sec-fetch-site"]).toLowerCase();
  if (!origin || fetchSite !== "same-origin") return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.origin === origin
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}
