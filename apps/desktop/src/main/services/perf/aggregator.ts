import { closeSync, existsSync, openSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Event = { ts: number; kind: string; [key: string]: unknown };

type ProcessMetricSample = {
  ts: number;
  processes: Array<{
    pid: number;
    type: string;
    cpuPercent: number;
    workingSetSizeKb: number;
  }>;
  mainRss: number;
  mainHeapUsed: number;
};

type RendererMemSample = { ts: number; usedMB: number };

type WebVitalSample = {
  ts: number;
  metric: "INP" | "FCP" | "CLS" | "LCP";
  value: number;
  scenario: string | null;
};

type IpcSample = {
  ts: number;
  channel: string;
  durationMs: number;
  failed: boolean;
  scenario: string | null;
};

type MeasureSample = {
  ts: number;
  name: string;
  durationMs: number;
  scenario: string | null;
};

type LongTaskSample = { ts: number; durationMs: number; scenario: string | null };

export type ChatTextFlushSample = {
  ts: number;
  sessionId: string;
  chars: number;
  deltasCoalesced: number;
  msSinceLastFlush: number | null;
  reason: string;
};

export type MainLoopDelaySample = { ts: number; p50: number; p95: number; max: number };

/** One ~1s window of renderer streaming-text paint smoothness. */
export type StreamSmoothnessSample = {
  ts: number;
  sessionId: string | null;
  framesTotal: number;
  framesAdvanced: number;
  advancedRatio: number;
  gapP50: number;
  gapP95: number;
  gapMax: number;
  /** Median rAF interval (ms) in the window. 0 on events from before this field existed. */
  frameIntervalP50: number;
  /** Wall-clock length (ms) of the window. 0 on events from before this field existed. */
  durationMs: number;
  charsAdvanced: number;
};

export type StreamSmoothnessSummary = {
  windows: number;
  framesTotal: number;
  framesAdvanced: number;
  /**
   * Overall ratio, weighted by frames rather than by window.
   *
   * Display-dependent — `framesTotal` is the refresh rate times the run length,
   * so a 240 Hz machine floors this at ~0.25 for a stream that a 60 Hz machine
   * scores at 1.0. Only compare it between runs with the same `estimatedHz`;
   * otherwise use `advancedPerSecond` or `advancedRatio60`.
   */
  advancedRatio: number;
  /**
   * Refresh rate inferred from the median of the per-window median rAF
   * intervals (median of medians, so one hitched window cannot move it).
   * 0 when no window carried `frameIntervalP50`.
   */
  estimatedHz: number;
  /**
   * Advancing frames per second of wall clock — the display-independent form of
   * `advancedRatio`. 0 when no window carried `durationMs`.
   */
  advancedPerSecond: number;
  /**
   * `advancedPerSecond` expressed as a 60 Hz ratio, capped at 1: what
   * `advancedRatio` would have read on a 60 Hz display. This is the number to
   * compare across machines.
   */
  advancedRatio60: number;
  /** Worst single window — the stall the user actually felt. */
  worstWindowGapP95: number;
  worstWindowGapMax: number;
  charsAdvanced: number;
};

export type ChatTextFlushStats = {
  flushes: number;
  chars: number;
  deltasCoalesced: number;
  meanCharsPerFlush: number;
  maxCharsPerFlush: number;
  meanMsSinceLastFlush: number;
  p95MsSinceLastFlush: number;
};

export type ChatTextSummary = ChatTextFlushStats & {
  reasonCounts: Record<string, number>;
  perSession: Array<{ sessionId: string } & ChatTextFlushStats>;
};

export type MainLoopSummary = { samples: number; p95: number; max: number };

type Summary = {
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  scenarios: Record<
    string,
    {
      startedAt: number;
      endedAt: number;
      durationMs: number;
      ok: boolean;
      smokeFailures: string[];
    }
  >;
  fitness: {
    score: number;
    components: {
      interactionLatencyP95: number;
      inpP95: number;
      rendererHeapGrowthMB: number;
      mainCpuSeconds: number;
      ipcP95TopChannels: number;
      longTaskCount: number;
    };
  };
  ipc: {
    perChannel: Array<{
      channel: string;
      count: number;
      p50: number;
      p95: number;
      max: number;
      failedCount: number;
    }>;
    slowChannels: Array<{ channel: string; p95: number; count: number }>;
  };
  marks: Array<{ name: string; count: number; p50: number; p95: number; max: number }>;
  webVitals: {
    inpP95: number;
    inpSamples: number;
    fcp: number | null;
    cls: number;
    longTaskCount: number;
    longTaskTotalMs: number;
  };
  process: {
    mainCpuPercentP95: number;
    mainCpuSecondsApprox: number;
    rendererPeakRssKb: number;
    gpuPeakRssKb: number;
    rendererHeapGrowthMB: number;
    rendererHeapPeakMB: number;
  };
  chatText: ChatTextSummary;
  mainLoop: MainLoopSummary;
  streamSmoothness: StreamSmoothnessSummary;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function chatTextFlushStats(samples: ChatTextFlushSample[]): ChatTextFlushStats {
  let chars = 0;
  let deltasCoalesced = 0;
  let maxCharsPerFlush = 0;
  const gaps: number[] = [];
  for (const sample of samples) {
    chars += sample.chars;
    deltasCoalesced += sample.deltasCoalesced;
    maxCharsPerFlush = Math.max(maxCharsPerFlush, sample.chars);
    if (typeof sample.msSinceLastFlush === "number") gaps.push(sample.msSinceLastFlush);
  }
  const gapsSorted = [...gaps].sort((a, b) => a - b);
  const gapMean = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  return {
    flushes: samples.length,
    chars,
    deltasCoalesced,
    meanCharsPerFlush: samples.length > 0 ? round2(chars / samples.length) : 0,
    maxCharsPerFlush,
    meanMsSinceLastFlush: round2(gapMean),
    p95MsSinceLastFlush: round2(percentile(gapsSorted, 0.95)),
  };
}

export function summarizeChatTextFlushes(samples: ChatTextFlushSample[]): ChatTextSummary {
  const bySession = new Map<string, ChatTextFlushSample[]>();
  const reasonCounts: Record<string, number> = {};
  for (const sample of samples) {
    const arr = bySession.get(sample.sessionId) ?? [];
    arr.push(sample);
    bySession.set(sample.sessionId, arr);
    reasonCounts[sample.reason] = (reasonCounts[sample.reason] ?? 0) + 1;
  }
  const perSession = [...bySession.entries()].map(([sessionId, sessionSamples]) => ({
    sessionId,
    ...chatTextFlushStats(sessionSamples),
  }));
  perSession.sort((a, b) => b.chars - a.chars);
  return { ...chatTextFlushStats(samples), reasonCounts, perSession };
}

export function summarizeMainLoopDelay(samples: MainLoopDelaySample[]): MainLoopSummary {
  const p95Sorted = samples.map((s) => s.p95).sort((a, b) => a - b);
  return {
    samples: samples.length,
    p95: round2(percentile(p95Sorted, 0.95)),
    max: round2(samples.reduce((m, s) => Math.max(m, s.max), 0)),
  };
}

export function summarizeStreamSmoothness(
  samples: StreamSmoothnessSample[],
): StreamSmoothnessSummary {
  let framesTotal = 0;
  let framesAdvanced = 0;
  let charsAdvanced = 0;
  let worstWindowGapP95 = 0;
  let worstWindowGapMax = 0;
  let durationMs = 0;
  const frameIntervals: number[] = [];
  for (const sample of samples) {
    framesTotal += sample.framesTotal;
    framesAdvanced += sample.framesAdvanced;
    charsAdvanced += sample.charsAdvanced;
    worstWindowGapP95 = Math.max(worstWindowGapP95, sample.gapP95);
    worstWindowGapMax = Math.max(worstWindowGapMax, sample.gapMax);
    durationMs += sample.durationMs;
    if (sample.frameIntervalP50 > 0) frameIntervals.push(sample.frameIntervalP50);
  }
  frameIntervals.sort((a, b) => a - b);
  const medianFrameInterval = percentile(frameIntervals, 0.5);
  const advancedPerSecond = durationMs > 0 ? (framesAdvanced * 1000) / durationMs : 0;
  return {
    windows: samples.length,
    framesTotal,
    framesAdvanced,
    advancedRatio: framesTotal > 0 ? round2(framesAdvanced / framesTotal) : 0,
    estimatedHz: medianFrameInterval > 0 ? Math.round(1000 / medianFrameInterval) : 0,
    advancedPerSecond: round2(advancedPerSecond),
    advancedRatio60: round2(Math.min(1, advancedPerSecond / 60)),
    worstWindowGapP95: round2(worstWindowGapP95),
    worstWindowGapMax: round2(worstWindowGapMax),
    charsAdvanced,
  };
}

function visitJsonlEvents(path: string, visit: (event: Event) => void): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = "";
  let count = 0;

  const parseLine = (line: string) => {
    if (!line.trim()) return;
    try {
      visit(JSON.parse(line) as Event);
      count += 1;
    } catch {
      // skip malformed line
    }
  };

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += buffer.toString("utf8", 0, bytesRead);
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        parseLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }
    parseLine(pending);
  } finally {
    closeSync(fd);
  }

  return count;
}

