/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MacDesktopEventPayload, MacDesktopStreamStatus } from "../../../shared/types/macDesktop";
import {
  MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
  resetMacDesktopLiveViewLeasesForTests,
} from "./macDesktopLiveViewLease";
import {
  FIRST_FRAME_TIMEOUT_MS,
  RECOVER_DELAY_MS,
  RECOVER_MAX_TRIES,
  RETRY_MAX_ATTEMPTS,
  shouldRetryLiveView,
  useMacDesktopLiveView,
} from "./useMacDesktopLiveView";

describe("shouldRetryLiveView", () => {
  it("retries only from the error state, and only with a lane", () => {
    expect(shouldRetryLiveView({ status: "error", laneId: "lane-1", failures: 0 })).toBe(true);
    expect(shouldRetryLiveView({ status: "playing", laneId: "lane-1", failures: 0 })).toBe(false);
    expect(shouldRetryLiveView({ status: "starting", laneId: "lane-1", failures: 0 })).toBe(false);
    expect(shouldRetryLiveView({ status: "idle", laneId: "lane-1", failures: 0 })).toBe(false);
    expect(shouldRetryLiveView({ status: "error", laneId: null, failures: 0 })).toBe(false);
  });

  it("stops once the budget is spent, and starts again once it is reset", () => {
    // A stream that fails for a reason a retry cannot fix — an unreadable
    // config record, say — burns the budget and then stays quiet rather than
    // restarting an encoder process every four seconds.
    expect(shouldRetryLiveView({
      status: "error",
      laneId: "lane-1",
      failures: RETRY_MAX_ATTEMPTS - 1,
    })).toBe(true);
    expect(shouldRetryLiveView({
      status: "error",
      laneId: "lane-1",
      failures: RETRY_MAX_ATTEMPTS,
    })).toBe(false);
    // `restart()` and a successful attempt both zero the count; that is what
    // makes the panel's Retry work after the budget ran out.
    expect(shouldRetryLiveView({ status: "error", laneId: "lane-1", failures: 0 })).toBe(true);
  });
});

function streamStatus(laneId = "lane-1"): MacDesktopStreamStatus {
  return {
    laneId,
    running: true,
    fps: 30,
    idle: false,
    bitrateKbps: null,
    transport: { url: "http://127.0.0.1:1/s?token=t", port: 1, token: "t", codec: "avc1", width: 10, height: 10 },
    lastError: null,
    clients: 1,
    viewerChatSessionIds: ["chat-1"],
  };
}

let listeners: Array<(event: MacDesktopEventPayload) => void> = [];
let api: {
  startStream: ReturnType<typeof vi.fn>;
  stopStream: ReturnType<typeof vi.fn>;
  resolveStreamUrl: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
};

function emit(event: MacDesktopEventPayload): void {
  for (const listener of listeners) listener(event);
}

function stopped(laneId: string): MacDesktopEventPayload {
  return { type: "stream-stopped", status: { ...streamStatus(laneId), running: false, transport: null } };
}

