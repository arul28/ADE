import { describe, expect, it, vi } from "vitest";
import {
  createBuiltInBrowserPreviewStreams,
  type BuiltInBrowserPreviewCapture,
  type BuiltInBrowserPreviewFrame,
} from "./builtInBrowserPreviewStream";

type Harness = ReturnType<typeof harness>;

function harness(options: {
  capture?: (tabId: string, maxWidth: number) => Promise<BuiltInBrowserPreviewCapture | null>;
} = {}) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const frames: BuiltInBrowserPreviewFrame[] = [];
  const errors: unknown[] = [];
  let visible = true;
  const aliveTabs = new Set(["tab-1", "tab-2"]);
  const captureCalls: { tabId: string; maxWidth: number }[] = [];

  const streams = createBuiltInBrowserPreviewStreams({
    capture: (tabId, maxWidth) => {
      captureCalls.push({ tabId, maxWidth });
      return options.capture
        ? options.capture(tabId, maxWidth)
        : Promise.resolve({ dataUrl: `data:image/jpeg;base64,${tabId}`, width: maxWidth, height: 100 });
    },
    emit: (frame) => frames.push(frame),
    isTabAlive: (tabId) => aliveTabs.has(tabId),
    isVisible: () => visible,
    onError: (_tabId, error) => errors.push(error),
    now: () => 1_700_000_000_000,
    setLoopTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setInterval>;
    },
    clearLoopTimer: (handle) => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
  });

  return {
    streams,
    frames,
    errors,
    timers,
    captureCalls,
    aliveTabs,
    setVisible: (next: boolean) => {
      visible = next;
    },
    /** Fires every timer that is still armed, newest definition wins per tab. */
    fire: () => {
      for (const timer of timers) {
        if (!timer.cleared) timer.fn();
      }
    },
  };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const liveTimers = (h: Harness) => h.timers.filter((timer) => !timer.cleared);

