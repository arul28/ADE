import fs from "node:fs";
import path from "node:path";
import type { spawn } from "node:child_process";
import type { AppleRunTestsArgs, AppleRunTestsResult, AppleTestFailure } from "../../../shared/types/iosSimulator";
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

/** Counts, failing tests and the lines that matter, from the whole `xcodebuild` output. */
function summarizeXcodebuildTestLog(
  output: string,
  run: { timedOut: boolean; timeoutMs: number },
): {
  testsExecuted: number | null;
  testsFailed: number | null;
  testsSkipped: number | null;
  summary: string;
  failures: AppleTestFailure[];
} {
  const xctest = xcodebuildTestTotal(output);
  const swiftTesting = swiftTestingTotal(output);
  const total = xctest || swiftTesting
    ? {
      executed: (xctest?.executed ?? 0) + (swiftTesting?.executed ?? 0),
      failed: (xctest?.failed ?? 0) + (swiftTesting?.failed ?? 0),
      skipped: (xctest?.skipped ?? 0) + (swiftTesting?.skipped ?? 0),
    }
    : null;
  const failingLines = output.split(/\r?\n/).filter((line) => (
    /Test Case .* failed|Test case '.*' failed|: error:|\*\* TEST (FAILED|BUILD FAILED)|\*\* BUILD FAILED|Test .* recorded an issue|Test (?!run with).* failed after/.test(line)
  ));
  const summary = [
    run.timedOut ? `Timed out after ${Math.round(run.timeoutMs / 60_000)} min.` : null,
    ...failingLines.slice(0, 30),
    failingLines.length ? null : output.trimEnd().split(/\r?\n/).slice(-15).join("\n"),
  ].filter(Boolean).join("\n");
  return {
    testsExecuted: total?.executed ?? null,
    testsFailed: total?.failed ?? null,
    testsSkipped: total?.skipped ?? null,
    summary,
    failures: xcodebuildTestFailures(output),
  };
}

/**
 * The run's total from XCTest's `Executed N tests, with M failures` lines.
 *
 * XCTest prints one per suite, one per bundle, and one for the whole run
 * (under `Test Suite 'All tests'` or `'Selected tests'`); the run's line is
 * the one that counts, and it is also the largest. A run with skips prints
 * "with 1 test skipped and 0 failures", which the old pattern did not match,
 * so a 1273-test run reported the last per-suite 48.
 */
function xcodebuildTestTotal(output: string): { executed: number; failed: number; skipped: number } | null {
  const lines = [...output.matchAll(
    /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?/g,
  )].map((match) => ({
    index: match.index ?? 0,
    executed: Number(match[1]),
    skipped: Number(match[2] ?? 0),
    failed: Number(match[3]),
  }));
  if (!lines.length) return null;
  // The line printed after the run-wide suite's own "passed/failed at" line.
  const runSuite = [...output.matchAll(/Test Suite '(?:All tests|Selected tests)' (?:passed|failed) at/g)].pop();
  if (runSuite?.index !== undefined) {
    const after = lines.find((line) => line.index > (runSuite.index ?? 0));
    if (after) return { executed: after.executed, failed: after.failed, skipped: after.skipped };
  }
  const largest = lines.reduce((best, line) => (line.executed > best.executed ? line : best));
  return { executed: largest.executed, failed: largest.failed, skipped: largest.skipped };
}

const MAX_FAILURES = 200;

/**
 * One entry per failing test, in log order, from both frameworks:
 *
 * - XCTest: `File.swift:11: error: -[Mod.Class testX] : message`, then
 *   `Test Case '-[Mod.Class testX]' failed (…)`. The name becomes
 *   `Mod/Class/testX`, the form `-only-testing` takes.
 * - Swift Testing: `✘ Test name() recorded an issue at File.swift:6:40: message`,
 *   then `✘ Test name() failed after …`.
 * - xcodebuild's own `Test case 'Class/testX()' failed on '…'` line.
 *
 * A test with several issues keeps the first one's place and message and
 * joins the rest; a test that failed with no issue line (a crash) still gets
 * an entry.
 */
