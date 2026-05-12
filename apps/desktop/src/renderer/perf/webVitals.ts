import { isPerfActive } from "./markers";

const LONG_TASK_THRESHOLD_MS = 50;

let installed = false;
let cumulativeLayoutShift = 0;

function send(kind: string, payload: Record<string, unknown>): void {
  if (!isPerfActive()) return;
  window.ade?.perf?.recordEvent({
    kind,
    ts: Date.now(),
    ...payload,
  });
}

function observe(type: string, callback: (entries: PerformanceEntryList) => void): void {
  try {
    const po = new PerformanceObserver((list) => callback(list.getEntries()));
    po.observe({ type, buffered: true } as PerformanceObserverInit);
  } catch {
    // observer type not supported in this runtime — ignore.
  }
}

export function installWebVitalsObservers(): void {
  if (installed) return;
  installed = true;

  observe("longtask", (entries) => {
    for (const entry of entries) {
      if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
      send("longTask", {
        durationMs: Math.round(entry.duration),
        startTime: Math.round(entry.startTime),
      });
    }
  });

  observe("paint", (entries) => {
    for (const entry of entries) {
      if (entry.name === "first-contentful-paint") {
        send("webVital", {
          metric: "FCP",
          value: Math.round(entry.startTime),
        });
      }
    }
  });

  observe("largest-contentful-paint", (entries) => {
    for (const entry of entries) {
      send("webVital", {
        metric: "LCP",
        value: Math.round(entry.startTime),
      });
    }
  });

  observe("layout-shift", (entries) => {
    for (const entry of entries as unknown as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (entry.hadRecentInput) continue;
      cumulativeLayoutShift += entry.value;
    }
    if (cumulativeLayoutShift > 0) {
      send("webVital", { metric: "CLS", value: cumulativeLayoutShift });
    }
  });

  observe("event", (entries) => {
    for (const entry of entries as unknown as Array<PerformanceEntry & { interactionId?: number; duration: number }>) {
      if (!entry.interactionId) continue;
      if (entry.duration < 16) continue;
      send("webVital", {
        metric: "INP",
        value: Math.round(entry.duration),
        eventName: entry.name,
      });
    }
  });
}
