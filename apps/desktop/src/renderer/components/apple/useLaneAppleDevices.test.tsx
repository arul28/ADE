/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleDeviceListResult, IosSimulatorEventPayload } from "../../../shared/types/iosSimulator";
import {
  buildLaneAppleDevices,
  laneAppleDeviceLabel,
  useLaneAppleDevices,
} from "./useLaneAppleDevices";

const { platformForTest } = vi.hoisted(() => ({ platformForTest: { mac: true } }));
vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  supportsIosSimulatorPlatform: () => platformForTest.mac,
}));

function listResult(overrides: Partial<AppleDeviceListResult> = {}): AppleDeviceListResult {
  return { installed: [], lane: null, owners: [], laneId: null, ...overrides };
}

const owner = { udid: "udid-1", laneId: "lane-a", laneName: "Lane A", origin: "clone" as const, mine: false };
const installed = {
  udid: "udid-1",
  name: "iPhone 16 Pro",
  runtime: "iOS 18.0",
  state: "Booted",
} as unknown as AppleDeviceListResult["installed"][number];

describe("laneAppleDeviceLabel", () => {
  it("names the device and says when it is off", () => {
    expect(laneAppleDeviceLabel({ udid: "u", name: "iPhone 16 Pro", running: true })).toBe("iPhone 16 Pro on this lane");
    expect(laneAppleDeviceLabel({ udid: "u", name: "iPhone 16 Pro", running: false })).toBe("iPhone 16 Pro on this lane (off)");
    expect(laneAppleDeviceLabel({ udid: "u", name: null, running: null })).toBe("An Apple device on this lane");
  });
});

describe("buildLaneAppleDevices", () => {
  it("keeps the name and state of a device the lane still holds when the installed list was not read", () => {
    const previous = new Map([["lane-a", { udid: "udid-1", name: "iPhone 16 Pro", running: true }]]);
    const next = buildLaneAppleDevices(listResult({ owners: [owner] }), previous, false);
    expect(next.get("lane-a")).toEqual({ udid: "udid-1", name: "iPhone 16 Pro", running: true });

    const moved = buildLaneAppleDevices(listResult({ owners: [{ ...owner, udid: "udid-2" }] }), previous, false);
    expect(moved.get("lane-a")).toEqual({ udid: "udid-2", name: null, running: null });
  });
});

describe("useLaneAppleDevices", () => {
  let listeners: Array<(event: IosSimulatorEventPayload) => void>;
  let deviceList: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    platformForTest.mac = true;
    listeners = [];
    deviceList = vi.fn(async (args: { installed?: boolean }) => (
      args.installed
        ? listResult({ owners: [owner], installed: [installed] })
        : listResult({ owners: [owner] })
    ));
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        iosSimulator: {
          deviceList,
          onEvent: (cb: (event: IosSimulatorEventPayload) => void) => {
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

  it("reads the device name once for a new claim, then only the claims on each lane refresh", async () => {
    const { result, rerender } = renderHook(({ key }) => useLaneAppleDevices({ refreshKey: key }), {
      initialProps: { key: 1 },
    });

    await waitFor(() => {
      expect(result.current.get("lane-a")).toEqual({ udid: "udid-1", name: "iPhone 16 Pro", running: true });
    });
    expect(deviceList.mock.calls.map(([args]) => args.installed)).toEqual([false, true]);

    rerender({ key: 2 });
    await waitFor(() => expect(deviceList).toHaveBeenCalledTimes(3));
    expect(deviceList.mock.calls[2]![0].installed).toBe(false);
    expect(result.current.get("lane-a")?.name).toBe("iPhone 16 Pro");
  });

  it("dims the mark on a stop event and drops it when the claim is released", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => useLaneAppleDevices({ refreshKey: 1 }));
      await waitFor(() => expect(result.current.get("lane-a")?.running).toBe(true));

      act(() => {
        for (const listener of listeners) {
          listener({ type: "apple.device.state", laneId: "lane-a", udid: "udid-1", phase: "stopped" });
        }
      });
      expect(result.current.get("lane-a")?.running).toBe(false);

      deviceList.mockImplementation(async () => listResult({ owners: [] }));
      act(() => {
        for (const listener of listeners) {
          listener({ type: "apple.device.state", laneId: "lane-a", udid: "udid-1", phase: "released" });
        }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => expect(result.current.size).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing on a local non-Mac project", async () => {
    platformForTest.mac = false;
    const { result } = renderHook(() => useLaneAppleDevices({ refreshKey: 1 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(deviceList).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});
