#!/usr/bin/env node
// Desktop main-process start, from process start to three points:
//   bundle  dist/main/main.cjs (the tsup bundle) has been required and its top level has run
//   ready   Electron's app 'ready' event
//   window  the first BrowserWindow was constructed
// Each mark is milliseconds since the main process started (performance.timeOrigin).
// The metric the compile cache targets is `bundle`; `window` is the user-visible point.
//
// Launches the BUILT desktop main (apps/desktop, through electron.cjs) with the
// Electron binary from node_modules, one launch per run. Each launch gets throwaway
// ADE_HOME, user-data dir, runtime socket and compile-cache dir, so its state is kept
// away from the installed app's ~/.ade and caches. The bench counts any brain that a
// launch starts (its ADE_HOME is in the brain's environment) and kills it. DO_NOT_TRACK
// is set so no telemetry is sent. Each launch quits itself at the window mark.
// The measurement is taken by scripts/perf/desktop-main-start-probe.cjs, loaded
// through NODE_OPTIONS=--require; product code is not changed for it.
//
// usage: node scripts/perf/desktop-main-start.mjs --mode off|cold|warm [--runs 7] [--keep-user-data] [--project <dir>] [--out results.json]
//   off   NODE_DISABLE_COMPILE_CACHE=1: no compile cache (the baseline for the new bootstrap)
//   cold  the cache dir is emptied before every run: a launch right after an update
//   warm  one unmeasured launch fills the cache, then --runs measured launches reuse it
//   --keep-user-data  every launch reuses one user-data dir, as a relaunch does, so
//                     what a launch saves for the next (the shell PATH) is in play;
//                     in warm mode the fill launch also fills it
//   --project <dir>   open <dir> as the startup project (ADE_PROJECT_ROOT), the way a
//                     relaunch after an update or `ade open` does; use a throwaway git
//                     repo, never a real project. Its brain is stopped after each run
// Build the bundle first: `cd apps/desktop && ./node_modules/.bin/tsup`.
// Run it under the machine limiter: `~/ade-perf-handoff/bin/quiet.sh node scripts/perf/desktop-main-start.mjs ...`.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const desktopDir = path.join(repo, "apps/desktop");
const probePath = path.join(repo, "scripts/perf/desktop-main-start-probe.cjs");
const bundlePath = path.join(desktopDir, "dist/main/main.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const opts = { mode: null, runs: 7, out: null, keepUserData: false, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === "--mode") opts.mode = value();
    else if (flag === "--runs") opts.runs = Number(value());
    else if (flag === "--out") opts.out = path.resolve(value());
    else if (flag === "--keep-user-data") opts.keepUserData = true;
    else if (flag === "--project") opts.project = path.resolve(value());
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!["off", "cold", "warm"].includes(opts.mode)) throw new Error("--mode must be off, cold or warm");
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  return opts;
}

// Variables inherited from a shell or an ADE-hosted chat that would point a launch at real state.
const INHERITED_TO_CLEAR = [
  "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE",
  "ADE_HOME", "ADE_PROJECT_ROOT", "ADE_RUNTIME_SOCKET_PATH", "ADE_DEV_RUNTIME_SOCKET_PATH",
  "ADE_DESKTOP_USER_DATA_PATH", "ADE_PERF_RUN_ID", "ADE_PERF_SCENARIO", "ADE_PERF_START_PROBE",
  "ADE_COMPILE_CACHE_DIR", "ADE_PACKAGE_CHANNEL", "VITE_DEV_SERVER_URL", "ADE_RUNTIME_PACKAGED",
  "ADE_DEV_RUNTIME_SYNC", "ADE_ENABLE_DESKTOP_SYNC_HOST", "ADE_DISABLE_SYNC_HOST",
  "ADE_DISABLE_RUNTIME_SERVICE_INSTALL",
];

function launchEnv({ runDir, cacheDir, mode, userDataDir, project }) {
  const env = { ...process.env };
  for (const key of INHERITED_TO_CLEAR) delete env[key];
  Object.assign(env, {
    ADE_HOME: path.join(runDir, "ade-home"),
    ADE_DESKTOP_USER_DATA_PATH: userDataDir ?? path.join(runDir, "user-data"),
    ADE_RUNTIME_SOCKET_PATH: path.join(runDir, "ade-home", "sock", "ade.sock"),
    ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    ADE_DISABLE_SYNC_HOST: "1",
    ADE_COMPILE_CACHE_DIR: cacheDir,
    ADE_PERF_START_PROBE: path.join(runDir, "marks.json"),
    NODE_OPTIONS: `--require ${probePath}`,
    DO_NOT_TRACK: "1",
    ADE_DISABLE_PRODUCT_ANALYTICS: "1",
  });
  if (mode === "off") env.NODE_DISABLE_COMPILE_CACHE = "1";
  if (project) env.ADE_PROJECT_ROOT = project;
  return env;
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return count;
}

function eventNames(adeHome) {
  const logPath = path.join(adeHome, "runtime", "desktop-main.jsonl");
  if (!fs.existsSync(logPath)) return [];
  const names = new Set();
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.event === "string") names.add(entry.event);
    } catch { /* partial line */ }
  }
  return [...names].sort();
}

// The installed app's brain and other agents' dev brains are always running; only a brain
// started by this launch (its environment carries this launch's ADE_HOME) counts as a violation.
const brainPids = () => spawnSync("pgrep", ["-f", "cli.cjs serve|/bin/ade serve"], { encoding: "utf8" }).stdout
  .split("\n").filter(Boolean);

