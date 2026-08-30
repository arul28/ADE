import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { app } from "electron";
import { appendEvent, isRunActive } from "./perfLog";

const SAMPLE_INTERVAL_MS = 1000;
const LOOP_DELAY_RESOLUTION_MS = 10;

let timer: NodeJS.Timeout | null = null;
let loopDelay: IntervalHistogram | null = null;

function toMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds)) return 0;
  return Math.round((nanoseconds / 1e6) * 100) / 100;
}

export function startMetricsSampler(): void {
  if (!isRunActive() || timer) return;
  loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  loopDelay.enable();
  timer = setInterval(() => {
    const ts = Date.now();
    if (loopDelay) {
      try {
        appendEvent({
          ts,
          kind: "mainLoopDelay",
          p50: toMs(loopDelay.percentile(50)),
          p95: toMs(loopDelay.percentile(95)),
          max: toMs(loopDelay.max),
        });
      } catch {
        // Ignore — loop delay sampling is best effort.
      }
      loopDelay.reset();
    }
    try {
      const metrics = app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        cpuPercent: m.cpu?.percentCPUUsage ?? 0,
        cpuIdleWakeups: m.cpu?.idleWakeupsPerSecond ?? 0,
        workingSetSizeKb: m.memory?.workingSetSize ?? 0,
        peakWorkingSetSizeKb: m.memory?.peakWorkingSetSize ?? 0,
      }));
      const mem = process.memoryUsage();
      const heap = getHeapStatistics();
      appendEvent({
        ts,
        kind: "processMetrics",
        processes: metrics,
        mainRss: mem.rss,
        mainHeapUsed: mem.heapUsed,
        mainHeapTotal: mem.heapTotal,
        mainExternal: mem.external,
        mainV8UsedHeapSize: heap.used_heap_size,
        mainV8TotalHeapSize: heap.total_heap_size,
      });
    } catch {
      // Ignore — metrics are best effort.
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

export function stopMetricsSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (loopDelay) {
    loopDelay.disable();
    loopDelay = null;
  }
}
