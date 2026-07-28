import { describe, expect, it, vi } from "vitest";
import type { LaneSummary, PortLease } from "../../../shared/types";
import {
  ensureActiveLanePortLease,
  releaseLaneRuntimeResources,
  restoreRecreatedLaneRuntime,
} from "./laneRuntimeLifecycle";

const lane = {
  id: "lane-1",
  name: "Lane one",
  laneType: "worktree",
  worktreePath: "/repo/.ade/worktrees/lane-1",
} as LaneSummary;

const lease: PortLease = {
  laneId: lane.id,
  rangeStart: 4100,
  rangeEnd: 4199,
  status: "active",
  leasedAt: "2026-07-28T00:00:00.000Z",
};

function laneService() {
  return {
    list: vi.fn(async () => [lane]),
  };
}

describe("lane runtime lifecycle", () => {
  it("acquires an active lease for a restored lane", async () => {
    const acquire = vi.fn(() => lease);
    const result = await ensureActiveLanePortLease({
      laneService: laneService(),
      portAllocationService: {
        getLease: vi.fn(() => null),
        acquire,
        release: vi.fn(),
      },
    }, lane.id);

    expect(result).toEqual(lease);
    expect(acquire).toHaveBeenCalledWith(lane.id);
  });

  it("restores the port lease before initializing the lane environment", async () => {
    const order: string[] = [];
    const initLaneEnvironment = vi.fn(async () => {
      order.push("environment");
    });
    await restoreRecreatedLaneRuntime({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: { envFiles: [] },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment,
      },
      portAllocationService: {
        getLease: vi.fn(() => null),
        acquire: vi.fn(() => {
          order.push("lease");
          return lease;
        }),
        release: vi.fn(),
      },
    }, lane.id);

    expect(order).toEqual(["lease", "environment"]);
    expect(initLaneEnvironment).toHaveBeenCalledWith(
      lane,
      { envFiles: [] },
      { portRange: { start: 4100, end: 4199 } },
    );
  });

  it("removes the proxy route and releases an active lease", () => {
    const removeRoute = vi.fn();
    const release = vi.fn();
    releaseLaneRuntimeResources({
      laneProxyService: { removeRoute },
      portAllocationService: {
        getLease: vi.fn(() => lease),
        acquire: vi.fn(() => lease),
        release,
      },
    }, lane.id);

    expect(removeRoute).toHaveBeenCalledWith(lane.id);
    expect(release).toHaveBeenCalledWith(lane.id);
  });

  it("releases an active lease before reporting a proxy route failure", () => {
    const routeError = new Error("proxy route is busy");
    const release = vi.fn();

    expect(() => releaseLaneRuntimeResources({
      laneProxyService: {
        removeRoute: vi.fn(() => {
          throw routeError;
        }),
      },
      portAllocationService: {
        getLease: vi.fn(() => lease),
        acquire: vi.fn(() => lease),
        release,
      },
    }, lane.id)).toThrow(routeError);

    expect(release).toHaveBeenCalledWith(lane.id);
  });
});
