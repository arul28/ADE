#!/usr/bin/env node
/**
 * Streaming chat render cost: ADE against PandaCode and T3 Code, each a production web
 * build in the same headless Chrome, with the same streamed reply.
 *
 * The method is PandaCode's published one (github.com/aicodeking/pandacode,
 * bench/t3-compare/README.md); this runner is ADE's own code. It imports the workload
 * (W1: a 50,000-byte Markdown reply cut into 2,000 deltas of 25 B, one every 16 ms) and
 * the PandaCode and T3 delivery schedules from a PandaCode checkout at run time, so the
 * three apps get byte-identical provider deltas.
 *
 * What reaches each UI is what that app's own pipeline makes of the deltas:
 *   - ADE: the brain's 100 ms text buffer (agentChatService BUFFERED_TEXT_FLUSH_MS; the
 *     first delta arms the timer, later deltas join the pending text, the timer flushes
 *     it, turn end flushes the rest). Each event carries only the new text. Events go in
 *     through the browser preview's `window.__adeMockEmitChatEvent`, which calls the same
 *     chat event listeners the host's IPC events reach.
 *   - PandaCode: its 33 ms / 8 KiB coalescer, new text only, through `__previewEmit`.
 *   - T3 Code: its 50 ms provider flush and 50 ms live-event window, whole text so far,
 *     through the bench page's live thread subscription.
 *
 * Each run: a new Chrome, a new page, a chat that already holds 20 turns (T3's own
 * fixture text, rebuilt as ADE events for ADE), then the reply or, for the idle
 * baseline, the same 32 s with nothing delivered. Measured from just before the first
 * delivery to 1 s after the frame that shows the reply's last line: CDP TaskDuration
 * (and its script, layout and style parts), last delivery to final paint, worst timer
 * lateness, JS heap after a forced GC before and after, and DOM mutation records.
 *
 * Builds (once):
 *   ADE:       cd apps/desktop && NODE_ENV=production npx vite build --mode production --outDir <ade-dist>
 *   PandaCode: npm ci; ./node_modules/.bin/vite build --outDir bench/t3-compare/.dist-pandacode
 *   T3 Code:   pnpm install; T3CODE_DIR=<t3> sh <pandacode>/bench/t3-compare/setup-t3.sh
 *
 * Usage:
 *   node scripts/perf/ui/stream-render-compare.mjs --pandacode <checkout> --t3 <checkout>
 *     --ade-dist <dir> [--runs 5] [--apps ade,pandacode,t3] [--out <file.json>]
 *     [--chrome <binary>] [--profile <prefix>] [--ade-init <file.js>] [--label <name>] [--ade-flush-ms 100]
 *     [--modes w1,idle] [--screencast <dir>] [--after-eval <expression>]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const pandacodeDir = flag("--pandacode");
const t3Dir = flag("--t3");
const adeDist = flag("--ade-dist");
const runs = Number(flag("--runs", 5));
const apps = String(flag("--apps", "ade,pandacode,t3")).split(",").map((name) => name.trim()).filter(Boolean);
const out = flag("--out");
/** Writes a CPU profile of each streamed run to `<prefix>-<app>-<round>.cpuprofile`. */
const profilePrefix = flag("--profile");
/** A script run before ADE's page loads (an A/B arm: a localStorage setting, a style override). */
const adeInit = flag("--ade-init");
/** A second ADE arm in the same run ("ade-b" in --apps): its own init script and label, interleaved with the rest. */
const adeBInit = flag("--ade-b-init");
const adeBLabel = flag("--ade-b-label", "ADE (B)");
/** A name for this run in the summary and the JSON (e.g. the A/B arm). */
const label = flag("--label", "run");
/** Records the first 6 s of each streamed run (live screencast, 60 fps PNGs) into `<dir>/<app>-<round>/`. Costs CPU: not for measuring. */
const screencastDir = flag("--screencast");
/** ADE's brain text buffer in ms (agentChatService BUFFERED_TEXT_FLUSH_MS); another value models a change to it. */
const adeFlushMs = Number(flag("--ade-flush-ms", 100));
/** A page expression printed after each run (a debug counter a temporary build keeps on `window`). */
const afterEval = flag("--after-eval");
/** Which modes run: the streamed reply (w1), the idle baseline, or both. */
const modes = String(flag("--modes", "w1,idle")).split(",").map((m) => m.trim());
if (!modes.every((m) => m === "w1" || m === "idle")) throw new Error("--modes takes w1, idle or both");
const chromeBinary = flag("--chrome", process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
if (!pandacodeDir) throw new Error("--pandacode <checkout> is required (it holds the workload and schedules)");
if (apps.includes("t3") && !t3Dir) throw new Error("--t3 <checkout> is required to run T3 Code");
if ((apps.includes("ade") || apps.includes("ade-b")) && !adeDist) throw new Error("--ade-dist <dir> is required to run ADE");
if (apps.includes("ade-b") && !adeBInit) throw new Error("--ade-b-init <file.js> is required for ade-b");
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

const benchDir = path.join(pandacodeDir, "bench", "t3-compare");
const { W1_TEXT, W1_DELTAS, W1_TIMES, SENTINEL } = await import(pathToFileURL(path.join(benchDir, "workload.mjs")).href);
const { pandacodeSchedule, t3Schedule } = await import(pathToFileURL(path.join(benchDir, "schedule.mjs")).href);

/** ADE's brain text buffer: the first delta arms a 100 ms timer, the timer flushes, turn end flushes the rest. */
function adeSchedule(times, sizes, flushMs = 100) {
  const plan = [];
  let end = 0;
  let armedAt = null;
  times.forEach((at, index) => {
    if (armedAt !== null && armedAt + flushMs <= at) {
      plan.push({ at: armedAt + flushMs, end });
      armedAt = null;
    }
    end += sizes[index];
    armedAt ??= at;
  });
  if (armedAt !== null) plan.push({ at: times.at(-1), end });
  return plan;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sizes = W1_DELTAS.map((delta) => delta.length);
const VIEWPORT = { width: 1440, height: 940, deviceScaleFactor: 2 };
const SETTLE_MS = 1_000;
const HISTORY_TURNS = 20;

const APPS = {
  ade: {
    label: "ADE",
    port: 4175,
    cwd: path.join(repoRoot, "apps", "desktop"),
    serve: [path.join(repoRoot, "apps", "desktop", "node_modules", ".bin", "vite"), "preview", "--outDir", adeDist ?? ""],
    path: "/work",
    plan: adeSchedule(W1_TIMES, sizes, adeFlushMs),
  },
  "ade-b": {
    label: adeBLabel,
    port: 4177,
    cwd: path.join(repoRoot, "apps", "desktop"),
    serve: [path.join(repoRoot, "apps", "desktop", "node_modules", ".bin", "vite"), "preview", "--outDir", adeDist ?? ""],
    path: "/work",
    plan: adeSchedule(W1_TIMES, sizes, adeFlushMs),
  },
  pandacode: {
    label: "PandaCode",
    port: 4173,
    cwd: pandacodeDir,
    serve: ["./node_modules/.bin/vite", "preview", "--outDir", "bench/t3-compare/.dist-pandacode"],
    path: "/",
    plan: pandacodeSchedule(W1_TIMES, sizes),
  },
  t3: {
    label: "T3 Code",
    port: 4174,
    cwd: t3Dir ? path.join(t3Dir, "apps", "web") : "",
    serve: ["./node_modules/.bin/vp", "preview", "--config", "zbench/vite.bench.config.ts"],
    path: "/zbench/bench.html",
    plan: t3Schedule(W1_TIMES, sizes),
  },
};
for (const name of apps) if (!APPS[name]) throw new Error(`unknown app ${name}; use ade, pandacode or t3`);

// The preview CLIs start child processes, so each server gets its own process group.
const stopGroup = (child) => {
  try {
    if (process.platform === "win32") {
      // A child that already exited no longer owns its PID, and Windows may have given it to another process.
      if (child.exitCode === null && child.signalCode === null) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid);
    }
  } catch (error) {
    // ESRCH: the group is already gone.
    if (error?.code !== "ESRCH") console.warn(`could not stop preview server ${child.pid}: ${error?.message ?? error}`);
  }
};

async function serve(app) {
  const child = spawn(app.serve[0], [...app.serve.slice(1), "--host", "127.0.0.1", "--port", String(app.port), "--strictPort"], {
    cwd: app.cwd,
    stdio: "ignore",
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
    env: { ...process.env, NODE_ENV: "production" },
  });
  const base = `http://127.0.0.1:${app.port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`${app.label} preview exited; is port ${app.port} free?`);
    if (await fetch(base + app.path).then((response) => response.ok, () => false)) return { child, base };
    await delay(200);
  }
  stopGroup(child);
  throw new Error(`${app.label} preview did not serve ${app.path} on ${base}`);
}

function cdpClient(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) for (const listener of listeners) listener(message);
    const waiter = message.id ? pending.get(message.id) : null;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result ?? {});
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, onEvent: (listener) => listeners.add(listener), close: () => ws.close() };
}

/** A new headless Chrome with a fresh profile; returns its first page's CDP client. */
async function launchChrome() {
  const profile = mkdtempSync(path.join(os.tmpdir(), "ade-stream-compare-"));
  const chrome = spawn(chromeBinary, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; !existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n"); i++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited (${chromeBinary})`);
    if (i > 150) throw new Error("Chrome never opened a DevTools port");
    await delay(100);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let page = null;
  for (let i = 0; !page; i++) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((target) => target.type === "page");
    if (!page && i > 50) throw new Error("Chrome has no page target");
    if (!page) await delay(100);
  }
  const versionInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const version = versionInfo.Browser;
  const cdp = cdpClient(page.webSocketDebuggerUrl);
  await cdp.ready;
  // Browser-level CDP for process CPU: the renderer (main thread, compositor, raster) and the GPU process.
  const browserCdp = cdpClient(versionInfo.webSocketDebuggerUrl);
  await browserCdp.ready;
  const processCpu = async () => {
    const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
    const sum = (type) => processInfo.filter((p) => p.type === type).reduce((total, p) => total + p.cpuTime, 0);
    return { renderer: sum("renderer"), gpu: sum("GPU") + sum("gpu") };
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: false });
  // A headless page without input is not focused, and ADE rests its working animations in an unfocused
  // window. Every app runs as the focused window, as it would in front of a user.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const close = async () => {
    cdp.close();
    browserCdp.close();
    chrome.kill();
    await new Promise((resolve) => (chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve)));
    rmSync(profile, { recursive: true, force: true });
  };
  return { cdp, version, processCpu, onEvent: cdp.onEvent, onBrowserEvent: browserCdp.onEvent, browserSend: browserCdp.send, close };
}

