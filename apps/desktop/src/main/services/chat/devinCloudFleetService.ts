import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type {
  DevinCloudFleetEntry,
  DevinCloudFleetResult,
  DevinCloudPullIntoLaneResult,
  DevinCloudSessionSummary,
} from "../../../shared/types/config";
import type { DevinCloudListSessionsArgs } from "../ai/devinCloudClient";
import type { LaneSummary } from "../../../shared/types/lanes";
import { repoMatchKey } from "../../../shared/cursorCloudRepoMatch";
import {
  devinCloudAdeLaneId,
  devinCloudCreatedViaAde,
  devinCloudFleetStatus,
} from "../../../shared/devinCloudFleetStatus";
import type { createLaneService } from "../lanes/laneService";

type SessionLink = {
  sessionId: string;
  devinSessionId: string;
  laneId: string;
  title: string | null;
};

type FleetServiceDeps = {
  projectRoot: string;
  logger: Logger;
  /** Client-side session listing (v3 org-scoped or v1 personal-key fallback). */
  listDevinCloudSessions: (args: DevinCloudListSessionsArgs) => Promise<{
    items: DevinCloudSessionSummary[];
    endCursor: string | null;
  }>;
  /** Single-session read for ids beyond the first list page. */
  getDevinCloudSession?: (devinSessionId: string) => Promise<DevinCloudSessionSummary | null>;
  /** `user_id` of the credential's principal (`/v3/self`) — drives the "Mine" filter. */
  getDevinCloudCallerUserId?: () => Promise<string | null>;
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "importBranch">;
  /** ADE chat sessions already linked to a Devin cloud session. */
  listDevinCloudSessionLinks: () => Promise<SessionLink[]>;
  openDevinCloudChat: (args: {
    devinSessionId: string;
    laneId: string;
  }) => Promise<{ sessionId: string }>;
};

const ORIGIN_CACHE_TTL_MS = 60_000;
const FLEET_CACHE_TTL_MS = 2_000;
const PAGE_SIZE = 100;

/** `https://github.com/o/r/pull/123` → "123"; anything else → null. */
function githubPullNumber(prUrl: string | null): string | null {
  if (!prUrl) return null;
  const match = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i.exec(prUrl.trim());
  return match ? match[1] : null;
}

/** `https://github.com/o/r/pull/123` → "https://github.com/o/r"; anything else → null. */
function githubPullRepo(prUrl: string | null): string | null {
  if (!prUrl) return null;
  const match = /(github\.com\/[^/]+\/[^/]+)\/pull\/\d+/i.exec(prUrl.trim());
  return match ? `https://${match[1]}` : null;
}

/**
 * Guard a remote-reported ref before it reaches git argv or importBranch.
 * A leading `-` would be parsed as an option by git (classic option
 * injection through argv position), and empty refs are meaningless.
 */
function safeBranchRef(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`Devin reported an unusable branch name for this session.`);
  }
  return trimmed;
}

