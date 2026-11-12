#!/usr/bin/env node
/**
 * Advertises this Mac as a spare iOS CI runner, and stops advertising the
 * moment it is not safe to use.
 *
 * `test-ios` in .github/workflows/ci.yml picks its runner from the
 * `MAC_STUDIO_READY` repository variable. The value is the Unix time this
 * script last proved the machine had room; the router only accepts a stamp
 * younger than ten minutes. Nothing here can make a busy or sleeping Mac take
 * a job — the worst case is the hosted macOS runner, which is where the suite
 * already runs today.
 *
 * A stamp, not a boolean, is deliberate: a Mac that goes to sleep stops
 * publishing, the stamp ages out, and CI falls back on its own. A boolean would
 * stick at `true` forever.
 *
 * What it checks before publishing:
 *   - a runner registered for THIS repository, and its listener running
 *     (this machine already runs runners for other repos; those do not count)
 *   - free disk on the volume that holds the runner's work directory
 *   - macOS's own "memory free percentage" (os.freemem() under-reports on
 *     macOS because it ignores reclaimable pages)
 *   - one-minute load average against the core count
 *
 * Usage:
 *   node scripts/ci/mac-studio-readiness.mjs --dry-run   # print the verdict
 *   node scripts/ci/mac-studio-readiness.mjs --once      # assess and publish
 *   node scripts/ci/mac-studio-readiness.mjs --install   # launchd agent, every 5 min
 *   node scripts/ci/mac-studio-readiness.mjs --uninstall
 *
 * One-time setup on the Mac:
 *   1. Create the runner under the repository's Settings → Actions → Runners →
 *      New self-hosted runner, then unpack it at ~/actions-runner-ade:
 *        mkdir -p ~/actions-runner-ade && cd ~/actions-runner-ade
 *        # run the ./config.sh line GitHub shows you, with:
 *        ./config.sh --labels mac-studio,ios --unattended --replace
 *   2. ./svc.sh install && ./svc.sh start
 *   3. node scripts/ci/mac-studio-readiness.mjs --install
 *
 * Undo at any time with `gh variable set MAC_STUDIO_READY --body 0`; that
 * routes every job back to the hosted runner immediately.
 *
 * `gh` must be authenticated for the account that owns the repository.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  repo: "arul28/ADE",
  variable: "MAC_STUDIO_READY",
  minFreeGb: 25,
  minFreeMemPct: 25,
  maxLoadRatio: 0.6,
  // Re-publish this often while ready so the stamp never ages past the
  // router's 15-minute freshness window. Writes happen only on a state change
  // or on this refresh — on a busy Mac that is one write per transition, not
  // one per tick.
  republishSeconds: 480,
  runnerDir: path.join(process.env.HOME ?? "/tmp", "actions-runner-ade"),
};

const LABEL = "com.ade.mac-studio-readiness";
const PLIST = path.join(process.env.HOME ?? "/tmp", "Library", "LaunchAgents", `${LABEL}.plist`);
const STATE = path.join(process.env.HOME ?? "/tmp", ".ade", "mac-studio-readiness.json");

function parseArgs(argv) {
  const out = { ...DEFAULTS, mode: "once" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.mode = "dry-run";
    else if (arg === "--once") out.mode = "once";
    else if (arg === "--install") out.mode = "install";
    else if (arg === "--uninstall") out.mode = "uninstall";
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--runner-dir") out.runnerDir = argv[++i];
    else if (arg === "--min-free-gb") out.minFreeGb = Number(argv[++i]);
    else if (arg === "--min-free-mem-pct") out.minFreeMemPct = Number(argv[++i]);
    else if (arg === "--max-load-ratio") out.maxLoadRatio = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

/** Free bytes on the filesystem holding `dir`, or null when it cannot be read. */
function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * macOS reports "System-wide memory free percentage" through memory_pressure;
 * os.freemem() counts only completely free pages and reads alarmingly low on a
 * healthy Mac. Falls back to os.freemem() off macOS.
 */
function freeMemoryPct() {
  if (process.platform === "darwin") {
    try {
      const text = execFileSync("memory_pressure", { encoding: "utf8" });
      const match = text.match(/System-wide memory free percentage:\s*(\d+)%/);
      if (match) return Number(match[1]);
    } catch {
      // fall through
    }
  }
  return (os.freemem() / os.totalmem()) * 100;
}

/** The repository URL this runner directory is registered against, if any. */
function registeredRepoUrl(runnerDir) {
  try {
    // The runner writes .runner with a UTF-8 BOM; JSON.parse rejects it.
    const raw = fs.readFileSync(path.join(runnerDir, ".runner"), "utf8").replace(/^\uFEFF/, "");
    const config = JSON.parse(raw);
    return typeof config.gitHubUrl === "string" ? config.gitHubUrl : null;
  } catch {
    return null;
  }
}

/**
 * True when a listener process runs out of exactly this runner directory.
 *
 * `-f` matches the command line, so the pattern is written `Runner[.]Listener`
 * to keep it from matching the shell whose argv contains the pattern text.
 * Matching on the directory rather than the process name matters here: this
 * machine can host runners for other repositories, and those must not make ADE
 * look ready.
 */