const evaluate = async (cdp, expression) => {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};

async function waitFor(cdp, expression, what, timeoutMs = 30_000) {
  const started = Date.now();
  while (!(await evaluate(cdp, expression).catch(() => false))) {
    if (Date.now() - started > timeoutMs) {
      const where = await evaluate(cdp, "location.href + ' | ' + document.body.innerText.slice(0, 400).replace(/\\s+/g, ' ')").catch(() => "?");
      throw new Error(`timed out waiting for ${what} (page: ${where})`);
    }
    await delay(50);
  }
}

/** The 20 turns of T3's own fixture (apps/web/test/fakeEnvironment.ts threadWithHistory), as ADE chat events. */
function adeHistoryEvents() {
  const events = [];
  for (let turn = 0; turn < HISTORY_TURNS; turn++) {
    const turnId = `bench-turn-${turn}`;
    events.push(
      { type: "user_message", text: `bench: question ${turn}`, turnId, messageId: `bench-user-${turn}` },
      { type: "status", turnStatus: "started", turnId },
      {
        type: "text",
        turnId,
        messageId: `bench-assistant-${turn}`,
        text: `Answer ${turn} for bench.\n\n- checked \`Sidebar.tsx\`\n- ran the tests\n\n`
          + "The width is now `clamp(next, MIN_WIDTH, MAX_WIDTH)`, so the layout no longer jumps.",
      },
      { type: "done", turnId, status: "completed" },
    );
  }
  return events;
}

