#!/usr/bin/env node
/**
 * Repeatable web client benchmark: bundle size, cold load, and the shared chat renderer.
 *
 * Run from apps/desktop (Node 22; Chrome drives over CDP; no new dependencies):
 *   npm run bench:webclient -- --out /tmp/webclient-bench.json
 *
 * A/B: pass --root <apps/desktop of the BEFORE tree> and --compare <apps/desktop of the AFTER tree>.
 * Runs alternate per iteration (A, B, A, B ...) in one session, and every run records the
 * machine's 1-minute load average. Both trees should run THIS harness (copy it in), so the
 * measuring code is identical on both sides. Without --compare, only --root (default: this
 * checkout) is measured.
 *
 * Sections (each timed section repeats --runs times, default 3; the JSON holds the median,
 * min, max and every run):
 *   1. bundle  `npm run build:webclient` (skip with --skip-build), then entry HTML + eager
 *              JS/CSS (raw and gzip), total JS/CSS, chunk count, and the 10 largest chunks.
 *              Deterministic: not affected by machine load.
 *   2. load    Cold start of dist/web-client from a local static server in headless Chrome,
 *              fresh profile and no cache per run. Reports the transfer bytes by kind (js, css,
 *              image, font, html, other), request count, same-origin vs external requests,
 *              first contentful paint, React mount (splash removed), the signed-out gate
 *              ("Sign in to ADE") visible, long tasks >50 ms counted until 2 s after the gate,
 *              and JS heap after GC. The request count and bytes are deterministic; the timings
 *              are not. Skip with --skip-load.
 *   3. chat    The shared renderer in the desktop browser mock: a dev server this run starts
 *              (`vite`, on a free port, never a server it did not start), replaying a real
 *              transcript through scripts/perf-chat-stream.mjs. Reports time from opening the
 *              chat to its first rows, per-streamed-event script, style and layout cost (CDP
 *              Performance metrics), React commits and DOM mutation records per streamed event,
 *              frame pacing, and composer keystroke-to-paint latency (50 keys) idle and while
 *              the turn streams. Commit and mutation counts during streaming have the typing
 *              cost subtracted (idle keystrokes measured the same way). Skip with --skip-chat.
 *              Transcript: --transcript <file.chat.jsonl>; default is the largest file in the
 *              primary project's .ade/transcripts.
 *   4. hosted  Not measured here. The real hosted client signed in over ADE Relay needs a Clerk
 *              sign-in and an attached machine, so remote-command counts are not measured.
 *
 * Options: --out <file>  --runs <n>  --skip-build  --skip-load  --skip-chat
 *          --root <apps/desktop dir>  --compare <apps/desktop dir>
 *          --root-label <name, default root>  --compare-label <name, default compare>
 *          --transcript <file>  --stream <events, 400>  --rate <events/s, 30>
 * Environment: CHROME_PATH overrides the Chrome binary.
 *
 * Caveats: headless Chrome, not a real window on a display. Wall-clock numbers are noisy on a
 * shared machine; read them next to contentionStart/contentionEnd and each run's loadavg1m.
 * Gate and mount times have ~10 ms polling granularity.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const checkoutDesktopDir = path.resolve(scriptDir, "..");
const checkoutRepoRoot = path.resolve(checkoutDesktopDir, "../..");
const workDir = path.join(os.tmpdir(), "ade-webclient-bench");
// The composer is a rich contentEditable editor or a textarea (its fallback). Several
// layout variants can carry the same attributes and only one is on screen, so take
// the first one that is rendered (offsetParent is null for display:none) and enabled.
const composerLookup = `[...document.querySelectorAll('[role="textbox"][data-chat-composer-text], textarea[data-chat-composer-text]')]
  .find((el) => el.offsetParent !== null && !el.disabled)`;
const gateText = "Sign in to ADE";

const argv = process.argv.slice(2);
function value(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return next;
}
const flag = (name) => argv.includes(name);
const options = {
  out: value("--out", null),
  runs: Number(value("--runs", 3)),
  transcript: value("--transcript", null),
  stream: Number(value("--stream", 400)),
  rate: Number(value("--rate", 30)),
  root: path.resolve(value("--root", checkoutDesktopDir)),
  compare: value("--compare", null) ? path.resolve(value("--compare", null)) : null,
  rootLabel: value("--root-label", "root"),
  compareLabel: value("--compare-label", "compare"),
};
if (!Number.isInteger(options.runs) || options.runs < 1) {
  console.error("--runs needs a positive integer");
  process.exit(2);
}

function makeSide(label, desktopDir) {
  const repoRoot = path.resolve(desktopDir, "../..");
  return {
    label,
    desktopDir,
    distDir: path.join(desktopDir, "dist/web-client"),
    perfChatStream: path.join(repoRoot, "scripts/perf-chat-stream.mjs"),
  };
}
const sides = [makeSide(options.rootLabel, options.root)];
if (options.compare) sides.push(makeSide(options.compareLabel, options.compare));

const round1 = (n) => Math.round(n * 10) / 10;
const kb = (bytes) => round1(bytes / 1024);
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (xs, p) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
};
function summarize(runs) {
  const keys = new Set(runs.flatMap((run) => Object.keys(run)));
  const summary = {};
  for (const key of keys) {
    const xs = runs.map((run) => run[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (xs.length) summary[key] = { median: round1(median(xs)), min: round1(Math.min(...xs)), max: round1(Math.max(...xs)), runs: xs.map(round1) };
  }
  return summary;
}

// ---------- Bundle ----------

function readEntryGraph(outputDir) {
  const indexPath = path.join(outputDir, "index.html");
  if (!fs.existsSync(indexPath)) throw new Error(`No built entry at ${indexPath}; run npm run build:webclient`);
  const html = fs.readFileSync(indexPath, "utf8");
  const readAttribute = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  };
  const eagerJs = new Set();
  const eagerCss = new Set();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tagName = match[1].toLowerCase();
    const tag = match[0];
    const relation = readAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    const reference = readAttribute(tag, tagName === "script" ? "src" : "href");
    if (!reference) continue;
    const local = new URL(reference, "https://webclient.invalid/");
    if (local.origin !== "https://webclient.invalid") continue;
    const file = path.resolve(outputDir, `.${decodeURIComponent(local.pathname)}`);
    if (tagName === "script" || relation.includes("modulepreload")) eagerJs.add(file);
    else if (relation.includes("stylesheet")) eagerCss.add(file);
  }
  return { html, eagerJs: [...eagerJs], eagerCss: [...eagerCss] };
}

function measureBundle(side) {
  if (!flag("--skip-build")) {
    const build = spawnSync("npm", ["run", "build:webclient"], { cwd: side.desktopDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (build.status !== 0) throw new Error(`build:webclient failed in ${side.label} (exit ${build.status}): ${(build.stderr || build.stdout).slice(-2000)}`);
  }
  const graph = readEntryGraph(side.distDir);
  const gz = (buf) => zlib.gzipSync(buf).length;
  const htmlBuf = Buffer.from(graph.html);
  const eagerJsSizes = graph.eagerJs.map((file) => {
    const buf = fs.readFileSync(file);
    return { file: path.relative(side.distDir, file), raw: buf.length, gzip: gz(buf) };
  });
  const assetFiles = fs.readdirSync(path.join(side.distDir, "assets"));
  const cssFiles = assetFiles.filter((f) => f.endsWith(".css"));
  const allJs = assetFiles.filter((f) => f.endsWith(".js"));
  const jsSizes = allJs.map((f) => {
    const buf = fs.readFileSync(path.join(side.distDir, "assets", f));
    return { file: `assets/${f}`, raw: buf.length, gzip: gz(buf) };
  });
  const totalCssRaw = cssFiles.reduce((s, f) => s + fs.statSync(path.join(side.distDir, "assets", f)).size, 0);
  const eagerJsRaw = eagerJsSizes.reduce((s, f) => s + f.raw, 0);
  const eagerJsGzip = eagerJsSizes.reduce((s, f) => s + f.gzip, 0);
  const eagerCssRaw = graph.eagerCss.reduce((s, file) => s + fs.statSync(file).size, 0);
  const top10 = [...jsSizes].sort((a, b) => b.raw - a.raw).slice(0, 10).map((f) => ({ file: f.file, rawKB: kb(f.raw), gzipKB: kb(f.gzip) }));
  return {
    entryHtmlKB: { raw: kb(htmlBuf.length), gzip: kb(gz(htmlBuf)) },
    eagerJsKB: { raw: kb(eagerJsRaw), gzip: kb(eagerJsGzip), files: eagerJsSizes.length },
    entryGraphKB: { raw: kb(htmlBuf.length + eagerJsRaw) },
    eagerCssKB: kb(eagerCssRaw),
    totalJsKB: kb(jsSizes.reduce((s, f) => s + f.raw, 0)),
    totalJsGzipKB: kb(jsSizes.reduce((s, f) => s + f.gzip, 0)),
    totalCssKB: kb(totalCssRaw),
    chunkCount: { js: allJs.length, css: cssFiles.length },
    top10LargestJs: top10,
  };
}

// ---------- Chrome + CDP ----------

function chromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("No Chrome found; set CHROME_PATH");
  return found;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function launchChrome(port, profileDir, url) {
  return spawn(
    chromeBinary(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--window-size=1440,900",
      url,
    ],
    { stdio: "ignore" },
  );
}

async function waitForPageTarget(port, predicate = () => true, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && predicate(t));
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    if (Date.now() > deadline) throw new Error(`No page target on Chrome port ${port}`);
    await delay(100);
  }
}

async function chromeVersion(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
}

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.once("open", () => resolve(new Cdp(ws)));
      ws.once("error", reject);
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`Page evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}

async function pollUntil(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(50);
  }
}

// Chrome keeps writing its profile for a moment after SIGTERM; wait for the exit,
// then remove the profile best-effort so cleanup never fails a run.
async function closeChrome(chrome, profile) {
  chrome.kill();
  await Promise.race([once(chrome, "exit"), delay(3_000)]);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Leftover temp files only; the measurements are already taken.
  }
}

// ---------- Cold load ----------

const LOAD_INIT_SCRIPT = `(() => {
  const b = (window.__adeBench = { longTasks: [], fcp: null, reactMountedAt: null, gateAt: null });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) b.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntriesByName("first-contentful-paint")) b.fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
  } catch {}
  const timer = setInterval(() => {
    const now = performance.now();
    const root = document.getElementById("root");
    if (b.reactMountedAt === null && root && root.childElementCount > 0 && !document.querySelector(".ade-splash")) {
      b.reactMountedAt = now;
    }
    if (b.gateAt === null && document.body && document.body.textContent.includes(${JSON.stringify(gateText)})) {
      b.gateAt = now;
      clearInterval(timer);
    }
  }, 10);
})()`;

// Counts React commits (through the DevTools global hook React reports into) and
// DOM mutation records, so chat runs can report work per streamed event.
const COUNT_INIT_SCRIPT = `(() => {
  window.__benchCommits = 0;
  window.__benchMutations = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { this.renderers.set(this.renderers.size + 1, renderer); return this.renderers.size; },
    onCommitFiberRoot() { window.__benchCommits += 1; },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((records) => { window.__benchMutations += records.length; })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  });
})()`;

// The welcome-video card (role=dialog) opens over the chat composer on a fresh
// browser profile and sits at its centre, so mouse focus lands on the card. Mark
// it dismissed in the mock's storage (browserMock.ts, ADE_WELCOME_VIDEO_ID/VERSION).
const WELCOME_DISMISSED_SCRIPT = `(() => {
  try {
    window.localStorage.setItem("ade.browserMock.welcomeVideoState", JSON.stringify({
      videoId: "64E0pViEiB8", version: 1, completedAt: null, dismissedAt: "2026-01-01T00:00:00.000Z",
    }));
  } catch {}
})()`;

function serveStatic(root) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.join(root, pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, "index.html");
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function transferKind(url) {
  const pathname = url.split("?")[0];
  if (/\.js$/.test(pathname)) return "js";
  if (/\.css$/.test(pathname)) return "css";
  if (/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(pathname)) return "image";
  if (/\.(woff2?|ttf|otf)$/i.test(pathname)) return "font";
  if (pathname === "" || pathname === "/" || pathname.endsWith(".html")) return "html";
  return "other";
}

let chromeName = null;

async function coldLoadRun(baseUrl) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bench-profile-"));
  const chrome = launchChrome(port, profile, "about:blank");
  let cdp = null;
  try {
    const target = await waitForPageTarget(port);
    chromeName ??= await chromeVersion(port);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    const urlById = new Map();
    const bytesByKind = { js: 0, css: 0, image: 0, font: 0, html: 0, other: 0 };
    const transfers = [];
    let requests = 0;
    let bytes = 0;
    let externalRequests = 0;
    let externalBytes = 0;
    cdp.on("Network.requestWillBeSent", (p) => {
      requests++;
      urlById.set(p.requestId, p.request.url);
    });
    cdp.on("Network.loadingFinished", (p) => {
      bytes += p.encodedDataLength;
      const url = urlById.get(p.requestId) ?? "";
      const local = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
      bytesByKind[transferKind(local)] += p.encodedDataLength;
      transfers.push({ url: local, kb: kb(p.encodedDataLength) });
      if (url && !url.startsWith(baseUrl)) {
        externalRequests++;
        externalBytes += p.encodedDataLength;
      }
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LOAD_INIT_SCRIPT });
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await pollUntil(() => evaluate(cdp, "window.__adeBench?.gateAt != null"), 60_000, "the signed-out gate");
    await delay(2_000);
    const bench = await evaluate(cdp, `(() => {
      const b = window.__adeBench;
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        fcp: b.fcp, reactMountedAt: b.reactMountedAt, gateAt: b.gateAt, longTasks: b.longTasks,
        domContentLoaded: nav?.domContentLoadedEventEnd ?? null, load: nav?.loadEventEnd ?? null,
      };
    })()`);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const longTaskDurations = bench.longTasks.map((t) => t[1]);
    return {
      requests,
      transferKB: kb(bytes),
      jsKB: kb(bytesByKind.js),
      cssKB: kb(bytesByKind.css),
      imageKB: kb(bytesByKind.image),
      fontKB: kb(bytesByKind.font),
      htmlKB: kb(bytesByKind.html),
      otherKB: kb(bytesByKind.other),
      externalRequests,
      externalKB: kb(externalBytes),
      fcpMs: bench.fcp == null ? null : round1(bench.fcp),
      reactMountedMs: bench.reactMountedAt == null ? null : round1(bench.reactMountedAt),
      gateVisibleMs: round1(bench.gateAt),
      domContentLoadedMs: bench.domContentLoaded == null ? null : round1(bench.domContentLoaded),
      loadEventMs: bench.load == null ? null : round1(bench.load),
      longTasks: longTaskDurations.length,
      longTaskTotalMs: round1(longTaskDurations.reduce((s, d) => s + d, 0)),
      longTaskMaxMs: round1(Math.max(0, ...longTaskDurations)),
      heapUsedMB: round1(heap.usedSize / 1024 / 1024),
      largestTransfers: [...transfers].sort((a, b) => b.kb - a.kb).slice(0, 12),
    };
  } finally {
    cdp?.close();
    await closeChrome(chrome, profile);
  }
}

// ---------- Chat renderer (desktop browser mock) ----------

function reachable(url) {
  return fetch(url).then((r) => r.ok, () => false);
}

// Always a dev server this run started, on a free port: another worktree's
// server on a fixed port would otherwise be measured as this checkout.
async function startDevServer(side) {
  const port = await freePort();
  const snapshot = spawnSync(process.execPath, ["scripts/export-browser-mock-ade-snapshot.mjs", "--optional"], { cwd: side.desktopDir, encoding: "utf8" });
  if (snapshot.status !== 0) throw new Error(`browser-mock snapshot export failed in ${side.label}: ${(snapshot.stderr || "").slice(-500)}`);
  const log = path.join(workDir, `vite-${side.label}.log`);
  const logFd = fs.openSync(log, "w");
  const child = spawn(process.execPath, [path.join(side.desktopDir, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"], {
    cwd: side.desktopDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  const url = `http://localhost:${port}`;
  await pollUntil(() => reachable(`${url}/`), 180_000, `the desktop Vite dev server for ${side.label}`);
  return { child, url };
}

function stopDevServer(server) {
  try {
    process.kill(-server.child.pid, "SIGTERM");
  } catch {
    // Already exited.
  }
}

// Other worktrees' Vite and Electron processes share this machine; record them
// at start and end so a noisy run is visible in the numbers' context.
function contention() {
  const lines = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout.split("\n");
  const count = (re) => lines.filter((line) => re.test(line) && !/bench-webclient/.test(line)).length;
  return {
    loadavg1m: round1(os.loadavg()[0]),
    viteServers: count(/vite(\.js)?\s.*--port/),
    chromeOrElectron: count(/Google Chrome|Chromium|Electron/),
  };
}

async function typeLatency(cdp, count, gapMs) {
  // Find the composer the way a user sees it: the first rendered, enabled
  // editor. Scroll it into view, then log what sits at its centre, so an overlay
  // that covers it shows up in the output instead of silently eating input.
  const target = await evaluate(cdp, `(() => {
    const el = ${composerLookup};
    if (!el) return { found: false };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const blocker = top && (top === el || el.contains(top)) ? null : top;
    const guard = blocker?.closest('[inert],[aria-hidden="true"],[data-state="open"]') ?? null;
    return {
      found: true,
      tag: el.tagName,
      editable: el.isContentEditable === true,
      x, y,
      width: Math.round(r.width),
      height: Math.round(r.height),
      blockedBy: blocker ? { tag: blocker.tagName, className: String(blocker.className ?? "").slice(0, 120), guard: guard ? guard.outerHTML.slice(0, 160) : null } : null,
    };
  })()`);
  if (!target.found) return { available: false };

  // Focus like a user: a real mouse press and release on the composer's centre.
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await delay(100);
  const focus = { ...target, focusedAfterClick: await evaluate(cdp, `(() => { const el = ${composerLookup}; return document.activeElement === el; })()`) };
  delete focus.x;
  delete focus.y;
  if (!focus.focusedAfterClick) return { available: false, focus, keystrokes: 0, applied: 0 };

  const counters = "({ commits: window.__benchCommits, mutations: window.__benchMutations })";
  // The textContent for a contenteditable, .value for a textarea; both have the typed text.
  const length = () => evaluate(cdp, `(() => { const el = ${composerLookup}; return el ? (el.value ?? el.textContent ?? "").length : -1; })()`);
  const before = await length();
  const counts0 = await evaluate(cdp, counters);
  const latencies = [];
  for (let i = 0; i < count; i++) {
    // IME-style text insertion goes through the editor's own input path.
    const t0 = await evaluate(cdp, "performance.now()");
    await cdp.send("Input.insertText", { text: "a" });
    // Double rAF: the first callback runs before the frame that paints the change,
    // so the second one lands after that frame.
    const painted = await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))");
    latencies.push(painted - t0);
    await delay(gapMs);
  }
  const counts1 = await evaluate(cdp, counters);
  const applied = (await length()) - before;
  // Remove the typed text (not measured).
  for (let i = 0; i < applied; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  }
  return {
    available: true,
    focus,
    keystrokes: count,
    applied,
    p50Ms: round1(percentile(latencies, 50)),
    p95Ms: round1(percentile(latencies, 95)),
    maxMs: round1(Math.max(...latencies)),
    commitsPerKey: (counts1.commits - counts0.commits) / count,
    mutationsPerKey: (counts1.mutations - counts0.mutations) / count,
  };
}

function pickTranscript() {
  if (options.transcript) return options.transcript;
  const commonDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkoutRepoRoot, encoding: "utf8" }).stdout.trim();
  const dir = path.join(path.dirname(commonDir), ".ade/transcripts");
  if (!fs.existsSync(dir)) throw new Error(`No transcripts directory at ${dir}; pass --transcript`);
  const largest = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".chat.jsonl"))
    .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  if (!largest) throw new Error(`No .chat.jsonl in ${dir}; pass --transcript`);
  return largest.file;
}

async function chatRun(side, transcript, devUrl) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bench-chat-"));
  const chrome = launchChrome(port, profile, `${devUrl}/work`);
  let keys = null;
  let child = null;
  try {
    const target = await waitForPageTarget(port, (t) => t.url.startsWith(devUrl));
    chromeName ??= await chromeVersion(port);
    keys = await Cdp.connect(target.webSocketDebuggerUrl);
    await keys.send("Runtime.enable");
    await keys.send("Page.enable");
    await keys.send("Page.addScriptToEvaluateOnNewDocument", { source: COUNT_INIT_SCRIPT });
    await keys.send("Page.addScriptToEvaluateOnNewDocument", { source: WELCOME_DISMISSED_SCRIPT });
    await keys.send("Page.navigate", { url: `${devUrl}/work` });
    // The emitter is installed when a chat pane subscribes, so this waits for the
    // whole desktop renderer to mount, including Vite's first dependency pre-bundle.
    await pollUntil(() => evaluate(keys, "typeof window.__adeMockEmitChatEvent === 'function'"), 240_000, "the mock chat emitter");

    const outFile = path.join(workDir, `chat-${side.label}-${Date.now()}.json`);
    const stderrLines = [];
    child = spawn(process.execPath, [
      side.perfChatStream, "--port", String(port), "--transcript", transcript,
      "--stream", String(options.stream), "--rate", String(options.rate),
      "--label", `chat-${side.label}`, "--out", outFile,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => stderrLines.push(String(chunk)));
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

    // Keystrokes and counter reads while the replayed turn streams: start once
    // perf-chat-stream has opened the chat and begun emitting live events.
    const streamingTyping = (async () => {
      await pollUntil(() => evaluate(keys, "window.__adeStreamBench?.on === true"), 240_000, "the streaming phase").catch(() => null);
      const start = await evaluate(keys, "({ commits: window.__benchCommits, mutations: window.__benchMutations })");
      const typing = await typeLatency(keys, 50, 120);
      return { start, typing };
    })().catch(() => ({ start: null, typing: {} }));
    const code = await exited;
    if (code !== 0) throw new Error(`perf-chat-stream exited ${code}: ${stderrLines.join("").slice(-1500)}`);
    const streamed = await streamingTyping;
    const end = await evaluate(keys, "({ commits: window.__benchCommits, mutations: window.__benchMutations })");
    const stream = JSON.parse(fs.readFileSync(outFile, "utf8"));
    const idle = await typeLatency(keys, 50, 120);

    // Typing during streaming also commits and mutates the DOM; take the idle per-key
    // cost out of the streaming window so the per-event numbers are the stream's own.
    const applied = streamed.typing.applied ?? 0;
    const commitsStream = streamed.start ? end.commits - streamed.start.commits - applied * (idle.commitsPerKey ?? 0) : null;
    const mutationsStream = streamed.start ? end.mutations - streamed.start.mutations - applied * (idle.mutationsPerKey ?? 0) : null;
    const events = stream.streamedEvents || 1;

    return {
      openToFirstRowsMs: stream.openToFirstRowsMs,
      streamedEvents: stream.streamedEvents,
      historyEvents: stream.historyEvents,
      scriptMsPerEvent: stream.scriptMsPerEvent,
      taskMsPerEvent: stream.taskMsPerEvent,
      styleMs: stream.styleMs,
      layoutMs: stream.layoutMs,
      commitsPerStreamedEvent: commitsStream == null ? null : round1(commitsStream / events),
      mutationsPerStreamedEvent: mutationsStream == null ? null : round1(mutationsStream / events),
      rendererCpuPct: stream.rendererCpuPct,
      frameP50Ms: stream.frameP50,
      frameP95Ms: stream.frameP95,
      frameMaxMs: stream.frameMax,
      framesOver33ms: stream.over33,
      loafCount: stream.loafCount,
      loafBlockingMs: stream.loafBlockingMs,
      // A keystroke that never reached the composer times a frame, not typing:
      // report null then, so only runs where input applied produce latency.
      keyStreamingP50Ms: applied > 0 ? streamed.typing.p50Ms ?? null : null,
      keyStreamingP95Ms: applied > 0 ? streamed.typing.p95Ms ?? null : null,
      keyStreamingMaxMs: applied > 0 ? streamed.typing.maxMs ?? null : null,
      keyStreamingApplied: applied,
      keyIdleP50Ms: (idle.applied ?? 0) > 0 ? idle.p50Ms : null,
      keyIdleP95Ms: (idle.applied ?? 0) > 0 ? idle.p95Ms : null,
      keyIdleMaxMs: (idle.applied ?? 0) > 0 ? idle.maxMs : null,
      keyIdleApplied: idle.applied ?? 0,
      keyFocus: idle.focus ?? null,
      keyIdleCommitsPerKey: idle.commitsPerKey == null ? null : round1(idle.commitsPerKey),
      keyIdleMutationsPerKey: idle.mutationsPerKey == null ? null : round1(idle.mutationsPerKey),
    };
  } finally {
    child?.kill();
    keys?.close();
    await closeChrome(chrome, profile);
  }
}

// ---------- Orchestration: interleaved A/B ----------

function loadAverage() {
  return round1(os.loadavg()[0]);
}

async function measureSides() {
  const transcript = pickTranscript();
  fs.mkdirSync(workDir, { recursive: true });

  for (const side of sides) {
    side.result = { root: side.desktopDir, errors: {} };
    try {
      side.result.bundle = measureBundle(side);
    } catch (error) {
      side.result.errors.bundle = error.message;
    }
  }

  if (!flag("--skip-load")) {
    const servers = await Promise.all(sides.map((side) => serveStatic(side.distDir)));
    try {
      const loadRuns = new Map(sides.map((side) => [side, []]));
      for (let i = 0; i < options.runs; i++) {
        for (const [index, side] of sides.entries()) {
          const baseUrl = `http://127.0.0.1:${servers[index].address().port}`;
          const loadavg1m = loadAverage();
          try {
            loadRuns.get(side).push({ ...(await coldLoadRun(baseUrl)), loadavg1m });
          } catch (error) {
            side.result.errors.load = error.message;
          }
        }
      }
      for (const side of sides) {
        const runs = loadRuns.get(side);
        side.result.load = { runs, summary: summarize(runs) };
      }
    } finally {
      for (const server of servers) server.close();
    }
  }

  if (!flag("--skip-chat")) {
    // One dev server per run, closed right after: no Vite or Chrome left running between steps.
    const chatRuns = new Map(sides.map((side) => [side, []]));
    for (let i = 0; i < options.runs; i++) {
      for (const side of sides) {
        const loadavg1m = loadAverage();
        let server = null;
        try {
          server = await startDevServer(side);
          chatRuns.get(side).push({ ...(await chatRun(side, transcript, server.url)), loadavg1m });
        } catch (error) {
          side.result.errors.chat = error.message;
        } finally {
          if (server) stopDevServer(server);
        }
      }
    }
    for (const side of sides) {
      const runs = chatRuns.get(side);
      side.result.chat = { transcript: path.basename(transcript), runs, summary: summarize(runs) };
    }
  }
}

// ---------- Main ----------

function gitInfo() {
  const git = (...args) => spawnSync("git", args, { cwd: checkoutRepoRoot, encoding: "utf8" }).stdout.trim();
  return {
    head: git("rev-parse", "--short", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    appSrcDiffStat: git("diff", "--stat", "--", "apps/desktop/src").split("\n").pop() || "clean",
    appSrcUntracked: git("ls-files", "--others", "--exclude-standard", "apps/desktop/src").split("\n").filter(Boolean).length,
  };
}

const result = {
  generatedAt: new Date().toISOString(),
  contentionStart: contention(),
  args: {
    runs: options.runs,
    stream: options.stream,
    rate: options.rate,
    interleaved: sides.length > 1,
    skipBuild: flag("--skip-build"),
    skipLoad: flag("--skip-load"),
    skipChat: flag("--skip-chat"),
  },
  machine: {
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cpus: os.cpus().length,
    memGB: round1(os.totalmem() / 1024 ** 3),
    node: process.version,
  },
  git: gitInfo(),
  sides: {},
};

try {
  await measureSides();
} catch (error) {
  result.fatal = error instanceof Error ? error.message : String(error);
}
for (const side of sides) {
  result.sides[side.label] = side.result ?? { root: side.desktopDir, fatal: "not run" };
  if (side.result?.errors && !Object.keys(side.result.errors).length) delete side.result.errors;
}
result.chrome = chromeName;
result.remoteCommands = { measured: false, reason: "needs a signed-in hosted client attached to a machine; not automated here" };
result.contentionEnd = contention();

const json = JSON.stringify(result, null, 2);
if (options.out) {
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, json);
}
console.log(json);
const anyError = result.fatal || sides.some((side) => side.result?.errors && Object.keys(side.result.errors).length);
process.exitCode = anyError ? 1 : 0;
