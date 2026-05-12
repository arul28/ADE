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
import { existsSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
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

function sanitizeRunId(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
}

const runId = sanitizeRunId(positional[1] ?? `run-${Date.now()}`);
if (!runId) {
  console.error("Usage: run id must contain at least one safe filename character");
  process.exit(2);
}
const dir = join(homedir(), ".ade", "perf-runs", runId);
const summaryPath = join(dir, "summary.json");
const timeoutMs = Number(process.env.ADE_PERF_TIMEOUT_MS ?? 300_000);

mkdirSync(dir, { recursive: true });
if (existsSync(summaryPath)) {
  await rm(summaryPath, { force: true });
}

console.log(`[perf] scenario=${scenarioId} runId=${runId}`);
console.log(`[perf] events → ${join(dir, "events.jsonl")}`);
console.log(`[perf] summary → ${summaryPath}`);

const tempPerfPassDir = noProject ? mkdtempSync(join(tmpdir(), "ade-perf-no-project-")) : null;
const perfPassDir = tempPerfPassDir ?? process.env.ADE_PERF_PASS_DIR ?? join(homedir(), "Projects", "perf pass");

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

const cleanupTempPerfPassDir = async () => {
  if (!tempPerfPassDir) return;
  await rm(tempPerfPassDir, { recursive: true, force: true }).catch(() => {});
};

let cleaningUp = false;
const deadline = Date.now() + timeoutMs;
const cleanup = async (code) => {
  if (cleaningUp) return;
  cleaningUp = true;
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
  await cleanupTempPerfPassDir();
  process.exit(code);
};

process.on("SIGINT", () => { void cleanup(130); });
process.on("SIGTERM", () => { void cleanup(143); });
process.on("uncaughtException", (err) => {
  console.error(`[perf] uncaught error: ${err instanceof Error ? err.message : String(err)}`);
  void cleanup(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`[perf] unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
  void cleanup(1);
});
child.on("exit", (code) => {
  if (!cleaningUp) {
    void cleanupTempPerfPassDir().finally(() => process.exit(code ?? 1));
  }
});

(async function pollForSummary() {
  while (Date.now() < deadline) {
    if (existsSync(summaryPath)) {
      try {
        const text = readFileSync(summaryPath, "utf8");
        const summary = JSON.parse(text);
        console.log("\n[perf] summary:");
        console.log(JSON.stringify(summary, null, 2));
        await cleanup(0);
        return;
      } catch (err) {
        console.error(`[perf] failed to parse summary: ${err.message}`);
        await cleanup(1);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error(`[perf] timed out waiting for ${summaryPath}`);
  await cleanup(1);
})();
