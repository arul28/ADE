import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorCloudMirrorWatch } from "./cursorCloudMirrorWatch";

describe("createCursorCloudMirrorWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates immediately on first watch and stops after the last unwatch", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue("unchanged");
    const controller = createCursorCloudMirrorWatch({ refresh });

    controller.watch({ sessionId: "sess-1", watching: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    controller.watch({ sessionId: "sess-1", watching: false });
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("schedules the floor delay after the immediate hydrate when the chat is quiet", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue("unchanged");
    const controller = createCursorCloudMirrorWatch({ refresh });

    controller.watch({ sessionId: "sess-1", watching: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockClear();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refcounts overlapping watchers and only polls while someone is looking", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue("unchanged");
    const controller = createCursorCloudMirrorWatch({ refresh });

    controller.watch({ sessionId: "sess-1", watching: true });
    controller.watch({ sessionId: "sess-1", watching: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    controller.watch({ sessionId: "sess-1", watching: false });
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    controller.watch({ sessionId: "sess-1", watching: false });
    refresh.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps polling after a refresh throw", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("unchanged");
    const controller = createCursorCloudMirrorWatch({ refresh });

    controller.watch({ sessionId: "sess-1", watching: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
