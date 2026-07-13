import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { codexWorkDir, generatedImageDir, uploadDir } from "../src/config.js";
import { allowedDownloadRoots, isAllowedDownload } from "../src/paths.js";

test("download roots are supplied from runtime configuration", () => {
  const roots = allowedDownloadRoots();
  assert.deepEqual(roots, [...new Set([codexWorkDir, uploadDir, generatedImageDir].map((root) => path.resolve(root)))]);
  assert.equal(isAllowedDownload(path.join(generatedImageDir, "thread", "image.png")), true);
});