function brainsOwnedBy(pids, adeHome) {
  return pids.filter((pid) => spawnSync("ps", ["eww", "-o", "command=", "-p", pid], { encoding: "utf8" }).stdout
    .includes(`ADE_HOME=${adeHome}`));
}

async function launchOnce({ electronBin, tmpRoot, cacheDir, mode, index, userDataDir, project }) {
  const runDir = path.join(tmpRoot, `run-${index}`);
  fs.mkdirSync(path.join(runDir, "ade-home"), { recursive: true });
  const brainsBefore = new Set(brainPids());
  const stdoutFd = fs.openSync(path.join(runDir, "stdout.log"), "w");
  const stderrFd = fs.openSync(path.join(runDir, "stderr.log"), "w");
  const env = launchEnv({ runDir, cacheDir, mode, userDataDir, project });
  const started = Date.now();
  // A mock keychain: the unsigned dev Electron would otherwise ask the login
  // keychain for its safe-storage key, and wait on a dialog until the timeout.
  const child = spawn(electronBin, ["--use-mock-keychain", "."], {
    cwd: desktopDir,
    env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), RUN_TIMEOUT_MS);
  });
  const outcome = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  const wallMs = Date.now() - started;
  if (outcome === "timeout") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    await exited;
  }
  // Electron helpers share the launch's process group; take any left behind.
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already empty */ }
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const newBrains = brainPids().filter((pid) => !brainsBefore.has(pid));
  const ownBrains = brainsOwnedBy(newBrains, env.ADE_HOME);
  for (const pid of ownBrains) {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
  }

  const marksPath = path.join(runDir, "marks.json");
  if (!fs.existsSync(marksPath)) {
    const stderrTail = fs.readFileSync(path.join(runDir, "stderr.log"), "utf8").split("\n").slice(-20).join("\n");
    throw new Error(`run ${index} wrote no marks (${outcome === "timeout" ? "timed out" : JSON.stringify(outcome)}). stderr tail:\n${stderrTail}`);
  }
  const marks = JSON.parse(fs.readFileSync(marksPath, "utf8"));
  const result = {
    index,
    bundleMs: marks.bundle,
    readyMs: marks.ready,
    windowMs: marks.window,
    spawnToProcessStartMs: marks.timeOrigin - started,
    wallMs,
    node: marks.node,
    electron: marks.electron,
    events: eventNames(env.ADE_HOME),
    ownBrainsStarted: ownBrains.length,
    otherNewBrainProcesses: newBrains.length - ownBrains.length,
  };
  fs.rmSync(runDir, { recursive: true, force: true });
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return {
    n: values.length,
    median: Math.round(median(values)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    sd: Math.round(sd),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(bundlePath)) throw new Error(`no bundle at ${bundlePath}; run tsup in apps/desktop first`);
  const electronBin = createRequire(path.join(desktopDir, "package.json"))("electron");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-start-"));
  const cacheDir = path.join(tmpRoot, "compile-cache");
  const userDataDir = opts.keepUserData ? path.join(tmpRoot, "user-data") : undefined;

  console.error(`[desktop-main-start] mode=${opts.mode} runs=${opts.runs}${opts.keepUserData ? " keep-user-data" : ""} load=${os.loadavg()[0].toFixed(2)}`);
  const runs = [];
  const launches = [];
  let index = 0;
  if (opts.mode === "warm") {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    launches.push(await launchOnce({ electronBin, tmpRoot, cacheDir, mode: opts.mode, index: index++, userDataDir, project: opts.project }));
    const cached = countFiles(cacheDir);
    if (cached === 0) throw new Error("warm: the cache dir is still empty after the fill launch; the cache is not flushed at exit");
    console.error(`[desktop-main-start] cache filled (${cached} files), measuring`);
  }
  for (let i = 0; i < opts.runs; i += 1) {
    if (opts.mode === "cold") fs.rmSync(cacheDir, { recursive: true, force: true });
    const result = await launchOnce({ electronBin, tmpRoot, cacheDir, mode: opts.mode, index: index++, userDataDir, project: opts.project });
    launches.push(result);
    runs.push(result);
    console.error(`[desktop-main-start] run ${i + 1}/${opts.runs}: bundle=${result.bundleMs.toFixed(0)} ready=${result.readyMs.toFixed(0)} window=${result.windowMs.toFixed(0)}`);
    await sleep(500);
  }
  const ownBrainsStarted = launches.reduce((sum, l) => sum + l.ownBrainsStarted, 0);
  const otherNewBrainProcesses = launches.reduce((sum, l) => sum + l.otherNewBrainProcesses, 0);
  const cacheFiles = countFiles(cacheDir);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  const summary = {
    bundle: summarize(runs.map((r) => r.bundleMs)),
    ready: summarize(runs.map((r) => r.readyMs)),
    window: summarize(runs.map((r) => r.windowMs)),
    spawnToProcessStart: summarize(runs.map((r) => r.spawnToProcessStartMs)),
    wall: summarize(runs.map((r) => r.wallMs)),
  };
  const report = {
    mode: opts.mode,
    keepUserData: opts.keepUserData,
    node: runs[0].node,
    electron: runs[0].electron,
    loadAvg1m: os.loadavg()[0],
    ownBrainsStarted,
    otherNewBrainProcesses,
    cacheFilesAfterRuns: cacheFiles,
    eventNames: runs[0].events,
    summary,
    runs,
  };
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ mode: opts.mode, node: report.node, electron: report.electron, summary, ownBrainsStarted, otherNewBrainProcesses, cacheFilesAfterRuns: cacheFiles }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
