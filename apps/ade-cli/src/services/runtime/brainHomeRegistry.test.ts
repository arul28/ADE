import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrainHomeRegistry,
  describeOtherBrains,
  isBrainRecordLive,
} from "./brainHomeRegistry";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-brain-registry-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length) {
    const home = homes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A fake process table: pid -> start time, absent means dead. */
function table(entries: Record<number, number>) {
  return {
    isPidAlive: (pid: number) => pid in entries,
    readProcessStartTimeMs: (pid: number) => entries[pid] ?? null,
  };
}

describe("brain home registry", () => {
  it("tells a joining brain who is already on this home", () => {
    const home = makeHome();
    const procs = table({ 100: 1_000, 200: 2_000 });

    const first = createBrainHomeRegistry({ home, ...procs });
    expect(first.join({ pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1_000, label: "stable" })).toEqual([]);

    const second = createBrainHomeRegistry({ home, ...procs });
    const others = second.join({ pid: 200, endpoint: "/tmp/b.sock", startedAtMs: 2_000, label: "dev" });

    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ pid: 100, endpoint: "/tmp/a.sock", label: "stable" });
  });

  it("never reports the joining brain to itself", () => {
    const home = makeHome();
    const procs = table({ 100: 1_000 });
    const registry = createBrainHomeRegistry({ home, ...procs });
    registry.join({ pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1_000, label: "stable" });
    // A restart under the same pid must not accuse itself.
    expect(registry.join({ pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1_000, label: "stable" })).toEqual([]);
  });

  it("forgets a brain that died, and removes its file", () => {
    const home = makeHome();
    const alive = table({ 100: 1_000, 200: 2_000 });
    createBrainHomeRegistry({ home, ...alive }).join({
      pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1_000, label: "orphan",
    });

    // 100 is gone now.
    const afterDeath = createBrainHomeRegistry({ home, ...table({ 200: 2_000 }) });
    expect(afterDeath.join({ pid: 200, endpoint: "/tmp/b.sock", startedAtMs: 2_000, label: "dev" })).toEqual([]);
    expect(fs.existsSync(path.join(home, "brains", "100.json"))).toBe(false);
  });

  it("does not accuse a process that merely reused the pid number", () => {
    const home = makeHome();
    createBrainHomeRegistry({ home, ...table({ 100: 1_000 }) }).join({
      pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1_000, label: "old",
    });

    // Same pid number, different process: the OS recycled it. Reporting this
    // would name an innocent process as a rival brain.
    const recycled = createBrainHomeRegistry({ home, ...table({ 100: 9_999, 200: 2_000 }) });
    expect(recycled.join({ pid: 200, endpoint: "/tmp/b.sock", startedAtMs: 2_000, label: "dev" })).toEqual([]);
  });

  it("drops its record on leave, so the next brain sees an empty home", () => {
    const home = makeHome();
    const procs = table({ 100: 1_000, 200: 2_000 });
    const first = createBrainHomeRegistry({ home, ...procs });
    first.join({ pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1_000, label: "stable" });
    first.leave(100);
    first.leave(100); // idempotent

    const second = createBrainHomeRegistry({ home, ...procs });
    expect(second.join({ pid: 200, endpoint: "/tmp/b.sock", startedAtMs: 2_000, label: "dev" })).toEqual([]);
  });

  it("survives an unreadable record instead of failing to start", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "brains"), { recursive: true });
    fs.writeFileSync(path.join(home, "brains", "100.json"), "{ not json");
    const registry = createBrainHomeRegistry({ home, ...table({ 100: 1_000, 200: 2_000 }) });
    expect(registry.join({ pid: 200, endpoint: "/tmp/b.sock", startedAtMs: 2_000, label: "dev" })).toEqual([]);
  });

  it("treats a record with no start time as live rather than inventing one", () => {
    expect(isBrainRecordLive(
      { pid: 100, endpoint: "/tmp/a.sock", startedAtMs: null, label: null, recordedAt: "" },
      table({ 100: 1_000 }),
    )).toBe(true);
  });
});

describe("describeOtherBrains", () => {
  it("says nothing when this brain is alone", () => {
    expect(describeOtherBrains([])).toBeNull();
  });

  it("names each brain and what it serves", () => {
    const sentence = describeOtherBrains([
      { pid: 100, endpoint: "/tmp/a.sock", startedAtMs: 1, label: "stable", recordedAt: "" },
      { pid: 200, endpoint: "/tmp/b.sock", startedAtMs: 2, label: null, recordedAt: "" },
    ]);
    expect(sentence).toContain("2 other ADE brains");
    expect(sentence).toContain("stable (pid 100, /tmp/a.sock)");
    // An unlabelled brain still gets a readable name rather than "null".
    expect(sentence).toContain("ADE brain (pid 200, /tmp/b.sock)");
    // Not phrased as a failure: sharing a home is the documented dev loop.
    expect(sentence).not.toMatch(/error|refus|cannot start/i);
  });
});
