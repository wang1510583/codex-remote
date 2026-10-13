import assert from "node:assert/strict";
import test from "node:test";
import { readBody } from "../src/utils.js";

test("readBody decodes multibyte UTF-8 split across request chunks", async () => {
  const bytes = Buffer.from(JSON.stringify({ message: "中文路径/你好" }));
  const request = {
    async *[Symbol.asyncIterator]() {
      for (const byte of bytes) yield Buffer.from([byte]);
    }
  };
  assert.deepEqual(await readBody(request), { message: "中文路径/你好" });
});
