/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { appleStreamLeaseCount, appleStreamLeaseKey, resetAppleStreamLeases } from "./appleStreamLease";

const heldOn = (deviceUdid: string) =>
  appleStreamLeaseCount(appleStreamLeaseKey({ pin: null, bound: null, laneId: "lane-1", deviceUdid }));
import {
  APPLE_FIRST_FRAME_TIMEOUT_MS,
  APPLE_FRAME_STALL_MS,
  APPLE_STREAM_RECOVER_DELAY_MS,
  APPLE_STREAM_STOP_GRACE_MS,
  useAppleDeviceStream,
  type AppleDeviceStream,
} from "./useAppleDeviceStream";

type Api = {
  startStream: ReturnType<typeof vi.fn>;
  stopStream: ReturnType<typeof vi.fn>;
  getStreamStatus: ReturnType<typeof vi.fn>;
  resolveStreamUrl: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
};

let eventListeners: Array<(event: unknown) => void> = [];

let api: Api;

function installApi(): Api {
  const next: Api = {
    startStream: vi.fn().mockResolvedValue({
      deviceUdid: "UDID-1",
      running: true,
      backend: "helper-h264",
      fps: null,
      targetFps: 30,
      frameCount: null,
      startedAt: new Date().toISOString(),
      lastFrameAt: null,
      lastError: null,
      streamUrl: "http://127.0.0.1:51234/ios-simulator-video",
      transport: {
        url: "http://127.0.0.1:51234/ios-simulator-video",
        port: 51234,
        token: "s3cret",
        codec: "avc1.640032",
        width: 1179,
        height: 2556,
      },
    }),
    stopStream: vi.fn().mockResolvedValue({}),
    getStreamStatus: vi.fn().mockResolvedValue({ running: true, fps: 60, bitrateKbps: 1400 }),
    resolveStreamUrl: vi.fn().mockImplementation(async (url: string | null) => ({
      url,
      forwarded: false,
      error: null,
    })),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return () => {
        eventListeners = eventListeners.filter((entry) => entry !== listener);
      };
    }),
  };
  (globalThis as unknown as { window: { ade: unknown } }).window.ade = { iosSimulator: next };
  return next;
}

function Harness({
  onStream,
  hidden = false,
  enabled = true,
  machineName = null,
  deviceUdid = "UDID-1",
}: {
  onStream: (stream: AppleDeviceStream) => void;
  deviceUdid?: string;
  hidden?: boolean;
  enabled?: boolean;
  machineName?: string | null;
}) {
  const pinRef = useRef<OpenProjectBinding | null>(null);
  const stream = useAppleDeviceStream({
    deviceUdid,
    laneId: "lane-1",
    chatSessionId: "chat-1",
    enabled,
    hidden,
    machineName,
    bitrateKbpsCap: 2500,
    runtimePinRef: pinRef,
    onError: () => {},
  });
  onStream(stream);
  return null;
}

