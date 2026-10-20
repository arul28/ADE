#!/usr/bin/env node
// node scripts/perf/ui/terminal-flood.mjs <laneId> [seq|yes] [timeoutSecs]
// Whether the brain keeps answering while a terminal floods output. Starts a
// tracked shell in <laneId>, shows it, and floods it:
//   seq  `seq 1 2000000` (about 16 MB), then exits: reports the time to finish
//   yes  200 MB of colored `yes` lines, then exits
// Meanwhile the renderer calls `sessions.get` again 100 ms after each reply
// and the script reports that round trip (p50, p95, max over the calls that
// answered, plus how many failed), the renderer's frame gaps and long tasks,
// and the brain's CPU seconds.
// Run against a dev app with its own socket (docs/perf/macos-baseline.md), and
// set `ADE_RUNTIME_SOCKET` to that socket for the brain CPU number. The lane
// must be on this machine: the calls carry no runtime pin. The shell it starts
// stays in the lane as an ended session; one still running at the timeout is
// closed.
import { execFileSync } from "node:child_process";
import { findPage, positionalArgs } from "./target.mjs";

const [laneId, mode = "seq", timeoutArg] = positionalArgs();
if (!laneId) throw new Error("usage: terminal-flood.mjs <laneId> [seq|yes] [timeoutSecs]");
const socket = process.env.ADE_RUNTIME_SOCKET;
const timeoutMs = Number(timeoutArg ?? 120) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`timeoutSecs must be a positive number, got ${timeoutArg}`);
const flood = mode === "yes"
  ? "yes $'\\e[31mred\\e[0m plain \\e[1mbold\\e[0m text line for the flood benchmark' | head -c 200000000"
  : "seq 1 2000000";

const list = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9222}/json/list`)).json();
const page = findPage(list);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const evaluate = (expression) => new Promise((resolve, reject) => {
  const i = id++;
  pending.set(i, (m) => {
    const r = m.result;
    if (m.error || r?.exceptionDetails) reject(new Error(JSON.stringify(m.error ?? r.exceptionDetails).slice(0, 500)));
    else resolve(r.result.value);
  });
  ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});

const findBrainPid = () => {
  try {
    const pid = execFileSync("pgrep", ["-f", `serve --socket ${socket}`]).toString().trim().split("\n")[0];
    return /^\d+$/.test(pid) ? pid : "";
  } catch {
    return "";
  }
};
const brainPid = socket ? findBrainPid() : "";
const cpuSeconds = () => {
  if (!brainPid) return null;
  const t = execFileSync("ps", ["-o", "time=", "-p", brainPid]).toString().trim();
  return t.replace("-", ":").split(":").reduce((a, x) => a * 60 + Number(x), 0);
};

let ptyId = null;
let session = null;
let result = { finished: false };
try {
  const created = await evaluate(`window.ade.pty.create({
    laneId: ${JSON.stringify(laneId)}, cols: 120, rows: 36, title: "terminal-flood ${mode}",
    tracked: true, toolType: "shell", startupCommand: ${JSON.stringify(`sleep 2; ${flood}; exit`)},
  }).then((r) => ({ ptyId: r.ptyId, sessionId: r.sessionId }))`);
  ptyId = created.ptyId;
  session = created.sessionId;
  await evaluate(`window.dispatchEvent(new CustomEvent("ade:work:select-session", { detail: { sessionId: ${JSON.stringify(session)}, laneId: ${JSON.stringify(laneId)} } })); 1`);
  const cpuBefore = cpuSeconds();
  result = await evaluate(`new Promise((resolve) => {
    const frames = [], longTasks = [], calls = [];
    let failedCalls = 0;
    let done = false, finished = false, last = performance.now();
    const t0 = performance.now();
    const observer = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); });
    observer.observe({ type: "longtask" });
    const frame = () => { const n = performance.now(); frames.push(n - last); last = n; if (!done) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    (async () => {
      while (!done) {
        const a = performance.now();
        let status = null;
        try {
          // A reply that never comes must not hold the run past its timeout.
          const left = Math.max(1, ${timeoutMs} - (performance.now() - t0));
          let deadline;
          const reply = await Promise.race([
            window.ade.sessions.get(${JSON.stringify(session)}),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("timeout")), left); }),
          ]).finally(() => clearTimeout(deadline));
          status = reply?.status ?? null;
          calls.push(performance.now() - a);
        } catch {
          failedCalls += 1;
        }
        if (status && status !== "running") { finished = true; break; }
        if (performance.now() - t0 > ${timeoutMs}) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      done = true;
      observer.disconnect();
      const q = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0); };
      resolve({
        finished, wallMs: Math.round(performance.now() - t0),
        ipcP50: q(calls, 0.5), ipcP95: q(calls, 0.95), ipcMax: q(calls, 1), ipcCalls: calls.length, ipcFailed: failedCalls,
        frameP95: q(frames, 0.95), frameMax: q(frames, 1),
        longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
      });
    })();
  })`);
  const cpuAfter = cpuSeconds();
  console.log(JSON.stringify({
    mode,
    ...result,
    brainCpuSec: cpuBefore == null ? null : +(cpuAfter - cpuBefore).toFixed(1),
  }));
} finally {
  if (!result.finished && ptyId) {
    // Do not leave the flood running into the next measurement.
    await evaluate(`window.ade.pty.dispose({ ptyId: ${JSON.stringify(ptyId)}, sessionId: ${JSON.stringify(session)} }).then(() => 1)`).catch(() => {});
  }
  ws.close();
}
