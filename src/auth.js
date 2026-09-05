import { authToken, authCookieName, routePrefix, externalBasePath } from "./config.js";
import { parseCookies, safeCompare } from "./utils.js";

export function authCookie(value, maxAge) {
  return `${authCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function isAuthenticated(req) {
  return safeCompare(parseCookies(req)[authCookieName], authToken);
}

export function routePath(pathname) {
  if (pathname === routePrefix) return "/";
  if (pathname.startsWith(`${routePrefix}/`)) return pathname.slice(routePrefix.length) || "/";
  return pathname;
}

export function routeBase(pathname, req = null) {
  const headerPrefix = req?.headers?.["x-forwarded-prefix"] || "";
  if (typeof headerPrefix === "string" && headerPrefix.startsWith("/")) return headerPrefix.replace(/\/+$/, "");
  if (pathname === routePrefix || pathname.startsWith(`${routePrefix}/`)) return routePrefix;
  return externalBasePath;
}

export function isPublicPath(pathname) {
  return ["/login.html", "/styles.css", "/site.webmanifest", "/icon.svg", "/pwa.js", "/sw.js", "/api/remote/login", "/api/remote/auth"].includes(pathname);
}

export function redirectToLogin(res, basePath = "") {
  res.writeHead(302, { Location: `${basePath}/login.html` });
  res.end();
}
