import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import { runGit, runGitOrThrow } from "../git/git";
import type { createOperationService } from "../history/operationService";
import type {
  AttachLaneArgs,
  CreateChildLaneArgs,
  CreateLaneArgs,
  DeleteLaneArgs,
  LaneIcon,
  LaneStatus,
  LaneSummary,
  LaneType,
  ListLanesArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RebaseAbortArgs,
  RebaseRun,
  RebaseRunEventPayload,
  RebaseRunLane,
  RebaseRollbackArgs,
  RebaseScope,
  RebaseStartArgs,
  RebaseStartResult,
  RebasePushArgs,
  PushMode,
  StackChainItem,
  UpdateLaneAppearanceArgs
} from "../../../shared/types";

type LaneRow = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  lane_type: LaneType;
  base_ref: string;
  branch_ref: string;
  worktree_path: string;
  attached_root_path: string | null;
  is_edit_protected: number;
  parent_lane_id: string | null;
  color: string | null;
  icon: string | null;
  tags_json: string | null;
  folder: string | null;
  created_at: string;
  archived_at: string | null;
  status: string;
};

const DEFAULT_LANE_STATUS: LaneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
const LANE_LIST_CACHE_TTL_MS = 10_000;

function cloneLaneStatus(status: LaneStatus): LaneStatus {
  return {
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    remoteBehind: status.remoteBehind
  };
}

function cloneLaneSummary(summary: LaneSummary): LaneSummary {
  return {
    ...summary,
    status: cloneLaneStatus(summary.status),
    parentStatus: summary.parentStatus ? cloneLaneStatus(summary.parentStatus) : null,
    tags: [...summary.tags]
  };
}

function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length ? s : "lane";
}

function normAbs(p: string): string {
  return path.resolve(p);
}

function parseLaneIcon(value: string | null): LaneIcon {
  if (!value) return null;
  if (value === "star" || value === "flag" || value === "bolt" || value === "shield" || value === "tag") {
    return value;
  }
  return null;
}

function parseLaneTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 24);
  } catch {
    return [];
  }
}

function toLaneSummary(args: {
  row: LaneRow;
  status: LaneStatus;
  parentStatus: LaneStatus | null;
  childCount: number;
  stackDepth: number;
}): LaneSummary {
  const { row, status, parentStatus, childCount, stackDepth } = args;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    laneType: row.lane_type,
    baseRef: row.base_ref,
    branchRef: row.branch_ref,
    worktreePath: row.worktree_path,
    attachedRootPath: row.attached_root_path,
    parentLaneId: row.parent_lane_id,
    childCount,
    stackDepth,
    parentStatus,
    isEditProtected: row.is_edit_protected === 1,
    status,
    color: row.color,
    icon: parseLaneIcon(row.icon),
    tags: parseLaneTags(row.tags_json),
    folder: row.folder,
    createdAt: row.created_at,
    archivedAt: row.archived_at
  };
}

async function detectBranchRef(worktreePath: string, fallback: string): Promise<string> {
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (branchRes.exitCode === 0) {
    const value = branchRes.stdout.trim();
    if (value && value !== "HEAD") return value;
  }
  return fallback;
}

async function getHeadSha(worktreePath: string): Promise<string | null> {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (head.exitCode !== 0) return null;
  const sha = head.stdout.trim();
  return sha.length ? sha : null;
}

async function computeLaneStatus(worktreePath: string, baseRef: string, branchRef: string): Promise<LaneStatus> {
  const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8_000 });
  const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;

  const countsRes = await runGit(["rev-list", "--left-right", "--count", `${baseRef}...${branchRef}`], {
    cwd: worktreePath,
    timeoutMs: 8_000
  });
  let behind = 0;
  let ahead = 0;
  if (countsRes.exitCode === 0) {
    const parts = countsRes.stdout.trim().split(/\s+/).filter(Boolean);
    const left = Number(parts[0] ?? 0);
    const right = Number(parts[1] ?? 0);
    behind = Number.isFinite(left) ? left : 0;
    ahead = Number.isFinite(right) ? right : 0;
  }

  // Check how far behind the remote tracking branch we are
  let remoteBehind = -1; // -1 = no upstream configured
  const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd: worktreePath,
    timeoutMs: 5_000
  });
  if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim()) {
    const behindRes = await runGit(["rev-list", "HEAD..@{upstream}", "--count"], {
      cwd: worktreePath,
      timeoutMs: 5_000
    });
    if (behindRes.exitCode === 0) {
      const count = parseInt(behindRes.stdout.trim(), 10);
      remoteBehind = Number.isFinite(count) ? count : 0;
    }
  }

  return { dirty, ahead, behind, remoteBehind };
}

function computeStackDepth(args: {
  laneId: string;
  rowsById: Map<string, LaneRow>;
  memo: Map<string, number>;
  visiting?: Set<string>;
}): number {
  const { laneId, rowsById, memo } = args;
  const visiting = args.visiting ?? new Set<string>();
  const cached = memo.get(laneId);
  if (cached != null) return cached;
  if (visiting.has(laneId)) return 0;
  visiting.add(laneId);
  const row = rowsById.get(laneId);
  let depth = 0;
  if (row?.parent_lane_id) {
    depth = 1 + computeStackDepth({ laneId: row.parent_lane_id, rowsById, memo, visiting });
  }
  memo.set(laneId, depth);
  visiting.delete(laneId);
  return depth;
}

function sortByCreatedAtAsc(rows: LaneRow[]): LaneRow[] {
  return [...rows].sort((a, b) => {
    const aTs = Date.parse(a.created_at);
    const bTs = Date.parse(b.created_at);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  });
}

function collectDepthFirstIds(args: {
  rootLaneId: string;
  childrenByParent: Map<string, LaneRow[]>;
  includeSelf: boolean;
}): string[] {
  const out: string[] = [];
  const visit = (laneId: string) => {
    out.push(laneId);
    for (const child of args.childrenByParent.get(laneId) ?? []) {
      visit(child.id);
    }
  };
  visit(args.rootLaneId);
  return args.includeSelf ? out : out.slice(1);
}

