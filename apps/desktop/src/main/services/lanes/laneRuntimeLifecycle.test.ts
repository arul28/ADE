import { describe, expect, it, vi } from "vitest";
import type { LaneEnvInitConfig, LaneSummary, PortLease } from "../../../shared/types";
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

const DOCKER_ONLY: LaneEnvInitConfig = { docker: { composePath: "docker-compose.yml" } };

type Dependencies = Parameters<typeof restoreUnarchivedLaneDocker>[0];
type EnvironmentService = NonNullable<Dependencies["laneEnvironmentService"]>;

/**
 * One dependency bag for every case in this file — the four services were
 * re-typed by hand in each test, which made a signature change a find-and-
 * replace and hid which service any given case actually cared about.
 */
function makeDeps(
  overrides: {
    lanes?: LaneSummary[];
    laneEnvInit?: LaneEnvInitConfig;
    initLaneEnvironment?: EnvironmentService["initLaneEnvironment"];
    cleanupLaneEnvironment?: EnvironmentService["cleanupLaneEnvironment"];
    lastInitIncomplete?: boolean;
    portAllocationService?: Dependencies["portAllocationService"];
    laneProxyService?: Dependencies["laneProxyService"];
  } = {},
): Dependencies {
  const lanes = overrides.lanes ?? [lane];
  return {
    laneService: { list: vi.fn(async () => lanes) },
    projectConfigService: {
      getEffective: () => ({
        laneEnvInit: overrides.laneEnvInit ?? { envFiles: [] },
        laneOverlayPolicies: [],
      }),
    },
    laneEnvironmentService: {
      resolveEnvInitConfig: (config) => config,
      initLaneEnvironment: overrides.initLaneEnvironment ?? vi.fn(async () => {}),
      cleanupLaneEnvironment: overrides.cleanupLaneEnvironment ?? vi.fn(async () => {}),
      wasLastInitIncomplete: vi.fn(() => overrides.lastInitIncomplete === true),
    },
    ...(overrides.portAllocationService !== undefined
      ? { portAllocationService: overrides.portAllocationService }
      : {}),
    ...(overrides.laneProxyService !== undefined
      ? { laneProxyService: overrides.laneProxyService }
      : {}),
  };
}

/**
 * Allocator fake that behaves like the real one: `getLease` reports nothing
 * until `acquire` hands a lease out, and the acquired lease afterwards. A fake
 * that answered `null` forever hid that the overlay context reads the allocator
 * back rather than being handed a lease by its caller.
 */
function statefulAllocator(onAcquire?: () => void, release = vi.fn()) {
  let held: PortLease | null = null;
  return {
    getLease: vi.fn(() => held),
    acquire: vi.fn(() => {
      onAcquire?.();
      held = lease;
      return lease;
    }),
    release: vi.fn((laneId: string) => {
      // The real allocator keeps the entry and flips its status rather than
      // dropping it, so `getLease` after a release answers a released lease —
      // which is what `ensureActiveLanePortLease` distinguishes from `null`.
      held = { ...lease, status: "released", releasedAt: "2026-07-28T00:01:00.000Z" };
      release(laneId);
    }),
  };
}

/** Allocator that records the moment the lease is acquired, for ordering asserts. */
function recordingAllocator(order: string[], release = vi.fn()) {
  return statefulAllocator(() => order.push("lease"), release);
}

