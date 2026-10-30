import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentry is the network boundary: the report is the captured problem.
const captureProblem = vi.fn();
vi.mock("../../../desktop/src/shared/sentry/capture", () => ({
  captureProblem: (...args: unknown[]) => captureProblem(...args),
  flushSentry: async () => true,
  isSentryActive: () => true,
}));

import { startBrainRestartLoopWatch } from "./brainRestartLoop";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
// Past any platform's pid range, so never a live process.
const DEAD_PIDS = [99_999_901, 99_999_902, 99_999_903, 99_999_904, 99_999_905];

type SeedStart = { pid: number; minutesAgo: number; build: string; counted: boolean; stoppedAt?: boolean };

let runtimeDir = "";

function seed(starts: SeedStart[], extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(runtimeDir, "brain-starts.json"), JSON.stringify({
    starts: starts.map((start) => ({
      pid: start.pid,
      at: new Date(NOW - start.minutesAgo * 60_000).toISOString(),
      build: start.build,
      counted: start.counted,
      buildFlipFlop: false,
      ...(start.stoppedAt ? { stoppedAt: new Date(NOW - start.minutesAgo * 60_000 + 1_000).toISOString() } : {}),
    })),
    loopFoundAt: null,
    lastReportedAt: null,
    ...extra,
  }));
}

function readStarts(): { starts: Array<{ pid: number; counted: boolean }>; lastReportedAt: string | null } {
  return JSON.parse(fs.readFileSync(path.join(runtimeDir, "brain-starts.json"), "utf8"));
}

beforeEach(() => {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-restart-loop-"));
  captureProblem.mockReset();
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

describe("brain restart loop report", () => {
  it("reports a crash loop once, after the brain stays up, and not again that day", () => {
    seed([
      { pid: DEAD_PIDS[0], minutesAgo: 4, build: "b1", counted: false },
      { pid: DEAD_PIDS[1], minutesAgo: 3, build: "b1", counted: true },
      { pid: DEAD_PIDS[2], minutesAgo: 2, build: "b1", counted: true },
    ]);
    startBrainRestartLoopWatch({ runtimeDir, build: "b1" });
    expect(readStarts().starts.at(-1)).toMatchObject({ pid: process.pid, counted: true });
    // Not while the loop may still be going.
    expect(captureProblem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * 60_000);
    expect(captureProblem).toHaveBeenCalledTimes(1);
    const [message, options] = captureProblem.mock.calls[0] as [string, { fingerprint: string[]; extra: { restartCount: number } }];
    expect(message).toBe("The brain kept restarting");
    expect(options.fingerprint).toEqual(["brain", "restart_loop", process.platform]);
    expect(options.extra.restartCount).toBe(3);
    expect(readStarts().lastReportedAt).toBe(new Date(NOW + 2 * 60_000).toISOString());

    // A second loop the same day stays quiet.
    const { lastReportedAt } = readStarts();
    seed([
      { pid: DEAD_PIDS[2], minutesAgo: 1, build: "b1", counted: true },
      { pid: DEAD_PIDS[3], minutesAgo: 0.5, build: "b1", counted: true },
      { pid: DEAD_PIDS[4], minutesAgo: 0.2, build: "b1", counted: true },
    ], { lastReportedAt });
    startBrainRestartLoopWatch({ runtimeDir, build: "b1" });
    vi.advanceTimersByTime(10 * 60_000);
    expect(captureProblem).toHaveBeenCalledTimes(1);
  });

  it.each<{ name: string; build: string; previous: Partial<SeedStart>; uptimeSec?: number }>([
    { name: "the previous brain stopped in an orderly way", build: "b1", previous: { stoppedAt: true } },
    { name: "the previous brain is still running", build: "b1", previous: { pid: process.ppid } },
    { name: "an update replaced the build", build: "b2", previous: {} },
    { name: "the computer restarted since the previous brain started", build: "b1", previous: { minutesAgo: 1.5 }, uptimeSec: 60 },
  ])("does not count a start when $name", ({ build, previous, uptimeSec }) => {
    if (uptimeSec !== undefined) vi.spyOn(os, "uptime").mockReturnValue(uptimeSec);
    seed([
      { pid: DEAD_PIDS[0], minutesAgo: 4, build: "b1", counted: true },
      { pid: DEAD_PIDS[1], minutesAgo: 3, build: "b1", counted: true },
      { pid: DEAD_PIDS[2], minutesAgo: 2, build: "b1", counted: false, ...previous },
    ]);
    startBrainRestartLoopWatch({ runtimeDir, build });
    vi.advanceTimersByTime(10 * 60_000);
    const { starts, lastReportedAt } = readStarts();
    expect(starts.at(-1)).toMatchObject({ pid: process.pid, counted: false });
    expect(lastReportedAt).toBeNull();
    expect(captureProblem).not.toHaveBeenCalled();
  });
});