beforeEach(() => {
  eventListeners = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetAppleStreamLeases();
  api = installApi();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAppleDeviceStream", () => {
  it("keeps the token beside the url instead of in it", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.url).toBeTruthy());
    // The helper strips the query string before it matches the path and
    // authorises on the header alone, so a token carried in the URL is never
    // read and the request comes back 403.
    expect(box.current?.url).not.toContain("s3cret");
    expect(box.current?.token).toBe("s3cret");
  });

  it("caps the bitrate only for a remote viewer", async () => {
    render(<Harness onStream={() => {}} />);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    expect(api.startStream.mock.calls[0]?.[0]).toMatchObject({ bitrateKbps: null });

    api.startStream.mockClear();
    render(<Harness onStream={() => {}} machineName="studio-mac" />);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    expect(api.startStream.mock.calls[0]?.[0]).toMatchObject({ bitrateKbps: 2500 });
  });

  it("stalls when the first frame never arrives", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.state).toBe("starting"));
    await act(async () => {
      vi.advanceTimersByTime(APPLE_FIRST_FRAME_TIMEOUT_MS + 1_000);
    });
    // The old H.264 path had no first-frame timeout at all: a helper that
    // accepted the connection and produced nothing said "Starting" forever.
    await waitFor(() => expect(box.current?.state).toBe("stalled"));
  });

  it("stalls when frames stop, and not before", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.url).toBeTruthy());
    act(() => box.current?.noteFrame());
    await waitFor(() => expect(box.current?.state).toBe("live"));

    await act(async () => {
      vi.advanceTimersByTime(APPLE_FRAME_STALL_MS - 1_000);
    });
    expect(box.current?.state).toBe("live");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await waitFor(() => expect(box.current?.state).toBe("stalled"));
  });

  it("pauses rather than stalls when the viewer is not visible", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    const { rerender } = render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    rerender(<Harness onStream={(next) => { box.current = next; }} hidden />);
    await waitFor(() => expect(box.current?.state).toBe("paused"));
    await act(async () => { vi.advanceTimersByTime(APPLE_STREAM_STOP_GRACE_MS + 50); });
    expect(api.stopStream).toHaveBeenCalled();
    expect(box.current?.url).toBeNull();
  });

  it("redials on reconnect", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1));
    act(() => box.current?.reconnect());
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
  });

  it("reports a refused start as an error state", async () => {
    api.resolveStreamUrl.mockResolvedValue({ url: null, forwarded: false, error: "No route to the Mac." });
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.state).toBe("error"));
    expect(box.current?.error).toBe("No route to the Mac.");
  });

  /*
    Two viewers, one lane. `stopStream` is lane-scoped, so before the lease the
    corner card going hidden — or a web viewer disconnecting — stopped the
    column's capture with it and left a black stage beside a live device.
  */
  it("keeps the remaining viewer's frames when a second viewer goes away", async () => {
    const column: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { column.current = next; }} />);
    const card = render(<Harness onStream={() => {}} hidden={false} />);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    await waitFor(() => expect(heldOn("UDID-1")).toBe(2));

    // The card is dismissed. One lease left, and NO stop.
    card.unmount();
    await waitFor(() => expect(heldOn("UDID-1")).toBe(1));
    expect(api.stopStream).not.toHaveBeenCalled();
    expect(column.current?.state).not.toBe("idle");

    // The column leaves too. Last viewer out turns the capture off, once the
    // grace for a handover has passed.
    cleanup();
    await act(async () => { vi.advanceTimersByTime(APPLE_STREAM_STOP_GRACE_MS + 50); });
    await waitFor(() => expect(api.stopStream).toHaveBeenCalledTimes(1));
    expect(heldOn("UDID-1")).toBe(0);
  });

  it("does not stop the stream when only one of two viewers is hidden", async () => {
    const { rerender } = render(<Harness onStream={() => {}} />);
    render(<Harness onStream={() => {}} />);
    await waitFor(() => expect(heldOn("UDID-1")).toBe(2));

    rerender(<Harness onStream={() => {}} hidden />);
    await waitFor(() => expect(heldOn("UDID-1")).toBe(1));
    expect(api.stopStream).not.toHaveBeenCalled();
  });


  /*
   * The owner's 2026-09-23 report: the pane sat on "Connecting video" until a
   * tab switch remounted it. Whatever ended the capture, the viewer never
   * asked for it again.
   */
  it("a start that has not answered is not turned into an idle stream by the reader mounting", async () => {
    // The start never answers (a slow boot wait, a lost reply).
    api.startStream.mockImplementationOnce(() => new Promise(() => {}));
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.state).toBe("starting"));
    await act(async () => {
      vi.advanceTimersByTime(APPLE_FIRST_FRAME_TIMEOUT_MS + 1_000);
    });
    await waitFor(() => expect(box.current?.state).toBe("stalled"));
    // The pane mounts its stage for "video lost"; with no address the reader
    // reports "stopped". That used to park the viewer in `idle`, which no
    // watchdog watches and which the pane draws as "Connecting video".
    act(() => box.current?.handleReaderStatus("stopped", null));
    expect(box.current?.state).toBe("stalled");
    // And it asks the service again by itself.
    await act(async () => {
      vi.advanceTimersByTime(APPLE_STREAM_RECOVER_DELAY_MS + 100);
    });
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(box.current?.url).toBeTruthy());
  });

  it("when the capture ends under a viewer that still wants it, the viewer asks again", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.url).toBeTruthy());
    act(() => box.current?.noteFrame());
    expect(api.startStream).toHaveBeenCalledTimes(1);

    // Another viewer's stop, a helper restart: the service says it stopped.
    act(() => {
      for (const listener of eventListeners) {
        listener({ type: "stream-stopped", status: { deviceUdid: "UDID-1", running: false } });
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(APPLE_STREAM_RECOVER_DELAY_MS + 100);
    });
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));

    // Another device's stop is not ours.
    act(() => {
      for (const listener of eventListeners) {
        listener({ type: "stream-stopped", status: { deviceUdid: "UDID-9", running: false } });
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(APPLE_STREAM_RECOVER_DELAY_MS * 4);
    });
    expect(api.startStream).toHaveBeenCalledTimes(2);
  });

  it("the body ending under a live viewer redials instead of freezing", async () => {
    const box: { current: AppleDeviceStream | null } = { current: null };
    render(<Harness onStream={(next) => { box.current = next; }} />);
    await waitFor(() => expect(box.current?.url).toBeTruthy());
    act(() => box.current?.noteFrame());
    act(() => box.current?.handleReaderStatus("stopped", null));
    await act(async () => {
      vi.advanceTimersByTime(APPLE_STREAM_RECOVER_DELAY_MS + 100);
    });
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
  });

  it("gives up asking after a few tries, and a hidden viewer never asks", async () => {
    api.startStream.mockImplementation(() => new Promise(() => {}));
    const box: { current: AppleDeviceStream | null } = { current: null };
    const { rerender } = render(<Harness onStream={(next) => { box.current = next; }} />);
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(APPLE_FIRST_FRAME_TIMEOUT_MS + APPLE_STREAM_RECOVER_DELAY_MS * 4);
      });
    }
    // One start, and three recoveries at most.
    expect(api.startStream.mock.calls.length).toBeLessThanOrEqual(4);
    expect(box.current?.gaveUp).toBe(true);
    const calls = api.startStream.mock.calls.length;
    rerender(<Harness onStream={(next) => { box.current = next; }} hidden />);
    act(() => {
      for (const listener of eventListeners) {
        listener({ type: "stream-stopped", status: { deviceUdid: "UDID-1", running: false } });
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(APPLE_STREAM_RECOVER_DELAY_MS * 4);
    });
    expect(api.startStream.mock.calls.length).toBe(calls);
  });

  it("a viewer arriving just after the last one left joins the capture instead of a new one", async () => {
    // `apple show` hides the floating player a beat before the pane mounts.
    const player = render(<Harness onStream={() => {}} />);
    await waitFor(() => expect(heldOn("UDID-1")).toBe(1));
    player.unmount();
    await act(async () => { vi.advanceTimersByTime(APPLE_STREAM_STOP_GRACE_MS / 2); });
    render(<Harness onStream={() => {}} />);
    await waitFor(() => expect(heldOn("UDID-1")).toBe(1));
    await act(async () => { vi.advanceTimersByTime(APPLE_STREAM_STOP_GRACE_MS * 2); });
    expect(api.stopStream).not.toHaveBeenCalled();
  });

  /*
   * Regression (A2-1): `stopStream` is lane-scoped, so the grace stop armed for
   * device A used to fire after the swap and kill device B's new capture.
   */
  it("a device swap inside one viewer does not stop the new stream", async () => {
    const { rerender } = render(<Harness onStream={() => {}} />);
    await waitFor(() => expect(heldOn("UDID-1")).toBe(1));
    rerender(<Harness onStream={() => {}} deviceUdid="UDID-2" />);
    await waitFor(() => expect(heldOn("UDID-2")).toBe(1));
    expect(heldOn("UDID-1")).toBe(0);
    await act(async () => { vi.advanceTimersByTime(APPLE_STREAM_STOP_GRACE_MS * 2); });
    expect(api.stopStream).not.toHaveBeenCalled();
  });
});