/** Opens each app at a chat that already has history, with a turn running and nothing streamed yet. */
const OPEN = {
  "ade-b": (cdp, base) => OPEN.ade(cdp, base, adeBInit),
  async ade(cdp, base, init = adeInit) {
    // The preview's mock App Control session streams a fake screen frame every second into a floating
    // preview; no real chat does that while it waits, so the mock's own switch turns it off.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: 'localStorage.setItem("ade.mock.appControl", "off");' });
    if (init) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(init, "utf8") });
    await cdp.send("Page.navigate", { url: `${base}/work` });
    await waitFor(cdp, "typeof window.__adeMockEmitChatEvent === 'function' && !!window.ade?.sessions", "the ADE preview's chat hook");
    const sessionId = await evaluate(cdp, `(async () => {
      const rows = await window.ade.sessions.list({});
      return rows.filter((s) => String(s.toolType ?? "").endsWith("-chat")).map((s) => s.sessionId ?? s.id)[0] ?? null;
    })()`);
    if (!sessionId) throw new Error("the ADE preview has no chat");
    await evaluate(cdp, `(() => {
      for (const event of ${JSON.stringify(adeHistoryEvents())}) window.__adeMockEmitChatEvent(${JSON.stringify(sessionId)}, event, true);
      // A fresh profile starts on the first-run screen.
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skip setup")?.click();
      return 1;
    })()`);
    // The Work row opens its chat from its labeled inner target (as chat-switch.mjs does). The first-run
    // screen fades out after load, and a click during the fade does not reach the row, so click until it opens.
    const clickRow = `(() => {
      [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skip setup")?.click();
      const row = [...document.querySelectorAll('[data-session-row][data-session-id="${sessionId}"]')].find((el) => el.offsetParent);
      const target = row && (row.querySelector('[aria-label][class*="cursor-pointer"]') || row.querySelector("[aria-label]"));
      target?.click();
      return Boolean(target);
    })()`;
    for (let attempt = 0; !(await evaluate(cdp, "!!document.querySelector('.ade-chat-timeline-pane')")); attempt++) {
      if (attempt === 20) {
        const where = await evaluate(cdp, "document.body.innerText.slice(0, 600).replace(/\\s+/g, ' ')");
        throw new Error(`ADE's chat never opened from its Work row (page: ${where})`);
      }
      await evaluate(cdp, clickRow);
      await delay(750);
    }
    await waitFor(cdp, `document.body.textContent.includes("Answer ${HISTORY_TURNS - 1} for bench.")`, "ADE's chat history");
    await delay(1_500);
    await evaluate(cdp, `(() => {
      window.__benchSessionId = ${JSON.stringify(sessionId)};
      window.__adeMockEmitChatEvent(window.__benchSessionId, { type: "user_message", text: "Continue", turnId: "live-turn", messageId: "live-user" });
      window.__adeMockEmitChatEvent(window.__benchSessionId, { type: "status", turnStatus: "started", turnId: "live-turn" });
      return 1;
    })()`);
    await waitFor(cdp, `document.body.textContent.includes("Continue")`, "ADE's live prompt");
  },
  async pandacode(cdp, base) {
    await cdp.send("Page.navigate", { url: `${base}/` });
    await waitFor(cdp, `!!document.querySelector('.task-item[data-id="session-1"]')`, "PandaCode's task list");
    await delay(500);
    await evaluate(cdp, `(document.querySelector('.task-item[data-id="session-1"]').click(), 1)`);
    await waitFor(cdp, `!!document.querySelector('#prompt[data-session-id="session-1"]')`, "PandaCode's session");
  },
  async t3(cdp, base) {
    await cdp.send("Page.navigate", { url: `${base}/zbench/bench.html` });
    await waitFor(cdp, "!!window.__t3bench && window.__t3bench.ready()", "T3 Code's bench page");
    await delay(1_500);
    await evaluate(cdp, "(window.__t3bench.start(), 1)");
  },
};

