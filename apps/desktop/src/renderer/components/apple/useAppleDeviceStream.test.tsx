/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { appleStreamLeaseCount, resetAppleStreamLeases } from "./appleStreamLease";
import {
  APPLE_FIRST_FRAME_TIMEOUT_MS,
  APPLE_FRAME_STALL_MS,
  useAppleDeviceStream,
  type AppleDeviceStream,
} from "./useAppleDeviceStream";

type Api = {
  startStream: ReturnType<typeof vi.fn>;
  stopStream: ReturnType<typeof vi.fn>;
  getStreamStatus: ReturnType<typeof vi.fn>;
  resolveStreamUrl: ReturnType<typeof vi.fn>;
};

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
  };
  (globalThis as unknown as { window: { ade: unknown } }).window.ade = { iosSimulator: next };
  return next;
}

function Harness({
  onStream,
  hidden = false,
  enabled = true,
  machineName = null,
}: {
  onStream: (stream: AppleDeviceStream) => void;
  hidden?: boolean;
  enabled?: boolean;
  machineName?: string | null;
}) {
  const pinRef = useRef<OpenProjectBinding | null>(null);
  const stream = useAppleDeviceStream({
    deviceUdid: "UDID-1",
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
    await waitFor(() => expect(appleStreamLeaseCount("bound::lane-1::UDID-1")).toBe(2));

    // The card is dismissed. One lease left, and NO stop.
    card.unmount();
    await waitFor(() => expect(appleStreamLeaseCount("bound::lane-1::UDID-1")).toBe(1));
    expect(api.stopStream).not.toHaveBeenCalled();
    expect(column.current?.state).not.toBe("idle");

    // The column leaves too. Last viewer out turns the capture off.
    cleanup();
    await waitFor(() => expect(api.stopStream).toHaveBeenCalledTimes(1));
    expect(appleStreamLeaseCount("bound::lane-1::UDID-1")).toBe(0);
  });

  it("does not stop the stream when only one of two viewers is hidden", async () => {
    const { rerender } = render(<Harness onStream={() => {}} />);
    render(<Harness onStream={() => {}} />);
    await waitFor(() => expect(appleStreamLeaseCount("bound::lane-1::UDID-1")).toBe(2));

    rerender(<Harness onStream={() => {}} hidden />);
    await waitFor(() => expect(appleStreamLeaseCount("bound::lane-1::UDID-1")).toBe(1));
    expect(api.stopStream).not.toHaveBeenCalled();
  });

});
