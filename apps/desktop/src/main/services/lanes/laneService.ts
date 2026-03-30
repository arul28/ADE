import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import { getHeadSha, runGit, runGitOrThrow } from "../git/git";
import { isWithinDir, normalizeBranchName } from "../shared/utils";
import { fetchRemoteTrackingBranch, resolveQueueRebaseOverride, type QueueRebaseOverride } from "../shared/queueRebase";
import { detectConflictKind } from "../git/gitConflictState";
import { shouldLaneTrackParent } from "../../../shared/laneBaseResolution";
import type { createOperationService } from "../history/operationService";
import type { Logger } from "../logging/logger";
import type {
  AdoptAttachedLaneArgs,
  AttachLaneArgs,
  CreateChildLaneArgs,
  CreateLaneArgs,
  CreateLaneFromUnstagedArgs,
  DeleteLaneArgs,
  LaneIcon,
  MissionLaneRole,
  LaneStateSnapshotSummary,
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
  UnregisteredLaneCandidate,
  UpdateLaneAppearanceArgs
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";

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
  mission_id: string | null;
  lane_role: MissionLaneRole | null;
  created_at: string;
  archived_at: string | null;
  status: string;
};

type LaneStateSnapshotRow = {
  lane_id: string;
  agent_summary_json: string | null;
  mission_summary_json: string | null;
  updated_at: string | null;
};

const DEFAULT_LANE_STATUS: LaneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false };
const LANE_LIST_CACHE_TTL_MS = 10_000;

function cloneLaneStatus(status: LaneStatus): LaneStatus {
  return {
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    remoteBehind: status.remoteBehind,
    rebaseInProgress: status.rebaseInProgress
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

function parseSummaryRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
    missionId: row.mission_id,
    laneRole: row.lane_role,
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

  // Detect stuck rebase state
  let rebaseInProgress = false;
  try {
    const gitDirRes = await runGit(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: worktreePath, timeoutMs: 5_000 });
    if (gitDirRes.exitCode === 0) {
      const gitDir = gitDirRes.stdout.trim();
      const kind = detectConflictKind(gitDir);
      rebaseInProgress = kind === "rebase";
    }
  } catch {
    // ignore
  }

  return { dirty, ahead, behind, remoteBehind, rebaseInProgress };
}

async function resolveParentRebaseTarget(args: {
  projectRoot: string;
  parent: LaneRow;
}): Promise<{ headSha: string; label: string }> {
  const { projectRoot, parent } = args;

  if (parent.lane_type === "primary") {
    await fetchRemoteTrackingBranch({
      projectRoot,
      targetBranch: parent.branch_ref,
    }).catch(() => {});

    const candidateRefs: string[] = [];
    const upstreamRes = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: parent.worktree_path, timeoutMs: 5_000 },
    );
    const upstreamRef = upstreamRes.exitCode === 0 ? upstreamRes.stdout.trim() : "";
    if (upstreamRef) {
      candidateRefs.push(upstreamRef);
    }
    const originRef = `origin/${parent.branch_ref}`;
    if (!candidateRefs.includes(originRef)) {
      candidateRefs.push(originRef);
    }

    for (const ref of candidateRefs) {
      const res = await runGit(
        ["rev-parse", "--verify", ref],
        { cwd: parent.worktree_path, timeoutMs: 5_000 },
      );
      const sha = res.exitCode === 0 ? res.stdout.trim() : "";
      if (sha) {
        return { headSha: sha, label: ref };
      }
    }
  }

  const headSha = await getHeadSha(parent.worktree_path);
  if (!headSha) {
    throw new Error(`Unable to resolve parent HEAD for ${parent.name}`);
  }
  return {
    headSha,
    label: parent.name,
  };
}

function describeParentRebaseTarget(parent: LaneRow, label: string): string {
  return label === parent.name ? parent.name : `${parent.name} (${label})`;
}

function rowTracksParent(
  row: Pick<LaneRow, "base_ref" | "parent_lane_id">,
  parent: Pick<LaneRow, "lane_type" | "branch_ref"> | null | undefined,
): boolean {
  return shouldLaneTrackParent({
    lane: {
      baseRef: row.base_ref,
      parentLaneId: row.parent_lane_id,
    },
    parent: parent ? { laneType: parent.lane_type, branchRef: parent.branch_ref } : null,
  });
}

async function resolveBranchRebaseTarget(args: {
  projectRoot: string;
  branchRef: string;
  preferRemote: boolean;
}): Promise<{ headSha: string; label: string; branchName: string }> {
  const branchName = normalizeBranchName(args.branchRef).trim();
  if (!branchName) throw new Error("Base branch is empty.");
  if (args.preferRemote) {
    await fetchRemoteTrackingBranch({
      projectRoot: args.projectRoot,
      targetBranch: branchName,
    }).catch(() => {});
  }

  const candidateRefs = args.preferRemote
    ? [`origin/${branchName}`, branchName]
    : [branchName, `origin/${branchName}`];

  for (const ref of candidateRefs) {
    const res = await runGit(
      ["rev-parse", "--verify", ref],
      { cwd: args.projectRoot, timeoutMs: 5_000 },
    );
    const sha = res.exitCode === 0 ? res.stdout.trim() : "";
    if (sha) {
      return { headSha: sha, label: ref, branchName };
    }
  }

  throw new Error(`Unable to resolve base branch "${branchName}".`);
}

function describeBranchRebaseTarget(branchName: string, label: string): string {
  return label === branchName ? branchName : `${branchName} (${label})`;
}

