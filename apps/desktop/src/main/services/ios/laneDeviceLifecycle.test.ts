import { describe, expect, it, vi } from "vitest";
import type { AppleLaneDevice } from "../../../shared/types";
import { createLaneDeviceLifecycle, type LifecycleLaneRuntime } from "./laneDeviceLifecycle";
import { AppleDeviceAttachedNotDeletableError, type LaneDeviceRegistry } from "./laneDeviceRegistry";

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

function setup(initialOwner: string | null) {
  let owner = initialOwner;
  let bound: AppleLaneDevice | null = device;
  // The service's queue: one step at a time per lane.
  let queue: Promise<unknown> = Promise.resolve();
  const serializeDeviceLifecycle = <T>(_runtime: unknown, step: () => Promise<T>): Promise<T> => {
    const next = queue.then(step, step);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
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
    serializeDeviceLifecycle,
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
  return {
    lifecycle,
    laneDevices,
    shutdown,
    emit,
    serializeDeviceLifecycle,
    bound: () => bound,
    setBound: (next: AppleLaneDevice | null) => { bound = next; },
    setOwner: (next: string | null) => { owner = next; },
  };
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

    await lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-owner", force: true });

    expect(laneDevices.deviceDetach).toHaveBeenCalledWith({ laneId: "lane-b" });
    expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
  });

  it("regression: a forced deviceDelete from another chat cannot detach or delete the owner's device", async () => {
    const attachedCase = setup("chat-a");
    const attached = { ...device, origin: "attached" as const };
    (attachedCase.laneDevices as unknown as { get: () => AppleLaneDevice }).get = () => attached;

    await expect(attachedCase.lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-b", force: true }))
      .rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
    expect(attachedCase.laneDevices.deviceDetach).not.toHaveBeenCalled();
    expect(attachedCase.shutdown).not.toHaveBeenCalled();

    const cloneCase = setup("chat-a");
    await expect(cloneCase.lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-b", force: true }))
      .rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
    expect(cloneCase.laneDevices.deviceDelete).not.toHaveBeenCalled();
    expect(cloneCase.shutdown).not.toHaveBeenCalled();
    expect(cloneCase.bound()).toBe(device);

    // The Work pane deletes for whoever is running.
    await cloneCase.lifecycle.deviceDelete({ laneId: "lane-b", ignoreOwnership: true });
    expect(cloneCase.laneDevices.deviceDelete).toHaveBeenCalledWith({ laneId: "lane-b" });
  });

  it("regression: a delete queued behind another chat's start is refused once that chat claims the session", async () => {
    const { lifecycle, laneDevices, shutdown, serializeDeviceLifecycle, setOwner, bound } = setup(null);
    let claimed = () => {};
    const claim = new Promise<void>((resolve) => { claimed = resolve; });
    // Chat A's start, in flight: it claims the session when it finishes.
    const start = serializeDeviceLifecycle(null, async () => {
      await claim;
      setOwner("chat-a");
    });

    // No owner yet, so the up-front check passes and the delete waits its turn.
    const deleted = lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-b" });
    claimed();
    await start;

    await expect(deleted).rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
    expect(shutdown).not.toHaveBeenCalled();
    expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
    expect(bound()).toBe(device);
  });

  it("regression: an unforced delete of an attached device is refused before the stream stops", async () => {
    const { lifecycle, laneDevices, shutdown, setBound } = setup("chat-owner");
    const attached = { ...device, origin: "attached" as const };
    setBound(attached);

    await expect(lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-owner" }))
      .rejects.toBeInstanceOf(AppleDeviceAttachedNotDeletableError);
    expect(shutdown).not.toHaveBeenCalled();
    expect(laneDevices.deviceDetach).not.toHaveBeenCalled();
    expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
  });

  it("regression: a delete reads the lane's device once, in the queue, after a start in flight has changed it", async () => {
    const attached = { ...device, origin: "attached" as const };

    // Forced: the device the start left behind is attached, so it is detached, not deleted.
    const forced = setup(null);
    forced.setBound(null);
    const forcedStart = forced.serializeDeviceLifecycle(null, async () => { forced.setBound(attached); });
    await forced.lifecycle.deviceDelete({ laneId: "lane-b", force: true });
    await forcedStart;
    expect(forced.laneDevices.deviceDetach).toHaveBeenCalledWith({ laneId: "lane-b" });
    expect(forced.laneDevices.deviceDelete).not.toHaveBeenCalled();

    // Unforced: refused, and the stream the start opened keeps running.
    const unforced = setup(null);
    const unforcedStart = unforced.serializeDeviceLifecycle(null, async () => { unforced.setBound(attached); });
    await expect(unforced.lifecycle.deviceDelete({ laneId: "lane-b" }))
      .rejects.toBeInstanceOf(AppleDeviceAttachedNotDeletableError);
    await unforcedStart;
    expect(unforced.shutdown).not.toHaveBeenCalled();
    expect(unforced.laneDevices.deviceDelete).not.toHaveBeenCalled();
  });

  it("deletes a clone: the stream stops first, then the registry deletes and the lane hears released", async () => {
    const { lifecycle, laneDevices, shutdown, emit } = setup(null);
    await lifecycle.deviceDelete({ laneId: "lane-b" });
    expect(shutdown).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-b", ignoreOwnership: true }));
    expect(laneDevices.deviceDelete).toHaveBeenCalledWith({ laneId: "lane-b" });
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      (laneDevices.deviceDelete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(emit).toHaveBeenCalledWith({ type: "apple.device.state", laneId: "lane-b", udid: "device-clone", phase: "released" });
  });
});
