#!/usr/bin/env node
/**
 * Chat thread scroll benchmark for the desktop renderer, over CDP.
 *
 * Opens a chat, then drives steady wheel input from the live tail to the very
 * first message and back down, and reports what a reader would feel:
 *   - frame pacing (rAF deltas) and long animation frames
 *   - time spent pinned at the top waiting for older history ("stall")
 *   - unexpected content shifts of the row under the viewport top ("jumps")
 *   - renderer + GPU process CPU time and renderer main-thread work
 *
 * Usage:
 *   node scripts/perf-chat-scroll.mjs --port <cdp> --session <chatId> [--speed <px/s, 3000>] [--label base]
 *     [--timeout-s 120] [--out <file.json>] [--no-down] [--reload --park <smallChatId>]
 *     [--scenario wheel|top|idle] [--profile <prefix>] [--dump-frames <file>]
 */
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const argv = process.argv.slice(2);
const opt = { port: 9222, session: null, speed: 3000, label: "run", timeoutS: 120, out: null, down: true, open: true, scenario: "wheel", profile: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") opt.port = Number(argv[++i]);
  else if (a === "--session") opt.session = argv[++i];
  else if (a === "--speed") opt.speed = Number(argv[++i]);
  else if (a === "--label") opt.label = argv[++i];
  else if (a === "--timeout-s") opt.timeoutS = Number(argv[++i]);
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--no-down") opt.down = false;
  else if (a === "--no-open") opt.open = false;
  else if (a === "--scenario") opt.scenario = argv[++i];
  else if (a === "--reload") opt.reload = true;
  else if (a === "--dump-frames") opt.dumpFrames = argv[++i];
  else if (a === "--settle-ms") opt.settleMs = Number(argv[++i]);
  else if (a === "--park") opt.park = argv[++i];
  else if (a === "--inject-css") opt.injectCss = argv[++i];
  else if (a === "--profile") opt.profile = argv[++i];
}
if (!opt.session && opt.open) {
  console.error("--session <chatId> is required (or --no-open to use the open chat)");
  process.exit(2);
}

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", () => rej(new Error(`CDP connect failed: ${this.url}`)), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id ? this.pending.get(msg.id) : null;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result ?? {});
    });
  }
  send(method, params = {}, timeoutMs = 15_000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

const base = `http://127.0.0.1:${opt.port}`;
const targets = await (await fetch(`${base}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.title === "ADE" && !t.url.startsWith("devtools"));
if (!page) throw new Error("No ADE renderer page target found");
const version = await (await fetch(`${base}/json/version`)).json();

const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.connect();
const browser = new Cdp(version.webSocketDebuggerUrl);
await browser.connect();
await cdp.send("Performance.enable", { timeDomain: "timeTicks" });

async function processCpu() {
  try {
    const info = await browser.send("SystemInfo.getProcessInfo");
    const out = { renderer: 0, gpu: 0 };
    for (const p of info.processInfo ?? []) {
      if (p.type === "renderer") out.renderer += p.cpuTime;
      else if (p.type === "GPU") out.gpu += p.cpuTime;
    }
    return out;
  } catch {
    return { renderer: NaN, gpu: NaN };
  }
}
async function perfMetrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

const PANE = ".ade-chat-timeline-pane";

if (opt.reload) {
  // Cold renderer: no session view cache, no transcript collapse cache.
  // Reload onto a route with no chat selected, so the chat under test opens
  // from cold when the benchmark asks for it (a ?sessionId= would reopen it
  // during the reload wait and page its history in early).
  // Work also reopens the last selected chat, so park on a small one first.
  if (opt.park) {
    await cdp.eval(`(() => { history.pushState({}, "", "/work?sessionId=${encodeURIComponent(opt.park)}"); window.dispatchEvent(new PopStateEvent("popstate")); return true; })()`);
    await delay(1_500);
  }
  await cdp.eval(`(() => { history.replaceState({}, "", "/work"); return true; })()`);
  await cdp.send("Page.reload", { ignoreCache: false });
  const t0 = Date.now();
  await delay(1_000);
  for (;;) {
    const ok = await cdp.eval(`document.readyState === "complete" && !!document.querySelector('[data-tour="work.crossLaneSwitch"], [data-tour]') && document.body.innerText.includes("Primary")`).catch(() => false);
    if (ok) break;
    if (Date.now() - t0 > 180_000) throw new Error("App never came back after reload");
    await delay(500);
  }
  console.error(`[bench] reload ready in ${Date.now() - t0}ms`);
  await delay(3_000);
}

if (opt.open) {
  // In-app route change (react-router listens to popstate); a full reload
  // would re-boot the whole renderer and measure app start, not chat open.
  await cdp.eval(`(() => {
    history.pushState({}, "", "/work?sessionId=${encodeURIComponent(opt.session)}");
    window.dispatchEvent(new PopStateEvent("popstate"));
    return true;
  })()`);
  const openStart = Date.now();
  // Wait for the pane to exist and hold rows.
  for (;;) {
    const ready = await cdp.eval(`(() => { const p = document.querySelector(${JSON.stringify(PANE)}); return !!p && p.querySelectorAll('[data-chat-row-key]').length > 0; })()`).catch(() => false);
    if (ready) break;
    if (Date.now() - openStart > 60_000) throw new Error("Chat pane never rendered rows");
    await delay(100);
  }
  // Let hydration and measurement settle (idle scenario measures from open).
  await delay(opt.settleMs ?? (opt.scenario === "idle" ? 0 : 4_000));
}

// Experiments: e.g. --inject-css "*{backdrop-filter:none!important}".
if (opt.injectCss) {
  await cdp.eval(`(() => { const st = document.createElement("style"); st.dataset.adeBench = ""; st.textContent = ${JSON.stringify(opt.injectCss)}; document.head.appendChild(st); return true; })()`);
}

// In-page sampler: one record per animation frame.
await cdp.eval(`(() => {
  if (!document.querySelector(${JSON.stringify(PANE)})) throw new Error("no chat pane");
  // The list can remount under us (chat switch, hydration); always read the live pane.
  const s = window.__adeScrollBench = { frames: [], loaf: [], running: true, driven: 0 };
  Object.defineProperty(s, "pane", { get: () => document.querySelector(${JSON.stringify(PANE)}) });
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.loaf.push({ t: e.startTime, d: e.duration, b: e.blockingDuration ?? 0 });
    });
    po.observe({ type: "long-animation-frame", buffered: false });
    s.po = po;
  } catch {}
  const firstRow = (pane) => {
    const top = pane.getBoundingClientRect().top;
    for (const n of pane.querySelectorAll('[data-chat-row-key]')) {
      const r = n.getBoundingClientRect();
      if (r.bottom > top + 1) return { k: n.dataset.chatRowKey, y: r.top - top };
    }
    return null;
  };
  let last = performance.now();
  const tick = (now) => {
    if (!s.running) return;
    const pane = s.pane;
    if (!pane) { last = now; requestAnimationFrame(tick); return; }
    const fr = firstRow(pane);
    s.frames.push({
      t: now, dt: now - last, st: pane.scrollTop, sh: pane.scrollHeight,
      more: !!pane.querySelector('[role="status"][aria-live="polite"]'),
      rows: pane.querySelectorAll('[data-chat-row-key]').length,
      k: fr?.k ?? null, y: fr?.y ?? null, dv: s.driven,
    });
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`);


// Drive the scroll in the page: CDP Input.dispatchMouseEvent does not ack in
// the Electron dev build. Every frame fires a wheel event (so the list sees a
// reader scrolling) and moves scrollTop by speed * elapsed, so main-thread
// stalls show up as visible scroll stutter, exactly as a reader feels them.
async function wheelUntil(direction, done) {
  const start = Date.now();
  await cdp.eval(`(() => {
    const s = window.__adeScrollBench;
    s.drive = { dir: ${direction}, on: true };
    let last = performance.now();
    const step = (now) => {
      if (!s.drive.on) return;
      const pane = s.pane;
      if (!pane) { last = now; requestAnimationFrame(step); return; }
      const dt = Math.min(100, now - last);
      last = now;
      const dy = s.drive.dir * ${opt.speed} * dt / 1000;
      pane.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
      const before = pane.scrollTop;
      pane.scrollTop = before + dy;
      // Only what the pane actually applied (clamped at either end).
      s.driven += pane.scrollTop - before;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`);
  let polls = 0;
  try {
    while (Date.now() - start < opt.timeoutS * 1000) {
      await delay(250);
      polls++;
      if (await cdp.eval(done)) return { ms: Date.now() - start, reached: true };
      if (polls % 8 === 0) {
        const st = await cdp.eval(`(() => { const p = window.__adeScrollBench.pane; const f = window.__adeScrollBench.frames; return { st: Math.round(p.scrollTop), sh: p.scrollHeight, rows: f.at(-1)?.rows, more: f.at(-1)?.more }; })()`);
        console.error(`[bench] ${direction < 0 ? "up" : "down"} t=${Date.now() - start}ms`, JSON.stringify(st));
      }
    }
    return { ms: Date.now() - start, reached: false };
  } finally {
    await cdp.eval("(() => { window.__adeScrollBench.drive.on = false; return true; })()");
  }
}

const HEAD_REACHED = `(() => { const p = window.__adeScrollBench.pane; const more = !!p.querySelector('[role="status"][aria-live="polite"]'); return p.scrollTop <= 1 && !more; })()`;

// Jump to the top with no wheel input (scrollbar drag, Home, a minimap tick),
// then keep re-pinning to the top until the true first message is there.
async function jumpToHead() {
  const start = Date.now();
  let pins = 0;
  while (Date.now() - start < opt.timeoutS * 1000) {
    if (await cdp.eval(HEAD_REACHED)) return { ms: Date.now() - start, reached: true, pins };
    const moved = await cdp.eval("(() => { const p = window.__adeScrollBench.pane; if (p.scrollTop > 1) { p.scrollTop = 0; return true; } return false; })()");
    if (moved) pins++;
    await delay(100);
  }
  return { ms: Date.now() - start, reached: false, pins };
}

async function profileStart() {
  if (!opt.profile) return;
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  await cdp.send("Profiler.start");
}
async function profileStop(phase) {
  if (!opt.profile) return null;
  const { profile } = await cdp.send("Profiler.stop", {}, 60_000);
  writeFileSync(`${opt.profile}.${phase}.cpuprofile`, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dts = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const cf = n.callFrame;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()?.split("?")[0]}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0) / 1000);
  }
  return [...self.entries()].filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)")).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(0).padStart(6)}ms  ${k}`);
}

const cpu0 = await processCpu();
const pm0 = await perfMetrics();
const markUp = await cdp.eval("window.__adeScrollBench.frames.length");
await profileStart();
// idle: the reader stays at the live tail; time until every older page is resident.
async function idleUntilFullHistory() {
  const start = Date.now();
  let firstSeen = null;
  let goneSince = null;
  while (Date.now() - start < opt.timeoutS * 1000) {
    const more = await cdp.eval(`!!window.__adeScrollBench.pane?.querySelector('[role="status"][aria-live="polite"]')`);
    const now = Date.now();
    if (more) {
      firstSeen ??= now;
      goneSince = null;
    } else if (firstSeen !== null) {
      goneSince ??= now;
      // Gone for good: no page left to fetch.
      if (now - goneSince >= 1_500) return { ms: goneSince - start, reached: true, firstSeenMs: firstSeen - start };
    } else if (now - start > 5_000) {
      return { ms: 0, reached: true, firstSeenMs: null };
    }
    await delay(50);
  }
  return { ms: Date.now() - start, reached: false, firstSeenMs: firstSeen === null ? null : firstSeen - start };
}
const up = opt.scenario === "top"
  ? await jumpToHead()
  : opt.scenario === "idle"
    ? await idleUntilFullHistory()
    : await wheelUntil(-1, HEAD_REACHED);
const upProfile = await profileStop("up");
const cpu1 = await processCpu();
const pm1 = await perfMetrics();
const markDown = await cdp.eval("window.__adeScrollBench.frames.length");
let down = null;
let downProfile = null;
if (opt.down) {
  await profileStart();
  down = await wheelUntil(1, `(() => { const p = window.__adeScrollBench.pane; return p.scrollTop + p.clientHeight >= p.scrollHeight - 2; })()`);
  downProfile = await profileStop("down");
}
const cpu2 = await processCpu();
const pm2 = await perfMetrics();
const raw = await cdp.eval(`(() => { const s = window.__adeScrollBench; s.running = false; try { s.po?.disconnect(); } catch {} return { frames: s.frames, loaf: s.loaf }; })()`);

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
function summarize(frames, loaf, cpuA, cpuB, pmA, pmB, phase) {
  const f = frames.slice(1);
  const dts = f.map((x) => x.dt);
  const t0 = f[0]?.t ?? 0;
  const t1 = f.at(-1)?.t ?? 0;
  let stallMs = 0;
  let jumps = 0;
  let jumpPx = 0;
  for (let i = 1; i < f.length; i++) {
    const a = f[i - 1], b = f[i];
    if (phase === "up" && b.st <= 2 && b.more) stallMs += b.dt;
    if (a.k && a.k === b.k && a.y != null && b.y != null) {
      // Row-under-top moved on screen by anything other than the driven scroll.
      const shift = (b.y - a.y) + (b.dv - a.dv);
      if (Math.abs(shift) > 2) { jumps++; jumpPx += Math.abs(shift); }
    }
  }
  const l = loaf.filter((e) => e.t >= t0 && e.t <= t1);
  const secs = Math.max(0.001, (t1 - t0) / 1000);
  return {
    durationMs: Math.round(t1 - t0),
    frames: f.length,
    fps: +(f.length / secs).toFixed(1),
    frameP50: +pct(dts, 50).toFixed(1),
    frameP95: +pct(dts, 95).toFixed(1),
    frameP99: +pct(dts, 99).toFixed(1),
    frameMax: +Math.max(0, ...dts).toFixed(1),
    over33: dts.filter((d) => d > 33.4).length,
    over50: dts.filter((d) => d > 50).length,
    loafCount: l.length,
    loafBlockingMs: Math.round(l.reduce((s, e) => s + e.b, 0)),
    stallAtTopMs: Math.round(stallMs),
    contentJumps: jumps,
    contentJumpPx: Math.round(jumpPx),
    rendererCpuMs: Math.round((cpuB.renderer - cpuA.renderer) * 1000),
    gpuCpuMs: Math.round((cpuB.gpu - cpuA.gpu) * 1000),
    rendererCpuPct: +(((cpuB.renderer - cpuA.renderer) / secs) * 100).toFixed(1),
    gpuCpuPct: +(((cpuB.gpu - cpuA.gpu) / secs) * 100).toFixed(1),
    scriptMs: Math.round((pmB.ScriptDuration - pmA.ScriptDuration) * 1000),
    layoutMs: Math.round((pmB.LayoutDuration - pmA.LayoutDuration) * 1000),
    styleMs: Math.round((pmB.RecalcStyleDuration - pmA.RecalcStyleDuration) * 1000),
    taskMs: Math.round((pmB.TaskDuration - pmA.TaskDuration) * 1000),
    maxMountedRows: Math.max(0, ...f.map((x) => x.rows)),
    heapMB: +(pmB.JSHeapUsedSize / 1e6).toFixed(1),
  };
}

if (opt.dumpFrames) writeFileSync(opt.dumpFrames, JSON.stringify({ markUp, markDown, ...raw }));
const upFrames = raw.frames.slice(markUp, markDown);
const downFrames = raw.frames.slice(markDown);
const result = {
  label: opt.label,
  session: opt.session,
  speedPxPerSec: opt.speed,
  scenario: opt.scenario,
  up: { reachedHead: up.reached, wallMs: up.ms, pins: up.pins, firstSeenMs: up.firstSeenMs, ...summarize(upFrames, raw.loaf, cpu0, cpu1, pm0, pm1, "up") },
  down: down ? { reachedTail: down.reached, wallMs: down.ms, ...summarize(downFrames, raw.loaf, cpu1, cpu2, pm1, pm2, "down") } : null,
};
if (upProfile) result.upProfile = upProfile;
if (downProfile) result.downProfile = downProfile;
console.log(JSON.stringify(result, null, 2));
if (opt.out) writeFileSync(opt.out, JSON.stringify(result, null, 2));
cdp.close();
browser.close();
process.exit(0);