export function createLaneService({
  db,
  projectRoot,
  projectId,
  defaultBaseRef,
  worktreesDir,
  operationService,
  onHeadChanged,
  onRebaseEvent
}: {
  db: AdeDb;
  projectRoot: string;
  projectId: string;
  defaultBaseRef: string;
  worktreesDir: string;
  operationService?: ReturnType<typeof createOperationService>;
  onHeadChanged?: (args: { laneId: string; reason: string; preHeadSha: string | null; postHeadSha: string | null }) => void;
  onRebaseEvent?: (event: RebaseRunEventPayload) => void;
}) {
  const getLaneRow = (laneId: string) =>
    db.get<LaneRow>("select * from lanes where id = ? and project_id = ? limit 1", [laneId, projectId]);

  const getAllLaneRows = (includeArchived = false) =>
    db.all<LaneRow>(
      includeArchived
        ? "select * from lanes where project_id = ? order by created_at desc"
        : "select * from lanes where project_id = ? and status != 'archived' order by created_at desc",
      [projectId]
    );

  const getChildrenRows = (laneId: string, includeArchived = false) =>
    db.all<LaneRow>(
      includeArchived
        ? "select * from lanes where project_id = ? and parent_lane_id = ? order by created_at asc"
        : "select * from lanes where project_id = ? and parent_lane_id = ? and status != 'archived' order by created_at asc",
      [projectId, laneId]
    );

  const laneListCache = new Map<string, { expiresAt: number; rows: LaneSummary[] }>();
  const rebaseRuns = new Map<string, RebaseRun>();

  const invalidateLaneListCache = (): void => {
    laneListCache.clear();
  };

  const cloneRebaseRunLane = (lane: RebaseRunLane): RebaseRunLane => ({
    ...lane,
    conflictingFiles: [...lane.conflictingFiles]
  });

  const cloneRebaseRun = (run: RebaseRun): RebaseRun => ({
    ...run,
    lanes: run.lanes.map(cloneRebaseRunLane),
    pushedLaneIds: [...run.pushedLaneIds]
  });

  const emitRebaseEventSafe = (event: RebaseRunEventPayload): void => {
    if (!onRebaseEvent) return;
    try {
      onRebaseEvent(event);
    } catch {
      // Avoid surfacing event callback failures to callers.
    }
  };

  const emitRunUpdated = (run: RebaseRun): void => {
    emitRebaseEventSafe({
      type: "rebase-run-updated",
      run: cloneRebaseRun(run),
      timestamp: new Date().toISOString()
    });
  };

  const emitRunLog = (args: { runId: string; laneId?: string | null; message: string }): void => {
    emitRebaseEventSafe({
      type: "rebase-run-log",
      runId: args.runId,
      laneId: args.laneId ?? null,
      message: args.message,
      timestamp: new Date().toISOString()
    });
  };

  const parseConflictingFiles = (stdout: string): string[] =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  const resolveRebaseOrder = (args: { rootLaneId: string; scope: RebaseScope }): string[] => {
    const activeRows = getAllLaneRows(false);
    const childrenByParent = new Map<string, LaneRow[]>();
    for (const row of activeRows) {
      if (!row.parent_lane_id) continue;
      const arr = childrenByParent.get(row.parent_lane_id) ?? [];
      arr.push(row);
      childrenByParent.set(row.parent_lane_id, arr);
    }
    for (const [parentId, children] of childrenByParent.entries()) {
      childrenByParent.set(parentId, sortByCreatedAtAsc(children));
    }

    return args.scope === "lane_and_descendants"
      ? collectDepthFirstIds({ rootLaneId: args.rootLaneId, childrenByParent, includeSelf: true })
      : [args.rootLaneId];
  };

  const getStoredRebaseRun = (runId: string): RebaseRun => {
    const run = rebaseRuns.get(runId);
    if (!run) throw new Error(`Rebase run not found: ${runId}`);
    return run;
  };

  const ensureSameRepo = async (candidatePath: string) => {
    const resolvedProject = normAbs(projectRoot);
    const repoTop = (await runGitOrThrow(["rev-parse", "--show-toplevel"], { cwd: candidatePath, timeoutMs: 10_000 })).trim();
    if (normAbs(repoTop) !== resolvedProject) {
      throw new Error("Attached lane path must belong to the current project repository");
    }
  };

  const ensurePrimaryLane = async (): Promise<void> => {
    const existing = db.get<{ id: string }>(
      "select id from lanes where project_id = ? and lane_type = 'primary' limit 1",
      [projectId]
    );
    if (existing?.id) return;

    const laneId = randomUUID();
    const now = new Date().toISOString();
    const branchRef = await detectBranchRef(projectRoot, defaultBaseRef);
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'primary', ?, ?, ?, null, 1, null, null, null, null, 'active', ?, null)
      `,
      [laneId, projectId, "Primary", "Main repository workspace", defaultBaseRef, branchRef, projectRoot, now]
    );
    invalidateLaneListCache();
  };

  const syncPrimaryLaneBranchRef = async (): Promise<void> => {
    const primary = db.get<{
      id: string;
      worktree_path: string;
      base_ref: string;
      branch_ref: string;
    }>(
      `
        select id, worktree_path, base_ref, branch_ref
        from lanes
        where project_id = ? and lane_type = 'primary' and status != 'archived'
        limit 1
      `,
      [projectId]
    );
    if (!primary) return;

    const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: primary.worktree_path,
      timeoutMs: 8_000
    });
    if (branchRes.exitCode !== 0) return;
    const detectedBranchRef = branchRes.stdout.trim();
    if (!detectedBranchRef || detectedBranchRef === "HEAD" || detectedBranchRef === primary.branch_ref) return;

    db.run(
      "update lanes set branch_ref = ? where id = ? and project_id = ?",
      [detectedBranchRef, primary.id, projectId]
    );
    invalidateLaneListCache();
  };

  const listLanes = async ({
    includeArchived = false,
    includeStatus = true
  }: ListLanesArgs = {}): Promise<LaneSummary[]> => {
    const cacheKey = `arch:${includeArchived ? 1 : 0}|status:${includeStatus ? 1 : 0}`;
    const cached = laneListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.rows.map(cloneLaneSummary);
    }

    // Best-effort primary lane bootstrap -- failures should not block listing.
    try {
      await ensurePrimaryLane();
    } catch (err) {
      console.warn("[laneService] ensurePrimaryLane failed, continuing with existing lanes:", err instanceof Error ? err.message : String(err));
    }
    try {
      await syncPrimaryLaneBranchRef();
    } catch (err) {
      console.warn("[laneService] syncPrimaryLaneBranchRef failed, continuing:", err instanceof Error ? err.message : String(err));
    }

    const rows = getAllLaneRows(includeArchived);
    const contextRows = getAllLaneRows(true);
    const activeRows = contextRows.filter((row) => row.status !== "archived");
    const rowsById = new Map(contextRows.map((row) => [row.id, row] as const));
    const depthMemo = new Map<string, number>();
    const statusCache = new Map<string, LaneStatus>();
    const childCountMap = new Map<string, number>();

    for (const row of activeRows) {
      if (!row.parent_lane_id) continue;
      childCountMap.set(row.parent_lane_id, (childCountMap.get(row.parent_lane_id) ?? 0) + 1);
    }

    const resolveStatus = async (laneId: string): Promise<LaneStatus> => {
      const cached = statusCache.get(laneId);
      if (cached) return cached;
      const row = rowsById.get(laneId);
      if (!row) return DEFAULT_LANE_STATUS;
      const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
      let baseRef = parent?.branch_ref ?? row.base_ref;

      // For primary lanes with no parent, compare against the upstream tracking ref
      // instead of base_ref (which equals branchRef, giving 0 behind).
      if (!parent && row.lane_type === "primary") {
        const upstreamRes = await runGit(
          ["rev-parse", "--verify", `${row.branch_ref}@{upstream}`],
          { cwd: row.worktree_path, timeoutMs: 5_000 }
        );
        if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim()) {
          baseRef = upstreamRes.stdout.trim();
        } else {
          // Fallback: try origin/<branch>
          const originRes = await runGit(
            ["rev-parse", "--verify", `origin/${row.branch_ref}`],
            { cwd: row.worktree_path, timeoutMs: 5_000 }
          );
          if (originRes.exitCode === 0 && originRes.stdout.trim()) {
            baseRef = originRes.stdout.trim();
          }
          // else: keep row.base_ref as final fallback
        }
      }

      const status = await computeLaneStatus(row.worktree_path, baseRef, row.branch_ref);
      statusCache.set(laneId, status);
      return status;
    };

    const out: LaneSummary[] = [];
    for (const row of rows) {
      try {
        let status: LaneStatus = cloneLaneStatus(DEFAULT_LANE_STATUS);
        let parentStatus: LaneStatus | null = row.parent_lane_id ? cloneLaneStatus(DEFAULT_LANE_STATUS) : null;

        if (includeStatus) {
          try {
            status = await resolveStatus(row.id);
          } catch {
            console.warn(`[laneService] resolveStatus failed for lane ${row.id}, using default`);
            status = cloneLaneStatus(DEFAULT_LANE_STATUS);
          }
          if (row.parent_lane_id) {
            try {
              parentStatus = await resolveStatus(row.parent_lane_id);
            } catch {
              console.warn(`[laneService] resolveStatus failed for parent lane ${row.parent_lane_id}, using default`);
              parentStatus = cloneLaneStatus(DEFAULT_LANE_STATUS);
            }
          }
        }

        let stackDepth = 0;
        try {
          stackDepth = computeStackDepth({ laneId: row.id, rowsById, memo: depthMemo });
        } catch {
          console.warn(`[laneService] computeStackDepth failed for lane ${row.id}, defaulting to 0`);
        }
        out.push(
          toLaneSummary({
            row,
            status,
            parentStatus,
            childCount: childCountMap.get(row.id) ?? 0,
            stackDepth
          })
        );
      } catch (err) {
        // If building the summary for a single lane fails entirely, skip it
        // rather than crashing the whole list operation.
        console.warn(`[laneService] Failed to build summary for lane ${row.id}, skipping:`, err instanceof Error ? err.message : String(err));
      }
    }
    laneListCache.set(cacheKey, {
      expiresAt: Date.now() + LANE_LIST_CACHE_TTL_MS,
      rows: out.map(cloneLaneSummary)
    });
    return out;
  };

  const createWorktreeLane = async (args: {
    name: string;
    description?: string;
    baseRef: string;
    startPoint: string;
    parentLaneId: string | null;
    folder?: string;
  }): Promise<LaneSummary> => {
    const laneId = randomUUID();
    const now = new Date().toISOString();
    const slug = slugify(args.name);
    const suffix = laneId.slice(0, 8);
    const branchRef = `ade/${slug}-${suffix}`;
    const worktreePath = path.join(worktreesDir, `${slug}-${suffix}`);

    await runGitOrThrow(["worktree", "add", "-b", branchRef, worktreePath, args.startPoint], {
      cwd: projectRoot,
      timeoutMs: 60_000
    });

    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, null, null, null, ?, 'active', ?, null)
      `,
      [laneId, projectId, args.name, args.description ?? null, args.baseRef, branchRef, worktreePath, args.parentLaneId, args.folder ?? null, now]
    );
    invalidateLaneListCache();

    const row = getLaneRow(laneId);
    if (!row) throw new Error(`Failed to create lane: ${laneId}`);
    const rowsById = new Map(getAllLaneRows(true).map((entry) => [entry.id, entry] as const));
    const status = await computeLaneStatus(worktreePath, args.baseRef, branchRef);
    const parentStatus = args.parentLaneId
      ? await (async () => {
        const parentId = args.parentLaneId;
        if (!parentId) return null;
        const parent = rowsById.get(parentId);
        if (!parent) return null;
        const grandParent = parent.parent_lane_id ? rowsById.get(parent.parent_lane_id) : null;
        return await computeLaneStatus(parent.worktree_path, grandParent?.branch_ref ?? parent.base_ref, parent.branch_ref);
      })()
      : null;

    return toLaneSummary({
      row,
      status,
      parentStatus,
      childCount: 0,
      stackDepth: computeStackDepth({ laneId: laneId, rowsById, memo: new Map() })
    });
  };

  const getRowsById = (includeArchived = true): Map<string, LaneRow> =>
    new Map(getAllLaneRows(includeArchived).map((row) => [row.id, row] as const));

  const isDescendant = (rowsById: Map<string, LaneRow>, laneId: string, possibleDescendantId: string): boolean => {
    const queue = [laneId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === possibleDescendantId) return true;
      for (const row of rowsById.values()) {
        if (row.parent_lane_id === current) queue.push(row.id);
      }
    }
    return false;
  };

  return {
    async ensurePrimaryLane(): Promise<void> {
      await ensurePrimaryLane();
    },

    async list(args: ListLanesArgs = {}): Promise<LaneSummary[]> {
      return await listLanes(args);
    },

    invalidateListCache(): void {
      invalidateLaneListCache();
    },

    async create({ name, description, parentLaneId }: CreateLaneArgs): Promise<LaneSummary> {
      if (parentLaneId) {
        const parent = getLaneRow(parentLaneId);
        if (!parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
        if (parent.status === "archived") throw new Error("Parent lane is archived");

        // If parent is the primary lane, ensure it's in sync with remote.
        if (parent.lane_type === "primary") {
          await runGitOrThrow(["fetch", "--prune"], { cwd: parent.worktree_path, timeoutMs: 60_000 });
          const upstreamRes = await runGit(["rev-parse", "@{upstream}"], { cwd: parent.worktree_path, timeoutMs: 10_000 });
          if (upstreamRes.exitCode === 0) {
            const behindRes = await runGit(["rev-list", "HEAD..@{upstream}", "--count"], {
              cwd: parent.worktree_path,
              timeoutMs: 10_000
            });
            if (behindRes.exitCode === 0) {
              const behindCount = parseInt(behindRes.stdout.trim(), 10);
              if (behindCount > 0) {
                throw new Error(
                  `Primary branch is behind remote by ${behindCount} commit(s). Pull/sync before creating a new lane.`
                );
              }
            }
          }
        }

        const parentHeadSha = await getHeadSha(parent.worktree_path);
        if (!parentHeadSha) throw new Error(`Unable to resolve parent HEAD for lane ${parent.name}`);
        return await createWorktreeLane({
          name,
          description,
          baseRef: parent.branch_ref,
          startPoint: parentHeadSha,
          parentLaneId: parent.id
        });
      }

      // No parent specified: branch from defaultBaseRef. Resolve the exact SHA to avoid stale refs.
      const headRes = await runGit(["rev-parse", defaultBaseRef], { cwd: projectRoot, timeoutMs: 10_000 });
      const startPoint = headRes.exitCode === 0 && headRes.stdout.trim().length
        ? headRes.stdout.trim()
        : defaultBaseRef;

      return await createWorktreeLane({
        name,
        description,
        baseRef: defaultBaseRef,
        startPoint,
        parentLaneId: null
      });
    },

    async createChild(args: CreateChildLaneArgs): Promise<LaneSummary> {
      const parent = getLaneRow(args.parentLaneId);
      if (!parent) throw new Error(`Parent lane not found: ${args.parentLaneId}`);
      if (parent.status === "archived") throw new Error("Parent lane is archived");

      // If parent is the primary lane, ensure it's in sync with remote.
      if (parent.lane_type === "primary") {
        await runGitOrThrow(["fetch", "--prune"], { cwd: parent.worktree_path, timeoutMs: 60_000 });
        const upstreamRes = await runGit(["rev-parse", "@{upstream}"], { cwd: parent.worktree_path, timeoutMs: 10_000 });
        if (upstreamRes.exitCode === 0) {
          const behindRes = await runGit(["rev-list", "HEAD..@{upstream}", "--count"], {
            cwd: parent.worktree_path,
            timeoutMs: 10_000
          });
          if (behindRes.exitCode === 0) {
            const behindCount = parseInt(behindRes.stdout.trim(), 10);
            if (behindCount > 0) {
              throw new Error(
                `Primary branch is behind remote by ${behindCount} commit(s). Pull/sync before creating a new lane.`
              );
            }
          }
        }
      }

      const parentHeadSha = await getHeadSha(parent.worktree_path);
      if (!parentHeadSha) throw new Error(`Unable to resolve parent HEAD for lane ${parent.name}`);
      return await createWorktreeLane({
        name: args.name,
        description: args.description,
        baseRef: parent.branch_ref,
        startPoint: parentHeadSha,
        parentLaneId: parent.id,
        folder: args.folder
      });
    },

    async importBranch(args: { branchRef: string; name?: string; description?: string; parentLaneId?: string | null }): Promise<LaneSummary> {
      const branchRef = (args.branchRef ?? "").trim();
      if (!branchRef) throw new Error("branchRef is required");
      if (branchRef.includes("\0")) throw new Error("Invalid branchRef");

      // Ensure branch exists locally.
      await runGitOrThrow(["rev-parse", "--verify", branchRef], { cwd: projectRoot, timeoutMs: 12_000 });

      // Prevent duplicates.
      const existing = db.get<{ id: string }>(
        "select id from lanes where project_id = ? and branch_ref = ? limit 1",
        [projectId, branchRef]
      );
      if (existing?.id) {
        throw new Error(`Lane already exists for branch '${branchRef}'`);
      }

      const laneId = randomUUID();
      const now = new Date().toISOString();
      const displayName = (args.name ?? "").trim() || branchRef;
      const slug = slugify(displayName);
      const suffix = laneId.slice(0, 8);
      const worktreePath = path.join(worktreesDir, `${slug}-${suffix}`);

      // Attaching an existing branch: do NOT create a new branch, just add a worktree checkout.
      await runGitOrThrow(["worktree", "add", worktreePath, branchRef], {
        cwd: projectRoot,
        timeoutMs: 60_000
      });

      const parentLaneIdRaw = typeof args.parentLaneId === "string" ? args.parentLaneId.trim() : "";
      const parentLaneId = parentLaneIdRaw.length ? parentLaneIdRaw : null;
      const parent = parentLaneId ? getLaneRow(parentLaneId) : null;
      if (parentLaneId && !parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
      if (parent && parent.status === "archived") throw new Error("Parent lane is archived");

      const baseRef = parent?.branch_ref ?? defaultBaseRef;

      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          )
          values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, null, null, null, 'active', ?, null)
        `,
        [laneId, projectId, displayName, args.description ?? null, baseRef, branchRef, worktreePath, parentLaneId, now]
      );
      invalidateLaneListCache();

      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Failed to import lane: ${laneId}`);
      const rowsById = getRowsById(true);
      const status = await computeLaneStatus(worktreePath, baseRef, branchRef);
      const parentStatus = parent ? await computeLaneStatus(parent.worktree_path, parent.base_ref, parent.branch_ref) : null;

      if (onHeadChanged) {
        try {
          const postHeadSha = await getHeadSha(worktreePath);
          onHeadChanged({
            laneId,
            reason: "import_branch",
            preHeadSha: null,
            postHeadSha
          });
        } catch {
          // ignore
        }
      }

      return toLaneSummary({
        row,
        status,
        parentStatus,
        childCount: 0,
        stackDepth: computeStackDepth({ laneId, rowsById, memo: new Map() })
      });
    },

    async getChildren(laneId: string): Promise<LaneSummary[]> {
      // Query only children rows directly instead of fetching and filtering all lanes.
      const childRows = getChildrenRows(laneId, false);
      if (childRows.length === 0) return [];

      const allRows = getAllLaneRows(true);
      const rowsById = new Map(allRows.map((row) => [row.id, row] as const));
      const activeRows = allRows.filter((row) => row.status !== "archived");
      const depthMemo = new Map<string, number>();

      // Count children of each child (grandchildren count)
      const childCountMap = new Map<string, number>();
      for (const row of activeRows) {
        if (!row.parent_lane_id) continue;
        childCountMap.set(row.parent_lane_id, (childCountMap.get(row.parent_lane_id) ?? 0) + 1);
      }

      // Resolve parent status for all children (they share the same parent)
      const parentRow = rowsById.get(laneId);
      let parentStatus: LaneStatus | null = null;
      if (parentRow) {
        const grandParent = parentRow.parent_lane_id ? rowsById.get(parentRow.parent_lane_id) : null;
        try {
          parentStatus = await computeLaneStatus(
            parentRow.worktree_path,
            grandParent?.branch_ref ?? parentRow.base_ref,
            parentRow.branch_ref
          );
        } catch {
          parentStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
        }
      }

      const defaultStatus: LaneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
      const out: LaneSummary[] = [];
      for (const row of childRows) {
        let status: LaneStatus;
        try {
          const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
          status = await computeLaneStatus(
            row.worktree_path,
            parent?.branch_ref ?? row.base_ref,
            row.branch_ref
          );
        } catch {
          status = defaultStatus;
        }
        out.push(
          toLaneSummary({
            row,
            status,
            parentStatus,
            childCount: childCountMap.get(row.id) ?? 0,
            stackDepth: computeStackDepth({ laneId: row.id, rowsById, memo: depthMemo }),
          })
        );
      }
      return out;
    },

    async getStackChain(laneId: string): Promise<StackChainItem[]> {
      const start = getLaneRow(laneId);
      if (!start) throw new Error(`Lane not found: ${laneId}`);

      let rootId = start.id;
      let cursor: LaneRow | null = start;
      const visited = new Set<string>();
      while (cursor?.parent_lane_id && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        const parent = getLaneRow(cursor.parent_lane_id);
        if (!parent) break;
        rootId = parent.id;
        cursor = parent;
      }

      const chainRows = db.all<{
        id: string;
        name: string;
        branch_ref: string;
        parent_lane_id: string | null;
        base_ref: string;
        worktree_path: string;
        created_at: string;
      }>(
        `
          with recursive stack as (
            select id, parent_lane_id, 0 as depth
            from lanes
            where id = ? and project_id = ?
            union all
            select l.id, l.parent_lane_id, s.depth + 1
            from lanes l
            join stack s on l.parent_lane_id = s.id
            where l.project_id = ? and l.status != 'archived'
          )
          select l.id, l.name, l.branch_ref, l.parent_lane_id, l.base_ref, l.worktree_path, l.created_at
          from stack s
          join lanes l on l.id = s.id
          where l.project_id = ?
          order by l.created_at asc
        `,
        [rootId, projectId, projectId, projectId]
      );

      if (chainRows.length === 0) return [];
      const rowsById = new Map(chainRows.map((row) => [row.id, row] as const));
      const childrenByParent = new Map<string, LaneRow[]>();
      for (const row of chainRows) {
        if (!row.parent_lane_id) continue;
        const arr = childrenByParent.get(row.parent_lane_id) ?? [];
        const laneRow = getLaneRow(row.id);
        if (!laneRow) continue;
        arr.push(laneRow);
        childrenByParent.set(row.parent_lane_id, arr);
      }
      for (const [parentId, children] of childrenByParent.entries()) {
        childrenByParent.set(parentId, sortByCreatedAtAsc(children));
      }

      const statusCache = new Map<string, LaneStatus>();
      const resolveStatus = async (row: {
        id: string;
        parent_lane_id: string | null;
        base_ref: string;
        worktree_path: string;
        branch_ref: string;
      }): Promise<LaneStatus> => {
        const cached = statusCache.get(row.id);
        if (cached) return cached;
        const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
        const status = await computeLaneStatus(row.worktree_path, parent?.branch_ref ?? row.base_ref, row.branch_ref);
        statusCache.set(row.id, status);
        return status;
      };

      const out: StackChainItem[] = [];
      const visit = async (id: string, depth: number): Promise<void> => {
        const row = rowsById.get(id);
        if (!row) return;
        out.push({
          laneId: row.id,
          laneName: row.name,
          branchRef: row.branch_ref,
          depth,
          parentLaneId: row.parent_lane_id,
          status: await resolveStatus(row)
        });
        for (const child of childrenByParent.get(id) ?? []) {
          await visit(child.id, depth + 1);
        }
      };

      await visit(rootId, 0);
      return out;
    },

    async rebaseStart(args: RebaseStartArgs): Promise<RebaseStartResult> {
      const scope: RebaseScope = args.scope ?? "lane_and_descendants";
      const pushMode: PushMode = args.pushMode ?? "none";
      const actor = typeof args.actor === "string" && args.actor.trim().length ? args.actor.trim() : "user";
      const reason = typeof args.reason === "string" && args.reason.trim().length ? args.reason.trim() : "rebase";

      const target = getLaneRow(args.laneId);
      if (!target) throw new Error(`Lane not found: ${args.laneId}`);

      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const order = resolveRebaseOrder({ rootLaneId: target.id, scope });

      const lanes: RebaseRunLane[] = order.map((laneId) => {
        const lane = getLaneRow(laneId);
        return {
          laneId,
          laneName: lane?.name ?? laneId,
          parentLaneId: lane?.parent_lane_id ?? null,
          status: "pending",
          preHeadSha: null,
          postHeadSha: null,
          error: null,
          conflictingFiles: [],
          pushed: false
        };
      });

      const run: RebaseRun = {
        runId,
        rootLaneId: target.id,
        scope,
        pushMode,
        state: "running",
        startedAt,
        finishedAt: null,
        actor,
        baseBranch: target.base_ref,
        lanes,
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false
      };

      rebaseRuns.set(runId, run);
      emitRunLog({ runId, laneId: null, message: `Starting rebase run (${scope})` });
      emitRunUpdated(run);

      if (!target.parent_lane_id) {
        run.state = "failed";
        run.error = "Lane has no parent; nothing to rebase.";
        run.finishedAt = new Date().toISOString();
        run.canRollback = false;
        emitRunLog({ runId, laneId: target.id, message: run.error });
        emitRunUpdated(run);
        return { runId, run: cloneRebaseRun(run) };
      }

      for (let index = 0; index < run.lanes.length; index += 1) {
        const laneItem = run.lanes[index]!;
        const lane = getLaneRow(laneItem.laneId);
        if (!lane) {
          laneItem.status = "blocked";
          laneItem.error = `Lane not found: ${laneItem.laneId}`;
          continue;
        }

        if (!lane.parent_lane_id) {
          laneItem.status = "skipped";
          laneItem.error = "Primary lane has no parent to rebase against.";
          continue;
        }

        const parent = getLaneRow(lane.parent_lane_id);
        if (!parent) {
          laneItem.status = "blocked";
          laneItem.error = `Parent lane not found for ${lane.name}`;
          run.state = "failed";
          run.failedLaneId = lane.id;
          run.error = laneItem.error;
          for (let i = index + 1; i < run.lanes.length; i += 1) {
            const pending = run.lanes[i]!;
            if (pending.status === "pending") pending.status = "blocked";
          }
          break;
        }

        const parentHead = await getHeadSha(parent.worktree_path);
        if (!parentHead) {
          laneItem.status = "blocked";
          laneItem.error = `Unable to resolve parent HEAD for ${parent.name}`;
          run.state = "failed";
          run.failedLaneId = lane.id;
          run.error = laneItem.error;
          for (let i = index + 1; i < run.lanes.length; i += 1) {
            const pending = run.lanes[i]!;
            if (pending.status === "pending") pending.status = "blocked";
          }
          break;
        }

        run.currentLaneId = lane.id;
        laneItem.status = "running";
        laneItem.error = null;
        laneItem.preHeadSha = await getHeadSha(lane.worktree_path);
        emitRunUpdated(run);
        emitRunLog({
          runId,
          laneId: lane.id,
          message: `Rebasing ${lane.name} onto ${parent.name} (${parentHead.slice(0, 8)})`
        });

        const operation = operationService?.start({
          laneId: lane.id,
          kind: "lane_rebase",
          preHeadSha: laneItem.preHeadSha,
          metadata: {
            reason,
            parentLaneId: parent.id,
            parentBranchRef: parent.branch_ref,
            parentHeadSha: parentHead,
            recursive: scope === "lane_and_descendants"
          }
        });

        const rebaseRes = await runGit(["rebase", parentHead], { cwd: lane.worktree_path, timeoutMs: 120_000 });
        if (rebaseRes.exitCode === 0) {
          laneItem.status = "succeeded";
          laneItem.postHeadSha = await getHeadSha(lane.worktree_path);
          if (operation?.operationId) {
            operationService?.finish({
              operationId: operation.operationId,
              status: "succeeded",
              postHeadSha: laneItem.postHeadSha
            });
          }
          if (laneItem.preHeadSha !== laneItem.postHeadSha && onHeadChanged) {
            try {
              onHeadChanged({
                laneId: lane.id,
                reason,
                preHeadSha: laneItem.preHeadSha,
                postHeadSha: laneItem.postHeadSha
              });
            } catch {
              // ignore callback failures
            }
          }
          emitRunUpdated(run);
          continue;
        }

        const conflictRes = await runGit(["diff", "--name-only", "--diff-filter=U"], {
          cwd: lane.worktree_path,
          timeoutMs: 15_000
        });
        laneItem.conflictingFiles = conflictRes.exitCode === 0 ? parseConflictingFiles(conflictRes.stdout) : [];
        laneItem.status = "conflict";
        laneItem.error = rebaseRes.stderr.trim() || "Rebase failed with conflicts";
        laneItem.postHeadSha = await getHeadSha(lane.worktree_path);

        const abortRes = await runGit(["rebase", "--abort"], { cwd: lane.worktree_path, timeoutMs: 15_000 });
        if (abortRes.exitCode !== 0) {
          emitRunLog({
            runId,
            laneId: lane.id,
            message: `Failed to auto-abort rebase: ${abortRes.stderr.trim() || "unknown error"}`
          });
        }

        if (operation?.operationId) {
          operationService?.finish({
            operationId: operation.operationId,
            status: "failed",
            postHeadSha: laneItem.postHeadSha,
            metadataPatch: { error: laneItem.error }
          });
        }

        run.state = "failed";
        run.failedLaneId = lane.id;
        run.error = laneItem.error;
        for (let i = index + 1; i < run.lanes.length; i += 1) {
          const pending = run.lanes[i]!;
          if (pending.status === "pending") pending.status = "blocked";
        }
        emitRunLog({
          runId,
          laneId: lane.id,
          message: `Rebase failed on ${lane.name}: ${laneItem.error}`
        });
        emitRunUpdated(run);
        break;
      }

      run.currentLaneId = null;
      run.finishedAt = new Date().toISOString();
      if (run.state === "running") {
        run.state = "completed";
      }
      run.canRollback = run.lanes.some((lane) => lane.status === "succeeded");
      emitRunUpdated(run);
      return { runId, run: cloneRebaseRun(run) };
    },

    async rebasePush(args: RebasePushArgs): Promise<RebaseRun> {
      const run = getStoredRebaseRun(args.runId);
      if (!Array.isArray(args.laneIds) || args.laneIds.length === 0) {
        return cloneRebaseRun(run);
      }

      for (const laneId of args.laneIds) {
        const laneItem = run.lanes.find((entry) => entry.laneId === laneId);
        if (!laneItem || laneItem.status !== "succeeded") continue;
        if (run.pushedLaneIds.includes(laneId)) continue;
        const lane = getLaneRow(laneId);
        if (!lane) continue;

        await runGitOrThrow(["push", "--force-with-lease"], { cwd: lane.worktree_path, timeoutMs: 120_000 });
        laneItem.pushed = true;
        run.pushedLaneIds.push(laneId);
        emitRunLog({
          runId: run.runId,
          laneId,
          message: `Pushed ${laneItem.laneName} with --force-with-lease`
        });
      }

      run.canRollback = run.pushedLaneIds.length === 0 && run.lanes.some((lane) => lane.status === "succeeded");
      emitRunUpdated(run);
      return cloneRebaseRun(run);
    },

    async rebaseRollback(args: RebaseRollbackArgs): Promise<RebaseRun> {
      const run = getStoredRebaseRun(args.runId);
      if (run.pushedLaneIds.length > 0) {
        throw new Error("Cannot rollback after pushing lanes to remote.");
      }

      for (const laneItem of run.lanes) {
        if (laneItem.status !== "succeeded") continue;
        if (!laneItem.preHeadSha) continue;
        const lane = getLaneRow(laneItem.laneId);
        if (!lane) continue;
        const beforeReset = await getHeadSha(lane.worktree_path);
        await runGitOrThrow(["reset", "--hard", laneItem.preHeadSha], { cwd: lane.worktree_path, timeoutMs: 90_000 });
        const afterReset = await getHeadSha(lane.worktree_path);
        laneItem.postHeadSha = afterReset;
        laneItem.status = "skipped";
        emitRunLog({
          runId: run.runId,
          laneId: laneItem.laneId,
          message: `Rolled back ${laneItem.laneName} to ${laneItem.preHeadSha.slice(0, 8)}`
        });
        if (beforeReset !== afterReset && onHeadChanged) {
          try {
            onHeadChanged({
              laneId: laneItem.laneId,
              reason: "rebase_rollback",
              preHeadSha: beforeReset,
              postHeadSha: afterReset
            });
          } catch {
            // ignore callback failures
          }
        }
      }

      run.state = "aborted";
      run.finishedAt = new Date().toISOString();
      run.canRollback = false;
      emitRunUpdated(run);
      return cloneRebaseRun(run);
    },

    async rebaseAbort(args: RebaseAbortArgs): Promise<RebaseRun> {
      const run = getStoredRebaseRun(args.runId);
      const activeLaneId = run.currentLaneId;
      if (activeLaneId) {
        const lane = getLaneRow(activeLaneId);
        if (lane) {
          await runGit(["rebase", "--abort"], { cwd: lane.worktree_path, timeoutMs: 20_000 });
        }
      }

      run.currentLaneId = null;
      run.state = "aborted";
      run.finishedAt = new Date().toISOString();
      for (const laneItem of run.lanes) {
        if (laneItem.status === "running" || laneItem.status === "pending") {
          laneItem.status = "skipped";
        }
      }
      run.canRollback = run.pushedLaneIds.length === 0 && run.lanes.some((lane) => lane.status === "succeeded");
      emitRunLog({ runId: run.runId, laneId: activeLaneId, message: "Rebase run aborted." });
      emitRunUpdated(run);
      return cloneRebaseRun(run);
    },

    getRebaseRun(runId: string): RebaseRun | null {
      const run = rebaseRuns.get(runId);
      return run ? cloneRebaseRun(run) : null;
    },

    async reparent({ laneId, newParentLaneId }: ReparentLaneArgs): Promise<ReparentLaneResult> {
      const lane = getLaneRow(laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      if (lane.lane_type === "primary") throw new Error("Primary lane cannot be reparented");

      const newParent = getLaneRow(newParentLaneId);
      if (!newParent) throw new Error(`Parent lane not found: ${newParentLaneId}`);
      if (newParent.status === "archived") throw new Error("Parent lane is archived");
      if (lane.id === newParent.id) throw new Error("Cannot reparent lane to itself");

      const rowsById = getRowsById(true);
      if (isDescendant(rowsById, lane.id, newParent.id)) {
        throw new Error("Cannot reparent lane under one of its descendants");
      }

      const previousParentLaneId = lane.parent_lane_id;
      const previousBaseRef = lane.base_ref;
      const newBaseRef = newParent.branch_ref;
      const preHeadSha = await getHeadSha(lane.worktree_path);
      const newParentHead = await getHeadSha(newParent.worktree_path);
      if (!newParentHead) throw new Error(`Unable to resolve parent HEAD for lane ${newParent.name}`);

      const operation = operationService?.start({
        laneId: lane.id,
        kind: "lane_reparent",
        preHeadSha,
        metadata: {
          previousParentLaneId,
          newParentLaneId: newParent.id,
          previousBaseRef,
          newBaseRef,
          parentHeadSha: newParentHead
        }
      });

      db.run(
        "update lanes set parent_lane_id = ?, base_ref = ? where id = ? and project_id = ?",
        [newParent.id, newBaseRef, lane.id, projectId]
      );
      invalidateLaneListCache();

      try {
        await runGitOrThrow(["rebase", newParentHead], { cwd: lane.worktree_path, timeoutMs: 120_000 });
      } catch (error) {
        try {
          await runGit(["rebase", "--abort"], { cwd: lane.worktree_path, timeoutMs: 20_000 });
        } catch {
          // ignore
        }
        db.run(
          "update lanes set parent_lane_id = ?, base_ref = ? where id = ? and project_id = ?",
          [previousParentLaneId, previousBaseRef, lane.id, projectId]
        );
        invalidateLaneListCache();
        const message = error instanceof Error ? error.message : String(error);
        if (operation?.operationId) {
          const postHeadSha = await getHeadSha(lane.worktree_path);
          operationService?.finish({
            operationId: operation.operationId,
            status: "failed",
            postHeadSha,
            metadataPatch: { error: message }
          });
        }
        throw new Error(message);
      }

      const postHeadSha = await getHeadSha(lane.worktree_path);
      if (operation?.operationId) {
        operationService?.finish({
          operationId: operation.operationId,
          status: "succeeded",
          postHeadSha
        });
      }
      if (preHeadSha !== postHeadSha && onHeadChanged) {
        try {
          onHeadChanged({
            laneId: lane.id,
            reason: "reparent",
            preHeadSha,
            postHeadSha
          });
        } catch {
          // ignore callback failures
        }
      }

      return {
        laneId: lane.id,
        previousParentLaneId,
        newParentLaneId: newParent.id,
        previousBaseRef,
        newBaseRef,
        preHeadSha,
        postHeadSha
      };
    },

    rename({ laneId, name }: { laneId: string; name: string }): void {
      db.run("update lanes set name = ? where id = ? and project_id = ?", [name, laneId, projectId]);
      invalidateLaneListCache();
    },

    updateAppearance({ laneId, color, icon, tags }: UpdateLaneAppearanceArgs): void {
      const lane = getLaneRow(laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      const normalizedTags = tags == null
        ? parseLaneTags(lane.tags_json)
        : tags
            .map((entry) => entry.trim())
            .filter(Boolean)
            .slice(0, 24);
      const normalizedColor = color === undefined ? lane.color : color;
      const normalizedIcon = icon === undefined ? parseLaneIcon(lane.icon) : icon;

      db.run(
        `
          update lanes
          set color = ?, icon = ?, tags_json = ?
          where id = ? and project_id = ?
        `,
        [
          normalizedColor ?? null,
          normalizedIcon ?? null,
          JSON.stringify(normalizedTags),
          laneId,
          projectId
        ]
      );
      invalidateLaneListCache();
    },

    archive({ laneId }: { laneId: string }): void {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be archived");
      }

      // Guard: prevent archiving if lane is a member of an active PR group
      const activeGroupMember = db.get<{ group_id: string }>(
        `select m.group_id from pr_group_members m
         join pr_groups g on g.id = m.group_id
         where m.lane_id = ? and g.project_id = ?
         limit 1`,
        [laneId, projectId]
      );
      if (activeGroupMember) {
        throw new Error("Cannot archive a lane that is part of a PR group. Remove from the group first.");
      }

      const now = new Date().toISOString();
      db.run("update lanes set status = 'archived', archived_at = ? where id = ? and project_id = ?", [now, laneId, projectId]);
      invalidateLaneListCache();
    },

    async delete({
      laneId,
      deleteBranch = true,
      deleteRemoteBranch = false,
      remoteName = "origin",
      force = false
    }: DeleteLaneArgs): Promise<void> {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be deleted");
      }

      const childRows = getChildrenRows(laneId, false);
      if (childRows.length > 0) {
        throw new Error("Cannot delete a lane with active child lanes. Delete or rebase/archive children first.");
      }

      if (row.lane_type === "worktree" && row.worktree_path && fs.existsSync(row.worktree_path)) {
        const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: row.worktree_path, timeoutMs: 8_000 });
        const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;
        if (dirty && !force) {
          throw new Error("Lane has uncommitted changes. Enable force delete after confirming warnings.");
        }

        const removeArgs = ["worktree", "remove"];
        if (force) removeArgs.push("--force");
        removeArgs.push(row.worktree_path);
        await runGitOrThrow(removeArgs, { cwd: projectRoot, timeoutMs: 60_000 });
      }

      if (deleteBranch && row.branch_ref) {
        const refCheck = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${row.branch_ref}`], {
          cwd: projectRoot,
          timeoutMs: 8_000
        });
        if (refCheck.exitCode === 0) {
          await runGitOrThrow(["branch", "-D", row.branch_ref], { cwd: projectRoot, timeoutMs: 30_000 });
        }
      }

      if (deleteRemoteBranch && row.branch_ref) {
        const remote = remoteName.trim() || "origin";
        const remoteCheck = await runGit(["remote", "get-url", remote], { cwd: projectRoot, timeoutMs: 8_000 });
        if (remoteCheck.exitCode !== 0) {
          throw new Error(`Remote '${remote}' is not configured for this repository`);
        }
        const remoteRefCheck = await runGit(["ls-remote", "--heads", remote, row.branch_ref], {
          cwd: projectRoot,
          timeoutMs: 12_000
        });
        if (remoteRefCheck.exitCode === 0 && remoteRefCheck.stdout.trim().length > 0) {
          await runGitOrThrow(["push", remote, "--delete", row.branch_ref], { cwd: projectRoot, timeoutMs: 45_000 });
        }
      }

      const lanePackDir = path.join(projectRoot, ".ade", "packs", "lanes", laneId);
      try {
        fs.rmSync(lanePackDir, { recursive: true, force: true });
      } catch {
        // ignore pack folder cleanup failures
      }

      db.run("update lanes set parent_lane_id = null where parent_lane_id = ? and project_id = ?", [laneId, projectId]);
      db.run("delete from pr_group_members where lane_id = ?", [laneId]);
      db.run("delete from pull_requests where lane_id = ? and project_id = ?", [laneId, projectId]);
      db.run("delete from session_deltas where lane_id = ?", [laneId]);
      db.run("delete from terminal_sessions where lane_id = ?", [laneId]);
      db.run("delete from operations where lane_id = ?", [laneId]);
      db.run("delete from packs_index where lane_id = ?", [laneId]);
      db.run("delete from process_runtime where lane_id = ?", [laneId]);
      db.run("delete from process_runs where lane_id = ?", [laneId]);
      db.run("delete from test_runs where lane_id = ?", [laneId]);
      db.run("delete from lanes where id = ? and project_id = ?", [laneId, projectId]);
      invalidateLaneListCache();
    },

    getLaneWorktreePath(laneId: string): string {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return row.worktree_path;
    },

    getLaneBaseAndBranch(laneId: string): { baseRef: string; branchRef: string; worktreePath: string; laneType: LaneType } {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return { baseRef: row.base_ref, branchRef: row.branch_ref, worktreePath: row.worktree_path, laneType: row.lane_type };
    },

    updateBranchRef(laneId: string, branchRef: string): void {
      db.run("update lanes set branch_ref = ? where id = ? and project_id = ?", [branchRef, laneId, projectId]);
      invalidateLaneListCache();
    },

    getFilesWorkspaces(): Array<{
      id: string;
      kind: LaneType;
      laneId: string | null;
      name: string;
      rootPath: string;
      isReadOnlyByDefault: boolean;
    }> {
      const rows = getAllLaneRows(false);
      return rows.map((row) => ({
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        rootPath: row.worktree_path,
        isReadOnlyByDefault: row.is_edit_protected === 1
      }));
    },

    resolveWorkspaceById(workspaceId: string): {
      id: string;
      kind: LaneType;
      laneId: string | null;
      name: string;
      rootPath: string;
      isReadOnlyByDefault: boolean;
    } {
      const row = getLaneRow(workspaceId);
      if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
      return {
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        rootPath: row.worktree_path,
        isReadOnlyByDefault: row.is_edit_protected === 1
      };
    },

    async attach(args: AttachLaneArgs): Promise<LaneSummary> {
      const attachedPath = normAbs(args.attachedPath);
      if (!fs.existsSync(attachedPath) || !fs.statSync(attachedPath).isDirectory()) {
        throw new Error("Attached lane path must be an existing directory");
      }
      await ensureSameRepo(attachedPath);

      const laneId = randomUUID();
      const now = new Date().toISOString();
      const branchRef = await detectBranchRef(attachedPath, defaultBaseRef);
      const baseRef = defaultBaseRef;

      db.run(
        `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'attached', ?, ?, ?, ?, 0, null, null, null, null, 'active', ?, null)
      `,
        [laneId, projectId, args.name, args.description ?? null, baseRef, branchRef, attachedPath, attachedPath, now]
      );
      invalidateLaneListCache();

      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Failed to attach lane: ${laneId}`);
      const status = await computeLaneStatus(attachedPath, baseRef, branchRef);
      return toLaneSummary({
        row,
        status,
        parentStatus: null,
        childCount: 0,
        stackDepth: 0
      });
    }
  };
}
