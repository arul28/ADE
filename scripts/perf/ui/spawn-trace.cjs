// Records every child process a Node or Electron process starts, with the
// call stack that started it (see docs/perf/macos-baseline.md, "Idle").
// Load it into a dev app and its brain with
//   NODE_OPTIONS="--require <abs path>/spawn-trace.cjs"
// Each process appends JSON lines to $ADE_SPAWN_TRACE_DIR (default the OS temp dir)/spawns-<pid>.log;
// summarize them with spawn-report.mjs. Never load it into the installed app.
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const out = path.join(process.env.ADE_SPAWN_TRACE_DIR || os.tmpdir(), `spawns-${process.pid}.log`);

function record(kind, file, args) {
  try {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const error = new Error();
    Error.stackTraceLimit = limit;
    const frames = (error.stack || "").split("\n").slice(3)
      .map((line) => line.trim().replace(/^at /, ""))
      .filter((line) => line && !line.includes("node:") && !line.includes("spawn-trace.cjs"))
      .slice(0, 22);
    fs.appendFileSync(out, `${JSON.stringify({
      at: Date.now(),
      kind,
      cmd: String(file),
      args: (Array.isArray(args) ? args : []).slice(0, 16).map((arg) => String(arg).slice(0, 60)),
      stack: frames,
    })}\n`);
  } catch {
    // Tracing must never break the process it watches.
  }
}

for (const name of ["spawn", "execFile", "exec", "spawnSync", "execFileSync", "execSync"]) {
  const original = cp[name];
  const wrapped = function (file, args, ...rest) {
    record(name, file, args);
    return original.call(this, file, args, ...rest);
  };
  // promisify(execFile) resolves { stdout, stderr } through this symbol.
  const custom = original[util.promisify.custom];
  if (custom) {
    wrapped[util.promisify.custom] = function (file, args, ...rest) {
      record(name, file, args);
      return custom.call(this, file, args, ...rest);
    };
  }
  cp[name] = wrapped;
}
