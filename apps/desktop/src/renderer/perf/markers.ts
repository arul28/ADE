let perfActive = false;

export function setPerfActive(active: boolean): void {
  perfActive = active;
}

export function isPerfActive(): boolean {
  return perfActive;
}

export function perfMark(name: string, extra?: Record<string, unknown>): void {
  if (!perfActive) return;
  try {
    performance.mark(name);
  } catch {
    // best effort
  }
  window.ade?.perf?.recordEvent({
    kind: "mark",
    ts: Date.now(),
    name,
    extra: extra ?? null,
  });
}

export function perfMeasure(name: string, startMark: string, endMark?: string): number | null {
  if (!perfActive) return null;
  try {
    const entry = endMark
      ? performance.measure(name, startMark, endMark)
      : performance.measure(name, startMark);
    const durationMs = Math.round(entry.duration * 100) / 100;
    window.ade?.perf?.recordEvent({
      kind: "measure",
      ts: Date.now(),
      name,
      durationMs,
      startMark,
      endMark: endMark ?? null,
    });
    return durationMs;
  } catch {
    return null;
  }
}

let memorySamplingUnavailableLogged = false;

const memoryReader = () => {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
  };
  if (!perf.memory) {
    if (!memorySamplingUnavailableLogged) {
      memorySamplingUnavailableLogged = true;
      console.warn("[perf] performance.memory unavailable; renderer memory samples disabled");
    }
    return null;
  }
  return {
    usedMB: Math.round((perf.memory.usedJSHeapSize ?? 0) / 1024 / 1024),
    totalMB: Math.round((perf.memory.totalJSHeapSize ?? 0) / 1024 / 1024),
  };
};

let memorySamplerId: number | null = null;

export function startRendererMemorySampler(): void {
  if (memorySamplerId !== null || !perfActive) return;
  const sample = () => {
    const mem = memoryReader();
    if (!mem) return;
    window.ade?.perf?.recordEvent({
      kind: "rendererMemory",
      ts: Date.now(),
      usedMB: mem.usedMB,
      totalMB: mem.totalMB,
    });
  };
  sample();
  memorySamplerId = window.setInterval(sample, 1000);
}

export function stopRendererMemorySampler(): void {
  if (memorySamplerId !== null) {
    window.clearInterval(memorySamplerId);
    memorySamplerId = null;
  }
}
