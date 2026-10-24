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

import { measureProject } from "./moveCopy";

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

// `du -skI` (leaving out node_modules) is BSD `du`; the move is macOS-only.
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
