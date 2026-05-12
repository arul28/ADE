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
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
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
      max: Math.round(Math.max(...sorted)),
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
      max: Math.round(Math.max(...sorted)),
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
  };

  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
