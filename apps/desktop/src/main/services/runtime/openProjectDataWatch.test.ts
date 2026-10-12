import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenProjectDataWatch } from "./openProjectDataWatch";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function stats(ino: bigint) {
  return { dev: 1n, ino } as fs.BigIntStats;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createOpenProjectDataWatch", () => {
  it("reports each change of an open project's database once, and only real absence as missing", async () => {
    vi.useFakeTimers();
    // What `<root>/.ade/ade.db` looks like on each 5-second check.
    const ticks: Array<fs.BigIntStats | NodeJS.ErrnoException> = [
      stats(1n), // first sight: remembered, nothing to report
      errno("EIO"), // a drive slow to answer: not a verdict
      errno("ENOENT"), // gone
      errno("ENOENT"), // still gone: not reported again
      stats(1n), // the same file is back
      stats(2n), // another file took its place
      errno("ENOTDIR"), // `.ade` became a file
    ];
    vi.spyOn(fs.promises, "stat").mockImplementation((async () => {
      const next = ticks.shift();
      if (!next || next instanceof Error) throw next ?? errno("ENOENT");
      return next;
    }) as unknown as typeof fs.promises.stat);
    const onChange = vi.fn();
    let open = ["/projects/a"];
    const watch = createOpenProjectDataWatch({ openRoots: () => open, onChange });

    await vi.advanceTimersByTimeAsync(5_000 * 2);
    expect(onChange).not.toHaveBeenCalled();
    expect(watch.problem("/projects/a")).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000 * 2);
    expect(onChange.mock.calls).toEqual([["/projects/a", "missing"]]);
    expect(watch.problem("/projects/a")).toBe("missing");

    await vi.advanceTimersByTimeAsync(5_000 * 3);
    expect(onChange.mock.calls).toEqual([
      ["/projects/a", "missing"],
      ["/projects/a", "replaced"],
      ["/projects/a", "missing"],
    ]);

    // A project that closes is forgotten.
    open = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watch.problem("/projects/a")).toBeNull();
    watch.dispose();
  });
});
