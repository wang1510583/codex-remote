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

test("mobile keyboard layout is one visual-viewport shell without scroll-chain gaps", async () => {
  const html = await readFile(new URL("../public/remote.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 700px)"));
  const viewport = source.slice(
    source.indexOf("function updateVisualViewport"),
    source.indexOf("function draftKeyFor")
  );

  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /<html[^>]*class="remotePageRoot"/);
  assert.match(html, /<body class="remotePage">/);
  assert.match(styles, /html\.remotePageRoot,[\s\S]*?body\.remotePage\s*\{[\s\S]*?overscroll-behavior:\s*none/);
  assert.match(styles, /\.remoteLogWrap\s*\{[\s\S]*?overscroll-behavior:\s*none/);
  assert.match(mobile, /\.remoteApp\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*var\(--visual-viewport-top\);[\s\S]*?grid-template-rows:[^;]*minmax\(0, 1fr\) auto;/);
  assert.match(mobile, /\.remoteLogWrap\s*\{[\s\S]*?grid-row:\s*2;[\s\S]*?height:\s*auto;/);
  assert.match(mobile, /\.remoteComposer\s*\{[\s\S]*?position:\s*relative;[\s\S]*?grid-row:\s*3;/);
  assert.match(mobile, /\.remoteComposer\s*\{[\s\S]*?min-height:\s*var\(--mobile-composer-min-height\)/);
  assert.doesNotMatch(mobile, /\.remoteComposer\s*\{[^}]*min-height:\s*var\(--mobile-composer-height\)/);
  assert.doesNotMatch(mobile, /\.remoteComposer\s*\{[^}]*bottom:\s*var\(--keyboard-offset\)/);
  assert.match(mobile, /\.scrollJumpLayer\s*\{[\s\S]*?position:\s*absolute;/);
  assert.match(viewport, /--visual-viewport-top/);
  assert.match(viewport, /--visual-viewport-height/);
  assert.match(viewport, /--mobile-composer-height/);
});
