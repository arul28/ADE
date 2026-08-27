import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type {
  CursorCloudAgentSummary,
  CursorCloudFleetEntry,
  CursorCloudFleetRelayState,
  CursorCloudFleetResult,
  CursorCloudFleetRunStatus,
  CursorCloudPullIntoLaneResult,
} from "../../../shared/types/config";
import type { LaneSummary } from "../../../shared/types/lanes";
import { repoMatchKey } from "../../../shared/cursorCloudRepoMatch";
import {
  CURSOR_CLOUD_FLEET_DEFAULT_AGENTS,
  CURSOR_CLOUD_FLEET_MAX_AGENTS,
  CURSOR_CLOUD_MAX_PAGE_LIMIT,
} from "../../../shared/cursorCloudApiLimits";
import type { createLaneService } from "../lanes/laneService";

export type CursorCloudIngressStatusLike = {
  state: CursorCloudFleetRelayState;
  lastEventAt: string | null;
};

type SessionLink = {
  sessionId: string;
  agentId: string;
  laneId: string;
  title: string | null;
};

type FleetServiceDeps = {
  projectRoot: string;
  logger: Logger;
  listCursorCloudAgents: (args?: {
    includeArchived?: boolean;
    limit?: number;
    cursor?: string | null;
  }) => Promise<{ items: CursorCloudAgentSummary[]; nextCursor?: string | null }>;
  listCursorCloudRuns: (args: {
    agentId: string;
    limit?: number;
  }) => Promise<{ items: Array<Record<string, unknown>> }>;
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "importBranch">;
  listCursorCloudSessionLinks: () => Promise<SessionLink[]>;
  openCursorCloudChat: (args: {
    cloudAgentId: string;
    laneId: string;
    agentName?: string | null;
  }) => Promise<{ sessionId: string }>;
  cancelCursorCloudRun: (args: { agentId: string; runId: string }) => Promise<void>;
  /** Single-agent read for agents beyond the first list page. */
  getCursorCloudAgent?: (
    agentId: string,
  ) => Promise<CursorCloudAgentSummary | null>;
  getIngressStatus: () => CursorCloudIngressStatusLike | null;
};

const ENRICH_CONCURRENCY = 4;
/** Total agent rows one fleet read walks, across as many Cursor pages as it takes. */
const FLEET_MAX_AGENTS = CURSOR_CLOUD_FLEET_MAX_AGENTS;
const FLEET_DEFAULT_AGENTS = CURSOR_CLOUD_FLEET_DEFAULT_AGENTS;
const ORIGIN_CACHE_TTL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Every pushed branch entry off a raw run record, with repo keys normalized
 * for matching. v1 nests `git.branches[]` entries of
 * `{ repoUrl, branch?, prUrl? }` (repoUrl scheme-less); older shapes expose a
 * flat `git.branch` / `git.prUrl` with no repo attribution.
 */
function readRunPushedBranches(
  run: Record<string, unknown>,
): Array<{ repoKey: string | null; branch: string; prUrl: string | null }> {
  const git = isRecord(run.git) ? run.git : {};
  const branches = Array.isArray(git.branches) ? git.branches : [];
  const out: Array<{ repoKey: string | null; branch: string; prUrl: string | null }> = [];
  for (const entry of branches) {
    if (!isRecord(entry)) continue;
    const branch = readString(entry.branch);
    if (!branch) continue;
    out.push({
      repoKey: readString(entry.repoUrl) ? repoMatchKey(readString(entry.repoUrl)) : null,
      branch,
      prUrl: readString(entry.prUrl),
    });
  }
  if (out.length === 0) {
    const flatBranch = readString(git.branch);
    if (flatBranch) {
      out.push({ repoKey: null, branch: flatBranch, prUrl: readString(git.prUrl) });
    }
  }
  return out;
}

function normalizeRunStatus(status: string | null): CursorCloudFleetRunStatus | undefined {
  const lower = status?.toLowerCase();
  if (
    lower === "creating"
    || lower === "running"
    || lower === "finished"
    || lower === "error"
    || lower === "cancelled"
    || lower === "expired"
  ) {
    return lower;
  }
  return undefined;
}

