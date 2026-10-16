#!/usr/bin/env node
/**
 * Scene cost benchmark for the desktop renderer, over CDP.
 *
 * Opens a chat that holds ```scene fences and reports what its scenes cost in
 * each state a reader puts them in:
 *   open      chat opened, scenes drawing and settling
 *   visible   idle with scenes on screen (the steady state a reader looks at)
 *   scroll    wheel from the tail to the top and back
 *   hidden    another chat selected, the scene chat parked
 *
 * Per phase: CPU time of the renderer processes (the app's renderer and every
 * out-of-process scene frame), the GPU process and the browser (main)
 * process, as a percentage of one core; resident memory of all of them at the
 * end of the phase; host frame pacing; and how many scenes are mounted as live
 * frames versus shown as stills.
 *
 * Usage:
 *   node scripts/perf-chat-scenes.mjs --port <cdp> --session <scene chat> --park <other chat>
 *     [--label base] [--out file.json] [--phase-s 15] [--speed 1500] [--reload]
 *     [--focus-scene 4]      which scene the visible phase centres (1-based)
 *     [--no-sampler]         no host rAF sampler (frame stats read 0); idle CPU as an idle app has it
 *     [--scroll-s 8]         how long the scroll phase wheels up and down
 *     [--stills-reference]   extra phase with every live frame removed: the
 *                            cost if every scene had frozen to a still
 *
 * Launch the dev app with `ade app-control launch --command "NO_DEVTOOLS=1 node
 * scripts/dev-desktop.mjs --auto"` so the window keeps painting while occluded.
 * Compare A/B in one machine state: run base and change back to back.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const argv = process.argv.slice(2);
const opt = { port: 9222, session: null, park: null, label: "run", out: null, phaseS: 15, speed: 1500, reload: false, focusScene: 4, stillsReference: false, scrollS: 8, noSampler: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); }
    return v;
  };
  if (a === "--port") opt.port = Number(next());
  else if (a === "--session") opt.session = next();
  else if (a === "--park") opt.park = next();
  else if (a === "--label") opt.label = next();
  else if (a === "--out") opt.out = next();
  else if (a === "--phase-s") opt.phaseS = Number(next());
  else if (a === "--speed") opt.speed = Number(next());
  else if (a === "--reload") opt.reload = true;
  else if (a === "--focus-scene") opt.focusScene = Number(next());
  else if (a === "--stills-reference") opt.stillsReference = true;
  else if (a === "--scroll-s") opt.scrollS = Number(next());
  else if (a === "--no-sampler") opt.noSampler = true;
}
if (!opt.session || !opt.park) {
  console.error("--session <scene chat> and --park <other chat> are required");
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
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, timeoutMs);
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

const PANE = ".ade-chat-timeline-pane";

/** "M:SS.ss" or "H:MM:SS.ss" from `ps -o time=` to seconds. */
function psSeconds(text) {
  const parts = String(text).trim().split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Every process CDP knows (browser, GPU, renderers including scene frames,
 * utilities) with its CPU seconds read from `ps`. CDP's own cpuTime for the
 * browser process stopped tracking across dev-app restarts; `ps` on the pid is
 * the ground truth.
 */
async function processes() {
  const info = await browser.send("SystemInfo.getProcessInfo");
  const list = (info.processInfo ?? []).map((p) => ({ type: p.type, pid: p.id, cpu: 0 }));
  if (!list.length) return list;
  try {
    const out = execFileSync("ps", ["-o", "pid=,time=", "-p", list.map((p) => p.pid).join(",")], { encoding: "utf8" });
    const byPid = new Map(out.trim().split("\n").map((line) => {
      const [pid, time] = line.trim().split(/\s+/);
      return [Number(pid), psSeconds(time)];
    }));
    for (const p of list) p.cpu = byPid.get(p.pid) ?? 0;
  } catch { /* a process exited between the two reads */ }
  return list;
}
function rssMb(pids) {
  if (!pids.length) return 0;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    return out.split("\n").map((l) => Number(l.trim())).filter(Number.isFinite).reduce((a, b) => a + b, 0) / 1024;
  } catch {
    return NaN;
  }
}
function rendererBreakdown(before, after, wallMs) {
  const start = new Map(before.map((p) => [p.pid, p.cpu]));
  return after
    .filter((p) => p.type === "renderer")
    .map((p) => +(((p.cpu - (start.get(p.pid) ?? p.cpu)) / (wallMs / 1000)) * 100).toFixed(1))
    .sort((x, y) => y - x);
}

