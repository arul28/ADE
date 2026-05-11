import { app } from "electron";
import { appendEvent, isRunActive } from "./perfLog";

const SAMPLE_INTERVAL_MS = 1000;

let timer: NodeJS.Timeout | null = null;

export function startMetricsSampler(): void {
  if (!isRunActive() || timer) return;
  timer = setInterval(() => {
    const ts = Date.now();
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
      appendEvent({
        ts,
        kind: "processMetrics",
        processes: metrics,
        mainRss: mem.rss,
        mainHeapUsed: mem.heapUsed,
        mainHeapTotal: mem.heapTotal,
        mainExternal: mem.external,
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
}