/**
 * Guard a remote-reported ref before it reaches git argv or importBranch.
 * A leading `-` would be parsed as an option by git (classic option
 * injection through argv position), and empty refs are meaningless.
 */
function safeBranchRef(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`Cursor reported an unusable branch name for this agent.`);
  }
  return trimmed;
}

export function createCursorCloudFleetService(deps: FleetServiceDeps) {
  const { projectRoot, logger } = deps;

  let originCache: { key: string; at: number } | null = null;

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
      logger.warn("cursor_cloud_fleet.origin_probe_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      originCache = { key: "", at: Date.now() };
      return "";
    }
  };

  /**
   * List agents in Cursor-sized pages until `total` rows arrive.
   *
   * Cursor rejects a page larger than 100 with a validation error, so a caller
   * that wants more rows gets several pages instead of one oversized request.
   * The loop stops at the requested total, at the last page, or at a repeated
   * cursor, so a misbehaving server can never spin it forever.
   */
  const listAgentsPaged = async (total: number): Promise<CursorCloudAgentSummary[]> => {
    const wanted = Math.max(1, Math.floor(total));
    const items: CursorCloudAgentSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    while (items.length < wanted) {
      const page = await deps.listCursorCloudAgents({
        includeArchived: true,
        limit: Math.min(wanted - items.length, CURSOR_CLOUD_MAX_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.items);
      const next = page.nextCursor?.trim() || null;
      if (!next || page.items.length === 0 || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return items.length > wanted ? items.slice(0, wanted) : items;
  };

  const buildEntries = async (args: {
    includeArchived: boolean;
    limit: number;
  }): Promise<{
    items: CursorCloudFleetEntry[];
    relayState: CursorCloudFleetRelayState;
    lastEventAt: string | null;
  }> => {
    const [originKey, links, lanes] = await Promise.all([
      originMatchKey(),
      deps.listCursorCloudSessionLinks().catch((error) => {
        logger.warn("cursor_cloud_fleet.session_links_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as SessionLink[];
      }),
      deps.laneService.list({ includeArchived: true, includeStatus: false }).catch((error) => {
        logger.warn("cursor_cloud_fleet.list_lanes_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as LaneSummary[];
      }),
    ]);

    const linkByAgentId = new Map<string, SessionLink>();
    for (const link of links) {
      if (!link.agentId) continue;
      if (!linkByAgentId.has(link.agentId)) linkByAgentId.set(link.agentId, link);
    }
    const laneById = new Map<string, LaneSummary>();
    for (const lane of lanes) {
      laneById.set(lane.id, lane);
    }

    // `limit` is a total row budget, not a page size: the crawl walks
    // Cursor-sized pages up to that budget. The budget stays bounded so a
    // refresh never turns into a long API crawl.
    const listed = await listAgentsPaged(args.limit);

    const scoped = listed
      .map((agent): { agent: CursorCloudAgentSummary; matchedBy: CursorCloudFleetEntry["matchedBy"] } | null => {
        const link = linkByAgentId.get(agent.agentId) ?? null;
        const repoHit = Boolean(originKey)
          && (agent.repos ?? []).some((repo) => repoMatchKey(repo) === originKey);
        if (!link && !repoHit) return null;
        return {
          agent,
          matchedBy: link && repoHit ? "both" : link ? "session" : "repo",
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const activeOnly = scoped.filter(({ agent }) => {
      const lower = agent.status?.toLowerCase();
      return !agent.archived && (lower === "running" || lower == null);
    });

    // Enrich only live rows with their latest run. Finished rows enrich
    // lazily when the renderer expands them, keeping one refresh to a
    // handful of bounded calls instead of one per row.
    const runsByAgentId = new Map<string, Record<string, unknown>>();
    let cursor = 0;
    const workers = Math.min(ENRICH_CONCURRENCY, Math.max(activeOnly.length, 1));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (cursor < activeOnly.length) {
          const current = activeOnly[cursor++];
          try {
            const result = await deps.listCursorCloudRuns({
              agentId: current.agent.agentId,
              limit: 1,
            });
            const latest = result.items[0];
            if (latest) runsByAgentId.set(current.agent.agentId, latest);
          } catch (error) {
            logger.warn("cursor_cloud_fleet.enrich_run_failed", {
              agentId: current.agent.agentId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    );

    const ingress = deps.getIngressStatus();
    // originKey comes from the batched probe above.
    const items: CursorCloudFleetEntry[] = scoped.map(({ agent, matchedBy }) => {
      const run = runsByAgentId.get(agent.agentId) ?? null;
      const runStatus = run ? normalizeRunStatus(readString(run.status)) : undefined;
      // Prefer a branch pushed to this project's repo so multi-repo agents
      // never advertise another repository's branch or PR on the row.
      const pushedBranches = run ? readRunPushedBranches(run) : [];
      const ours = originKey
        ? pushedBranches.filter((entry) => entry.repoKey === originKey)
        : [];
      const unattributed = pushedBranches.filter((entry) => entry.repoKey == null);
      const primary = ours[0] ?? unattributed[0] ?? null;
      const model = isRecord(run?.model) ? run.model : {};
      const link = linkByAgentId.get(agent.agentId) ?? null;
      const lane = link ? laneById.get(link.laneId) ?? null : null;
      return {
        agent,
        ...(runStatus ? { runStatus } : {}),
        latestRunId: run ? readString(run.id) ?? readString(run.runId) : null,
        branch: primary?.branch ?? null,
        prUrl: primary?.prUrl ?? null,
        modelId: readString(model.id) ?? readString(run?.modelId),
        ownership: {
          sessionId: link?.sessionId ?? null,
          sessionTitle: link?.title ?? null,
          laneId: link?.laneId ?? null,
          laneName: lane?.name ?? null,
          linearIssueId: lane?.linearIssue?.identifier ?? null,
        },
        matchedBy,
      };
    });

    const visible = args.includeArchived
      ? items
      : items.filter((entry) => !entry.agent.archived);

    return {
      items: visible,
      relayState: ingress?.state ?? "unconfigured",
      lastEventAt: ingress?.lastEventAt ?? null,
    };
  };

  const getFleet = async (args?: {
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CursorCloudFleetResult> => {
    const built = await buildEntries({
      includeArchived: args?.includeArchived !== false,
      limit: Math.min(Math.max(args?.limit ?? FLEET_DEFAULT_AGENTS, 1), FLEET_MAX_AGENTS),
    });
    return { ...built, fetchedAt: new Date().toISOString() };
  };

  /**
   * Enrich one row on demand (pull prep). Returns precise run status plus
   * every pushed branch entry (with repo keys) so callers can scope to this
   * project's repo and never have to guess. Throws on API failure so a
   * transient Cursor error never masquerades as "no pushed branch".
   */
  const getFleetEntryDetail = async (
    agentId: string,
  ): Promise<{
    runStatus?: CursorCloudFleetRunStatus;
    branches: Array<{ repoKey: string | null; branch: string; prUrl: string | null }>;
    latestRunId: string | null;
  }> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const result = await deps.listCursorCloudRuns({ agentId: id, limit: 1 });
    const latest = result.items[0];
    if (!latest) return { branches: [], latestRunId: null };
    return {
      runStatus: normalizeRunStatus(readString(latest.status)),
      branches: readRunPushedBranches(latest),
      latestRunId: readString(latest.id) ?? readString(latest.runId),
    };
  };

  const assertCleanWorktree = async (worktreePath: string, laneName: string): Promise<void> => {
    const status = await runGit(["status", "--porcelain"], {
      cwd: worktreePath,
      timeoutMs: 15_000,
    });
    if (status.exitCode !== 0) {
      throw new Error(`Could not read the worktree state for lane '${laneName}'.`);
    }
    if (status.stdout.trim()) {
      throw new Error(
        `Lane '${laneName}' has uncommitted changes. Commit or stash them before pulling a cloud branch into it.`,
      );
    }
  };

  const resolvePullTargetLane = async (args: {
    linkedLaneId: string | null;
    branch: string;
  }): Promise<{ lane: LaneSummary; created: boolean }> => {
    const lanes = await deps.laneService.list({ includeArchived: false, includeStatus: false });
    if (args.linkedLaneId) {
      const linked = lanes.find((lane) => lane.id === args.linkedLaneId);
      if (linked) return { lane: linked, created: false };
    }
    // Branch refs are case-sensitive; compare exactly (repoMatchKey is a URL
    // canonicalizer and would fold case distinctions away).
    const byBranch = lanes.find((lane) => (lane.branchRef ?? "").trim() === args.branch);
    if (byBranch) return { lane: byBranch, created: false };
    const created = await deps.laneService.importBranch({
      branchRef: args.branch,
      name: args.branch,
    });
    return { lane: created, created: true };
  };

  /**
   * Fetch one agent's summary even when it is not on the first list page.
   * Falls back to a single-agent read so pull/resolve never fail with
   * "could not be found" just because the account has many agents.
   */
  const findAgentById = async (id: string): Promise<CursorCloudAgentSummary | null> => {
    const listed = await listAgentsPaged(FLEET_MAX_AGENTS);
    const found = listed.find((entry) => entry.agentId === id);
    if (found) return found;
    if (!deps.getCursorCloudAgent) return null;
    try {
      return await deps.getCursorCloudAgent(id);
    } catch {
      return null;
    }
  };

  /**
   * Pull a finished cloud agent's pushed branch into its owning ADE lane.
   *
   * Resolution order: the linked session's lane, then any local lane already
   * on that branch, then a fresh lane imported from the remote branch. The
   * merge refuses dirty worktrees — a foreign branch never lands on top of
   * uncommitted work. Afterwards the agent's chat is opened (created/adopted)
   * inside the target lane.
   */
  const pullIntoLane = async (agentId: string): Promise<CursorCloudPullIntoLaneResult> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");

    const agent = await findAgentById(id);
    if (!agent) throw new Error("That cloud agent could not be found.");
    if (agent.archived) throw new Error("Unarchive this agent before pulling it into a lane.");

    let detail;
    try {
      detail = await getFleetEntryDetail(id);
    } catch (error) {
      throw new Error(
        `Could not read this agent's latest run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const status = detail.runStatus ?? normalizeRunStatus(agent.status ?? null);
    if (status && status !== "finished") {
      throw new Error(
        `This agent is still ${status}. Pull is available once the run finishes.`,
      );
    }
    if (detail.branches.length === 0) {
      throw new Error("This agent did not push a branch, so there is nothing to pull yet.");
    }

    // When several repos are attached, only a branch pushed to this
    // project's repo may be fetched here. Entries with no repo attribution
    // (flat v0 shape) are unambiguous in the single-repo case; entries
    // attributed to OTHER repos never fall back to a name-only fetch.
    const originKey = await originMatchKey();
    let chosen: { repoKey: string | null; branch: string; prUrl: string | null } | undefined;
    if (originKey) {
      const attributedToOthers = detail.branches.filter(
        (entry) => entry.repoKey != null && entry.repoKey !== originKey,
      );
      const ours = detail.branches.filter((entry) => entry.repoKey === originKey);
      if (ours.length > 0) {
        chosen = ours[0];
      } else if (attributedToOthers.length === detail.branches.length) {
        throw new Error(
          "This agent only pushed branches to other repositories, so there is nothing to pull into this project.",
        );
      } else {
        chosen = detail.branches.find((entry) => entry.repoKey == null);
      }
    } else {
      chosen = detail.branches[0];
    }
    if (!chosen) {
      throw new Error("This agent did not push a branch, so there is nothing to pull yet.");
    }
    const safeBranch = safeBranchRef(chosen.branch);

    const links = await deps.listCursorCloudSessionLinks();
    const link = links.find((entry) => entry.agentId === id) ?? null;

    const { lane, created } = await resolvePullTargetLane({
      linkedLaneId: link?.laneId ?? null,
      branch: safeBranch,
    });
    if (!lane.worktreeAvailable) {
      throw new Error(`Lane '${lane.name}' exists but its worktree is missing.`);
    }

    await assertCleanWorktree(lane.worktreePath, lane.name);

    const fetchResult = await runGit(["fetch", "origin", safeBranch], {
      cwd: lane.worktreePath,
      timeoutMs: 120_000,
    });
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Fetching '${safeBranch}' failed: ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`);
    }
    const mergeResult = await runGit(["merge", "--no-edit", "FETCH_HEAD"], {
      cwd: lane.worktreePath,
      timeoutMs: 120_000,
    });
    if (mergeResult.exitCode !== 0) {
      // Leave the repo as merge left it (possibly mid-conflict) but tell the
      // user precisely where things stand instead of claiming success.
      await runGit(["merge", "--abort"], {
        cwd: lane.worktreePath,
        timeoutMs: 30_000,
      }).catch(() => undefined);
      throw new Error(
        `Merging '${safeBranch}' into '${lane.branchRef}' conflicted; the merge was aborted. Resolve it manually in the lane worktree.`,
      );
    }

    let sessionId: string | null = null;
    try {
      const opened = await deps.openCursorCloudChat({
        cloudAgentId: id,
        laneId: lane.id,
        agentName: agent.name,
      });
      sessionId = opened.sessionId;
    } catch (error) {
      logger.warn("cursor_cloud_fleet.open_chat_after_pull_failed", {
        agentId: id,
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

  /**
   * Resolve (and if needed create) the ADE lane a cloud agent belongs to,
   * without touching git state. Resolution order: linked session's lane,
   * local lane already on the agent's pushed branch, fresh lane imported
   * from that remote branch. Powers Open-in-ADE for unlinked agents;
   * pull-into-lane shares this order plus the merge step.
   */
  const resolveLaneForAgent = async (
    agentId: string,
  ): Promise<{ laneId: string; laneName: string; created: boolean }> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");

    const links = await deps.listCursorCloudSessionLinks();
    const linkedLaneId = links.find((entry) => entry.agentId === id)?.laneId ?? null;
    if (linkedLaneId) {
      const lanes = await deps.laneService.list({ includeArchived: false, includeStatus: false });
      const linked = lanes.find((lane) => lane.id === linkedLaneId);
      if (linked) return { laneId: linked.id, laneName: linked.name, created: false };
    }

    let detail;
    try {
      detail = await getFleetEntryDetail(id);
    } catch (error) {
      throw new Error(
        `Could not read this agent's latest run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Same repo scoping as pullIntoLane: never import or match a lane from
    // a branch that belongs to another repository.
    const originKey = await originMatchKey();
    const ours = originKey
      ? detail.branches.filter((entry) => entry.repoKey === originKey)
      : [];
    const unattributed = detail.branches.filter((entry) => entry.repoKey == null);
    const foreignOnly = originKey != null
      && detail.branches.length > 0
      && ours.length === 0
      && unattributed.length === 0;
    if (foreignOnly) {
      throw new Error(
        "This agent only pushed branches to other repositories, so there is no lane for it in this project.",
      );
    }
    const chosen = ours[0] ?? unattributed[0];
    if (chosen) {
      const resolved = await resolvePullTargetLane({
        linkedLaneId: null,
        branch: safeBranchRef(chosen.branch),
      });
      return { laneId: resolved.lane.id, laneName: resolved.lane.name, created: resolved.created };
    }
    throw new Error(
      "This agent has no pushed branch yet, so ADE cannot tell which lane it belongs to. Pull it into a lane once it finishes.",
    );
  };

  /**
   * Stop an active run from anywhere — no ADE chat needs to exist for it.
   * Resolves the latest run and cancels it through the shared cancel path,
   * which works for agents launched from ADE or on cursor.com alike.
   */
  const stopAgentRun = async (agentId: string): Promise<{ stopped: boolean }> => {
    const id = agentId.trim();
    if (!id) throw new Error("Cursor cloud agent id is required.");
    const result = await deps.listCursorCloudRuns({ agentId: id, limit: 1 });
    const latest = result.items[0];
    const runId = latest ? readString(latest.id) ?? readString(latest.runId) : null;
    if (!runId) throw new Error("This agent has no runs to stop.");
    await deps.cancelCursorCloudRun({ agentId: id, runId });
    return { stopped: true };
  };

  return {
    getFleet,
    pullIntoLane,
    resolveLaneForAgent,
    stopAgentRun,
  };
}

export type CursorCloudFleetService = ReturnType<typeof createCursorCloudFleetService>;
