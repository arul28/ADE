#!/usr/bin/env node
/**
 * Chat streaming benchmark for the desktop renderer in browser-mock mode.
 *
 * Replays a real chat transcript into a mock chat: everything but the last
 * `--stream` events is preloaded as history, then the chat is opened and those
 * last events arrive one by one at `--rate` per second, the way the host
 * streams a live turn. Reports what each streamed event costs the renderer.
 *
 * Needs the desktop Vite dev server (the app's own `npm run dev:desktop`, or
 * `npm run dev:vite` in apps/desktop) and a Chromium with a CDP port pointed at
 * it, e.g. Playwright's "Google Chrome for Testing" with
 *   --remote-debugging-port=9555 --headless=new http://localhost:5173/work
 *
 * Usage:
 *   node scripts/perf-chat-stream.mjs --port 9555 --transcript <file.chat.jsonl>
 *     [--stream 400] [--rate 30] [--label x] [--out file.json] [--profile prefix]
 *     [--background]   stream into a second chat while the first stays open
 *     [--render-hook <file.js>]   script installed before load (render counting)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const argv = process.argv.slice(2);
const opt = { port: 9555, transcript: null, stream: 400, rate: 30, label: "run", out: null, profile: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") opt.port = Number(argv[++i]);
  else if (a === "--transcript") opt.transcript = argv[++i];
  else if (a === "--stream") opt.stream = Number(argv[++i]);
  else if (a === "--rate") opt.rate = Number(argv[++i]);
  else if (a === "--label") opt.label = argv[++i];
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--profile") opt.profile = argv[++i];
  else if (a === "--render-hook") opt.renderHook = argv[++i];
  else if (a === "--background") opt.background = true;
}
if (!opt.transcript) {
  console.error("--transcript <file.chat.jsonl> is required");
  process.exit(2);
}

const envelopes = readFileSync(opt.transcript, "utf8").split("\n").flatMap((line) => {
  try {
    const parsed = JSON.parse(line);
    return parsed?.event?.type ? [parsed] : [];
  } catch {
    return [];
  }
});
const history = envelopes.slice(0, Math.max(0, envelopes.length - opt.stream));
const live = envelopes.slice(history.length);

const base = `http://127.0.0.1:${opt.port}`;
const page = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.type === "page" && /localhost/.test(t.url));
if (!page) throw new Error("No renderer page on that CDP port");
const browserWs = (await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl;

function connect(url) {
  const ws = new WebSocket(url);
  let id = 1;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    const p = m.id ? pending.get(m.id) : null;
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result ?? {});
  });
  const ready = new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ready, send };
}
const cdp = connect(page.webSocketDebuggerUrl);
const browser = connect(browserWs);
await cdp.ready;
await browser.ready;
const ev = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const rendererCpu = async () => {
  const info = await browser.send("SystemInfo.getProcessInfo");
  return info.processInfo.filter((p) => p.type === "renderer").reduce((s, p) => s + p.cpuTime, 0);
};
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

// Optional: a script installed before the page loads (e.g. a React DevTools
// hook that counts renders), with window.__renderCountOn toggled around the stream.
if (opt.renderHook) {
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(opt.renderHook, "utf8") });
}

// Fresh preview, then wait for the mock's chat event hook (installed when the
// Work surface subscribes to chat events).
await cdp.send("Page.navigate", { url: page.url.replace(/(localhost:\d+).*/, "$1/work") });
for (let i = 0; ; i++) {
  if (await ev("typeof window.__adeMockEmitChatEvent === 'function'").catch(() => false)) break;
  if (i > 600) throw new Error("Mock chat emitter never appeared (is this the browser-mock renderer?)");
  await delay(100);
}
const chatIds = await ev(`(async () => {
  const rows = await window.ade.sessions.list({});
  return rows.filter((s) => String(s.toolType ?? "").endsWith("-chat")).map((s) => s.sessionId ?? s.id).slice(0, 2);
})()`);
const sessionId = chatIds[0];
if (!sessionId) throw new Error("No chat session in the mock");
// --background: the open chat holds the history; the live events go to a
// second chat the reader is not looking at (another agent working elsewhere).
const liveSessionId = opt.background ? chatIds[1] : sessionId;
if (!liveSessionId) throw new Error("--background needs a second chat in the mock");

