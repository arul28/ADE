import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runXcodebuildTests } from "./appleTestRun";

describe("runXcodebuildTests log cleanup", () => {
  let projectRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  it("returns when an earlier log error already destroyed the stream", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-test-run-"));
    const log = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    log.destroy();
    await once(log, "close");
    const end = vi.spyOn(log, "end");
    vi.spyOn(fs, "createWriteStream").mockReturnValue(log as never);

    const spawnProcess = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null };
      child.stdout = null;
      child.stderr = null;
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as never;

    const result = await runXcodebuildTests({
      projectRoot,
      projectPath: path.join(projectRoot, "ADE.xcodeproj"),
      scheme: "ADE",
      device: { udid: "simulator", name: "iPhone" },
      derivedDataPath: path.join(projectRoot, "DerivedData"),
      testArgs: {},
      spawnProcess,
    });

    expect(result.passed).toBe(true);
    expect(end).not.toHaveBeenCalled();
  });

  it("counts XCTest and Swift Testing together and lists each failing test once", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-test-run-"));
    // Lines as xcodebuild 27.1 printed them for a bundle with both frameworks.
    const log = [
      "Test Suite 'All tests' started at 2026-10-27 21:43:33.181.",
      "/tmp/p/Tests/VLDTests.swift:6: error: -[VLDTests.OldTests testBad] : XCTAssertEqual failed: (\"2\") is not equal to (\"5\") - five",
      "Test Case '-[VLDTests.OldTests testBad]' failed (0.217 seconds).",
      "Test Case '-[VLDTests.OldTests testSkipped]' skipped (0.011 seconds).",
      "Test Suite 'OldTests' failed at 2026-10-27 21:43:33.413.",
      "\t Executed 3 tests, with 1 test skipped and 1 failure (0 unexpected) in 0.228 (0.231) seconds",
      "Test Suite 'All tests' failed at 2026-10-27 21:43:33.413.",
      "\t Executed 3 tests, with 1 test skipped and 1 failure (0 unexpected) in 0.228 (0.232) seconds",
      "◇ Test run started.",
      "✔ Test passes() passed after 0.001 seconds.",
      "✘ Test \"Two is three\" recorded an issue at VLDTests.swift:13:5: Expectation failed: 2 == 3",
      "✘ Test \"Two is three\" recorded an issue at VLDTests.swift:14:5: Expectation failed: 4 == 5",
      "✘ Test \"Two is three\" failed after 0.006 seconds with 2 issues.",
      "\u200b➜ Test skipped() skipped: \"nope\"",
      "✘ Suite MathSuite failed after 0.007 seconds with 2 issues.",
      "✘ Test run with 3 tests in 1 suite failed after 0.007 seconds with 2 issues.",
      "** TEST FAILED **",
      "",
    ].join("\n");
    const spawnProcess = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdout.end(log, () => setTimeout(() => child.emit("close", 65), 20));
      return child;
    }) as never;

    const result = await runXcodebuildTests({
      projectRoot,
      projectPath: path.join(projectRoot, "VLD.xcodeproj"),
      scheme: "VLD",
      device: { udid: "simulator", name: "iPad" },
      derivedDataPath: path.join(projectRoot, "DerivedData"),
      testArgs: {},
      spawnProcess,
    });

    expect(result).toMatchObject({ passed: false, testsExecuted: 6, testsFailed: 2, testsSkipped: 2 });
    expect(result.failures).toEqual([
      { test: "VLDTests/OldTests/testBad", file: "/tmp/p/Tests/VLDTests.swift", line: 6, message: "XCTAssertEqual failed: (\"2\") is not equal to (\"5\") - five" },
      { test: "Two is three", file: "VLDTests.swift", line: 13, message: "Expectation failed: 2 == 3\nExpectation failed: 4 == 5" },
    ]);
    // The summary keeps xcodebuild's lines, one per line.
    expect(result.summary.split("\n")).toContain("** TEST FAILED **");
  });
});
