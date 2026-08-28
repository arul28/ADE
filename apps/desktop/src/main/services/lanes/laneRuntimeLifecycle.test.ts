import { describe, expect, it, vi } from "vitest";
import type { LaneSummary, PortLease } from "../../../shared/types";
import {
  ensureActiveLanePortLease,
  releaseLaneRuntimeResources,
  restoreRecreatedLaneRuntime,
  restoreUnarchivedLaneDocker,
  restoreUnarchivedLaneRuntime,
  teardownArchivedLaneEnvironment,
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
        cleanupLaneEnvironment: vi.fn(async () => {}),
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

  it("tears down the lane docker environment when a lane is archived", async () => {
    const cleanupLaneEnvironment = vi.fn(async () => {});
    await teardownArchivedLaneEnvironment({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: { docker: { composePath: "docker-compose.yml" } },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment: vi.fn(async () => {}),
        cleanupLaneEnvironment,
      },
    }, lane.id);

    expect(cleanupLaneEnvironment).toHaveBeenCalledWith(lane, {
      docker: { composePath: "docker-compose.yml" },
    });
  });

  it("skips archive teardown when the lane has no docker services", async () => {
    const cleanupLaneEnvironment = vi.fn(async () => {});
    await teardownArchivedLaneEnvironment({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({ laneEnvInit: { envFiles: [] }, laneOverlayPolicies: [] }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment: vi.fn(async () => {}),
        cleanupLaneEnvironment,
      },
    }, lane.id);

    expect(cleanupLaneEnvironment).not.toHaveBeenCalled();
  });

  it("brings only the docker step back up on a plain unarchive", async () => {
    const initLaneEnvironment = vi.fn(async () => {});
    await restoreUnarchivedLaneDocker({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: {
            docker: { composePath: "docker-compose.yml" },
            envFiles: [{ source: ".env.template", dest: ".env" }],
            dependencies: [{ command: ["npm", "install"] }],
            setupScript: { commands: ["echo hi"] },
          },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment,
        cleanupLaneEnvironment: vi.fn(async () => {}),
      },
    }, lane.id);

    // Only docker: re-copying env files, reinstalling dependencies or re-running
    // the setup script would clobber a worktree that was never removed.
    expect(initLaneEnvironment).toHaveBeenCalledWith(
      lane,
      { docker: { composePath: "docker-compose.yml" } },
      {},
    );
  });

  it("re-acquires the port lease archive released before bringing docker back up", async () => {
    // Archive releases the lease; compose files are templated with PORT_RANGE_*
    // so coming back up without one would bind the fallback range.
    const order: string[] = [];
    const initLaneEnvironment = vi.fn(async () => {
      order.push("environment");
    });
    await restoreUnarchivedLaneDocker({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: { docker: { composePath: "docker-compose.yml" } },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment,
        cleanupLaneEnvironment: vi.fn(async () => {}),
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
      { docker: { composePath: "docker-compose.yml" } },
      { portRange: { start: 4100, end: 4199 } },
    );
  });

  it("returns before docker finishes on a plain unarchive", async () => {
    // `docker compose up -d` has a 300s budget while the mobile lanes.unarchive
    // command has 30s, so awaiting it timed unarchive out on every Docker
    // project. Progress reaches the UI over the lane-env-init broadcast.
    let releaseDocker: (() => void) | undefined;
    const dockerStarted = vi.fn();
    const initLaneEnvironment = vi.fn(async () => {
      dockerStarted();
      await new Promise<void>((resolve) => {
        releaseDocker = resolve;
      });
    });

    await restoreUnarchivedLaneRuntime({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: { docker: { composePath: "docker-compose.yml" } },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment,
        cleanupLaneEnvironment: vi.fn(async () => {}),
      },
    }, lane.id, { worktreeRecreated: false });

    // Resolved while compose is still running.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dockerStarted).toHaveBeenCalled();
    releaseDocker?.();
  });

  it("reports a background docker failure instead of swallowing it", async () => {
    const failure = new Error("compose refused to start");
    const onDockerError = vi.fn();

    await restoreUnarchivedLaneRuntime({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: { docker: { composePath: "docker-compose.yml" } },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment: vi.fn(async () => {
          throw failure;
        }),
        cleanupLaneEnvironment: vi.fn(async () => {}),
      },
    }, lane.id, { worktreeRecreated: false, onDockerError });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onDockerError).toHaveBeenCalledWith(failure);
  });

  it("awaits the full env init when the worktree was recreated", async () => {
    // The rare path hands back a directory with no env files, dependencies or
    // mounts yet, so reporting success before it finishes would be a lie.
    let initFinished = false;
    const initLaneEnvironment = vi.fn(async () => {
      await Promise.resolve();
      initFinished = true;
    });

    await restoreUnarchivedLaneRuntime({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({
          laneEnvInit: { docker: { composePath: "docker-compose.yml" }, envFiles: [] },
          laneOverlayPolicies: [],
        }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment,
        cleanupLaneEnvironment: vi.fn(async () => {}),
      },
    }, lane.id, { worktreeRecreated: true });

    expect(initFinished).toBe(true);
  });

  it("does nothing on a plain unarchive when the lane has no docker services", async () => {
    const initLaneEnvironment = vi.fn(async () => {});
    await restoreUnarchivedLaneDocker({
      laneService: laneService(),
      projectConfigService: {
        getEffective: () => ({ laneEnvInit: { envFiles: [] }, laneOverlayPolicies: [] }),
      },
      laneEnvironmentService: {
        resolveEnvInitConfig: (config) => config,
        initLaneEnvironment,
        cleanupLaneEnvironment: vi.fn(async () => {}),
      },
    }, lane.id);

    expect(initLaneEnvironment).not.toHaveBeenCalled();
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
