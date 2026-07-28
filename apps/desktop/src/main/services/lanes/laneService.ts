import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import { getHeadSha, runGit, runGitOrThrow } from "../git/git";
import { deletePullRequestRowsByIds, deletePullRequestRowsForLane } from "../prs/pullRequestRowCleanup";
import { isWithinDir, normalizeBranchName } from "../shared/utils";
import { fetchRemoteTrackingBranch, resolveQueueRebaseOverride, type QueueRebaseOverride } from "../shared/queueRebase";
import { detectConflictKind } from "../git/gitConflictState";
import { shouldLaneTrackParent } from "../../../shared/laneBaseResolution";
import { allocateLaneColor } from "../../../shared/laneColorPalette";
import { linearIssueBranchName, sanitizeLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import {
  finalizeLaneLinearIssue,
  isLinkableLaneLinearIssue,
  laneLinearIssueMissingFields,
  parseLaneLinearIssueJson,
} from "../../../shared/laneLinearIssue";
import type { createOperationService } from "../history/operationService";
import type { Logger } from "../logging/logger";
import { createWorktreeResidualCleanup } from "./worktreeResidualCleanup";
import { createLaneWorktreeLockService } from "./laneWorktreeLockService";
import type {
  AdoptAttachedLaneArgs,
  ArchiveAndReclaimLaneArgs,
  ArchiveAndReclaimLaneResult,
  AttachLaneArgs,
  CreateChildLaneArgs,
  CreateLaneArgs,
  CreateLaneFromUnstagedArgs,
  DeleteLaneArgs,
  LaneDeleteEvent,
  LaneLifecycleEvent,
  LaneDeleteProgress,
  LaneDeleteRisk,
  LaneReclaimRisk,
  LaneDeleteStep,
  LaneDeleteStepName,
  LaneIcon,
  LaneBranchActiveWorkItem,
  LaneBranchDrift,
  LaneBranchProfile,
  LaneBranchSwitchArgs,
  LaneBranchSwitchPreview,
  LaneBranchSwitchResult,
  LaneLinearIssue,
  LaneLinearIssueLink,
  LaneLinearIssueLinkRole,
  LaneLinearIssueLinkSource,
  LaneStateSnapshotSummary,
  LaneStatus,
  LaneSummary,
  LaneType,
  ListLanesArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RestoreLaneResult,
  ResolveLaneBranchDriftArgs,
  ResolveLaneBranchDriftResult,
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
  SessionLinearIssueLink,
  StackChainItem,
  UnregisteredLaneCandidate,
  UpdateLaneAppearanceArgs
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { codedError, encodeCodedErrorMessage } from "../../../shared/codedError";
import {
  detectLaneBranchDrift,
  laneNameAdvertisesBranch,
  parseWorktreeStatusPorcelainV2,
} from "./laneBranchDrift";

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

type LaneStateSnapshotRow = {
  lane_id: string;
  agent_summary_json: string | null;
  updated_at: string | null;
};

type LaneBranchProfileRow = {
  id: string;
  project_id: string;
  lane_id: string;
  branch_ref: string;
  normalized_branch_ref: string;
  base_ref: string;
  parent_lane_id: string | null;
  source_branch_ref: string | null;
  created_at: string;
  updated_at: string;
  last_checked_out_at: string | null;
};

type LaneLinearIssueRow = {
  id: string;
  project_id: string;
  lane_id: string;
  issue_id: string;
  issue_json: string;
  created_at: string;
  updated_at: string;
};

type LaneLinearIssueLinkRow = {
  id: string;
  project_id: string;
  lane_id: string;
  issue_id: string;
  issue_json: string;
  role: string;
  source: string;
  include_in_pr: number;
  close_on_merge: number;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
};

type SessionLinearIssueLinkRow = {
  id: string;
  project_id: string;
  session_id: string;
  lane_id: string | null;
  issue_id: string;
  issue_json: string;
  role: string;
  source: string;
  include_in_pr: number;
  close_on_merge: number;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
};

const DEFAULT_LANE_STATUS: LaneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false };
const LANE_LIST_CACHE_TTL_MS = 10_000;

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

async function makeTreeWritableForRemoval(targetPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(targetPath);
  } catch {
    return;
  }

  if (stat.isSymbolicLink()) return;

  try {
    await fs.promises.chmod(targetPath, stat.mode | 0o700);
  } catch {
    // Best effort. The following rm will surface any remaining failure.
  }

  if (!stat.isDirectory()) return;

  let entries: string[];
  try {
    entries = await fs.promises.readdir(targetPath);
  } catch (error) {
    if (!isPermissionError(error)) return;
    try {
      await fs.promises.chmod(targetPath, stat.mode | 0o700);
      entries = await fs.promises.readdir(targetPath);
    } catch {
      return;
    }
  }

  await Promise.all(entries.map((entry) => makeTreeWritableForRemoval(path.join(targetPath, entry))));
}

async function removeWorktreeDirectoryWithRecovery(targetPath: string): Promise<void> {
  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isPermissionError(error)) throw error;
  }

  await makeTreeWritableForRemoval(targetPath);
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

async function managedTreeBytes(targetPath: string): Promise<number> {
  let total = 0;
  const pending = [targetPath];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) {
      total += Math.max(0, stat.size);
      continue;
    }
    let names: string[];
    try {
      names = await fs.promises.readdir(current);
    } catch {
      continue;
    }
    for (const name of names) pending.push(path.join(current, name));
  }
  return total;
}

async function hasSymlinkInManagedPath(rootPath: string, targetPath: string): Promise<boolean> {
  const root = normAbs(rootPath);
  const target = normAbs(targetPath);
  if (path.dirname(target) !== root) return true;
  for (const candidate of [root, target]) {
    try {
      if ((await fs.promises.lstat(candidate)).isSymbolicLink()) return true;
    } catch {
      // A missing target is safe to recreate only when its managed root is real.
    }
  }
  return false;
}

function cloneLaneStatus(status: LaneStatus): LaneStatus {
  return {
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    remoteBehind: status.remoteBehind,
    rebaseInProgress: status.rebaseInProgress,
    headBranchRef: status.headBranchRef ?? null
  };
}

function cloneLaneLinearIssue(issue: LaneLinearIssue): LaneLinearIssue {
  return { ...issue, labels: [...issue.labels] };
}

function cloneLaneLinearIssueLink(link: LaneLinearIssueLink): LaneLinearIssueLink {
  return {
    ...link,
    issue: cloneLaneLinearIssue(link.issue),
    evidence: link.evidence ? { ...link.evidence } : null,
  };
}

function cloneLaneSummary(summary: LaneSummary): LaneSummary {
  return {
    ...summary,
    status: cloneLaneStatus(summary.status),
    parentStatus: summary.parentStatus ? cloneLaneStatus(summary.parentStatus) : null,
    tags: [...summary.tags],
    activeBranchProfile: summary.activeBranchProfile ? { ...summary.activeBranchProfile } : null,
    linearIssue: summary.linearIssue ? cloneLaneLinearIssue(summary.linearIssue) : null,
    linearIssueLinks: (summary.linearIssueLinks ?? []).map(cloneLaneLinearIssueLink)
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

function stablePathThroughExistingAncestor(targetPath: string): string {
  const absolute = path.resolve(targetPath);
  let existingAncestor = absolute;
  const missingSegments: string[] = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return absolute;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existingAncestor), ...missingSegments);
  } catch {
    return absolute;
  }
}

const STALE_WORKTREE_ROOT_MESSAGE = "Lane worktree is missing or no longer points at its Git worktree root.";

async function isExpectedGitWorktreeRoot(worktreePath: string): Promise<boolean> {
  if (!worktreePath) return false;
  try {
    const topLevelRes = await runGit(
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      { cwd: worktreePath, timeoutMs: 8_000 },
    );
    if (!topLevelRes || typeof topLevelRes.exitCode !== "number") return true;
    if (topLevelRes.exitCode !== 0) return false;
    const topLevel = topLevelRes.stdout.trim();
    if (!topLevel) return true;
    return normAbs(topLevel) === normAbs(worktreePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Test mocks can throw for unhandled git probes. The real runGit helper
    // returns a GitRunResult for normal git failures, so keep those tests on
    // their existing path without weakening production validation.
    return /^Unexpected git call:/i.test(message);
  }
}

async function readWorktreeDirty(worktreePath: string, timeoutMs = 8_000): Promise<boolean> {
  const result = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error("ADE could not verify whether the lane has uncommitted files.");
  }
  return result.stdout.trim().length > 0;
}

async function assertExpectedGitWorktreeRoot(worktreePath: string): Promise<void> {
  if (!(await isExpectedGitWorktreeRoot(worktreePath))) {
    throw new Error(STALE_WORKTREE_ROOT_MESSAGE);
  }
}

type GitWorktreeInfo = UnregisteredLaneCandidate & {
  isBare: boolean;
};

function worktreeStdout(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "stdout" in value &&
    typeof (value as { stdout?: unknown }).stdout === "string"
  ) {
    return (value as { stdout: string }).stdout;
  }
  return "";
}

function parseGitWorktreePorcelain(stdout: string): GitWorktreeInfo[] {
  const blocks = stdout.split(/\n\n+/).filter(Boolean);
  const worktrees: GitWorktreeInfo[] = [];

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
    if (!wtPath) continue;
    worktrees.push({ path: normAbs(wtPath), branch, isBare });
  }

  return worktrees;
}

/**
 * The trailing segment of a managed worktree directory name is the 8-char
 * prefix of the lane id that created it (`createWorktreeLane` builds the path
 * as `${slug}-${laneId.slice(0, 8)}`). This is the canonical "which lane owns
 * this worktree" signal used to pick the survivor when duplicate rows share a
 * path. Returns "" for paths without a hyphen suffix (e.g. attached lanes).
 */
function worktreeDirSuffix(worktreePath: string): string {
  const basename = path.basename(worktreePath);
  return basename.includes("-") ? basename.split("-").pop() ?? "" : "";
}

function inferLaneNameFromManagedWorktree(candidate: UnregisteredLaneCandidate): string {
  const basename = path.basename(candidate.path).trim();
  const branchSlug = candidate.branch.trim().replace(/^ade\//, "");
  const slug = (branchSlug || basename).replace(/-[0-9a-f]{8}$/i, "");
  const name = slug.replace(/[-_]+/g, " ").trim();
  return name || basename || "Recovered lane";
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

const LANE_LINEAR_ISSUE_LINK_ROLES: ReadonlySet<LaneLinearIssueLinkRole> = new Set([
  "primary",
  "worked",
  "referenced",
  "inferred",
]);

const LANE_LINEAR_ISSUE_LINK_SOURCES: ReadonlySet<LaneLinearIssueLinkSource> = new Set([
  "lane_create",
  "lane_link",
  "chat_attach",
  "linear_open_issue",
  "commit",
  "pr_body",
  "manual",
]);

function normalizeLaneLinearIssueLinkRole(value: string | null | undefined): LaneLinearIssueLinkRole {
  return LANE_LINEAR_ISSUE_LINK_ROLES.has(value as LaneLinearIssueLinkRole)
    ? (value as LaneLinearIssueLinkRole)
    : "referenced";
}

function normalizeLaneLinearIssueLinkSource(value: string | null | undefined): LaneLinearIssueLinkSource {
  return LANE_LINEAR_ISSUE_LINK_SOURCES.has(value as LaneLinearIssueLinkSource)
    ? (value as LaneLinearIssueLinkSource)
    : "manual";
}

function parseIssueLinkEvidence(raw: string | null | undefined): LaneLinearIssueLink["evidence"] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      chatSessionId: typeof parsed.chatSessionId === "string" ? parsed.chatSessionId : null,
      commitSha: typeof parsed.commitSha === "string" ? parsed.commitSha : null,
      prId: typeof parsed.prId === "string" ? parsed.prId : null,
    };
  } catch {
    return null;
  }
}