describe("lane runtime lifecycle", () => {
  it("acquires an active lease for a restored lane", async () => {
    const allocator = statefulAllocator();
    const result = await ensureActiveLanePortLease(
      {
        laneService: { list: vi.fn(async () => [lane]) },
        portAllocationService: allocator,
      },
      lane.id,
    );

    expect(result).toEqual(lease);
    expect(allocator.acquire).toHaveBeenCalledWith(lane.id);
  });

  it("restores the port lease before initializing the lane environment", async () => {
    const order: string[] = [];
    const initLaneEnvironment = vi.fn(async () => {
      order.push("environment");
    });
    await restoreRecreatedLaneRuntime(
      makeDeps({
        initLaneEnvironment,
        portAllocationService: recordingAllocator(order),
      }),
      lane.id,
    );

    expect(order).toEqual(["lease", "environment"]);
    expect(initLaneEnvironment).toHaveBeenCalledWith(
      lane,
      { envFiles: [] },
      { portRange: { start: 4100, end: 4199 } },
    );
  });

  it("tears down the lane docker environment when a lane is archived", async () => {
    const cleanupLaneEnvironment = vi.fn(async () => {});
    await teardownArchivedLaneEnvironment(
      makeDeps({ laneEnvInit: DOCKER_ONLY, cleanupLaneEnvironment }),
      lane.id,
    );

    expect(cleanupLaneEnvironment).toHaveBeenCalledWith(lane, DOCKER_ONLY);
  });

  it("skips archive teardown when the lane has no docker services", async () => {
    const cleanupLaneEnvironment = vi.fn(async () => {});
    await teardownArchivedLaneEnvironment(makeDeps({ cleanupLaneEnvironment }), lane.id);

    expect(cleanupLaneEnvironment).not.toHaveBeenCalled();
  });

  it("logs, rather than swallows, a teardown context failure", async () => {
    // The `onContextError` callback this replaced was optional, and both
    // archive-and-reclaim call sites had forgotten it — so a resolution failure
    // on the destructive path vanished.
    const warn = vi.fn();
    const cleanupLaneEnvironment = vi.fn(async () => {});
    const teardown = await teardownArchivedLaneEnvironment(
      {
        ...makeDeps({ lanes: [], laneEnvInit: DOCKER_ONLY, cleanupLaneEnvironment }),
        logger: { warn },
      },
      lane.id,
    );

    expect(teardown).toBeUndefined();
    expect(cleanupLaneEnvironment).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "lane_env_cleanup.teardown_context_failed",
      expect.objectContaining({ laneId: lane.id }),
    );
  });

  it("brings only the docker step back up on a plain unarchive", async () => {
    const initLaneEnvironment = vi.fn(async () => {});
    await restoreUnarchivedLaneDocker(
      makeDeps({
        laneEnvInit: {
          ...DOCKER_ONLY,
          envFiles: [{ source: ".env.template", dest: ".env" }],
          dependencies: [{ command: ["npm", "install"] }],
          setupScript: { commands: ["echo hi"] },
        },
        initLaneEnvironment,
      }),
      lane.id,
    );

    // Only docker: re-copying env files, reinstalling dependencies or re-running
    // the setup script would clobber a worktree that was never removed.
    expect(initLaneEnvironment).toHaveBeenCalledWith(lane, DOCKER_ONLY, {});
  });

  it("re-runs the whole env init when the lane's last init never completed", async () => {
    // Archiving mid-init cancels the remaining steps, and the teardown deletes
    // the progress entry that recorded it — so a docker-only restore would hand
    // back a worktree with no env files, dependencies or setup script and call
    // it healthy.
    const initLaneEnvironment = vi.fn(async () => {});
    const fullConfig: LaneEnvInitConfig = {
      ...DOCKER_ONLY,
      envFiles: [{ source: ".env.template", dest: ".env" }],
      dependencies: [{ command: ["npm", "install"] }],
      setupScript: { commands: ["echo hi"] },
    };
    await restoreUnarchivedLaneDocker(
      makeDeps({ laneEnvInit: fullConfig, initLaneEnvironment, lastInitIncomplete: true }),
      lane.id,
    );

    expect(initLaneEnvironment).toHaveBeenCalledWith(lane, fullConfig, {});
  });

  it("repairs an incomplete init even when the lane has no docker step", async () => {
    // The docker guard is what normally stops this path; a half-written
    // worktree still needs its env files and dependencies back.
    const initLaneEnvironment = vi.fn(async () => {});
    const config: LaneEnvInitConfig = { envFiles: [{ source: ".env.template", dest: ".env" }] };
    await restoreUnarchivedLaneDocker(
      makeDeps({ laneEnvInit: config, initLaneEnvironment, lastInitIncomplete: true }),
      lane.id,
    );

    expect(initLaneEnvironment).toHaveBeenCalledWith(lane, config, {});
  });

  it("re-acquires the port lease archive released before bringing docker back up", async () => {
    // Archive releases the lease; compose files are templated with PORT_RANGE_*
    // so coming back up without one would bind the fallback range.
    const order: string[] = [];
    const initLaneEnvironment = vi.fn(async () => {
      order.push("environment");
    });
    await restoreUnarchivedLaneDocker(
      makeDeps({
        laneEnvInit: DOCKER_ONLY,
        initLaneEnvironment,
        portAllocationService: recordingAllocator(order),
      }),
      lane.id,
    );

    expect(order).toEqual(["lease", "environment"]);
    expect(initLaneEnvironment).toHaveBeenCalledWith(lane, DOCKER_ONLY, {
      portRange: { start: 4100, end: 4199 },
    });
  });

  it("acquires no port lease when an unarchived lane has no docker step", async () => {
    // The lease guard used to run first, so every Docker-less unarchive took a
    // port range it would never use — and the plain path does not await this,
    // so nothing gave it back either.
    const allocator = statefulAllocator();
    await restoreUnarchivedLaneDocker(
      makeDeps({
        laneEnvInit: { envFiles: [{ source: ".env.template", dest: ".env" }] },
        portAllocationService: allocator,
      }),
      lane.id,
    );

    expect(allocator.acquire).not.toHaveBeenCalled();
  });

  it("hands the lease back when the lane is archived mid-restore", async () => {
    // The restore is not awaited, so an archive can land between acquiring the
    // lease and starting a 300s `compose up`. Stopping without releasing would
    // strand the range on a lane nobody owns.
    const release = vi.fn();
    const removeRoute = vi.fn();
    const initLaneEnvironment = vi.fn(async () => {});
    let listed = 0;
    const deps = makeDeps({
      laneEnvInit: DOCKER_ONLY,
      initLaneEnvironment,
      portAllocationService: statefulAllocator(undefined, release),
      laneProxyService: { removeRoute },
    });
    // Active for the first resolve and the lease check, archived by the re-check.
    deps.laneService.list = vi.fn(async () => {
      listed += 1;
      return listed <= 2 ? [lane] : [];
    });

    await restoreUnarchivedLaneDocker(deps, lane.id);

    expect(initLaneEnvironment).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(lane.id);
    expect(removeRoute).toHaveBeenCalledWith(lane.id);
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

    await restoreUnarchivedLaneRuntime(
      makeDeps({ laneEnvInit: DOCKER_ONLY, initLaneEnvironment }),
      lane.id,
      { worktreeRecreated: false },
    );

    // Resolved while compose is still running.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dockerStarted).toHaveBeenCalled();
    releaseDocker?.();
  });

  it("reports a background docker failure instead of swallowing it", async () => {
    const failure = new Error("compose refused to start");
    const onDockerError = vi.fn();

    await restoreUnarchivedLaneRuntime(
      makeDeps({
        laneEnvInit: DOCKER_ONLY,
        initLaneEnvironment: vi.fn(async () => {
          throw failure;
        }),
      }),
      lane.id,
      { worktreeRecreated: false, onDockerError },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onDockerError).toHaveBeenCalledWith(failure);
  });

  it("survives a throwing docker error handler instead of crashing the process", async () => {
    // The handler runs in the last `.catch` of a detached promise, so a throwing
    // logger there surfaced as an unhandled rejection rather than a failed
    // Docker restore.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await restoreUnarchivedLaneRuntime(
        makeDeps({
          laneEnvInit: DOCKER_ONLY,
          initLaneEnvironment: vi.fn(async () => {
            throw new Error("compose refused to start");
          }),
        }),
        lane.id,
        {
          worktreeRecreated: false,
          onDockerError: () => {
            throw new Error("logger blew up");
          },
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("awaits the full env init when the worktree was recreated", async () => {
    // The rare path hands back a directory with no env files, dependencies or
    // mounts yet, so reporting success before it finishes would be a lie.
    let initFinished = false;
    const initLaneEnvironment = vi.fn(async () => {
      await Promise.resolve();
      initFinished = true;
    });

    await restoreUnarchivedLaneRuntime(
      makeDeps({
        laneEnvInit: { ...DOCKER_ONLY, envFiles: [] },
        initLaneEnvironment,
      }),
      lane.id,
      { worktreeRecreated: true },
    );

    expect(initFinished).toBe(true);
  });

  it("does nothing on a plain unarchive when the lane has no docker services", async () => {
    const initLaneEnvironment = vi.fn(async () => {});
    await restoreUnarchivedLaneDocker(makeDeps({ initLaneEnvironment }), lane.id);

    expect(initLaneEnvironment).not.toHaveBeenCalled();
  });

  it("removes the proxy route and releases an active lease", () => {
    const removeRoute = vi.fn();
    const release = vi.fn();
    releaseLaneRuntimeResources(
      {
        laneProxyService: { removeRoute },
        portAllocationService: {
          getLease: vi.fn(() => lease),
          acquire: vi.fn(() => lease),
          release,
        },
      },
      lane.id,
    );

    expect(removeRoute).toHaveBeenCalledWith(lane.id);
    expect(release).toHaveBeenCalledWith(lane.id);
  });

  it("releases an active lease before reporting a proxy route failure", () => {
    const routeError = new Error("proxy route is busy");
    const release = vi.fn();

    expect(() =>
      releaseLaneRuntimeResources(
        {
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
        },
        lane.id,
      ),
    ).toThrow(routeError);

    expect(release).toHaveBeenCalledWith(lane.id);
  });
});
