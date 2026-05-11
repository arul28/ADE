#!/usr/bin/env node
/**
 * Run a single perf scenario end-to-end:
 *  1. Set ADE_PERF_RUN_ID + ADE_PERF_SCENARIO
 *  2. Launch `npm run dev:desktop` as a child process
 *  3. Poll for ~/.ade/perf-runs/<runId>/summary.json to appear
 *  4. Print summary + kill the dev process
 *
 * Usage:
 *   scripts/run-perf-scenario.mjs <scenarioId> [runId]
 *   scripts/run-perf-scenario.mjs lanes.cold-list
 *   scripts/run-perf-scenario.mjs lanes.stress-poll my-baseline
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const positional = [];
let noProject = false;
let initialRoute = null;
for (const arg of process.argv.slice(2)) {
  if (arg === "--no-project") noProject = true;
  else if (arg.startsWith("--route=")) initialRoute = arg.slice("--route=".length);
  else positional.push(arg);
}
const scenarioId = positional[0];
if (!scenarioId) {
  console.error("Usage: run-perf-scenario.mjs <scenarioId> [runId] [--no-project] [--route=/path]");
  process.exit(2);
}
const runId = positional[1] ?? `run-${Date.now()}`;
const dir = join(homedir(), ".ade", "perf-runs", runId);
const summaryPath = join(dir, "summary.json");
const timeoutMs = Number(process.env.ADE_PERF_TIMEOUT_MS ?? 300_000);

mkdirSync(dir, { recursive: true });
if (existsSync(summaryPath)) rmSync(summaryPath);

console.log(`[perf] scenario=${scenarioId} runId=${runId}`);
console.log(`[perf] events → ${join(dir, "events.jsonl")}`);
console.log(`[perf] summary → ${summaryPath}`);

const defaultPerfPass = "/Users/admin/Projects/perf pass";
const perfPassDir = noProject
  ? mkdtempSync(join(tmpdir(), "ade-perf-no-project-"))
  : (process.env.ADE_PERF_PASS_DIR ?? defaultPerfPass);

const env = {
  ...process.env,
  ADE_PERF_RUN_ID: runId,
  ADE_PERF_SCENARIO: scenarioId,
  ADE_PERF_PASS_DIR: perfPassDir,
  ADE_TRACE_IPC: "verbose",
  ADE_MODEL_OVERRIDE: process.env.ADE_MODEL_OVERRIDE ?? "gpt-5-codex",
  ELECTRON_ENABLE_LOGGING: "1",
};
if (initialRoute) env.ADE_PERF_INITIAL_ROUTE = initialRoute;

const child = spawn(
  "npm",
  ["run", "dev:desktop", "--", "--project-root", perfPassDir],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env,
    detached: false,
  }
);

const deadline = Date.now() + timeoutMs;
const cleanup = (code) => {
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

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

(async function pollForSummary() {
  while (Date.now() < deadline) {
    if (existsSync(summaryPath)) {
      try {
        const text = readFileSync(summaryPath, "utf8");
        const summary = JSON.parse(text);
        console.log("\n[perf] summary:");
        console.log(JSON.stringify(summary, null, 2));
        cleanup(0);
        return;
      } catch (err) {
        console.error(`[perf] failed to parse summary: ${err.message}`);
        cleanup(1);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error(`[perf] timed out waiting for ${summaryPath}`);
  cleanup(1);
})();