function localBranchNameFromRemoteRef(ref: string): string {
  const normalized = ref.trim();
  const slashIndex = normalized.indexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

async function resolveImportBranchTarget(args: {
  projectRoot: string;
  rawRef: string;
}): Promise<{ localBranchName: string; remoteRef: string }> {
  const rawRef = args.rawRef.trim();

  // Refresh cached remote refs, but still allow import when the fetch fails and refs are already present locally.
  await runGit(["fetch", "--prune", "--all"], {
    cwd: args.projectRoot,
    timeoutMs: 60_000,
  }).catch(() => {});

  const directCandidates = new Set<string>();
  if (rawRef.includes("/")) directCandidates.add(rawRef);
  directCandidates.add(`origin/${rawRef}`);

  for (const remoteRef of directCandidates) {
    const remoteExists = await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${remoteRef}`], {
      cwd: args.projectRoot,
      timeoutMs: 8_000,
    }).then((result) => result.exitCode === 0);
    if (remoteExists) {
      return {
        localBranchName: localBranchNameFromRemoteRef(remoteRef),
        remoteRef,
      };
    }
  }

  const remoteRefsRes = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/remotes"], {
    cwd: args.projectRoot,
    timeoutMs: 15_000,
  });
  if (remoteRefsRes.exitCode === 0) {
    const suffix = `/${rawRef}`;
    const matches = remoteRefsRes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((ref) => !ref.endsWith("/HEAD"))
      .filter((ref) => ref.endsWith(suffix));
    if (matches.length === 1) {
      return {
        localBranchName: localBranchNameFromRemoteRef(matches[0]!),
        remoteRef: matches[0]!,
      };
    }
    if (matches.length > 1) {
      throw new Error(
        `Branch '${rawRef}' exists on multiple remotes. Import it using an explicit remote ref like '${matches[0]}'.`,
      );
    }
  }

  throw new Error(`Branch '${rawRef}' not found locally or on any remote`);
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

type WorktreeChangeState = {
  hasStaged: boolean;
  hasUnstaged: boolean;
};

async function inspectWorktreeChanges(worktreePath: string): Promise<WorktreeChangeState> {
  const statusRes = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (statusRes.exitCode !== 0) {
    throw new Error("Unable to inspect lane worktree state.");
  }

  let hasStaged = false;
  let hasUnstaged = false;
  const lines = statusRes.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("??")) {
      hasUnstaged = true;
    } else {
      const stagedCode = line[0] ?? " ";
      const unstagedCode = line[1] ?? " ";
      if (stagedCode !== " " && stagedCode !== "?") hasStaged = true;
      if (unstagedCode !== " " && unstagedCode !== "?") hasUnstaged = true;
    }
    if (hasStaged && hasUnstaged) break;
  }

  return { hasStaged, hasUnstaged };
}

type GitStashEntry = {
  ref: string;
  subject: string;
};

async function listGitStashes(worktreePath: string): Promise<GitStashEntry[]> {
  const stashRes = await runGit(["stash", "list", "--format=%gd%x1f%gs"], {
    cwd: worktreePath,
    timeoutMs: 15_000,
  });
  if (stashRes.exitCode !== 0) {
    throw new Error("Unable to inspect git stash entries.");
  }

  return stashRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref, subject] = line.split("\u001f");
      return {
        ref: ref?.trim() ?? "",
        subject: subject?.trim() ?? "",
      };
    })
    .filter((entry) => entry.ref.length > 0);
}

export function createLaneService({
  db,
  projectRoot,
  projectId,
  defaultBaseRef,
  worktreesDir,
  operationService,
  onHeadChanged,
  onRebaseEvent,
  logger: injectedLogger
}: {
  db: AdeDb;
  projectRoot: string;
  projectId: string;
  defaultBaseRef: string;
  worktreesDir: string;
  operationService?: ReturnType<typeof createOperationService>;
  onHeadChanged?: (args: { laneId: string; reason: string; preHeadSha: string | null; postHeadSha: string | null }) => void;
  onRebaseEvent?: (event: RebaseRunEventPayload) => void;
  logger?: Logger;
}) {
  const logger: Logger = injectedLogger ?? {
    debug: () => {},
    info: () => {},
    warn: (event, meta) => console.warn(event, meta ?? ""),
    error: (event, meta) => console.error(event, meta ?? ""),
  };
  const upsertLaneStateSnapshot = (args: {
    laneId: string;
    status: LaneStatus;
    agentSummary?: Record<string, unknown> | null;
    missionSummary?: Record<string, unknown> | null;
    updatedAt?: string;
  }): void => {
    db.run(
      `
        insert into lane_state_snapshots(
          lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress,
          agent_summary_json, mission_summary_json, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(lane_id) do update set
          dirty = excluded.dirty,
          ahead = excluded.ahead,
          behind = excluded.behind,
          remote_behind = excluded.remote_behind,
          rebase_in_progress = excluded.rebase_in_progress,
          agent_summary_json = excluded.agent_summary_json,
          mission_summary_json = excluded.mission_summary_json,
          updated_at = excluded.updated_at
      `,
      [
        args.laneId,
        args.status.dirty ? 1 : 0,
        args.status.ahead,
        args.status.behind,
        args.status.remoteBehind,
        args.status.rebaseInProgress ? 1 : 0,
        args.agentSummary == null ? null : JSON.stringify(args.agentSummary),
        args.missionSummary == null ? null : JSON.stringify(args.missionSummary),
        args.updatedAt ?? new Date().toISOString(),
      ],
    );
  };

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

  const resolveRootAncestorId = (rowsById: Map<string, LaneRow>, laneId: string): string => {
    let currentId = laneId;
    const visited = new Set<string>();
    while (!visited.has(currentId)) {
      visited.add(currentId);
      const row = rowsById.get(currentId);
      if (!row?.parent_lane_id) return currentId;
      currentId = row.parent_lane_id;
    }
    return laneId;
  };

  const getStoredRebaseRun = (runId: string): RebaseRun => {
    const run = rebaseRuns.get(runId);
    if (!run) throw new Error(`Rebase run not found: ${runId}`);
    return run;
  };

  const normalizedProjectRoot = normAbs(projectRoot);

  const getGitTopLevel = async (cwd: string): Promise<string> => {
    const top = await runGitOrThrow(["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
    return normAbs(top.trim());
  };

  const getGitCommonDir = async (cwd: string): Promise<string> => {
    const commonDir = await runGitOrThrow(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeoutMs: 10_000 });
    return normAbs(commonDir.trim());
  };

  const ensureAttachableWorktreeRoot = async (candidatePath: string): Promise<void> => {
    const resolvedPath = normAbs(candidatePath);
    let worktreeRoot = "";
    let candidateCommonDir = "";
    try {
      worktreeRoot = await getGitTopLevel(resolvedPath);
      candidateCommonDir = await getGitCommonDir(resolvedPath);
    } catch {
      throw new Error("Attached lane path must be a valid git worktree root");
    }
    if (worktreeRoot !== resolvedPath) {
      throw new Error("Attached lane path must point to the root of a worktree (not a subdirectory)");
    }
    if (resolvedPath === normalizedProjectRoot) {
      throw new Error("Primary repository root is already tracked as the Primary lane");
    }
    const projectCommonDir = await getGitCommonDir(normalizedProjectRoot);
    if (candidateCommonDir !== projectCommonDir) {
      throw new Error("Attached lane path must belong to the current project repository");
    }
  };

  /** Look up the active (non-archived) primary lane. */
  const getActivePrimaryLane = (): { id: string; branch_ref: string } | undefined => {
    return db.get<{ id: string; branch_ref: string }>(
      "select id, branch_ref from lanes where project_id = ? and lane_type = 'primary' and status != 'archived' order by created_at asc, id asc limit 1",
      [projectId],
    ) ?? undefined;
  };

  const ensurePrimaryLane = async (): Promise<void> => {
    const existing = db.get<{ id: string }>(
      "select id from lanes where project_id = ? and lane_type = 'primary' and status != 'archived' limit 1",
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

  const repairPrimaryParentedRootLanes = (): void => {
    const primary = getActivePrimaryLane();
    if (!primary?.id) return;
    const repairCount = Number(
      db.get<{ count: number }>(
        `
          select count(1) as count
          from lanes
          where project_id = ?
            and lane_type != 'primary'
            and status != 'archived'
            and parent_lane_id = ?
        `,
        [projectId, primary.id],
      )?.count ?? 0,
    );
    if (repairCount <= 0) return;
    db.run(
      `
        update lanes
        set parent_lane_id = null,
            base_ref = ?
        where project_id = ?
          and lane_type != 'primary'
          and status != 'archived'
          and parent_lane_id = ?
      `,
      [defaultBaseRef, projectId, primary.id],
    );
    invalidateLaneListCache();
  };

  const repairLegacyPrimaryBaseRootLanes = (): void => {
    const normalizedDefaultBaseRef = defaultBaseRef.trim();
    if (!normalizedDefaultBaseRef.length) return;
    const repairCount = Number(
      db.get<{ count: number }>(
        `
          select count(1) as count
          from lanes l
          where l.project_id = ?
            and l.lane_type = 'worktree'
            and l.status != 'archived'
            and l.parent_lane_id is null
            and l.branch_ref like 'ade/%'
            and trim(coalesce(l.base_ref, '')) != ?
            and not exists (
              select 1
              from pull_requests pr
              where pr.project_id = l.project_id
                and pr.lane_id = l.id
                and pr.state in ('open', 'draft')
            )
        `,
        [projectId, normalizedDefaultBaseRef],
      )?.count ?? 0,
    );
    if (repairCount <= 0) return;
    db.run(
      `
        update lanes
        set base_ref = ?
        where project_id = ?
          and lane_type = 'worktree'
          and status != 'archived'
          and parent_lane_id is null
          and branch_ref like 'ade/%'
          and trim(coalesce(base_ref, '')) != ?
          and not exists (
            select 1
            from pull_requests pr
            where pr.project_id = lanes.project_id
              and pr.lane_id = lanes.id
              and pr.state in ('open', 'draft')
          )
      `,
      [normalizedDefaultBaseRef, projectId, normalizedDefaultBaseRef],
    );
    invalidateLaneListCache();
  };

  const listLanes = async ({
    includeArchived = false,
    includeStatus = true
  }: ListLanesArgs = {}): Promise<LaneSummary[]> => {
    // Best-effort primary lane bootstrap -- failures should not block listing.
    try {
      await ensurePrimaryLane();
    } catch (err) {
      logger.warn("laneService.ensurePrimaryLane_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      await syncPrimaryLaneBranchRef();
    } catch (err) {
      logger.warn("laneService.syncPrimaryLaneBranchRef_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      repairPrimaryParentedRootLanes();
    } catch (err) {
      logger.warn("laneService.repairPrimaryParentedRootLanes_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      repairLegacyPrimaryBaseRootLanes();
    } catch (err) {
      logger.warn("laneService.repairLegacyPrimaryBaseRootLanes_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    const cacheKey = `arch:${includeArchived ? 1 : 0}|status:${includeStatus ? 1 : 0}`;
    const cached = laneListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.rows.map(cloneLaneSummary);
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

    // Precompute queue rebase overrides for all lanes to avoid N+1 DB queries
    // inside resolveStatus(). Each call does multiple DB queries and may run
    // git commands, so batching up-front is significantly cheaper.
    const queueOverrideCache = new Map<string, QueueRebaseOverride | null>();
    if (includeStatus) {
      const laneIdsToResolve = new Set<string>();
      for (const row of rows) {
        laneIdsToResolve.add(row.id);
        if (row.parent_lane_id) laneIdsToResolve.add(row.parent_lane_id);
      }
      await Promise.all(
        [...laneIdsToResolve].map(async (laneId) => {
          try {
            const override = await resolveQueueRebaseOverride({
              db,
              projectId,
              projectRoot,
              laneId,
            });
            queueOverrideCache.set(laneId, override);
          } catch (err) {
            logger.warn("laneService.lane_list.queue_override_failed", { laneId, error: String(err) });
            queueOverrideCache.set(laneId, null);
          }
        }),
      );
    }

    const resolveStatus = async (laneId: string): Promise<LaneStatus> => {
      const cached = statusCache.get(laneId);
      if (cached) return cached;
      const row = rowsById.get(laneId);
      if (!row) return DEFAULT_LANE_STATUS;
      const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
      const queueOverride = queueOverrideCache.get(row.id) ?? null;
      let baseRef = queueOverride?.comparisonRef ?? (rowTracksParent(row, parent) ? parent?.branch_ref ?? row.base_ref : row.base_ref);

      // For primary lanes with no parent, compare against the upstream tracking ref
      // instead of base_ref (which equals branchRef, giving 0 behind).
      if (!queueOverride && !parent && row.lane_type === "primary") {
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
            logger.warn("laneService.resolveStatus_failed", { laneId: row.id });
            status = cloneLaneStatus(DEFAULT_LANE_STATUS);
          }
          if (row.parent_lane_id) {
            try {
              parentStatus = await resolveStatus(row.parent_lane_id);
            } catch {
              logger.warn("laneService.resolveStatus_failed", { laneId: row.parent_lane_id, context: "parent" });
              parentStatus = cloneLaneStatus(DEFAULT_LANE_STATUS);
            }
          }
        }

        let stackDepth = 0;
        try {
          stackDepth = computeStackDepth({ laneId: row.id, rowsById, memo: depthMemo });
        } catch {
          logger.warn("laneService.computeStackDepth_failed", { laneId: row.id });
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
        if (includeStatus) {
          upsertLaneStateSnapshot({
            laneId: row.id,
            status,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        // If building the summary for a single lane fails entirely, skip it
        // rather than crashing the whole list operation.
        logger.warn("laneService.build_summary_failed", { laneId: row.id, error: err instanceof Error ? err.message : String(err) });
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
    missionId?: string | null;
    laneRole?: MissionLaneRole | null;
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
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder, mission_id, lane_role, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, null, null, null, ?, ?, ?, 'active', ?, null)
      `,
      [
        laneId,
        projectId,
        args.name,
        args.description ?? null,
        args.baseRef,
        branchRef,
        worktreePath,
        args.parentLaneId,
        args.folder ?? null,
        args.missionId ?? null,
        args.laneRole ?? null,
        now
      ]
    );
    invalidateLaneListCache();

    // Best-effort initial push to establish upstream tracking
    try {
      await runGit(["push", "-u", "origin", branchRef], { cwd: worktreePath, timeoutMs: 60_000 });
    } catch {
      // Non-fatal: lane works locally even without remote tracking
    }

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

  try {
    repairLegacyPrimaryBaseRootLanes();
  } catch (err) {
    logger.warn("laneService.initial_repairLegacyPrimaryBaseRootLanes_failed", { error: err instanceof Error ? err.message : String(err) });
  }

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

    async listUnregisteredWorktrees(): Promise<UnregisteredLaneCandidate[]> {
      const stdout = await runGitOrThrow(
        ["worktree", "list", "--porcelain"],
        { cwd: projectRoot, timeoutMs: 15_000 }
      );

      const blocks = stdout.split(/\n\n+/).filter(Boolean);
      const worktrees: UnregisteredLaneCandidate[] = [];

      for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        let wtPath = "";
        let branch = "";
        let isBare = false;
        for (const line of lines) {
          if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
          if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
          if (line === "bare") isBare = true;
        }
        if (!wtPath || isBare) continue;
        worktrees.push({ path: normAbs(wtPath), branch });
      }

      // Filter out primary worktree and worktrees already tracked as lanes
      const registeredPaths = new Set(
        db.all<{ worktree_path: string }>(
          "select worktree_path from lanes where project_id = ?",
          [projectId]
        ).map((row) => normAbs(row.worktree_path))
      );

      return worktrees.filter(
        (wt) => wt.path !== normalizedProjectRoot && !registeredPaths.has(wt.path)
      );
    },

    getStateSnapshot(laneId: string): LaneStateSnapshotSummary | null {
      const row = db.get<LaneStateSnapshotRow>(
        `
          select s.lane_id, s.agent_summary_json, s.mission_summary_json, s.updated_at
          from lane_state_snapshots s
          join lanes l on l.id = s.lane_id
          where s.lane_id = ?
            and l.project_id = ?
          limit 1
        `,
        [laneId, projectId],
      );
      if (!row) return null;
      return {
        laneId: row.lane_id,
        agentSummary: parseSummaryRecord(row.agent_summary_json),
        missionSummary: parseSummaryRecord(row.mission_summary_json),
        updatedAt: row.updated_at ?? null,
      };
    },

    listStateSnapshots(): LaneStateSnapshotSummary[] {
      return db.all<LaneStateSnapshotRow>(
        `
          select s.lane_id, s.agent_summary_json, s.mission_summary_json, s.updated_at
          from lane_state_snapshots s
          join lanes l on l.id = s.lane_id
          where l.project_id = ?
        `,
        [projectId],
      ).map((row) => ({
        laneId: row.lane_id,
        agentSummary: parseSummaryRecord(row.agent_summary_json),
        missionSummary: parseSummaryRecord(row.mission_summary_json),
        updatedAt: row.updated_at ?? null,
      }));
    },

    async refreshSnapshots(args: ListLanesArgs = {}): Promise<{ refreshedCount: number; lanes: LaneSummary[] }> {
      invalidateLaneListCache();
      const summaries = await listLanes({
        includeArchived: args.includeArchived ?? true,
        includeStatus: true,
      });
      return {
        refreshedCount: summaries.length,
        lanes: summaries,
      };
    },

    invalidateListCache(): void {
      invalidateLaneListCache();
    },

    async create({ name, description, parentLaneId, baseBranch }: CreateLaneArgs): Promise<LaneSummary> {
      if (parentLaneId) {
        const parent = getLaneRow(parentLaneId);
        if (!parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
        if (parent.status === "archived") throw new Error("Parent lane is archived");

        const trimmedBaseBranch = baseBranch?.trim() ?? "";
        const requestedBaseRef = parent.lane_type === "primary"
          ? (trimmedBaseBranch.length > 0 ? trimmedBaseBranch : defaultBaseRef)
          : parent.branch_ref;

        // If we are branching directly from the current primary checkout, ensure
        // it is in sync with remote before using it as the base.
        if (parent.lane_type === "primary" && requestedBaseRef === parent.branch_ref) {
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
        let parentHeadSha: string | null;
        if (parent.lane_type === "primary") {
          const result = await runGit(["rev-parse", requestedBaseRef], { cwd: parent.worktree_path, timeoutMs: 10_000 });
          if (result.exitCode !== 0 || !result.stdout.trim().length) {
            throw new Error(`Base branch not found on primary lane: ${requestedBaseRef}`);
          }
          parentHeadSha = result.stdout.trim();
        } else {
          parentHeadSha = await getHeadSha(parent.worktree_path);
        }
        if (!parentHeadSha) throw new Error(`Unable to resolve parent HEAD for lane ${parent.name}`);
        return await createWorktreeLane({
          name,
          description,
          baseRef: requestedBaseRef,
          startPoint: parentHeadSha,
          parentLaneId: parent.lane_type === "primary" ? null : parent.id
        });
      }

      // No parent specified: branch from defaultBaseRef. Resolve the exact SHA to avoid stale refs.
      const trimmedBase = baseBranch?.trim() ?? "";
      const requestedBaseRef = trimmedBase.length > 0 ? trimmedBase : defaultBaseRef;
      const headRes = await runGit(["rev-parse", requestedBaseRef], { cwd: projectRoot, timeoutMs: 10_000 });
      const startPoint = headRes.exitCode === 0 && headRes.stdout.trim().length
        ? headRes.stdout.trim()
        : requestedBaseRef;

      return await createWorktreeLane({
        name,
        description,
        baseRef: requestedBaseRef,
        startPoint,
        parentLaneId: null
      });
    },

    async createChild(args: CreateChildLaneArgs): Promise<LaneSummary> {
      const parent = getLaneRow(args.parentLaneId);
      if (!parent) throw new Error(`Parent lane not found: ${args.parentLaneId}`);
      if (parent.status === "archived") throw new Error("Parent lane is archived");

      const trimmedBaseBranchRef = args.baseBranchRef?.trim() ?? "";
      const hasOverride = trimmedBaseBranchRef.length > 0 && trimmedBaseBranchRef !== parent.branch_ref;

      if (hasOverride) {
        let localBranchName = trimmedBaseBranchRef;
        const localExists = await runGit(
          ["show-ref", "--verify", "--quiet", `refs/heads/${trimmedBaseBranchRef}`],
          { cwd: projectRoot, timeoutMs: 8_000 },
        ).then((r) => r.exitCode === 0);

        if (!localExists) {
          const resolved = await resolveImportBranchTarget({ projectRoot, rawRef: trimmedBaseBranchRef });
          localBranchName = resolved.localBranchName;
          const resolvedLocalExists = await runGit(
            ["show-ref", "--verify", "--quiet", `refs/heads/${resolved.localBranchName}`],
            { cwd: projectRoot, timeoutMs: 8_000 },
          ).then((r) => r.exitCode === 0);
          if (!resolvedLocalExists) {
            await runGitOrThrow(
              ["branch", "--track", resolved.localBranchName, resolved.remoteRef],
              { cwd: projectRoot, timeoutMs: 15_000 },
            );
          }
        }

        const headRes = await runGit(["rev-parse", localBranchName], { cwd: projectRoot, timeoutMs: 10_000 });
        const startPoint = headRes.exitCode === 0 && headRes.stdout.trim().length
          ? headRes.stdout.trim()
          : localBranchName;

        return await createWorktreeLane({
          name: args.name,
          description: args.description,
          baseRef: localBranchName,
          startPoint,
          parentLaneId: parent.id,
          folder: args.folder,
          missionId: args.missionId ?? null,
          laneRole: args.laneRole ?? null,
        });
      }

      if (parent.lane_type === "primary") {
        const requestedBaseRef = defaultBaseRef;
        const headRes = await runGit(["rev-parse", requestedBaseRef], { cwd: projectRoot, timeoutMs: 10_000 });
        const startPoint = headRes.exitCode === 0 && headRes.stdout.trim().length
          ? headRes.stdout.trim()
          : requestedBaseRef;

        return await createWorktreeLane({
          name: args.name,
          description: args.description,
          baseRef: requestedBaseRef,
          startPoint,
          parentLaneId: null,
          folder: args.folder,
          missionId: args.missionId ?? null,
          laneRole: args.laneRole ?? null,
        });
      }

      const parentHeadSha = await getHeadSha(parent.worktree_path);
      if (!parentHeadSha) throw new Error(`Unable to resolve parent HEAD for lane ${parent.name}`);
      return await createWorktreeLane({
        name: args.name,
        description: args.description,
        baseRef: parent.branch_ref,
        startPoint: parentHeadSha,
        parentLaneId: parent.id,
        folder: args.folder,
        missionId: args.missionId ?? null,
        laneRole: args.laneRole ?? null
      });
    },

    setMissionOwnership(args: {
      laneId: string;
      missionId?: string | null;
      laneRole?: MissionLaneRole | null;
    }): void {
      const laneId = args.laneId.trim();
      if (!laneId.length) throw new Error("laneId is required.");
      const existing = getLaneRow(laneId);
      if (!existing) throw new Error(`Lane not found: ${laneId}`);
      db.run(
        `
          update lanes
          set mission_id = ?,
              lane_role = ?
          where id = ?
            and project_id = ?
        `,
        [args.missionId?.trim() || null, args.laneRole ?? null, laneId, projectId]
      );
      invalidateLaneListCache();
    },

    async createFromUnstaged(args: CreateLaneFromUnstagedArgs): Promise<LaneSummary> {
      const sourceLaneId = args.sourceLaneId.trim();
      const name = args.name.trim();
      if (!sourceLaneId) throw new Error("sourceLaneId is required");
      if (!name) throw new Error("name is required");

      const source = getLaneRow(sourceLaneId);
      if (!source) throw new Error(`Lane not found: ${sourceLaneId}`);
      if (source.status === "archived") throw new Error("Source lane is archived");

      const sourceHeadSha = await getHeadSha(source.worktree_path);
      if (!sourceHeadSha) throw new Error(`Unable to resolve HEAD for lane ${source.name}`);

      const changeState = await inspectWorktreeChanges(source.worktree_path);
      if (changeState.hasStaged) {
        throw new Error("This lane has staged changes. Unstage all changes before moving unstaged work to a new lane.");
      }
      if (!changeState.hasUnstaged) {
        throw new Error("This lane has no unstaged changes to move.");
      }

      const stashMarker = `ade-rescue-unstaged:${source.id}:${randomUUID()}`;
      let stashRef: string | null = null;
      let createdLaneId: string | null = null;

      const restoreSourceStash = async (): Promise<void> => {
        if (!stashRef) return;
        await runGitOrThrow(["stash", "apply", stashRef], {
          cwd: source.worktree_path,
          timeoutMs: 30_000,
        });
        await runGitOrThrow(["stash", "drop", stashRef], {
          cwd: source.worktree_path,
          timeoutMs: 15_000,
        });
        stashRef = null;
      };

      const cleanupCreatedLane = async (laneId: string): Promise<void> => {
        const row = getLaneRow(laneId);
        if (!row) return;

        if (row.lane_type === "worktree" && row.worktree_path && fs.existsSync(row.worktree_path)) {
          await runGitOrThrow(["worktree", "remove", "--force", row.worktree_path], {
            cwd: projectRoot,
            timeoutMs: 60_000,
          });
        }

        if (row.branch_ref) {
          const refCheck = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${row.branch_ref}`], {
            cwd: projectRoot,
            timeoutMs: 8_000,
          });
          if (refCheck.exitCode === 0) {
            await runGitOrThrow(["branch", "-D", row.branch_ref], { cwd: projectRoot, timeoutMs: 30_000 });
          }
        }

        db.run("delete from lanes where id = ? and project_id = ?", [laneId, projectId]);
        invalidateLaneListCache();
      };

      try {
        await runGitOrThrow(["stash", "push", "--keep-index", "-u", "-m", stashMarker], {
          cwd: source.worktree_path,
          timeoutMs: 30_000,
        });
        const stashEntry = (await listGitStashes(source.worktree_path)).find((entry) => entry.subject.includes(stashMarker));
        if (!stashEntry) {
          throw new Error("Created a temporary stash, but could not resolve it.");
        }
        stashRef = stashEntry.ref;

        const createdLane = await createWorktreeLane({
          name,
          baseRef: source.branch_ref,
          startPoint: sourceHeadSha,
          parentLaneId: source.id,
        });
        createdLaneId = createdLane.id;

        try {
          await runGitOrThrow(["stash", "apply", stashRef], {
            cwd: createdLane.worktreePath,
            timeoutMs: 30_000,
          });
        } catch (error) {
          const cleanupErrors: string[] = [];
          try {
            await cleanupCreatedLane(createdLane.id);
          } catch (cleanupError) {
            cleanupErrors.push(`cleanup lane failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
          try {
            await restoreSourceStash();
          } catch (restoreError) {
            cleanupErrors.push(`restore source changes failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
          }
          const cleanupMessage = cleanupErrors.length ? ` ${cleanupErrors.join(" ")}` : "";
          throw new Error(
            `Couldn't move unstaged changes to the new lane. ${error instanceof Error ? error.message : String(error)}${cleanupMessage}`.trim()
          );
        }

        try {
          await runGitOrThrow(["stash", "drop", stashRef], {
            cwd: source.worktree_path,
            timeoutMs: 15_000,
          });
          stashRef = null;
        } catch (error) {
          logger.warn("laneService.drop_rescue_stash_failed", { error: error instanceof Error ? error.message : String(error) });
        }

        const refreshedLane = (await listLanes({ includeArchived: false, includeStatus: true })).find(
          (lane) => lane.id === createdLane.id,
        );
        return refreshedLane ?? createdLane;
      } catch (error) {
        if (stashRef && !createdLaneId) {
          try {
            await restoreSourceStash();
          } catch (restoreError) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} Source changes could not be restored: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
            );
          }
        }
        throw error;
      }
    },

    async importBranch(args: { branchRef: string; name?: string; description?: string; baseBranch?: string }): Promise<LaneSummary> {
      const rawRef = (args.branchRef ?? "").trim();
      if (!rawRef) throw new Error("branchRef is required");
      if (rawRef.includes("\0")) throw new Error("Invalid branchRef");

      let branchRef = rawRef;
      let remoteRefToTrack: string | null = null;
      let branchCreated = false;
      let worktreeAdded = false;
      let laneInserted = false;
      let localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${rawRef}`], {
        cwd: projectRoot, timeoutMs: 8_000
      }).then((r) => r.exitCode === 0);

      if (!localExists) {
        const resolved = await resolveImportBranchTarget({ projectRoot, rawRef });
        branchRef = resolved.localBranchName;
        localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${resolved.localBranchName}`], {
          cwd: projectRoot,
          timeoutMs: 8_000,
        }).then((r) => r.exitCode === 0);
        remoteRefToTrack = localExists ? null : resolved.remoteRef;
      }

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

      try {
        if (remoteRefToTrack) {
          await runGitOrThrow(["branch", "--track", branchRef, remoteRefToTrack], { cwd: projectRoot, timeoutMs: 15_000 });
          branchCreated = true;
        }

        // Attaching an existing branch: do NOT create a new branch, just add a worktree checkout.
        await runGitOrThrow(["worktree", "add", worktreePath, branchRef], {
          cwd: projectRoot,
          timeoutMs: 60_000
        });
        worktreeAdded = true;

        // Imported branches are always root lanes. No caller passes
        // parentLaneId — if a child lane is wanted, the "child" creation
        // mode is used instead.
        const parentLaneId: string | null = null;
        const parent = parentLaneId ? getLaneRow(parentLaneId) : null;
        if (parentLaneId && !parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
        if (parent && parent.status === "archived") throw new Error("Parent lane is archived");

        const baseRef = args.baseBranch?.trim() || defaultBaseRef;

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
        laneInserted = true;
        invalidateLaneListCache();

        // Best-effort push to establish upstream if not already tracking a remote
        try {
          const upstreamCheck = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: worktreePath, timeoutMs: 5_000 });
          if (upstreamCheck.exitCode !== 0) {
            await runGit(["push", "-u", "origin", branchRef], { cwd: worktreePath, timeoutMs: 60_000 });
          }
        } catch {
          // Non-fatal: lane works locally even without remote tracking
        }

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
      } catch (error) {
        if (laneInserted) {
          const persistedRow = getLaneRow(laneId);
          if (!persistedRow) throw error;
          const rowsById = getRowsById(true);
          let status: Awaited<ReturnType<typeof computeLaneStatus>> | null = null;
          let parentStatus: Awaited<ReturnType<typeof computeLaneStatus>> | null = null;
          let stackDepth = 0;
          try {
            status = await computeLaneStatus(worktreePath, persistedRow.base_ref, branchRef);
          } catch {
            status = null;
          }
          try {
            const parent = persistedRow.parent_lane_id ? getLaneRow(persistedRow.parent_lane_id) : null;
            if (parent) {
              parentStatus = await computeLaneStatus(parent.worktree_path, parent.base_ref, parent.branch_ref);
            }
          } catch {
            parentStatus = null;
          }
          try {
            stackDepth = computeStackDepth({ laneId, rowsById, memo: new Map() });
          } catch {
            stackDepth = 0;
          }
          return toLaneSummary({
            row: persistedRow,
            status: status ?? { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
            parentStatus,
            childCount: 0,
            stackDepth,
          });
        }

        const cleanupErrors: string[] = [];
        if (worktreeAdded) {
          try {
            await runGitOrThrow(["worktree", "remove", "--force", worktreePath], {
              cwd: projectRoot,
              timeoutMs: 60_000,
            });
          } catch (cleanupError) {
            try {
              fs.rmSync(worktreePath, { recursive: true, force: true });
              // Directory removed but git metadata may be orphaned; prune to clean up
              try {
                await runGitOrThrow(["worktree", "prune"], {
                  cwd: projectRoot,
                  timeoutMs: 60_000,
                });
              } catch (pruneError) {
                cleanupErrors.push(`worktree prune failed: ${pruneError instanceof Error ? pruneError.message : String(pruneError)}`);
              }
            } catch {
              cleanupErrors.push(`remove worktree failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            }
          }
        }
        if (branchCreated) {
          try {
            await runGitOrThrow(["branch", "-D", branchRef], {
              cwd: projectRoot,
              timeoutMs: 15_000,
            });
          } catch (cleanupError) {
            cleanupErrors.push(`delete branch failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }

        if (cleanupErrors.length > 0) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} Cleanup failed: ${cleanupErrors.join(" ")}`);
        }
        throw error;
      }
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
          parentStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false };
        }
      }

      const defaultStatus: LaneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false };
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
        lane_type: LaneType;
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
          select l.id, l.name, l.lane_type, l.branch_ref, l.parent_lane_id, l.base_ref, l.worktree_path, l.created_at
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
        lane_type: LaneType;
        parent_lane_id: string | null;
        base_ref: string;
        worktree_path: string;
        branch_ref: string;
      }): Promise<LaneStatus> => {
        const cached = statusCache.get(row.id);
        if (cached) return cached;
        const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
        const status = await computeLaneStatus(
          row.worktree_path,
          rowTracksParent(row, parent) ? parent?.branch_ref ?? row.base_ref : row.base_ref,
          row.branch_ref,
        );
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
      const baseBranchOverride = normalizeBranchName(args.baseBranchOverride ?? "").trim();
      const persistBaseBranch = baseBranchOverride.length > 0;

      const target = getLaneRow(args.laneId);
      if (!target) throw new Error(`Lane not found: ${args.laneId}`);
      const targetParent = target.parent_lane_id ? getLaneRow(target.parent_lane_id) : null;
      if (persistBaseBranch && rowTracksParent(target, targetParent)) {
        throw new Error("Cannot persist a base branch override for a parented lane.");
      }

      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const order = resolveRebaseOrder({ rootLaneId: target.id, scope });
      const rowsById = getRowsById(false);
      const rootStackId = resolveRootAncestorId(rowsById, target.id);
      const conflictingRun = [...rebaseRuns.values()].find((existingRun) =>
        existingRun.state === "running"
        && resolveRootAncestorId(rowsById, existingRun.rootLaneId) === rootStackId
      );
      if (conflictingRun) {
        throw new Error(`A rebase run is already active for this lane stack (${conflictingRun.runId.slice(0, 8)}).`);
      }

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
        baseBranch: baseBranchOverride || target.base_ref,
        lanes,
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
        rootBaseRefBefore: target.base_ref,
        rootBaseRefAfter: baseBranchOverride || target.base_ref,
      };

      rebaseRuns.set(runId, run);
      emitRunLog({ runId, laneId: null, message: `Starting rebase run (${scope})` });
      emitRunUpdated(run);

      const failRunAtLane = (laneItem: RebaseRunLane, laneId: string, index: number, errorMsg: string): void => {
        laneItem.status = "blocked";
        laneItem.error = errorMsg;
        run.state = "failed";
        run.failedLaneId = laneId;
        run.error = errorMsg;
        for (let i = index + 1; i < run.lanes.length; i += 1) {
          const pending = run.lanes[i]!;
          if (pending.status === "pending") pending.status = "blocked";
        }
      };

      for (let index = 0; index < run.lanes.length; index += 1) {
        const laneItem = run.lanes[index]!;
        const lane = getLaneRow(laneItem.laneId);
        if (!lane) {
          laneItem.status = "blocked";
          laneItem.error = `Lane not found: ${laneItem.laneId}`;
          continue;
        }

        const isRootLane = index === 0 && lane.id === target.id;
        let parentHead = "";
        let parentTargetLabel = "";
        let operationMetadata: Record<string, unknown> = {
          reason,
          recursive: scope === "lane_and_descendants",
        };
        try {
          const parent = lane.parent_lane_id ? getLaneRow(lane.parent_lane_id) : null;
          const tracksParent = rowTracksParent(lane, parent);
          if (isRootLane && !tracksParent) {
            const branchTarget = await resolveBranchRebaseTarget({
              projectRoot,
              branchRef: baseBranchOverride || lane.base_ref,
              preferRemote: true,
            });
            parentHead = branchTarget.headSha;
            parentTargetLabel = describeBranchRebaseTarget(branchTarget.branchName, branchTarget.label);
            operationMetadata = {
              ...operationMetadata,
              baseBranchRef: branchTarget.branchName,
              baseTargetRef: branchTarget.label,
              baseHeadSha: branchTarget.headSha,
            };
          } else {
            if (!lane.parent_lane_id || !tracksParent) {
              failRunAtLane(laneItem, lane.id, index, `${lane.name} has no parent lane to rebase against.`);
              break;
            }
            if (!parent) {
              failRunAtLane(laneItem, lane.id, index, `Parent lane not found for ${lane.name}`);
              break;
            }
            const parentTarget = await resolveParentRebaseTarget({ projectRoot, parent });
            parentHead = parentTarget.headSha;
            parentTargetLabel = describeParentRebaseTarget(parent, parentTarget.label);
            operationMetadata = {
              ...operationMetadata,
              parentLaneId: parent.id,
              parentBranchRef: parent.branch_ref,
              parentHeadSha: parentHead,
            };
          }
        } catch (error) {
          failRunAtLane(
            laneItem,
            lane.id,
            index,
            error instanceof Error ? error.message : `Unable to resolve rebase target for ${lane.name}`,
          );
          break;
        }

        run.currentLaneId = lane.id;
        laneItem.preHeadSha = await getHeadSha(lane.worktree_path);
        if (!laneItem.preHeadSha) {
          failRunAtLane(laneItem, lane.id, index, `Unable to resolve HEAD for ${lane.name}`);
          break;
        }

        const alreadyCurrent = await runGit(["merge-base", "--is-ancestor", parentHead, laneItem.preHeadSha], {
          cwd: lane.worktree_path,
          timeoutMs: 15_000,
        });
        if (alreadyCurrent.exitCode === 0) {
          laneItem.status = "skipped";
          laneItem.postHeadSha = laneItem.preHeadSha;
          run.currentLaneId = null;
          emitRunLog({
            runId,
            laneId: lane.id,
            message: `${lane.name} is already up to date with ${parentTargetLabel}; skipping rebase.`,
          });
          emitRunUpdated(run);
          continue;
        }
        if (alreadyCurrent.exitCode !== 1) {
          failRunAtLane(laneItem, lane.id, index, alreadyCurrent.stderr.trim() || `Unable to compare ${lane.name} with ${parentTargetLabel}`);
          break;
        }

        // Refuse to rebase a dirty worktree — git rebase will fail and leave confusing state.
        const dirtyCheck = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktree_path, timeoutMs: 8_000 });
        if (dirtyCheck.exitCode === 0 && dirtyCheck.stdout.trim().length > 0) {
          failRunAtLane(laneItem, lane.id, index, `${lane.name} has uncommitted changes. Commit or stash before rebasing.`);
          emitRunLog({ runId, laneId: lane.id, message: `Skipping ${lane.name}: worktree is dirty.` });
          emitRunUpdated(run);
          break;
        }

        laneItem.status = "running";
        laneItem.error = null;
        emitRunUpdated(run);
        emitRunLog({
          runId,
          laneId: lane.id,
          message: `Rebasing ${lane.name} onto ${parentTargetLabel} (${parentHead.slice(0, 8)})`
        });

        const operation = operationService?.start({
          laneId: lane.id,
          kind: "lane_rebase",
          preHeadSha: laneItem.preHeadSha,
          metadata: operationMetadata,
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

        const abortRes = await runGit(["rebase", "--abort"], { cwd: lane.worktree_path, timeoutMs: 15_000 });
        if (abortRes.exitCode !== 0) {
          emitRunLog({
            runId,
            laneId: lane.id,
            message: `Failed to auto-abort rebase: ${abortRes.stderr.trim() || "unknown error"}`
          });
        }

        // Capture postHeadSha AFTER abort so it reflects the actual HEAD
        // (reverted to pre-rebase state), not the mid-conflict partial rebase.
        laneItem.postHeadSha = await getHeadSha(lane.worktree_path);

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
      if (run.state === "completed" && persistBaseBranch && target.base_ref !== baseBranchOverride) {
        db.run(
          "update lanes set parent_lane_id = null, base_ref = ? where id = ? and project_id = ?",
          [baseBranchOverride, target.id, projectId],
        );
        invalidateLaneListCache();
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

      if (run.rootBaseRefBefore && run.rootBaseRefAfter && run.rootBaseRefBefore !== run.rootBaseRefAfter) {
        db.run(
          "update lanes set base_ref = ? where id = ? and project_id = ?",
          [run.rootBaseRefBefore, run.rootLaneId, projectId],
        );
        invalidateLaneListCache();
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
      const persistedParentLaneId = newParent.lane_type === "primary" ? null : newParent.id;
      const preHeadSha = await getHeadSha(lane.worktree_path);
      const newParentTarget = await resolveParentRebaseTarget({ projectRoot, parent: newParent });
      const newParentHead = newParentTarget.headSha;

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
        [persistedParentLaneId, newBaseRef, lane.id, projectId]
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

    unarchive({ laneId }: { laneId: string }): void {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      db.run("update lanes set status = 'active', archived_at = null where id = ? and project_id = ?", [laneId, projectId]);
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

      const lanePackDir = path.join(resolveAdeLayout(projectRoot).packsDir, "lanes", laneId);
      try {
        fs.rmSync(lanePackDir, { recursive: true, force: true });
      } catch {
        // ignore pack folder cleanup failures
      }

      db.run("update lanes set parent_lane_id = null where parent_lane_id = ? and project_id = ?", [laneId, projectId]);
      db.run("delete from pr_group_members where lane_id = ?", [laneId]);
      // Explicitly delete child rows that rely on FK cascade — CRR conversion can
      // strip checked foreign keys, leaving orphaned rows if we only rely on CASCADE.
      db.run("delete from pr_convergence_state where pr_id in (select id from pull_requests where lane_id = ? and project_id = ?)", [laneId, projectId]);
      db.run("delete from pr_pipeline_settings where pr_id in (select id from pull_requests where lane_id = ? and project_id = ?)", [laneId, projectId]);
      db.run("delete from pr_issue_inventory where pr_id in (select id from pull_requests where lane_id = ? and project_id = ?)", [laneId, projectId]);
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

    invalidateCache(): void {
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
      const laneName = (args.name ?? "").trim();
      if (!laneName) throw new Error("Lane name is required");

      const attachedPath = normAbs(args.attachedPath);
      if (!fs.existsSync(attachedPath) || !fs.statSync(attachedPath).isDirectory()) {
        throw new Error("Attached lane path must be an existing directory");
      }
      await ensureAttachableWorktreeRoot(attachedPath);

      const branchRef = await detectBranchRef(attachedPath, defaultBaseRef);
      const existingPath = db.get<{ id: string; name: string; status: string }>(
        "select id, name, status from lanes where project_id = ? and worktree_path = ? limit 1",
        [projectId, attachedPath]
      );
      if (existingPath?.id) {
        if (existingPath.status === "archived") {
          throw new Error(`This worktree is already linked as archived lane '${existingPath.name}'. Unarchive it instead.`);
        }
        throw new Error(`This worktree is already linked as lane '${existingPath.name}'.`);
      }

      const existingBranch = db.get<{ id: string; name: string; status: string; worktree_path: string }>(
        "select id, name, status, worktree_path from lanes where project_id = ? and branch_ref = ? limit 1",
        [projectId, branchRef]
      );
      if (existingBranch?.id && normAbs(existingBranch.worktree_path) !== attachedPath) {
        if (existingBranch.status === "archived") {
          throw new Error(`Branch '${branchRef}' is already linked to archived lane '${existingBranch.name}'. Unarchive it instead.`);
        }
        throw new Error(`Branch '${branchRef}' is already linked to lane '${existingBranch.name}'.`);
      }

      const laneId = randomUUID();
      const now = new Date().toISOString();

      const parentLaneId = null;
      const baseRef = defaultBaseRef;

      db.run(
        `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'attached', ?, ?, ?, ?, 0, ?, null, null, null, 'active', ?, null)
      `,
        [laneId, projectId, laneName, args.description ?? null, baseRef, branchRef, attachedPath, attachedPath, parentLaneId, now]
      );
      invalidateLaneListCache();

      // Best-effort push to establish upstream if not already tracking a remote
      try {
        const upstreamCheck = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: attachedPath, timeoutMs: 5_000 });
        if (upstreamCheck.exitCode !== 0) {
          await runGit(["push", "-u", "origin", branchRef], { cwd: attachedPath, timeoutMs: 60_000 });
        }
      } catch {
        // Non-fatal: lane works locally even without remote tracking
      }

      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Failed to attach lane: ${laneId}`);
      const rowsById = getRowsById(true);
      const status = await computeLaneStatus(attachedPath, baseRef, branchRef);
      const parentRow = parentLaneId ? getLaneRow(parentLaneId) : null;
      const parentStatus = parentRow
        ? await computeLaneStatus(parentRow.worktree_path, parentRow.base_ref, parentRow.branch_ref)
        : null;
      return toLaneSummary({
        row,
        status,
        parentStatus,
        childCount: 0,
        stackDepth: computeStackDepth({ laneId, rowsById, memo: new Map() })
      });
    },

    async adoptAttached(args: AdoptAttachedLaneArgs): Promise<LaneSummary> {
      const laneId = (args.laneId ?? "").trim();
      if (!laneId) throw new Error("laneId is required");

      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type !== "attached") {
        throw new Error("Only attached lanes can be moved into .ade/worktrees");
      }
      if (row.status === "archived") {
        throw new Error("Archived lanes cannot be moved. Unarchive first.");
      }

      const currentPath = normAbs(row.worktree_path);
      if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
        throw new Error("Attached worktree path no longer exists on disk");
      }
      await ensureAttachableWorktreeRoot(currentPath);

      const slug = slugify(row.name);
      const defaultTarget = path.join(worktreesDir, `${slug}-${laneId.slice(0, 8)}`);
      const normalizedWorktreesDir = normAbs(worktreesDir);
      let targetPath = normAbs(defaultTarget);

      if (!isWithinDir(normalizedWorktreesDir, targetPath)) {
        throw new Error("Failed to resolve destination under .ade/worktrees");
      }

      if (currentPath !== targetPath) {
        if (fs.existsSync(targetPath)) {
          targetPath = normAbs(path.join(worktreesDir, `${slug}-${randomUUID().slice(0, 8)}`));
        }
        const existingTarget = db.get<{ id: string; name: string }>(
          "select id, name from lanes where project_id = ? and worktree_path = ? and id != ? limit 1",
          [projectId, targetPath, laneId]
        );
        if (existingTarget?.id) {
          throw new Error(`Destination path is already in use by lane '${existingTarget.name}'.`);
        }

        await runGitOrThrow(["worktree", "move", currentPath, targetPath], {
          cwd: projectRoot,
          timeoutMs: 120_000
        });
      }

      db.run(
        `
          update lanes
          set lane_type = 'worktree',
              worktree_path = ?,
              attached_root_path = null
          where id = ? and project_id = ?
        `,
        [targetPath, laneId, projectId]
      );
      invalidateLaneListCache();

      const updated = getLaneRow(laneId);
      if (!updated) throw new Error(`Failed to update lane: ${laneId}`);

      const rowsById = getRowsById(true);
      const parent = updated.parent_lane_id ? rowsById.get(updated.parent_lane_id) ?? null : null;
      const status = await computeLaneStatus(updated.worktree_path, updated.base_ref, updated.branch_ref);
      const parentStatus = parent
        ? await computeLaneStatus(parent.worktree_path, parent.base_ref, parent.branch_ref)
        : null;

      return toLaneSummary({
        row: updated,
        status,
        parentStatus,
        childCount: getChildrenRows(updated.id, false).length,
        stackDepth: computeStackDepth({ laneId: updated.id, rowsById, memo: new Map() })
      });
    },

  };
}
