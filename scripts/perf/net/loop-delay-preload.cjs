// Event-loop stall probe for a measurement brain (no product change): preload it next to
// guard-sync-port.cjs and set ADE_PERF_LOOP_DELAY_FILE=<path.jsonl>.
//   ADE_PERF_LOOP_DELAY_FILE=/tmp/loop.jsonl node --require guard-sync-port.cjs --require loop-delay-preload.cjs cli.cjs serve ...
// Every ADE_PERF_LOOP_DELAY_WINDOW_MS (default 5000) it appends one line
//   {"at": <iso>, "p50Ms", "p99Ms", "maxMs", "meanMs", "eluPct"}
// from perf_hooks.monitorEventLoopDelay (20 ms resolution) and eventLoopUtilization, then resets.
// Only the process that loaded it writes (child processes that inherit execArgv are skipped).
"use strict";
const fs = require("node:fs");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

const file = process.env.ADE_PERF_LOOP_DELAY_FILE;
const isServe = process.argv.includes("serve");
if (file && isServe) {
  const windowMs = Math.max(500, Number(process.env.ADE_PERF_LOOP_DELAY_WINDOW_MS ?? 5000));
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastElu = performance.eventLoopUtilization();
  const ms = (ns) => Math.round(ns / 1e5) / 10;
  const timer = setInterval(() => {
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    const row = {
      at: new Date().toISOString(),
      p50Ms: ms(histogram.percentile(50)),
      p99Ms: ms(histogram.percentile(99)),
      maxMs: ms(histogram.max),
      meanMs: ms(histogram.mean),
      eluPct: Math.round(elu.utilization * 1000) / 10,
    };
    histogram.reset();
    try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`); } catch { /* measurement only */ }
  }, windowMs);
  timer.unref();
}