async function pass(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useMacDesktopLiveView reconnects by itself", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetMacDesktopLiveViewLeasesForTests();
    listeners = [];
    api = {
      startStream: vi.fn(async () => streamStatus()),
      stopStream: vi.fn(async () => ({ ...streamStatus(), running: false })),
      resolveStreamUrl: vi.fn(async (url: string) => ({ url, forwarded: false, error: null })),
      onEvent: vi.fn((listener: (event: MacDesktopEventPayload) => void) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((entry) => entry !== listener);
        };
      }),
    };
    (window as unknown as { ade: unknown }).ade = { macDesktop: api };
  });

  afterEach(() => {
    cleanup();
    resetMacDesktopLiveViewLeasesForTests();
    vi.useRealTimers();
  });

  function mount(enabled = true) {
    return renderHook(
      ({ on }: { on: boolean }) => useMacDesktopLiveView({
        laneId: "lane-1",
        runtimePin: null,
        enabled: on,
        chatSessionId: "chat-1",
      }),
      { initialProps: { on: enabled } },
    );
  }

  it("regression: the capture stopping under a live viewer makes it ask again", async () => {
    // Another desktop's stop, the encoder dying: before, the pane kept a dead
    // address and sat on "Connecting" until it was reopened.
    const view = mount();
    await waitFor(() => expect(view.result.current.url).toBeTruthy());
    act(() => view.result.current.onStatus("playing", null));
    expect(api.startStream).toHaveBeenCalledTimes(1);

    act(() => emit(stopped("lane-1")));
    await pass(RECOVER_DELAY_MS + 50);
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));

    // Another lane's stop is not ours.
    act(() => view.result.current.onStatus("playing", null));
    act(() => emit(stopped("lane-9")));
    await pass(RECOVER_DELAY_MS * 4);
    expect(api.startStream).toHaveBeenCalledTimes(2);
  });

  it("the body ending under a live viewer re-dials, and a reader with no address changes nothing", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.url).toBeTruthy());
    act(() => view.result.current.onStatus("playing", null));
    act(() => view.result.current.onStatus("stopped", null));
    await pass(RECOVER_DELAY_MS + 50);
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));

    // A start that failed is in the error state the slow retry watches. A
    // reader mounting with no address must not turn that into "starting".
    api.startStream.mockImplementation(async () => ({ ...streamStatus(), transport: null, lastError: "no port" }));
    act(() => view.result.current.restart());
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    act(() => view.result.current.onStatus("stopped", null));
    expect(view.result.current.status).toBe("error");
  });

  it("an address that never draws re-dials, and gives up after a few tries", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.url).toBeTruthy());
    for (let i = 0; i < RECOVER_MAX_TRIES + 3; i += 1) {
      await pass(FIRST_FRAME_TIMEOUT_MS + RECOVER_DELAY_MS * (RECOVER_MAX_TRIES + 1));
    }
    // One start, and the recoveries at most.
    expect(api.startStream).toHaveBeenCalledTimes(1 + RECOVER_MAX_TRIES);

    // A drawn frame gives the budget back.
    act(() => view.result.current.onStatus("playing", null));
    act(() => emit(stopped("lane-1")));
    await pass(RECOVER_DELAY_MS + 50);
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2 + RECOVER_MAX_TRIES));
  });

  it("regression: the card and the pane of one chat never start the lane twice", async () => {
    // Coming back to a chat mounted the floating player and the pane a beat
    // apart. The player's start was still in flight when the pane took the
    // decoder, and the pane asked again: two starts, two encoders on the host.
    let release: (() => void) | null = null;
    api.startStream.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(streamStatus());
    }));
    const card = renderHook(() => useMacDesktopLiveView({
      laneId: "lane-1",
      runtimePin: null,
      enabled: true,
      chatSessionId: "chat-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
    }));
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1));
    const pane = renderHook(() => useMacDesktopLiveView({
      laneId: "lane-1",
      runtimePin: null,
      enabled: true,
      chatSessionId: "chat-1",
    }));
    await pass(50);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(pane.result.current.url).toBeTruthy());
    expect(api.startStream).toHaveBeenCalledTimes(1);
    expect(card.result.current.url).toBeNull();
  });

  it("regression: Reconnect and a picture that never arrives ask for a fresh stream", async () => {
    // Reconnect used to ask for the running stream again and got the same
    // dead run back every time.
    const view = mount();
    await waitFor(() => expect(view.result.current.url).toBeTruthy());
    expect(api.startStream.mock.calls[0]?.[0]).not.toMatchObject({ fresh: true });
    act(() => view.result.current.restart());
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
    expect(api.startStream.mock.calls[1]?.[0]).toMatchObject({ laneId: "lane-1", chatSessionId: "chat-1", fresh: true });

    // An address that draws nothing is as dead: its recovery asks fresh too.
    await waitFor(() => expect(view.result.current.url).toBeTruthy());
    await pass(FIRST_FRAME_TIMEOUT_MS + RECOVER_DELAY_MS + 50);
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(3));
    expect(api.startStream.mock.calls[2]?.[0]).toMatchObject({ fresh: true });

    // A capture that ended is only asked for again, not restarted.
    act(() => view.result.current.onStatus("playing", null));
    act(() => emit(stopped("lane-1")));
    await pass(RECOVER_DELAY_MS + 50);
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(4));
    expect(api.startStream.mock.calls[3]?.[0]).not.toMatchObject({ fresh: true });
  });

  it("a viewer that no longer wants the lane never asks again", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.url).toBeTruthy());
    view.rerender({ on: false });
    act(() => emit(stopped("lane-1")));
    await pass(FIRST_FRAME_TIMEOUT_MS + RECOVER_DELAY_MS * 4);
    expect(api.startStream).toHaveBeenCalledTimes(1);
    // Its lease went, so the service hears "this viewer left", once.
    expect(api.stopStream).toHaveBeenCalledTimes(1);
    expect(api.stopStream).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1", localViewer: true }, null);
  });
});
