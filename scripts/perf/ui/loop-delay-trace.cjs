// Records how long a Node process's event loop is held up, in windows.
// Load it into a dev brain (or app) the same way as spawn-trace.cjs:
//   NODE_OPTIONS="--require <abs path>/loop-delay-trace.cjs"
// Every $ADE_LOOP_DELAY_WINDOW_MS (default 5000) each process appends one JSON
// line to $ADE_SPAWN_TRACE_DIR (default /tmp)/loopdelay-<pid>.log: p50, p99 and
// max delay in that window (perf_hooks.monitorEventLoopDelay at 10 ms
// resolution) and the process's CPU time in it. Summarize the brain's lines
// with jq or a one-off script. Never load it into the installed app.
const fs = require("node:fs");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const out = path.join(process.env.ADE_SPAWN_TRACE_DIR || "/tmp", `loopdelay-${process.pid}.log`);
const windowMs = Number(process.env.ADE_LOOP_DELAY_WINDOW_MS || 5000);
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let lastCpu = process.cpuUsage();
const ms = (ns) => Math.round(ns / 1e5) / 10;

const timer = setInterval(() => {
  try {
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    fs.appendFileSync(out, `${JSON.stringify({
      at: Date.now(),
      argv: process.argv.slice(1, 3).map((arg) => path.basename(String(arg))).join(" "),
      p50Ms: ms(histogram.percentile(50)),
      p99Ms: ms(histogram.percentile(99)),
      maxMs: ms(histogram.max),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    })}\n`);
  } catch {
    // Tracing must never break the process it watches.
  }
  histogram.reset();
}, windowMs);
timer.unref();
