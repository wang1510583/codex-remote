import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

export function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength);
}

export function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export async function readBody(req, maxLength = 40000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > maxLength) throw new Error("请求内容太长。");
  }
  return body ? JSON.parse(body) : {};
}

export async function readRawBody(req, maxBytes = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("文件太大，单次上传最多 50MB。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashSecret(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function safeName(name) {
  return path.basename(String(name || "file")).replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_").slice(0, 120) || "file";
}

export function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip"
  }[ext] || "application/octet-stream";
}

export function formatBytes(size = 0) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function isPreviewText(file) {
  return /\.(txt|md|json|js|css|html|xml|svg|log|toml|ya?ml|csv|ts|tsx|jsx|py|sh|env|gitignore)$/i.test(file);
}

export function safeFolderName(name = "") {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw Object.assign(new Error("文件夹名称不能为空。"), { statusCode: 400 });
  if (trimmed === "." || trimmed === "..") throw Object.assign(new Error("文件夹名称无效。"), { statusCode: 400 });
  if (/[<>:"/\\|?*\x00-\x1F]/.test(trimmed)) throw Object.assign(new Error("文件夹名称不能包含特殊路径字符。"), { statusCode: 400 });
  return trimmed;
}

export function safeProjectFileName(name = "") {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw Object.assign(new Error("文件名不能为空。"), { statusCode: 400 });
  if (trimmed === "." || trimmed === "..") throw Object.assign(new Error("文件名无效。"), { statusCode: 400 });
  if (/[<>:"/\\|?*\x00-\x1F]/.test(trimmed)) throw Object.assign(new Error("文件名不能包含特殊路径字符。"), { statusCode: 400 });
  return trimmed;
}

export function rpcErrorMessage(error) {
  if (!error) return "Codex app-server 调用失败";
  if (typeof error === "string") return error;
  return error.message || error.data || JSON.stringify(error);
}

export function connectorNow() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
