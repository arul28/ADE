import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserWindow, session as electronSession } from "electron";

import { buildSceneDocument, escapeForScript } from "../../../shared/chatSceneDocument";
import {
  isSceneParseFailure,
  parseSceneFence,
  SCENE_CONTENT_SECURITY_POLICY,
  sceneFrameMessage,
} from "../../../shared/chatScene";
import {
  lintSceneSource,
  sceneSourceFromInput,
  scenePreviewTheme,
  SCENE_PREVIEW_WIDTH,
  type ScenePreviewProblem,
  type ScenePreviewRequest,
  type ScenePreviewResult,
} from "../../../shared/scenePreview";
import { isWoff2, SCENE_FONT_FACES, sceneFontFaceRule } from "../../../shared/sceneFontFaces";
import type { Logger } from "../logging/logger";

/**
 * `ade scene preview`, the desktop half.
 *
 * Draws one scene exactly as a chat would — `buildSceneDocument`, the in-frame
 * SDK, the scene policy, a `sandbox="allow-scripts"` frame with an opaque
 * origin — in a hidden offscreen window, and answers with a screenshot and the
 * problems it hit. Isolation, because the code is the agent's:
 *
 *  - an in-memory partition of its own: no cookies, storage or cache of the
 *    user's, and nothing kept after the window closes;
 *  - every network request refused at the session, on top of the scene's own
 *    `connect-src 'none'`;
 *  - no navigation, no popups, no permissions;
 *  - one render at a time, each with a hard deadline, and the window destroyed
 *    after every render.
 */

const PREVIEW_PARTITION = "scene-preview";
const PREVIEW_DEADLINE_MS = 20_000;
/**
 * The hard stop for one render. The settle deadline above is checked between
 * awaits, and a scene stuck in `while (true) {}` holds the renderer so no await
 * ever returns; past this the renderer is crashed and the window destroyed.
 */
const PREVIEW_HARD_DEADLINE_MS = 25_000;
/** After settle (or the deadline for one), wait this long for late errors. */
const LATE_ERROR_GRACE_MS = 300;
const MAX_CAPTURE_HEIGHT = 4_000;
const MAX_PROBLEMS = 40;

type PreviewState = {
  readyMs: number | null;
  settledMs: number | null;
  height: number;
  errors: string[];
};

let fontFaceCssCache: string | null = null;

/**
 * ADE's two variable fonts as `@font-face` data URLs, for parity with the
 * chat's frames. Packaged: the hashed copies in the renderer's assets. Dev: the
 * package files. Empty when neither is found; the scene then draws in the
 * system fallbacks.
 */
function resolveFontFaceCss(roots: { appPath: string; rendererDir: string }): string {
  if (fontFaceCssCache !== null) return fontFaceCssCache;
  const assetsDir = path.join(roots.rendererDir, "assets");
  let assets: string[] = [];
  try { assets = fs.readdirSync(assetsDir); } catch { assets = []; }
  const rules: string[] = [];
  for (const face of SCENE_FONT_FACES) {
    const asset = assets.find((name) => face.assetPattern.test(name));
    const file = asset ? path.join(assetsDir, asset) : path.join(roots.appPath, "node_modules", face.packageFile);
    try {
      const bytes = fs.readFileSync(file);
      if (isWoff2(bytes)) rules.push(sceneFontFaceRule(face.family, bytes.toString("base64")));
    } catch {
      // Not shipped here; the system fallback stands in.
    }
  }
  fontFaceCssCache = rules.join("\n");
  return fontFaceCssCache;
}