function xcodebuildTestFailures(output: string): AppleTestFailure[] {
  const byTest = new Map<string, AppleTestFailure>();
  const add = (test: string, entry: Omit<AppleTestFailure, "test">) => {
    const existing = byTest.get(test);
    if (!existing) {
      if (byTest.size >= MAX_FAILURES) return;
      byTest.set(test, { test, ...entry });
      return;
    }
    if (!existing.file && entry.file) {
      existing.file = entry.file;
      existing.line = entry.line;
    }
    if (entry.message && entry.message !== "failed" && !existing.message.includes(entry.message)) {
      existing.message = existing.message === "failed" ? entry.message : `${existing.message}\n${entry.message}`;
    }
  };
  const xctestName = (objc: string) => {
    // `-[LibTests.OldTests testBad]` -> `LibTests/OldTests/testBad`.
    const match = /^-\[([^\s\]]+) ([^\s\]]+)\]$/u.exec(objc.trim());
    return match ? `${match[1]!.replace(/\./gu, "/")}/${match[2]}` : objc.trim();
  };
  const unquote = (name: string) => name.trim().replace(/^"(.*)"$/u, "$1");
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    let match = /^(.+?):(\d+): error: (-\[[^\]]+\]) : (.*)$/u.exec(line);
    if (match) {
      add(xctestName(match[3]!), { file: match[1]!, line: Number(match[2]), message: match[4]!.trim() });
      continue;
    }
    match = /Test Case '(-\[[^\]]+\])' failed/u.exec(line);
    if (match) {
      add(xctestName(match[1]!), { file: null, line: null, message: "failed" });
      continue;
    }
    match = /Test (?!run with)(.+?) recorded an issue at (.+?):(\d+)(?::\d+)?: (.*)$/u.exec(line);
    if (match) {
      add(unquote(match[1]!), { file: match[2]!, line: Number(match[3]), message: match[4]!.trim() });
      continue;
    }
    match = /Test (?!run with)(?!Case )(?!case ')(.+?) failed after [\d.]+ seconds?/u.exec(line);
    if (match) {
      add(unquote(match[1]!), { file: null, line: null, message: "failed" });
      continue;
    }
    match = /Test case '(.+?)' failed on /u.exec(line);
    if (match) {
      // xcodebuild's Swift name for an XCTest (`Class/testX()`) or a Swift
      // Testing test; skip it when the framework's own line named it already.
      const name = match[1]!;
      const known = [...byTest.keys()].some((key) => key.endsWith(name.replace(/\(\)$/u, "")) || key === name);
      if (!known) add(name, { file: null, line: null, message: "failed" });
    }
  }
  return [...byTest.values()];
}

/**
 * Swift Testing's totals: `✘ Test run with 3 tests in 1 suite failed after
 * 0.001 seconds with 1 issue.` One per test process, so a run with several
 * test bundles prints several; they add up. The count includes skipped tests,
 * as XCTest's does; failures are the tests that printed `failed after`.
 */
function swiftTestingTotal(output: string): { executed: number; failed: number; skipped: number } | null {
  const runs = [...output.matchAll(/Test run with (\d+) tests?(?: in \d+ suites?)? (?:passed|failed) after/gu)];
  if (!runs.length) return null;
  const failed = new Set<string>();
  const skipped = new Set<string>();
  for (const match of output.matchAll(/Test (?!run with)(?!Case )(?!case ')(.+?) failed after [\d.]+ seconds?/gu)) failed.add(match[1]!);
  for (const match of output.matchAll(/Test (?!run with)(?!Case )(?!case ')(.+?) skipped(?:[:.]|$)/gmu)) skipped.add(match[1]!);
  return {
    executed: runs.reduce((sum, match) => sum + Number(match[1]), 0),
    failed: failed.size,
    skipped: skipped.size,
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
