#!/usr/bin/env node
/**
 * Warm-launch ADE in perf mode pointing at perf-pass on a specific tab.
 * Perf instrumentation is ON but no scenario auto-runs — for Codex to inspect
 * and drive interactively. Quits when you SIGINT/kill it.
 *
 * Usage:
 *   scripts/perf-launch.mjs --tab lanes
 *   scripts/perf-launch.mjs --tab missions --run-id manual
 *   scripts/perf-launch.mjs --tab boot --no-project
 *   scripts/perf-launch.mjs --route /settings --project "/path/to/repo"
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const args = {
  tab: null,
  route: null,
  runId: null,
  projectRoot: null,
  noProject: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--tab") args.tab = argv[++i] ?? null;
  else if (a === "--route") args.route = argv[++i] ?? null;
  else if (a === "--run-id") args.runId = argv[++i] ?? null;
  else if (a === "--project") args.projectRoot = argv[++i] ?? null;
  else if (a === "--no-project") args.noProject = true;
  else if (a === "--help" || a === "-h") {
    console.log(`Usage: perf-launch.mjs --tab <name> [--run-id <id>] [--project <path>] [--no-project]
       perf-launch.mjs --route /<path> [--run-id <id>] [--project <path>] [--no-project]`);
    process.exit(0);
  }
}

const route = args.route ?? (args.tab ? `/${args.tab}` : null);
if (!route) {
  console.error("perf-launch: must pass --tab <name> or --route /<path>");
  process.exit(2);
}

function sanitizeRunId(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
}

const runId = sanitizeRunId(args.runId ?? `warm-${Date.now()}`);
if (!runId) {
  console.error("perf-launch: run id must contain at least one safe filename character");
  process.exit(2);
}
mkdirSync(join(homedir(), ".ade", "perf-runs", runId), { recursive: true });

const tempProjectRoot = args.noProject ? mkdtempSync(join(tmpdir(), "ade-perf-no-project-")) : null;
const projectRoot = tempProjectRoot ?? args.projectRoot ?? process.env.ADE_PERF_PASS_DIR ?? process.cwd();

console.log(`[perf-launch] tab=${args.tab ?? "(route)"} route=${route} runId=${runId}`);
console.log(`[perf-launch] project=${projectRoot}${args.noProject ? " (no-project mode)" : ""}`);
console.log(`[perf-launch] events → ${join(homedir(), ".ade", "perf-runs", runId, "events.jsonl")}`);
console.log(`[perf-launch] press Ctrl-C to quit`);

const env = {
  ...process.env,
  ADE_PERF_RUN_ID: runId,
  ADE_PERF_INITIAL_ROUTE: route,
  ADE_PERF_PASS_DIR: projectRoot,
  ADE_TRACE_IPC: "verbose",
  ADE_MODEL_OVERRIDE: process.env.ADE_MODEL_OVERRIDE ?? "gpt-5-codex",
  ELECTRON_ENABLE_LOGGING: "1",
};
delete env.ADE_PERF_SCENARIO;

const child = spawn(
  "npm",
  ["run", "dev:desktop", "--", "--project-root", projectRoot],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env,
    detached: false,
  }
);

const waitForChildExit = (timeoutMs) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
};

let stopping = false;
const cleanupTempProjectRoot = async () => {
  if (!tempProjectRoot) return;
  await rm(tempProjectRoot, { recursive: true, force: true }).catch(() => {});
};

const stop = async (code) => {
  if (stopping) return;
  stopping = true;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await waitForChildExit(5_000);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(1_000);
      }
    }
  } catch {
    // ignore
  }
  await cleanupTempProjectRoot();
  process.exit(code);
};

process.on("SIGINT", () => { void stop(130); });
process.on("SIGTERM", () => { void stop(143); });
child.on("exit", (code) => {
  if (!stopping) {
    void cleanupTempProjectRoot().finally(() => process.exit(code ?? 0));
  }
});