function listenerRunning(runnerDir) {
  const escaped = runnerDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    execFileSync("pgrep", ["-f", `${escaped}/bin/Runner[.]Listener`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function assess(options) {
  const cores = os.cpus().length || 1;
  const freeGb = (freeBytes(options.runnerDir) ?? freeBytes(os.homedir()) ?? 0) / 1024 ** 3;
  const memPct = freeMemoryPct();
  const load = os.loadavg()[0];
  const loadRatio = load / cores;

  const repoUrl = registeredRepoUrl(options.runnerDir);
  const expectedUrl = `https://github.com/${options.repo}`;

  const blockers = [];
  if (repoUrl !== expectedUrl) {
    blockers.push(repoUrl === null
      ? `no runner registered at ${options.runnerDir}`
      : `runner at ${options.runnerDir} belongs to ${repoUrl}, not ${expectedUrl}`);
  } else if (!listenerRunning(options.runnerDir)) {
    blockers.push("runner listener not running");
  }
  if (freeGb < options.minFreeGb) blockers.push(`disk ${freeGb.toFixed(1)} GB < ${options.minFreeGb} GB`);
  if (memPct < options.minFreeMemPct) blockers.push(`memory ${memPct.toFixed(0)}% < ${options.minFreeMemPct}%`);
  if (loadRatio > options.maxLoadRatio) blockers.push(`load ${load.toFixed(1)} on ${cores} cores (${loadRatio.toFixed(2)} > ${options.maxLoadRatio})`);

  return {
    ready: blockers.length === 0,
    blockers,
    metrics: {
      freeGb: Number(freeGb.toFixed(1)),
      memPct: Number(memPct.toFixed(0)),
      load: Number(load.toFixed(1)),
      loadRatio: Number(loadRatio.toFixed(2)),
      cores,
    },
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`);
}

function publish(options, value) {
  execFileSync("gh", [
    "variable", "set", options.variable,
    "--repo", options.repo,
    "--body", String(value),
  ], { stdio: "inherit" });
}

function runOnce(options) {
  const verdict = assess(options);
  const now = Math.floor(Date.now() / 1000);
  const value = verdict.ready ? now : 0;
  const previous = readState();

  const summary = `${verdict.ready ? "READY" : "NOT READY"} ` +
    `disk=${verdict.metrics.freeGb}GB mem=${verdict.metrics.memPct}% ` +
    `load=${verdict.metrics.load} (${verdict.metrics.loadRatio} of ${verdict.metrics.cores} cores)` +
    (verdict.blockers.length ? ` (${verdict.blockers.join("; ")})` : "");

  if (options.mode === "dry-run") {
    console.log(summary);
    return;
  }

  // Publish on a state change, or refresh a ready stamp before it can expire.
  const changed = previous.ready !== verdict.ready;
  const stale = verdict.ready && now - (previous.publishedAt ?? 0) >= options.republishSeconds;
  if (changed || stale) {
    publish(options, value);
    writeState({ ready: verdict.ready, publishedAt: now, value, summary });
  }
  console.log(summary);
}

function install(options) {
  const source = path.resolve(new URL(import.meta.url).pathname);
  // Run a stable copy rather than the checkout this was invoked from: a lane
  // worktree can be archived, and the agent must keep working after that.
  // Re-run --install after changing this script.
  const installed = path.join(os.homedir(), ".ade", "bin", "mac-studio-readiness.mjs");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.copyFileSync(source, installed);
  fs.chmodSync(installed, 0o755);

  // A Homebrew Cellar path is pinned to one version and breaks on upgrade;
  // /opt/homebrew/bin/node is the stable symlink.
  const homebrewNode = "/opt/homebrew/bin/node";
  const nodePath = fs.existsSync(homebrewNode) ? homebrewNode : process.execPath;

  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${installed}</string>
    <string>--once</string>
    <string>--repo</string><string>${options.repo}</string>
    <string>--runner-dir</string><string>${options.runnerDir}</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${os.homedir()}/Library/Logs/ade-mac-studio-readiness.log</string>
  <key>StandardErrorPath</key><string>${os.homedir()}/Library/Logs/ade-mac-studio-readiness.log</string>
</dict>
</plist>
`;
  fs.writeFileSync(PLIST, plist);
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["load", PLIST], { stdio: "inherit" });
  console.log(`Installed ${LABEL}: every 5 minutes, running ${installed}`);
  console.log(`Logs: ~/Library/Logs/ade-mac-studio-readiness.log`);
  console.log(`Remove it with: node ${installed} --uninstall`);
}

function uninstall() {
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
  } catch {
    // already unloaded
  }
  fs.rmSync(PLIST, { force: true });
  fs.rmSync(STATE, { force: true });
  console.log(`Removed ${LABEL}. The repository variable is left alone; set it to 0 to stop routing at once.`);
}

const options = parseArgs(process.argv.slice(2));
if (options.mode === "install") install(options);
else if (options.mode === "uninstall") uninstall();
else runOnce(options);
