import fs from "node:fs";
import path from "node:path";
import type {
  AndroidInstrumentationTestArgs,
  AndroidInstrumentationTestFailure,
  AndroidInstrumentationTestResult,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { readAndroidGradleTarget } from "./androidApps";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";

/*
 * Instrumentation tests on the lane's emulator (plan §6 P3,
 * `connectedAndroidTest`): `gradlew :<module>:connected<Variant>AndroidTest`
 * through the same runner as `install --gradle` (the project's wrapper, the
 * JDK ADE finds, ANDROID_SERIAL set to the lane's emulator, the same time
 * limit and stop on shutdown).
 *
 * The result comes from the JUnit XML the Android Gradle plugin writes under
 * `<module>/build/outputs/androidTest-results/connected/`, only the files
 * this run wrote. With no XML (an older plugin, a run that stopped early) it
 * comes from Gradle's own lines. A build that fails before any test runs is
 * the install's refusal (`ANDROID_BUILD_FAILED`).
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** A Java class name: dot-separated identifiers (`$` for a nested class). */
const CLASS_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/u;
const METHOD_NAME = /^[A-Za-z_$][\w$]*$/u;
/** The message lines kept for each failure. */
const FAILURE_LINES = 6;
const FAILURE_LINE_CHARS = 300;
/** The failures one result carries; the XML files have the rest. */
const MAX_FAILURES = 50;
const OUTPUT_TAIL_LINES = 40;
/** A result file older than the run's start (less this much) is from an earlier run. */
const RESULT_MTIME_SLACK_MS = 2_000;

type GradleRun = { exitCode: number | null; output: string; jdk: { home: string; source: string } };

export type AndroidInstrumentationTestsDeps = {
  /** Refuses with `ANDROID_NOT_RUNNING` when the lane's emulator is not booted. */
  requireBooted: (laneId: string) => Promise<unknown>;
  assertWorkCopyLive: (laneId: string) => void;
  /** The lane's folder, or the refusal that says it is gone. */
  laneRootOrRefuse: (laneId: string, what: string) => string;
  /** `androidApps`' Gradle runner: the exit code and output, a failing build included. */
  runGradleProcess: (laneId: string, root: string, task: string, extraArgs: readonly string[]) => Promise<GradleRun>;
  /** `androidApps`' refusal for a failed Gradle run. */
  gradleFailure: (task: string, run: GradleRun) => Error;
  logger: Logger | null;
  /** One coarse product fact for a run that ran tests. */
  captureAnalytics?: (outcome: "tests_run") => void;
};

type TestCase = { className: string; name: string; status: "passed" | "failed" | "skipped"; message: string[] };
type Counts = { total: number; passed: number; failed: number; skipped: number; failures: AndroidInstrumentationTestFailure[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`, "u").exec(` ${attributes}`);
  return match ? decodeXml(match[1]!) : null;
}

function messageLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FAILURE_LINES)
    .map((line) => (line.length > FAILURE_LINE_CHARS ? `${line.slice(0, FAILURE_LINE_CHARS - 1)}…` : line));
}

/** The test cases of one JUnit XML file (`<testsuite>` or `<testsuites>`). */
function parseJUnitXml(xml: string): TestCase[] {
  const body = xml.replace(/<!--[\s\S]*?-->/gu, "");
  const cases: TestCase[] = [];
  for (const match of body.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const attributes = match[1]!;
    const inner = match[2] ?? "";
    const className = attribute(attributes, "classname") ?? "";
    const name = attribute(attributes, "name") ?? "";
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/u.exec(inner);
    if (failure) {
      const text = failure[3] ? decodeXml(failure[3]) : "";
      const lines = messageLines(text);
      cases.push({ className, name, status: "failed", message: lines.length ? lines : messageLines(attribute(failure[2]!, "message") ?? "") });
    } else if (/<skipped\b/u.test(inner)) {
      cases.push({ className, name, status: "skipped", message: [] });
    } else {
      cases.push({ className, name, status: "passed", message: [] });
    }
  }
  return cases;
}

function countCases(cases: readonly TestCase[]): Counts {
  const failed = cases.filter((entry) => entry.status === "failed");
  const skipped = cases.filter((entry) => entry.status === "skipped").length;
  return {
    total: cases.length,
    passed: cases.length - failed.length - skipped,
    failed: failed.length,
    skipped,
    failures: failed.slice(0, MAX_FAILURES).map(({ className, name, message }) => ({ className, name, message })),
  };
}

/** The XML files this run wrote under `dir`, newest last. Unreadable folders are skipped. */
function findResultFiles(dir: string, sinceMs: number, logger: Logger | null): string[] {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  const walk = (current: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // No results folder is the normal answer of a run that wrote none.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger?.warn("android.instrumentation.results_unreadable", { dir: current, error: getErrorMessage(error) });
      }
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) {
        try {
          const mtimeMs = fs.statSync(full).mtimeMs;
          if (mtimeMs >= sinceMs) found.push({ file: full, mtimeMs });
        } catch (error) {
          logger?.warn("android.instrumentation.result_stat_failed", { file: full, error: getErrorMessage(error) });
        }
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs).map((entry) => entry.file);
}

/**
 * The counts from Gradle's own lines, for a run with no XML:
 *
 *     Starting 3 tests on Pixel_9(AVD) - 16
 *     com.example.LoginTest > rejectsEmpty[Pixel_9(AVD) - 16] FAILED
 *         java.lang.AssertionError: expected:<1> but was:<2>
 *     Finished 3 tests on Pixel_9(AVD) - 16
 */
function countFromGradleOutput(output: string): Counts {
  const lines = output.split(/\r?\n/u);
  let total = 0;
  for (const line of lines) {
    const match = /\b(?:Starting|Finished) (\d+) tests? on\b/u.exec(line);
    if (match) total = Math.max(total, Number(match[1]));
  }
  const failures: AndroidInstrumentationTestFailure[] = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*([\w.$]+) > ([^\s[]+)(?:\[[^\]]*\])? (FAILED|SKIPPED)\s*$/u.exec(lines[index]!);
    if (!match) continue;
    if (match[3] === "SKIPPED") {
      skipped += 1;
      continue;
    }
    const message: string[] = [];
    for (let next = index + 1; next < lines.length && /^\s+\S/u.test(lines[next]!) && message.length < FAILURE_LINES; next += 1) {
      message.push(...messageLines(lines[next]!));
    }
    failures.push({ className: match[1]!, name: match[2]!, message });
  }
  total = Math.max(total, failures.length + skipped);
  return {
    total,
    passed: Math.max(0, total - failures.length - skipped),
    failed: failures.length,
    skipped,
    failures: failures.slice(0, MAX_FAILURES),
  };
}

/** `com.example.LoginTest` or `com.example.LoginTest#rejectsEmpty`, checked; null for the whole suite. */
function testFilter(className: string | null | undefined, method: string | null | undefined): string | null {
  const klass = className?.trim() || null;
  const name = method?.trim() || null;
  if (name && !klass) throw new Error("--method needs --class <fully qualified class name>.");
  if (klass && !CLASS_NAME.test(klass)) throw new Error(`--class must be a fully qualified class name such as com.example.LoginTest (got ${JSON.stringify(klass)}).`);
  if (name && !METHOD_NAME.test(name)) throw new Error(`--method must be a method name such as rejectsEmpty (got ${JSON.stringify(name)}).`);
  return klass ? (name ? `${klass}#${name}` : klass) : null;
}

function outputTail(output: string): string[] {
  return output.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean).slice(-OUTPUT_TAIL_LINES);
}

export function createAndroidInstrumentationTests(deps: AndroidInstrumentationTestsDeps) {
  const { logger } = deps;
  /** Lanes with a run in flight: two runs on one emulator would fight over the device and Gradle's build folder. */
  const running = new Set<string>();

  return {
    async runInstrumentationTests(args: AndroidInstrumentationTestArgs): Promise<AndroidInstrumentationTestResult> {
      const laneId = requireLaneId(args?.laneId);
      deps.assertWorkCopyLive(laneId);
      const { segments, variant } = readAndroidGradleTarget(args.gradle);
      const filter = testFilter(args.className, args.method);
      // An emulator that is off is refused before any build starts.
      await deps.requireBooted(laneId);
      if (running.has(laneId)) {
        throw new AndroidEmulatorFailure("ANDROID_TESTS_RUNNING", "Instrumentation tests already run on this lane's emulator. Wait for them to end, then run again.");
      }
      running.add(laneId);
      try {
        const root = deps.laneRootOrRefuse(laneId, "a Gradle build");
        const task = `:${segments.join(":")}:connected${variant.charAt(0).toUpperCase()}${variant.slice(1)}AndroidTest`;
        const startedAt = Date.now();
        const extraArgs = filter ? [`-Pandroid.testInstrumentationRunnerArguments.class=${filter}`] : [];
        const run = await deps.runGradleProcess(laneId, root, task, extraArgs);
        const moduleDir = path.join(root, ...segments);
        const resultsDir = path.join(moduleDir, "build", "outputs", "androidTest-results", "connected");
        const resultFiles = findResultFiles(resultsDir, startedAt - RESULT_MTIME_SLACK_MS, logger);
        const cases: TestCase[] = [];
        for (const file of resultFiles) {
          try {
            cases.push(...parseJUnitXml(fs.readFileSync(file, "utf8")));
          } catch (error) {
            logger?.warn("android.instrumentation.result_unreadable", { file, error: getErrorMessage(error) });
          }
        }
        const fromXml = cases.length > 0;
        const counts = fromXml ? countCases(cases) : countFromGradleOutput(run.output);
        // No test ran and Gradle failed: the build broke first, as an install's build does.
        if (run.exitCode !== 0 && counts.total === 0) throw deps.gradleFailure(task, run);
        const reportPath = [
          path.join(moduleDir, "build", "reports", "androidTests", "connected", variant, "index.html"),
          path.join(moduleDir, "build", "reports", "androidTests", "connected", "index.html"),
        ].find((candidate) => fs.existsSync(candidate)) ?? null;
        const result: AndroidInstrumentationTestResult = {
          laneId,
          gradleTask: task,
          filter,
          ok: run.exitCode === 0 && counts.failed === 0,
          exitCode: run.exitCode,
          source: fromXml ? "junit-xml" : "gradle-output",
          ...counts,
          resultFiles,
          reportPath,
          durationMs: Date.now() - startedAt,
          outputTail: outputTail(run.output),
        };
        logger?.info("android.instrumentation.finished", {
          laneId,
          task,
          filter,
          exitCode: run.exitCode,
          source: result.source,
          total: result.total,
          failed: result.failed,
          skipped: result.skipped,
          durationMs: result.durationMs,
        });
        if (result.total > 0) deps.captureAnalytics?.("tests_run");
        return result;
      } finally {
        running.delete(laneId);
      }
    },
  };
}