// Preload history in batches (persisted, so the chat's history read returns it).
for (let i = 0; i < history.length; i += 400) {
  const batch = history.slice(i, i + 400).map((e) => [e.event, e.timestamp]);
  await ev(`(() => { for (const [event] of ${JSON.stringify(batch)}) window.__adeMockEmitChatEvent(${JSON.stringify(sessionId)}, event, true); return 1; })()`);
}
await ev(`(() => { history.pushState({}, "", "/work?sessionId=${sessionId}"); dispatchEvent(new PopStateEvent("popstate")); return 1; })()`);
for (let i = 0; ; i++) {
  const rows = await ev(`document.querySelectorAll(".ade-chat-timeline-pane [data-chat-row-key]").length`);
  if (rows > 0) break;
  if (i > 300) throw new Error("Chat never rendered");
  await delay(100);
}
await delay(5_000);

await cdp.send("Performance.enable");
await ev(`(() => {
  const s = window.__adeStreamBench = { frames: [], loaf: [], on: true };
  try {
    s.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) s.loaf.push([e.startTime, e.duration, e.blockingDuration ?? 0]); });
    s.po.observe({ type: "long-animation-frame" });
  } catch {}
  let last = performance.now();
  const tick = (now) => { if (!s.on) return; s.frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return 1;
})()`);
if (opt.profile) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}
if (opt.renderHook) await ev("(window.__renderCountsReset?.(), window.__renderCountOn = true, 1)");
const cpu0 = await rendererCpu();
const m0 = await metrics();
const t0 = Date.now();
const intervalMs = 1000 / opt.rate;
for (let i = 0; i < live.length; i++) {
  const due = t0 + i * intervalMs;
  const wait = due - Date.now();
  if (wait > 0) await delay(wait);
  await ev(`(window.__adeMockEmitChatEvent(${JSON.stringify(liveSessionId)}, ${JSON.stringify(live[i].event)}, true), 1)`);
}
await delay(1_000);
const wallS = (Date.now() - t0) / 1000;
const cpu1 = await rendererCpu();
const m1 = await metrics();
let topSelf = null;
if (opt.profile) {
  const { profile } = await cdp.send("Profiler.stop");
  writeFileSync(`${opt.profile}.cpuprofile`, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((sid, i) => {
    const cf = byId.get(sid).callFrame;
    if (["(idle)", "(program)"].includes(cf.functionName)) return;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()?.split("?")[0]}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  topSelf = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(0).padStart(6)}ms ${k}`);
}
const renders = opt.renderHook ? await ev("(window.__renderCountOn = false, window.__renderCounts?.() ?? null)") : null;
const raw = await ev(`(() => { const s = window.__adeStreamBench; s.on = false; try { s.po.disconnect(); } catch {} return { frames: s.frames, loaf: s.loaf }; })()`);
const dts = raw.frames.slice(1).sort((a, b) => a - b);
const pct = (p) => +(dts[Math.min(dts.length - 1, Math.floor(p / 100 * dts.length))] ?? 0).toFixed(1);
const result = {
  label: opt.label,
  background: Boolean(opt.background),
  historyEvents: history.length,
  streamedEvents: live.length,
  ratePerSec: opt.rate,
  wallS: +wallS.toFixed(1),
  rendererCpuPct: +(((cpu1 - cpu0) / wallS) * 100).toFixed(1),
  scriptMsPerEvent: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / live.length).toFixed(2),
  taskMsPerEvent: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / live.length).toFixed(2),
  styleMs: Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
  layoutMs: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000),
  frameP50: pct(50),
  frameP95: pct(95),
  frameP99: pct(99),
  frameMax: +(dts.at(-1) ?? 0).toFixed(1),
  over33: dts.filter((d) => d > 33.4).length,
  loafCount: raw.loaf.length,
  loafBlockingMs: Math.round(raw.loaf.reduce((s, e) => s + e[2], 0)),
  ...(topSelf ? { topSelf } : {}),
  ...(renders ? { renders } : {}),
};
console.log(JSON.stringify(result, null, 2));
if (opt.out) writeFileSync(opt.out, JSON.stringify(result, null, 2));
process.exit(0);
