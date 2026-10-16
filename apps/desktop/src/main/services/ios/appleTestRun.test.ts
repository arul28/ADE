import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { Writable } from "node:stream";
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
});
