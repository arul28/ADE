#!/usr/bin/env node
/**
 * Generates the document shell the iOS app loads a scene into.
 *
 *   node apps/desktop/scripts/generate-ios-scene-shell.mjs           write the shell
 *   node apps/desktop/scripts/generate-ios-scene-shell.mjs --check   exit 1 when the checked-in shell is stale
 *
 * The scene document (the policy, the base styles, the in-frame SDK and
 * `ade.chart`) has one source: `buildSceneDocument` in
 * `src/shared/chatSceneDocument.ts`. iOS cannot run TypeScript, so this script
 * calls that function with placeholder tokens where the per-scene values go and
 * writes the result to `apps/ios/ADE/Resources/SceneShell.html`. Swift
 * (`WorkSceneDocument.swift`) fills the tokens at run time and never assembles
 * markup of its own.
 *
 * It also writes `apps/ios/ADE/Resources/SceneThree.js`, the three.js bundle
 * desktop inlines into 3D scenes (`sceneThreeBundle.mjs`); Swift fills the
 * shell's THREE token with it for a scene that uses it.
 *
 * Run it after any change to `chatScene.ts`, `chatSceneDocument.ts`,
 * `chatSceneChart.ts`, `chatSceneThree.ts` or the three.js version, and
 * commit the result. `--check` is the drift guard, and
 * CI runs it (the `lint-desktop` job).
 *
 * `--check` also guards the scene policy's other hand-kept copy: the hosted web
 * client serves the scene frame's page with the policy as a response header
 * (`src/renderer/webclient/public/_headers`), and that file cannot import it.
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleSceneThree } from "./sceneThreeBundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const outPath = path.resolve(desktopRoot, "../ios/ADE/Resources/SceneShell.html");
/** three.js for 3D scenes, the same bytes desktop inlines; Swift fills the THREE token with it. */
const threePath = path.resolve(desktopRoot, "../ios/ADE/Resources/SceneThree.js");
const headersPath = path.join(desktopRoot, "src/renderer/webclient/public/_headers");
/** The paths the web client's scene frame is served at; see the comments in `_headers`. */
const SCENE_FRAME_PATHS = ["/scene-frame.html", "/scene-frame"];

/** Every token Swift fills. `WorkSceneDocument.swift` reads the same list. */
const token = (name) => `@@ADE_IOS:${name}@@`;
const TOKENS = {
  body: token("BODY"),
  nonce: token("NONCE"),
  restored: token("RESTORED"),
  scheme: token("SCHEME"),
  fontSize: token("FONT_SIZE"),
  bg: token("BG"),
  surface: token("SURFACE"),
  border: token("BORDER"),
  fg: token("FG"),
  fgMuted: token("FG_MUTED"),
  accent: token("ACCENT"),
  success: token("SUCCESS"),
  warning: token("WARNING"),
  danger: token("DANGER"),
  fontSans: token("FONT_SANS"),
  fontMono: token("FONT_MONO"),
  // three.js for a scene that uses it (`sceneUsesThree`), empty otherwise.
  three: token("THREE"),
};

/**
 * A phone lays a page with no viewport out 980 px wide and scales it down.
 * Desktop frames ignore this tag, so it is added here and not in the shared
 * builder. It goes AFTER the policy: the policy stays the first thing in <head>.
 */
const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">';

