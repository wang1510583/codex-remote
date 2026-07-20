import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ordinary request failures are not broadcast as task errors", async () => {
  const routerSource = await readFile(new URL("../src/router.js", import.meta.url), "utf8");
  const catchBlock = routerSource.slice(
    routerSource.lastIndexOf("  } catch (error) {"),
    routerSource.indexOf("\n  }\n}\n\nfunction absoluteCwdLocal")
  );
  assert.doesNotMatch(catchBlock, /broadcast\(\{\s*type:\s*["']error["']/);
  assert.match(catchBlock, /json\(res, statusCode,/);
});

test("task completion preserves the final live reply instead of rebuilding messages", async () => {
  const remoteSource = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const doneHandler = remoteSource.slice(
    remoteSource.indexOf('if (data.type === "done")'),
    remoteSource.indexOf('if (data.type === "thread_completion"')
  );
  assert.doesNotMatch(doneHandler, /loadState|renderState|innerHTML/);
  assert.match(doneHandler, /scheduleThreadListRefresh\(250\)/);
});
