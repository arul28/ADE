/**
 * The Android emulator contract, P3: instrumentation tests
 * (`connectedAndroidTest`) on the lane's emulator. Re-exported from
 * `androidEmulator.ts`; import from there.
 */

import type { AndroidGradleTarget, AndroidLaneArgs } from "./androidEmulator";

/* ──────────────────────────────────────────────────────────────────────────
   P3 INSTRUMENTATION TESTS: `gradlew :<module>:connected<Variant>AndroidTest`
   in the lane's folder, with ANDROID_SERIAL set to the lane's emulator. The
   same Gradle runner and JDK as `install --gradle`. The result comes from the
   JUnit XML the Android Gradle plugin writes, or from Gradle's output when
   there is none.
   ────────────────────────────────────────────────────────────────────────── */

export type AndroidInstrumentationTestArgs = AndroidLaneArgs & {
  /** Module `app` and variant `debug` by default. `gradle: {}` takes both defaults. */
  gradle?: AndroidGradleTarget | null;
  /** One test class (`com.example.LoginTest`). */
  className?: string | null;
  /** One test method of `className`. */
  method?: string | null;
};

export type AndroidInstrumentationTestFailure = {
  className: string;
  name: string;
  /** The first lines of the failure message and stack. */
  message: string[];
};

export type AndroidInstrumentationTestResult = {
  laneId: string;
  /** `:app:connectedDebugAndroidTest`. */
  gradleTask: string;
  /** The `-Pandroid.testInstrumentationRunnerArguments.class=` value, when one was given. */
  filter: string | null;
  /** Gradle ended with exit 0 and no test failed. */
  ok: boolean;
  exitCode: number | null;
  /** Where the counts come from. */
  source: "junit-xml" | "gradle-output";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: AndroidInstrumentationTestFailure[];
  /** The JUnit XML files read (on the emulator's machine). */
  resultFiles: string[];
  /** The HTML report, when the plugin wrote one. */
  reportPath: string | null;
  durationMs: number;
  /** The last lines of Gradle's output. */
  outputTail: string[];
};

export type AndroidEmulatorInstrumentationServiceApi = {
  runInstrumentationTests(args: AndroidInstrumentationTestArgs): Promise<AndroidInstrumentationTestResult>;
};