function fail(message) {
  console.error(`generate-ios-scene-shell: ${message}`);
  process.exit(1);
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Replace `from` with `to`, and stop when it is not there exactly `times` times. */
function replaceExactly(source, from, to, times, what) {
  const found = countOf(source, from);
  if (found !== times) fail(`expected ${times} of ${what}, found ${found}. The scene document changed shape; update this script.`);
  return source.split(from).join(to);
}

async function loadBuilder() {
  const dir = mkdtempSync(path.join(tmpdir(), "ade-ios-scene-shell-"));
  const outfile = path.join(dir, "chatSceneDocument.mjs");
  try {
    await build({
      stdin: {
        contents: [
          'export { buildSceneDocument } from "./chatSceneDocument";',
          'export { SCENE_CONTENT_SECURITY_POLICY } from "./chatScene";',
        ].join("\n"),
        resolveDir: path.join(desktopRoot, "src/shared"),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The header lines `_headers` sets for one path: the indented lines under the
 * line that is exactly that path, up to the next line that is not indented.
 */
function headerLinesFor(headersText, routePath) {
  const lines = headersText.split(/\r?\n/);
  const start = lines.indexOf(routePath);
  if (start < 0) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    block.push(line.trim());
  }
  return block;
}

/** Stop when the web client does not serve the scene frame with today's scene policy. */
function checkWebClientHeaders(policy) {
  let text = "";
  try { text = readFileSync(headersPath, "utf8"); } catch { /* missing counts as wrong */ }
  const wanted = `Content-Security-Policy: ${policy}; frame-ancestors 'self'`;
  const shown = path.relative(process.cwd(), headersPath);
  for (const routePath of SCENE_FRAME_PATHS) {
    const block = headerLinesFor(text, routePath);
    if (!block) fail(`${shown} has no entry for ${routePath}.`);
    if (!block.includes(wanted)) {
      fail(`${shown} does not serve ${routePath} with the scene policy. Its entry needs exactly this line:\n  ${wanted}`);
    }
  }
}

async function generate() {
  const { buildSceneDocument, SCENE_CONTENT_SECURITY_POLICY } = await loadBuilder();
  let html = buildSceneDocument({
    html: TOKENS.body,
    title: null,
    data: null,
    nonce: TOKENS.nonce,
    restored: false,
    fontFaceCss: "",
    threeSource: TOKENS.three,
    scopeKey: null,
    theme: {
      bg: TOKENS.bg,
      surface: TOKENS.surface,
      border: TOKENS.border,
      fg: TOKENS.fg,
      fgMuted: TOKENS.fgMuted,
      accent: TOKENS.accent,
      success: TOKENS.success,
      warning: TOKENS.warning,
      danger: TOKENS.danger,
      fontSans: TOKENS.fontSans,
      fontMono: TOKENS.fontMono,
      scheme: TOKENS.scheme,
      fontSize: TOKENS.fontSize,
    },
  });

  // The two values the builder does not write as a quoted string.
  html = replaceExactly(
    html,
    `"fontSize":"${TOKENS.fontSize}"`,
    `"fontSize":${TOKENS.fontSize}`,
    1,
    "the theme's fontSize in window.__ADE_SCENE_THEME__",
  );
  html = replaceExactly(
    html,
    "window.__ADE_SCENE_RESTORED__ = false;",
    `window.__ADE_SCENE_RESTORED__ = ${TOKENS.restored};`,
    1,
    "the restored flag",
  );

  const policyLine = html.split("\n")[2] ?? "";
  if (!html.startsWith('<!doctype html>\n<html lang="en"><head>\n<meta http-equiv="Content-Security-Policy" content="')) {
    fail("the Content-Security-Policy meta is no longer the first element in <head>.");
  }
  html = replaceExactly(html, `${policyLine}\n`, `${policyLine}\n${VIEWPORT_META}\n`, 1, "the policy line");

  // Each color and font goes in twice (a CSS variable and ade.theme); the
  // scheme and font size too; the rest once.
  const expected = { body: 1, nonce: 1, restored: 1, three: 1 };
  for (const [name, value] of Object.entries(TOKENS)) {
    const want = expected[name] ?? 2;
    const found = countOf(html, value);
    if (found !== want) fail(`token ${value} appears ${found} times, expected ${want}.`);
  }
  const strays = html.match(/@@ADE_IOS:[A-Z_]+@@/g).filter((found) => !Object.values(TOKENS).includes(found));
  if (strays.length) fail(`unknown tokens in the shell: ${[...new Set(strays)].join(", ")}`);
  return { html: html.endsWith("\n") ? html : `${html}\n`, policy: SCENE_CONTENT_SECURITY_POLICY };
}

const { html, policy } = await generate();
const three = await bundleSceneThree();
if (!three) fail("the three.js bundle came out empty.");
if (process.argv.includes("--check")) {
  for (const [file, wanted] of [[outPath, html], [threePath, three]]) {
    let current = "";
    try { current = readFileSync(file, "utf8"); } catch { /* missing counts as stale */ }
    if (current !== wanted) {
      fail(`${path.relative(process.cwd(), file)} is stale. Run: node apps/desktop/scripts/generate-ios-scene-shell.mjs`);
    }
  }
  console.log("iOS scene shell and three.js bundle are up to date.");
  checkWebClientHeaders(policy);
  console.log(`The web client serves ${SCENE_FRAME_PATHS.join(" and ")} with the scene policy.`);
} else {
  writeFileSync(outPath, html);
  console.log(`Wrote ${path.relative(process.cwd(), outPath)} (${html.length} bytes).`);
  writeFileSync(threePath, three);
  console.log(`Wrote ${path.relative(process.cwd(), threePath)} (${three.length} bytes).`);
}
