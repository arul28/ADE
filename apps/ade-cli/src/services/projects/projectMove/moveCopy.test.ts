import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The `du` command line of every run, so a second check that starts its own is visible. */
const duRuns = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = (...args: unknown[]) => {
    if (args[0] === "/usr/bin/du") duRuns.push((args[1] as string[] | undefined) ?? []);
    return (actual.execFile as unknown as (...callArgs: unknown[]) => unknown)(...args);
  };
  // `moveCopy` calls `util.promisify(execFile)`, which uses this symbol instead
  // of the callback form; record there too, or the wrapper is bypassed.
  const promisified = (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom];
  (run as unknown as Record<symbol, unknown>)[promisify.custom] = (...args: unknown[]) => {
    if (args[0] === "/usr/bin/du") duRuns.push((args[1] as string[] | undefined) ?? []);
    return (promisified as (...callArgs: unknown[]) => unknown)(...args);
  };
  return { ...actual, execFile: run };
});

import { measureProject, writeCopyList } from "./moveCopy";

const created: string[] = [];

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-measure-project-"));
  created.push(root);
  fs.writeFileSync(path.join(root, "file.bin"), Buffer.alloc(64 * 1024));
  return root;
}

beforeEach(() => {
  duRuns.length = 0;
});

afterEach(() => {
  for (const root of created.splice(0)) {
    fs.chmodSync(root, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// DARWIN-GATE: `du -skI` (leaving out node_modules) is BSD `du`, and the move is
// macOS-only; no macOS runner executes the ade-cli vitest suites.
describe.skipIf(process.platform !== "darwin")("measureProject", () => {
  it("keeps one measurement in flight and counts its minute from when it finished", async () => {
    const root = tempProject();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const startedAt = Date.now();
      const first = measureProject(root);
      const second = measureProject(root);
      // A check on every destination change joins the `du` already running.
      // One measurement is two runs (with and without node_modules); a second
      // check that started its own would double that.
      vi.setSystemTime(startedAt + 90_000);
      await Promise.all([first, second]);
      expect(duRuns).toHaveLength(2);
      const sizes = await first;
      expect(sizes.measured).toBe(true);
      if (!sizes.measured) return;
      expect(sizes.copyBytes).toBeGreaterThan(0);
      // The minute counts from the finish, so a measurement that ran 90s is
      // still reusable just after it ends; counting from the start threw it
      // away before any check could use it.
      vi.setSystemTime(startedAt + 120_000);
      await measureProject(root);
      expect(duRuns).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.getuid?.() === 0)("reports an unreadable project as unmeasured instead of 0 B", async () => {
    const root = tempProject();
    fs.chmodSync(root, 0o000);
    // 0 B would tell the move the destination has room it never checked.
    expect((await measureProject(root)).measured).toBe(false);
  });
});

// DARWIN-GATE: the move copies with BSD `find`/`ditto`, macOS only.
describe.skipIf(process.platform !== "darwin")("the move leaves out the Apple tools' DerivedData", () => {
  it("lists neither the main checkout's nor a lane's DerivedData, and does not count them in the copy", async () => {
    const root = tempProject();
    const derived = [
      path.join(root, ".ade", "cache", "ios-simulator", "DerivedData"),
      path.join(root, ".ade", "worktrees", "lane-a", ".ade", "cache", "ios-simulator", "DerivedData"),
    ];
    for (const dir of derived) {
      fs.mkdirSync(path.join(dir, "SourcePackages"), { recursive: true });
      // SwiftPM's state names absolute paths; copied, it breaks the next build.
      fs.writeFileSync(path.join(dir, "SourcePackages", "workspace-state.json"), Buffer.alloc(2 * 1024 * 1024));
    }
    const logs = path.join(root, ".ade", "worktrees", "lane-a", ".ade", "cache", "ios-simulator", "test-logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "run.log"), "kept");

    const listFile = path.join(root, "..", `${path.basename(root)}-list.txt`);
    created.push(listFile);
    await writeCopyList(root, listFile, [], false);
    const listed = fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean);
    expect(listed.some((entry) => entry.includes("DerivedData"))).toBe(false);
    expect(listed).toContain("./.ade/worktrees/lane-a/.ade/cache/ios-simulator/test-logs/run.log");
    expect(listed).toContain("./file.bin");

    const sizes = await measureProject(root);
    expect(sizes.measured).toBe(true);
    if (!sizes.measured) return;
    // 64 KB of project, not the 4 MB of build state beside it.
    expect(sizes.copyBytes).toBeLessThan(1024 * 1024);
  });
});

