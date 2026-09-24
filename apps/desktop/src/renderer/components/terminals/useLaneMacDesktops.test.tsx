/* @vitest-environment jsdom */

import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacDesktopDisplay, MacDesktopEventPayload, MacDesktopStatus } from "../../../shared/types/macDesktop";
import { LaneMacDesktopMarker } from "./LaneMacDesktopMarker";
import { LANE_MAC_DESKTOP_LABEL, useLaneMacDesktops } from "./useLaneMacDesktops";

const { webClient } = vi.hoisted(() => ({ webClient: { on: false } }));
vi.mock("../../lib/webClientMode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/webClientMode")>()),
  isWebClientMode: () => webClient.on,
}));

function display(laneId: string): MacDesktopDisplay {
  return {
    laneId,
    displayId: 31,
    name: `ADE · ${laneId}`,
    mode: "virtual",
    width: 2560,
    height: 1440,
    scale: 1,
    origin: { x: 0, y: 0 },
    createdAt: "2026-09-18T19:00:00.000Z",
    windowCount: 0,
    lastActivityAt: "2026-09-18T19:00:00.000Z",
  };
}

function status(overrides: Partial<MacDesktopStatus> = {}): Partial<MacDesktopStatus> {
  return {
    supported: true,
    lanes: [{ laneId: "lane-a", laneName: "Lane A", displayId: 31, windowCount: 1, streaming: false }],
    ...overrides,
  };
}

describe("useLaneMacDesktops", () => {
  let listeners: Array<(event: MacDesktopEventPayload) => void>;
  let getStatus: ReturnType<typeof vi.fn>;

  function emit(event: MacDesktopEventPayload): void {
    act(() => {
      for (const listener of listeners) listener(event);
    });
  }

  beforeEach(() => {
    webClient.on = false;
    listeners = [];
    getStatus = vi.fn(async () => status());
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        macDesktop: {
          getStatus,
          onEvent: (cb: (event: MacDesktopEventPayload) => void) => {
            listeners.push(cb);
            return () => {
              listeners = listeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ade");
  });

  it("marks the lanes holding a display from one read, then follows display events", async () => {
    const { result } = renderHook(() => useLaneMacDesktops());
    await waitFor(() => expect(result.current.has("lane-a")).toBe(true));
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith({});

    emit({ type: "display-created", display: display("lane-b") });
    expect(result.current.has("lane-b")).toBe(true);

    emit({ type: "display-destroyed", laneId: "lane-a", reason: "idle" });
    expect(result.current.has("lane-a")).toBe(false);
    expect(result.current.has("lane-b")).toBe(true);
    // Events move the set without a second read.
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps a display created while the first read was in flight", async () => {
    let resolve: (value: Partial<MacDesktopStatus>) => void = () => {};
    getStatus.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useLaneMacDesktops());
    emit({ type: "display-created", display: display("lane-b") });
    await act(async () => {
      resolve(status());
    });
    expect([...result.current].sort()).toEqual(["lane-a", "lane-b"]);
  });

  it("marks nothing, and stops listening, on a host that cannot host a display", async () => {
    getStatus.mockResolvedValue(status({ supported: false, lanes: [] }));
    const { result } = renderHook(() => useLaneMacDesktops());
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    await waitFor(() => expect(listeners).toHaveLength(0));
    expect(result.current.size).toBe(0);
  });

  it("asks nothing in the web client", async () => {
    webClient.on = true;
    const { result } = renderHook(() => useLaneMacDesktops());
    await act(async () => {
      await Promise.resolve();
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});

describe("LaneMacDesktopMarker", () => {
  afterEach(() => cleanup());

  it("names what it marks", () => {
    render(<LaneMacDesktopMarker laneId="lane-a" />);
    const mark = screen.getByRole("img", { name: LANE_MAC_DESKTOP_LABEL });
    expect(mark.getAttribute("data-lane-mac-desktop")).toBe("lane-a");
  });
});
