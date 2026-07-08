import path from "node:path";
import { stat } from "node:fs/promises";
import { codexWorkDir, uploadDir } from "./config.js";

export function projectPath(input = "") {
  const raw = String(input || "");
  const root = path.resolve(codexWorkDir);
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("路径超出项目范围。");
  return resolved;
}

export function relativeProjectPath(file) {
  const relative = path.relative(codexWorkDir, file).replaceAll(path.sep, "/");
  return relative === "." ? "" : relative;
}

export async function assertProjectDirectory(input = "") {
  const dir = projectPath(input);
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error("请选择文件夹。 ");
  return dir;
}

export function stateCwdValue(input = "") {
  return relativeProjectPath(projectPath(input));
}

export function absoluteStateCwd(state = {}) {
  return projectPath(state.cwd || "");
}

export function safeStateCwdValue(input = "") {
  try {
    return stateCwdValue(input);
  } catch {
    return "";
  }
}

export function stateAbsoluteCwd(cwd = "") {
  try {
    return projectPath(cwd || "");
  } catch {
    return path.resolve(codexWorkDir);
  }
}

export function isAllowedDownload(file) {
  const resolved = path.resolve(file);
  const roots = [path.resolve(codexWorkDir), path.resolve(uploadDir)];
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}