/** In the page: deliver each planned event at its time, then wait for the frame that shows the end. */
async function replay({ text, plan, kind, sentinel, idle }) {
  // Each app's live reply element, and how it takes a delivery (new text for ADE and PandaCode, the whole text so far for T3).
  const apps = {
    ade: {
      target: () => [...document.querySelectorAll("[data-assistant-output]")].at(-1) ?? null,
      deliver: (from, end) => window.__adeMockEmitChatEvent(window.__benchSessionId, { type: "text", text: text.slice(from, end), turnId: "live-turn", messageId: "live-assistant" }),
    },
    pandacode: {
      target: () => document.querySelector(".live-text"),
      deliver: (from, end) => window.__previewEmit("agent-event", { sessionId: "session-1", kind: "text", text: text.slice(from, end) }),
    },
    t3: {
      target: () => document.querySelector('[data-message-id="live-assistant"]'),
      deliver: (_from, end) => window.__t3bench.update(text.slice(0, end)),
    },
  };
  const { target, deliver } = apps[kind];
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const t0 = performance.now();
  if (idle) {
    await new Promise((resolve) => setTimeout(resolve, plan.at(-1).at));
    return { wallMs: Math.round(performance.now() - t0) };
  }
  let from = 0;
  let maxLateMs = 0;
  for (const { at, end } of plan) {
    const wait = t0 + at - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    maxLateMs = Math.max(maxLateMs, performance.now() - t0 - at);
    await deliver(from, end);
    from = end;
  }
  const last = performance.now();
  while (!target()?.textContent.includes(sentinel)) {
    if (performance.now() - last > 30_000) throw new Error("the final text never appeared");
    await frame();
  }
  await frame();
  const shown = target();
  return {
    wallMs: Math.round(performance.now() - t0),
    finalPaintMs: Math.round(performance.now() - last),
    maxLateMs: Math.round(maxLateMs),
    shownChars: shown.textContent.length,
    elements: Object.fromEntries(["pre", "table", "li", "h2", "blockquote", "a"].map((tag) => [tag, shown.querySelectorAll(tag).length])),
  };
}

