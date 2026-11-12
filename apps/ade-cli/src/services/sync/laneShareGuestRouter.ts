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
 * - Not redeemed (the brain's ingress, which redeems nothing): any open
 *   project, which redeems the ticket and, when the lane is elsewhere, routes
 *   it here again, redeemed.
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
  logger: Logger;
}): LaneShareGuestRouter {
  /** Repository keys by project root and origin, so a guest costs no git read after the first. */
  const repoKeys = new Map<string, string | null>();
  const repoKeyOf = (project: LaneShareRouterProject): string | null => {
    const cacheKey = `${project.rootPath}\u0000${project.gitOriginUrl ?? ""}`;
    if (!repoKeys.has(cacheKey)) {
      let origin = project.gitOriginUrl;
      if (!origin) {
        try {
          origin = readGitOriginUrl(project.rootPath);
        } catch {
          origin = null;
        }
      }
      repoKeys.set(cacheKey, accountRepoScopeKey(origin));
    }
    return repoKeys.get(cacheKey) ?? null;
  };

  const syncOf = async (projectId: string): Promise<LaneShareRouterSync | null> => {
    try {
      return (await deps.bootedSync(projectId)) ?? (await deps.openSync(projectId));
    } catch (error) {
      deps.logger.warn("lane_share.router_open_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  /** Open runtimes first, then the most recently opened. */
  const ordered = async (projects: readonly LaneShareRouterProject[]): Promise<LaneShareRouterProject[]> => {
    const booted = new Set<string>();
    for (const project of projects) {
      if (deps.bootedSync(project.projectId)) booted.add(project.projectId);
    }
    return [...projects].sort((left, right) => {
      const bootDelta = Number(booted.has(right.projectId)) - Number(booted.has(left.projectId));
      return bootDelta !== 0 ? bootDelta : right.lastOpenedAt - left.lastOpenedAt;
    });
  };

  return async (handoff) => {
    const projects = deps.listProjects().filter((project) => !deps.isOpenBlocked(project.projectId));
    if (handoff.redeemed) {
      const { repoKey, laneId } = handoff.redeemed.redemption;
      if (!repoKey) return false;
      const matching = await ordered(projects.filter((project) => repoKeyOf(project) === repoKey));
      for (const project of matching) {
        const sync = await syncOf(project.projectId);
        if (!sync) continue;
        if (matching.length > 1 && !sync.hasLaneShareLane(laneId)) continue;
        const adopted = sync.adoptLaneShareGuest(handoff);
        deps.logger.info("lane_share.router_routed", { redeemed: true, adopted });
        return adopted;
      }
      deps.logger.info("lane_share.router_no_project", { redeemed: true, candidates: matching.length });
      return false;
    }
    // Not redeemed: any project redeems it and routes it on when needed.
    for (const project of await ordered(projects)) {
      const sync = await syncOf(project.projectId);
      if (!sync) continue;
      const adopted = sync.adoptLaneShareGuest(handoff);
      deps.logger.info("lane_share.router_routed", { redeemed: false, adopted });
      return adopted;
    }
    deps.logger.info("lane_share.router_no_project", { redeemed: false, candidates: projects.length });
    return false;
  };
}
