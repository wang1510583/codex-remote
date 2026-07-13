import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const fileLocks = new Map();

function fallbackValue(fallback) {
  return typeof fallback === "function" ? fallback() : fallback;
}

async function readJsonUnlocked(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallbackValue(fallback);
    if (error instanceof SyntaxError) {
      console.error(`failed to parse ${file}; using fallback`, error.message);
      return fallbackValue(fallback);
    }
    throw error;
  }
}

async function writeJsonUnlocked(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, file);
}

export async function withJsonFileLock(file, task) {
  const key = path.resolve(file);
  const previous = fileLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  fileLocks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === current) fileLocks.delete(key);
  }
}

export function readJsonFile(file, fallback) {
  return readJsonUnlocked(file, fallback);
}

export function writeJsonFile(file, data) {
  return withJsonFileLock(file, () => writeJsonUnlocked(file, data));
}

export function updateJsonFile(file, fallback, update) {
  return withJsonFileLock(file, async () => {
    const current = await readJsonUnlocked(file, fallback);
    const next = await update(current);
    await writeJsonUnlocked(file, next);
    return next;
  });
}