function cpuByType(list) {
  const out = { renderer: 0, gpu: 0, browser: 0, other: 0, renderers: 0 };
  for (const p of list) {
    if (p.type === "renderer") { out.renderer += p.cpu; out.renderers += 1; }
    else if (p.type === "GPU") out.gpu += p.cpu;
    else if (p.type === "browser") out.browser += p.cpu;
    else out.other += p.cpu;
  }
  return out;
}

async function sceneCounts() {
  return cdp.eval(`(() => {
    const scenes = [...document.querySelectorAll('[data-testid="chat-scene"]')];
    return {
      scenes: scenes.length,
      frames: document.querySelectorAll('[data-testid="chat-scene-frame"]').length,
      stills: document.querySelectorAll('[data-testid="chat-scene-snapshot"]').length,
      statuses: scenes.map((s) => s.dataset.sceneStatus),
    };
  })()`);
}

async function openChat(id) {
  await cdp.eval(`(() => {
    history.pushState({}, "", "/work?sessionId=${encodeURIComponent("__ID__")}".replace("__ID__", ${JSON.stringify(id)}));
    window.dispatchEvent(new PopStateEvent("popstate"));
    return true;
  })()`);
  const t0 = Date.now();
  for (;;) {
    const ready = await cdp.eval(`(() => { const p = document.querySelector(${JSON.stringify(PANE)}); return !!p && p.querySelectorAll('[data-chat-row-key]').length > 0; })()`).catch(() => false);
    if (ready) return Date.now() - t0;
    if (Date.now() - t0 > 60_000) throw new Error(`Chat ${id} never rendered rows`);
    await delay(100);
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measure(phase, run) {
  const tStart = await cdp.eval("performance.now()");
  const before = await processes();
  const wall0 = Date.now();
  const extra = (await run()) ?? {};
  const wallMs = Date.now() - wall0;
  const after = await processes();
  const tEnd = await cdp.eval("performance.now()");
  const a = cpuByType(before);
  const b = cpuByType(after);
  const pctCore = (x) => +((x / (wallMs / 1000)) * 100).toFixed(1);
  const { frames, loaf } = await cdp.eval(`(() => {
    const s = window.__adeSceneBench;
    return {
      frames: s.frames.filter((f) => f.t >= ${tStart} && f.t <= ${tEnd}).map((f) => f.dt),
      loaf: s.loaf.filter((f) => f.t >= ${tStart} && f.t <= ${tEnd}).map((f) => f.d),
    };
  })()`);
  const counts = await sceneCounts();
  const result = {
    phase,
    wallMs,
    cpu: {
      renderer: pctCore(b.renderer - a.renderer),
      gpu: pctCore(b.gpu - a.gpu),
      browser: pctCore(b.browser - a.browser),
      other: pctCore(b.other - a.other),
    },
    rendererProcesses: b.renderers,
    perRenderer: rendererBreakdown(before, after, wallMs),
    rssMb: Math.round(rssMb(after.map((p) => p.pid))),
    frames: {
      count: frames.length,
      fps: +(frames.length / (wallMs / 1000)).toFixed(1),
      p50: +pct(frames, 50).toFixed(1),
      p95: +pct(frames, 95).toFixed(1),
      over33: frames.filter((d) => d > 33).length,
      longFrames: loaf.length,
      longFrameMs: Math.round(loaf.reduce((x, y) => x + y, 0)),
    },
    scenes: counts,
    ...extra,
  };
  console.error(`[${opt.label}] ${phase}: cpu r=${result.cpu.renderer}% gpu=${result.cpu.gpu}% main=${result.cpu.browser}% · rss=${result.rssMb}MB · procs=${result.rendererProcesses} [${result.perRenderer.join("/")}] · frames=${counts.frames}/${counts.scenes} stills=${counts.stills} · p95=${result.frames.p95}ms long=${result.frames.longFrames}`);
  return result;
}

async function wheel(direction) {
  return cdp.eval(`new Promise((resolve) => {
    const speed = ${opt.speed};
    let last = performance.now();
    const t0 = last;
    const step = (now) => {
      const pane = document.querySelector(${JSON.stringify(PANE)});
      if (!pane) return resolve(false);
      const dy = ${direction === "up" ? -1 : 1} * speed * (now - last) / 1000;
      last = now;
      pane.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true }));
      pane.scrollTop += dy;
      const atEnd = ${direction === "up"} ? pane.scrollTop <= 0 : pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
      if (atEnd || now - t0 > 20000) return resolve(true);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`);
}

if (opt.reload) {
  await openChat(opt.park);
  await delay(1_000);
  await cdp.send("Page.reload", {});
  await delay(1_000);
  for (let t = Date.now(); Date.now() - t < 120_000;) {
    const ok = await cdp.eval(`document.readyState === "complete" && !!document.querySelector('[data-tour]')`).catch(() => false);
    if (ok) break;
    await delay(500);
  }
  await delay(3_000);
}

// One rAF sampler for the whole run; each phase reads its own slice.
// --no-sampler leaves it out: a rAF loop in the host makes the host produce a
// frame every display refresh, which is not what an idle app does, and every
// live scene frame then costs the host an intersection update per frame.
await cdp.eval(`(() => {
  const s = window.__adeSceneBench = { frames: [], loaf: [] };
  if (${opt.noSampler}) return true;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.loaf.push({ t: e.startTime, d: e.duration });
    });
    po.observe({ type: "long-animation-frame", buffered: false });
  } catch {}
  let last = performance.now();
  const tick = (now) => { s.frames.push({ t: now, dt: now - last }); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`);


const results = { label: opt.label, at: new Date().toISOString(), phaseS: opt.phaseS, phases: [] };

// Park first so the scene chat opens from a different chat each run.
await openChat(opt.park);
await delay(2_000);

results.phases.push(await measure("open", async () => {
  const openMs = await openChat(opt.session);
  await delay(opt.phaseS * 1000);
  return { openMs };
}));

results.phases.push(await measure("visible", async () => {
  // Centre the scene named by --focus-scene (1-based; default the 4th, the
  // looping one in the fixture): the worst case a reader can look at.
  await cdp.eval(`(() => {
    const scenes = document.querySelectorAll('[data-testid="chat-scene"]');
    const target = scenes[Math.min(scenes.length, ${opt.focusScene}) - 1];
    if (target) target.scrollIntoView({ block: "center" });
    return !!target;
  })()`);
  await delay(opt.phaseS * 1000);
}));

if (opt.stillsReference) {
  // Reference only: drop every live frame, as if each scene had frozen to its
  // still. What the old design cost at best, with every capture succeeding.
  results.phases.push(await measure("stills-reference", async () => {
    await cdp.eval(`(() => { document.querySelectorAll('[data-testid="chat-scene-frame"]').forEach((f) => f.remove()); return true; })()`);
    await delay(opt.phaseS * 1000);
  }));
}

results.phases.push(await measure("scroll", async () => {
  // Up and down until --scroll-s has passed, so a short chat still gives a
  // phase long enough to read CPU from.
  const until = Date.now() + opt.scrollS * 1000;
  while (Date.now() < until) {
    await wheel("up");
    await wheel("down");
  }
}));

results.phases.push(await measure("settle-after-scroll", async () => {
  await delay(opt.phaseS * 1000);
}));

results.phases.push(await measure("hidden", async () => {
  await openChat(opt.park);
  await delay(opt.phaseS * 1000);
}));

if (opt.out) writeFileSync(opt.out, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
process.exit(0);
