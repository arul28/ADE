import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/*
 * The bug is what the OS does with a signal, so these run the helper in a real
 * child process. Skipped on Windows, where SIGTERM is a TerminateProcess and
 * never reaches a listener (see serviceManager/runtimeShutdownRequest.ts).
 */

const HELPER_URL = new URL("./brainStartupSignals.ts", import.meta.url).href;
const REGISTRY_URL = new URL("./brainHomeRegistry.ts", import.meta.url).href;
const PACKAGE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Mirrors runServe: the registry joins, the startup exit is installed, and in
// "graceful" mode the startup exit is removed before a stand-in for the
// graceful handler takes both signals.
const CHILD_SCRIPT = `
const { installStartupSignalExit } = await import(process.env.ADE_TEST_HELPER_URL);
const { createBrainHomeRegistry } = await import(process.env.ADE_TEST_REGISTRY_URL);
const registry = createBrainHomeRegistry({
  home: process.env.ADE_TEST_HOME,
  readProcessStartTimeMs: () => null,
  isPidAlive: () => true,
});
registry.join({ pid: process.pid, endpoint: "test.sock", startedAtMs: 0, label: "test" });
const stopStartupSignalExit = installStartupSignalExit(() => registry.leave(process.pid));
if (process.env.ADE_TEST_MODE === "graceful") {
  stopStartupSignalExit();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      process.stdout.write("graceful\\n");
      process.exit(0);
    });
  }
}
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

type ChildRun = {
  proc: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
};

const children: ChildProcessWithoutNullStreams[] = [];
const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-signals-"));
  homes.push(home);
  return home;
}

// The record path the registry writes for a pid.
function recordPath(home: string, pid: number): string {
  return path.join(home, "brains", `${pid}.json`);
}

function startChild(mode: "startup" | "graceful", home: string): Promise<ChildRun> {
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      ADE_TEST_HELPER_URL: HELPER_URL,
      ADE_TEST_REGISTRY_URL: REGISTRY_URL,
      ADE_TEST_HOME: home,
      ADE_TEST_MODE: mode,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(proc);
  const output = { stdout: "", stderr: "" };
  proc.stdout.on("data", (chunk: Buffer) => { output.stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { output.stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child did not become ready: ${output.stderr}`));
    }, 20_000);
    proc.stdout.on("data", () => {
      if (output.stdout.includes("ready")) {
        clearTimeout(timer);
        resolve({ proc, output });
      }
    });
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited before ready (code=${code}, signal=${signal}): ${output.stderr}`));
    });
  });
}

async function signalAndWaitForExit(run: ChildRun, signal: NodeJS.Signals) {
  const started = performance.now();
  // "close", not "exit": stdout may still be buffered when "exit" fires.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>((resolve) => {
    run.proc.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  // A brain that swallowed the signal never exits; bound the wait so the
  // failure is an assertion rather than a hung test.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 3_000);
  });
  run.proc.kill(signal);
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  return { ...result, exited: result !== null, elapsedMs: performance.now() - started };
}

afterEach(() => {
  for (const proc of children.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("brain startup signal exit", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)(
    "%s during startup exits promptly with code %i and removes the registry record",
    async (signal, expectedCode) => {
      const home = makeHome();
      const run = await startChild("startup", home);
      const pid = run.proc.pid!;
      expect(fs.existsSync(recordPath(home, pid))).toBe(true);

      const outcome = await signalAndWaitForExit(run, signal);

      expect(outcome.exited).toBe(true);
      expect(outcome.code).toBe(expectedCode);
      expect(outcome.signal).toBeNull();
      expect(outcome.elapsedMs).toBeLessThan(1_000);
      expect(fs.existsSync(recordPath(home, pid))).toBe(false);
    },
    30_000,
  );

  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s after the graceful handler takes over runs that handler, not the startup exit",
    async (signal) => {
      const home = makeHome();
      const run = await startChild("graceful", home);

      const outcome = await signalAndWaitForExit(run, signal);

      expect(outcome.exited).toBe(true);
      expect(outcome.code).toBe(0);
      expect(run.output.stdout).toContain("graceful");
    },
    30_000,
  );
});