export function createDevinCloudFleetService(deps: FleetServiceDeps) {
  const { projectRoot, logger } = deps;

  let originCache: { key: string; at: number } | null = null;
  let fleetCache: { at: number; result: DevinCloudFleetResult } | null = null;

  const originMatchKey = async (): Promise<string> => {
    if (originCache && Date.now() - originCache.at < ORIGIN_CACHE_TTL_MS) {
      return originCache.key;
    }
    try {
      const result = await runGit(["remote", "get-url", "origin"], {
        cwd: projectRoot,
        timeoutMs: 8_000,
      });
      const url = result.exitCode === 0 ? result.stdout.trim() : "";
      const key = repoMatchKey(url);
      originCache = { key, at: Date.now() };
      return key;
    } catch (error) {
      logger.warn("devin_cloud_fleet.origin_probe_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      originCache = { key: "", at: Date.now() };
      return "";
    }
  };

  /** Local branch name ADE creates for a Devin session's pushed PR head. */
  const devinBranchFor = (sessionId: string): string =>
    `devin/${sessionId.trim().slice(0, 12).toLowerCase()}`;

  const buildEntries = async (includeArchived: boolean): Promise<DevinCloudFleetEntry[]> => {
    const [originKey, links, lanes] = await Promise.all([
      originMatchKey(),
      deps.listDevinCloudSessionLinks().catch((error) => {
        logger.warn("devin_cloud_fleet.session_links_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as SessionLink[];
      }),
      deps.laneService.list({ includeArchived: true, includeStatus: false }).catch((error) => {
        logger.warn("devin_cloud_fleet.list_lanes_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as LaneSummary[];
      }),
    ]);

    const linkByDevinId = new Map<string, SessionLink>();
    for (const link of links) {
      if (!link.devinSessionId) continue;
      if (!linkByDevinId.has(link.devinSessionId)) linkByDevinId.set(link.devinSessionId, link);
    }
    const laneById = new Map<string, LaneSummary>();
    for (const lane of lanes) {
      laneById.set(lane.id, lane);
    }

    // Consume every cursor page so a long-lived fleet does not silently drop
    // older sessions. v1 lists use the offset string as the cursor.
    const listedItems: DevinCloudSessionSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await deps.listDevinCloudSessions({
        first: PAGE_SIZE,
        ...(includeArchived ? {} : { isArchived: false }),
        ...(cursor ? { after: cursor } : {}),
      });
      listedItems.push(...page.items);
      const next = page.endCursor?.trim() ?? "";
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    } while (true);

    const callerUserId = deps.getDevinCloudCallerUserId
      ? await deps.getDevinCloudCallerUserId().catch(() => null)
      : null;

    return listedItems.map((session): DevinCloudFleetEntry => {
      const link = linkByDevinId.get(session.sessionId) ?? null;
      const laneIdFromTag = devinCloudAdeLaneId(session.tags);
      const lane =
        (link ? laneById.get(link.laneId) : undefined)
        ?? (laneIdFromTag ? laneById.get(laneIdFromTag) : undefined)
        ?? null;
      const repoHit =
        Boolean(originKey)
        && (session.repos ?? []).some((repo) => repoMatchKey(repo) === originKey);
      const createdViaAde = devinCloudCreatedViaAde(session.tags) || Boolean(link);
      const matchedBy: DevinCloudFleetEntry["matchedBy"] = link
        ? "session"
        : createdViaAde || laneIdFromTag
          ? "tag"
          : repoHit
            ? "repo"
            : "org";
      return {
        session,
        fleetStatus: devinCloudFleetStatus(session),
        prUrl: session.pullRequests[0]?.prUrl ?? null,
        ownership: {
          sessionId: link?.sessionId ?? null,
          sessionTitle: link?.title ?? null,
          laneId: lane?.id ?? null,
          laneName: lane?.name ?? null,
          linearIssueId: lane?.linearIssue?.identifier ?? null,
        },
        createdViaAde,
        adeLaneId: laneIdFromTag,
        matchedBy,
        isMine: Boolean(callerUserId && session.userId && session.userId === callerUserId),
      };
    });
  };

  const getFleet = async (args?: { force?: boolean; includeArchived?: boolean }): Promise<DevinCloudFleetResult> => {
    const includeArchived = args?.includeArchived === true;
    if (!args?.force && !includeArchived && fleetCache && Date.now() - fleetCache.at < FLEET_CACHE_TTL_MS) {
      return fleetCache.result;
    }
    const items = await buildEntries(includeArchived);
    const result: DevinCloudFleetResult = { items, fetchedAt: new Date().toISOString() };
    if (!includeArchived) {
      fleetCache = { at: Date.now(), result };
    }
    return result;
  };

  const findSessionById = async (id: string): Promise<DevinCloudSessionSummary | null> => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await deps.listDevinCloudSessions({
        first: PAGE_SIZE,
        isArchived: false,
        ...(cursor ? { after: cursor } : {}),
      });
      const found = page.items.find((entry) => entry.sessionId === id);
      if (found) return found;
      const next = page.endCursor?.trim() ?? "";
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    } while (true);
    if (!deps.getDevinCloudSession) return null;
    try {
      return await deps.getDevinCloudSession(id);
    } catch {
      return null;
    }
  };

  const findPullTargetLane = async (args: {
    linkedLaneId: string | null;
    branch: string;
  }): Promise<LaneSummary | null> => {
    const lanes = await deps.laneService.list({ includeArchived: false, includeStatus: false });
    if (args.linkedLaneId) {
      const linked = lanes.find((lane) => lane.id === args.linkedLaneId);
      if (linked) return linked;
    }
    return lanes.find((lane) => (lane.branchRef ?? "").trim() === args.branch) ?? null;
  };

  const assertCleanWorktree = async (worktreePath: string, laneName: string): Promise<void> => {
    const status = await runGit(["status", "--porcelain"], {
      cwd: worktreePath,
      timeoutMs: 10_000,
    });
    if (status.exitCode !== 0) {
      throw new Error(`Could not read the worktree state for lane '${laneName}'.`);
    }
    if (status.stdout.trim()) {
      throw new Error(
        `Lane '${laneName}' has uncommitted changes. Commit or stash them before pulling a Devin branch into it.`,
      );
    }
  };

  /**
   * Fetch a Devin session's PR head into a lane.
   *
   * Devin's API exposes `pull_requests[].pr_url` but never a branch name, so
   * the branch arrives as a GitHub `refs/pull/<n>/head` fetch. The fetch has
   * to come first either way: for a new lane it materializes
   * `refs/heads/devin/<id>` so `importBranch` has a real ref to check out,
   * and for an existing lane it lands on that lane's own FETCH_HEAD (each
   * worktree keeps its own) before the dirty-worktree-guarded merge.
   */
  const pullIntoLane = async (devinSessionId: string): Promise<DevinCloudPullIntoLaneResult> => {
    const id = devinSessionId.trim();
    if (!id) throw new Error("Devin cloud session id is required.");

    const session = await findSessionById(id);
    if (!session) throw new Error("Could not find this Devin session in your org.");
    if (session.isArchived) throw new Error("Unarchive this session before pulling it into a lane.");

    const prUrl = session.pullRequests[0]?.prUrl ?? null;
    const prNumber = githubPullNumber(prUrl);
    if (!prNumber) {
      throw new Error(
        "This session has not opened a GitHub pull request yet, so there is nothing to pull.",
      );
    }

    // PR numbers are repo-local and the fleet is org-wide: a session from a
    // different repository must not merge this project's same-numbered PR.
    const prRepoKey = repoMatchKey(githubPullRepo(prUrl));
    const projectRepoKey = await originMatchKey();
    if (!prRepoKey || !projectRepoKey || prRepoKey !== projectRepoKey) {
      throw new Error("This session's pull request is not for this project's repository.");
    }

    const links = await deps.listDevinCloudSessionLinks().catch(() => [] as SessionLink[]);
    const link = links.find((entry) => entry.devinSessionId === id) ?? null;
    const laneIdFromTag = devinCloudAdeLaneId(session.tags);
    const safeBranch = safeBranchRef(devinBranchFor(id));

    let lane = await findPullTargetLane({
      linkedLaneId: link?.laneId ?? laneIdFromTag,
      branch: safeBranch,
    });
    let created = false;

    if (!lane) {
      // Materialize the PR head as a local branch first — importBranch only
      // resolves refs that already exist.
      const fetchResult = await runGit(
        ["fetch", "origin", `+refs/pull/${prNumber}/head:refs/heads/${safeBranch}`],
        { cwd: projectRoot, timeoutMs: 60_000 },
      );
      if (fetchResult.exitCode !== 0) {
        throw new Error(
          `Could not fetch the session's PR head (refs/pull/${prNumber}/head): ${fetchResult.stderr.trim() || "fetch failed"}`,
        );
      }
      try {
        lane = await deps.laneService.importBranch({
          branchRef: safeBranch,
          name: safeBranch,
        });
        created = true;
      } catch (error) {
        await runGit(["update-ref", "-d", `refs/heads/${safeBranch}`], {
          cwd: projectRoot,
          timeoutMs: 15_000,
        }).catch(() => undefined);
        throw error;
      }
    } else {
      await assertCleanWorktree(lane.worktreePath, lane.name);

      const fetchResult = await runGit(
        ["fetch", "origin", `+refs/pull/${prNumber}/head`],
        { cwd: lane.worktreePath, timeoutMs: 60_000 },
      );
      if (fetchResult.exitCode !== 0) {
        throw new Error(
          `Could not fetch the session's PR head (refs/pull/${prNumber}/head): ${fetchResult.stderr.trim() || "fetch failed"}`,
        );
      }

      const mergeResult = await runGit(["merge", "--no-edit", "FETCH_HEAD"], {
        cwd: lane.worktreePath,
        timeoutMs: 60_000,
      });
      if (mergeResult.exitCode !== 0) {
        await runGit(["merge", "--abort"], {
          cwd: lane.worktreePath,
          timeoutMs: 30_000,
        }).catch(() => undefined);
        throw new Error(
          `Merging the session's PR head into '${lane.branchRef}' conflicted; the merge was aborted. Resolve it manually in the lane worktree.`,
        );
      }
    }

    let sessionId: string | null = null;
    try {
      const opened = await deps.openDevinCloudChat({
        devinSessionId: id,
        laneId: lane.id,
      });
      sessionId = opened.sessionId;
    } catch (error) {
      logger.warn("devin_cloud_fleet.open_chat_after_pull_failed", {
        devinSessionId: id,
        laneId: lane.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      status: created ? "created_lane" : "pulled",
      laneId: lane.id,
      laneName: lane.name,
      sessionId,
      mergedBranch: safeBranch,
    };
  };

  const invalidateCache = (): void => {
    fleetCache = null;
  };

  return {
    getFleet,
    pullIntoLane,
    findSessionById,
    invalidateCache,
  };
}

export type DevinCloudFleetService = ReturnType<typeof createDevinCloudFleetService>;
