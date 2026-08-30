import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregate,
  summarizeChatTextFlushes,
  summarizeMainLoopDelay,
  summarizeStreamSmoothness,
  type ChatTextFlushSample,
  type StreamSmoothnessSample,
} from "./aggregator";

function flush(
  sessionId: string,
  chars: number,
  deltasCoalesced: number,
  msSinceLastFlush: number | null,
  reason = "timer",
): ChatTextFlushSample {
  return { ts: 0, sessionId, chars, deltasCoalesced, msSinceLastFlush, reason };
}

const createdRunIds: string[] = [];

function writeEvents(runId: string, events: Array<Record<string, unknown>>): void {
  createdRunIds.push(runId);
  const dir = join(homedir(), ".ade", "perf-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}

describe("aggregate", () => {
  afterEach(() => {
    for (const runId of createdRunIds.splice(0)) {
      rmSync(join(homedir(), ".ade", "perf-runs", runId), {
        recursive: true,
        force: true,
      });
    }
  });

  it("rejects traversal run ids", () => {
    expect(() => aggregate("../outside")).toThrow(/Invalid perf run id/);
  });

  it("skips malformed process metric samples", () => {
    const runId = `test-run-${process.pid}-${Date.now()}`;
    writeEvents(runId, [
      { ts: 1, kind: "scenarioStart", scenario: "boot.open-project" },
      { ts: 2, kind: "processMetrics" },
      {
        ts: 3,
        kind: "processMetrics",
        processes: [{ pid: 1, type: "Browser", cpuPercent: 12, workingSetSizeKb: 256 }],
        mainRss: 1024,
        mainHeapUsed: 512,
      },
      { ts: 4, kind: "scenarioEnd", scenario: "boot.open-project", ok: true },
    ]);

    const summary = aggregate(runId);

    expect(summary.process.mainCpuPercentP95).toBe(12);
    expect(summary.scenarios["boot.open-project"]?.ok).toBe(true);
  });

  it("summarizes chat text flush and main loop delay events end to end", () => {
    const runId = `test-run-chat-${process.pid}-${Date.now()}`;
    writeEvents(runId, [
      { ts: 1, kind: "scenarioStart", scenario: "chat.stream" },
      {
        ts: 2,
        kind: "chatTextFlush",
        sessionId: "s1",
        chars: 10,
        deltasCoalesced: 3,
        msSinceLastFlush: null,
        reason: "timer",
      },
      {
        ts: 3,
        kind: "chatTextFlush",
        sessionId: "s1",
        chars: 30,
        deltasCoalesced: 5,
        msSinceLastFlush: 100,
        reason: "interleave",
      },
      { ts: 4, kind: "mainLoopDelay", p50: 1, p95: 4, max: 9 },
      { ts: 5, kind: "mainLoopDelay", p50: 2, p95: 12, max: 40 },
      {
        ts: 5,
        kind: "streamSmoothness",
        sessionId: "s1",
        framesTotal: 60,
        framesAdvanced: 20,
        advancedRatio: 0.33,
        gapP50: 33,
        gapP95: 80,
        gapMax: 120,
        frameIntervalP50: 16.7,
        durationMs: 1000,
        charsAdvanced: 400,
      },
      { ts: 6, kind: "scenarioEnd", scenario: "chat.stream", ok: true },
    ]);

    const summary = aggregate(runId);

    expect(summary.chatText.flushes).toBe(2);
    expect(summary.chatText.chars).toBe(40);
    expect(summary.chatText.meanCharsPerFlush).toBe(20);
    expect(summary.chatText.maxCharsPerFlush).toBe(30);
    expect(summary.chatText.reasonCounts).toEqual({ timer: 1, interleave: 1 });
    expect(summary.chatText.perSession).toHaveLength(1);
    expect(summary.mainLoop).toEqual({ samples: 2, p95: 4, max: 40 });
    expect(summary.streamSmoothness).toEqual({
      windows: 1,
      framesTotal: 60,
      framesAdvanced: 20,
      advancedRatio: 0.33,
      estimatedHz: 60,
      advancedPerSecond: 20,
      advancedRatio60: 0.33,
      worstWindowGapP95: 80,
      worstWindowGapMax: 120,
      charsAdvanced: 400,
    });
  });
});

describe("summarizeStreamSmoothness", () => {
  const window = (
    framesTotal: number,
    framesAdvanced: number,
    gapP95: number,
    gapMax: number,
    charsAdvanced: number,
    frameIntervalP50 = 16.67,
    durationMs = 1000,
  ): StreamSmoothnessSample => ({
    ts: 0,
    sessionId: "s1",
    framesTotal,
    framesAdvanced,
    advancedRatio: framesTotal > 0 ? framesAdvanced / framesTotal : 0,
    gapP50: 0,
    gapP95,
    gapMax,
    frameIntervalP50,
    durationMs,
    charsAdvanced,
  });

  it("weights the overall ratio by frames, not by window", () => {
    // Naively averaging the window ratios (0.9, 0.1) gives 0.5; weighting by
    // frames gives 92/120 = 0.77, which is what a viewer actually experienced.
    const summary = summarizeStreamSmoothness([
      window(100, 90, 20, 30, 900),
      window(20, 2, 200, 400, 10),
    ]);

    expect(summary.windows).toBe(2);
    expect(summary.framesTotal).toBe(120);
    expect(summary.framesAdvanced).toBe(92);
    expect(summary.advancedRatio).toBe(0.77);
    // Worst single window, not an average — the stall the user felt.
    expect(summary.worstWindowGapP95).toBe(200);
    expect(summary.worstWindowGapMax).toBe(400);
    expect(summary.charsAdvanced).toBe(910);
  });

  it("normalizes across displays: 240 Hz and 60 Hz runs painting alike score alike", () => {
    // Same stream, same wall clock, same 40 advancing frames per second. The
    // 240 Hz machine sees 4x the rAF callbacks, so its raw advancedRatio is 4x
    // worse for identical painting — the exact trap this normalization exists
    // to close.
    const fast = summarizeStreamSmoothness([window(240, 40, 20, 30, 400, 4.17, 1000)]);
    const slow = summarizeStreamSmoothness([window(60, 40, 20, 30, 400, 16.67, 1000)]);

    expect(fast.estimatedHz).toBe(240);
    expect(slow.estimatedHz).toBe(60);
    expect(fast.advancedRatio).toBe(0.17);
    expect(slow.advancedRatio).toBe(0.67);

    expect(fast.advancedPerSecond).toBe(40);
    expect(slow.advancedPerSecond).toBe(40);
    expect(fast.advancedRatio60).toBe(0.67);
    expect(slow.advancedRatio60).toBe(0.67);
  });

  it("caps advancedRatio60 at 1 when a high-Hz display advances faster than 60/s", () => {
    const summary = summarizeStreamSmoothness([window(240, 200, 5, 10, 2000, 4.17, 1000)]);

    expect(summary.advancedPerSecond).toBe(200);
    expect(summary.advancedRatio60).toBe(1);
  });

  it("takes estimatedHz from the median window so one hitched window cannot move it", () => {
    const summary = summarizeStreamSmoothness([
      window(240, 40, 20, 30, 400, 4.17, 1000),
      window(240, 40, 20, 30, 400, 4.17, 1000),
      window(30, 5, 400, 900, 50, 33.3, 1000),
    ]);

    expect(summary.estimatedHz).toBe(240);
  });

  it("reports zero rates when windows predate the frame-interval fields", () => {
    const legacy = summarizeStreamSmoothness([window(60, 40, 20, 30, 400, 0, 0)]);

    expect(legacy.estimatedHz).toBe(0);
    expect(legacy.advancedPerSecond).toBe(0);
    expect(legacy.advancedRatio60).toBe(0);
    // The display-dependent ratio still works on old events.
    expect(legacy.advancedRatio).toBe(0.67);
  });

  it("returns zeros with no windows", () => {
    expect(summarizeStreamSmoothness([])).toEqual({
      windows: 0,
      framesTotal: 0,
      framesAdvanced: 0,
      advancedRatio: 0,
      estimatedHz: 0,
      advancedPerSecond: 0,
      advancedRatio60: 0,
      worstWindowGapP95: 0,
      worstWindowGapMax: 0,
      charsAdvanced: 0,
    });
  });
});

describe("summarizeChatTextFlushes", () => {
  it("aggregates overall and per-session stats", () => {
    const summary = summarizeChatTextFlushes([
      flush("a", 10, 2, null),
      flush("a", 20, 4, 100),
      flush("b", 60, 1, 300, "identityBreak"),
    ]);

    expect(summary.flushes).toBe(3);
    expect(summary.chars).toBe(90);
    expect(summary.deltasCoalesced).toBe(7);
    expect(summary.meanCharsPerFlush).toBe(30);
    expect(summary.maxCharsPerFlush).toBe(60);
    // Only the two samples that carry a gap participate in the gap stats.
    expect(summary.meanMsSinceLastFlush).toBe(200);
    // Repo-wide percentile convention: floor((n-1) * p) index into the sorted array.
    expect(summary.p95MsSinceLastFlush).toBe(100);
    expect(summary.reasonCounts).toEqual({ timer: 2, identityBreak: 1 });

    // Sorted by chars descending.
    expect(summary.perSession.map((s) => s.sessionId)).toEqual(["b", "a"]);
    const sessionA = summary.perSession.find((s) => s.sessionId === "a")!;
    expect(sessionA.flushes).toBe(2);
    expect(sessionA.chars).toBe(30);
    expect(sessionA.meanCharsPerFlush).toBe(15);
    expect(sessionA.meanMsSinceLastFlush).toBe(100);
  });

  it("returns zeroed stats for no samples", () => {
    expect(summarizeChatTextFlushes([])).toEqual({
      flushes: 0,
      chars: 0,
      deltasCoalesced: 0,
      meanCharsPerFlush: 0,
      maxCharsPerFlush: 0,
      meanMsSinceLastFlush: 0,
      p95MsSinceLastFlush: 0,
      reasonCounts: {},
      perSession: [],
    });
  });
});

describe("summarizeMainLoopDelay", () => {
  it("takes p95 across window p95s and the max across window maxes", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      ts: i,
      p50: 1,
      p95: i,
      max: i * 2,
    }));

    expect(summarizeMainLoopDelay(samples)).toEqual({ samples: 10, p95: 8, max: 18 });
  });

  it("returns zeros with no samples", () => {
    expect(summarizeMainLoopDelay([])).toEqual({ samples: 0, p95: 0, max: 0 });
  });
});
