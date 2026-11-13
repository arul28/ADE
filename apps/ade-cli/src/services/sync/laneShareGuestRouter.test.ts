import { describe, expect, it, vi } from "vitest";
import { accountRepoScopeKey } from "../../../../desktop/src/shared/accountSettingsScope";
import { createLaneShareGuestRouter, type LaneShareRouterProject, type LaneShareRouterSync } from "./laneShareGuestRouter";
import type { LaneShareGuestHandoff } from "./laneShareGuestTypes";

const ORIGIN = "https://github.com/acme/app.git";
const OTHER_ORIGIN = "https://github.com/acme/other.git";
const REPO_KEY = accountRepoScopeKey(ORIGIN)!;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function project(projectId: string, gitOriginUrl: string | null, lastOpenedAt = 1): LaneShareRouterProject {
  return { projectId, rootPath: `/work/${projectId}`, gitOriginUrl, lastOpenedAt };
}

/** A project's sync service as the router sees it: whether it has the lane, and whether its host takes the socket. */
function sync(options: { lanes?: string[]; takes?: boolean } = {}) {
  const adopted: LaneShareGuestHandoff[] = [];
  const service: LaneShareRouterSync = {
    adoptLaneShareGuest: (handoff) => {
      if (options.takes === false) return false;
      adopted.push(handoff);
      return true;
    },
    hasLaneShareLane: (laneId) => (options.lanes ?? ["lane-1"]).includes(laneId),
  };
  return { service, adopted };
}

function handoff(redeemed: LaneShareGuestHandoff["redeemed"], fromProjectId?: string): LaneShareGuestHandoff {
  return {
    ws: { readyState: 1, OPEN: 1 } as never,
    remoteAddress: null,
    remotePort: null,
    transportOrigin: "relay-bridge",
    requestId: "hello-1",
    hello: {} as never,
    auth: { kind: "guest" } as never,
    redeemed,
    ...(fromProjectId ? { fromProjectId } : {}),
  };
}

function redeemed(repoKey: string | null, laneId = "lane-1"): NonNullable<LaneShareGuestHandoff["redeemed"]> {
  return {
    dpopPublicKey: "key",
    redemption: { repoKey, laneId } as never,
    snapshot: {} as never,
    redeemerUserId: "user-owner",
  };
}

describe("lane share guest router", () => {
  it("never opens a project for a socket whose ticket nobody redeemed: only an already open host gets it", async () => {
    const open = sync();
    const closed = sync();
    const openSync = vi.fn(async () => closed.service);
    const route = createLaneShareGuestRouter({
      listProjects: () => [project("closed", ORIGIN, 9), project("open", OTHER_ORIGIN, 1)],
      isOpenBlocked: () => false,
      bootedSync: (projectId) => (projectId === "open" ? Promise.resolve(open.service) : null),
      openSync,
      readOrigin: () => null,
      logger,
    });

    expect(await route(handoff(null))).toBe(true);
    expect(open.adopted).toHaveLength(1);
    expect(closed.adopted).toHaveLength(0);
    expect(openSync).not.toHaveBeenCalled();

    // With no open project, an unredeemed socket is refused, still without opening one.
    const none = createLaneShareGuestRouter({
      listProjects: () => [project("closed", ORIGIN)],
      isOpenBlocked: () => false,
      bootedSync: () => null,
      openSync,
      readOrigin: () => ORIGIN,
      logger,
    });
    expect(await none(handoff(null))).toBe(false);
    expect(openSync).not.toHaveBeenCalled();
  });

  it("routes a redeemed guest to its repository's project: never back where it came from, a stale registry origin first, then a live one", async () => {
    const source = sync();
    const stale = sync({ takes: false });
    const live = sync();
    const blocked = sync();
    const opened: string[] = [];
    const services: Record<string, LaneShareRouterSync> = {
      source: source.service,
      stale: stale.service,
      live: live.service,
      blocked: blocked.service,
    };
    const route = createLaneShareGuestRouter({
      listProjects: () => [
        project("source", ORIGIN, 4),
        project("blocked", ORIGIN, 3),
        // The registry still says this checkout is the repository; its host cannot take the guest.
        project("stale", ORIGIN, 2),
        // The registry's copy of this one's origin is old; its own origin matches.
        project("live", OTHER_ORIGIN, 1),
      ],
      isOpenBlocked: (projectId) => projectId === "blocked",
      bootedSync: () => null,
      openSync: async (projectId) => {
        opened.push(projectId);
        return services[projectId] ?? null;
      },
      readOrigin: (rootPath) => (rootPath.endsWith("/live") ? ORIGIN : OTHER_ORIGIN),
      logger,
    });

    expect(await route(handoff(redeemed(REPO_KEY), "source"))).toBe(true);
    expect(opened).toEqual(["stale", "live"]);
    expect(live.adopted).toHaveLength(1);
    expect(source.adopted).toHaveLength(0);
    expect(blocked.adopted).toHaveLength(0);

    // A repository no checkout has: refused, nothing opened.
    opened.length = 0;
    expect(await route(handoff(redeemed(accountRepoScopeKey("https://github.com/acme/missing.git")), "source"))).toBe(false);
    expect(opened).toEqual([]);
  });
});
