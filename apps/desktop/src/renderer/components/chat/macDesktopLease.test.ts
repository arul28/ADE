import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAC_DESKTOP_LEASE_TTL_MS } from "../../../shared/types/macDesktop";
import {
  MAC_DESKTOP_LEASE_HEARTBEAT_MS,
  createMacDesktopLeaseHeartbeat,
  macDesktopAgentHasControl,
  macDesktopUserHasControl,
} from "./macDesktopLease";

describe("macDesktop lease heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews well inside the TTL, so one lost renewal is survivable", () => {
    expect(MAC_DESKTOP_LEASE_HEARTBEAT_MS * 2).toBeLessThan(MAC_DESKTOP_LEASE_TTL_MS);
  });

  it("renews on a period and stops on demand", async () => {
    const renew = vi.fn(async () => ({ expiresAt: "2026-01-01T00:00:00.000Z" }));
    const heartbeat = createMacDesktopLeaseHeartbeat({ renew, onLost: vi.fn(), periodMs: 1_000 });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(renew).toHaveBeenCalledTimes(3);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(heartbeat.running).toBe(false);
  });

  it("a second start does not open a second interval", async () => {
    const renew = vi.fn(async () => ({ expiresAt: "x" }));
    const heartbeat = createMacDesktopLeaseHeartbeat({ renew, onLost: vi.fn(), periodMs: 1_000 });
    heartbeat.start();
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("reports the lease lost exactly once when the host says it is gone", async () => {
    const onLost = vi.fn();
    const heartbeat = createMacDesktopLeaseHeartbeat({
      renew: async () => null,
      onLost,
      periodMs: 1_000,
    });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(heartbeat.running).toBe(false);
  });

  it("reports the lease lost when a renewal rejects", async () => {
    const onLost = vi.fn();
    const heartbeat = createMacDesktopLeaseHeartbeat({
      renew: async () => {
        throw new Error("machine went away");
      },
      onLost,
      periodMs: 1_000,
    });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onLost).toHaveBeenCalledWith("machine went away");
  });

  it("stopping a stopped heartbeat is a no-op", () => {
    const heartbeat = createMacDesktopLeaseHeartbeat({
      renew: async () => null,
      onLost: vi.fn(),
    });
    expect(() => {
      heartbeat.stop();
      heartbeat.stop();
    }).not.toThrow();
  });
});

describe("who holds control", () => {
  it("is this window only when the lease names this controller", () => {
    expect(macDesktopUserHasControl({ holder: "user", holderId: "me" }, "me")).toBe(true);
    // Another ADE window of the same user. From here that is somebody else's
    // control, and the amber banner must not claim it.
    expect(macDesktopUserHasControl({ holder: "user", holderId: "other" }, "me")).toBe(false);
    expect(macDesktopUserHasControl({ holder: "agent", holderId: "me" }, "me")).toBe(false);
    expect(macDesktopUserHasControl(null, "me")).toBe(false);
  });

  it("knows when an agent is driving", () => {
    expect(macDesktopAgentHasControl({ holder: "agent" })).toBe(true);
    expect(macDesktopAgentHasControl({ holder: "user" })).toBe(false);
    expect(macDesktopAgentHasControl(null)).toBe(false);
  });
});
