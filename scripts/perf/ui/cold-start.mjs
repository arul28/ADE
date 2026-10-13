#!/usr/bin/env node
// Cold start of the dev app, timed from the launch command.
// usage: node scripts/perf/ui/cold-start.mjs <logfile> <runtime-socket> [timeoutSecs]
// Launches `npm run dev:desktop -- --socket <socket>` through dev-detached.mjs
// (so the app outlives this script), then polls the dev log and CDP port 9222
// and prints the time from launch to each milestone:
//   log lines: runtime start, isolation report, Electron launch;
//   CDP: first page target (window created), DOMContentLoaded, app mounted
//   (more than 300 elements), and settled (element count unchanged for 2 s).
// Stop the app afterwards yourself (the printed pid).
// On Windows from Git Bash, set MSYS_NO_PATHCONV=1 or a \\.\pipe\ path is rewritten.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [logPath, socket, timeoutArg] = process.argv.slice(2);
if (!logPath || !socket) {
  console.error("usage: cold-start.mjs <logfile> <runtime-socket> [timeoutSecs]");
  process.exit(2);
}
const timeoutMs = Number(timeoutArg ?? 240) * 1000;
const port = Number(process.env.CDP_PORT ?? 9222);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const markers = [
  ["cliBuildSkippedOrDone", /verified dist\/cli\.cjs|runtime CLI (is )?fresh|ade-cli:build/i],
  ["runtimeStarting", /starting dev runtime/i],
  ["isolationReport", /dev isolation report/i],
  ["electronLaunch", /dev launcher using/i],
  ["failed", /dev desktop failed|electron exited/i],
];

const t0 = Date.now();
const launched = spawnSync(process.execPath, [path.join(repo, "scripts/dev-detached.mjs"), logPath, "npm", "run", "dev:desktop", "--", "--socket", socket], { cwd: repo, encoding: "utf8", env: process.env });
const pid = launched.stdout.trim();
const at = {};
const mark = (k) => { if (at[k] == null) at[k] = Date.now() - t0; };

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((x) => x.type === "page" && x.url.includes(process.env.CDP_TARGET_URL ?? "//localhost:")) ?? null;
  } catch { return null; }
}

async function evalOnce(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return await new Promise((res) => {
      ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) res(m.result?.result?.value); };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
  } finally { ws.close(); }
}

let lastCount = -1; let stableSince = 0;
while (Date.now() - t0 < timeoutMs) {
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8");
    for (const [k, re] of markers) if (re.test(log)) mark(k);
    if (at.failed != null) break;
  }
  const page = await pageTarget();
  if (page) {
    mark("windowCreated");
    try {
      const v = await evalOnce(page.webSocketDebuggerUrl, `JSON.stringify({ rs: document.readyState, n: document.getElementsByTagName("*").length })`);
      if (v) {
        const { rs, n } = JSON.parse(v);
        if (rs !== "loading") mark("domContentLoaded");
        if (n > 300) mark("appMounted");
        if (at.appMounted != null) {
          if (n !== lastCount) { lastCount = n; stableSince = Date.now(); }
          else if (Date.now() - stableSince >= 2000) { at.settled = stableSince - t0; at.settledElements = n; break; }
        }
      }
    } catch { /* page still booting */ }
  }
  await sleep(100);
}
console.log(JSON.stringify({ pid, socket, ms: at }));
