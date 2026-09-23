/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleDeviceListResult, IosSimulatorEventPayload } from "../../../shared/types/iosSimulator";
import { useAppleLaneDeviceCard } from "./useAppleLaneDeviceCard";

const lane = {
  laneId: "lane-a",
  udid: "udid-1",
  name: "iPhone 17 Pro",
  origin: "attached",
  family: "iphone",
  runtime: "iOS 26.2",
  createdAt: new Date(0).toISOString(),
  templateUdid: null,
} as unknown as NonNullable<AppleDeviceListResult["lane"]>;

function listed(state: string, withLane = true): AppleDeviceListResult {
  return {
    installed: [{ udid: "udid-1", name: "iPhone 17 Pro", runtime: "iOS 26.2", state } as AppleDeviceListResult["installed"][number]],
    lane: withLane ? lane : null,
    owners: [],
    laneId: "lane-a",
  };
}

describe("useAppleLaneDeviceCard", () => {
  let listeners: Array<(event: IosSimulatorEventPayload) => void>;
  let power: string;
  let hasLane: boolean;
  let deviceList: ReturnType<typeof vi.fn>;

  const emit = (event: IosSimulatorEventPayload) => {
    act(() => {
      for (const listener of listeners) listener(event);
    });
  };

  beforeEach(() => {
    listeners = [];
    power = "Booted";
    hasLane = true;
    deviceList = vi.fn(async () => listed(power, hasLane));
    (window as unknown as { ade: unknown }).ade = {
      iosSimulator: {
        deviceList,
        onEvent: (listener: (event: IosSimulatorEventPayload) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((entry) => entry !== listener);
          };
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("regression: reads Off as soon as the device is shut down, without waiting for the poll", async () => {
    // The owner's 2026-09-23 report: back on the tools grid after a shut down,
    // the Apple Development card still said Running. The grid's read landed
    // before `simctl shutdown` did, and nothing but the 6s poll re-read it.
    const { result } = renderHook(() => useAppleLaneDeviceCard({ laneId: "lane-a", runtimePin: null, enabled: true }));
    await waitFor(() => expect(result.current).toEqual({ name: "iPhone 17 Pro", state: "running" }));

    power = "Shutdown";
    const readsBefore = deviceList.mock.calls.length;
    emit({ type: "apple.device.state", laneId: "lane-a", udid: "udid-1", phase: "stopped" });

    expect(result.current?.state).toBe("off");
    // And it re-reads now rather than on the next tick of the poll.
    await waitFor(() => expect(deviceList.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(result.current?.state).toBe("off");
  });

  it("goes Starting → Running on a start, and back to no device when the lane gives it up", async () => {
    power = "Shutdown";
    const { result } = renderHook(() => useAppleLaneDeviceCard({ laneId: "lane-a", runtimePin: null, enabled: true }));
    await waitFor(() => expect(result.current?.state).toBe("off"));

    emit({ type: "apple.device.state", laneId: "lane-a", udid: "udid-1", phase: "starting" });
    expect(result.current?.state).toBe("starting");

    power = "Booted";
    emit({ type: "apple.device.state", laneId: "lane-a", udid: "udid-1", phase: "streaming" });
    await waitFor(() => expect(result.current?.state).toBe("running"));

    // "Choose another device" and a takeover both announce `released`.
    hasLane = false;
    emit({ type: "apple.device.state", laneId: "lane-a", udid: "udid-1", phase: "released" });
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("ignores another lane's events", async () => {
    const { result } = renderHook(() => useAppleLaneDeviceCard({ laneId: "lane-a", runtimePin: null, enabled: true }));
    await waitFor(() => expect(result.current?.state).toBe("running"));
    const readsBefore = deviceList.mock.calls.length;
    emit({ type: "apple.device.state", laneId: "lane-b", udid: "udid-9", phase: "stopped" });
    expect(result.current?.state).toBe("running");
    expect(deviceList.mock.calls.length).toBe(readsBefore);
  });
});
