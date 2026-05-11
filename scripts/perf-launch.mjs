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

const runId = args.runId ?? `warm-${Date.now()}`;
mkdirSync(join(homedir(), ".ade", "perf-runs", runId), { recursive: true });

const defaultPerfPass = "/Users/admin/Projects/perf pass";
const projectRoot = args.noProject
  ? mkdtempSync(join(tmpdir(), "ade-perf-no-project-"))
  : (args.projectRoot ?? process.env.ADE_PERF_PASS_DIR ?? defaultPerfPass);

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

const stop = (code) => {
  try {
    if (!child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000).unref();
    }
  } catch {
    // ignore
  }
  process.exit(code);
};

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
child.on("exit", (code) => process.exit(code ?? 0));
