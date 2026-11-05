import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAndroidInstrumentationTests } from "./androidInstrumentationTests";

type GradleRun = { exitCode: number | null; output: string; jdk: { home: string; source: string } };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The service on a lane folder, with Gradle as the process boundary: `gradle`
 * stands in for `gradlew connectedDebugAndroidTest` and writes what the
 * Android Gradle plugin writes.
 */
function harness(gradle: (resultsDir: string) => GradleRun) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-tests-"));
  roots.push(root);
  const resultsDir = path.join(root, "app", "build", "outputs", "androidTest-results", "connected");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outcomes: string[] = [];
  const service = createAndroidInstrumentationTests({
    requireBooted: async () => ({ serial: "emulator-5554" }),
    assertWorkCopyLive: () => {},
    laneRootOrRefuse: () => root,
    runGradleProcess: async () => gradle(resultsDir),
    gradleFailure: (task, run) => new Error(`ANDROID_BUILD_FAILED: ${task} exited ${run.exitCode}`),
    logger: null,
    captureAnalytics: (outcome) => outcomes.push(outcome),
  });
  return { service, resultsDir, outcomes };
}

const jdk = { home: "/jdk", source: "test" };

describe("runInstrumentationTests", () => {
  it("counts this run's JUnit XML, ignores an earlier run's file, and fails the result on a failed test", async () => {
    const { service, outcomes } = harness((resultsDir) => {
      const earlier = path.join(resultsDir, "TEST-earlier.xml");
      fs.writeFileSync(earlier, `<testsuite><testcase classname="com.example.OldTest" name="gone"><failure>old</failure></testcase></testsuite>`);
      const anHourAgo = new Date(Date.now() - 3_600_000);
      fs.utimesSync(earlier, anHourAgo, anHourAgo);
      fs.mkdirSync(path.join(resultsDir, "Pixel_Fold"), { recursive: true });
      fs.writeFileSync(path.join(resultsDir, "Pixel_Fold", "TEST-Pixel_Fold-app-.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <!-- <testcase classname="com.example.Commented" name="notATest"/> -->
  <testsuite name="com.example.LoginTest" tests="3" failures="1">
    <testcase classname="com.example.LoginTest" name="acceptsValid" time="0.4"/>
    <testcase classname="com.example.LoginTest" name="rejectsEmpty" time="0.2">
      <failure message="short">java.lang.AssertionError: expected:&lt;1&gt; but was:&lt;2&gt;
	at com.example.LoginTest.rejectsEmpty(LoginTest.kt:12)</failure>
    </testcase>
    <testcase classname="com.example.LoginTest" name="slow"><skipped/></testcase>
  </testsuite>
</testsuites>`);
      return { exitCode: 1, output: "> Task :app:connectedDebugAndroidTest FAILED", jdk };
    });

    const result = await service.runInstrumentationTests({ laneId: "lane-1" });

    expect(result.source).toBe("junit-xml");
    expect(result.ok).toBe(false);
    expect({ total: result.total, passed: result.passed, failed: result.failed, skipped: result.skipped })
      .toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(result.failures).toEqual([{
      className: "com.example.LoginTest",
      name: "rejectsEmpty",
      message: ["java.lang.AssertionError: expected:<1> but was:<2>", "at com.example.LoginTest.rejectsEmpty(LoginTest.kt:12)"],
    }]);
    expect(result.resultFiles).toHaveLength(1);
    expect(result.gradleTask).toBe(":app:connectedDebugAndroidTest");
    expect(outcomes).toEqual(["tests_run"]);
  });

  it("counts from Gradle's lines when no XML was written, and passes only a clean run", async () => {
    const output = [
      "Starting 2 tests on Pixel_Fold(AVD) - 16",
      "com.example.LoginTest > rejectsEmpty[Pixel_Fold(AVD) - 16] FAILED",
      "    java.lang.AssertionError: expected:<1> but was:<2>",
      "Finished 2 tests on Pixel_Fold(AVD) - 16",
    ].join("\n");
    const failing = await harness(() => ({ exitCode: 1, output, jdk })).service.runInstrumentationTests({ laneId: "lane-1" });
    expect(failing.source).toBe("gradle-output");
    expect(failing.ok).toBe(false);
    expect({ total: failing.total, passed: failing.passed, failed: failing.failed }).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(failing.failures[0]).toEqual({ className: "com.example.LoginTest", name: "rejectsEmpty", message: ["java.lang.AssertionError: expected:<1> but was:<2>"] });

    const passing = await harness(() => ({ exitCode: 0, output: "Starting 2 tests on Pixel_Fold(AVD) - 16\nFinished 2 tests on Pixel_Fold(AVD) - 16", jdk }))
      .service.runInstrumentationTests({ laneId: "lane-1" });
    expect(passing.ok).toBe(true);
    expect({ total: passing.total, passed: passing.passed, failed: passing.failed }).toEqual({ total: 2, passed: 2, failed: 0 });

    // The app crashed under the runner: no test reads FAILED, but Gradle failed, so the run did not pass.
    const crashed = await harness(() => ({ exitCode: 1, output: "Starting 2 tests on Pixel_Fold(AVD) - 16\nTest run failed to complete. Instrumentation run failed due to Process crashed.", jdk }))
      .service.runInstrumentationTests({ laneId: "lane-1" });
    expect(crashed.ok).toBe(false);
    expect(crashed.failed).toBe(0);
  });

  it("refuses as a failed build when Gradle fails before any test runs, and records nothing", async () => {
    const { service, outcomes } = harness(() => ({ exitCode: 1, output: "Compilation error in LoginTest.kt", jdk }));
    await expect(service.runInstrumentationTests({ laneId: "lane-1" })).rejects.toThrow(/ANDROID_BUILD_FAILED: :app:connectedDebugAndroidTest exited 1/);
    expect(outcomes).toEqual([]);
  });
});