async function measure(kind, base, idle) {
  const app = APPS[kind];
  const chrome = await launchChrome();
  const { cdp } = chrome;
  try {
    const errors = [];
    await OPEN[kind](cdp, base);
    await delay(1_000);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const heapMb = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      return (await cdp.send("Runtime.getHeapUsage")).usedSize / 2 ** 20;
    };
    await evaluate(cdp, `(() => {
      window.__mutations = 0;
      new MutationObserver((list) => { window.__mutations += list.length; })
        .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      window.addEventListener("error", (e) => { (window.__benchErrors ??= []).push(String(e.message)); });
      return 1;
    })()`);
    const heapBeforeMB = await heapMb();
    // Compositor draws per second (viz DrawAndSwap), traced browser-wide over the idle span: how often the
    // GPU has to produce a frame while nothing is delivered.
    const drawEvents = [];
    let drawsDone = null;
    // A profiled run traces the page instead; Chrome keeps one trace at a time.
    if (idle && !profilePrefix) {
      drawsDone = new Promise((resolve) => chrome.onBrowserEvent((message) => {
        if (message.method === "Tracing.dataCollected") drawEvents.push(...message.params.value);
        if (message.method === "Tracing.tracingComplete") resolve();
      }));
      await chrome.browserSend("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["viz"] } });
    }
    const m0 = await metrics();
    const cpu0 = await chrome.processCpu();
    const params = { text: W1_TEXT, plan: app.plan, kind: kind === "ade-b" ? "ade" : kind, sentinel: SENTINEL, idle };
    const profiling = Boolean(profilePrefix);
    // Long tasks (over 20 ms) during the stream, with the JS that ran in them, for the worst-lateness row.
    const longTasks = [];
    const onTrace = (message) => { if (message.method === "Tracing.dataCollected") longTasks.push(...message.params.value); };
    if (profiling) {
      chrome.onEvent(onTrace);
      await cdp.send("Tracing.start", { transferMode: "ReportEvents", categories: "devtools.timeline,disabled-by-default-devtools.timeline" });
    }
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    const frames = [];
    let stopCast = null;
    if (screencastDir && !idle) {
      chrome.onEvent((message) => {
        if (message.method !== "Page.screencastFrame") return;
        frames.push({ data: message.params.data, ts: message.params.metadata.timestamp });
        cdp.send("Page.screencastFrameAck", { sessionId: message.params.sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      stopCast = delay(6_000).then(() => cdp.send("Page.stopScreencast"));
    }
    if (profiling) {
      // What loops on the page: each running animation, its period, and the element it moves.
      const running = await evaluate(cdp, `JSON.stringify(document.getAnimations().map((a) => [a.animationName ?? a.constructor.name, a.effect?.getTiming().duration, a.effect?.target?.getAttribute?.("class")?.slice(0, 60) ?? a.effect?.target?.tagName]))`);
      console.log(`running animations (${kind}): ${running}`);
    }
    const run = await evaluate(cdp, `(${replay.toString()})(${JSON.stringify(params)})`);
    if (stopCast) {
      await stopCast;
      const dir = path.join(screencastDir, `${kind}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      // Constant 60 fps: each slot shows the newest frame drawn at or before it.
      const t0 = frames[0].ts;
      const count = Math.floor((frames.at(-1).ts - t0) * 60);
      for (let i = 0, j = 0; i < count; i++) {
        while (j + 1 < frames.length && frames[j + 1].ts <= t0 + i / 60) j++;
        writeFileSync(path.join(dir, `${String(i).padStart(4, "0")}.png`), Buffer.from(frames[j].data, "base64"));
      }
      console.log(`screencast ${dir}: ${frames.length} frames`);
    }
    await delay(SETTLE_MS);
    if (profiling) {
      const finished = new Promise((resolve) => chrome.onEvent((message) => { if (message.method === "Tracing.tracingComplete") resolve(); }));
      await cdp.send("Tracing.end");
      await finished;
      const main = longTasks.find((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
      const onMain = longTasks.filter((e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === "X");
      // Main-thread time by event name (nested events overlap; read it as "where", not a sum).
      const byName = new Map();
      for (const e of onMain) {
        const [total, count] = byName.get(e.name) ?? [0, 0];
        byName.set(e.name, [total + (e.dur ?? 0), count + 1]);
      }
      console.log(`main-thread events (ms ×count): ${[...byName].sort((a, b) => b[1][0] - a[1][0]).slice(0, 30).map(([n, [d, c]]) => `${n} ${(d / 1000).toFixed(0)} ×${c}`).join(" | ")}`);
      const tasks = onMain.filter((e) => e.name === "RunTask" && e.dur > 20_000);
      for (const task of tasks) {
        const inside = onMain.filter((e) => e.ts >= task.ts && e.ts + (e.dur ?? 0) <= task.ts + task.dur && e.name !== "RunTask");
        const top = inside.filter((e) => e.dur > 1_000)
          .sort((a, b) => b.dur - a.dur).slice(0, 8)
          .map((e) => `${e.name}${e.args?.data?.functionName ? ` ${e.args.data.functionName}` : ""}${e.args?.data?.url ? ` ${e.args.data.url.split("/").pop()}:${e.args.data.lineNumber}` : ""} ${(e.dur / 1000).toFixed(1)}`);
        console.log(`long task ${(task.dur / 1000).toFixed(1)} ms at +${((task.ts - tasks[0].ts) / 1e6).toFixed(1)} s: ${top.join(" | ")}`);
      }
      const { profile } = await cdp.send("Profiler.stop");
      const stamp = Date.now();
      writeFileSync(`${profilePrefix}-${kind}-${idle ? "idle" : "w1"}-${stamp}.cpuprofile`, JSON.stringify(profile));
      writeFileSync(`${profilePrefix}-${kind}-${idle ? "idle" : "w1"}-${stamp}.trace.json`, JSON.stringify({ traceEvents: longTasks }));
    }
    if (afterEval) console.log(`after-eval (${kind}): ${JSON.stringify(await evaluate(cdp, afterEval))}`);
    const m1 = await metrics();
    const cpu1 = await chrome.processCpu();
    let drawsPerSec = null;
    if (drawsDone) {
      await chrome.browserSend("Tracing.end");
      await drawsDone;
      const draws = drawEvents.filter((e) => e.name === "Display::DrawAndSwap" && (e.ph === "X" || e.ph === "B")).length;
      drawsPerSec = +(draws / ((W1_TIMES.at(-1) + SETTLE_MS) / 1000)).toFixed(1);
    }
    const heapAfterMB = await heapMb();
    errors.push(...((await evaluate(cdp, "window.__benchErrors ?? []")) ?? []));
    const ms = (key) => Math.round((m1[key] - m0[key]) * 1000);
    return {
      app: kind,
      mode: idle ? "idle" : "w1",
      events: idle ? 0 : app.plan.length,
      ...run,
      taskMs: ms("TaskDuration"),
      scriptMs: ms("ScriptDuration"),
      layoutMs: ms("LayoutDuration"),
      styleMs: ms("RecalcStyleDuration"),
      otherMs: ms("TaskDuration") - ms("ScriptDuration") - ms("LayoutDuration") - ms("RecalcStyleDuration"),
      // Whole processes over the same span: work moved off the main thread (compositor, raster, GPU) still counts here.
      drawsPerSec,
      rendererCpuMs: Math.round((cpu1.renderer - cpu0.renderer) * 1000),
      gpuCpuMs: Math.round((cpu1.gpu - cpu0.gpu) * 1000),
      heapBeforeMB: +heapBeforeMB.toFixed(1),
      heapAfterMB: +heapAfterMB.toFixed(1),
      mutationRecords: await evaluate(cdp, "window.__mutations"),
      pageErrors: errors,
      chrome: chrome.version,
    };
  } finally {
    await chrome.close();
  }
}

const sh = (cmd, cmdArgs, cwd) => {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const servers = {};
const results = [];
try {
  for (const kind of apps) servers[kind] = await serve(APPS[kind]);
  // Rotate the order each round so drift (heat, background load) hits every app alike.
  for (let round = 0; round < runs; round++) {
    const order = apps.map((_, i) => apps[(i + round) % apps.length]);
    for (const kind of order) {
      for (const idle of [false, true].filter((isIdle) => modes.includes(isIdle ? "idle" : "w1"))) {
        const result = await measure(kind, servers[kind].base, idle);
        if (!idle && result.shownChars < 40_000) throw new Error(`${kind}: only ${result.shownChars} characters shown`);
        console.log(JSON.stringify({ round: round + 1, app: kind, mode: result.mode, taskMs: result.taskMs, scriptMs: result.scriptMs, rendererCpuMs: result.rendererCpuMs, gpuCpuMs: result.gpuCpuMs, drawsPerSec: result.drawsPerSec, finalPaintMs: result.finalPaintMs, heapAfterMB: result.heapAfterMB, events: result.events }));
        results.push({ round: round + 1, ...result });
      }
    }
  }
} finally {
  for (const { child } of Object.values(servers)) stopGroup(child);
}

const meta = {
  label,
  adeFlushMs,
  adeInit: adeInit ? readFileSync(adeInit, "utf8") : null,
  adeBInit: adeBInit ? readFileSync(adeBInit, "utf8") : null,
  date: new Date().toISOString(),
  workload: { bytes: W1_TEXT.length, deltas: W1_DELTAS.length, deltaMs: W1_TIMES[1], durationMs: W1_TIMES.at(-1) },
  machine: { platform: process.platform, cpu: os.cpus()[0]?.model ?? null, ramGB: Math.round(os.totalmem() / 2 ** 30), os: os.release() },
  chrome: results[0]?.chrome ?? null,
  runsPerAppAndMode: runs,
  viewport: VIEWPORT,
  commits: {
    ade: sh("git", ["rev-parse", "HEAD"], repoRoot),
    pandacode: sh("git", ["rev-parse", "HEAD"], pandacodeDir),
    t3code: t3Dir ? sh("git", ["rev-parse", "HEAD"], t3Dir) : null,
  },
};
if (out) writeFileSync(out, `${JSON.stringify({ ...meta, runs: results }, null, 1)}\n`);

const values = (kind, mode, key) => results.filter((r) => r.app === kind && r.mode === mode).map((r) => r[key]).filter((v) => typeof v === "number").sort((a, b) => a - b);
const median = (v) => (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2);
const cell = (v) => (v.length ? `${+median(v).toFixed(1)} (${v[0]}–${v.at(-1)})` : "–");
const ROWS = [
  ["taskMs", "Main-thread task time (ms)"], ["scriptMs", "  of which script (ms)"], ["layoutMs", "  of which layout (ms)"],
  ["styleMs", "  of which style recalc (ms)"], ["otherMs", "  other (ms)"], ["finalPaintMs", "Last delivery to final paint (ms)"],
  ["maxLateMs", "Worst delivery lateness (ms)"], ["rendererCpuMs", "Renderer process CPU (ms)"], ["gpuCpuMs", "GPU process CPU (ms)"], ["heapBeforeMB", "JS heap before, after GC (MB)"], ["heapAfterMB", "JS heap after, after GC (MB)"],
  ["mutationRecords", "DOM mutation records"], ["events", "Updates delivered to the UI"],
];
const table = (mode, rows) => [
  `| Metric | ${apps.map((k) => APPS[k].label).join(" | ")} |`,
  `| --- | ${apps.map(() => "---:").join(" | ")} |`,
  ...rows.map(([key, label]) => `| ${label} | ${apps.map((k) => cell(values(k, mode, key))).join(" | ")} |`),
].join("\n");
const net = (kind) => (values(kind, "w1", "taskMs").length && values(kind, "idle", "taskMs").length
  ? median(values(kind, "w1", "taskMs")) - median(values(kind, "idle", "taskMs"))
  : NaN);
console.log(`\n# ${label}`);
console.log(`\n## W1, ${runs} cold runs per app and mode, median (min–max)\n\n${table("w1", ROWS)}`);
console.log(`\n## Idle baseline, same page state and span, nothing delivered\n\n${table("idle", ROWS.slice(0, 2).concat([["rendererCpuMs", "Renderer process CPU (ms)"], ["gpuCpuMs", "GPU process CPU (ms)"], ["drawsPerSec", "Compositor draws per second"], ["mutationRecords", "DOM mutation records"]]))}`);
console.log(`\nStreaming cost above idle: ${apps.map((k) => `${APPS[k].label} ${Math.round(net(k))} ms`).join(", ")}`);
console.log(`Rendered structure: ${apps.map((k) => `${APPS[k].label} ${JSON.stringify(results.find((r) => r.app === k && r.mode === "w1")?.elements ?? null)}`).join("; ")}`);
console.log(`Chrome ${meta.chrome}; ${meta.machine.cpu}; commits ${JSON.stringify(meta.commits)}`);
