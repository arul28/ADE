import { describe, expect, it, vi } from "vitest";
import type { AppleLaneDevice } from "../../../shared/types";
import { createLaneDeviceLifecycle, type LifecycleLaneRuntime } from "./laneDeviceLifecycle";
import type { LaneDeviceRegistry } from "./laneDeviceRegistry";

const device: AppleLaneDevice = {
  laneId: "lane-b",
  udid: "device-clone",
  name: "ADE · lane-b",
  origin: "clone",
  family: "iphone",
  runtime: "iOS 26.3",
  createdAt: "2026-09-23T00:00:00.000Z",
  templateUdid: "device-2",
};

function setup(owner: string | null) {
  let bound: AppleLaneDevice | null = device;
  const runtime: LifecycleLaneRuntime = {
    key: "lane-b",
    laneId: "lane-b",
    streamStatus: { running: true, deviceUdid: device.udid },
    hub: null,
  };
  const laneDevices = {
    get: () => bound,
    list: () => (bound ? [bound] : []),
    deviceDetach: vi.fn(async () => {
      const detached = bound;
      bound = null;
      return detached;
    }),
    deviceDelete: vi.fn(async () => {}),
    deviceDeleteInstalled: vi.fn(async () => {}),
  } as unknown as LaneDeviceRegistry;
  const shutdown = vi.fn(async () => ({ released: true, previousSession: null }));
  const emit = vi.fn();
  const lifecycle = createLaneDeviceLifecycle({
    laneDevices,
    runtimeForLane: () => runtime,
    allRuntimes: () => [runtime],
    resolveRuntime: () => runtime,
    requireLaneScope: () => runtime,
    serializeDeviceLifecycle: (_runtime, step) => step(),
    assertDarwin: () => {},
    // The service's rule, as `shutdown` applies it.
    assertSessionOwner: (_runtime, caller) => {
      if (owner && owner !== (caller.chatSessionId ?? null) && !caller.force && !caller.ignoreOwnership) {
        throw new Error("IOS_SIMULATOR_OWNED_BY_OTHER_SESSION: owned by another chat");
      }
    },
    shutdown,
    stopRuntimeStream: vi.fn(async () => {}),
    stopDeviceRecording: vi.fn(async () => {}),
    invalidateStatus: vi.fn(),
    invalidateDeviceList: vi.fn(),
    emit,
    logger: { info: vi.fn(), debug: vi.fn() },
  });
  return { lifecycle, laneDevices, shutdown, emit, bound: () => bound };
}

describe("laneDeviceLifecycle", () => {
  it("regression: deviceDetach refuses a device another chat is driving, as deviceStop does", async () => {
    const { lifecycle, laneDevices, shutdown, bound } = setup("chat-owner");

    await expect(lifecycle.deviceDetach({ laneId: "lane-b", chatSessionId: "chat-other" }))
      .rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
    // Refused before anything changed.
    expect(laneDevices.deviceDetach).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(bound()).toBe(device);

    await expect(lifecycle.deviceDetach({ laneId: "lane-b", chatSessionId: "chat-owner" }))
      .resolves.toMatchObject({ udid: "device-clone" });
  });

  it("detaches for the pane that ignores ownership, and releases the lane's hold", async () => {
    const { lifecycle, shutdown, emit } = setup("chat-owner");
    await expect(lifecycle.deviceDetach({ laneId: "lane-b", ignoreOwnership: true }))
      .resolves.toMatchObject({ udid: "device-clone" });
    expect(shutdown).toHaveBeenCalledWith({ laneId: "lane-b", ignoreOwnership: true });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "apple.device.state", phase: "released" }));
  });

  it("a forced delete of an attached device detaches it and deletes nothing", async () => {
    const { lifecycle, laneDevices } = setup("chat-owner");
    const attached = { ...device, origin: "attached" as const };
    (laneDevices as unknown as { get: () => AppleLaneDevice }).get = () => attached;
    (laneDevices.deviceDetach as ReturnType<typeof vi.fn>).mockResolvedValueOnce(attached);

    await lifecycle.deviceDelete({ laneId: "lane-b", force: true });

    expect(laneDevices.deviceDetach).toHaveBeenCalledWith({ laneId: "lane-b" });
    expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
  });
});