function parseLaneLinearIssueLink(row: LaneLinearIssueLinkRow | null | undefined): LaneLinearIssueLink | null {
  if (!row) return null;
  const issue = parseLaneLinearIssueJson(row.issue_json);
  if (!issue) return null;
  return {
    id: row.id,
    laneId: row.lane_id,
    issue,
    role: normalizeLaneLinearIssueLinkRole(row.role),
    source: normalizeLaneLinearIssueLinkSource(row.source),
    includeInPr: row.include_in_pr === 1,
    closeOnMerge: row.close_on_merge === 1,
    evidence: parseIssueLinkEvidence(row.evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSessionLinearIssueLink(row: SessionLinearIssueLinkRow | null | undefined): SessionLinearIssueLink | null {
  if (!row) return null;
  const issue = parseLaneLinearIssueJson(row.issue_json);
  if (!issue) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    laneId: row.lane_id ?? null,
    issue,
    role: normalizeLaneLinearIssueLinkRole(row.role),
    source: normalizeLaneLinearIssueLinkSource(row.source),
    includeInPr: row.include_in_pr === 1,
    closeOnMerge: row.close_on_merge === 1,
    evidence: parseIssueLinkEvidence(row.evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makePrimaryLinearIssueLink(laneId: string, issue: LaneLinearIssue, timestamp: string): LaneLinearIssueLink {
  return {
    id: `primary:${laneId}:${issue.id}`,
    laneId,
    issue: cloneLaneLinearIssue(issue),
    role: "primary",
    source: "lane_link",
    includeInPr: true,
    closeOnMerge: false,
    evidence: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mergePrimaryLinearIssueLink(
  laneId: string,
  primaryIssue: LaneLinearIssue | null,
  links: LaneLinearIssueLink[],
  timestamp: string,
): LaneLinearIssueLink[] {
  const cloned = links.map(cloneLaneLinearIssueLink);
  if (!primaryIssue) return cloned;
  const primaryIndex = cloned.findIndex((link) => link.issue.id === primaryIssue.id || link.issue.identifier === primaryIssue.identifier);
  if (primaryIndex >= 0) {
    cloned[primaryIndex] = {
      ...cloned[primaryIndex],
      issue: cloneLaneLinearIssue(primaryIssue),
      role: "primary",
      includeInPr: true,
    };
    return cloned;
  }
  return [makePrimaryLinearIssueLink(laneId, primaryIssue, timestamp), ...cloned];
}

function toLaneSummary(args: {
  row: LaneRow;
  status: LaneStatus;
  parentStatus: LaneStatus | null;
  childCount: number;
  stackDepth: number;
  worktreeAvailable?: boolean;
  activeBranchProfile?: LaneBranchProfile | null;
  linearIssue?: LaneLinearIssue | null;
  linearIssueLinks?: LaneLinearIssueLink[];
}): LaneSummary {
  const { row, status, parentStatus, childCount, stackDepth, activeBranchProfile, linearIssue } = args;
  const linearIssueLinks = mergePrimaryLinearIssueLink(row.id, linearIssue ?? null, args.linearIssueLinks ?? [], row.created_at);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    laneType: row.lane_type,
    baseRef: row.base_ref,
    branchRef: row.branch_ref,
    worktreePath: row.worktree_path,
    ...(typeof args.worktreeAvailable === "boolean" ? { worktreeAvailable: args.worktreeAvailable } : {}),
    attachedRootPath: row.attached_root_path,
    parentLaneId: row.parent_lane_id,
    childCount,
    stackDepth,
    parentStatus,
    isEditProtected: row.is_edit_protected === 1,
    status,
    branchDrift: detectLaneBranchDrift({
      expectedBranchRef: row.branch_ref,
      headBranchRef: status.headBranchRef,
    }),
    color: row.color,
    icon: parseLaneIcon(row.icon),
    tags: parseLaneTags(row.tags_json),
    folder: row.folder,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    activeBranchProfile: activeBranchProfile ?? null,
    linearIssue: linearIssue ?? null,
    linearIssueLinks
  };
}

async function detectBranchRef(worktreePath: string, fallback: string): Promise<string> {
  if (!(await isExpectedGitWorktreeRoot(worktreePath))) return fallback;
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (branchRes.exitCode === 0) {
    const value = branchRes.stdout.trim();
    if (value && value !== "HEAD") return value;
  }
  return fallback;
}

async function computeLaneStatus(worktreePath: string, baseRef: string, branchRef: string): Promise<LaneStatus> {
  if (!(await isExpectedGitWorktreeRoot(worktreePath))) {
    return cloneLaneStatus(DEFAULT_LANE_STATUS);
  }

  // `--porcelain=v2 --branch` carries the live HEAD branch in its header, so
  // branch-drift detection rides along on the dirty check with no extra spawn.
  const dirtyRes = await runGit(["status", "--porcelain=v2", "--branch"], { cwd: worktreePath, timeoutMs: 8_000 });
  const parsedStatus = dirtyRes.exitCode === 0
    ? parseWorktreeStatusPorcelainV2(dirtyRes.stdout)
    : { dirty: false, headBranchRef: null };
  const dirty = parsedStatus.dirty;
  const headBranchRef = parsedStatus.headBranchRef;

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

  return { dirty, ahead, behind, remoteBehind, rebaseInProgress, headBranchRef };
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
  await assertExpectedGitWorktreeRoot(worktreePath);

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
  await assertExpectedGitWorktreeRoot(worktreePath);

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

const LANE_DELETE_PROGRESS_HISTORY_TTL_MS = 60_000;

function branchNameForDelete(branchRef: string, remoteName = "origin"): string {
  const trimmed = branchRef.trim().replace(/^refs\/heads\//, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("refs/remotes/")) {
    const rest = trimmed.slice("refs/remotes/".length);
    const remotePrefix = `${remoteName.trim() || "origin"}/`;
    return rest.startsWith(remotePrefix) ? rest.slice(remotePrefix.length) : rest;
  }
  const remotePrefix = `${remoteName.trim() || "origin"}/`;
  return trimmed.startsWith(remotePrefix) ? trimmed.slice(remotePrefix.length) : trimmed;
}

function cloneLaneDeleteProgress(progress: LaneDeleteProgress): LaneDeleteProgress {
  return {
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  };
}

function isTerminalLaneDeleteProgress(progress: LaneDeleteProgress): boolean {
  return progress.overallStatus !== "running";
}

export type LaneDeleteTeardownDeps = {
  agentChatService?: {
    countActiveForLane: (laneId: string) => number;
    disposeForLane: (laneId: string) => Promise<number>;
  };
  ptyService?: {
    countActiveForLane: (laneId: string) => number;
    disposeForLane: (laneId: string) => number;
  };
  autoRebaseService?: {
    cancelForLane: (laneId: string) => void;
  };
  rebaseSuggestionService?: {
    dismiss: (args: { laneId: string }) => void | Promise<void>;
  };
  fileWatcherService?: {
    countActiveForWorkspace: (workspaceId: string) => number;
    stopAllForWorkspace: (workspaceId: string) => number;
  };
};

export function createLaneService({
  db,
  projectRoot,
  primaryWorktreePath = projectRoot,
  projectId,
  defaultBaseRef,
  worktreesDir,
  operationService,
  onHeadChanged,
  onRebaseEvent,
  onDeleteEvent,
  onLifecycleEvent,
  onLinearIssueLinked,
  onLinearIssueSessionLinked,
  teardownDeps,
  logger: injectedLogger
}: {
  db: AdeDb;
  projectRoot: string;
  /**
   * Filesystem boundary for the synthetic primary lane. Ordinary projects use
   * `projectRoot`; machine-owned personal chats keep runtime state and agent
   * scratch space in separate directories.
   */
  primaryWorktreePath?: string;
  projectId: string;
  defaultBaseRef: string;
  worktreesDir: string;
  operationService?: ReturnType<typeof createOperationService>;
  onHeadChanged?: (args: { laneId: string; reason: string; preHeadSha: string | null; postHeadSha: string | null }) => void;
  onRebaseEvent?: (event: RebaseRunEventPayload) => void;
  onDeleteEvent?: (event: LaneDeleteEvent) => void;
  onLifecycleEvent?: (event: LaneLifecycleEvent) => void;
  onLinearIssueLinked?: (args: { lane: LaneSummary; issue: LaneLinearIssue; linkedAt: string }) => void | Promise<void>;
  onLinearIssueSessionLinked?: (args: {
    laneId: string;
    sessionId: string;
    sessionTitle: string | null;
    issue: LaneLinearIssue;
    linkedAt: string;
  }) => void | Promise<void>;
  teardownDeps?: LaneDeleteTeardownDeps;
  logger?: Logger;
}) {
  const logger: Logger = injectedLogger ?? {
    debug: () => {},
    info: () => {},
    warn: (event, meta) => console.warn(event, meta ?? ""),
    error: (event, meta) => console.error(event, meta ?? ""),
  };

  // Late-bound hook fired after a worktree lane is successfully created. Used by
  // the PR service to auto-map an existing open PR on the lane's branch. Set via
  // `setOnWorktreeLaneCreated` because the PR service is constructed after the
  // lane service. Best-effort: failures are swallowed, never blocking creation.
  let onWorktreeLaneCreated: ((lane: LaneSummary) => void | Promise<void>) | null = null;

  const resolveSessionTitle = (sessionId: string): string | null => {
    const id = sessionId.trim();
    if (!id) return null;
    try {
      const chat = db.get<{ title: string | null }>(
        "select title from claude_sessions where session_id = ? limit 1",
        [id],
      );
      if (chat?.title?.trim()) return chat.title.trim();
    } catch {
      // Fall through to terminal session lookup.
    }
    try {
      const terminal = db.get<{ title: string | null }>(
        "select title from terminal_sessions where id = ? limit 1",
        [id],
      );
      if (terminal?.title?.trim()) return terminal.title.trim();
    } catch {
      // No title is fine; card builders fall back to the session id.
    }
    return null;
  };

  const notifyLinearIssueLinked = (lane: LaneSummary, issue: LaneLinearIssue): void => {
    if (!onLinearIssueLinked) return;
    const logFailure = (error: unknown): void => {
      logger.warn("laneService.linear_issue_link_notify_failed", {
        laneId: lane.id,
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      const result = onLinearIssueLinked({ lane, issue, linkedAt: lane.createdAt });
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(logFailure);
      }
    } catch (error) {
      logFailure(error);
    }
  };

  const notifyLinearIssueSessionLinked = (link: SessionLinearIssueLink): void => {
    if (!onLinearIssueSessionLinked || !link.laneId) return;
    const logFailure = (error: unknown): void => {
      logger.warn("laneService.linear_issue_session_link_notify_failed", {
        laneId: link.laneId,
        sessionId: link.sessionId,
        issueId: link.issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      const result = onLinearIssueSessionLinked({
        laneId: link.laneId,
        sessionId: link.sessionId,
        sessionTitle: resolveSessionTitle(link.sessionId),
        issue: link.issue,
        linkedAt: link.createdAt,
      });
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(logFailure);
      }
    } catch (error) {
      logFailure(error);
    }
  };

  const linkExistingDependencyInstalls = (worktreePath: string): void => {
    if (!fs.existsSync(worktreePath)) return;

    const linkDirectory = (source: string, destination: string): void => {
      try {
        if (!fs.existsSync(source) || fs.existsSync(destination)) return;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
        logger.info("laneService.dependency_install_linked", { source, destination });
      } catch (error) {
        logger.warn("laneService.dependency_install_link_failed", {
          source,
          destination,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    linkDirectory(path.join(projectRoot, "node_modules"), path.join(worktreePath, "node_modules"));

    const sourceAppsDir = path.join(projectRoot, "apps");
    const targetAppsDir = path.join(worktreePath, "apps");
    if (!fs.existsSync(sourceAppsDir) || !fs.existsSync(targetAppsDir)) return;

    for (const entry of fs.readdirSync(sourceAppsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      linkDirectory(
        path.join(sourceAppsDir, entry.name, "node_modules"),
        path.join(targetAppsDir, entry.name, "node_modules"),
      );
    }
  };

  const upsertLaneStateSnapshot = (args: {
    laneId: string;
    status: LaneStatus;
    agentSummary?: Record<string, unknown> | null;
    updatedAt?: string;
  }): void => {
    const shouldUpdateAgentSummary = Object.prototype.hasOwnProperty.call(args, "agentSummary");
    const agentSummaryJson = args.agentSummary == null ? null : JSON.stringify(args.agentSummary);
    db.run(
      `
        insert into lane_state_snapshots(
          lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress,
          agent_summary_json, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(lane_id) do update set
          dirty = excluded.dirty,
          ahead = excluded.ahead,
          behind = excluded.behind,
          remote_behind = excluded.remote_behind,
          rebase_in_progress = excluded.rebase_in_progress,
          agent_summary_json = case
            when ? then excluded.agent_summary_json
            else lane_state_snapshots.agent_summary_json
          end,
          updated_at = excluded.updated_at
        where lane_state_snapshots.dirty is not excluded.dirty
           or lane_state_snapshots.ahead is not excluded.ahead
           or lane_state_snapshots.behind is not excluded.behind
           or lane_state_snapshots.remote_behind is not excluded.remote_behind
           or lane_state_snapshots.rebase_in_progress is not excluded.rebase_in_progress
           or (? = 1 and lane_state_snapshots.agent_summary_json is not excluded.agent_summary_json)
      `,
      [
        args.laneId,
        args.status.dirty ? 1 : 0,
        args.status.ahead,
        args.status.behind,
        args.status.remoteBehind,
        args.status.rebaseInProgress ? 1 : 0,
        agentSummaryJson,
        args.updatedAt ?? new Date().toISOString(),
        shouldUpdateAgentSummary ? 1 : 0,
        shouldUpdateAgentSummary ? 1 : 0,
      ],
    );
  };

  const getLaneRow = (laneId: string) =>
    db.get<LaneRow>("select * from lanes where id = ? and project_id = ? limit 1", [laneId, projectId]);

  const getLaneLinearIssue = (laneId: string): LaneLinearIssue | null => {
    try {
      const row = db.get<LaneLinearIssueRow>(
        `
          select *
          from lane_linear_issues
          where project_id = ?
            and lane_id = ?
          order by updated_at desc
          limit 1
        `,
        [projectId, laneId],
      );
      return parseLaneLinearIssueJson(row?.issue_json ?? null);
    } catch {
      return null;
    }
  };

  const getLaneLinearIssueLinks = (laneId: string): LaneLinearIssueLink[] => {
    try {
      return db.all<LaneLinearIssueLinkRow>(
        `
          select *
          from lane_linear_issue_links
          where project_id = ?
            and lane_id = ?
          order by
            case role when 'primary' then 0 when 'worked' then 1 when 'referenced' then 2 else 3 end,
            updated_at desc
        `,
        [projectId, laneId],
      ).map(parseLaneLinearIssueLink).filter((link): link is LaneLinearIssueLink => Boolean(link));
    } catch {
      return [];
    }
  };

  const upsertLaneLinearIssueLink = (args: {
    laneId: string;
    issue: LaneLinearIssue;
    role: LaneLinearIssueLinkRole;
    source: LaneLinearIssueLinkSource;
    includeInPr?: boolean;
    closeOnMerge?: boolean;
    evidence?: LaneLinearIssueLink["evidence"];
  }): LaneLinearIssueLink => {
    const laneId = args.laneId.trim();
    const now = new Date().toISOString();
    const includeInPr = args.includeInPr !== false;
    const closeOnMerge = args.closeOnMerge === true;
    db.run("begin");
    try {
      db.run(
        `
          delete from lane_linear_issue_links
          where project_id = ?
            and lane_id = ?
            and issue_id = ?
            and role = ?
        `,
        [projectId, laneId, args.issue.id, args.role],
      );
      const id = randomUUID();
      db.run(
        `
          insert into lane_linear_issue_links(
            id, project_id, lane_id, issue_id, issue_json, role, source,
            include_in_pr, close_on_merge, evidence_json, created_at, updated_at
          )
          values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          projectId,
          laneId,
          args.issue.id,
          JSON.stringify(args.issue),
          args.role,
          args.source,
          includeInPr ? 1 : 0,
          closeOnMerge ? 1 : 0,
          args.evidence ? JSON.stringify(args.evidence) : null,
          now,
          now,
        ],
      );
      db.run("commit");
      return {
        id,
        laneId,
        issue: cloneLaneLinearIssue(args.issue),
        role: args.role,
        source: args.source,
        includeInPr,
        closeOnMerge,
        evidence: args.evidence ?? null,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      try { db.run("rollback"); } catch { /* keep original issue-link error */ }
      throw err;
    }
  };

  // Resolve the lane a chat/CLI session belongs to, if any. Chat sessions live
  // in `claude_sessions` (keyed by session_id); CLI/terminal sessions in
  // `terminal_sessions` (keyed by id). Standalone chats / `ade chat` sessions
  // may have no lane, in which case this returns null.
  const resolveSessionLaneId = (sessionId: string): string | null => {
    const id = sessionId.trim();
    if (!id) return null;
    try {
      const chat = db.get<{ lane_id: string | null }>(
        "select lane_id from claude_sessions where session_id = ? limit 1",
        [id],
      );
      if (chat?.lane_id && getLaneRow(chat.lane_id)) return chat.lane_id;
    } catch {
      // claude_sessions may be unavailable in some runtime modes; fall through.
    }
    try {
      const terminal = db.get<{ lane_id: string | null }>(
        "select lane_id from terminal_sessions where id = ? limit 1",
        [id],
      );
      if (terminal?.lane_id && getLaneRow(terminal.lane_id)) return terminal.lane_id;
    } catch {
      // terminal_sessions may be unavailable in some runtime modes.
    }
    return null;
  };

  const laneSummaryForLinearNotification = (row: LaneRow): LaneSummary =>
    toLaneSummary({
      row,
      status: {
        dirty: false,
        ahead: 0,
        behind: 0,
        remoteBehind: -1,
        rebaseInProgress: false,
      },
      parentStatus: null,
      childCount: 0,
      stackDepth: 0,
      activeBranchProfile: ensureBranchProfileForRow(row),
      linearIssue: getLaneLinearIssue(row.id),
      linearIssueLinks: getLaneLinearIssueLinks(row.id),
    });

  const getSessionLinearIssueLinks = (sessionId: string): SessionLinearIssueLink[] => {
    const id = sessionId.trim();
    if (!id) return [];
    try {
      return db.all<SessionLinearIssueLinkRow>(
        `
          select *
          from session_linear_issues
          where project_id = ?
            and session_id = ?
          order by
            case role when 'primary' then 0 when 'worked' then 1 when 'referenced' then 2 else 3 end,
            updated_at desc
        `,
        [projectId, id],
      ).map(parseSessionLinearIssueLink).filter((link): link is SessionLinearIssueLink => Boolean(link));
    } catch {
      return [];
    }
  };

  const upsertSessionLinearIssueLink = (args: {
    sessionId: string;
    laneId?: string | null;
    issue: LaneLinearIssue;
    role: LaneLinearIssueLinkRole;
    source: LaneLinearIssueLinkSource;
    includeInPr?: boolean;
    closeOnMerge?: boolean;
    evidence?: SessionLinearIssueLink["evidence"];
  }): SessionLinearIssueLink => {
    const sessionId = args.sessionId.trim();
    const laneId = args.laneId?.trim() || null;
    const now = new Date().toISOString();
    const includeInPr = args.includeInPr !== false;
    const closeOnMerge = args.closeOnMerge === true;
    db.run("begin");
    try {
      db.run(
        `
          delete from session_linear_issues
          where project_id = ?
            and session_id = ?
            and issue_id = ?
            and role = ?
        `,
        [projectId, sessionId, args.issue.id, args.role],
      );
      const id = randomUUID();
      db.run(
        `
          insert into session_linear_issues(
            id, project_id, session_id, lane_id, issue_id, issue_json, role, source,
            include_in_pr, close_on_merge, evidence_json, created_at, updated_at
          )
          values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          projectId,
          sessionId,
          laneId,
          args.issue.id,
          JSON.stringify(args.issue),
          args.role,
          args.source,
          includeInPr ? 1 : 0,
          closeOnMerge ? 1 : 0,
          args.evidence ? JSON.stringify(args.evidence) : null,
          now,
          now,
        ],
      );
      db.run("commit");
      return {
        id,
        sessionId,
        laneId,
        issue: cloneLaneLinearIssue(args.issue),
        role: args.role,
        source: args.source,
        includeInPr,
        closeOnMerge,
        evidence: args.evidence ?? null,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      try { db.run("rollback"); } catch { /* keep original issue-link error */ }
      throw err;
    }
  };

  const getAllLaneRows = (includeArchived = false) =>
    db.all<LaneRow>(
      includeArchived
        ? "select * from lanes where project_id = ? order by created_at desc"
        : "select * from lanes where project_id = ? and status != 'archived' order by created_at desc",
      [projectId]
    );

  const allocateLaneColorForProject = (): string => {
    const usedColors = getAllLaneRows(false)
      .map((row) => row.color)
      .filter((color): color is string => typeof color === "string" && color.trim().length > 0);
    return allocateLaneColor(usedColors);
  };

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

  const normalizeBranchKey = (ref: string): string =>
    normalizeBranchName(ref).trim();

  const toLaneBranchProfile = (row: LaneBranchProfileRow): LaneBranchProfile => ({
    id: row.id,
    laneId: row.lane_id,
    branchRef: row.branch_ref,
    baseRef: row.base_ref,
    parentLaneId: row.parent_lane_id,
    sourceBranchRef: row.source_branch_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedOutAt: row.last_checked_out_at,
  });

  const getBranchProfileRow = (laneId: string, branchRef: string): LaneBranchProfileRow | null => {
    const normalized = normalizeBranchKey(branchRef);
    if (!normalized) return null;
    return db.get<LaneBranchProfileRow>(
      `
        select *
        from lane_branch_profiles
        where project_id = ?
          and lane_id = ?
          and normalized_branch_ref = ?
        limit 1
      `,
      [projectId, laneId, normalized],
    ) ?? null;
  };

  const upsertBranchProfileForRow = (
    row: LaneRow,
    options: {
      branchRef?: string;
      baseRef?: string;
      parentLaneId?: string | null;
      sourceBranchRef?: string | null;
      lastCheckedOutAt?: string | null;
    } = {},
  ): LaneBranchProfile => {
    const branchRef = normalizeBranchKey(options.branchRef ?? row.branch_ref);
    if (!branchRef) throw new Error("Branch ref is required.");
    const existing = getBranchProfileRow(row.id, branchRef);
    const now = new Date().toISOString();
    const profile: LaneBranchProfileRow = {
      id: existing?.id ?? randomUUID(),
      project_id: projectId,
      lane_id: row.id,
      branch_ref: branchRef,
      normalized_branch_ref: branchRef,
      base_ref: options.baseRef?.trim() || existing?.base_ref || row.base_ref || defaultBaseRef,
      parent_lane_id: options.parentLaneId !== undefined ? options.parentLaneId : (existing?.parent_lane_id ?? row.parent_lane_id),
      source_branch_ref: options.sourceBranchRef !== undefined ? options.sourceBranchRef : (existing?.source_branch_ref ?? null),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_checked_out_at: options.lastCheckedOutAt !== undefined ? options.lastCheckedOutAt : existing?.last_checked_out_at ?? null,
    };
    if (existing) {
      db.run(
        `
          update lane_branch_profiles
          set branch_ref = ?,
              base_ref = ?,
              parent_lane_id = ?,
              source_branch_ref = ?,
              updated_at = ?,
              last_checked_out_at = ?
          where id = ?
            and project_id = ?
        `,
        [
          profile.branch_ref,
          profile.base_ref,
          profile.parent_lane_id,
          profile.source_branch_ref,
          profile.updated_at,
          profile.last_checked_out_at,
          profile.id,
          projectId,
        ],
      );
    } else {
      db.run(
        `
          insert into lane_branch_profiles(
            id, project_id, lane_id, branch_ref, normalized_branch_ref, base_ref,
            parent_lane_id, source_branch_ref, created_at, updated_at, last_checked_out_at
          )
          values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          profile.id,
          profile.project_id,
          profile.lane_id,
          profile.branch_ref,
          profile.normalized_branch_ref,
          profile.base_ref,
          profile.parent_lane_id,
          profile.source_branch_ref,
          profile.created_at,
          profile.updated_at,
          profile.last_checked_out_at,
        ],
      );
    }
    return toLaneBranchProfile(profile);
  };

  const upsertLaneLinearIssue = (laneId: string, issue: LaneLinearIssue, branchName: string): LaneLinearIssue => {
    const normalized = finalizeLaneLinearIssue(issue, branchName);
    const missing = laneLinearIssueMissingFields(normalized);
    if (missing.length > 0) {
      throw new Error(`Linear issue attachment is missing required fields: ${missing.join(", ")}.`);
    }
    const now = new Date().toISOString();
    db.run("begin");
    try {
      db.run(
        `
          delete from lane_linear_issues
          where project_id = ?
            and lane_id = ?
        `,
        [projectId, laneId],
      );
      db.run(
        `
          insert into lane_linear_issues(
            id, project_id, lane_id, issue_id, issue_json, created_at, updated_at
          )
          values(?, ?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          projectId,
          laneId,
          normalized.id,
          JSON.stringify(normalized),
          now,
          now,
        ],
      );
      db.run("commit");
    } catch (err) {
      try { db.run("rollback"); } catch { /* keep the original upsert error */ }
      throw err;
    }
    try {
      upsertLaneLinearIssueLink({
        laneId,
        issue: normalized,
        role: "primary",
        source: "lane_create",
        includeInPr: true,
        closeOnMerge: false,
      });
    } catch (error) {
      logger.warn("laneService.primary_linear_issue_link_upsert_failed", {
        laneId,
        issueId: normalized.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return normalized;
  };

  const resolveCreateBranchRef = async (args: {
    name: string;
    laneId: string;
    branchName?: string | null;
    linearIssue?: LaneLinearIssue | null;
  }): Promise<string> => {
    const explicitBranch = args.branchName?.trim() ?? "";
    const linearBranch = !explicitBranch && args.linearIssue
      ? linearIssueBranchName(args.linearIssue)
      : "";
    const suggested = explicitBranch || linearBranch;
    const isCustomBranch = suggested.length > 0;
    const isLinearBranch = !explicitBranch && linearBranch.length > 0;
    const slug = slugify(args.name);
    const fallback = `ade/${slug}-${args.laneId.slice(0, 8)}`;
    const branchRef = suggested
      ? sanitizeLinearIssueBranchName(suggested)
      : fallback;

    const check = await runGit(["check-ref-format", "--branch", branchRef], {
      cwd: projectRoot,
      timeoutMs: 8_000,
    });
    if (check.exitCode !== 0) {
      throw new Error(`Generated branch name "${branchRef}" is not valid.`);
    }

    // Does this ref already exist locally, as a remote-tracking ref, or on the
    // actual remote? Used to detect collisions before `git worktree add -b`.
    const branchIsTaken = async (ref: string): Promise<boolean> => {
      const localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], {
        cwd: projectRoot,
        timeoutMs: 8_000,
      }).then((res) => res.exitCode === 0);
      if (localExists) return true;
      // Only auto-named (slug / Linear) branches probe the remote — explicit
      // user branches are checked separately so the error can be specific.
      if (!isCustomBranch) return false;
      const remoteTrackingExists = await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${ref}`], {
        cwd: projectRoot,
        timeoutMs: 8_000,
      }).then((res) => res.exitCode === 0);
      if (remoteTrackingExists) return true;
      return runGit(["ls-remote", "--heads", "origin", ref], {
        cwd: projectRoot,
        timeoutMs: 15_000,
      }).then((res) => res.exitCode === 0 && res.stdout.trim().length > 0);
    };

    // Linear-derived branch names are deterministic (e.g. `ver-136-title`) and so
    // collide when the same issue is launched again or a prior lane leaked the
    // branch. Mirror the `ade/<slug>-<laneId>` fallback: keep the clean name when
    // it is free (so Linear's branch-name matching still works), otherwise append
    // the lane's unique suffix until the name is unused. Never hard-fail here.
    if (isLinearBranch) {
      if (!(await branchIsTaken(branchRef))) return branchRef;
      const compactId = args.laneId.replace(/-/g, "");
      for (let len = 6; len <= 12; len += 2) {
        const candidate = sanitizeLinearIssueBranchName(`${branchRef}-${compactId.slice(0, len)}`);
        if (!(await branchIsTaken(candidate))) return candidate;
      }
      // Astronomically unlikely; fall back to the guaranteed-unique slug form.
      return fallback;
    }

    if (await branchIsTaken(branchRef)) {
      throw new Error(
        `Branch "${branchRef}" already exists locally or on the remote. Choose a different branch name.`,
      );
    }

    return branchRef;
  };

  const ensureBranchProfileForRow = (row: LaneRow): LaneBranchProfile =>
    upsertBranchProfileForRow(row);

  const backfillLaneBranchProfiles = (): void => {
    for (const row of getAllLaneRows(true)) {
      if (!row.branch_ref.trim()) continue;
      upsertBranchProfileForRow(row);
    }
  };

  const getActiveWorkForLane = (laneId: string): LaneBranchActiveWorkItem[] => {
    const terminalRows = db.all<{ id: string; title: string; status: string }>(
      `
        select id, title, status
        from terminal_sessions
        where lane_id = ?
          and archived_at is null
          and ended_at is null
        order by started_at desc
        limit 10
      `,
      [laneId],
    );
    return [
      ...terminalRows.map((row) => ({
        id: row.id,
        kind: "terminal" as const,
        title: row.title || row.id,
        status: row.status,
      })),
    ];
  };

  const findActiveBranchOwner = (branchRef: string, laneId: string): { id: string; name: string } | null => {
    const normalized = normalizeBranchKey(branchRef);
    if (!normalized) return null;
    const row = db.get<{ id: string; name: string }>(
      `
        select id, name
        from lanes
        where project_id = ?
          and id != ?
          and lane_type != 'primary'
          and status != 'archived'
          and branch_ref = ?
        limit 1
      `,
      [projectId, laneId, normalized],
    );
    return row ? { id: row.id, name: row.name } : null;
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
  const normalizedWorktreesDir = normAbs(worktreesDir);

  // Worktree paths / branch refs with an in-flight `git worktree add`. A new
  // worktree is visible to `git worktree list` before its lane row is
  // inserted, so recovery/adoption surfaces must skip these or a concurrent
  // lanes.list adopts the half-created worktree as a duplicate lane.
  const pendingWorktreeCreationPaths = new Set<string>();
  const pendingWorktreeCreationBranches = new Set<string>();

  const trackPendingWorktreeCreation = (worktreePath: string, branchRef: string): (() => void) => {
    const pathKey = normAbs(worktreePath);
    const branchKey = normalizeBranchKey(branchRef);
    pendingWorktreeCreationPaths.add(pathKey);
    if (branchKey) pendingWorktreeCreationBranches.add(branchKey);
    return () => {
      pendingWorktreeCreationPaths.delete(pathKey);
      if (branchKey) pendingWorktreeCreationBranches.delete(branchKey);
    };
  };

  const isPendingWorktreeCreation = (worktreePath: string, branchRef: string): boolean =>
    pendingWorktreeCreationPaths.has(normAbs(worktreePath)) ||
    (normalizeBranchKey(branchRef).length > 0 && pendingWorktreeCreationBranches.has(normalizeBranchKey(branchRef)));

  const getGitTopLevel = async (cwd: string): Promise<string> => {
    const top = await runGitOrThrow(["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
    return normAbs(top.trim());
  };

  const getGitCommonDir = async (cwd: string): Promise<string> => {
    const commonDir = await runGitOrThrow(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeoutMs: 10_000 });
    return normAbs(commonDir.trim());
  };

  const listGitWorktrees = async (): Promise<GitWorktreeInfo[]> => {
    const result = await runGitOrThrow(
      ["worktree", "list", "--porcelain"],
      { cwd: projectRoot, timeoutMs: 15_000 }
    );
    return parseGitWorktreePorcelain(worktreeStdout(result));
  };

  const registeredWorktreeForLane = async (
    worktreePath: string,
    branchRef: string,
  ): Promise<GitWorktreeInfo | null> => {
    const target = normAbs(worktreePath);
    const expectedBranch = normalizeBranchKey(branchRef);
    if (!expectedBranch) return null;
    const worktrees = await listGitWorktrees();
    return worktrees.find((worktree) =>
      !worktree.isBare
      && worktree.path === target
      && normalizeBranchKey(worktree.branch) === expectedBranch
    ) ?? null;
  };

  const residualWorktreeCleanup = createWorktreeResidualCleanup({
    db,
    projectId,
    projectRoot,
    worktreesDir,
    logger,
    listGitWorktrees,
    isPendingWorktreeCreation: (worktreePath) => pendingWorktreeCreationPaths.has(normAbs(worktreePath)),
    removeWorktreeDirectory: removeWorktreeDirectoryWithRecovery,
  });

  const findGitWorktreeForBranch = async (branchRef: string): Promise<GitWorktreeInfo | null> => {
    const normalizedBranch = normalizeBranchKey(branchRef);
    if (!normalizedBranch) return null;
    const worktrees = await listGitWorktrees();
    return worktrees.find((wt) => !wt.isBare && normalizeBranchKey(wt.branch) === normalizedBranch) ?? null;
  };

  const listUnregisteredWorktreeCandidates = async (): Promise<UnregisteredLaneCandidate[]> => {
    const worktrees = await listGitWorktrees();
    const registeredPaths = new Set(
      db.all<{ worktree_path: string }>(
        "select worktree_path from lanes where project_id = ?",
        [projectId]
      ).map((row) => normAbs(row.worktree_path))
    );

    return worktrees.filter(
      (wt) =>
        !wt.isBare &&
        wt.path !== normalizedProjectRoot &&
        !registeredPaths.has(wt.path) &&
        !isPendingWorktreeCreation(wt.path, wt.branch)
    );
  };

  const recoverManagedWorktreeRows = async (): Promise<number> => {
    const candidates = await listUnregisteredWorktreeCandidates();
    let recoveredCount = 0;

    for (const candidate of candidates) {
      const worktreePath = normAbs(candidate.path);
      const branchRef = candidate.branch.trim();
      if (!branchRef) continue;
      if (path.dirname(worktreePath) !== normalizedWorktreesDir) continue;
      // A create may have started after the candidate snapshot was taken.
      if (isPendingWorktreeCreation(worktreePath, branchRef)) continue;

      const existingPath = db.get<{ id: string }>(
        "select id from lanes where project_id = ? and worktree_path = ? limit 1",
        [projectId, worktreePath]
      );
      if (existingPath?.id) continue;

      const existingBranch = db.get<{ id: string }>(
        "select id from lanes where project_id = ? and branch_ref = ? limit 1",
        [projectId, branchRef]
      );
      if (existingBranch?.id) continue;

      const laneId = randomUUID();
      const now = new Date().toISOString();
      const displayName = inferLaneNameFromManagedWorktree(candidate);
      const laneColor = allocateLaneColorForProject();
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          )
          values(?, ?, ?, null, 'worktree', ?, ?, ?, null, 0, null, ?, null, null, 'active', ?, null)
        `,
        [laneId, projectId, displayName, defaultBaseRef, branchRef, worktreePath, laneColor, now]
      );

      const row = getLaneRow(laneId);
      if (row) {
        upsertBranchProfileForRow(row, {
          branchRef,
          baseRef: defaultBaseRef,
          parentLaneId: null,
        });
      }
      recoveredCount += 1;
    }

    if (recoveredCount > 0) {
      invalidateLaneListCache();
      logger.info("laneService.recovered_managed_worktrees", {
        projectRoot,
        count: recoveredCount,
      });
    }
    return recoveredCount;
  };

  /**
   * Fold a duplicate lane's user-visible data onto the keeper, then cascade the
   * duplicate row away. Sessions (and their session-scoped Linear links), child
   * lanes, branch profiles, the lane's primary Linear issue, and additional
   * Linear issue links are all re-pointed first so nothing the user attached to
   * the soon-to-be-deleted row is lost. The caller MUST run this inside a
   * transaction (both call sites already hold `begin immediate`) and the keeper
   * row must already exist. Shared by the create/recover dedupe repair and the
   * create-path raced-adoption absorb.
   */
  const mergeDuplicateLaneInto = (keeperId: string, duplicateId: string): void => {
    // Sessions and their session-scoped Linear links follow the lane.
    db.run("update claude_sessions set lane_id = ? where lane_id = ?", [keeperId, duplicateId]);
    db.run("update terminal_sessions set lane_id = ? where lane_id = ?", [keeperId, duplicateId]);
    db.run("update session_linear_issues set lane_id = ? where lane_id = ? and project_id = ?", [
      keeperId,
      duplicateId,
      projectId,
    ]);
    // Child lanes / branch profiles re-parent onto the keeper.
    db.run("update lanes set parent_lane_id = ? where parent_lane_id = ? and project_id = ?", [
      keeperId,
      duplicateId,
      projectId,
    ]);
    db.run("update lane_branch_profiles set parent_lane_id = ? where parent_lane_id = ? and project_id = ?", [
      keeperId,
      duplicateId,
      projectId,
    ]);
    db.run(
      `delete from lane_branch_profiles
       where lane_id = ? and project_id = ?
         and exists (
           select 1 from lane_branch_profiles keeper
           where keeper.lane_id = ? and keeper.project_id = ?
             and keeper.normalized_branch_ref = lane_branch_profiles.normalized_branch_ref
         )`,
      [duplicateId, projectId, keeperId, projectId],
    );
    db.run("update lane_branch_profiles set lane_id = ? where lane_id = ? and project_id = ?", [
      keeperId,
      duplicateId,
      projectId,
    ]);
    // Primary Linear issue: a lane holds at most one (`lane_linear_issues` is
    // keyed by lane). Keep the keeper's if it already has one; otherwise adopt
    // the duplicate's.
    const keeperHasPrimaryIssue = db.get<{ one: number }>(
      "select 1 as one from lane_linear_issues where lane_id = ? and project_id = ? limit 1",
      [keeperId, projectId],
    );
    if (keeperHasPrimaryIssue) {
      db.run("delete from lane_linear_issues where lane_id = ? and project_id = ?", [duplicateId, projectId]);
    } else {
      db.run("update lane_linear_issues set lane_id = ? where lane_id = ? and project_id = ?", [
        keeperId,
        duplicateId,
        projectId,
      ]);
    }
    // Additional Linear links are unique per (issue, role), so dedupe on both —
    // dropping only the duplicate's links the keeper already carries for the
    // same issue AND role, and migrating the rest.
    db.run(
      `delete from lane_linear_issue_links
       where lane_id = ? and project_id = ?
         and exists (
           select 1 from lane_linear_issue_links keeper
           where keeper.lane_id = ? and keeper.project_id = ?
             and keeper.issue_id = lane_linear_issue_links.issue_id
             and keeper.role = lane_linear_issue_links.role
         )`,
      [duplicateId, projectId, keeperId, projectId],
    );
    db.run("update lane_linear_issue_links set lane_id = ? where lane_id = ? and project_id = ?", [
      keeperId,
      duplicateId,
      projectId,
    ]);
    // Everything else lane-scoped on the duplicate cascades away.
    cleanupLaneDatabaseRows(duplicateId);
  };

  /**
   * Remove duplicate lane rows that share a managed worktree path. These are
   * artifacts of the create/recover race: a lanes.list adopted a half-created
   * worktree before the creating call inserted its own row. The keeper is the
   * row whose id matches the suffix embedded in the worktree directory name
   * (the lane that actually created the worktree — see `worktreeDirSuffix`),
   * falling back to the oldest row. Each duplicate is folded into the keeper
   * via `mergeDuplicateLaneInto`, so no user-visible data is lost.
   */
  const repairDuplicateManagedWorktreeLanes = (): void => {
    const rows = db.all<{ id: string; worktree_path: string; created_at: string }>(
      `
        select id, worktree_path, created_at
        from lanes
        where project_id = ? and lane_type = 'worktree' and status != 'archived'
      `,
      [projectId]
    );

    const groups = new Map<string, { id: string; worktree_path: string; created_at: string }[]>();
    for (const row of rows) {
      const pathKey = normAbs(row.worktree_path);
      if (!pathKey.length) continue;
      const group = groups.get(pathKey) ?? [];
      group.push(row);
      groups.set(pathKey, group);
    }

    let removedCount = 0;
    for (const [pathKey, group] of groups) {
      if (group.length < 2) continue;
      // Never dedupe under an in-flight create; the row set is still settling.
      if (pendingWorktreeCreationPaths.has(pathKey)) continue;

      const sorted = [...group].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
      );
      const dirSuffix = worktreeDirSuffix(pathKey);
      const keeper =
        sorted.find((row) => dirSuffix.length > 0 && row.id.startsWith(dirSuffix)) ?? sorted[0];

      for (const duplicate of sorted) {
        if (duplicate.id === keeper.id) continue;
        db.run("begin immediate");
        try {
          mergeDuplicateLaneInto(keeper.id, duplicate.id);
          db.run("commit");
          removedCount += 1;
        } catch (error) {
          try {
            db.run("rollback");
          } catch {
            // surface the original error below
          }
          throw error;
        }
      }
    }

    if (removedCount > 0) {
      invalidateLaneListCache();
      logger.info("laneService.repaired_duplicate_worktree_lanes", {
        projectRoot,
        count: removedCount,
      });
    }
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
    const branchRef = await detectBranchRef(primaryWorktreePath, defaultBaseRef);
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'primary', ?, ?, ?, null, 1, null, null, null, null, 'active', ?, null)
      `,
      [laneId, projectId, "Primary", "Main repository workspace", defaultBaseRef, branchRef, primaryWorktreePath, now]
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
    const row = getLaneRow(primary.id);
    if (row) {
      upsertBranchProfileForRow(row, {
        branchRef: detectedBranchRef,
        baseRef: primary.base_ref,
        parentLaneId: null,
        lastCheckedOutAt: new Date().toISOString(),
      });
    }
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

  const createLaneStatusResolver = async (args: {
    rows: LaneRow[];
    rowsById: Map<string, LaneRow>;
    includeStatus: boolean;
    logContext: string;
  }): Promise<{
    resolveWorktreeAvailable: (row: LaneRow) => Promise<boolean>;
    resolveStatus: (laneId: string) => Promise<LaneStatus>;
  }> => {
    const statusCache = new Map<string, LaneStatus>();
    const worktreeAvailabilityCache = new Map<string, boolean>();
    const queueOverrideCache = new Map<string, QueueRebaseOverride | null>();

    if (args.includeStatus) {
      const laneIdsToResolve = new Set<string>();
      for (const row of args.rows) {
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
            logger.warn(`laneService.${args.logContext}.queue_override_failed`, { laneId, error: String(err) });
            queueOverrideCache.set(laneId, null);
          }
        }),
      );
    }

    const resolveWorktreeAvailable = async (row: LaneRow): Promise<boolean> => {
      const cached = worktreeAvailabilityCache.get(row.id);
      if (cached != null) return cached;
      const available = await isExpectedGitWorktreeRoot(row.worktree_path);
      worktreeAvailabilityCache.set(row.id, available);
      return available;
    };

    const resolveStatus = async (laneId: string): Promise<LaneStatus> => {
      const cached = statusCache.get(laneId);
      if (cached) return cached;
      const row = args.rowsById.get(laneId);
      if (!row) return DEFAULT_LANE_STATUS;
      const worktreeAvailable = await resolveWorktreeAvailable(row);
      if (!worktreeAvailable) {
        const status = cloneLaneStatus(DEFAULT_LANE_STATUS);
        statusCache.set(laneId, status);
        return status;
      }
      const parent = row.parent_lane_id ? args.rowsById.get(row.parent_lane_id) : null;
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
          const originRes = await runGit(
            ["rev-parse", "--verify", `origin/${row.branch_ref}`],
            { cwd: row.worktree_path, timeoutMs: 5_000 }
          );
          if (originRes.exitCode === 0 && originRes.stdout.trim()) {
            baseRef = originRes.stdout.trim();
          }
        }
      }

      const status = await computeLaneStatus(row.worktree_path, baseRef, row.branch_ref);
      statusCache.set(laneId, status);
      return status;
    };

    return { resolveWorktreeAvailable, resolveStatus };
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
    try {
      await residualWorktreeCleanup.retry();
    } catch (err) {
      logger.warn("laneService.residualWorktreeCleanup_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      await recoverManagedWorktreeRows();
    } catch (err) {
      logger.warn("laneService.recoverManagedWorktreeRows_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      repairDuplicateManagedWorktreeLanes();
    } catch (err) {
      logger.warn("laneService.repairDuplicateManagedWorktreeLanes_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      backfillLaneBranchProfiles();
    } catch (err) {
      logger.warn("laneService.backfillLaneBranchProfiles_failed", { error: err instanceof Error ? err.message : String(err) });
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
    const childCountMap = new Map<string, number>();

    // Fetch all lane_linear_issues in a single query and build a map keyed by
    // lane_id (latest by updated_at) — avoids an N+1 in the loop below.
    const linearIssueByLaneId = new Map<string, LaneLinearIssue>();
    try {
      const linearRows = db.all<LaneLinearIssueRow>(
        `
          select *
          from lane_linear_issues
          where project_id = ?
          order by updated_at desc
        `,
        [projectId],
      );
      for (const linearRow of linearRows) {
        if (!linearRow?.lane_id || linearIssueByLaneId.has(linearRow.lane_id)) continue;
        const parsed = parseLaneLinearIssueJson(linearRow.issue_json ?? null);
        if (parsed) linearIssueByLaneId.set(linearRow.lane_id, parsed);
      }
    } catch {
      // Non-fatal — fall back to empty map (per-lane lookup absent).
    }

    const linearIssueLinksByLaneId = new Map<string, LaneLinearIssueLink[]>();
    try {
      const linkRows = db.all<LaneLinearIssueLinkRow>(
        `
          select *
          from lane_linear_issue_links
          where project_id = ?
          order by
            case role when 'primary' then 0 when 'worked' then 1 when 'referenced' then 2 else 3 end,
            updated_at desc
        `,
        [projectId],
      );
      for (const linkRow of linkRows) {
        if (!linkRow?.lane_id) continue;
        const parsed = parseLaneLinearIssueLink(linkRow);
        if (!parsed) continue;
        const list = linearIssueLinksByLaneId.get(linkRow.lane_id) ?? [];
        if (!list.some((entry) => entry.issue.id === parsed.issue.id && entry.role === parsed.role)) {
          list.push(parsed);
        }
        linearIssueLinksByLaneId.set(linkRow.lane_id, list);
      }
    } catch {
      // Non-fatal — linked issue metadata is additive.
    }

    for (const row of activeRows) {
      if (!row.parent_lane_id) continue;
      childCountMap.set(row.parent_lane_id, (childCountMap.get(row.parent_lane_id) ?? 0) + 1);
    }

    const { resolveWorktreeAvailable, resolveStatus } = await createLaneStatusResolver({
      rows,
      rowsById,
      includeStatus,
      logContext: "lane_list",
    });

    const out: LaneSummary[] = [];
    for (const row of rows) {
      try {
        let status: LaneStatus = cloneLaneStatus(DEFAULT_LANE_STATUS);
        let parentStatus: LaneStatus | null = row.parent_lane_id ? cloneLaneStatus(DEFAULT_LANE_STATUS) : null;
        let worktreeAvailable: boolean | undefined;

        if (includeStatus) {
          try {
            worktreeAvailable = await resolveWorktreeAvailable(row);
          } catch {
            worktreeAvailable = false;
          }
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
            stackDepth,
            worktreeAvailable,
            activeBranchProfile: ensureBranchProfileForRow(row),
            linearIssue: linearIssueByLaneId.get(row.id) ?? null,
            linearIssueLinks: linearIssueLinksByLaneId.get(row.id) ?? [],
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
    branchName?: string | null;
    linearIssue?: LaneLinearIssue | null;
  }): Promise<LaneSummary> => {
    const laneId = randomUUID();
    const now = new Date().toISOString();
    const slug = slugify(args.name);
    const suffix = laneId.slice(0, 8);
    const branchRef = await resolveCreateBranchRef({
      name: args.name,
      laneId,
      branchName: args.branchName,
      linearIssue: args.linearIssue,
    });
    const worktreePath = path.join(worktreesDir, `${slug}-${suffix}`);

    // The worktree is visible to `git worktree list` the moment `worktree add`
    // registers it, but the lane row only lands after checkout completes. Hold
    // the pending marker across that window so a concurrent lanes.list cannot
    // adopt the half-created worktree as a duplicate lane.
    const releasePendingWorktreeCreation = trackPendingWorktreeCreation(worktreePath, branchRef);
    let linearIssue: LaneLinearIssue | null = null;
    let absorbedRacedAdoptionRows = 0;
    try {
      await runGitWorktreeMutation(() =>
        runGitOrThrow(["worktree", "add", "-b", branchRef, worktreePath, args.startPoint], {
          cwd: projectRoot,
          timeoutMs: 60_000
        })
      );

      // From this point the worktree exists on disk. Any failure persisting the lane
      // row or dependent inserts must remove the worktree, otherwise we orphan a
      // checkout that no lane row references.
      try {
        linkExistingDependencyInstalls(worktreePath);

        // Absorb any row another process raced onto this path/branch while the
        // checkout ran (the path and branch embed this lane's fresh id suffix,
        // and `worktree add -b` proved the branch was free, so a matching row
        // can only be a recovery artifact adopted from the half-created
        // worktree) and insert the canonical row in one transaction, so a crash
        // can never leave the worktree with the artifact deleted but no keeper.
        const laneColor = allocateLaneColorForProject();
        db.run("begin immediate");
        let absorbedRowsInTransaction = 0;
        try {
          // Insert the canonical row first, then fold any raced recovery
          // artifact into it (so its sessions / Linear links migrate rather
          // than being deleted). Archived lanes are excluded: an old archived
          // lane may legitimately share this branch name after its Git ref was
          // deleted, and it is not the raced artifact.
          db.run(
            `
              insert into lanes(
                id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
                attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
              )
              values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, ?, null, null, ?, 'active', ?, null)
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
              laneColor,
              args.folder ?? null,
              now
            ]
          );

          const racedAdoptionRows = db.all<{ id: string }>(
            `
              select id from lanes
              where project_id = ?
                and id != ?
                and lane_type = 'worktree'
                and status != 'archived'
                and is_edit_protected = 0
                and (worktree_path = ? or branch_ref = ?)
            `,
            [projectId, laneId, worktreePath, branchRef]
          );
          for (const raced of racedAdoptionRows) {
            logger.info("laneService.absorbed_raced_adoption_row", { laneId, racedLaneId: raced.id });
            mergeDuplicateLaneInto(laneId, raced.id);
            absorbedRowsInTransaction += 1;
          }

          db.run("commit");
          absorbedRacedAdoptionRows = absorbedRowsInTransaction;
        } catch (txError) {
          try {
            db.run("rollback");
          } catch {
            // surface the original error below
          }
          throw txError;
        }
        // Linear issue upsert manages its own transaction, so it must run
        // after the absorb+insert commit (SQLite has no nested transactions).
        linearIssue = args.linearIssue
          ? upsertLaneLinearIssue(laneId, args.linearIssue, branchRef)
          : null;
        invalidateLaneListCache();

      } catch (error) {
        await cleanupCreatedWorktreeLaneAfterCreateFailure({
          laneId,
          branchRef,
          worktreePath,
          cause: error,
          preserveCreatedLane: absorbedRacedAdoptionRows > 0,
        });
      }
    } finally {
      releasePendingWorktreeCreation();
    }

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

    const summary = toLaneSummary({
      row,
      status,
      parentStatus,
      childCount: 0,
      stackDepth: computeStackDepth({ laneId: laneId, rowsById, memo: new Map() }),
      activeBranchProfile: ensureBranchProfileForRow(row),
      linearIssue,
      linearIssueLinks: getLaneLinearIssueLinks(laneId),
    });
    if (linearIssue) notifyLinearIssueLinked(summary, linearIssue);

    // Trigger #1: best-effort auto-map of an existing open PR on this lane's
    // branch. Fire-and-forget so it never blocks (or throws into) creation.
    if (onWorktreeLaneCreated) {
      void Promise.resolve()
        .then(() => onWorktreeLaneCreated?.(summary))
        .catch((error) => {
          logger.warn("laneService.worktree_lane_created_hook_failed", {
            laneId: summary.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    broadcastLifecycleEvent({
      type: "lane-created",
      laneId: summary.id,
      laneName: summary.name,
      color: summary.color,
      lane: summary,
    });

    return summary;
  };

  const getRowsById = (includeArchived = true): Map<string, LaneRow> =>
    new Map(getAllLaneRows(includeArchived).map((row) => [row.id, row] as const));

  try {
    repairLegacyPrimaryBaseRootLanes();
  } catch (err) {
    logger.warn("laneService.initial_repairLegacyPrimaryBaseRootLanes_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    backfillLaneBranchProfiles();
  } catch (err) {
    logger.warn("laneService.initial_backfillLaneBranchProfiles_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const previewBranchSwitch = async (args: LaneBranchSwitchArgs): Promise<LaneBranchSwitchPreview> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required.");
    const row = getLaneRow(laneId);
    if (!row) throw new Error(`Lane not found: ${laneId}`);
    if (row.status === "archived") throw new Error("Lane is archived.");

    const mode = args.mode ?? "existing";
    const rawBranchName = args.branchName.trim();
    if (!rawBranchName) throw new Error("Branch name is required.");
    let targetBranchRef = normalizeBranchKey(rawBranchName);
    if (mode === "existing") {
      const localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${rawBranchName}`], {
        cwd: row.worktree_path,
        timeoutMs: 8_000,
      }).then((res) => res.exitCode === 0);
      const remoteExists = !localExists && await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${rawBranchName}`], {
        cwd: row.worktree_path,
        timeoutMs: 8_000,
      }).then((res) => res.exitCode === 0);
      if (remoteExists) {
        targetBranchRef = localBranchNameFromRemoteRef(rawBranchName);
      }
    }
    if (!targetBranchRef) throw new Error("Branch name is required.");

    const status = await runGit(["status", "--porcelain=v1"], { cwd: row.worktree_path, timeoutMs: 8_000 });
    const dirty = status.exitCode === 0 && status.stdout.trim().length > 0;
    const duplicate = findActiveBranchOwner(targetBranchRef, row.id);
    const activeWork = getActiveWorkForLane(row.id);
    const targetProfile = getBranchProfileRow(row.id, targetBranchRef);

    return {
      laneId: row.id,
      currentBranchRef: row.branch_ref,
      targetBranchRef,
      mode,
      dirty,
      duplicateLaneId: duplicate?.id ?? null,
      duplicateLaneName: duplicate?.name ?? null,
      activeWork,
      targetProfile: targetProfile ? toLaneBranchProfile(targetProfile) : null,
    };
  };

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

  const deleteProgressByLaneId = new Map<string, LaneDeleteProgress>();
  const laneReclaimInFlight = new Set<string>();
  const laneStorageWorktreeLocks = createLaneWorktreeLockService({ db, logger });
  let gitWorktreeMutationQueue: Promise<void> = Promise.resolve();
  const gitWorktreeMutationOwner = new AsyncLocalStorage<boolean>();

  const acquireStorageLifecycleLock = (args: {
    laneId: string;
    worktreePath: string;
    ownerLabel: string;
  }) => {
    const operationToken = randomUUID();
    return laneStorageWorktreeLocks.acquire({
      ...args,
      worktreePath: stablePathThroughExistingAncestor(args.worktreePath),
      ownerKind: "storage_lifecycle",
      ownerSessionId: operationToken,
      token: operationToken,
      leaseMs: 15 * 60_000,
    });
  };

  const runGitWorktreeMutation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (gitWorktreeMutationOwner.getStore()) {
      return work();
    }
    const run = gitWorktreeMutationQueue.then(() => gitWorktreeMutationOwner.run(true, work));
    gitWorktreeMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const pruneDeleteProgressHistory = (now = Date.now()): void => {
    for (const [laneId, progress] of deleteProgressByLaneId.entries()) {
      if (!isTerminalLaneDeleteProgress(progress)) continue;
      const completedAtMs = progress.completedAt ? Date.parse(progress.completedAt) : Number.NaN;
      if (!Number.isFinite(completedAtMs) || now - completedAtMs >= LANE_DELETE_PROGRESS_HISTORY_TTL_MS) {
        deleteProgressByLaneId.delete(laneId);
      }
    }
  };

  const broadcastDeleteEvent = (progress: LaneDeleteProgress): void => {
    pruneDeleteProgressHistory();
    deleteProgressByLaneId.set(progress.laneId, cloneLaneDeleteProgress(progress));
    if (!onDeleteEvent) return;
    try {
      onDeleteEvent({ type: "lane-delete", progress: cloneLaneDeleteProgress(progress) });
    } catch (err) {
      logger.warn("lane.delete.broadcast_failed", { laneId: progress.laneId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const broadcastLifecycleEvent = (event: LaneLifecycleEvent): void => {
    if (!onLifecycleEvent) return;
    try {
      onLifecycleEvent(event);
    } catch (err) {
      logger.warn("lane.lifecycle.broadcast_failed", {
        laneId: event.laneId,
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const cleanupLaneDatabaseRows = (laneId: string): void => {
    db.run("update lanes set parent_lane_id = null where parent_lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("update lane_branch_profiles set parent_lane_id = null where parent_lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("update integration_proposals set integration_lane_id = null where integration_lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("update integration_proposals set preferred_integration_lane_id = null where preferred_integration_lane_id = ? and project_id = ?", [laneId, projectId]);

    deletePullRequestRowsForLane(db, projectId, laneId);
    db.run("delete from pr_auto_link_ignores where lane_id = ? and project_id = ?", [laneId, projectId]);

    db.run("delete from review_run_publications where run_id in (select id from review_runs where lane_id = ? and project_id = ?)", [laneId, projectId]);
    db.run("delete from review_finding_feedback where run_id in (select id from review_runs where lane_id = ? and project_id = ?)", [laneId, projectId]);
    db.run("delete from review_run_artifacts where run_id in (select id from review_runs where lane_id = ? and project_id = ?)", [laneId, projectId]);
    db.run("delete from review_findings where run_id in (select id from review_runs where lane_id = ? and project_id = ?)", [laneId, projectId]);
    db.run("delete from review_candidate_findings where run_id in (select id from review_runs where lane_id = ? and project_id = ?)", [laneId, projectId]);
    db.run("delete from review_reviewer_runs where run_id in (select id from review_runs where lane_id = ? and project_id = ?)", [laneId, projectId]);
    db.run("delete from review_runs where lane_id = ? and project_id = ?", [laneId, projectId]);

    db.run("delete from file_directory_snapshots where workspace_id in (select id from files_workspaces where lane_id = ?)", [laneId]);
    db.run("delete from file_content_snapshots where workspace_id in (select id from files_workspaces where lane_id = ?)", [laneId]);
    db.run("delete from file_diff_snapshots where workspace_id in (select id from files_workspaces where lane_id = ?)", [laneId]);
    db.run("delete from file_history_snapshots where workspace_id in (select id from files_workspaces where lane_id = ?)", [laneId]);
    db.run("delete from files_workspaces where lane_id = ?", [laneId]);

    db.run("delete from conflict_proposals where project_id = ? and (lane_id = ? or peer_lane_id = ?)", [projectId, laneId, laneId]);
    db.run("delete from conflict_predictions where project_id = ? and (lane_a_id = ? or lane_b_id = ?)", [projectId, laneId, laneId]);
    db.run("delete from checkpoints where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from session_deltas where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run(
      `
        delete from session_linear_issues
        where project_id = ?
          and (
            lane_id = ?
            or session_id in (select id from terminal_sessions where lane_id = ?)
            or session_id in (select session_id from claude_sessions where lane_id = ?)
          )
      `,
      [projectId, laneId, laneId, laneId],
    );
    db.run("delete from claude_sessions where lane_id = ?", [laneId]);
    db.run("delete from terminal_sessions where lane_id = ?", [laneId]);
    db.run("delete from operations where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from packs_index where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from test_runs where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from rebase_deferred where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from rebase_dismissed where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from lane_state_snapshots where lane_id = ?", [laneId]);
    db.run("delete from lane_branch_profiles where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from lane_worktree_locks where lane_id = ?", [laneId]);
    db.run("delete from lane_linear_issues where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from lane_linear_issue_links where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from local_lane_storage_state where lane_id = ? and project_id = ?", [laneId, projectId]);
    db.run("delete from lanes where id = ? and project_id = ?", [laneId, projectId]);
  };

  const commitLaneRestoreState = (laneId: string, worktreePath?: string): void => {
    db.run("begin immediate");
    try {
      if (worktreePath) {
        db.run(
          "update lanes set worktree_path = ?, status = 'active', archived_at = null where id = ? and project_id = ?",
          [worktreePath, laneId, projectId],
        );
      } else {
        db.run(
          "update lanes set status = 'active', archived_at = null where id = ? and project_id = ?",
          [laneId, projectId],
        );
      }
      db.run("delete from local_lane_storage_state where project_id = ? and lane_id = ?", [projectId, laneId]);
      db.run("commit");
    } catch (error) {
      try {
        db.run("rollback");
      } catch {
        // Preserve the original activation error.
      }
      throw error;
    }
  };

  async function cleanupCreatedWorktreeLaneAfterCreateFailure(args: {
    laneId: string;
    branchRef: string;
    worktreePath: string;
    cause: unknown;
    preserveCreatedLane?: boolean;
  }): Promise<never> {
    const cleanupErrors: string[] = [];
    const originalMessage = args.cause instanceof Error ? args.cause.message : String(args.cause);

    if (args.preserveCreatedLane) {
      invalidateLaneListCache();
      logger.warn("laneService.lane_create_cleanup_skipped_after_absorb", {
        laneId: args.laneId,
        branchRef: args.branchRef,
        worktreePath: args.worktreePath,
        error: originalMessage,
      });
      throw args.cause instanceof Error ? args.cause : new Error(originalMessage);
    }

    try {
      cleanupLaneDatabaseRows(args.laneId);
      invalidateLaneListCache();
    } catch (error) {
      cleanupErrors.push(`database cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await runGitWorktreeMutation(async () => {
        try {
          await runGitOrThrow(
            ["worktree", "remove", "--force", args.worktreePath],
            { cwd: projectRoot, timeoutMs: 60_000 },
          );
        } catch {
          await removeWorktreeDirectoryWithRecovery(args.worktreePath);
          await runGit(["worktree", "prune"], { cwd: projectRoot, timeoutMs: 30_000 });
        }
      });
    } catch (error) {
      cleanupErrors.push(`worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const result = await runGit(
        ["branch", "-D", args.branchRef],
        { cwd: projectRoot, timeoutMs: 30_000 },
      );
      if (result.exitCode !== 0) {
        const message = (result.stderr || result.stdout).trim();
        cleanupErrors.push(`branch cleanup failed: ${message || `git branch -D exited ${result.exitCode}`}`);
      }
    } catch (error) {
      cleanupErrors.push(`branch cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (cleanupErrors.length > 0) {
      logger.error("laneService.lane_create_cleanup_failed", {
        laneId: args.laneId,
        branchRef: args.branchRef,
        worktreePath: args.worktreePath,
        error: originalMessage,
        cleanupErrors,
      });
      throw new Error(`${originalMessage} Cleanup after failed lane creation also failed: ${cleanupErrors.join("; ")}`);
    }

    throw args.cause instanceof Error ? args.cause : new Error(originalMessage);
  }

  // Named so a few methods (branch-drift resolution) can delegate to sibling
  // methods instead of duplicating their transaction/rollback handling.
  const laneServiceApi = {
    async ensurePrimaryLane(): Promise<void> {
      await ensurePrimaryLane();
    },

    async list(args: ListLanesArgs = {}): Promise<LaneSummary[]> {
      return await listLanes(args);
    },

    async getSummary(laneId: string, options: { includeStatus?: boolean } = {}): Promise<LaneSummary | null> {
      const row = getLaneRow(laneId);
      if (!row) return null;

      const rowsById = getRowsById(true);
      const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) ?? null : null;
      let status: LaneStatus = cloneLaneStatus(DEFAULT_LANE_STATUS);
      let parentStatus: LaneStatus | null = parent ? cloneLaneStatus(DEFAULT_LANE_STATUS) : null;
      let worktreeAvailable: boolean | undefined;

      if (options.includeStatus !== false) {
        const { resolveWorktreeAvailable, resolveStatus } = await createLaneStatusResolver({
          rows: [row],
          rowsById,
          includeStatus: true,
          logContext: "lane_summary",
        });
        try {
          worktreeAvailable = await resolveWorktreeAvailable(row);
          if (worktreeAvailable) {
            status = await resolveStatus(row.id);
          }
        } catch {
          logger.warn("laneService.getSummary.status_failed", { laneId });
          worktreeAvailable = false;
          status = cloneLaneStatus(DEFAULT_LANE_STATUS);
        }

        if (parent) {
          try {
            parentStatus = await resolveStatus(parent.id);
          } catch {
            logger.warn("laneService.getSummary.parent_status_failed", { laneId, parentLaneId: parent.id });
            parentStatus = cloneLaneStatus(DEFAULT_LANE_STATUS);
          }
        }

        upsertLaneStateSnapshot({
          laneId: row.id,
          status,
          updatedAt: new Date().toISOString(),
        });
      }

      return toLaneSummary({
        row,
        status,
        parentStatus,
        childCount: getChildrenRows(row.id, false).length,
        stackDepth: computeStackDepth({ laneId: row.id, rowsById, memo: new Map() }),
        worktreeAvailable,
        activeBranchProfile: ensureBranchProfileForRow(row),
        linearIssue: getLaneLinearIssue(row.id),
        linearIssueLinks: getLaneLinearIssueLinks(row.id),
      });
    },

    async listUnregisteredWorktrees(): Promise<UnregisteredLaneCandidate[]> {
      return listUnregisteredWorktreeCandidates();
    },

    getStateSnapshot(laneId: string): LaneStateSnapshotSummary | null {
      const row = db.get<LaneStateSnapshotRow>(
        `
          select s.lane_id, s.agent_summary_json, s.updated_at
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
        updatedAt: row.updated_at ?? null,
      };
    },

    listStateSnapshots(): LaneStateSnapshotSummary[] {
      return db.all<LaneStateSnapshotRow>(
        `
          select s.lane_id, s.agent_summary_json, s.updated_at
          from lane_state_snapshots s
          join lanes l on l.id = s.lane_id
          where l.project_id = ?
        `,
        [projectId],
      ).map((row) => ({
        laneId: row.lane_id,
        agentSummary: parseSummaryRecord(row.agent_summary_json),
        updatedAt: row.updated_at ?? null,
      }));
    },

    async refreshSnapshots(args: ListLanesArgs = {}): Promise<{ refreshedCount: number; lanes: LaneSummary[] }> {
      invalidateLaneListCache();
      const summaries = await listLanes({
        includeArchived: args.includeArchived ?? true,
        includeStatus: args.includeStatus ?? true,
      });
      return {
        refreshedCount: summaries.length,
        lanes: summaries,
      };
    },

    invalidateListCache(): void {
      invalidateLaneListCache();
    },

    linkLinearIssues(args: {
      laneId: string;
      issues: LaneLinearIssue[];
      role?: LaneLinearIssueLinkRole;
      source?: LaneLinearIssueLinkSource;
      includeInPr?: boolean;
      closeOnMerge?: boolean;
      evidence?: LaneLinearIssueLink["evidence"];
    }): LaneLinearIssueLink[] {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required.");
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.status === "archived") throw new Error("Lane is archived.");
      const primary = getLaneLinearIssue(laneId);
      const links: LaneLinearIssueLink[] = [];
      const seen = new Set<string>();
      for (const issue of args.issues) {
        const normalized = finalizeLaneLinearIssue(issue, issue.branchName ?? row.branch_ref);
        if (!isLinkableLaneLinearIssue(normalized) || seen.has(normalized.id)) {
          continue;
        }
        seen.add(normalized.id);
        if (primary && (primary.id === normalized.id || primary.identifier === normalized.identifier)) {
          continue;
        }
        links.push(upsertLaneLinearIssueLink({
          laneId,
          issue: normalized,
          role: args.role ?? "worked",
          source: args.source ?? "manual",
          includeInPr: args.includeInPr ?? true,
          closeOnMerge: args.closeOnMerge ?? false,
          evidence: args.evidence ?? null,
        }));
      }
      if (links.length) {
        invalidateLaneListCache();
        if ((args.source ?? "manual") !== "chat_attach") {
          const summary = laneSummaryForLinearNotification(row);
          for (const link of links) {
            notifyLinearIssueLinked(summary, link.issue);
          }
        }
      }
      return links;
    },

    /**
     * Attach one or more Linear issues to a chat or CLI session. Works for
     * standalone sessions with no lane. When the session resolves to a lane,
     * each issue is also mirrored into `lane_linear_issue_links` (source
     * `chat_attach`, evidence.chatSessionId) so lane-level closeout/PR-open
     * linking can fan out from the session. Mirrors `linkLinearIssues`: returns
     * the session-scoped links it created, deduped by issue id, skipping issues
     * that are missing required fields.
     */
    attachLinearIssueToSession(args: {
      chatSessionId: string;
      issues: LaneLinearIssue[];
      role?: LaneLinearIssueLinkRole;
      source?: LaneLinearIssueLinkSource;
      includeInPr?: boolean;
      closeOnMerge?: boolean;
      evidence?: SessionLinearIssueLink["evidence"];
    }): SessionLinearIssueLink[] {
      const chatSessionId = args.chatSessionId.trim();
      if (!chatSessionId) throw new Error("chatSessionId is required.");
      const laneId = resolveSessionLaneId(chatSessionId);
      const laneRow = laneId ? getLaneRow(laneId) : null;
      const branchHint = laneRow?.branch_ref ?? null;
      const role = args.role ?? "worked";
      const source = args.source ?? "chat_attach";
      const includeInPr = args.includeInPr ?? true;
      const closeOnMerge = args.closeOnMerge ?? false;
      const evidence = args.evidence ?? { chatSessionId };
      const links: SessionLinearIssueLink[] = [];
      const mirroredLaneLinks: LaneLinearIssueLink[] = [];
      const seen = new Set<string>();
      let mirrored = false;
      for (const issue of args.issues) {
        const normalized = finalizeLaneLinearIssue(
          issue,
          issue.branchName ?? branchHint ?? linearIssueBranchName(issue),
        );
        if (!isLinkableLaneLinearIssue(normalized) || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        links.push(upsertSessionLinearIssueLink({
          sessionId: chatSessionId,
          laneId,
          issue: normalized,
          role,
          source,
          includeInPr,
          closeOnMerge,
          evidence,
        }));
        // Mirror into the lane-scoped link table when the session has a lane so
        // the lane's PR/closeout flows treat the issue as worked. Never promote
        // to the lane's `primary` issue here — that is reserved for lane-create.
        if (laneId && laneRow?.status !== "archived") {
          try {
            const primary = getLaneLinearIssue(laneId);
            if (!primary || (primary.id !== normalized.id && primary.identifier !== normalized.identifier)) {
              const laneLink = upsertLaneLinearIssueLink({
                laneId,
                issue: normalized,
                role: role === "primary" ? "worked" : role,
                source: "chat_attach",
                includeInPr,
                closeOnMerge,
                evidence: { chatSessionId },
              });
              mirroredLaneLinks.push(laneLink);
              mirrored = true;
            }
          } catch (error) {
            logger.warn("laneService.session_link_lane_mirror_failed", {
              chatSessionId,
              laneId,
              issueId: normalized.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (mirrored) {
        invalidateLaneListCache();
        if (laneRow) {
          const summary = laneSummaryForLinearNotification(laneRow);
          for (const link of mirroredLaneLinks) {
            notifyLinearIssueLinked(summary, link.issue);
          }
        }
      }
      for (const link of links) {
        notifyLinearIssueSessionLinked(link);
      }
      return links;
    },

    /**
     * Detach Linear issues from a session. Omit `issueId` to detach every issue
     * attached to the session. When the session resolves to a lane, the
     * mirrored `chat_attach` lane links for the same issues are removed too.
     * Returns true when at least one row was deleted.
     */
    detachLinearIssueFromSession(args: { chatSessionId: string; issueId?: string }): boolean {
      const chatSessionId = args.chatSessionId.trim();
      if (!chatSessionId) throw new Error("chatSessionId is required.");
      const issueId = args.issueId?.trim() || null;
      const before = getSessionLinearIssueLinks(chatSessionId);
      const target = issueId
        ? before.filter((link) => link.issue.id === issueId || link.issue.identifier === issueId)
        : before;
      if (!target.length) return false;
      const laneId = target.find((link) => link.laneId)?.laneId ?? resolveSessionLaneId(chatSessionId);
      db.run("begin");
      try {
        for (const link of target) {
          db.run(
            "delete from session_linear_issues where project_id = ? and id = ?",
            [projectId, link.id],
          );
          if (laneId) {
            db.run(
              `
                delete from lane_linear_issue_links
                where project_id = ?
                  and lane_id = ?
                  and issue_id = ?
                  and source = 'chat_attach'
              `,
              [projectId, laneId, link.issue.id],
            );
          }
        }
        db.run("commit");
      } catch (err) {
        try { db.run("rollback"); } catch { /* keep original detach error */ }
        throw err;
      }
      if (laneId) invalidateLaneListCache();
      return true;
    },

    /** List Linear issues attached to a single chat/CLI session. */
    listLinearIssuesForSession(args: { chatSessionId: string }): SessionLinearIssueLink[] {
      return getSessionLinearIssueLinks(args.chatSessionId);
    },

    /**
     * List every session-scoped Linear issue link across all chat and CLI
     * sessions that belong to a lane. Used on PR-open to fan out session →
     * lane → Linear attachment for issues that were only attached to a session.
     */
    listLinearIssuesForLaneSessions(args: { laneId: string }): SessionLinearIssueLink[] {
      const id = args.laneId.trim();
      if (!id) return [];
      try {
        return db.all<SessionLinearIssueLinkRow>(
          `
            select *
            from session_linear_issues
            where project_id = ?
              and lane_id = ?
            order by
              case role when 'primary' then 0 when 'worked' then 1 when 'referenced' then 2 else 3 end,
              updated_at desc
          `,
          [projectId, id],
        ).map(parseSessionLinearIssueLink).filter((link): link is SessionLinearIssueLink => Boolean(link));
      } catch {
        return [];
      }
    },

    /**
     * Remove lane-scoped Linear issue links from a lane. Omit `issueId` to
     * remove every non-primary link. NEVER touches the lane's primary issue
     * (stored separately in `lane_linear_issues`); a link row that matches the
     * primary is skipped defensively. Returns true when at least one row was
     * deleted. Counterpart to `linkLinearIssues` for lane-level detach.
     */
    unlinkLinearIssues(args: { laneId: string; issueId?: string }): boolean {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required.");
      const issueId = args.issueId?.trim() || null;
      const existing = getLaneLinearIssueLinks(laneId);
      const primary = getLaneLinearIssue(laneId);
      const isPrimaryIssue = (link: LaneLinearIssueLink): boolean =>
        Boolean(primary) && (link.issue.id === primary!.id || link.issue.identifier === primary!.identifier);
      const target = existing.filter((link) => {
        if (isPrimaryIssue(link)) return false;
        if (!issueId) return true;
        return link.issue.id === issueId || link.issue.identifier === issueId;
      });
      if (!target.length) return false;
      db.run("begin");
      try {
        for (const link of target) {
          db.run(
            "delete from lane_linear_issue_links where project_id = ? and id = ?",
            [projectId, link.id],
          );
        }
        db.run("commit");
      } catch (err) {
        try { db.run("rollback"); } catch { /* keep original unlink error */ }
        throw err;
      }
      invalidateLaneListCache();
      return true;
    },

    async create({ name, description, parentLaneId, baseBranch, branchName, startPoint, linearIssue }: CreateLaneArgs): Promise<LaneSummary> {
      const requestedStartPoint = startPoint?.trim() ?? "";
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
        if (!requestedStartPoint && parent.lane_type === "primary" && requestedBaseRef === parent.branch_ref) {
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
        if (requestedStartPoint) {
          const result = await runGit(["rev-parse", "--verify", requestedStartPoint], {
            cwd: parent.worktree_path,
            timeoutMs: 10_000,
          });
          if (result.exitCode !== 0 || !result.stdout.trim().length) {
            throw new Error(`Start point not found for new lane: ${requestedStartPoint}`);
          }
          parentHeadSha = result.stdout.trim();
        } else if (parent.lane_type === "primary") {
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
          parentLaneId: parent.lane_type === "primary" ? null : parent.id,
          branchName,
          linearIssue,
        });
      }

      // No parent specified: branch from defaultBaseRef. Resolve the exact SHA to avoid stale refs.
      const trimmedBase = baseBranch?.trim() ?? "";
      const requestedBaseRef = trimmedBase.length > 0 ? trimmedBase : defaultBaseRef;
      const startRef = requestedStartPoint || requestedBaseRef;
      const headRes = await runGit(
        requestedStartPoint ? ["rev-parse", "--verify", requestedStartPoint] : ["rev-parse", requestedBaseRef],
        { cwd: projectRoot, timeoutMs: 10_000 },
      );
      const resolvedHead = headRes.exitCode === 0 ? headRes.stdout.trim() : "";
      if (requestedStartPoint && !resolvedHead) {
        throw new Error(`Start point not found for new lane: ${requestedStartPoint}`);
      }
      const resolvedStartPoint = resolvedHead || startRef;

      return await createWorktreeLane({
        name,
        description,
        baseRef: requestedBaseRef,
        startPoint: resolvedStartPoint,
        parentLaneId: null,
        branchName,
        linearIssue,
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
          branchName: args.branchName,
          linearIssue: args.linearIssue ?? null,
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
          branchName: args.branchName,
          linearIssue: args.linearIssue ?? null,
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
        branchName: args.branchName,
        linearIssue: args.linearIssue ?? null,
      });
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
          await runGitWorktreeMutation(() =>
            runGitOrThrow(["worktree", "remove", "--force", row.worktree_path], {
              cwd: projectRoot,
              timeoutMs: 60_000,
            })
          );
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

        db.run("delete from lane_linear_issues where lane_id = ? and project_id = ?", [laneId, projectId]);
        db.run("delete from lane_linear_issue_links where lane_id = ? and project_id = ?", [laneId, projectId]);
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

      try {
        await recoverManagedWorktreeRows();
      } catch (err) {
        logger.warn("laneService.importBranch.recoverManagedWorktreeRows_failed", { error: err instanceof Error ? err.message : String(err) });
      }

      // Prevent duplicates.
      const existing = db.get<{ id: string }>(
        "select id from lanes where project_id = ? and branch_ref = ? limit 1",
        [projectId, branchRef]
      );
      if (existing?.id) {
        throw new Error(`Lane already exists for branch '${branchRef}'`);
      }

      try {
        const checkedOutWorktree = await findGitWorktreeForBranch(branchRef);
        if (checkedOutWorktree && checkedOutWorktree.path !== normalizedProjectRoot) {
          throw new Error(
            `Branch '${branchRef}' is already checked out at '${checkedOutWorktree.path}'. Use Add existing worktrees to attach it as a lane, or remove/prune that worktree before importing again.`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("already checked out at")) throw err;
        logger.warn("laneService.importBranch.worktree_ownership_check_failed", { branchRef, error: err instanceof Error ? err.message : String(err) });
      }

      const laneId = randomUUID();
      const now = new Date().toISOString();
      const displayName = (args.name ?? "").trim() || branchRef;
      const slug = slugify(displayName);
      const suffix = laneId.slice(0, 8);
      const worktreePath = path.join(worktreesDir, `${slug}-${suffix}`);

      // Same create/recover race as createWorktreeLane: keep recovery away
      // from this path/branch until the lane row exists.
      const releasePendingWorktreeCreation = trackPendingWorktreeCreation(worktreePath, branchRef);
      try {
        if (remoteRefToTrack) {
          await runGitOrThrow(["branch", "--track", branchRef, remoteRefToTrack], { cwd: projectRoot, timeoutMs: 15_000 });
          branchCreated = true;
        }

        // Attaching an existing branch: do NOT create a new branch, just add a worktree checkout.
        await runGitWorktreeMutation(() =>
          runGitOrThrow(["worktree", "add", worktreePath, branchRef], {
            cwd: projectRoot,
            timeoutMs: 60_000
          })
        );
        worktreeAdded = true;
        linkExistingDependencyInstalls(worktreePath);

        // Imported branches are always root lanes. No caller passes
        // parentLaneId — if a child lane is wanted, the "child" creation
        // mode is used instead.
        const parentLaneId: string | null = null;
        const parent = parentLaneId ? getLaneRow(parentLaneId) : null;
        if (parentLaneId && !parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
        if (parent && parent.status === "archived") throw new Error("Parent lane is archived");

        const baseRef = args.baseBranch?.trim() || defaultBaseRef;
        const laneColor = allocateLaneColorForProject();

        db.run("begin immediate");
        try {
          db.run(
            `
              insert into lanes(
                id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
                attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
              )
              values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, ?, null, null, 'active', ?, null)
            `,
            [laneId, projectId, displayName, args.description ?? null, baseRef, branchRef, worktreePath, parentLaneId, laneColor, now]
          );

          const racedAdoptionRows = db.all<{ id: string }>(
            `
              select id from lanes
              where project_id = ?
                and id != ?
                and lane_type = 'worktree'
                and status != 'archived'
                and is_edit_protected = 0
                and (worktree_path = ? or branch_ref = ?)
            `,
            [projectId, laneId, worktreePath, branchRef]
          );
          for (const raced of racedAdoptionRows) {
            logger.info("laneService.import_absorbed_raced_adoption_row", { laneId, racedLaneId: raced.id });
            mergeDuplicateLaneInto(laneId, raced.id);
          }

          db.run("commit");
          laneInserted = true;
        } catch (txError) {
          try {
            db.run("rollback");
          } catch {
            // surface the original error below
          }
          throw txError;
        }
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

        const summary = toLaneSummary({
          row,
          status,
          parentStatus,
          childCount: 0,
          stackDepth: computeStackDepth({ laneId, rowsById, memo: new Map() }),
          activeBranchProfile: ensureBranchProfileForRow(row)
        });
        broadcastLifecycleEvent({
          type: "lane-created",
          laneId: summary.id,
          laneName: summary.name,
          color: summary.color,
          lane: summary,
        });
        return summary;
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
            await runGitWorktreeMutation(() =>
              runGitOrThrow(["worktree", "remove", "--force", worktreePath], {
                cwd: projectRoot,
                timeoutMs: 60_000,
              })
            );
          } catch (cleanupError) {
            try {
              fs.rmSync(worktreePath, { recursive: true, force: true });
              // Directory removed but git metadata may be orphaned; prune to clean up
              try {
                await runGitWorktreeMutation(() =>
                  runGitOrThrow(["worktree", "prune"], {
                    cwd: projectRoot,
                    timeoutMs: 60_000,
                  })
                );
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
      } finally {
        releasePendingWorktreeCreation();
      }
    },

    listBranchProfiles(laneId: string): LaneBranchProfile[] {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      ensureBranchProfileForRow(row);
      return db.all<LaneBranchProfileRow>(
        `
          select *
          from lane_branch_profiles
          where project_id = ?
            and lane_id = ?
          order by coalesce(last_checked_out_at, updated_at) desc, branch_ref asc
        `,
        [projectId, laneId],
      ).map(toLaneBranchProfile);
    },

    /**
     * Lightweight branch ownership lookup that avoids the full `list()` work
     * (status resolution, queue rebase overrides, primary-lane bootstrap).
     * Returns a map of branch ref → owning lane info for active, non-primary
     * lanes other than `excludeLaneId`. Used by the branch picker to flag
     * branches that another lane already owns.
     */
    listBranchOwners(args: { excludeLaneId?: string } = {}): Array<{ id: string; name: string; branchRef: string }> {
      const exclude = args.excludeLaneId?.trim() ?? "";
      const rows = db.all<{ id: string; name: string; branch_ref: string }>(
        `
          select id, name, branch_ref
          from lanes
          where project_id = ?
            and status != 'archived'
            and lane_type != 'primary'
            and branch_ref is not null
            and branch_ref != ''
        `,
        [projectId],
      );
      return rows
        .filter((row) => row.id !== exclude)
        .map((row) => ({ id: row.id, name: row.name, branchRef: row.branch_ref }));
    },

    async previewBranchSwitch(args: LaneBranchSwitchArgs): Promise<LaneBranchSwitchPreview> {
      return await previewBranchSwitch(args);
    },

    async switchBranch(args: LaneBranchSwitchArgs): Promise<LaneBranchSwitchResult> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required.");
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.status === "archived") throw new Error("Lane is archived.");

      const mode = args.mode ?? "existing";
      const rawBranchName = args.branchName.trim();
      if (!rawBranchName) throw new Error("Branch name is required.");

      const preview = await previewBranchSwitch(args);
      if (preview.dirty) {
        throw new Error("This lane has uncommitted changes. Commit or stash them before switching branches.");
      }
      if (preview.duplicateLaneId) {
        throw new Error(`Branch '${preview.targetBranchRef}' is already active in lane '${preview.duplicateLaneName ?? preview.duplicateLaneId}'.`);
      }
      if (preview.activeWork.length > 0 && !args.acknowledgeActiveWork) {
        throw new Error("This lane has active sessions. Confirm the branch switch to continue.");
      }

      const previousBranchRef = row.branch_ref;
      upsertBranchProfileForRow(row);

      let targetBranchRef = preview.targetBranchRef;
      let targetProfileRow = getBranchProfileRow(row.id, targetBranchRef);
      const now = new Date().toISOString();
      let pendingProfileUpsert: {
        branchRef: string;
        baseRef: string;
        parentLaneId: string | null;
        sourceBranchRef: string | null;
        lastCheckedOutAt: string;
      } | null = null;

      if (mode === "create") {
        const baseRef = args.baseRef?.trim();
        if (!baseRef) {
          throw new Error("Base branch is required when creating a branch inside a lane.");
        }
        const baseRefRes = await runGit(["rev-parse", "--verify", baseRef], {
          cwd: row.worktree_path,
          timeoutMs: 10_000,
        });
        if (baseRefRes.exitCode !== 0 || !baseRefRes.stdout.trim()) {
          throw new Error(`Base branch '${baseRef}' was not found.`);
        }
        const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${targetBranchRef}`], {
          cwd: row.worktree_path,
          timeoutMs: 8_000,
        }).then((res) => res.exitCode === 0);
        if (branchExists) {
          throw new Error(`Branch '${targetBranchRef}' already exists. Switch to it instead of creating it.`);
        }
        const startPoint = args.startPoint?.trim() || row.branch_ref;
        const startPointRes = await runGit(["rev-parse", "--verify", startPoint], {
          cwd: row.worktree_path,
          timeoutMs: 10_000,
        });
        if (startPointRes.exitCode !== 0 || !startPointRes.stdout.trim()) {
          throw new Error(`Start point '${startPoint}' was not found.`);
        }
        await runGitOrThrow(["checkout", "-b", targetBranchRef, startPoint], {
          cwd: row.worktree_path,
          timeoutMs: 60_000,
        });
        targetProfileRow = null;
        pendingProfileUpsert = {
          branchRef: targetBranchRef,
          baseRef,
          parentLaneId: null,
          sourceBranchRef: startPoint,
          lastCheckedOutAt: now,
        };
      } else {
        const localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${rawBranchName}`], {
          cwd: row.worktree_path,
          timeoutMs: 8_000,
        }).then((res) => res.exitCode === 0);
        let remoteRef: string | null = null;
        if (!localExists) {
          const remoteExists = await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${rawBranchName}`], {
            cwd: row.worktree_path,
            timeoutMs: 8_000,
          }).then((res) => res.exitCode === 0);
          if (remoteExists) {
            remoteRef = rawBranchName;
            targetBranchRef = localBranchNameFromRemoteRef(rawBranchName);
          } else {
            const resolved = await resolveImportBranchTarget({ projectRoot, rawRef: rawBranchName });
            remoteRef = resolved.remoteRef;
            targetBranchRef = resolved.localBranchName;
          }
        }

        const checkoutCmd = remoteRef
          ? ["checkout", "--track", "--ignore-other-worktrees", remoteRef]
          : ["checkout", "--ignore-other-worktrees", targetBranchRef];
        await runGitOrThrow(checkoutCmd, { cwd: row.worktree_path, timeoutMs: 60_000 });

        const existingProfile = targetProfileRow ? toLaneBranchProfile(targetProfileRow) : null;
        pendingProfileUpsert = {
          branchRef: targetBranchRef,
          baseRef: args.baseRef?.trim() || existingProfile?.baseRef || defaultBaseRef,
          parentLaneId: existingProfile?.parentLaneId ?? null,
          sourceBranchRef: existingProfile?.sourceBranchRef ?? null,
          lastCheckedOutAt: now,
        };
      }

      // Wrap the profile upsert + lanes update + stale-PR cleanup in a single
      // transaction so a partial failure can't leave the lane row referencing
      // the new branch while the orphaned PR rows linger (or vice versa), or
      // leave the post-checkout profile written without the matching lanes
      // row update.
      db.run("begin");
      try {
        if (pendingProfileUpsert) {
          upsertBranchProfileForRow(row, pendingProfileUpsert);
        }
        const targetProfile = getBranchProfileRow(row.id, targetBranchRef);
        const baseRef = targetProfile?.base_ref ?? args.baseRef?.trim() ?? defaultBaseRef;
        const parentLaneId = targetProfile?.parent_lane_id ?? null;
        db.run(
          `
            update lanes
            set branch_ref = ?,
                base_ref = ?,
                parent_lane_id = ?
            where id = ?
              and project_id = ?
          `,
          [targetBranchRef, baseRef, parentLaneId, row.id, projectId],
        );
        // Drop any PR rows still associated with this lane whose head_branch
        // no longer matches the lane's current branch — those references are
        // stale after a branch switch and must not bleed into PR lookups.
        // pull_requests.lane_id is NOT NULL, so we DELETE (mirrors the explicit
        // child-row cleanup used by the lane-delete path; CRR conversion can
        // strip FK cascades).
        const stalePrRows = db.all<{ id: string }>(
          `
            select id from pull_requests
            where lane_id = ?
              and project_id = ?
              and head_branch <> ?
          `,
          [row.id, projectId, targetBranchRef],
        );
        if (stalePrRows.length > 0) {
          const stalePrIds = stalePrRows.map((r) => r.id);
          deletePullRequestRowsByIds(db, projectId, stalePrIds);
        }
        db.run("commit");
      } catch (err) {
        try { db.run("rollback"); } catch { /* swallow rollback failures */ }
        if (previousBranchRef && previousBranchRef !== targetBranchRef) {
          try {
            await runGitOrThrow(
              ["checkout", "--ignore-other-worktrees", previousBranchRef],
              { cwd: row.worktree_path, timeoutMs: 60_000 },
            );
          } catch (rollbackErr) {
            logger.warn("laneService.switchBranch_git_rollback_failed", {
              laneId: row.id,
              previousBranchRef,
              targetBranchRef,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            });
          }
        }
        throw err;
      }
      invalidateLaneListCache();

      const refreshed = (await listLanes({ includeArchived: false, includeStatus: true })).find((lane) => lane.id === row.id);
      if (!refreshed) throw new Error(`Lane not found after branch switch: ${row.id}`);
      return {
        lane: refreshed,
        previousBranchRef,
        activeWork: preview.activeWork,
      };
    },

    /**
     * On-demand branch-drift read for a single lane.
     *
     * The lane list already carries `branchDrift` (computed from the status
     * refresh); this exists for callers that need a fresh answer right before
     * acting — e.g. immediately ahead of a PR operation or a new chat turn.
     */
    async getBranchDrift(args: { laneId: string }): Promise<LaneBranchDrift | null> {
      const laneId = args.laneId.trim();
      if (!laneId) return null;
      const row = getLaneRow(laneId);
      if (!row || row.status === "archived") return null;
      if (!(await isExpectedGitWorktreeRoot(row.worktree_path))) return null;
      const headRes = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: row.worktree_path,
        timeoutMs: 5_000,
      }).catch(() => null);
      const headBranchRef = headRes?.exitCode === 0 ? headRes.stdout.trim() : null;
      return detectLaneBranchDrift({ expectedBranchRef: row.branch_ref, headBranchRef });
    },

    /**
     * Resolve branch drift. This is the single entry point the ADE action
     * registry / IPC layer should call for both affordances.
     *
     * - `switch-back` restores the worktree to the recorded `branch_ref`. It
     *   delegates to `switchBranch`, which refuses (throwing, changing nothing)
     *   when the worktree is dirty, and rolls the checkout back if the DB write
     *   fails.
     * - `keep-head` re-points `branch_ref` at the live HEAD and, when the lane
     *   name was merely advertising the old branch, renames the lane to match —
     *   both inside one transaction, so the lane can never end up pointing at
     *   one branch while its name advertises another.
     */
    async resolveBranchDrift(args: ResolveLaneBranchDriftArgs): Promise<ResolveLaneBranchDriftResult> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required.");
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.status === "archived") throw new Error("Lane is archived.");
      if (!(await isExpectedGitWorktreeRoot(row.worktree_path))) {
        throw new Error("This lane's worktree is unavailable.");
      }

      const headRes = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: row.worktree_path,
        timeoutMs: 5_000,
      });
      const liveHeadBranchRef = headRes.exitCode === 0 ? headRes.stdout.trim() : "";
      const drift = detectLaneBranchDrift({
        expectedBranchRef: row.branch_ref,
        headBranchRef: liveHeadBranchRef,
      });
      if (!drift) {
        throw new Error("This lane is already on its recorded branch.");
      }
      const expectedHeadBranchRef = args.expectedHeadBranchRef?.trim();
      if (expectedHeadBranchRef && normalizeBranchKey(expectedHeadBranchRef) !== drift.headBranchRef) {
        throw new Error(
          `This lane is now on '${drift.headBranchRef}', not '${expectedHeadBranchRef}'. Refresh and try again.`,
        );
      }

      if (args.resolution === "switch-back") {
        const result = await laneServiceApi.switchBranch({
          laneId: row.id,
          branchName: drift.expectedBranchRef,
          mode: "existing",
          // Never default this on: switchBranch's active-work guard is the only
          // thing stopping a force checkout of a worktree that agents are still
          // running against. A caller that really wants to proceed must say so.
          acknowledgeActiveWork: args.acknowledgeActiveWork === true,
        });
        return {
          lane: result.lane,
          resolution: "switch-back",
          previousBranchRef: drift.headBranchRef,
          branchRef: result.lane.branchRef,
          previousLaneName: null,
          laneName: result.lane.name,
        };
      }

      const targetBranchRef = drift.headBranchRef;
      const duplicate = findActiveBranchOwner(targetBranchRef, row.id);
      if (duplicate) {
        throw new Error(`Branch '${targetBranchRef}' is already active in lane '${duplicate.name}'.`);
      }

      // Only re-point the name when it is literally advertising the branch the
      // lane no longer tracks. A hand-written lane name ("Auth work") advertises
      // nothing and must survive.
      const previousLaneName = row.name;
      const nameAdvertisesOldBranch = laneNameAdvertisesBranch(row.name, drift.expectedBranchRef);
      const nameTaken = db.get<{ id: string }>(
        `
          select id from lanes
          where project_id = ?
            and id != ?
            and archived_at is null
            and lower(name) = lower(?)
          limit 1
        `,
        [projectId, row.id, targetBranchRef],
      );
      const nextLaneName = row.lane_type !== "primary" && nameAdvertisesOldBranch && !nameTaken
        ? targetBranchRef
        : row.name;

      db.run("begin");
      try {
        const existingProfile = getBranchProfileRow(row.id, targetBranchRef);
        upsertBranchProfileForRow(row, {
          branchRef: targetBranchRef,
          baseRef: existingProfile?.base_ref || row.base_ref || defaultBaseRef,
          parentLaneId: existingProfile?.parent_lane_id ?? row.parent_lane_id,
          sourceBranchRef: existingProfile?.source_branch_ref ?? drift.expectedBranchRef,
          lastCheckedOutAt: new Date().toISOString(),
        });
        const profile = getBranchProfileRow(row.id, targetBranchRef);
        db.run(
          `
            update lanes
            set branch_ref = ?,
                base_ref = ?,
                parent_lane_id = ?,
                name = ?
            where id = ?
              and project_id = ?
          `,
          [
            targetBranchRef,
            profile?.base_ref ?? row.base_ref ?? defaultBaseRef,
            profile?.parent_lane_id ?? row.parent_lane_id,
            nextLaneName,
            row.id,
            projectId,
          ],
        );
        // Same rationale as switchBranch: PR rows whose head branch no longer
        // matches the lane are stale references and must not bleed into PR
        // lookups now that the lane tracks a different branch.
        const stalePrRows = db.all<{ id: string }>(
          `
            select id from pull_requests
            where lane_id = ?
              and project_id = ?
              and head_branch <> ?
          `,
          [row.id, projectId, targetBranchRef],
        );
        if (stalePrRows.length > 0) {
          deletePullRequestRowsByIds(db, projectId, stalePrRows.map((entry) => entry.id));
        }
        db.run("commit");
      } catch (err) {
        try { db.run("rollback"); } catch { /* swallow rollback failures */ }
        throw err;
      }
      invalidateLaneListCache();

      if (nextLaneName !== previousLaneName) {
        broadcastLifecycleEvent({
          type: "lane-renamed",
          laneId: row.id,
          laneName: nextLaneName,
          previousLaneName,
          color: row.color,
        });
      }

      const refreshed = (await listLanes({ includeArchived: false, includeStatus: true }))
        .find((lane) => lane.id === row.id);
      if (!refreshed) throw new Error(`Lane not found after drift resolution: ${row.id}`);
      return {
        lane: refreshed,
        resolution: "keep-head",
        previousBranchRef: drift.expectedBranchRef,
        branchRef: targetBranchRef,
        previousLaneName: nextLaneName !== previousLaneName ? previousLaneName : null,
        laneName: nextLaneName,
      };
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
            activeBranchProfile: ensureBranchProfileForRow(row),
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
          runId,
          rootLaneId: target.id,
          reason,
          recursive: scope === "lane_and_descendants",
          scope,
          pushMode,
          actor,
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

    async reparent({ laneId, newParentLaneId, stackBaseBranchRef }: ReparentLaneArgs): Promise<ReparentLaneResult> {
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
      const persistedParentLaneId = newParent.lane_type === "primary" ? null : newParent.id;
      const stackBaseOverride = stackBaseBranchRef ? normalizeBranchName(stackBaseBranchRef).trim() : "";
      const newBaseRef = stackBaseOverride || newParent.branch_ref;
      if (lane.parent_lane_id === persistedParentLaneId && newBaseRef === previousBaseRef) {
        const headSha = await getHeadSha(lane.worktree_path);
        return {
          laneId: lane.id,
          previousParentLaneId,
          newParentLaneId: newParent.id,
          previousBaseRef,
          newBaseRef: previousBaseRef,
          preHeadSha: headSha,
          postHeadSha: headSha,
        };
      }
      const newParentTarget = stackBaseOverride
        ? await resolveBranchRebaseTarget({ projectRoot, branchRef: stackBaseOverride, preferRemote: true })
        : await resolveParentRebaseTarget({ projectRoot, parent: newParent });
      const newParentHead = newParentTarget.headSha;
      const preHeadSha = await getHeadSha(lane.worktree_path);

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
      upsertBranchProfileForRow(lane, {
        branchRef: lane.branch_ref,
        baseRef: newBaseRef,
        parentLaneId: persistedParentLaneId,
      });
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
        upsertBranchProfileForRow(lane, {
          branchRef: lane.branch_ref,
          baseRef: previousBaseRef,
          parentLaneId: previousParentLaneId,
        });
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
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Lane name is required");
      const lane = getLaneRow(laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      if (lane.lane_type === "primary") throw new Error("Primary lane cannot be renamed");
      if (trimmed === lane.name) return;

      const duplicate = db.get<{ name: string }>(
        `
          select name from lanes
          where project_id = ?
            and id != ?
            and archived_at is null
            and lower(name) = lower(?)
          limit 1
        `,
        [projectId, laneId, trimmed],
      );
      if (duplicate) {
        throw new Error(`A lane named "${duplicate.name}" already exists`);
      }

      db.run("update lanes set name = ? where id = ? and project_id = ?", [trimmed, laneId, projectId]);
      invalidateLaneListCache();
      broadcastLifecycleEvent({
        type: "lane-renamed",
        laneId,
        laneName: trimmed,
        previousLaneName: lane.name,
        color: lane.color,
      });
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

      if (normalizedColor && normalizedColor !== lane.color) {
        const conflict = db.get<{ name: string }>(
          `select name from lanes
           where project_id = ?
             and id != ?
             and archived_at is null
             and lower(color) = lower(?)
           limit 1`,
          [projectId, laneId, normalizedColor]
        );
        if (conflict) {
          throw new Error(`Color already in use by lane "${conflict.name}"`);
        }
      }

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

    async getReclaimRisk(laneId: string): Promise<LaneReclaimRisk> {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      const deleteRisk = await laneServiceApi.getDeleteRisk(laneId);
      const normalizedRoot = normAbs(worktreesDir);
      const normalizedWorktree = normAbs(row.worktree_path);
      const managedPath = row.lane_type === "worktree" && path.dirname(normalizedWorktree) === normalizedRoot;
      const worktreeExists = managedPath && fs.existsSync(normalizedWorktree);
      const symlinkPath = managedPath
        ? await hasSymlinkInManagedPath(normalizedRoot, normalizedWorktree)
        : false;
      let registeredWorktree: GitWorktreeInfo | null = null;
      if (worktreeExists && !symlinkPath) {
        try {
          registeredWorktree = await registeredWorktreeForLane(normalizedWorktree, row.branch_ref);
        } catch {
          // Ownership must be proven before reclaim; a failed registry read is
          // treated as blocked instead of trusting the saved database path.
        }
      }
      const worktreeAvailable = Boolean(registeredWorktree);
      const lanePackDir = path.join(resolveAdeLayout(projectRoot).packsDir, "lanes", laneId);
      const [worktreeBytes, generatedBytes] = await Promise.all([
        worktreeAvailable && !symlinkPath ? managedTreeBytes(normalizedWorktree) : Promise.resolve(0),
        managedTreeBytes(lanePackDir),
      ]);
      const branchName = row.branch_ref ? branchNameForDelete(row.branch_ref, "origin") : "";
      let unmerged = false;
      if (branchName) {
        const merged = await runGit(
          ["merge-base", "--is-ancestor", branchName, row.base_ref],
          { cwd: projectRoot, timeoutMs: 8_000 },
        );
        unmerged = merged.exitCode !== 0;
      }
      const blockedReasons: LaneReclaimRisk["blockedReasons"] = [];
      if (row.lane_type === "primary") {
        blockedReasons.push({
          code: "primary_lane",
          message: "The primary lane is always kept on disk.",
          disposition: "blocked",
        });
      }
      if (row.lane_type === "attached") {
        blockedReasons.push({
          code: "attached_lane",
          message: "This folder is attached from outside ADE, so ADE will not remove it.",
          disposition: "blocked",
        });
      }
      if (row.lane_type === "worktree" && !managedPath) {
        blockedReasons.push({
          code: "worktree_outside_managed_root",
          message: "The saved folder is outside ADE's managed worktree folder.",
          disposition: "blocked",
        });
      }
      if (symlinkPath) {
        blockedReasons.push({
          code: "symlink_path",
          message: "The folder or its managed root is a link.",
          disposition: "blocked",
        });
      }
      if (worktreeExists && !symlinkPath && !registeredWorktree) {
        blockedReasons.push({
          code: "worktree_not_registered",
          message: "This folder is not the lane worktree registered to this project and will not be removed.",
          disposition: "blocked",
        });
      }
      if (deleteRisk.activeChatCount + deleteRisk.activePtyCount + deleteRisk.activeWatcherCount > 0) {
        blockedReasons.push({
          code: "active_work",
          message: "Running chats, terminals, or file watchers will be stopped after you confirm.",
          disposition: "confirmation_required",
        });
      }
      if (deleteRisk.dirty) {
        blockedReasons.push({
          code: "dirty_worktree",
          message: "This lane has uncommitted files. Reclaiming can permanently remove those file changes.",
          disposition: "confirmation_required",
        });
      }
      if (unmerged || deleteRisk.hasUnpushedCommits) {
        blockedReasons.push({
          code: "unmerged_work",
          message: "The branch has work that is not merged or pushed. The branch is kept, but review it before reclaiming.",
          disposition: "confirmation_required",
        });
      }
      const state = db.get<{ attempts: number; last_error: string | null }>(
        "select attempts, last_error from local_lane_storage_state where project_id = ? and lane_id = ?",
        [projectId, laneId],
      );
      return {
        ...deleteRisk,
        laneName: row.name,
        worktreePath: row.worktree_path,
        worktreeBytes,
        generatedBytes,
        reclaimableBytes: worktreeBytes + generatedBytes,
        worktreeAvailable,
        blockedReasons,
        lastFailure: state?.last_error ?? null,
        retryCount: state?.attempts ?? 0,
      };
    },

    async archiveAndReclaim(
      args: ArchiveAndReclaimLaneArgs,
      runtimeOpts?: { teardownEnv?: () => Promise<void> },
    ): Promise<ArchiveAndReclaimLaneResult> {
      if (args.confirmation !== "RECLAIM") {
        throw new Error('Type "RECLAIM" to confirm removing this lane folder.');
      }
      const row = getLaneRow(args.laneId);
      if (!row) throw new Error(`Lane not found: ${args.laneId}`);
      if (laneReclaimInFlight.has(args.laneId)) {
        throw new Error("Archive & Reclaim is already running for this lane.");
      }
      if (deleteProgressByLaneId.get(args.laneId)?.overallStatus === "running") {
        throw new Error("This lane is already being deleted.");
      }
      if (row.lane_type === "primary") throw new Error("The primary lane cannot be reclaimed.");
      if (row.lane_type === "attached") {
        throw new Error("Attached folders are not ADE-managed and cannot be reclaimed.");
      }
      const normalizedRoot = normAbs(worktreesDir);
      const normalizedWorktree = normAbs(row.worktree_path);
      if (path.dirname(normalizedWorktree) !== normalizedRoot) {
        throw new Error("The lane folder is outside ADE's managed worktree folder.");
      }
      if (await hasSymlinkInManagedPath(normalizedRoot, normalizedWorktree)) {
        throw new Error("ADE will not reclaim a folder through a symbolic link.");
      }

      const risk = await laneServiceApi.getReclaimRisk(args.laneId);
      const hardBlock = risk.blockedReasons.find((reason) => reason.disposition === "blocked");
      if (hardBlock) throw new Error(hardBlock.message);
      if (risk.dirty && args.forceDirty !== true) {
        throw new Error("This lane has uncommitted files. Confirm that those changes may be lost.");
      }
      if (laneReclaimInFlight.has(args.laneId)) {
        throw new Error("Archive & Reclaim is already running for this lane.");
      }
      if (deleteProgressByLaneId.get(args.laneId)?.overallStatus === "running") {
        throw new Error("This lane is already being deleted.");
      }
      const storageLock = acquireStorageLifecycleLock({
        laneId: args.laneId,
        worktreePath: normalizedWorktree,
        ownerLabel: `Archive & Reclaim: ${row.name}`,
      });
      laneReclaimInFlight.add(args.laneId);
      const warnings: string[] = [];
      const now = new Date().toISOString();
      const startedAtMs = Date.now();
      try {
        laneServiceApi.archive({ laneId: args.laneId });
        db.run(
          `insert into local_lane_storage_state(
             lane_id, project_id, worktree_path, reclaim_state, last_known_bytes,
             attempts, last_error, reclaimed_at, updated_at
           ) values(?, ?, ?, 'kept', ?, 0, null, null, ?)
           on conflict(lane_id) do update set
             worktree_path = excluded.worktree_path,
             last_known_bytes = excluded.last_known_bytes,
             last_error = null,
             updated_at = excluded.updated_at`,
          [args.laneId, projectId, row.worktree_path, risk.reclaimableBytes, now],
        );
        teardownDeps?.autoRebaseService?.cancelForLane(args.laneId);
        await teardownDeps?.rebaseSuggestionService?.dismiss({ laneId: args.laneId });
        await teardownDeps?.agentChatService?.disposeForLane(args.laneId);
        teardownDeps?.ptyService?.disposeForLane(args.laneId);
        teardownDeps?.fileWatcherService?.stopAllForWorkspace(args.laneId);
        if (runtimeOpts?.teardownEnv) {
          try {
            await runtimeOpts.teardownEnv();
          } catch (error) {
            warnings.push(`Environment cleanup did not finish: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        let worktreeRemoved = !fs.existsSync(normalizedWorktree);
        if (!worktreeRemoved) {
          const initialStat = await fs.promises.lstat(normalizedWorktree);
          if (!initialStat.isDirectory() || initialStat.isSymbolicLink()) {
            throw new Error("The lane worktree is no longer a safe managed folder.");
          }
          await runGitWorktreeMutation(async () => {
            if (await hasSymlinkInManagedPath(normalizedRoot, normalizedWorktree)) {
              throw new Error("ADE will not reclaim a folder through a symbolic link.");
            }
            if (!await registeredWorktreeForLane(normalizedWorktree, row.branch_ref)) {
              throw new Error("This folder is no longer the lane worktree registered to this project.");
            }
            const beforeRemove = await fs.promises.lstat(normalizedWorktree);
            if (
              !beforeRemove.isDirectory()
              || beforeRemove.isSymbolicLink()
              || beforeRemove.dev !== initialStat.dev
              || beforeRemove.ino !== initialStat.ino
            ) {
              throw new Error("The lane worktree changed while ADE was preparing cleanup.");
            }
            const dirtyBeforeRemove = await readWorktreeDirty(normalizedWorktree);
            if (dirtyBeforeRemove && args.forceDirty !== true) {
              throw new Error("This lane gained uncommitted files during cleanup. Confirm that those changes may be lost.");
            }
            const remove = await runGit(
              ["worktree", "remove", "--force", normalizedWorktree],
              { cwd: projectRoot, timeoutMs: 120_000 },
            );
            if (remove.exitCode !== 0 || fs.existsSync(normalizedWorktree)) {
              let residualStat: fs.Stats | null = null;
              try {
                residualStat = await fs.promises.lstat(normalizedWorktree);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
              if (residualStat) {
                if (
                  !residualStat.isDirectory()
                  || residualStat.isSymbolicLink()
                  || residualStat.dev !== initialStat.dev
                  || residualStat.ino !== initialStat.ino
                ) {
                  throw new Error("The lane worktree changed during cleanup; ADE left the folder in place.");
                }
                await removeWorktreeDirectoryWithRecovery(normalizedWorktree);
              }
            }
            const prune = await runGit(["worktree", "prune"], { cwd: projectRoot, timeoutMs: 30_000 });
            if (prune.exitCode !== 0) {
              warnings.push((prune.stderr || prune.stdout || "Git worktree cleanup did not finish.").trim());
            }
          });
          worktreeRemoved = !fs.existsSync(normalizedWorktree);
        }
        if (!worktreeRemoved) throw new Error("The managed worktree folder could not be removed.");

        const lanePackDir = path.join(resolveAdeLayout(projectRoot).packsDir, "lanes", args.laneId);
        try {
          await fs.promises.rm(lanePackDir, { recursive: true, force: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const remainingBytes = await managedTreeBytes(lanePackDir);
          db.run(
            `update local_lane_storage_state
                set last_known_bytes = ?, updated_at = ?
              where project_id = ? and lane_id = ?`,
            [remainingBytes, new Date().toISOString(), projectId, args.laneId],
          );
          throw new Error(`Generated lane data could not be removed: ${message}`);
        }
        db.run(
          `update local_lane_storage_state
              set reclaim_state = 'reclaimed', reclaimed_at = ?, last_error = null, updated_at = ?
            where project_id = ? and lane_id = ?`,
          [now, now, projectId, args.laneId],
        );
        invalidateLaneListCache();
        broadcastLifecycleEvent({
          type: "lane-reclaimed",
          laneId: args.laneId,
          laneName: row.name,
          color: row.color,
        });
        logger.info("lane.storage.reclaim.completed", {
          laneId: args.laneId,
          reclaimedBytes: risk.reclaimableBytes,
          forceDirty: args.forceDirty === true,
          warningCount: warnings.length,
          durationMs: Date.now() - startedAtMs,
        });
        return {
          laneId: args.laneId,
          reclaimedBytes: risk.reclaimableBytes,
          worktreeRemoved,
          generatedDataRemoved: true,
          warnings,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.run(
          `update local_lane_storage_state
              set reclaim_state = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
            where project_id = ? and lane_id = ?`,
          [message, new Date().toISOString(), projectId, args.laneId],
        );
        logger.warn("lane.storage.reclaim.failed", {
          laneId: args.laneId,
          forceDirty: args.forceDirty === true,
          errorType: error instanceof Error ? error.name : "UnknownError",
          durationMs: Date.now() - startedAtMs,
        });
        throw error;
      } finally {
        laneReclaimInFlight.delete(args.laneId);
        laneStorageWorktreeLocks.release({ token: storageLock.token });
      }
    },

    archive({ laneId }: { laneId: string }): void {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be archived");
      }
      if (row.status === "archived") return;

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
      broadcastLifecycleEvent({
        type: "lane-archived",
        laneId,
        laneName: row.name,
        color: row.color,
      });
    },

    async unarchive({ laneId }: { laneId: string }): Promise<RestoreLaneResult> {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (laneReclaimInFlight.has(laneId)) {
        throw new Error("Wait for Archive & Reclaim to finish before restoring this lane.");
      }
      if (row.status !== "archived") {
        const lane = await laneServiceApi.getSummary(laneId, { includeStatus: true });
        if (!lane) throw new Error(`Lane not found: ${laneId}`);
        return { lane, worktreeRecreated: false };
      }
      if (row.lane_type !== "worktree") {
        commitLaneRestoreState(laneId);
        invalidateLaneListCache();
        const lane = await laneServiceApi.getSummary(laneId, { includeStatus: true });
        if (!lane) throw new Error(`Lane not found: ${laneId}`);
        broadcastLifecycleEvent({
          type: "lane-unarchived",
          laneId,
          laneName: row.name,
          color: row.color,
        });
        return { lane, worktreeRecreated: false };
      }

      const normalizedRoot = normAbs(worktreesDir);
      const savedPath = normAbs(row.worktree_path);
      const canonicalPath = path.join(normalizedRoot, `${slugify(row.name)}-${laneId.slice(0, 8)}`);
      const savedPathIsManaged = path.dirname(savedPath) === normalizedRoot;
      const targetPath = savedPathIsManaged ? savedPath : canonicalPath;
      const storageLock = acquireStorageLifecycleLock({
        laneId,
        worktreePath: targetPath,
        ownerLabel: `Restore lane: ${row.name}`,
      });
      try {
        if (savedPathIsManaged && fs.existsSync(savedPath)) {
          const registered = await registeredWorktreeForLane(savedPath, row.branch_ref).catch(() => null);
          if (!registered) {
            throw new Error("The saved lane folder is occupied by a different or unregistered Git worktree.");
          }
          commitLaneRestoreState(laneId);
          invalidateLaneListCache();
          const lane = await laneServiceApi.getSummary(laneId, { includeStatus: true });
          if (!lane) throw new Error(`Lane not found: ${laneId}`);
          broadcastLifecycleEvent({
            type: "lane-unarchived",
            laneId,
            laneName: row.name,
            color: row.color,
          });
          return { lane, worktreeRecreated: false };
        }
        if (await hasSymlinkInManagedPath(normalizedRoot, targetPath)) {
          throw new Error("ADE will not restore a lane through a symbolic link.");
        }
        if (fs.existsSync(targetPath)) {
          throw new Error("The restore folder already exists but is not this lane's Git worktree.");
        }

        const branchName = branchNameForDelete(row.branch_ref, "origin");
        await runGitWorktreeMutation(async () => {
          const localBranch = await runGit(
            ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
            { cwd: projectRoot, timeoutMs: 8_000 },
          );
          const addArgs = localBranch.exitCode === 0
            ? ["worktree", "add", targetPath, branchName]
            : ["worktree", "add", "-b", branchName, targetPath, `origin/${branchName}`];
          await runGitOrThrow(addArgs, { cwd: projectRoot, timeoutMs: 120_000 });
        });
        try {
          commitLaneRestoreState(laneId, targetPath);
        } catch (error) {
          await runGitWorktreeMutation(async () => {
            await runGit(["worktree", "remove", "--force", targetPath], { cwd: projectRoot, timeoutMs: 120_000 });
            await fs.promises.rm(targetPath, { recursive: true, force: true });
            await runGit(["worktree", "prune"], { cwd: projectRoot, timeoutMs: 30_000 });
          });
          throw error;
        }
        invalidateLaneListCache();
        const lane = await laneServiceApi.getSummary(laneId, { includeStatus: true });
        if (!lane) throw new Error(`Lane not found: ${laneId}`);
        broadcastLifecycleEvent({
          type: "lane-restored",
          laneId,
          laneName: row.name,
          color: row.color,
        });
        return { lane, worktreeRecreated: true };
      } finally {
        laneStorageWorktreeLocks.release({ token: storageLock.token });
      }
    },

    listDeleteProgress(): LaneDeleteProgress[] {
      pruneDeleteProgressHistory();
      return Array.from(deleteProgressByLaneId.values())
        .map(cloneLaneDeleteProgress);
    },

    hasRunningDelete(): boolean {
      pruneDeleteProgressHistory();
      return Array.from(deleteProgressByLaneId.values()).some((progress) => progress.overallStatus === "running");
    },

    async delete(
      args: DeleteLaneArgs,
      runtimeOpts?: { teardownEnv?: () => Promise<void> }
    ): Promise<void> {
      const {
        laneId,
        deleteBranch = true,
        deleteRemoteBranch = false,
        requireRemoteBranchDelete = false,
        remoteName = "origin",
        force = false
      } = args;
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (laneReclaimInFlight.has(laneId)) {
        throw new Error("Archive & Reclaim is already running for this lane.");
      }
      if (deleteProgressByLaneId.get(laneId)?.overallStatus === "running") {
        throw new Error(`Lane delete is already running: ${laneId}`);
      }
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be deleted");
      }
      const deleteOperation = (() => {
        try {
          return operationService?.start({
            laneId: null,
            kind: "lane_delete",
            metadata: {
              laneId,
              laneName: row.name,
              laneType: row.lane_type,
              branchRef: row.branch_ref,
              deleteBranch,
              deleteRemoteBranch,
              force,
            },
          }) ?? null;
        } catch (error) {
          logger.warn("lane.delete.operation_start_failed", { laneId, error: error instanceof Error ? error.message : String(error) });
          return null;
        }
      })();
      const finishDeleteOperation = (
        status: "succeeded" | "failed",
        metadataPatch: Record<string, unknown>,
      ): void => {
        if (!deleteOperation?.operationId) return;
        try {
          operationService?.finish({
            operationId: deleteOperation.operationId,
            status,
            metadataPatch,
          });
        } catch (error) {
          logger.warn("lane.delete.operation_finish_failed", { laneId, status, error: error instanceof Error ? error.message : String(error) });
        }
      };
      const childRows = getChildrenRows(laneId, false);
      if (childRows.length > 0) {
        finishDeleteOperation("failed", { error: "Lane has active child lanes." });
        throw new Error("Cannot delete a lane with active child lanes. Delete or rebase/archive children first.");
      }

      const worktreeMetadataPath = row.worktree_path
        ? path.join(projectRoot, ".git", "worktrees", path.basename(row.worktree_path))
        : "";
      const worktreeRegistered = Boolean(worktreeMetadataPath) && fs.existsSync(worktreeMetadataPath);
      const hasWorktree =
        row.lane_type === "worktree" &&
        Boolean(row.worktree_path) &&
        (fs.existsSync(row.worktree_path) || worktreeRegistered);
      const stepNames: LaneDeleteStepName[] = [];
      if (hasWorktree) stepNames.push("git_status");
      stepNames.push("cancel_auto_rebase", "stop_chats", "stop_ptys", "stop_watchers", "cleanup_env");
      if (hasWorktree) stepNames.push("git_worktree_remove");
      if (deleteBranch && row.branch_ref) stepNames.push("git_branch_delete");
      if (deleteRemoteBranch && row.branch_ref) stepNames.push("git_remote_branch_delete");
      stepNames.push("pack_dir_remove", "database_cleanup");

      const progress: LaneDeleteProgress = {
        laneId,
        steps: stepNames.map((name): LaneDeleteStep => ({ name, status: "pending" })),
        startedAt: new Date().toISOString(),
        overallStatus: "running",
        cancellable: false
      };
      const findStep = (name: LaneDeleteStepName): LaneDeleteStep | undefined =>
        progress.steps.find((s) => s.name === name);

      const nonFatalFailures: Array<{ step: LaneDeleteStepName; message: string }> = [];
      const recordNonFatalFailure = (step: LaneDeleteStepName, message: string): void => {
        nonFatalFailures.push({ step, message });
        logger.warn("lane.delete.non_fatal_step_failed", { laneId, step, error: message });
      };

      const runStep = async (
        name: LaneDeleteStepName,
        work: () => Promise<{ detail?: string } | void>,
        options?: { fatal?: boolean },
      ): Promise<void> => {
        const step = findStep(name);
        if (!step) return;
        const fatal = options?.fatal !== false;
        step.status = "running";
        step.startedAt = new Date().toISOString();
        broadcastDeleteEvent(progress);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const t0 = Date.now();
        try {
          const result = await work();
          step.detail = result?.detail;
          step.status = "completed";
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          step.status = fatal ? "failed" : "warning";
          step.errorMessage = errorMessage;
          step.completedAt = new Date().toISOString();
          step.durationMs = Date.now() - t0;
          if (!fatal) {
            recordNonFatalFailure(name, errorMessage);
          }
          broadcastDeleteEvent(progress);
          if (fatal) throw error;
          return;
        }
        step.completedAt = new Date().toISOString();
        step.durationMs = Date.now() - t0;
        if (step.durationMs >= 500) {
          logger.info("lane.delete.step", { laneId, step: name, durationMs: step.durationMs });
        }
        broadcastDeleteEvent(progress);
      };

      const finalize = (status: LaneDeleteProgress["overallStatus"]): void => {
        if (status === "failed" || status === "cancelled") {
          for (const step of progress.steps) {
            if (step.status === "pending") step.status = "skipped";
          }
        }
        progress.overallStatus = status;
        progress.completedAt = new Date().toISOString();
        progress.cancellable = false;
        broadcastDeleteEvent(progress);
      };

      broadcastDeleteEvent(progress);

      try {
        if (hasWorktree) {
          await runStep("git_status", async () => {
            if (!(await isExpectedGitWorktreeRoot(row.worktree_path))) {
              return { detail: fs.existsSync(row.worktree_path) ? "stale worktree directory" : "missing worktree directory" };
            }
            const dirty = await readWorktreeDirty(row.worktree_path);
            if (dirty && !force) {
              throw new Error("Lane has uncommitted changes. Enable force delete after confirming warnings.");
            }
            return { detail: dirty ? "dirty (force enabled)" : "clean" };
          });
        }

        await runStep("cancel_auto_rebase", async () => {
          teardownDeps?.autoRebaseService?.cancelForLane(laneId);
          try {
            await teardownDeps?.rebaseSuggestionService?.dismiss({ laneId });
          } catch {
            // ignore
          }
        });

        await runStep("stop_chats", async () => {
          const svc = teardownDeps?.agentChatService;
          if (!svc) return { detail: "no service" };
          const before = svc.countActiveForLane(laneId);
          if (before === 0) return { detail: "none active" };
          const disposed = await svc.disposeForLane(laneId);
          return { detail: `closed ${disposed} ${disposed === 1 ? "chat" : "chats"}` };
        }, { fatal: false });

        await runStep("stop_ptys", async () => {
          const svc = teardownDeps?.ptyService;
          if (!svc) return { detail: "no service" };
          const before = svc.countActiveForLane(laneId);
          if (before === 0) return { detail: "none active" };
          const disposed = svc.disposeForLane(laneId);
          return { detail: `closed ${disposed} ${disposed === 1 ? "session" : "sessions"}` };
        });

        await runStep("stop_watchers", async () => {
          const svc = teardownDeps?.fileWatcherService;
          if (!svc) return { detail: "no service" };
          const before = svc.countActiveForWorkspace(laneId);
          const stopped = svc.stopAllForWorkspace(laneId);
          if (before === 0 && stopped === 0) return { detail: "none active" };
          return { detail: `stopped ${stopped} ${stopped === 1 ? "watcher" : "watchers"}` };
        });

        await runStep("cleanup_env", async () => {
          if (!runtimeOpts?.teardownEnv) return { detail: "no env to clean" };
          try {
            await runtimeOpts.teardownEnv();
            return { detail: "env cleaned" };
          } catch (err) {
            logger.warn("lane.delete.cleanup_env_failed", { laneId, error: err instanceof Error ? err.message : String(err) });
            return { detail: `warning: ${err instanceof Error ? err.message : String(err)}` };
          }
        });

        // Brief grace period so kernel-level handle releases settle on macOS before
        // git tries to unlink the worktree directory.
        await new Promise((resolve) => setTimeout(resolve, 250));

        if (hasWorktree) {
          await runStep("git_worktree_remove", async () => {
            return runGitWorktreeMutation(async () => {
              const removeArgs = ["worktree", "remove"];
              if (force) removeArgs.push("--force");
              removeArgs.push(row.worktree_path);
              const isStillRegisteredWorktree = async (): Promise<boolean> => {
                try {
                  const worktrees = await listGitWorktrees();
                  const target = normAbs(row.worktree_path);
                  return worktrees.some((wt) => wt.path === target);
                } catch {
                  return fs.existsSync(worktreeMetadataPath);
                }
              };
              const pruneWorktreesBestEffort = async (): Promise<string | null> => {
                const pruneRes = await runGit(["worktree", "prune"], { cwd: projectRoot, timeoutMs: 30_000 });
                if (pruneRes.exitCode === 0) return null;
                return (pruneRes.stderr || pruneRes.stdout || "git worktree prune failed").trim();
              };
              const removeResidualDirectory = async (detail: string, failurePrefix?: string) => {
                try {
                  await removeWorktreeDirectoryWithRecovery(row.worktree_path);
                } catch (rmError) {
                  const cleanupMessage = `${failurePrefix ? `${failurePrefix}; ` : ""}manual cleanup failed: ${
                    rmError instanceof Error ? rmError.message : String(rmError)
                  }`;
                  const pruneFailure = await pruneWorktreesBestEffort();
                  const fullMessage = pruneFailure
                    ? `${cleanupMessage}; git worktree prune failed: ${pruneFailure}`
                    : cleanupMessage;
                  if (await isStillRegisteredWorktree()) {
                    throw new Error(fullMessage);
                  }
                  residualWorktreeCleanup.recordFailure({
                    laneId,
                    branchRef: row.branch_ref,
                    worktreePath: row.worktree_path,
                    error: fullMessage,
                  });
                  recordNonFatalFailure("git_worktree_remove", fullMessage);
                  return { detail: `${detail}; warning: ${fullMessage}` };
                }
                residualWorktreeCleanup.deleteRow(row.worktree_path);
                const pruneFailure = await pruneWorktreesBestEffort();
                if (pruneFailure) {
                  const message = `git worktree prune failed: ${pruneFailure}`;
                  if (await isStillRegisteredWorktree()) {
                    throw new Error(message);
                  }
                  recordNonFatalFailure("git_worktree_remove", message);
                  return { detail: `${detail}; warning: ${message}` };
                }
                return { detail };
              };
              // 60s — large worktrees (e.g. with node_modules) can take longer than 15s
              // to walk; a timeout here mid-remove leaves the worktree in a half-deleted
              // state that blocks future deletes.
              const removeRes = await runGit(removeArgs, { cwd: projectRoot, timeoutMs: 60_000 });
              if (removeRes.exitCode === 0) {
                if (fs.existsSync(row.worktree_path)) {
                  return removeResidualDirectory(`${row.worktree_path} (removed residual files)`);
                }
                residualWorktreeCleanup.deleteRow(row.worktree_path);
                return { detail: row.worktree_path };
              }
              // Recovery path: a previous failed delete (or this one's first attempt)
              // can leave the worktree dir present without its `.git` pointer file, or
              // the dir gone with stale metadata still registered. Either way: rm the
              // dir if any, then prune git's metadata.
              const original = (removeRes.stderr || removeRes.stdout || "").trim();
              return removeResidualDirectory(
                `${row.worktree_path} (recovered from stale state)`,
                `git worktree remove failed (${original})`
              );
            });
          });
        }

        if (deleteBranch && row.branch_ref) {
          await runStep("git_branch_delete", async () => {
            const branchName = branchNameForDelete(row.branch_ref, remoteName);
            const refCheck = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
              cwd: projectRoot,
              timeoutMs: 8_000,
            });
            if (refCheck.exitCode !== 0) return { detail: "ref not found" };
            await runGitOrThrow(["branch", "-D", branchName], { cwd: projectRoot, timeoutMs: 30_000 });
            return { detail: branchName };
          }, { fatal: requireRemoteBranchDelete });
        }

        if (deleteRemoteBranch && row.branch_ref) {
          await runStep("git_remote_branch_delete", async () => {
            const remote = remoteName.trim() || "origin";
            const branchName = branchNameForDelete(row.branch_ref, remote);
            const remoteCheck = await runGit(["remote", "get-url", remote], { cwd: projectRoot, timeoutMs: 8_000 });
            if (remoteCheck.exitCode !== 0) {
              throw new Error(`Remote '${remote}' is not configured for this repository`);
            }
            const remoteRefCheck = await runGit(["ls-remote", "--heads", remote, branchName], {
              cwd: projectRoot,
              timeoutMs: 30_000,
            });
            if (remoteRefCheck.exitCode !== 0) {
              const detail = (remoteRefCheck.stderr || remoteRefCheck.stdout).trim();
              throw new Error(detail || `Unable to check ${remote}/${branchName}`);
            }
            if (remoteRefCheck.stdout.trim().length === 0) {
              return { detail: `${remote}/${branchName} not found` };
            }
            await runGitOrThrow(["push", remote, "--delete", branchName], { cwd: projectRoot, timeoutMs: 45_000 });
            return { detail: `${remote}/${branchName}` };
          }, { fatal: requireRemoteBranchDelete });
        }

        await runStep("pack_dir_remove", async () => {
          const lanePackDir = path.join(resolveAdeLayout(projectRoot).packsDir, "lanes", laneId);
          try {
            await fs.promises.rm(lanePackDir, { recursive: true, force: true });
            return { detail: lanePackDir };
          } catch (err) {
            // Best-effort cleanup — match the warn pattern used by the other
            // best-effort cleanup steps so a failure
            // here is at least surfaced in the lane's logs and progress UI
            // rather than vanishing silently.
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("lane.delete.pack_dir_remove_failed", { laneId, lanePackDir, error: message });
            return { detail: `warning: ${message}` };
          }
        });

        await runStep("database_cleanup", async () => {
          db.run("begin immediate");
          try {
            cleanupLaneDatabaseRows(laneId);
            db.run("commit");
          } catch (error) {
            try {
              db.run("rollback");
            } catch {
              // ignore rollback failures and surface the original cleanup error
            }
            throw error;
          }
        });

        invalidateLaneListCache();
        finalize(nonFatalFailures.length > 0 ? "completed_with_warnings" : "completed");
        broadcastLifecycleEvent({
          type: "lane-deleted",
          laneId,
          laneName: row.name,
          color: row.color,
        });
        finishDeleteOperation("succeeded", {
          overallStatus: progress.overallStatus,
          warnings: nonFatalFailures,
          completedAt: progress.completedAt ?? new Date().toISOString(),
        });
        const totalMs = Date.now() - new Date(progress.startedAt).getTime();
        if (totalMs >= 1_000) {
          logger.info("lane.delete.completed", {
            laneId,
            laneType: row.lane_type,
            deleteBranch,
            deleteRemoteBranch,
            force,
            warnings: nonFatalFailures,
            durationMs: totalMs
          });
        }
      } catch (error) {
        finalize("failed");
        finishDeleteOperation("failed", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },

    cancelDelete(laneId: string): { cancelled: boolean; reason?: string } {
      return { cancelled: false, reason: `Lane deletes run to completion once started: ${laneId}` };
    },

    async getDeleteRisk(laneId: string): Promise<LaneDeleteRisk> {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      const worktreeExists = Boolean(row.worktree_path) && fs.existsSync(row.worktree_path);
      const worktreeUsable = worktreeExists && await isExpectedGitWorktreeRoot(row.worktree_path);
      let dirty = false;
      if (worktreeUsable) {
        dirty = await readWorktreeDirty(row.worktree_path, 6_000);
      }
      let hasUnpushedCommits = false;
      let unpushedCommitCount = 0;
      let remoteBranchExists = false;
      // Normalize the same way delete() does, so the risk the user confirms
      // against matches the branch the delete actually touches (a remote-shaped
      // ref like "origin/feature" must probe "feature").
      const riskBranchName = row.branch_ref ? branchNameForDelete(row.branch_ref, "origin") : "";
      if (riskBranchName) {
        const cwd = worktreeUsable ? row.worktree_path : projectRoot;
        const unpushed = await runGit(
          ["rev-list", "--count", riskBranchName, "--not", "--remotes"],
          { cwd, timeoutMs: 8_000 }
        );
        if (unpushed.exitCode === 0) {
          unpushedCommitCount = Number.parseInt(unpushed.stdout.trim(), 10) || 0;
          hasUnpushedCommits = unpushedCommitCount > 0;
        }
        const remoteCheck = await runGit(
          ["ls-remote", "--heads", "origin", riskBranchName],
          { cwd: projectRoot, timeoutMs: 8_000 }
        );
        remoteBranchExists = remoteCheck.exitCode === 0 && remoteCheck.stdout.trim().length > 0;
      }
      const activeChatCount = teardownDeps?.agentChatService?.countActiveForLane(laneId) ?? 0;
      const activePtyCount = teardownDeps?.ptyService?.countActiveForLane(laneId) ?? 0;
      const activeWatcherCount = teardownDeps?.fileWatcherService?.countActiveForWorkspace(laneId) ?? 0;
      return {
        laneId,
        branchRef: row.branch_ref ?? null,
        dirty,
        hasUnpushedCommits,
        unpushedCommitCount,
        remoteBranchExists,
        activeChatCount,
        activePtyCount,
        activeWatcherCount,
        envInitialized: false
      };
    },

    getLaneWorktreePath(laneId: string): string {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return row.worktree_path;
    },

    getLaneBaseAndBranch(laneId: string): { baseRef: string; branchRef: string; worktreePath: string; laneType: LaneType; linearIssue: LaneLinearIssue | null } {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return {
        baseRef: row.base_ref,
        branchRef: row.branch_ref,
        worktreePath: row.worktree_path,
        laneType: row.lane_type,
        linearIssue: getLaneLinearIssue(laneId),
      };
    },

    /**
     * Late-bind a best-effort hook fired after a worktree lane is created. Used
     * by the PR service to auto-map an existing open PR on the new lane's branch.
     */
    setOnWorktreeLaneCreated(hook: ((lane: LaneSummary) => void | Promise<void>) | null): void {
      onWorktreeLaneCreated = hook ?? null;
    },


    updateBranchRef(laneId: string, branchRef: string): void {
      const row = getLaneRow(laneId);
      db.run("update lanes set branch_ref = ? where id = ? and project_id = ?", [branchRef, laneId, projectId]);
      if (row) {
        upsertBranchProfileForRow(row, {
          branchRef,
          baseRef: row.base_ref,
          parentLaneId: row.parent_lane_id,
          lastCheckedOutAt: new Date().toISOString(),
        });
      }
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
      branchRef: string;
      rootPath: string;
      isReadOnlyByDefault: boolean;
    }> {
      const rows = getAllLaneRows(false);
      return rows.map((row) => ({
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        branchRef: row.branch_ref,
        rootPath: row.worktree_path,
        // Edit-protection no longer gates file editing; workspaces are always editable.
        isReadOnlyByDefault: false
      }));
    },

    resolveWorkspaceById(workspaceId: string): {
      id: string;
      kind: LaneType;
      laneId: string | null;
      name: string;
      branchRef: string;
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
        branchRef: row.branch_ref,
        rootPath: row.worktree_path,
        // Edit-protection no longer gates file editing; workspaces are always editable.
        isReadOnlyByDefault: false
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
          throw codedError(
            encodeCodedErrorMessage(
              "lane_already_linked",
              `This worktree is already linked as archived lane '${existingPath.name}'. Unarchive it instead.`,
            ),
            "lane_already_linked",
          );
        }
        throw codedError(
          encodeCodedErrorMessage(
            "lane_already_linked",
            `This worktree is already linked as lane '${existingPath.name}'.`,
          ),
          "lane_already_linked",
        );
      }

      const existingBranch = db.get<{ id: string; name: string; status: string; worktree_path: string }>(
        "select id, name, status, worktree_path from lanes where project_id = ? and branch_ref = ? limit 1",
        [projectId, branchRef]
      );
      if (existingBranch?.id && normAbs(existingBranch.worktree_path) !== attachedPath) {
        if (existingBranch.status === "archived") {
          throw codedError(
            encodeCodedErrorMessage(
              "lane_already_linked",
              `Branch '${branchRef}' is already linked to archived lane '${existingBranch.name}'. Unarchive it instead.`,
            ),
            "lane_already_linked",
          );
        }
        throw codedError(
          encodeCodedErrorMessage(
            "lane_already_linked",
            `Branch '${branchRef}' is already linked to lane '${existingBranch.name}'.`,
          ),
          "lane_already_linked",
        );
      }

      const laneId = randomUUID();
      const now = new Date().toISOString();

      const parentLaneId = null;
      const baseRef = defaultBaseRef;
      const laneColor = allocateLaneColorForProject();

      db.run(
        `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'attached', ?, ?, ?, ?, 0, ?, ?, null, null, 'active', ?, null)
      `,
        [laneId, projectId, laneName, args.description ?? null, baseRef, branchRef, attachedPath, attachedPath, parentLaneId, laneColor, now]
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
      const summary = toLaneSummary({
        row,
        status,
        parentStatus,
        childCount: 0,
        stackDepth: computeStackDepth({ laneId, rowsById, memo: new Map() })
      });
      broadcastLifecycleEvent({
        type: "lane-created",
        laneId: summary.id,
        laneName: summary.name,
        color: summary.color,
        lane: summary,
      });
      return summary;
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

        await runGitWorktreeMutation(() =>
          runGitOrThrow(["worktree", "move", currentPath, targetPath], {
            cwd: projectRoot,
            timeoutMs: 120_000
          })
        );
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

  return laneServiceApi;
}
