import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scroll jump controls avoid WebView font glyphs and scroll-container fixed positioning", async () => {
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");
  const logWrapStart = html.indexOf('<section class="remoteLogWrap">');
  const logWrapEnd = html.indexOf("</section>", logWrapStart);
  const layerIndex = html.indexOf('<div class="scrollJumpLayer">');
  const topButtonIndex = html.indexOf('id="scrollTopRemote"');
  const bottomButtonIndex = html.indexOf('id="scrollBottomRemote"');

  assert.ok(logWrapStart >= 0 && logWrapEnd > logWrapStart);
  assert.ok(layerIndex > logWrapEnd, "fixed jump controls must live outside the overflow scroller");
  assert.ok(topButtonIndex > layerIndex && bottomButtonIndex > topButtonIndex);
  assert.doesNotMatch(html, /scrollTopRemote[^>]*>\s*↑/);
  assert.doesNotMatch(html, /scrollBottomRemote[^>]*>\s*↓/);
  assert.match(html, /scrollTopRemote[\s\S]*?<svg class="scrollJumpIcon"[\s\S]*?<\/button>/);
  assert.match(html, /scrollBottomRemote[\s\S]*?<svg class="scrollJumpIcon"[\s\S]*?<\/button>/);
});

test("scroll jump controls use an isolated pointer-safe overlay and explicit icon centering", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const blockStart = styles.indexOf(".scrollJumpLayer");
  const block = styles.slice(blockStart, styles.indexOf(".remoteEvent", blockStart));

  assert.ok(blockStart >= 0 && block.length > 0);
  assert.match(block, /\.scrollJumpLayer\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?pointer-events:\s*none;/);
  assert.match(block, /\.scrollJump\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;/);
  assert.match(block, /\.scrollJump\s*\{[\s\S]*?-webkit-appearance:\s*none;[\s\S]*?appearance:\s*none;/);
  assert.match(block, /\.scrollJumpIcon\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
});