export function aggregate(runId: string): Summary {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes("..")) {
    throw new Error(`Invalid perf run id: ${runId}`);
  }
  const dir = join(homedir(), ".ade", "perf-runs", runId);
  const eventsPath = join(dir, "events.jsonl");

  // Group scenarios.
  type ScenarioState = {
    startedAt: number;
    endedAt: number;
    ok: boolean;
    smokeFailures: string[];
  };
  const scenarios: Record<string, ScenarioState> = {};
  let currentScenario: string | null = null;

  const processSamples: ProcessMetricSample[] = [];
  const rendererMem: RendererMemSample[] = [];
  const webVitals: WebVitalSample[] = [];
  const longTasks: LongTaskSample[] = [];
  const ipcCalls: IpcSample[] = [];
  const measures: MeasureSample[] = [];
  const chatTextFlushes: ChatTextFlushSample[] = [];
  const mainLoopDelays: MainLoopDelaySample[] = [];
  const streamSmoothnessWindows: StreamSmoothnessSample[] = [];

  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = Number.NEGATIVE_INFINITY;
  const eventCount = visitJsonlEvents(eventsPath, (ev) => {
    if (Number.isFinite(ev.ts)) {
      startedAt = Math.min(startedAt, ev.ts);
      endedAt = Math.max(endedAt, ev.ts);
    }
    switch (ev.kind) {
      case "scenarioStart": {
        const name = String(ev.scenario ?? "unknown");
        scenarios[name] = {
          startedAt: ev.ts,
          endedAt: ev.ts,
          ok: false,
          smokeFailures: [],
        };
        currentScenario = name;
        break;
      }
      case "scenarioEnd": {
        const name = String(ev.scenario ?? currentScenario ?? "unknown");
        const state = scenarios[name];
        if (state) {
          state.endedAt = ev.ts;
          state.ok = ev.ok === true;
          if (Array.isArray(ev.smokeFailures)) {
            state.smokeFailures = ev.smokeFailures.map(String);
          }
        }
        currentScenario = null;
        break;
      }
      case "processMetrics": {
        if (!Array.isArray(ev.processes)) {
          break;
        }
        processSamples.push({
          ts: ev.ts,
          processes: ev.processes
            .filter((sample): sample is Record<string, unknown> =>
              Boolean(sample) && typeof sample === "object"
            )
            .map((sample) => ({
              pid: Number(sample.pid ?? 0),
              type: String(sample.type ?? "unknown"),
              cpuPercent: Number(sample.cpuPercent ?? 0),
              workingSetSizeKb: Number(sample.workingSetSizeKb ?? 0),
            })),
          mainRss: Number(ev.mainRss ?? 0),
          mainHeapUsed: Number(ev.mainHeapUsed ?? 0),
        });
        break;
      }
      case "rendererMemory": {
        rendererMem.push({ ts: ev.ts, usedMB: Number(ev.usedMB ?? 0) });
        break;
      }
      case "webVital": {
        webVitals.push({
          ts: ev.ts,
          metric: ev.metric as WebVitalSample["metric"],
          value: Number(ev.value ?? 0),
          scenario: currentScenario,
        });
        break;
      }
      case "longTask": {
        longTasks.push({
          ts: ev.ts,
          durationMs: Number(ev.durationMs ?? 0),
          scenario: currentScenario,
        });
        break;
      }
      case "ipcInvoke": {
        ipcCalls.push({
          ts: ev.ts,
          channel: String(ev.channel ?? "unknown"),
          durationMs: Number(ev.durationMs ?? 0),
          failed: ev.failed === true,
          scenario: currentScenario,
        });
        break;
      }
      case "chatTextFlush": {
        chatTextFlushes.push({
          ts: ev.ts,
          sessionId: String(ev.sessionId ?? "unknown"),
          chars: Number(ev.chars ?? 0),
          deltasCoalesced: Number(ev.deltasCoalesced ?? 0),
          msSinceLastFlush:
            typeof ev.msSinceLastFlush === "number" ? ev.msSinceLastFlush : null,
          reason: String(ev.reason ?? "other"),
        });
        break;
      }
      case "streamSmoothness": {
        streamSmoothnessWindows.push({
          ts: ev.ts,
          sessionId: typeof ev.sessionId === "string" ? ev.sessionId : null,
          framesTotal: Number(ev.framesTotal ?? 0),
          framesAdvanced: Number(ev.framesAdvanced ?? 0),
          advancedRatio: Number(ev.advancedRatio ?? 0),
          gapP50: Number(ev.gapP50 ?? 0),
          gapP95: Number(ev.gapP95 ?? 0),
          gapMax: Number(ev.gapMax ?? 0),
          frameIntervalP50: Number(ev.frameIntervalP50 ?? 0),
          durationMs: Number(ev.durationMs ?? 0),
          charsAdvanced: Number(ev.charsAdvanced ?? 0),
        });
        break;
      }
      case "mainLoopDelay": {
        mainLoopDelays.push({
          ts: ev.ts,
          p50: Number(ev.p50 ?? 0),
          p95: Number(ev.p95 ?? 0),
          max: Number(ev.max ?? 0),
        });
        break;
      }
      case "measure": {
        measures.push({
          ts: ev.ts,
          name: String(ev.name ?? "unknown"),
          durationMs: Number(ev.durationMs ?? 0),
          scenario: currentScenario,
        });
        break;
      }
      default:
        break;
    }
  });

  if (eventCount === 0 || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    throw new Error(`No events found at ${eventsPath}`);
  }

  // IPC per-channel stats.
  const ipcByChannel = new Map<string, number[]>();
  const ipcFailed = new Map<string, number>();
  for (const c of ipcCalls) {
    const arr = ipcByChannel.get(c.channel) ?? [];
    arr.push(c.durationMs);
    ipcByChannel.set(c.channel, arr);
    if (c.failed) ipcFailed.set(c.channel, (ipcFailed.get(c.channel) ?? 0) + 1);
  }
  const ipcPerChannel = [...ipcByChannel.entries()].map(([channel, durations]) => {
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      channel,
      count: sorted.length,
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
      failedCount: ipcFailed.get(channel) ?? 0,
    };
  });
  ipcPerChannel.sort((a, b) => b.p95 - a.p95);
  const slowChannels = ipcPerChannel.filter((c) => c.p95 >= 120).map((c) => ({
    channel: c.channel,
    p95: c.p95,
    count: c.count,
  }));
  const ipcP95TopChannels = ipcPerChannel
    .slice(0, 5)
    .reduce((sum, c) => sum + c.p95, 0);

  // Marks per-name stats.
  const measureByName = new Map<string, number[]>();
  for (const m of measures) {
    const arr = measureByName.get(m.name) ?? [];
    arr.push(m.durationMs);
    measureByName.set(m.name, arr);
  }
  const marks = [...measureByName.entries()].map(([name, durations]) => {
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      name,
      count: sorted.length,
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
    };
  });
  marks.sort((a, b) => b.p95 - a.p95);
  const interactionLatencyP95 = marks.slice(0, 3).reduce((sum, m) => sum + m.p95, 0);

  // Web Vitals stats.
  const inpValues = webVitals.filter((w) => w.metric === "INP").map((w) => w.value);
  const inpSorted = [...inpValues].sort((a, b) => a - b);
  const inpP95 = Math.round(percentile(inpSorted, 0.95));
  const fcpVals = webVitals.filter((w) => w.metric === "FCP").map((w) => w.value);
  const fcp = fcpVals.length > 0 ? Math.round(fcpVals[0]!) : null;
  const cls = webVitals
    .filter((w) => w.metric === "CLS")
    .reduce((max, w) => Math.max(max, w.value), 0);
  const longTaskCount = longTasks.length;
  const longTaskTotalMs = Math.round(longTasks.reduce((sum, t) => sum + t.durationMs, 0));

  // Process stats.
  const mainCpu = processSamples.map(
    (s) => s.processes.find((p) => p.type === "Browser")?.cpuPercent ?? 0
  );
  const mainCpuSorted = [...mainCpu].sort((a, b) => a - b);
  const mainCpuPercentP95 = percentile(mainCpuSorted, 0.95);
  // Approximate CPU-seconds: avg percent * total run seconds * 0.01.
  const runSeconds = (endedAt - startedAt) / 1000;
  const mainCpuAvg =
    mainCpu.length > 0 ? mainCpu.reduce((a, b) => a + b, 0) / mainCpu.length : 0;
  const mainCpuSecondsApprox = Math.round(mainCpuAvg * runSeconds * 0.01 * 100) / 100;

  const rendererPeakRssKb = processSamples.reduce((peak, s) => {
    const r = s.processes
      .filter((p) => p.type !== "Browser" && p.type !== "GPU" && p.type !== "Utility")
      .reduce((m, p) => Math.max(m, p.workingSetSizeKb), 0);
    return Math.max(peak, r);
  }, 0);
  const gpuPeakRssKb = processSamples.reduce((peak, s) => {
    const g = s.processes
      .filter((p) => p.type === "GPU")
      .reduce((m, p) => Math.max(m, p.workingSetSizeKb), 0);
    return Math.max(peak, g);
  }, 0);

  const rendererHeapPeakMB = rendererMem.reduce((m, s) => Math.max(m, s.usedMB), 0);
  const rendererHeapStartMB = rendererMem.length > 0 ? rendererMem[0]!.usedMB : 0;
  const rendererHeapEndMB =
    rendererMem.length > 0 ? rendererMem[rendererMem.length - 1]!.usedMB : 0;
  const rendererHeapGrowthMB = Math.max(0, rendererHeapEndMB - rendererHeapStartMB);

  // Fitness (lower = better).
  const fitnessScore =
    1.0 * interactionLatencyP95 +
    0.8 * inpP95 +
    0.5 * rendererHeapGrowthMB +
    0.3 * mainCpuSecondsApprox +
    0.2 * ipcP95TopChannels +
    0.2 * longTaskCount;

  const summary: Summary = {
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    scenarios: Object.fromEntries(
      Object.entries(scenarios).map(([name, s]) => [
        name,
        {
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          durationMs: s.endedAt - s.startedAt,
          ok: s.ok,
          smokeFailures: s.smokeFailures,
        },
      ])
    ),
    fitness: {
      score: Math.round(fitnessScore * 100) / 100,
      components: {
        interactionLatencyP95,
        inpP95,
        rendererHeapGrowthMB,
        mainCpuSeconds: mainCpuSecondsApprox,
        ipcP95TopChannels,
        longTaskCount,
      },
    },
    ipc: { perChannel: ipcPerChannel, slowChannels },
    marks,
    webVitals: {
      inpP95,
      inpSamples: inpValues.length,
      fcp,
      cls: Math.round(cls * 1000) / 1000,
      longTaskCount,
      longTaskTotalMs,
    },
    process: {
      mainCpuPercentP95: Math.round(mainCpuPercentP95 * 100) / 100,
      mainCpuSecondsApprox,
      rendererPeakRssKb,
      gpuPeakRssKb,
      rendererHeapGrowthMB,
      rendererHeapPeakMB,
    },
    chatText: summarizeChatTextFlushes(chatTextFlushes),
    mainLoop: summarizeMainLoopDelay(mainLoopDelays),
    streamSmoothness: summarizeStreamSmoothness(streamSmoothnessWindows),
  };

  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