/** The page that hosts the scene frame and records what it reports. Ours, not the agent's. */
function hostPage(sceneDocument: string, width: number, background: string, nonce: string, data: unknown): string {
  // The live-data message the chat would post after ready, built here with the
  // protocol's own envelope so the page posts it as-is.
  const dataMessage = escapeForScript(data == null ? null : sceneFrameMessage({ type: "data", payload: data }));
  // The scene's own policy, on the host too: a srcdoc frame inherits its
  // parent's policy, so the host must allow exactly what a scene may do.
  const hostPolicy = SCENE_CONTENT_SECURITY_POLICY.split("; ").filter((rule) => !rule.startsWith("frame-src")).join("; ");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${hostPolicy}">
<style>html,body{margin:0;padding:0;background:${background};}iframe{display:block;border:0;width:${width}px;height:120px;background:transparent;}</style>
</head><body><script>
(function(){
  var state = { readyMs: null, settledMs: null, height: 120, errors: [] };
  var DATA_MESSAGE = ${dataMessage};
  window.__scenePreview = state;
  var t0 = 0;
  var frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow) return;
    var m = event.data;
    if (!m || m.__adeScene !== 1 || m.nonce !== ${JSON.stringify(nonce)}) return;
    var p = m.payload || {};
    if (typeof p.height === "number" && isFinite(p.height)) {
      state.height = Math.max(1, Math.min(${MAX_CAPTURE_HEIGHT}, Math.round(p.height)));
      frame.style.height = state.height + "px";
    }
    if (m.type === "ready" && state.readyMs === null) {
      state.readyMs = Math.round(performance.now() - t0);
      // As the chat does: the live-data snapshot follows ready.
      if (DATA_MESSAGE !== null) frame.contentWindow.postMessage(DATA_MESSAGE, "*");
    }
    if (m.type === "settled" && state.settledMs === null) state.settledMs = Math.round(performance.now() - t0);
    if (m.type === "error" && state.errors.length < ${MAX_PROBLEMS}) state.errors.push(String(p.message || "scene error"));
  });
  t0 = performance.now();
  frame.srcdoc = ${escapeForScript(sceneDocument)};
  document.body.appendChild(frame);
})();
</script></body></html>`;
}

let preparedSession: Electron.Session | null = null;

function previewSession(): Electron.Session {
  if (preparedSession) return preparedSession;
  const ses = electronSession.fromPartition(PREVIEW_PARTITION, { cache: false });
  preparedSession = ses;
  // Belt and braces: the scene's policy already allows no fetch. Anything that
  // is not the host page itself is refused.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed = url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:");
    callback({ cancel: !allowed });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

let busy: Promise<unknown> = Promise.resolve();

/** Render one scene. Serialized: a second call waits for the first. */
export function renderScenePreview(
  request: ScenePreviewRequest,
  deps: { appPath: string; rendererDir: string; logger?: Logger | null },
): Promise<ScenePreviewResult> {
  const run = busy.then(() => renderWithHardDeadline(request, deps));
  busy = run.catch(() => undefined);
  return run;
}

async function renderWithHardDeadline(
  request: ScenePreviewRequest,
  deps: { appPath: string; rendererDir: string; logger?: Logger | null },
): Promise<ScenePreviewResult> {
  const holder: { win: BrowserWindow | null } = { win: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<ScenePreviewResult>((resolve) => {
    timer = setTimeout(() => {
      const win = holder.win;
      if (win && !win.isDestroyed()) {
        try { win.webContents.forcefullyCrashRenderer(); } catch { /* already gone */ }
        win.destroy();
      }
      resolve({
        title: null,
        width: SCENE_PREVIEW_WIDTH.default,
        height: 0,
        readyMs: null,
        settledMs: null,
        screenshotBase64: null,
        problems: [{
          kind: "timeout",
          message: `The scene kept its page busy for ${PREVIEW_HARD_DEADLINE_MS / 1000}s and was stopped. Look for an endless loop in its script.`,
        }],
      });
    }, PREVIEW_HARD_DEADLINE_MS);
  });
  try {
    return await Promise.race([renderOnce(request, deps, holder), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function renderOnce(
  request: ScenePreviewRequest,
  deps: { appPath: string; rendererDir: string; logger?: Logger | null },
  holder: { win: BrowserWindow | null },
): Promise<ScenePreviewResult> {
  const source = sceneSourceFromInput(String(request.source ?? ""));
  const width = Math.round(Math.max(
    SCENE_PREVIEW_WIDTH.min,
    Math.min(SCENE_PREVIEW_WIDTH.max, Number(request.width) || SCENE_PREVIEW_WIDTH.default),
  ));
  const problems: ScenePreviewProblem[] = [...lintSceneSource(source)];
  const parsed = parseSceneFence(source);
  if (isSceneParseFailure(parsed)) {
    return {
      title: null,
      width,
      height: 0,
      readyMs: null,
      settledMs: null,
      screenshotBase64: null,
      problems: [...problems, { kind: "error", message: `The chat would show this as code, not a view: ${parsed.detail}` }],
    };
  }
  const theme = scenePreviewTheme(request.theme);
  const nonce = randomUUID();
  const sceneDocument = buildSceneDocument({
    html: parsed.html,
    title: parsed.title,
    theme,
    nonce,
    fontFaceCss: resolveFontFaceCss(deps),
  });

  const win = new BrowserWindow({
    show: false,
    width,
    height: 800,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    // Captures are as tall as the scene, which can exceed the screen.
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      session: previewSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      javascript: true,
    },
  });
  holder.win = win;
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    // The scene frame's own srcdoc load is the only navigation there is.
    if (!event.url.startsWith("about:srcdoc")) event.preventDefault();
  });
  contents.on("console-message", (...args: unknown[]) => {
    // Electron hands the details on the event object; older builds passed
    // (event, level, message) positionally with a numeric level.
    const event = args[0] as { level?: unknown; message?: unknown };
    const level = typeof event?.level === "string"
      ? event.level
      : (["verbose", "info", "warning", "error"][Number(args[1])] ?? "info");
    const message = String(event?.message ?? args[2] ?? "");
    // Uncaught errors arrive once more, cleaner, from the SDK's error handler.
    if (/^Uncaught /.test(message) || /Electron Security Warning/.test(message)) return;
    if ((level === "error" || level === "warning") && problems.length < MAX_PROBLEMS) {
      const kind = /Content Security Policy|Refused to/i.test(message) ? "policy" : "console";
      problems.push({ kind, message: message.slice(0, 500) });
    }
  });

  try {
    const html = hostPage(sceneDocument, width, theme.bg, nonce, request.data ?? null);
    await contents.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`);
    const readState = async (): Promise<PreviewState> =>
      (await contents.executeJavaScript("JSON.parse(JSON.stringify(window.__scenePreview))", true)) as PreviewState;

    const deadline = Date.now() + PREVIEW_DEADLINE_MS;
    let state = await readState();
    while (state.settledMs === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await readState();
    }
    await new Promise((resolve) => setTimeout(resolve, LATE_ERROR_GRACE_MS));
    state = await readState();
    if (state.readyMs === null) problems.push({ kind: "timeout", message: "The scene never finished loading (no ready)." });
    else if (state.settledMs === null) {
      problems.push({
        kind: "timeout",
        message: `The scene never settled within ${PREVIEW_DEADLINE_MS / 1000}s: a script that never returns (an endless loop) or a page that never stops changing. In the chat it would sit blank or never get a still.`,
      });
    }
    for (const message of state.errors) {
      if (problems.length >= MAX_PROBLEMS) break;
      problems.push({ kind: /policy/i.test(message) ? "policy" : "error", message });
    }

    const height = Math.max(1, Math.min(MAX_CAPTURE_HEIGHT, state.height));
    win.setContentSize(width, height);
    // Two frames for the resize to paint before the grab.
    await contents.executeJavaScript("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true)})})})", true);
    const image = await contents.capturePage({ x: 0, y: 0, width, height });
    return {
      title: parsed.title,
      width,
      height: state.height,
      readyMs: state.readyMs,
      settledMs: state.settledMs,
      screenshotBase64: image.isEmpty() ? null : image.toPNG().toString("base64"),
      problems: dedupeProblems(problems),
    };
  } catch (error) {
    deps.logger?.warn("scene.preview_failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function dedupeProblems(problems: ScenePreviewProblem[]): ScenePreviewProblem[] {
  const seen = new Set<string>();
  const out: ScenePreviewProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.kind}:${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(problem);
  }
  return out;
}