describe("createBuiltInBrowserPreviewStreams", () => {
  it("never runs a loop for a tab nobody subscribed to", () => {
    const h = harness();
    h.fire();
    expect(h.captureCalls).toHaveLength(0);
    expect(h.streams.snapshot()).toEqual([]);
  });

  it("shares one loop between two subscribers and stops it on the last release", async () => {
    const h = harness();
    expect(h.streams.start("tab-1").subscribers).toBe(1);
    expect(h.streams.start("tab-1").subscribers).toBe(2);
    expect(liveTimers(h)).toHaveLength(1);

    h.fire();
    await flush();
    // One loop, so two watchers see one capture per tick — not two.
    expect(h.captureCalls).toHaveLength(1);
    expect(h.frames).toHaveLength(1);

    expect(h.streams.stop("tab-1").subscribers).toBe(1);
    expect(liveTimers(h)).toHaveLength(1);
    expect(h.streams.stop("tab-1").subscribers).toBe(0);
    expect(liveTimers(h)).toHaveLength(0);
    expect(h.streams.snapshot()).toEqual([]);
  });

  it("skips a tick instead of queueing when the previous capture has not resolved", async () => {
    const pending: { resolve: ((frame: BuiltInBrowserPreviewCapture) => void) | null } = { resolve: null };
    const h = harness({
      capture: () => new Promise<BuiltInBrowserPreviewCapture | null>((resolve) => {
        pending.resolve = resolve;
      }),
    });
    h.streams.start("tab-1");

    h.fire();
    h.fire();
    h.fire();
    await flush();

    expect(h.captureCalls).toHaveLength(1);
    expect(h.streams.snapshot()[0]?.skipped).toBe(2);

    pending.resolve?.({ dataUrl: "data:image/jpeg;base64,x", width: 480, height: 300 });
    await flush();
    expect(h.frames).toHaveLength(1);

    // Once the in-flight capture lands, the next tick captures again.
    h.fire();
    await flush();
    expect(h.captureCalls).toHaveLength(2);
  });

  it("pauses while the window is hidden and resumes without a re-subscribe", async () => {
    const h = harness();
    h.streams.start("tab-1");

    h.setVisible(false);
    h.fire();
    h.fire();
    await flush();
    expect(h.captureCalls).toHaveLength(0);
    // Still subscribed — the loop is paused, not torn down.
    expect(h.streams.snapshot()[0]?.subscribers).toBe(1);

    h.setVisible(true);
    h.fire();
    await flush();
    expect(h.captureCalls).toHaveLength(1);
  });

  it("stops the loop for good once the tab is destroyed", async () => {
    const h = harness();
    h.streams.start("tab-1");
    h.aliveTabs.delete("tab-1");

    h.fire();
    await flush();

    expect(h.captureCalls).toHaveLength(0);
    expect(h.streams.snapshot()).toEqual([]);
    expect(liveTimers(h)).toHaveLength(0);
  });

  it("clamps fps and honours the fastest subscriber", () => {
    const h = harness();
    const slow = h.streams.start("tab-1", { fps: 2, maxWidth: 200 });
    expect(slow.fps).toBe(2);
    expect(liveTimers(h)[0]?.ms).toBe(500);

    // A second, faster watcher re-arms the shared loop rather than opening a
    // second one — and the wider request wins too.
    const fast = h.streams.start("tab-1", { fps: 999, maxWidth: 480 });
    expect(fast.fps).toBe(24);
    expect(fast.maxWidth).toBe(480);
    expect(liveTimers(h)).toHaveLength(1);
    expect(liveTimers(h)[0]?.ms).toBe(42);
  });

  it("defaults to 12fps at 480px", () => {
    const h = harness();
    const started = h.streams.start("tab-1");
    expect(started.fps).toBe(12);
    expect(started.maxWidth).toBe(480);
    expect(liveTimers(h)[0]?.ms).toBe(83);
  });

  it("drops a frame whose subscribers all left while the capture was in flight", async () => {
    const pending: { resolve: ((frame: BuiltInBrowserPreviewCapture) => void) | null } = { resolve: null };
    const h = harness({
      capture: () => new Promise<BuiltInBrowserPreviewCapture | null>((resolve) => {
        pending.resolve = resolve;
      }),
    });
    h.streams.start("tab-1");
    h.fire();
    h.streams.stop("tab-1");
    pending.resolve?.({ dataUrl: "data:image/jpeg;base64,x", width: 480, height: 300 });
    await flush();
    expect(h.frames).toHaveLength(0);
  });

  it("keeps running after a failed capture and reports it once", async () => {
    const failure = new Error("capturePage timed out");
    let shouldFail = true;
    const h = harness({
      capture: () => (shouldFail
        ? Promise.reject(failure)
        : Promise.resolve({ dataUrl: "data:image/jpeg;base64,ok", width: 480, height: 300 })),
    });
    h.streams.start("tab-1");

    h.fire();
    await flush();
    expect(h.errors).toEqual([failure]);
    expect(h.frames).toHaveLength(0);

    shouldFail = false;
    h.fire();
    await flush();
    expect(h.frames).toHaveLength(1);
  });

  it("runs independent loops for different tabs", async () => {
    const h = harness();
    h.streams.start("tab-1");
    h.streams.start("tab-2");
    expect(liveTimers(h)).toHaveLength(2);

    h.fire();
    await flush();
    expect(h.captureCalls.map((call) => call.tabId).sort()).toEqual(["tab-1", "tab-2"]);

    h.streams.stopTab("tab-1");
    expect(h.streams.snapshot().map((entry) => entry.tabId)).toEqual(["tab-2"]);
  });

  it("stop() on an unknown tab is a no-op that reports zero subscribers", () => {
    const h = harness();
    expect(h.streams.stop("tab-9").subscribers).toBe(0);
  });

  it("dispose() clears every loop and refuses new subscriptions", () => {
    const h = harness();
    h.streams.start("tab-1");
    h.streams.start("tab-2");
    h.streams.dispose();
    expect(liveTimers(h)).toHaveLength(0);
    expect(h.streams.snapshot()).toEqual([]);
    expect(() => h.streams.start("tab-1")).toThrow(/disposed/i);
  });

  it("emits a capturedAt timestamp with each frame", async () => {
    const emit = vi.fn();
    const streams = createBuiltInBrowserPreviewStreams({
      capture: async () => ({ dataUrl: "data:image/jpeg;base64,x", width: 480, height: 300 }),
      emit,
      isTabAlive: () => true,
      isVisible: () => true,
      now: () => 1_700_000_000_000,
      setLoopTimer: (fn) => {
        queueMicrotask(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearLoopTimer: () => {},
    });
    streams.start("tab-1");
    await flush();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      tabId: "tab-1",
      capturedAt: new Date(1_700_000_000_000).toISOString(),
    }));
    streams.dispose();
  });
});
