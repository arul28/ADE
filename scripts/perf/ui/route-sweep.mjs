// node scripts/perf/ui/route-sweep.mjs <runId> <route>[,<route>...] [idleSecs]
// IPC timings need the dev app started with ADE_PERF_RUN_ID=<runId> (read from
// ~/.ade/perf-runs/<runId>/events.jsonl); idle numbers should be taken without
// it. See docs/perf/macos-baseline.md.
// For each route: navigate via history API, then
//   nav phase (0-4s): long tasks, IPC calls/time (from perf events.jsonl)
//   idle phase (6s..6+idle): renderer metrics, IPC/min, animations, compositor draws
import { existsSync, readFileSync } from "node:fs";
const [runId, routesArg, idleArg] = process.argv.slice(2);
const routes = routesArg.split(",");
const idleSecs = Number(idleArg ?? 12);
const eventsPath = `${process.env.HOME}/.ade/perf-runs/${runId}/events.jsonl`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:"));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 1; const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? {}); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
await send("Performance.enable", { timeDomain: "threadTicks" });
const metrics = async () => Object.fromEntries(((await send("Performance.getMetrics")).metrics ?? []).map((m) => [m.name, m.value]));

await ev(`(() => { window.__lt = []; if (!window.__ltObs) { window.__ltObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); }); window.__ltObs.observe({ type: "longtask" }); } return 1 })()`);

function ipcIn(t0, t1) {
  // Without ADE_PERF_RUN_ID there is no event log: IPC columns stay empty, and
  // the idle numbers are free of the perf-only stream sampler (see the doc).
  if (!existsSync(eventsPath)) return { n: null, ms: null, top: [] };
  const rows = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((j) => j && j.kind === "ipcInvoke" && j.ts >= t0 && j.ts <= t1 && j.channel !== "ade.perf.recordEvent");
  const by = new Map();
  for (const r of rows) { const x = by.get(r.channel) ?? { n: 0, ms: 0, max: 0 }; x.n++; x.ms += r.durationMs; x.max = Math.max(x.max, r.durationMs); by.set(r.channel, x); }
  return { n: rows.length, ms: rows.reduce((s, r) => s + r.durationMs, 0), top: [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6).map(([k, v]) => `${k.replace("ade.localRuntime.callAction:", "act:").replace("ade.", "")} x${v.n} ${v.ms}ms(max ${v.max})`) };
}

const results = [];
for (const route of routes) {
  const nav0 = Date.now();
  const perf0 = await ev("performance.now()");
  await ev(`(() => { history.pushState({}, "", ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent("popstate")); return 1 })()`);
  await sleep(4000);
  const lt = await ev(`JSON.stringify(window.__lt.filter((e) => e.s >= ${perf0}))`);
  const longTasks = JSON.parse(lt);
  const navIpc = ipcIn(nav0, nav0 + 4000);
  await sleep(2000);
  const idle0 = Date.now(); const m0 = await metrics();
  await sleep(idleSecs * 1000);
  const m1 = await metrics(); const idle1 = Date.now();
  const idleIpc = ipcIn(idle0, idle1);
  const anim = await ev(`document.getAnimations().filter(a=>a.playState==="running" && !a.effect?.target?.closest?.("[data-ade-surface-hidden]")).map(a=>(a.animationName||a.transitionProperty||"?")+"@"+(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? "").toString().slice(0,40)).join(" | ")`);
  const dom = await ev(`document.getElementsByTagName("*").length`);
  const per = (k) => (((m1[k] ?? 0) - (m0[k] ?? 0)) / ((idle1 - idle0) / 1000));
  const r = {
    route,
    nav: { longTaskMs: Math.round(longTasks.reduce((s, e) => s + e.d, 0)), worstLongTaskMs: Math.round(Math.max(0, ...longTasks.map((e) => e.d))), ipcCalls: navIpc.n, ipcMs: navIpc.ms, topIpc: navIpc.top },
    idle: { taskMsPerS: +(per("TaskDuration") * 1000).toFixed(1), scriptMsPerS: +(per("ScriptDuration") * 1000).toFixed(1), styleRecalcPerS: +per("RecalcStyleCount").toFixed(1), layoutPerS: +per("LayoutCount").toFixed(1), ipcPerMin: +(idleIpc.n / ((idle1 - idle0) / 60000)).toFixed(1), topIpc: idleIpc.top.slice(0, 4), heapMB: Math.round((m1.JSHeapUsedSize ?? 0) / 1048576), domNodes: dom, animations: anim },
  };
  results.push(r);
  console.log(JSON.stringify(r));
}
ws.close();
