import fs from "node:fs";
import path from "node:path";
import type { spawn } from "node:child_process";
import type { AppleRunTestsArgs, AppleRunTestsResult } from "../../../shared/types/iosSimulator";
import { signalChildProcessTree } from "../shared/utils";

/**
 * `xcodebuild test` on one lane's device: the argument list, the run, and the
 * reading of its log.
 *
 * What agents did before this existed: made their own simulator with
 * `simctl create`, pointed `xcodebuild` at it with DerivedData in `/tmp`, and
 * left both behind — a 6 GB simulator and a 1.6 GB build folder nobody owned.
 * The service resolves the lane, its device and the scheme; this keeps the
 * build inside the lane's cache (`<build root>/.ade/cache/ios-simulator`),
 * which ADE deletes with the lane. Output streams to a log file rather than
 * being held in memory. A failing test is a result, not an error.
 */

const APPLE_TEST_RUN_DEFAULT_TIMEOUT_MS = 30 * 60_000;
const APPLE_TEST_RUN_MAX_TIMEOUT_MS = 2 * 60 * 60_000;
/** A lane keeps its newest three result bundles (hundreds of megabytes each) and ten logs. */
const KEEP_RESULT_BUNDLES = 3;
const KEEP_LOGS = 10;

type AppleTestRunSpec = {
  projectPath: string;
  scheme: string;
  deviceUdid: string;
  derivedDataPath: string;
  resultBundlePath: string;
  testPlan?: string | null;
  onlyTesting?: readonly string[] | null;
  skipTesting?: readonly string[] | null;
  buildOnly?: boolean | null;
};

/** The `xcodebuild` argv. Parallel testing is always off. */
function buildXcodebuildTestArgs(spec: AppleTestRunSpec): string[] {
  const argv = [
    spec.projectPath.endsWith(".xcworkspace") ? "-workspace" : "-project",
    spec.projectPath,
    "-scheme",
    spec.scheme,
    "-destination",
    `platform=iOS Simulator,id=${spec.deviceUdid}`,
    "-derivedDataPath",
    spec.derivedDataPath,
    "-parallel-testing-enabled",
    "NO",
    "-resultBundlePath",
    spec.resultBundlePath,
  ];
  if (spec.testPlan?.trim()) argv.push("-testPlan", spec.testPlan.trim());
  for (const id of spec.onlyTesting ?? []) if (id.trim()) argv.push(`-only-testing:${id.trim()}`);
  for (const id of spec.skipTesting ?? []) if (id.trim()) argv.push(`-skip-testing:${id.trim()}`);
  argv.push(spec.buildOnly ? "build-for-testing" : "test");
  return argv;
}

/** Counts and the lines that matter, from the whole `xcodebuild` output. */
function summarizeXcodebuildTestLog(
  output: string,
  run: { timedOut: boolean; timeoutMs: number },
): { testsExecuted: number | null; testsFailed: number | null; summary: string } {
  const executed = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].pop();
  const failingLines = output.split(/\r?\n/).filter((line) => (
    /Test Case .* failed|: error:|\*\* TEST (FAILED|BUILD FAILED)|\*\* BUILD FAILED/.test(line)
  ));
  const summary = [
    run.timedOut ? `Timed out after ${Math.round(run.timeoutMs / 60_000)} min.` : null,
    ...failingLines.slice(0, 30),
    failingLines.length ? null : output.trimEnd().split(/\r?\n/).slice(-15).join("\n"),
  ].filter(Boolean).join("\n");
  return {
    testsExecuted: executed ? Number(executed[1]) : null,
    testsFailed: executed ? Number(executed[2]) : null,
    summary,
  };
}

/** Keep the newest `keep` entries of a cache directory, delete the rest. Best effort. */
async function pruneCacheEntries(directory: string, keep: number): Promise<void> {
  const entries = await fs.promises.readdir(directory).catch(() => [] as string[]);
  const stats = await Promise.all(entries.map(async (name) => {
    const full = path.join(directory, name);
    const stat = await fs.promises.stat(full).catch(() => null);
    return stat ? { full, mtimeMs: stat.mtimeMs } : null;
  }));
  const sorted = stats.filter((entry): entry is { full: string; mtimeMs: number } => Boolean(entry))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of sorted.slice(keep)) {
    await fs.promises.rm(entry.full, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Run the tests and read the result. The caller holds the one-run-at-a-time claim and the device. */
export async function runXcodebuildTests(input: {
  projectRoot: string;
  projectPath: string;
  scheme: string;
  device: { udid: string; name: string };
  derivedDataPath: string;
  testArgs: Pick<AppleRunTestsArgs, "testPlan" | "onlyTesting" | "skipTesting" | "buildOnly" | "timeoutMs">;
  spawnProcess: typeof spawn;
}): Promise<AppleRunTestsResult> {
  const cacheRoot = path.dirname(input.derivedDataPath);
  const resultsDir = path.join(cacheRoot, "test-results");
  const logsDir = path.join(cacheRoot, "test-logs");
  await Promise.all([input.derivedDataPath, resultsDir, logsDir].map((dir) => fs.promises.mkdir(dir, { recursive: true })));
  // Room for this run's bundle and log.
  await pruneCacheEntries(resultsDir, KEEP_RESULT_BUNDLES - 1);
  await pruneCacheEntries(logsDir, KEEP_LOGS - 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultBundlePath = path.join(resultsDir, `${stamp}.xcresult`);
  const logPath = path.join(logsDir, `${stamp}.log`);
  const argv = buildXcodebuildTestArgs({
    projectPath: input.projectPath,
    scheme: input.scheme,
    deviceUdid: input.device.udid,
    derivedDataPath: input.derivedDataPath,
    resultBundlePath,
    ...input.testArgs,
  });
  const timeoutMs = Math.min(
    Math.max(Number(input.testArgs.timeoutMs) || APPLE_TEST_RUN_DEFAULT_TIMEOUT_MS, 60_000),
    APPLE_TEST_RUN_MAX_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  let timedOut = false;
  const log = fs.createWriteStream(logPath);
  // A full disk mid-run must not become an uncaught error in the brain; the
  // run's own result still comes from xcodebuild's exit code.
  log.on("error", () => undefined);
  const child = input.spawnProcess("xcodebuild", argv, { cwd: input.projectRoot, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        signalChildProcessTree(child, "SIGTERM");
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(typeof code === "number" ? code : null);
      });
    });
  } finally {
    // Closed or failed, either ends the wait: a stream that errored never closes cleanly.
    if (!log.destroyed) {
      await new Promise<void>((resolve) => {
        log.once("close", () => resolve());
        log.once("error", () => resolve());
        log.end();
      });
    }
  }
  const output = await fs.promises.readFile(logPath, "utf8").catch(() => "");
  return {
    passed: exitCode === 0 && !timedOut,
    exitCode,
    timedOut,
    deviceUdid: input.device.udid,
    deviceName: input.device.name,
    scheme: input.scheme,
    projectPath: input.projectPath,
    derivedDataPath: input.derivedDataPath,
    resultBundlePath: fs.existsSync(resultBundlePath) ? resultBundlePath : null,
    logPath,
    ...summarizeXcodebuildTestLog(output, { timedOut, timeoutMs }),
    durationMs: Date.now() - startedAt,
  };
}
