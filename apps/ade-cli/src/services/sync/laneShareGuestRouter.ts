import { accountRepoScopeKey } from "../../../../desktop/src/shared/accountSettingsScope";
import { readGitOriginUrl } from "../../../../desktop/src/main/services/projects/recentProjectSummary";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { LaneShareGuestHandoff } from "./laneShareGuestTypes";
import type { LaneShareGuestRouter } from "./sharedSyncListener";

/**
 * Lane sharing across a brain's projects.
 *
 * A brain serves one project on its shared sync listener at a time (the one
 * opened last), but a lane may be shared from any project of the machine. A
 * guest socket that lands on the wrong project's host, or on the brain's own
 * ingress when no project is served, comes here (`LaneShareGuestHandoff`),
 * and this router gives it to the host of the right project
 * (`syncService.adoptLaneShareGuest`), which may be a guests-only host made
 * for it.
 *
 * - Redeemed (the first host checked the proof and redeemed the ticket): the
 *   project whose repository key is the grant's. Two checkouts of one
 *   repository: the one that has the lane.
 * - Not redeemed (the brain's ingress, which redeems nothing): a project
 *   that is already open, which redeems the ticket and, when the lane is
 *   elsewhere, routes it here again, redeemed. No project is opened for a
 *   socket whose ticket nobody has checked.
 * - Never back to the project the socket came from (`fromProjectId`).
 *
 * A project the brain refuses to open (a frozen folder) is skipped. Nothing
 * here trusts the guest: the host that takes the socket runs every check.
 */

/** A registered project, as the router reads it. */
export type LaneShareRouterProject = {
  projectId: string;
  rootPath: string;
  gitOriginUrl: string | null;
  lastOpenedAt: number;
};

/** What the router needs of a project's runtime. */
export type LaneShareRouterSync = {
  adoptLaneShareGuest(handoff: LaneShareGuestHandoff): boolean;
  hasLaneShareLane(laneId: string): boolean;
};

export function createLaneShareGuestRouter(deps: {
  listProjects(): readonly LaneShareRouterProject[];
  isOpenBlocked(projectId: string): boolean;
  /** The project's sync service when its runtime is open, without opening it. */
  bootedSync(projectId: string): Promise<LaneShareRouterSync | null> | null;
  /** Opens the project's runtime (or waits for it) and returns its sync service. */
  openSync(projectId: string): Promise<LaneShareRouterSync | null>;
  /** The project's origin now (the registry's copy can be old). */
  readOrigin?: (rootPath: string) => string | null;
  logger: Logger;
}): LaneShareGuestRouter {
  const readOrigin = deps.readOrigin ?? ((rootPath: string) => readGitOriginUrl(rootPath));
  const keyOfOrigin = (origin: string | null | undefined): string | null => accountRepoScopeKey(origin ?? null);
  /** A checkout's repository key from its own origin, for a miss on the registry's copy (`readGitOriginUrl` caches by the config's change time). */
  const liveKeyOf = (project: LaneShareRouterProject): string | null => {
    try {
      return keyOfOrigin(readOrigin(project.rootPath));
    } catch (error) {
      deps.logger.warn("lane_share.router_origin_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const syncOf = async (projectId: string, open: boolean): Promise<LaneShareRouterSync | null> => {
    try {
      const booted = deps.bootedSync(projectId);
      if (booted) return await booted;
      return open ? await deps.openSync(projectId) : null;
    } catch (error) {
      deps.logger.warn("lane_share.router_open_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  /** Open runtimes first, then the most recently opened. */
  const ordered = (projects: readonly LaneShareRouterProject[]): LaneShareRouterProject[] => {
    const booted = new Set(projects.filter((project) => deps.bootedSync(project.projectId) != null).map((project) => project.projectId));
    return [...projects].sort((left, right) => {
      const bootDelta = Number(booted.has(right.projectId)) - Number(booted.has(left.projectId));
      return bootDelta !== 0 ? bootDelta : right.lastOpenedAt - left.lastOpenedAt;
    });
  };

  /** The first candidate whose host takes the socket; the next one when a host cannot. */
  const offer = async (
    candidates: readonly LaneShareRouterProject[],
    handoff: LaneShareGuestHandoff,
    options: { open: boolean; laneId: string | null; checkLane: boolean },
  ): Promise<boolean> => {
    for (const project of candidates) {
      const sync = await syncOf(project.projectId, options.open);
      if (!sync) continue;
      if (options.checkLane && options.laneId && !sync.hasLaneShareLane(options.laneId)) continue;
      if (handoff.ws.readyState !== handoff.ws.OPEN) return false;
      if (sync.adoptLaneShareGuest(handoff)) {
        deps.logger.info("lane_share.router_routed", { redeemed: handoff.redeemed != null });
        return true;
      }
    }
    return false;
  };

  return async (handoff) => {
    const projects = deps.listProjects().filter((project) =>
      !deps.isOpenBlocked(project.projectId) && project.projectId !== (handoff.fromProjectId ?? null));
    if (handoff.redeemed) {
      const { repoKey, laneId } = handoff.redeemed.redemption;
      if (repoKey) {
        let matching = projects.filter((project) => keyOfOrigin(project.gitOriginUrl) === repoKey);
        // The registry's origin can be old: read each checkout's own.
        if (matching.length === 0) matching = projects.filter((project) => liveKeyOf(project) === repoKey);
        if (await offer(ordered(matching), handoff, { open: true, laneId, checkLane: matching.length > 1 })) return true;
        deps.logger.info("lane_share.router_no_project", { redeemed: true, candidates: matching.length });
        return false;
      }
      // A grant with no repository key: only an open project that has the lane.
      if (await offer(ordered(projects), handoff, { open: false, laneId, checkLane: true })) return true;
      deps.logger.info("lane_share.router_no_project", { redeemed: true, candidates: 0 });
      return false;
    }
    // Not redeemed (the brain's ingress): an already open project redeems it
    // and routes it on. Nothing is opened for a socket nobody has checked.
    if (await offer(ordered(projects), handoff, { open: false, laneId: null, checkLane: false })) return true;
    deps.logger.info("lane_share.router_no_project", { redeemed: false, candidates: projects.length });
    return false;
  };
}
