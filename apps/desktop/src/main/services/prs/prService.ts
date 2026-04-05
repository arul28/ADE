import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreatePrFromLaneArgs,
  CreateQueuePrsArgs,
  CreateQueuePrsResult,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  CreateIntegrationLaneForProposalArgs,
  CreateIntegrationLaneForProposalResult,
  CommitIntegrationArgs,
  CleanupIntegrationWorkflowArgs,
  CleanupIntegrationWorkflowResult,
  DeleteIntegrationProposalArgs,
  DeleteIntegrationProposalResult,
  DismissIntegrationCleanupArgs,
  DraftPrDescriptionArgs,
  DeletePrArgs,
  DeletePrResult,
  IntegrationLaneChangeStatus,
  IntegrationLaneSnapshot,
  GitHubRepoRef,
  IntegrationLaneSummary,
  IntegrationPairwiseResult,
  IntegrationProposal,
  IntegrationProposalStep,
  IntegrationResolutionState,
  IntegrationStepResolution,
  IntegrationCleanupState,
  IntegrationWorkflowDisplayState,
  LandResult,
  LandPrArgs,
  LandQueueNextArgs,
  LandStackArgs,
  LandStackEnhancedArgs,
  LaneSummary,
  ListIntegrationWorkflowsArgs,
  LinkPrToLaneArgs,
  PrCheck,
  PrComment,
  PrChecksStatus,
  PrConflictAnalysis,
  PrGroupMemberRole,
  PrHealth,
  PrMergeContext,
  PrReview,
  PrReviewStatus,
  PrState,
  PrStatus,
  PrSummary,
  PrWithConflicts,
  QueueLandingState,
  ReorderQueuePrsArgs,
  RecheckIntegrationStepArgs,
  RecheckIntegrationStepResult,
  SimulateIntegrationArgs,
  StartIntegrationResolutionArgs,
  StartIntegrationResolutionResult,
  UpdateIntegrationProposalArgs,
  UpdatePrDescriptionArgs,
  AddPrCommentArgs,
  UpdatePrTitleArgs,
  UpdatePrBodyArgs,
  SetPrLabelsArgs,
  RequestPrReviewersArgs,
  SubmitPrReviewArgs,
  ClosePrArgs,
  ReopenPrArgs,
  RerunPrChecksArgs,
  AiReviewSummaryArgs,
  AiReviewSummary,
  GitHubPrListItem,
  GitHubPrSnapshot,
  PrDetail,
  PrFile,
  PrActionRun,
  PrActionJob,
  PrActionStep,
  PrActivityEvent,
  PrLabel,
  PrUser,
  PrReviewThread,
  PrReviewThreadComment,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createAutoRebaseService } from "../lanes/autoRebaseService";
import type { createRebaseSuggestionService } from "../lanes/rebaseSuggestionService";
import type { createOperationService } from "../history/operationService";
import type { createGithubService } from "../github/githubService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createAgentChatService } from "../chat/agentChatService";
import { runGit, runGitMergeTree, runGitOrThrow } from "../git/git";
import { extractFirstJsonObject } from "../ai/utils";
import { buildIntegrationPreflight } from "./integrationPlanning";
import { hasMergeConflictMarkers, parseGitStatusPorcelain } from "./integrationValidation";
import { fetchRemoteTrackingBranch } from "../shared/queueRebase";
import { asNumber, asString, getErrorMessage, normalizeBranchName, nowIso, resolvePathWithinRoot } from "../shared/utils";
import { branchNameFromLaneRef, resolveStableLaneBaseBranch } from "../../../shared/laneBaseResolution";

type PullRequestRow = {
  id: string;
  lane_id: string;
  project_id: string;
  repo_owner: string;
  repo_name: string;
  github_pr_number: number;
  github_url: string;
  github_node_id: string | null;
  title: string | null;
  state: string;
  base_branch: string;
  head_branch: string;
  checks_status: string | null;
  review_status: string | null;
  additions: number | null;
  deletions: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

type PullRequestSnapshotHydration = {
  prId: string;
  detail: PrDetail | null;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  files: PrFile[];
  updatedAt: string | null;
};

type IntegrationProposalRow = {
  id: string;
  source_lane_ids_json: string;
  base_branch: string;
  steps_json: string;
  overall_outcome: string;
  created_at: string;
  title: string | null;
  body: string | null;
  draft: number | null;
  integration_lane_name: string | null;
  status: string;
  integration_lane_id: string | null;
  preferred_integration_lane_id: string | null;
  resolution_state_json: string | null;
  pairwise_results_json: string | null;
  lane_summaries_json: string | null;
  linked_group_id: string | null;
  linked_pr_id: string | null;
  workflow_display_state: string | null;
  cleanup_state: string | null;
  closed_at: string | null;
  merged_at: string | null;
  completed_at: string | null;
  cleanup_declined_at: string | null;
  cleanup_completed_at: string | null;
  merge_into_head_sha: string | null;
};

type PrGroupLookupRow = {
  group_id: string;
  group_type: "queue" | "integration";
};

type PrGroupMemberLookupRow = {
  group_id: string;
  pr_id: string;
  lane_id: string;
  position: number;
  role: string;
  lane_name: string | null;
  pr_number: number | null;
};

function branchNameFromRef(ref: string): string {
  return branchNameFromLaneRef(ref);
}

function normalizeGroupMemberRole(raw: string): PrGroupMemberRole {
  if (raw === "source" || raw === "integration" || raw === "target") return raw;
  return "source";
}

function parseWorkflowDisplayState(raw: string | null | undefined): IntegrationWorkflowDisplayState {
  return raw === "history" ? "history" : "active";
}

function parseCleanupState(raw: string | null | undefined): IntegrationCleanupState {
  return raw === "required" || raw === "declined" || raw === "completed" ? raw : "none";
}

function createEmptyIntegrationResolutionState(integrationLaneId: string, updatedAt = nowIso()): IntegrationResolutionState {
  return {
    integrationLaneId,
    stepResolutions: {},
    activeWorkerStepId: null,
    activeLaneId: null,
    createdSnapshot: null,
    currentSnapshot: null,
    laneChangeStatus: "unknown",
    updatedAt,
  };
}

async function readIntegrationLaneSnapshot(worktreePath: string): Promise<IntegrationLaneSnapshot | null> {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  const [headRes, statusRes] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 }),
    runGit(["status", "--porcelain"], { cwd: worktreePath, timeoutMs: 8_000 }),
  ]);
  if (headRes.exitCode !== 0 || statusRes.exitCode !== 0) return null;
  return {
    headSha: headRes.stdout.trim() || null,
    dirty: statusRes.stdout.trim().length > 0,
  };
}

type ConflictExcerpts = {
  conflictType: "content" | null;
  conflictMarkers: string;
  oursExcerpt: string | null;
  theirsExcerpt: string | null;
  diffHunk: string | null;
};

function parseConflictMarkers(content: string): ConflictExcerpts {
  const markerRegex = /(<<<<<<<[^\r\n]*\r?\n)([\s\S]*?)(=======\r?\n)([\s\S]*?)(>>>>>>>[^\r\n]*)/g;
  const markers: string[] = [];
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(content)) !== null) {
    markers.push(match[0]);
    oursLines.push(match[2]!.trim());
    theirsLines.push(match[4]!.trim());
  }
  return {
    conflictType: "content",
    conflictMarkers: markers.join("\n---\n").slice(0, 2000),
    oursExcerpt: oursLines.join("\n---\n").slice(0, 500) || null,
    theirsExcerpt: theirsLines.join("\n---\n").slice(0, 500) || null,
    diffHunk: markers.map((entry) => entry.split("\n").slice(0, 12).join("\n")).join("\n...\n").slice(0, 500) || null,
  };
}

const EMPTY_CONFLICT_EXCERPTS: ConflictExcerpts = {
  conflictType: null,
  conflictMarkers: "",
  oursExcerpt: null,
  theirsExcerpt: null,
  diffHunk: null,
};

function readConflictFilePreviewFromWorktree(worktreePath: string, filePath: string): IntegrationProposalStep["conflictingFiles"][number] {
  const root = path.resolve(worktreePath);
  let absPath: string;
  try {
    absPath = resolvePathWithinRoot(root, filePath);
  } catch {
    return { path: filePath, ...EMPTY_CONFLICT_EXCERPTS };
  }

  try {
    const content = fs.readFileSync(absPath, "utf8");
    if (!hasMergeConflictMarkers(content)) {
      return { path: filePath, ...EMPTY_CONFLICT_EXCERPTS };
    }
    return { path: filePath, ...parseConflictMarkers(content) };
  } catch {
    return { path: filePath, ...EMPTY_CONFLICT_EXCERPTS };
  }
}

function getIntegrationLaneChangeStatus(
  createdSnapshot: IntegrationLaneSnapshot | null | undefined,
  currentSnapshot: IntegrationLaneSnapshot | null | undefined
): IntegrationLaneChangeStatus {
  if (!currentSnapshot) return "missing";
  if (!createdSnapshot) return "unknown";
  return createdSnapshot.headSha === currentSnapshot.headSha && createdSnapshot.dirty === currentSnapshot.dirty
    ? "unchanged"
    : "changed";
}

async function hydrateIntegrationResolutionState(args: {
  laneById: Map<string, LaneSummary>;
  resolutionState: IntegrationResolutionState | null;
  integrationLaneId: string | null;
  fallbackUpdatedAt?: string;
}): Promise<IntegrationResolutionState | null> {
  const { laneById, resolutionState, integrationLaneId, fallbackUpdatedAt } = args;
  if (!integrationLaneId) return resolutionState;
  const lane = laneById.get(integrationLaneId);
  const currentSnapshot = lane ? await readIntegrationLaneSnapshot(lane.worktreePath) : null;
  const nextState = resolutionState
    ? { ...resolutionState }
    : createEmptyIntegrationResolutionState(integrationLaneId, fallbackUpdatedAt ?? nowIso());
  nextState.integrationLaneId = integrationLaneId;
  nextState.currentSnapshot = currentSnapshot;
  nextState.laneChangeStatus = getIntegrationLaneChangeStatus(nextState.createdSnapshot, currentSnapshot);
  return nextState;
}

function toPrState(args: { state: string; draft: boolean; mergedAt: string | null }): PrState {
  if (args.mergedAt) return "merged";
  const state = args.state.toLowerCase();
  if (state === "open" && args.draft) return "draft";
  if (state === "open") return "open";
  return "closed";
}

function toChecksStatus(state: string | null | undefined): PrChecksStatus {
  const value = (state ?? "").toLowerCase();
  if (value === "success") return "passing";
  if (value === "failure" || value === "error") return "failing";
  if (value === "pending") return "pending";
  return "none";
}

function toChecksStatusFromCheckRuns(checkRuns: any[]): PrChecksStatus | null {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) return null;

  let hasPending = false;
  let hasFailure = false;
  let hasSuccessLike = false;
  for (const run of checkRuns) {
    const status = asString(run?.status).toLowerCase();
    const conclusion = asString(run?.conclusion).toLowerCase();
    if (status && status !== "completed") {
      hasPending = true;
      continue;
    }
    if (!conclusion) continue;
    if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
      hasSuccessLike = true;
      continue;
    }
    if (
      conclusion === "failure" ||
      conclusion === "cancelled" ||
      conclusion === "timed_out" ||
      conclusion === "action_required" ||
      conclusion === "stale"
    ) {
      hasFailure = true;
    }
  }

  if (hasPending) return "pending";
  if (hasFailure) return "failing";
  if (hasSuccessLike) return "passing";
  return "none";
}

function computeReviewStatus(args: { requestedReviewers: string[]; reviewStatesByUser: Map<string, string> }): PrReviewStatus {
  for (const state of args.reviewStatesByUser.values()) {
    if (state === "CHANGES_REQUESTED") return "changes_requested";
  }
  for (const state of args.reviewStatesByUser.values()) {
    if (state === "APPROVED") return "approved";
  }
  if (args.requestedReviewers.length > 0) return "requested";
  return "none";
}

function rowToSummary(row: PullRequestRow): PrSummary {
  return {
    id: row.id,
    laneId: row.lane_id,
    projectId: row.project_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    githubPrNumber: Number(row.github_pr_number),
    githubUrl: row.github_url,
    githubNodeId: row.github_node_id,
    title: row.title ?? "",
    state: (row.state as PrState) ?? "open",
    baseBranch: row.base_branch,
    headBranch: row.head_branch,
    checksStatus: (row.checks_status as PrChecksStatus) ?? "none",
    reviewStatus: (row.review_status as PrReviewStatus) ?? "none",
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    lastSyncedAt: row.last_synced_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const BACKGROUND_REFRESH_MAX_PRS = 4;
const BACKGROUND_REFRESH_MIN_STALE_MS = 2 * 60_000;
const BACKGROUND_REFRESH_CLOSED_STALE_MS = 15 * 60_000;

function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBackgroundRefreshCandidate(row: PullRequestRow, nowMs: number): boolean {
  const state = String(row.state ?? "").toLowerCase();
  const isActive = state === "open" || state === "draft";
  const staleAfterMs = isActive ? BACKGROUND_REFRESH_MIN_STALE_MS : BACKGROUND_REFRESH_CLOSED_STALE_MS;
  const lastSyncedAtMs = parseIsoMs(row.last_synced_at);
  if (lastSyncedAtMs <= 0) return true;
  return nowMs - lastSyncedAtMs >= staleAfterMs;
}

function compareBackgroundRefreshPriority(left: PullRequestRow, right: PullRequestRow): number {
  const leftState = String(left.state ?? "").toLowerCase();
  const rightState = String(right.state ?? "").toLowerCase();
  const leftActive = leftState === "open" || leftState === "draft";
  const rightActive = rightState === "open" || rightState === "draft";
  if (leftActive !== rightActive) return leftActive ? -1 : 1;

  const lastSyncedDiff = parseIsoMs(left.last_synced_at) - parseIsoMs(right.last_synced_at);
  if (lastSyncedDiff !== 0) return lastSyncedDiff;

  return parseIsoMs(right.updated_at) - parseIsoMs(left.updated_at);
}

function hasMaterialSummaryChange(row: PullRequestRow, summary: PrSummary): boolean {
  return row.state !== summary.state
    || row.checks_status !== summary.checksStatus
    || row.review_status !== summary.reviewStatus
    || (row.title ?? "") !== summary.title
    || row.base_branch !== summary.baseBranch
    || row.head_branch !== summary.headBranch
    || row.github_url !== summary.githubUrl
    || (row.github_node_id ?? "") !== (summary.githubNodeId ?? "")
    || Number(row.additions ?? 0) !== Number(summary.additions ?? 0)
    || Number(row.deletions ?? 0) !== Number(summary.deletions ?? 0);
}

function parsePrLocator(raw: string): { owner?: string; repo?: string; number: number } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("PR URL or number is required");
  if (/^[0-9]+$/.test(trimmed)) {
    return { number: Number(trimmed) };
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([0-9]+)(?:\/|$)/);
    if (!match) throw new Error("Invalid PR URL format");
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  } catch {
    throw new Error("Invalid PR URL format");
  }
}

function readPrTemplate(projectRoot: string): string | null {
  const templatePath = path.join(projectRoot, ".github", "PULL_REQUEST_TEMPLATE.md");
  if (!fs.existsSync(templatePath)) return null;
  try {
    const raw = fs.readFileSync(templatePath, "utf8");
    return raw.trim().length ? raw : null;
  } catch {
    return null;
  }
}


function parsePrDraftJson(text: string): { title: string; body: string } | null {
  const candidate = extractFirstJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const title = asString((parsed as Record<string, unknown>).title).trim();
    const body = asString((parsed as Record<string, unknown>).body).trim();
    if (!title.length || !body.length) return null;
    return { title, body: `${body}\n` };
  } catch {
    return null;
  }
}

function parseDiffStatOutput(stdout: string): IntegrationProposalStep["diffStat"] {
  const match = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/i
  );
  if (!match) return { insertions: 0, deletions: 0, filesChanged: 0 };
  return {
    insertions: Number(match[2] ?? 0),
    deletions: Number(match[3] ?? 0),
    filesChanged: Number(match[1] ?? 0)
  };
}

const DIRTY_WORKTREE_PREFIX = "DIRTY_WORKTREE:";

function formatDirtyWorktreeError(lanes: LaneSummary[]): Error {
  const names = lanes.map((lane) => lane.name).join(", ");
  return new Error(
    `${DIRTY_WORKTREE_PREFIX} Uncommitted changes detected in ${names}. Commit, stash, or discard them before creating the PR, or explicitly continue anyway.`
  );
}

function toJobStatus(raw: unknown): "queued" | "in_progress" | "completed" {
  const s = asString(raw).toLowerCase();
  if (s === "queued") return "queued";
  if (s === "in_progress") return "in_progress";
  return "completed";
}

function toRunStatus(raw: unknown): "queued" | "in_progress" | "waiting" | "completed" {
  const s = asString(raw).toLowerCase();
  if (s === "queued") return "queued";
  if (s === "in_progress") return "in_progress";
  if (s === "waiting") return "waiting";
  return "completed";
}

function toJobConclusion(raw: unknown): "success" | "failure" | "neutral" | "cancelled" | "skipped" | null {
  const c = asString(raw).toLowerCase();
  if (c === "success") return "success";
  if (c === "failure") return "failure";
  if (c === "neutral") return "neutral";
  if (c === "cancelled") return "cancelled";
  if (c === "skipped") return "skipped";
  return null;
}

function toRunConclusion(
  raw: unknown
): "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null {
  const base = toJobConclusion(raw);
  if (base) return base;
  const c = asString(raw).toLowerCase();
  if (c === "timed_out") return "timed_out";
  if (c === "action_required") return "action_required";
  return null;
}

function toFileStatus(raw: unknown): PrFile["status"] {
  const s = asString(raw).toLowerCase();
  if (s === "added") return "added";
  if (s === "removed") return "removed";
  if (s === "renamed") return "renamed";
  if (s === "copied") return "copied";
  return "modified";
}

function toUser(raw: any): PrUser {
  return {
    login: asString(raw?.login) || "",
    avatarUrl: asString(raw?.avatar_url) || null
  };
}

function toLabel(raw: any): PrLabel {
  return {
    name: asString(raw?.name) || "",
    color: asString(raw?.color) || "",
    description: asString(raw?.description) || null
  };
}

function parseJsonArrayOrEmpty<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function createPrService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  operationService,
  githubService,
  aiIntegrationService,
  projectConfigService,
  conflictService,
  autoRebaseService,
  rebaseSuggestionService,
  openExternal,
  onHotRefreshChanged,
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  operationService: ReturnType<typeof createOperationService>;
  githubService: ReturnType<typeof createGithubService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  conflictService?: ReturnType<typeof createConflictService>;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  openExternal: (url: string) => Promise<void>;
  onHotRefreshChanged?: () => void;
}) {
  const PR_COLUMNS = `id, lane_id, project_id, repo_owner, repo_name, github_pr_number,
    github_url, github_node_id, title, state, base_branch, head_branch,
    checks_status, review_status, additions, deletions, last_synced_at,
    created_at, updated_at`;

  const getRow = (prId: string): PullRequestRow | null =>
    db.get<PullRequestRow>(
      `select ${PR_COLUMNS} from pull_requests where id = ? and project_id = ? limit 1`,
      [prId, projectId]
    );

  const requireRow = (prId: string): PullRequestRow => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    return row;
  };

  const repoFromRow = (row: PullRequestRow): GitHubRepoRef => ({
    owner: row.repo_owner,
    name: row.repo_name
  });

  const getRowForLane = (laneId: string): PullRequestRow | null =>
    db.get<PullRequestRow>(
      `select ${PR_COLUMNS} from pull_requests where lane_id = ? and project_id = ? limit 1`,
      [laneId, projectId]
    );

  const listRows = (): PullRequestRow[] =>
    db.all<PullRequestRow>(
      `select ${PR_COLUMNS} from pull_requests where project_id = ? order by updated_at desc`,
      [projectId]
    );

  const HOT_REFRESH_PHASE_ONE_MS = 60_000;
  const HOT_REFRESH_PHASE_TWO_MS = 3 * 60_000;
  const HOT_REFRESH_INTERVAL_PHASE_ONE_MS = 5_000;
  const HOT_REFRESH_INTERVAL_PHASE_TWO_MS = 15_000;
  const hotRefreshStartedAtByPrId = new Map<string, number>();

  const invalidateGithubSnapshotCache = (): void => {
    cachedGithubSnapshot = null;
    cachedGithubSnapshotAt = 0;
  };

  const pruneExpiredHotRefreshes = (nowMs = Date.now()): void => {
    for (const [prId, startedAt] of Array.from(hotRefreshStartedAtByPrId.entries())) {
      if (nowMs - startedAt >= HOT_REFRESH_PHASE_TWO_MS) {
        hotRefreshStartedAtByPrId.delete(prId);
      }
    }
  };

  const markHotRefresh = (prIds: string[]): void => {
    const nowMs = Date.now();
    const uniquePrIds = [...new Set(prIds.map((prId) => String(prId ?? "").trim()).filter(Boolean))];
    if (uniquePrIds.length === 0) return;
    for (const prId of uniquePrIds) {
      hotRefreshStartedAtByPrId.set(prId, nowMs);
    }
    invalidateGithubSnapshotCache();
    onHotRefreshChanged?.();
  };

  const getHotRefreshPrIds = (nowMs = Date.now()): string[] => {
    pruneExpiredHotRefreshes(nowMs);
    return Array.from(hotRefreshStartedAtByPrId.keys());
  };

  const getHotRefreshDelayMs = (nowMs = Date.now()): number | null => {
    pruneExpiredHotRefreshes(nowMs);
    let nextDelay: number | null = null;
    for (const startedAt of hotRefreshStartedAtByPrId.values()) {
      const ageMs = nowMs - startedAt;
      const delay =
        ageMs < HOT_REFRESH_PHASE_ONE_MS
          ? HOT_REFRESH_INTERVAL_PHASE_ONE_MS
          : ageMs < HOT_REFRESH_PHASE_TWO_MS
            ? HOT_REFRESH_INTERVAL_PHASE_TWO_MS
            : null;
      if (delay == null) continue;
      nextDelay = nextDelay == null ? delay : Math.min(nextDelay, delay);
    }
    return nextDelay;
  };

  const isAutoRebaseEnabled = (): boolean => {
    try {
      return Boolean(projectConfigService.getEffective()?.git?.autoRebaseOnHeadChange);
    } catch {
      return false;
    }
  };

  const pushRebasedLane = async (lane: LaneSummary): Promise<void> => {
    const headBranch = branchNameFromRef(lane.branchRef);
    const upstreamCheck = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: lane.worktreePath, timeoutMs: 10_000 }
    );
    if (upstreamCheck.exitCode === 0) {
      await runGitOrThrow(["push", "--force-with-lease"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
      return;
    }
    await runGitOrThrow(["push", "-u", "origin", headBranch], { cwd: lane.worktreePath, timeoutMs: 60_000 });
  };

  const restoreAutoRebaseChildLane = async (args: {
    lane: LaneSummary;
    previousParentLaneId: string | null;
    previousBaseRef: string;
    preHeadSha: string;
  }): Promise<void> => {
    await runGitOrThrow(["reset", "--hard", args.preHeadSha], { cwd: args.lane.worktreePath, timeoutMs: 90_000 });
    db.run(
      "update lanes set parent_lane_id = ?, base_ref = ? where id = ? and project_id = ?",
      [args.previousParentLaneId, args.previousBaseRef, args.lane.id, projectId]
    );
    laneService.invalidateCache?.();
  };

  const advanceChildLanesAfterLand = async (args: {
    landedLaneId: string;
    landedLaneName: string;
  }): Promise<{
    updatedLaneIds: string[];
    failedLaneIds: string[];
    blockCleanup: boolean;
  }> => {
    if (!isAutoRebaseEnabled()) {
      return { updatedLaneIds: [], failedLaneIds: [], blockCleanup: false };
    }

    const allLanes = await laneService.list({ includeArchived: true });
    const allLanesById = new Map(allLanes.map((lane) => [lane.id, lane] as const));
    const landedLane = allLanes.find((lane) => lane.id === args.landedLaneId) ?? null;
    const directChildren = await laneService.getChildren(args.landedLaneId);
    if (directChildren.length === 0) {
      return { updatedLaneIds: [], failedLaneIds: [], blockCleanup: false };
    }

    let successorParent = landedLane?.parentLaneId
      ? allLanesById.get(landedLane.parentLaneId) ?? null
      : null;
    if (!successorParent || successorParent.archivedAt) {
      successorParent = allLanes.find((lane) => lane.laneType === "primary" && !lane.archivedAt) ?? null;
    }

    type AttentionStatus = {
      laneId: string;
      parentLaneId: string | null;
      parentHeadSha: string | null;
      state: "autoRebased" | "rebasePending" | "rebaseConflict" | "rebaseFailed";
      conflictCount: number;
      message?: string | null;
    };
    const recordAttentionStatusSafely = async (status: AttentionStatus, laneId: string): Promise<boolean> => {
      try {
        await autoRebaseService?.recordAttentionStatus(status);
        return true;
      } catch (error) {
        logger.warn("prs.child_auto_rebase_attention_status_failed", {
          landedLaneId: args.landedLaneId,
          childLaneId: laneId,
          error: getErrorMessage(error),
        });
        return false;
      }
    };

    if (!successorParent) {
      for (const child of directChildren) {
        await recordAttentionStatusSafely({
          laneId: child.id,
          parentLaneId: child.parentLaneId,
          parentHeadSha: null,
          state: "rebaseFailed",
          conflictCount: 0,
          message: `Auto-rebase failed after '${args.landedLaneName}' merged because ADE could not find a new parent lane. Open the Rebase tab to recover this lane.`,
        }, child.id);
      }
      return {
        updatedLaneIds: [],
        failedLaneIds: directChildren.map((lane) => lane.id),
        blockCleanup: true,
      };
    }

    const successorBaseBranch = branchNameFromRef(successorParent.branchRef);
    const successorParentLaneId = successorParent.laneType === "primary" ? null : successorParent.id;
    const updatedLaneIds: string[] = [];
    const failedLaneIds: string[] = [];

    for (const child of directChildren) {
      const previousParentLaneId = child.parentLaneId;
      const previousBaseRef = child.baseRef;
      const childPr = getRowForLane(child.id);

      let reparentResult:
        | {
            preHeadSha: string | null;
            newParentLaneId: string;
          }
        | null = null;

      try {
        reparentResult = await laneService.reparent({
          laneId: child.id,
          newParentLaneId: successorParent.id,
        });
        const refreshedChild = {
          ...(allLanesById.get(child.id) ?? child),
          parentLaneId: successorParentLaneId,
          baseRef: successorParent.branchRef,
        };
        allLanesById.set(child.id, refreshedChild);
        await pushRebasedLane(refreshedChild);
        if (childPr && childPr.base_branch !== successorBaseBranch) {
          const retargetError = await retargetBase(childPr.id, successorBaseBranch).catch((error) => {
            logger.warn("prs.child_auto_rebase_retarget_failed", {
              landedLaneId: args.landedLaneId,
              childLaneId: child.id,
              prId: childPr.id,
              error: getErrorMessage(error),
            });
            return getErrorMessage(error);
          });
          markHotRefresh([childPr.id]);
          if (retargetError) {
            failedLaneIds.push(child.id);
            await recordAttentionStatusSafely({
              laneId: child.id,
              parentLaneId: successorParentLaneId,
              parentHeadSha: null,
              state: "rebaseFailed",
              conflictCount: 0,
              message: `Auto-rebase pushed this lane after '${args.landedLaneName}' merged, but ADE could not retarget the PR base to '${successorBaseBranch}': ${retargetError}. The merged parent lane was left in place so you can finish cleanup manually.`,
            }, child.id);
            continue;
          }
        }
        const recorded = await recordAttentionStatusSafely({
          laneId: child.id,
          parentLaneId: successorParentLaneId,
          parentHeadSha: null,
          state: "autoRebased",
          conflictCount: 0,
          message: `Rebased and pushed automatically after '${args.landedLaneName}' merged.`,
        }, child.id);
        if (!recorded) {
          failedLaneIds.push(child.id);
          continue;
        }
        updatedLaneIds.push(child.id);
      } catch (error) {
        const childError = getErrorMessage(error);
        let rollbackError: string | null = null;
        if (reparentResult?.preHeadSha) {
          try {
            await restoreAutoRebaseChildLane({
              lane: child,
              previousParentLaneId,
              previousBaseRef,
              preHeadSha: reparentResult.preHeadSha,
            });
            allLanesById.set(child.id, {
              ...(allLanesById.get(child.id) ?? child),
              parentLaneId: previousParentLaneId,
              baseRef: previousBaseRef,
            });
          } catch (restoreError) {
            rollbackError = getErrorMessage(restoreError);
            logger.warn("prs.child_auto_rebase_restore_failed", {
              landedLaneId: args.landedLaneId,
              childLaneId: child.id,
              error: rollbackError,
            });
          }
        }
        await recordAttentionStatusSafely({
          laneId: child.id,
          parentLaneId: previousParentLaneId,
          parentHeadSha: null,
          state: "rebaseFailed",
          conflictCount: 0,
          message: rollbackError
            ? `Auto-rebase failed after '${args.landedLaneName}' merged: ${childError}. Automatic rollback also failed: ${rollbackError}. Open the Rebase tab to recover this lane.`
            : `Auto-rebase failed after '${args.landedLaneName}' merged: ${childError}. The lane was restored to its pre-rebase state. Open the Rebase tab to recover this lane.`,
        }, child.id);
        failedLaneIds.push(child.id);
      }
    }

    return {
      updatedLaneIds,
      failedLaneIds,
      blockCleanup: failedLaneIds.length > 0,
    };
  };

  const upsertSnapshotRow = (args: {
    prId: string;
    detail?: PrDetail | null;
    status?: PrStatus | null;
    checks?: PrCheck[] | null;
    reviews?: PrReview[] | null;
    comments?: PrComment[] | null;
    files?: PrFile[] | null;
    updatedAt?: string;
  }): void => {
    const existing = db.get<{
      detail_json: string | null;
      status_json: string | null;
      checks_json: string | null;
      reviews_json: string | null;
      comments_json: string | null;
      files_json: string | null;
    }>(
      `select detail_json, status_json, checks_json, reviews_json, comments_json, files_json
         from pull_request_snapshots
        where pr_id = ?
        limit 1`,
      [args.prId],
    );

    // If the caller provides a value, serialize it. If undefined, keep the
    // existing DB value. If explicitly null, store null.
    const jsonOrFallback = (next: unknown, fallback: string | null | undefined): string | null => {
      if (next === undefined) return fallback ?? null;
      if (next == null) return null;
      return JSON.stringify(next);
    };

    db.run(
      `
        insert into pull_request_snapshots(
          pr_id, detail_json, status_json, checks_json, reviews_json, comments_json, files_json, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(pr_id) do update set
          detail_json = excluded.detail_json,
          status_json = excluded.status_json,
          checks_json = excluded.checks_json,
          reviews_json = excluded.reviews_json,
          comments_json = excluded.comments_json,
          files_json = excluded.files_json,
          updated_at = excluded.updated_at
      `,
      [
        args.prId,
        jsonOrFallback(args.detail, existing?.detail_json),
        jsonOrFallback(args.status, existing?.status_json),
        jsonOrFallback(args.checks, existing?.checks_json),
        jsonOrFallback(args.reviews, existing?.reviews_json),
        jsonOrFallback(args.comments, existing?.comments_json),
        jsonOrFallback(args.files, existing?.files_json),
        args.updatedAt ?? nowIso(),
      ],
    );
  };

  const decodeSnapshotJson = <T>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const listSnapshotRows = (args: { prId?: string } = {}): PullRequestSnapshotHydration[] => {
    const rows = db.all<{
      pr_id: string;
      detail_json: string | null;
      status_json: string | null;
      checks_json: string | null;
      reviews_json: string | null;
      comments_json: string | null;
      files_json: string | null;
      updated_at: string | null;
    }>(
      `
        select s.pr_id, s.detail_json, s.status_json, s.checks_json, s.reviews_json, s.comments_json, s.files_json, s.updated_at
          from pull_request_snapshots s
          join pull_requests p on p.id = s.pr_id and p.project_id = ?
         ${args.prId ? "where s.pr_id = ?" : ""}
         order by p.updated_at desc
      `,
      args.prId ? [projectId, args.prId] : [projectId],
    );

    return rows.map((row) => ({
      prId: row.pr_id,
      detail: decodeSnapshotJson<PrDetail>(row.detail_json),
      status: decodeSnapshotJson<PrStatus>(row.status_json),
      checks: decodeSnapshotJson<PrCheck[]>(row.checks_json) ?? [],
      reviews: decodeSnapshotJson<PrReview[]>(row.reviews_json) ?? [],
      comments: decodeSnapshotJson<PrComment[]>(row.comments_json) ?? [],
      files: decodeSnapshotJson<PrFile[]>(row.files_json) ?? [],
      updatedAt: row.updated_at,
    }));
  };

  const upsertRow = (summary: Omit<PrSummary, "projectId"> & { projectId?: string }): void => {
    const now = nowIso();
    const existing = getRowForLane(summary.laneId);
    if (existing) {
      db.run(
        `
          update pull_requests
             set repo_owner = ?,
                 repo_name = ?,
                 github_pr_number = ?,
                 github_url = ?,
                 github_node_id = ?,
                 title = ?,
                 state = ?,
                 base_branch = ?,
                 head_branch = ?,
                 checks_status = ?,
                 review_status = ?,
                 additions = ?,
                 deletions = ?,
                 last_synced_at = ?,
                 updated_at = ?
           where id = ? and project_id = ?
        `,
        [
          summary.repoOwner,
          summary.repoName,
          summary.githubPrNumber,
          summary.githubUrl,
          summary.githubNodeId,
          summary.title,
          summary.state,
          summary.baseBranch,
          summary.headBranch,
          summary.checksStatus,
          summary.reviewStatus,
          summary.additions,
          summary.deletions,
          summary.lastSyncedAt,
          summary.updatedAt ?? now,
          existing.id,
          projectId,
        ]
      );
      return;
    }

    db.run(
      `
        insert into pull_requests(
          id,
          project_id,
          lane_id,
          repo_owner,
          repo_name,
          github_pr_number,
          github_url,
          github_node_id,
          title,
          state,
          base_branch,
          head_branch,
          checks_status,
          review_status,
          additions,
          deletions,
          last_synced_at,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        summary.id,
        projectId,
        summary.laneId,
        summary.repoOwner,
        summary.repoName,
        summary.githubPrNumber,
        summary.githubUrl,
        summary.githubNodeId,
        summary.title,
        summary.state,
        summary.baseBranch,
        summary.headBranch,
        summary.checksStatus,
        summary.reviewStatus,
        summary.additions,
        summary.deletions,
        summary.lastSyncedAt,
        summary.createdAt ?? now,
        summary.updatedAt ?? now
      ]
    );
  };

  const assertDirtyWorktreesAllowed = (args: {
    lanes: LaneSummary[];
    laneIds: string[];
    allowDirtyWorktree?: boolean;
  }): void => {
    if (args.allowDirtyWorktree) return;
    const selectedLaneIds = new Set(args.laneIds);
    const dirtyLanes = args.lanes.filter((lane) => selectedLaneIds.has(lane.id) && Boolean(lane.status.dirty));
    if (dirtyLanes.length > 0) {
      throw formatDirtyWorktreeError(dirtyLanes);
    }
  };

  const fetchPr = async (repo: GitHubRepoRef, prNumber: number): Promise<any> => {
    const { data } = await githubService.apiRequest<any>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`
    });
    return data;
  };

  const graphqlRequest = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const { data: payload } = await githubService.apiRequest<{
      data?: T;
      errors?: Array<{ message?: unknown }>;
    }>({
      method: "POST",
      path: "/graphql",
      body: { query, variables },
    });

    const errors = Array.isArray(payload?.errors)
      ? payload.errors
          .map((entry) => asString(entry?.message).trim())
          .filter(Boolean)
      : [];
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    if (!payload || payload.data == null) {
      throw new Error("GitHub GraphQL request returned no data.");
    }
    return payload.data;
  };

  const fetchAllPages = async <T>(args: {
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    select?: (payload: any) => T[];
  }): Promise<T[]> => {
    const out: T[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await githubService.apiRequest<any>({
        method: "GET",
        path: args.path,
        query: { ...(args.query ?? {}), per_page: pageSize, page }
      });
      const batch = args.select ? args.select(data) : Array.isArray(data) ? (data as T[]) : [];
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out;
  };

  const listIntegrationProposalRows = (args: { where?: string; params?: Array<string | number | null> } = {}): IntegrationProposalRow[] =>
    db.all<IntegrationProposalRow>(
      `select * from integration_proposals where project_id = ?${args.where ? ` and ${args.where}` : ""} order by created_at desc`,
      [projectId, ...(args.params ?? [])]
    );

  const updateIntegrationProposalColumns = (
    proposalId: string,
    changes: Record<string, string | number | null | undefined>
  ): void => {
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([column]) => `${column} = ?`);
    const params = entries.map(([, value]) => value ?? null);
    params.push(proposalId);
    db.run(`update integration_proposals set ${sets.join(", ")} where id = ?`, params);
  };

  const loadIntegrationWorkflowRows = async (): Promise<IntegrationProposalRow[]> => {
    const rows = listIntegrationProposalRows();
    const reconciled: IntegrationProposalRow[] = [];

    for (const row of rows) {
      const cleanupState = parseCleanupState(row.cleanup_state);
      const workflowDisplayState = parseWorkflowDisplayState(row.workflow_display_state);
      const linkedPrId = asString(row.linked_pr_id).trim() || null;
      const linkedPrRow = linkedPrId ? getRow(linkedPrId) : null;
      const updates: Record<string, string | null> = {};

      let nextCleanupState: IntegrationCleanupState = cleanupState;
      let nextWorkflowDisplayState: IntegrationWorkflowDisplayState = workflowDisplayState;
      let nextClosedAt = row.closed_at;
      let nextMergedAt = row.merged_at;
      let nextCompletedAt = row.completed_at;

      if (cleanupState === "declined" || cleanupState === "completed") {
        nextWorkflowDisplayState = "history";
      } else if (linkedPrRow) {
        const linkedState = String(linkedPrRow.state ?? "").toLowerCase();
        const linkedUpdatedAt = asString(linkedPrRow.updated_at) || nowIso();

        if (linkedState === "merged") {
          nextCleanupState = "required";
          nextWorkflowDisplayState = "active";
          nextMergedAt = row.merged_at ?? linkedUpdatedAt;
          nextCompletedAt = row.completed_at ?? linkedUpdatedAt;
        } else if (linkedState === "closed") {
          nextCleanupState = "required";
          nextWorkflowDisplayState = "active";
          nextClosedAt = row.closed_at ?? linkedUpdatedAt;
          nextCompletedAt = row.completed_at ?? linkedUpdatedAt;
        } else if (linkedState === "open" || linkedState === "draft") {
          nextClosedAt = null;
          nextMergedAt = null;
          nextCompletedAt = null;
          if (cleanupState === "required") {
            nextCleanupState = "none";
          }
          nextWorkflowDisplayState = "active";
        }
      }

      if (nextCleanupState !== cleanupState) updates.cleanup_state = nextCleanupState;
      if (nextWorkflowDisplayState !== workflowDisplayState) updates.workflow_display_state = nextWorkflowDisplayState;
      if ((nextClosedAt ?? null) !== (row.closed_at ?? null)) updates.closed_at = nextClosedAt ?? null;
      if ((nextMergedAt ?? null) !== (row.merged_at ?? null)) updates.merged_at = nextMergedAt ?? null;
      if ((nextCompletedAt ?? null) !== (row.completed_at ?? null)) updates.completed_at = nextCompletedAt ?? null;

      if (Object.keys(updates).length > 0) {
        updateIntegrationProposalColumns(row.id, updates);
        reconciled.push({
          ...row,
          cleanup_state: updates.cleanup_state ?? row.cleanup_state,
          workflow_display_state: updates.workflow_display_state ?? row.workflow_display_state,
          closed_at: updates.closed_at ?? row.closed_at,
          merged_at: updates.merged_at ?? row.merged_at,
          completed_at: updates.completed_at ?? row.completed_at,
        });
      } else {
        reconciled.push(row);
      }
    }

    return reconciled;
  };

  const hydrateIntegrationProposalRow = async (
    row: IntegrationProposalRow,
    laneById: Map<string, LaneSummary>
  ): Promise<IntegrationProposal> => {
    const integrationLaneId = row.integration_lane_id || null;
    const parsedResolutionState = row.resolution_state_json
      ? JSON.parse(String(row.resolution_state_json)) as IntegrationResolutionState
      : null;
    const resolutionState = await hydrateIntegrationResolutionState({
      laneById,
      resolutionState: parsedResolutionState,
      integrationLaneId,
      fallbackUpdatedAt: String(row.created_at),
    });

    return {
      proposalId: String(row.id),
      sourceLaneIds: JSON.parse(String(row.source_lane_ids_json)) as string[],
      baseBranch: String(row.base_branch),
      pairwiseResults: parseJsonArrayOrEmpty<IntegrationPairwiseResult>(row.pairwise_results_json),
      laneSummaries: parseJsonArrayOrEmpty<IntegrationLaneSummary>(row.lane_summaries_json),
      steps: JSON.parse(String(row.steps_json)) as IntegrationProposalStep[],
      overallOutcome: String(row.overall_outcome) as IntegrationProposal["overallOutcome"],
      createdAt: String(row.created_at),
      title: String(row.title || ""),
      body: String(row.body || ""),
      draft: Boolean(row.draft),
      integrationLaneName: String(row.integration_lane_name || ""),
      preferredIntegrationLaneId: asString(row.preferred_integration_lane_id).trim() || null,
      mergeIntoHeadSha: asString(row.merge_into_head_sha).trim() || null,
      status: String(row.status) as IntegrationProposal["status"],
      integrationLaneId,
      linkedGroupId: asString(row.linked_group_id).trim() || null,
      linkedPrId: asString(row.linked_pr_id).trim() || null,
      workflowDisplayState: parseWorkflowDisplayState(row.workflow_display_state),
      cleanupState: parseCleanupState(row.cleanup_state),
      closedAt: asString(row.closed_at).trim() || null,
      mergedAt: asString(row.merged_at).trim() || null,
      completedAt: asString(row.completed_at).trim() || null,
      cleanupDeclinedAt: asString(row.cleanup_declined_at).trim() || null,
      cleanupCompletedAt: asString(row.cleanup_completed_at).trim() || null,
      resolutionState,
    };
  };

  const fetchReviews = async (repo: GitHubRepoRef, prNumber: number): Promise<PrReview[]> => {
    const data = await fetchAllPages<any>({
      path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`
    });

    return data.map((entry: any) => {
      const rawState = asString(entry?.state).toLowerCase();
      let state: PrReview["state"];
      if (rawState === "approved") state = "approved";
      else if (rawState === "changes_requested") state = "changes_requested";
      else if (rawState === "dismissed") state = "dismissed";
      else state = "commented";
      return {
        reviewer: asString(entry?.user?.login) || "unknown",
        reviewerAvatarUrl: asString(entry?.user?.avatar_url) || null,
        state,
        body: asString(entry?.body) || null,
        submittedAt: asString(entry?.submitted_at) || null
      };
    });
  };

  const fetchIssueComments = async (repo: GitHubRepoRef, prNumber: number): Promise<PrComment[]> => {
    const data = await fetchAllPages<any>({
      path: `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`
    });

    return data.map((entry: any) => ({
      id: `issue:${asString(entry?.node_id) || String(entry?.id ?? randomUUID())}`,
      author: asString(entry?.user?.login) || "unknown",
      authorAvatarUrl: asString(entry?.user?.avatar_url) || null,
      body: asString(entry?.body) || null,
      source: "issue",
      url: asString(entry?.html_url) || null,
      path: null,
      line: null,
      createdAt: asString(entry?.created_at) || null,
      updatedAt: asString(entry?.updated_at) || null
    }));
  };

  const fetchReviewComments = async (repo: GitHubRepoRef, prNumber: number): Promise<PrComment[]> => {
    const data = await fetchAllPages<any>({
      path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`
    });

    return data.map((entry: any) => ({
      id: `review:${asString(entry?.node_id) || String(entry?.id ?? randomUUID())}`,
      author: asString(entry?.user?.login) || "unknown",
      authorAvatarUrl: asString(entry?.user?.avatar_url) || null,
      body: asString(entry?.body) || null,
      source: "review",
      url: asString(entry?.html_url) || null,
      path: asString(entry?.path) || null,
      line: Number.isFinite(Number(entry?.line)) ? Number(entry?.line) : null,
      createdAt: asString(entry?.created_at) || null,
      updatedAt: asString(entry?.updated_at) || null
    }));
  };

  const fetchReviewThreads = async (repo: GitHubRepoRef, prNumber: number): Promise<PrReviewThread[]> => {
    const threads: PrReviewThread[] = [];
    let after: string | null = null;

    const query = `
      query AdePullRequestReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                originalLine
                startLine
                originalStartLine
                diffSide
                # TODO: comments are capped at 50 per thread with no pagination.
                # Threads with more than 50 comments will have truncated data and
                # thread-level timestamps (createdAt/updatedAt) are derived from this
                # incomplete slice. Paginating comments requires schema changes.
                comments(first: 50) {
                  nodes {
                    id
                    body
                    url
                    createdAt
                    updatedAt
                    author {
                      login
                      avatarUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    for (let page = 0; page < 10; page += 1) {
      const data: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
              nodes?: any[];
            } | null;
          } | null;
        } | null;
      } = await graphqlRequest(query, {
        owner: repo.owner,
        name: repo.name,
        number: prNumber,
        after,
      });

      const reviewThreads: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        nodes?: any[];
      } | null | undefined = data.repository?.pullRequest?.reviewThreads;
      const nodes = Array.isArray(reviewThreads?.nodes) ? reviewThreads.nodes : [];
      for (const node of nodes) {
        const comments: PrReviewThreadComment[] = Array.isArray(node?.comments?.nodes)
          ? node.comments.nodes.map((entry: any) => ({
              id: asString(entry?.id) || String(randomUUID()),
              author: asString(entry?.author?.login) || "unknown",
              authorAvatarUrl: asString(entry?.author?.avatarUrl) || null,
              body: asString(entry?.body) || null,
              url: asString(entry?.url) || null,
              createdAt: asString(entry?.createdAt) || null,
              updatedAt: asString(entry?.updatedAt) || null,
            }))
          : [];
        const latestComment = comments[comments.length - 1] ?? comments[0] ?? null;
        const diffSideRaw = asString(node?.diffSide).trim().toUpperCase();
        threads.push({
          id: asString(node?.id) || String(randomUUID()),
          isResolved: Boolean(node?.isResolved),
          isOutdated: Boolean(node?.isOutdated),
          path: asString(node?.path) || null,
          line: Number.isFinite(Number(node?.line)) ? Number(node?.line) : null,
          originalLine: Number.isFinite(Number(node?.originalLine)) ? Number(node?.originalLine) : null,
          startLine: Number.isFinite(Number(node?.startLine)) ? Number(node?.startLine) : null,
          originalStartLine: Number.isFinite(Number(node?.originalStartLine)) ? Number(node?.originalStartLine) : null,
          diffSide: diffSideRaw === "LEFT" || diffSideRaw === "RIGHT" ? diffSideRaw : null,
          url: latestComment?.url ?? null,
          createdAt: asString(node?.createdAt) || latestComment?.createdAt || null,
          updatedAt: asString(node?.updatedAt) || latestComment?.updatedAt || null,
          comments,
        });
      }

      const hasNextPage = Boolean(reviewThreads?.pageInfo?.hasNextPage);
      const endCursor: string | null = asString(reviewThreads?.pageInfo?.endCursor) || null;
      if (!hasNextPage || !endCursor) break;
      after = endCursor;
    }

    return threads.sort((a, b) => {
      const aTs = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
      const bTs = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
      return a.id.localeCompare(b.id);
    });
  };

  const fetchCombinedStatus = async (repo: GitHubRepoRef, sha: string): Promise<{
    state: string;
    statuses: Array<{ context: string; state: string; description: string | null; target_url: string | null; created_at: string | null; updated_at: string | null }>;
  }> => {
    const { data } = await githubService.apiRequest<any>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/commits/${sha}/status`
    });
    return {
      state: asString(data?.state),
      statuses: Array.isArray(data?.statuses) ? data.statuses : []
    };
  };

  const fetchCheckRuns = async (repo: GitHubRepoRef, sha: string): Promise<any[]> => {
    const { data } = await githubService.apiRequest<any>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs`,
      query: { per_page: 100 }
    });
    return Array.isArray(data?.check_runs) ? data.check_runs : [];
  };

  const fetchCompare = async (repo: GitHubRepoRef, baseSha: string, headSha: string): Promise<{ behindBy: number }> => {
    const { data } = await githubService.apiRequest<any>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/compare/${baseSha}...${headSha}`
    });
    return {
      behindBy: Number(data?.behind_by ?? 0)
    };
  };

  const refreshOne = async (prId: string): Promise<PrSummary> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    const repo = { owner: row.repo_owner, name: row.repo_name };

    const pr = await fetchPr(repo, Number(row.github_pr_number));
    const headSha = asString(pr?.head?.sha);
    const requestedReviewers = Array.isArray(pr?.requested_reviewers) ? pr.requested_reviewers.map((u: any) => asString(u?.login)).filter(Boolean) : [];

    const [combinedStatus, checkRuns, reviews] = await Promise.all([
      headSha ? fetchCombinedStatus(repo, headSha) : Promise.resolve({ state: "", statuses: [] }),
      headSha ? fetchCheckRuns(repo, headSha).catch(() => []) : Promise.resolve([]),
      fetchReviews(repo, Number(row.github_pr_number)).catch(() => [])
    ]);
    const reviewStatesByUser = new Map<string, string>();
    for (const review of reviews) {
      // Only treat these as gating states.
      if (review.state === "approved") reviewStatesByUser.set(review.reviewer, "APPROVED");
      if (review.state === "changes_requested") reviewStatesByUser.set(review.reviewer, "CHANGES_REQUESTED");
    }

    const state = toPrState({
      state: asString(pr?.state) || "open",
      draft: Boolean(pr?.draft),
      mergedAt: asString(pr?.merged_at) || null
    });

    const checksStatus = toChecksStatusFromCheckRuns(checkRuns) ?? toChecksStatus(combinedStatus.state);
    const reviewStatus = computeReviewStatus({ requestedReviewers, reviewStatesByUser });
    const additions = Number(pr?.additions ?? 0);
    const deletions = Number(pr?.deletions ?? 0);
    const baseBranch = asString(pr?.base?.ref) || row.base_branch;
    const headBranch = asString(pr?.head?.ref) || row.head_branch;

    const updated: PrSummary = {
      id: row.id,
      laneId: row.lane_id,
      projectId,
      repoOwner: repo.owner,
      repoName: repo.name,
      githubPrNumber: Number(row.github_pr_number),
      githubUrl: asString(pr?.html_url) || row.github_url,
      githubNodeId: asString(pr?.node_id) || row.github_node_id,
      title: asString(pr?.title) || row.title || "",
      state,
      baseBranch,
      headBranch,
      checksStatus,
      reviewStatus,
      additions,
      deletions,
      lastSyncedAt: nowIso(),
      createdAt: row.created_at,
      updatedAt: asString(pr?.updated_at) || row.updated_at || nowIso()
    };

    if (hasMaterialSummaryChange(row, updated)) {
      invalidateGithubSnapshotCache();
    }
    upsertRow(updated);

    return updated;
  };

  const computeStatus = async (summary: PrSummary): Promise<PrStatus> => {
    const repo: GitHubRepoRef = { owner: summary.repoOwner, name: summary.repoName };
    const pr = await fetchPr(repo, summary.githubPrNumber);
    const headSha = asString(pr?.head?.sha);
    const baseSha = asString(pr?.base?.sha);
    const mergeableState = asString(pr?.mergeable_state);
    const mergeConflicts = mergeableState.toLowerCase() === "dirty";

    const [combinedStatus, checkRuns, reviews, compare] = await Promise.all([
      headSha ? fetchCombinedStatus(repo, headSha) : Promise.resolve({ state: "", statuses: [] }),
      headSha ? fetchCheckRuns(repo, headSha).catch(() => []) : Promise.resolve([]),
      fetchReviews(repo, summary.githubPrNumber).catch(() => []),
      baseSha && headSha ? fetchCompare(repo, baseSha, headSha).catch(() => ({ behindBy: 0 })) : Promise.resolve({ behindBy: 0 })
    ]);

    const requestedReviewers = Array.isArray(pr?.requested_reviewers) ? pr.requested_reviewers.map((u: any) => asString(u?.login)).filter(Boolean) : [];
    const reviewStatesByUser = new Map<string, string>();
    for (const review of reviews) {
      if (review.state === "approved") reviewStatesByUser.set(review.reviewer, "APPROVED");
      if (review.state === "changes_requested") reviewStatesByUser.set(review.reviewer, "CHANGES_REQUESTED");
    }

    const nextState = toPrState({
      state: asString(pr?.state) || "open",
      draft: Boolean(pr?.draft),
      mergedAt: asString(pr?.merged_at) || null
    });
    const checksStatus = toChecksStatusFromCheckRuns(checkRuns) ?? toChecksStatus(combinedStatus.state);
    const reviewStatus = computeReviewStatus({ requestedReviewers, reviewStatesByUser });
    const isMergeable = Boolean(pr?.mergeable) && checksStatus !== "failing" && reviewStatus !== "changes_requested";

    const refreshed: PrSummary = {
      ...summary,
      state: nextState,
      checksStatus,
      reviewStatus,
      additions: Number(pr?.additions ?? summary.additions),
      deletions: Number(pr?.deletions ?? summary.deletions),
      lastSyncedAt: nowIso(),
      updatedAt: nowIso()
    };
    upsertRow(refreshed);

    return {
      prId: summary.id,
      state: nextState,
      checksStatus,
      reviewStatus,
      isMergeable,
      mergeConflicts,
      behindBaseBy: compare.behindBy
    };
  };

  const getChecks = async (prId: string): Promise<PrCheck[]> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };
    const pr = await fetchPr(repo, Number(row.github_pr_number));
    const headSha = asString(pr?.head?.sha);
    if (!headSha) return [];
    const [combinedStatus, checkRuns] = await Promise.all([
      fetchCombinedStatus(repo, headSha).catch(() => ({ state: "", statuses: [] })),
      fetchCheckRuns(repo, headSha).catch(() => [])
    ]);

    const out: PrCheck[] = [];
    const seen = new Set<string>();

    for (const run of checkRuns) {
      const name = asString(run?.name) || "check";
      if (seen.has(name)) continue;
      seen.add(name);
      const conclusionRaw = asString(run?.conclusion).toLowerCase();
      const conclusion: PrCheck["conclusion"] =
        conclusionRaw === "failure" || conclusionRaw === "timed_out" || conclusionRaw === "action_required"
          ? "failure"
          : toJobConclusion(run?.conclusion);
      out.push({
        name,
        status: toJobStatus(run?.status),
        conclusion,
        detailsUrl: asString(run?.details_url) || asString(run?.html_url) || null,
        startedAt: asString(run?.started_at) || null,
        completedAt: asString(run?.completed_at) || null
      });
    }

    for (const s of combinedStatus.statuses) {
      const name = asString(s.context) || "status";
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        status: s.state === "pending" ? "in_progress" : "completed",
        conclusion: s.state === "success" ? "success" : s.state === "failure" || s.state === "error" ? "failure" : null,
        detailsUrl: s.target_url ?? null,
        startedAt: s.created_at ?? null,
        completedAt: s.updated_at ?? null
      });
    }

    return out;
  };

  const getReviews = async (prId: string): Promise<PrReview[]> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };
    return await fetchReviews(repo, Number(row.github_pr_number));
  };

  const getComments = async (prId: string): Promise<PrComment[]> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };
    const prNumber = Number(row.github_pr_number);

    const [issueComments, reviewComments] = await Promise.all([
      fetchIssueComments(repo, prNumber).catch(() => []),
      fetchReviewComments(repo, prNumber).catch(() => [])
    ]);

    return [...issueComments, ...reviewComments].sort((a, b) => {
      const aTs = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
      const bTs = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
      return a.id.localeCompare(b.id);
    });
  };

  const getDetailSnapshot = async (prId: string): Promise<PrDetail> => {
    const row = requireRow(prId);
    const repo = repoFromRow(row);
    const { data } = await githubService.apiRequest<any>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`
    });
    return {
      prId,
      body: asString(data?.body) || null,
      labels: Array.isArray(data?.labels) ? data.labels.map(toLabel) : [],
      assignees: Array.isArray(data?.assignees) ? data.assignees.map(toUser) : [],
      requestedReviewers: Array.isArray(data?.requested_reviewers) ? data.requested_reviewers.map(toUser) : [],
      author: toUser(data?.user),
      isDraft: Boolean(data?.draft),
      milestone: asString(data?.milestone?.title) || null,
      linkedIssues: []
    };
  };

  const getFilesSnapshot = async (prId: string): Promise<PrFile[]> => {
    const row = requireRow(prId);
    const repo = repoFromRow(row);
    const data = await fetchAllPages<any>({
      path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}/files`
    });
    return data.map((f: any) => ({
      filename: asString(f?.filename) || "",
      status: toFileStatus(f?.status),
      additions: Number(f?.additions) || 0,
      deletions: Number(f?.deletions) || 0,
      patch: asString(f?.patch) || null,
      previousFilename: asString(f?.previous_filename) || null
    }));
  };

  const refreshSnapshotData = async (prId: string): Promise<void> => {
    const [detail, status, checks, reviews, comments, files] = await Promise.all([
      getDetailSnapshot(prId).catch(() => null),
      computeStatus(rowToSummary(requireRow(prId))).catch(() => null),
      getChecks(prId).catch(() => null),
      getReviews(prId).catch(() => null),
      getComments(prId).catch(() => null),
      getFilesSnapshot(prId).catch(() => null),
    ]);
    upsertSnapshotRow({ prId, detail, status, checks, reviews, comments, files });
  };

  const updateDescription = async (args: UpdatePrDescriptionArgs): Promise<void> => {
    const row = getRow(args.prId);
    if (!row) throw new Error(`PR not found: ${args.prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };
    await githubService.apiRequest({
      method: "PATCH",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
      body: { body: args.body }
    });
    await refreshOne(args.prId);
  };

  const deletePr = async (args: DeletePrArgs): Promise<DeletePrResult> => {
    const row = getRow(args.prId);
    if (!row) throw new Error(`PR not found: ${args.prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };

    let githubClosed = false;
    let githubCloseError: string | null = null;
    if (args.closeOnGitHub) {
      try {
        await githubService.apiRequest({
          method: "PATCH",
          path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
          body: { state: "closed" }
        });
        githubClosed = true;
      } catch (error) {
        githubCloseError = error instanceof Error ? error.message : String(error);
        logger.warn("prs.close_failed", {
          prId: row.id,
          prNumber: Number(row.github_pr_number),
          error: githubCloseError
        });
      }
    }

    db.run("delete from pr_group_members where pr_id = ?", [row.id]);
    db.run(
      `
        delete from pr_groups
        where project_id = ?
          and id in (
            select g.id
            from pr_groups g
            left join pr_group_members m on m.group_id = g.id
            where g.project_id = ?
            group by g.id
            having count(m.id) = 0
          )
      `,
      [projectId, projectId]
    );
    // Explicitly delete child rows that rely on FK cascade — CRR conversion can
    // strip checked foreign keys, leaving orphaned rows if we only rely on CASCADE.
    db.run("delete from pr_convergence_state where pr_id = ?", [row.id]);
    db.run("delete from pr_pipeline_settings where pr_id = ?", [row.id]);
    db.run("delete from pr_issue_inventory where pr_id = ?", [row.id]);
    db.run("delete from pull_requests where id = ? and project_id = ?", [row.id, projectId]);

    let laneArchived = false;
    let laneArchiveError: string | null = null;
    if (args.archiveLane) {
      try {
        await laneService.archive({ laneId: row.lane_id });
        laneArchived = true;
      } catch (error) {
        laneArchiveError = error instanceof Error ? error.message : String(error);
        logger.warn("prs.archive_lane_failed", { prId: row.id, laneId: row.lane_id, error: laneArchiveError });
      }
    }

    return {
      prId: row.id,
      laneId: row.lane_id,
      removedLocal: true,
      githubClosed,
      githubCloseError,
      laneArchived,
      laneArchiveError
    };
  };

  const draftDescription = async (args: DraftPrDescriptionArgs): Promise<{ title: string; body: string }> => {
    const { laneId, model, reasoningEffort } = args;
    const lane = (await laneService.list({ includeArchived: true })).find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);

    const template = readPrTemplate(projectRoot);
    const packBody = await (async () => {
      // W6: pack-based context removed. Provide a bounded git-native lane change summary instead.
      const diff = await runGit(
        ["diff", "--name-status", `${lane.baseRef}...HEAD`],
        { cwd: lane.worktreePath, timeoutMs: 15_000 }
      );
      if (diff.exitCode === 0) {
        return diff.stdout.trim() || "(no changed files)";
      }
      const status = await runGit(["status", "--short"], { cwd: lane.worktreePath, timeoutMs: 15_000 });
      return status.exitCode === 0 ? status.stdout.trim() || "(no changed files)" : "(unable to compute lane change summary)";
    })();

    const commits = await runGit(
      ["log", "-n20", "--date=iso-strict", "--pretty=format:%h %aI %an %s"],
      { cwd: lane.worktreePath, timeoutMs: 15_000 }
    ).then((res) => (res.exitCode === 0 ? res.stdout.trim().split("\n").filter(Boolean) : []));

    const context = {
      laneId,
      laneName: lane.name,
      branchRef: lane.branchRef,
      baseRef: lane.baseRef,
      parentLaneId: lane.parentLaneId,
      commits,
      packBody,
      prTemplate: template
    };

    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const defaultTitle = lane.name.replace(/[-_/]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || lane.name;

    if (providerMode !== "guest" && aiIntegrationService) {
      const prompt = [
        "You are ADE's PR drafting assistant. Keep content factual and concise.",
        "Return JSON only with shape: {\"title\": string, \"body\": string}.",
        "The body must be GitHub-flavored markdown with sections: Summary, What Changed, Validation, Risks.",
        "",
        "PR Context JSON:",
        JSON.stringify(context, null, 2)
      ].join("\n");

      try {
        const draft = await aiIntegrationService.draftPrDescription({
          laneId,
          cwd: lane.worktreePath,
          prompt,
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {})
        });
        const parsed = parsePrDraftJson(draft.text);
        if (parsed) return parsed;

        if (draft.text.trim().length) {
          return {
            title: defaultTitle,
            body: `${draft.text.trim()}\n`
          };
        }
      } catch (error) {
        logger.warn("prs.draft.ai_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Guest/CLI fallback: deterministic content.
    const lines: string[] = [];
    lines.push("## Summary");
    lines.push("");
    lines.push("_Describe the change._");
    lines.push("");
    lines.push("## What Changed");
    lines.push("");
    lines.push("_Key files and behaviors._");
    lines.push("");
    lines.push("## Validation");
    lines.push("");
    lines.push("_How you tested._");
    lines.push("");
    lines.push("## Risks");
    lines.push("");
    lines.push("_Anything to watch._");
    if (template) {
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(template);
    }
    return {
      title: defaultTitle || lane.name,
      body: `${lines.join("\n")}\n`
    };
  };

  const createFromLane = async (args: CreatePrFromLaneArgs): Promise<PrSummary> => {
    const allLanes = await laneService.list({ includeArchived: true });
    const lane = allLanes.find((entry) => entry.id === args.laneId);
    if (!lane) throw new Error(`Lane not found: ${args.laneId}`);
    assertDirtyWorktreesAllowed({
      lanes: allLanes,
      laneIds: [lane.id],
      allowDirtyWorktree: args.allowDirtyWorktree
    });

    const repo = await githubService.getRepoOrThrow();
    const headBranch = branchNameFromRef(lane.branchRef);
    const parentLane = lane.parentLaneId ? allLanes.find((entry) => entry.id === lane.parentLaneId) ?? null : null;
    const primaryLane = allLanes.find((entry) => entry.laneType === "primary") ?? null;
    const defaultBaseBranch = resolveStableLaneBaseBranch({
      lane,
      parent: parentLane,
      primaryBranchRef: primaryLane?.branchRef ?? null,
    });
    const baseBranch = (args.baseBranch ?? defaultBaseBranch).trim();

    // Push the branch to remote before creating the PR
    const upstreamCheck = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: lane.worktreePath, timeoutMs: 10_000 }
    );
    if (upstreamCheck.exitCode === 0) {
      const pushResult = await runGit(["push"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
      if (pushResult.exitCode !== 0) {
        const stderr = pushResult.stderr ?? "";
        if (stderr.includes("non-fast-forward") || stderr.includes("rejected")) {
          // Branch was rebased locally — force-push safely
          logger.info("prs.push_force_lease", { headBranch, reason: "non-fast-forward after rebase" });
          await runGitOrThrow(["push", "--force-with-lease"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        } else {
          throw new Error(`Push failed: ${stderr}`);
        }
      }
    } else {
      await runGitOrThrow(["push", "-u", "origin", headBranch], { cwd: lane.worktreePath, timeoutMs: 60_000 });
    }

    const createdAt = nowIso();
    let created: { data: any; response: Response | null };
    try {
      created = await githubService.apiRequest<any>({
        method: "POST",
        path: `/repos/${repo.owner}/${repo.name}/pulls`,
        body: {
          title: args.title,
          head: headBranch,
          base: baseBranch,
          body: args.body,
          draft: Boolean(args.draft)
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to create pull request for "${headBranch}" → "${baseBranch}": ${msg}`
      );
    }

    const pr = created.data;
    const prNumber = Number(pr?.number);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      throw new Error("GitHub returned an invalid PR number.");
    }

    if (args.labels?.length) {
      await githubService.apiRequest({
        method: "POST",
        path: `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/labels`,
        body: { labels: args.labels }
      }).catch((error) => {
        logger.warn("prs.labels_failed", { prNumber, error: error instanceof Error ? error.message : String(error) });
      });
    }

    if (args.reviewers?.length) {
      await githubService.apiRequest({
        method: "POST",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/requested_reviewers`,
        body: { reviewers: args.reviewers }
      }).catch((error) => {
        logger.warn("prs.reviewers_failed", { prNumber, error: error instanceof Error ? error.message : String(error) });
      });
    }

    const summary: PrSummary = {
      id: randomUUID(),
      laneId: lane.id,
      projectId,
      repoOwner: repo.owner,
      repoName: repo.name,
      githubPrNumber: prNumber,
      githubUrl: asString(pr?.html_url),
      githubNodeId: asString(pr?.node_id) || null,
      title: asString(pr?.title),
      state: toPrState({ state: asString(pr?.state) || "open", draft: Boolean(pr?.draft), mergedAt: asString(pr?.merged_at) || null }),
      baseBranch,
      headBranch,
      checksStatus: "none",
      reviewStatus: "none",
      additions: Number(pr?.additions ?? 0),
      deletions: Number(pr?.deletions ?? 0),
      lastSyncedAt: null,
      createdAt,
      updatedAt: createdAt
    };

    upsertRow(summary);

    return await refreshOne(summary.id);
  };

  const linkToLane = async (args: LinkPrToLaneArgs): Promise<PrSummary> => {
    const lane = (await laneService.list({ includeArchived: true })).find((entry) => entry.id === args.laneId);
    if (!lane) throw new Error(`Lane not found: ${args.laneId}`);

    const locator = parsePrLocator(args.prUrlOrNumber);
    const repo = locator.owner && locator.repo ? { owner: locator.owner, name: locator.repo } : await githubService.getRepoOrThrow();
    if (!locator.number) throw new Error("PR number missing.");

    const pr = await fetchPr(repo, locator.number);
    const createdAt = nowIso();
    const headBranch = asString(pr?.head?.ref) || branchNameFromRef(lane.branchRef);
    const baseBranch = asString(pr?.base?.ref) || branchNameFromRef(lane.baseRef);

    const summary: PrSummary = {
      id: randomUUID(),
      laneId: lane.id,
      projectId,
      repoOwner: repo.owner,
      repoName: repo.name,
      githubPrNumber: locator.number,
      githubUrl: asString(pr?.html_url) || "",
      githubNodeId: asString(pr?.node_id) || null,
      title: asString(pr?.title) || "",
      state: toPrState({ state: asString(pr?.state) || "open", draft: Boolean(pr?.draft), mergedAt: asString(pr?.merged_at) || null }),
      baseBranch,
      headBranch,
      checksStatus: "none",
      reviewStatus: "none",
      additions: Number(pr?.additions ?? 0),
      deletions: Number(pr?.deletions ?? 0),
      lastSyncedAt: null,
      createdAt,
      updatedAt: createdAt
    };

    upsertRow(summary);
    return await refreshOne(summary.id);
  };

  const land = async (args: LandPrArgs): Promise<LandResult> => {
    const row = getRow(args.prId);
    if (!row) throw new Error(`PR not found: ${args.prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };

    const op = operationService.start({
      laneId: row.lane_id,
      kind: "pr_land",
      metadata: {
        prId: row.id,
        prNumber: Number(row.github_pr_number),
        method: args.method
      }
    });

    try {
      const merge = await githubService.apiRequest<any>({
        method: "PUT",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}/merge`,
        body: {
          merge_method: args.method
        }
      });

      const mergeCommitSha = asString(merge.data?.sha) || null;

      // --- Post-merge cleanup: failures here must not mask a successful merge ---
      const headBranch = row.head_branch;
      let branchDeleted = false;
      let laneArchived = false;
      let childAutoRebaseBlockedCleanup = false;

      try {
        // Remove PR from any group membership before archiving (lane archive blocks if still in a group)
        try {
          db.run("delete from pr_group_members where pr_id = ?", [row.id]);
        } catch (groupErr) {
          logger.warn("prs.group_membership_cleanup_failed", { prId: row.id, error: getErrorMessage(groupErr) });
        }

        await fetchRemoteTrackingBranch({
          projectRoot,
          targetBranch: row.base_branch,
        }).catch((error) => {
          logger.warn("prs.fetch_base_branch_failed", {
            prId: row.id,
            baseBranch: row.base_branch,
            error: getErrorMessage(error),
          });
        });
        try {
          laneService.invalidateCache?.();
        } catch (cacheError) {
          logger.warn("prs.lane_cache_invalidation_failed", {
            prId: row.id,
            error: getErrorMessage(cacheError),
          });
        }

        const childAdvanceResult = await advanceChildLanesAfterLand({
          landedLaneId: row.lane_id,
          landedLaneName: row.title?.trim() || row.head_branch,
        }).catch((error) => {
          logger.warn("prs.child_auto_rebase_failed", {
            prId: row.id,
            laneId: row.lane_id,
            error: getErrorMessage(error),
          });
          return {
            updatedLaneIds: [],
            failedLaneIds: [],
            blockCleanup: true,
          };
        });
        childAutoRebaseBlockedCleanup = childAdvanceResult.blockCleanup;

        if (!childAutoRebaseBlockedCleanup) {
          try {
            await githubService.apiRequest({
              method: "DELETE",
              path: `/repos/${repo.owner}/${repo.name}/git/refs/heads/${headBranch}`
            });
            branchDeleted = true;
          } catch (error) {
            logger.warn("prs.delete_branch_failed", { prId: row.id, headBranch, error: getErrorMessage(error) });
          }

          if (args.archiveLane) {
            try {
              await laneService.archive({ laneId: row.lane_id });
              laneArchived = true;
            } catch (archiveErr) {
              logger.warn("prs.lane_archive_failed", { prId: row.id, laneId: row.lane_id, error: getErrorMessage(archiveErr) });
            }
          }
        } else {
          logger.warn("prs.post_merge_cleanup_blocked", {
            prId: row.id,
            laneId: row.lane_id,
            failedLaneIds: childAdvanceResult.failedLaneIds,
          });
        }

        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          metadataPatch: {
            mergeCommitSha,
            branchDeleted,
            laneArchived,
            childAutoRebaseBlockedCleanup,
            autoRebasedChildLaneIds: childAdvanceResult.updatedLaneIds,
            failedAutoRebaseChildLaneIds: childAdvanceResult.failedLaneIds,
          }
        });

        markHotRefresh([row.id]);
        await refreshOne(row.id).catch(() => {});
        await conflictService?.scanRebaseNeeds().catch((error) => {
          logger.warn("prs.refresh_rebase_needs_failed", {
            prId: row.id,
            error: getErrorMessage(error),
          });
        });
        await rebaseSuggestionService?.refresh().catch((error) => {
          logger.warn("prs.refresh_rebase_suggestions_failed", {
            prId: row.id,
            error: getErrorMessage(error),
          });
        });
        await autoRebaseService?.refreshActiveRebaseNeeds("merge_completed").catch((error) => {
          logger.warn("prs.refresh_auto_rebase_failed", {
            prId: row.id,
            error: getErrorMessage(error),
          });
        });
      } catch (cleanupError) {
        // The merge itself succeeded -- cleanup failure must not mask that.
        const cleanupMsg = getErrorMessage(cleanupError);
        logger.error("prs.post_merge_cleanup_failed", {
          prId: row.id,
          mergeCommitSha,
          error: cleanupMsg,
        });
        // Best-effort: mark the operation as succeeded even if cleanup threw
        try {
          operationService.finish({
            operationId: op.operationId,
            status: "succeeded",
            metadataPatch: {
              mergeCommitSha,
              branchDeleted,
              laneArchived,
              childAutoRebaseBlockedCleanup,
              cleanupError: cleanupMsg,
            }
          });
        } catch { /* already finished or double-finish -- ignore */ }
      }

      return {
        prId: row.id,
        prNumber: Number(row.github_pr_number),
        success: true,
        mergeCommitSha,
        branchDeleted,
        laneArchived,
        error: null
      };
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      // Provide actionable guidance for common GitHub API errors
      let userMsg = rawMsg;
      if (rawMsg.includes("Resource not accessible by personal access token")) {
        userMsg = "GitHub token lacks permission to merge PRs. For fine-grained PATs, enable 'Contents: write' and 'Pull requests: write'. For classic PATs, enable the 'repo' scope.";
      } else if (rawMsg.includes("405") || rawMsg.includes("Method Not Allowed")) {
        userMsg = "PR cannot be merged — branch protection rules may require status checks or reviews to pass first.";
      } else if (rawMsg.includes("409") || rawMsg.includes("Conflict")) {
        userMsg = "PR has merge conflicts. Rebase or resolve conflicts before merging.";
      }
      operationService.finish({
        operationId: op.operationId,
        status: "failed",
        metadataPatch: { error: rawMsg }
      });
      return {
        prId: row.id,
        prNumber: Number(row.github_pr_number),
        success: false,
        mergeCommitSha: null,
        branchDeleted: false,
        laneArchived: false,
        error: userMsg
      };
    }
  };

  const retargetBase = async (prId: string, baseBranch: string): Promise<void> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    const repo: GitHubRepoRef = { owner: row.repo_owner, name: row.repo_name };
    await githubService.apiRequest({
      method: "PATCH",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
      body: { base: baseBranch }
    });
    await refreshOne(prId);
  };

  const landStack = async (args: LandStackArgs): Promise<LandResult[]> => {
    const chain = await laneService.getStackChain(args.rootLaneId);
    if (!chain.length) return [];

    // Root base branch is derived from the root lane PR.
    const rootRow = getRowForLane(chain[0]!.laneId);
    if (!rootRow) throw new Error("Root lane has no PR linked.");
    const baseTarget = rootRow.base_branch;

    const results: LandResult[] = [];
    for (const item of chain) {
      const row = getRowForLane(item.laneId);
      if (!row) {
        results.push({
          prId: "",
          prNumber: 0,
          success: false,
          mergeCommitSha: null,
          branchDeleted: false,
          laneArchived: false,
          error: `Lane '${item.laneName}' has no PR linked.`
        });
        break;
      }

      if (row.base_branch !== baseTarget) {
        await retargetBase(row.id, baseTarget).catch((error) => {
          logger.warn("prs.retarget_failed", { prId: row.id, error: error instanceof Error ? error.message : String(error) });
        });
      }

      const landed = await land({ prId: row.id, method: args.method });
      results.push(landed);
      if (!landed.success) break;
    }

    return results;
  };

  const createQueuePrs = async (args: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> => {
    const groupId = randomUUID();
    const now = nowIso();
    const prs: PrSummary[] = [];
    const errors: Array<{ laneId: string; error: string }> = [];

    const lanes = await laneService.list({ includeArchived: false });
    assertDirtyWorktreesAllowed({
      lanes,
      laneIds: args.laneIds,
      allowDirtyWorktree: args.allowDirtyWorktree
    });
    const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));

    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at) values (?, ?, 'queue', ?, ?, ?, ?, ?)`,
      [groupId, projectId, args.queueName ?? null, args.autoRebase ? 1 : 0, args.ciGating ? 1 : 0, args.targetBranch, now]
    );

    // Queue PRs all target the same branch (no chaining)
    for (let i = 0; i < args.laneIds.length; i++) {
      const laneId = args.laneIds[i]!;
      const lane = laneMap.get(laneId);
      if (!lane) {
        errors.push({ laneId, error: `Lane not found: ${laneId}` });
        continue;
      }

      const title = args.titles?.[laneId] ?? lane.name;
      try {
        const pr = await createFromLane({
          laneId,
          title,
          body: "",
          draft: Boolean(args.draft),
          baseBranch: args.targetBranch,
          allowDirtyWorktree: true
        });
        prs.push(pr);

        const memberId = randomUUID();
        db.run(
          `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
          [memberId, groupId, pr.id, laneId, i]
        );
      } catch (error) {
        errors.push({ laneId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    return { groupId, prs, errors };
  };

  const createIntegrationPr = async (args: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> => {
    if (!args.sourceLaneIds.length) throw new Error("At least one source lane is required");
    const integrationLaneName = args.integrationLaneName.trim();
    if (!integrationLaneName) throw new Error("Integration lane name is required");

    const lanes = await laneService.list({ includeArchived: false });
    const preflight = buildIntegrationPreflight(lanes, args.sourceLaneIds, args.baseBranch);
    if (!preflight.uniqueSourceLaneIds.length) throw new Error("At least one valid source lane is required");
    if (preflight.duplicateSourceLaneIds.length > 0) {
      throw new Error(`Duplicate source lanes selected: ${preflight.duplicateSourceLaneIds.join(", ")}`);
    }
    if (preflight.missingSourceLaneIds.length > 0) {
      throw new Error(`Source lanes not found: ${preflight.missingSourceLaneIds.join(", ")}`);
    }
    if (!preflight.baseLane) {
      throw new Error(`Could not map base branch "${args.baseBranch}" to an active lane. Create or attach that lane first.`);
    }
    const existingIntegrationLaneId = asString(args.existingIntegrationLaneId).trim();
    const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
    if (existingIntegrationLaneId) {
      if (preflight.uniqueSourceLaneIds.includes(existingIntegrationLaneId)) {
        throw new Error("Integration lane cannot be one of the source lanes.");
      }
      const adoptLane = laneMap.get(existingIntegrationLaneId);
      if (!adoptLane) {
        throw new Error(`Integration lane not found: ${existingIntegrationLaneId}`);
      }
    }
    assertDirtyWorktreesAllowed({
      lanes,
      laneIds: existingIntegrationLaneId
        ? [...preflight.uniqueSourceLaneIds, existingIntegrationLaneId]
        : preflight.uniqueSourceLaneIds,
      allowDirtyWorktree: args.allowDirtyWorktree
    });

    const sourceLaneNames = preflight.uniqueSourceLaneIds.map((laneId) => laneMap.get(laneId)?.name ?? laneId);
    const groupId = randomUUID();
    const now = nowIso();

    // Track resources created during this operation for cleanup on failure.
    let groupInserted = false;
    let integrationLane: LaneSummary | null = null;
    let createdNewIntegrationLane = false;

    try {
      db.run(
        `insert into pr_groups(id, project_id, group_type, created_at) values (?, ?, 'integration', ?)`,
        [groupId, projectId, now]
      );
      groupInserted = true;

      if (existingIntegrationLaneId) {
        integrationLane = laneMap.get(existingIntegrationLaneId) ?? null;
        if (!integrationLane) throw new Error(`Integration lane not found: ${existingIntegrationLaneId}`);
      } else {
        integrationLane = await laneService.createChild({
          parentLaneId: preflight.baseLane.id,
          name: integrationLaneName,
          description: `Integration lane for merging: ${sourceLaneNames.join(", ")}`
        });
        createdNewIntegrationLane = true;
      }

      const mergeResults: Array<{ laneId: string; success: boolean; error?: string }> = [];

      for (const sourceLaneId of preflight.uniqueSourceLaneIds) {
        const sourceLane = laneMap.get(sourceLaneId);
        if (!sourceLane) {
          mergeResults.push({ laneId: sourceLaneId, success: false, error: `Lane not found: ${sourceLaneId}` });
          continue;
        }
        const sourceBranch = branchNameFromRef(sourceLane.branchRef);
        const mergeRes = await runGit(
          ["merge", "--no-ff", "-m", `Merge ${sourceLane.name} into integration`, sourceBranch],
          { cwd: integrationLane.worktreePath, timeoutMs: 60_000 }
        );
        if (mergeRes.exitCode !== 0) {
          // Abort the failed merge so subsequent merges can proceed
          await runGit(["merge", "--abort"], { cwd: integrationLane.worktreePath, timeoutMs: 10_000 });
          mergeResults.push({ laneId: sourceLaneId, success: false, error: mergeRes.stderr.trim() || "Merge failed" });
        } else {
          mergeResults.push({ laneId: sourceLaneId, success: true });
        }
      }

      const failedMerges = mergeResults.filter((result) => !result.success);
      if (failedMerges.length > 0) {
        const failedLaneNames = failedMerges
          .map((result) => laneMap.get(result.laneId)?.name ?? result.laneId)
          .join(", ");
        throw new Error(
          `Integration merge blocked. Resolve conflicts for: ${failedLaneNames}. ` +
            `No GitHub PR was created yet; fix merges in lane '${integrationLane.name}' and try again.`
        );
      }

      const pr = await createFromLane({
        laneId: integrationLane.id,
        title: args.title,
        body: args.body ?? "",
        draft: Boolean(args.draft),
        baseBranch: args.baseBranch,
        allowDirtyWorktree: true
      });

      const integrationMemberId = randomUUID();
      db.run(
        `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, 0, 'integration')`,
        [integrationMemberId, groupId, pr.id, integrationLane.id]
      );

      for (let i = 0; i < preflight.uniqueSourceLaneIds.length; i++) {
        const memberId = randomUUID();
        db.run(
          `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
          [memberId, groupId, pr.id, preflight.uniqueSourceLaneIds[i]!, i + 1]
        );
      }

      return {
        groupId,
        integrationLaneId: integrationLane.id,
        pr,
        mergeResults
      };
    } catch (error) {
      // Clean up orphaned resources created during this operation.
      // Remove group members and the group row if we inserted it.
      if (groupInserted) {
        try {
          db.run("delete from pr_group_members where group_id = ?", [groupId]);
          db.run("delete from pr_groups where id = ? and project_id = ?", [groupId, projectId]);
        } catch (cleanupError) {
          logger.warn("prs.integration_cleanup_group_failed", {
            groupId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
      // Archive the integration lane only if we created it (best-effort).
      if (integrationLane && createdNewIntegrationLane) {
        try {
          await laneService.archive({ laneId: integrationLane.id });
        } catch (cleanupError) {
          logger.warn("prs.integration_cleanup_lane_failed", {
            laneId: integrationLane.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
      throw error;
    }
  };

  const createIntegrationLane = async (args: {
    sourceLaneIds: string[];
    integrationLaneName: string;
    baseBranch: string;
    description?: string;
    allowDirtyWorktree?: boolean;
    missionId?: string | null;
    laneRole?: "mission_root" | "worker" | "integration" | "result" | null;
  }): Promise<{
    integrationLane: LaneSummary;
    mergeResults: Array<{ laneId: string; success: boolean; error?: string }>;
  }> => {
    if (!args.sourceLaneIds.length) throw new Error("At least one source lane is required");
    const integrationLaneName = args.integrationLaneName.trim();
    if (!integrationLaneName) throw new Error("Integration lane name is required");

    const lanes = await laneService.list({ includeArchived: false });
    const preflight = buildIntegrationPreflight(lanes, args.sourceLaneIds, args.baseBranch);
    if (!preflight.uniqueSourceLaneIds.length) throw new Error("At least one valid source lane is required");
    if (preflight.duplicateSourceLaneIds.length > 0) {
      throw new Error(`Duplicate source lanes selected: ${preflight.duplicateSourceLaneIds.join(", ")}`);
    }
    if (preflight.missingSourceLaneIds.length > 0) {
      throw new Error(`Source lanes not found: ${preflight.missingSourceLaneIds.join(", ")}`);
    }
    if (!preflight.baseLane) {
      throw new Error(`Could not map base branch "${args.baseBranch}" to an active lane. Create or attach that lane first.`);
    }
    assertDirtyWorktreesAllowed({
      lanes,
      laneIds: preflight.uniqueSourceLaneIds,
      allowDirtyWorktree: args.allowDirtyWorktree
    });

    const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
    const sourceLaneNames = preflight.uniqueSourceLaneIds.map((laneId) => laneMap.get(laneId)?.name ?? laneId);
    let integrationLane: LaneSummary | null = null;
    try {
      integrationLane = await laneService.createChild({
        parentLaneId: preflight.baseLane.id,
        name: integrationLaneName,
        description: args.description?.trim() || `Integration lane for merging: ${sourceLaneNames.join(", ")}`,
        missionId: args.missionId ?? null,
        laneRole: args.laneRole ?? "integration",
      });

      const mergeResults: Array<{ laneId: string; success: boolean; error?: string }> = [];
      for (const sourceLaneId of preflight.uniqueSourceLaneIds) {
        const sourceLane = laneMap.get(sourceLaneId);
        if (!sourceLane) {
          mergeResults.push({ laneId: sourceLaneId, success: false, error: `Lane not found: ${sourceLaneId}` });
          continue;
        }
        const sourceBranch = branchNameFromRef(sourceLane.branchRef);
        const mergeRes = await runGit(
          ["merge", "--no-ff", "-m", `Merge ${sourceLane.name} into integration`, sourceBranch],
          { cwd: integrationLane.worktreePath, timeoutMs: 60_000 }
        );
        if (mergeRes.exitCode !== 0) {
          await runGit(["merge", "--abort"], { cwd: integrationLane.worktreePath, timeoutMs: 10_000 });
          mergeResults.push({ laneId: sourceLaneId, success: false, error: mergeRes.stderr.trim() || "Merge failed" });
        } else {
          mergeResults.push({ laneId: sourceLaneId, success: true });
        }
      }

      return {
        integrationLane,
        mergeResults,
      };
    } catch (error) {
      if (integrationLane) {
        try {
          await laneService.archive({ laneId: integrationLane.id });
        } catch (cleanupError) {
          logger.warn("prs.integration_lane_cleanup_failed", {
            laneId: integrationLane.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
      throw error;
    }
  };

  const landStackEnhanced = async (args: LandStackEnhancedArgs): Promise<LandResult[]> => {
    if (args.mode === "sequential") {
      return await landStack({ rootLaneId: args.rootLaneId, method: args.method });
    }

    // all-at-once: land all PRs without waiting for retargeting.
    const chain = await laneService.getStackChain(args.rootLaneId);
    if (!chain.length) return [];

    const rootRow = getRowForLane(chain[0]!.laneId);
    if (!rootRow) throw new Error("Root lane has no PR linked.");
    const baseTarget = rootRow.base_branch;

    // Use an indexed array so results stay in chain order regardless of
    // whether individual items resolve synchronously (missing PR) or
    // asynchronously (actual land call).
    const results: LandResult[] = new Array(chain.length);
    const landEntries: Array<{ index: number; promise: Promise<LandResult> }> = [];

    for (let i = 0; i < chain.length; i++) {
      const item = chain[i]!;
      const row = getRowForLane(item.laneId);
      if (!row) {
        results[i] = {
          prId: "",
          prNumber: 0,
          success: false,
          mergeCommitSha: null,
          branchDeleted: false,
          laneArchived: false,
          error: `Lane '${item.laneName}' has no PR linked.`
        };
        continue;
      }

      if (row.base_branch !== baseTarget) {
        await retargetBase(row.id, baseTarget).catch((error) => {
          logger.warn("prs.retarget_failed", { prId: row.id, error: error instanceof Error ? error.message : String(error) });
        });
      }

      landEntries.push({ index: i, promise: land({ prId: row.id, method: args.method }) });
    }

    const settled = await Promise.allSettled(landEntries.map((entry) => entry.promise));
    for (let j = 0; j < settled.length; j++) {
      const result = settled[j]!;
      const idx = landEntries[j]!.index;
      if (result.status === "fulfilled") {
        results[idx] = result.value;
      } else {
        results[idx] = {
          prId: "",
          prNumber: 0,
          success: false,
          mergeCommitSha: null,
          branchDeleted: false,
          laneArchived: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        };
      }
    }

    return results;
  };

  const getConflictAnalysis = async (prId: string): Promise<PrConflictAnalysis> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);
    const laneId = row.lane_id;

    if (!conflictService) {
      return {
        prId,
        laneId,
        riskLevel: "none",
        overlapCount: 0,
        conflictPredicted: false,
        peerConflicts: [],
        analyzedAt: nowIso()
      };
    }

    const status = await conflictService.getLaneStatus({ laneId });
    const overlaps = await conflictService.listOverlaps({ laneId });

    const peerConflicts: PrConflictAnalysis["peerConflicts"] = overlaps
      .filter((o): o is typeof o & { peerId: string } => o.peerId != null)
      .map((o) => ({
        peerId: o.peerId,
        peerName: o.peerName,
        riskLevel: o.riskLevel,
        overlapFiles: o.files.map((f) => f.path)
      }));

    const riskLevels = ["none", "low", "medium", "high"] as const;
    const highestRisk = peerConflicts.reduce<PrConflictAnalysis["riskLevel"]>(
      (max, pc) => {
        return riskLevels.indexOf(pc.riskLevel) > riskLevels.indexOf(max) ? pc.riskLevel : max;
      },
      status.status === "conflict-predicted" || status.status === "conflict-active" ? "high" : "none"
    );

    return {
      prId,
      laneId,
      riskLevel: highestRisk as PrConflictAnalysis["riskLevel"],
      overlapCount: status.overlappingFileCount,
      conflictPredicted: status.status === "conflict-predicted" || status.status === "conflict-active",
      peerConflicts,
      analyzedAt: nowIso()
    };
  };

  const getMergeContext = async (prId: string): Promise<PrMergeContext> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);

    const lanes = await laneService.list({ includeArchived: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const findLaneIdByBranch = (rawBranch: string): string | null => {
      const normalized = normalizeBranchName(rawBranch);
      if (!normalized) return null;
      const byBranch = lanes.find((lane) => normalizeBranchName(lane.branchRef) === normalized);
      return byBranch?.id ?? null;
    };

    const fallbackTargetLaneId = findLaneIdByBranch(row.base_branch);
    const fallbackSourceLaneId = row.lane_id;
    const fallbackMembers: PrMergeContext["members"] = [
      {
        prId: row.id,
        laneId: row.lane_id,
        laneName: laneById.get(row.lane_id)?.name ?? row.lane_id,
        prNumber: Number.isFinite(Number(row.github_pr_number)) ? Number(row.github_pr_number) : null,
        position: 0,
        role: "source"
      }
    ];

    const group = db.get<PrGroupLookupRow>(
      `
        select
          g.id as group_id,
          g.group_type as group_type
        from pr_group_members m
        join pr_groups g on g.id = m.group_id
        where g.project_id = ? and m.pr_id = ?
        order by g.created_at desc
        limit 1
      `,
      [projectId, prId]
    );

    const baseMergeContext: PrMergeContext = {
      prId,
      groupId: group?.group_id ?? null,
      groupType: null,
      sourceLaneIds: [fallbackSourceLaneId],
      targetLaneId: fallbackTargetLaneId,
      integrationLaneId: null,
      members: fallbackMembers
    };

    if (!group) {
      return baseMergeContext;
    }

    const members = db
      .all<PrGroupMemberLookupRow>(
        `
          select
            m.group_id as group_id,
            m.pr_id as pr_id,
            m.lane_id as lane_id,
            m.position as position,
            m.role as role,
            l.name as lane_name,
            p.github_pr_number as pr_number
          from pr_group_members m
          left join lanes l on l.id = m.lane_id and l.project_id = ?
          left join pull_requests p on p.id = m.pr_id and p.project_id = ?
          where m.group_id = ?
          order by m.position asc
        `,
        [projectId, projectId, group.group_id]
      )
      .map((member) => ({
        prId: member.pr_id,
        laneId: member.lane_id,
        laneName: member.lane_name ?? laneById.get(member.lane_id)?.name ?? member.lane_id,
        prNumber: Number.isFinite(Number(member.pr_number)) ? Number(member.pr_number) : null,
        position: Number(member.position),
        role: normalizeGroupMemberRole(String(member.role ?? "source"))
      }));

    const groupType = group.group_type === "integration" ? "integration" : "queue";
    const sourceLaneIds = members
      .filter((member) => member.role === "source")
      .map((member) => member.laneId);

    const integrationLaneId =
      groupType === "integration" ? (members.find((member) => member.role === "integration")?.laneId ?? null) : null;

    return {
      ...baseMergeContext,
      groupType,
      sourceLaneIds: sourceLaneIds.length > 0 ? sourceLaneIds : [fallbackSourceLaneId],
      integrationLaneId,
      members: members.length > 0 ? members : fallbackMembers
    };
  };

  const extractConflictDetail = async (
    treeOid: string,
    filePath: string,
    cwd: string
  ): Promise<ConflictExcerpts> => {
    try {
      const result = await runGit(
        ["show", `${treeOid}:${filePath}`],
        { cwd, timeoutMs: 10_000 }
      );
      const content = result.stdout;
      if (!content.includes("<<<<<<<")) {
        return EMPTY_CONFLICT_EXCERPTS;
      }
      return parseConflictMarkers(content);
    } catch {
      return EMPTY_CONFLICT_EXCERPTS;
    }
  };

  const readConflictMarkerFiles = (worktreePath: string, filePaths: string[]): string[] => {
    const worktreeRoot = path.resolve(worktreePath);
    const matches: string[] = [];

    for (const rawPath of filePaths) {
      const filePath = rawPath.trim();
      if (!filePath) continue;
      let absPath: string;
      try {
        absPath = resolvePathWithinRoot(worktreeRoot, filePath);
      } catch {
        continue;
      }
      try {
        if (!fs.statSync(absPath).isFile()) continue;
        const content = fs.readFileSync(absPath, "utf8");
        if (hasMergeConflictMarkers(content)) {
          matches.push(filePath);
        }
      } catch {
        // Best-effort validation only.
      }
    }

    return matches;
  };

  const simulateIntegration = async (args: SimulateIntegrationArgs): Promise<IntegrationProposal> => {
    const proposalId = randomUUID();
    const now = nowIso();
    const lanes = await laneService.list({ includeArchived: false });
    const preflight = buildIntegrationPreflight(lanes, args.sourceLaneIds, args.baseBranch);
    if (!preflight.uniqueSourceLaneIds.length) throw new Error("At least one source lane is required");
    if (preflight.duplicateSourceLaneIds.length > 0) {
      throw new Error(`Duplicate source lanes selected: ${preflight.duplicateSourceLaneIds.join(", ")}`);
    }
    if (preflight.missingSourceLaneIds.length > 0) {
      throw new Error(`Source lanes not found: ${preflight.missingSourceLaneIds.join(", ")}`);
    }
    const sourceLaneIds = preflight.uniqueSourceLaneIds;
    const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
    const laneOrder = new Map(sourceLaneIds.map((laneId, index) => [laneId, index]));
    const zeroDiffStat: IntegrationProposalStep["diffStat"] = { insertions: 0, deletions: 0, filesChanged: 0 };

    const mergeIntoLaneId = asString(args.mergeIntoLaneId).trim();
    if (mergeIntoLaneId && sourceLaneIds.includes(mergeIntoLaneId)) {
      throw new Error("Merge-into lane cannot be one of the source lanes.");
    }
    const mergeIntoLane = mergeIntoLaneId ? laneMap.get(mergeIntoLaneId) ?? null : null;
    if (mergeIntoLaneId && !mergeIntoLane) {
      throw new Error(`Merge-into lane not found: ${mergeIntoLaneId}`);
    }

    // Resolve base branch SHA once, then compare each lane head against it.
    const baseSha = (await runGitOrThrow(
      ["rev-parse", args.baseBranch],
      { cwd: projectRoot, timeoutMs: 10_000 }
    )).trim();

    let mergeIntoHeadSha: string | null = null;
    if (mergeIntoLane) {
      mergeIntoHeadSha = (await runGitOrThrow(
        ["rev-parse", branchNameFromRef(mergeIntoLane.branchRef)],
        { cwd: projectRoot, timeoutMs: 10_000 }
      )).trim();
    }
    const sequentialStartSha = mergeIntoHeadSha ?? baseSha;

    const laneSummariesById = new Map<
      string,
      {
        laneId: string;
        laneName: string;
        position: number;
        headSha: string | null;
        commitHash: string;
        commitCount: number;
        diffStat: IntegrationProposalStep["diffStat"];
      }
    >();

    for (let i = 0; i < sourceLaneIds.length; i++) {
      const laneId = sourceLaneIds[i]!;
      const lane = laneMap.get(laneId);
      if (!lane) {
        laneSummariesById.set(laneId, {
          laneId,
          laneName: laneId,
          position: i,
          headSha: null,
          commitHash: "",
          commitCount: 0,
          diffStat: zeroDiffStat
        });
        continue;
      }

      try {
        const headSha = (await runGitOrThrow(
          ["rev-parse", branchNameFromRef(lane.branchRef)],
          { cwd: projectRoot, timeoutMs: 10_000 }
        )).trim();

        const commitCountResult = await runGit(
          ["rev-list", "--count", `${baseSha}..${headSha}`],
          { cwd: projectRoot, timeoutMs: 10_000 }
        );
        const commitCount = commitCountResult.exitCode === 0 ? asNumber(commitCountResult.stdout.trim()) : 0;

        const diffStatResult = await runGit(
          ["diff", "--shortstat", `${baseSha}..${headSha}`],
          { cwd: projectRoot, timeoutMs: 10_000 }
        );
        const diffStat = diffStatResult.exitCode === 0 ? parseDiffStatOutput(diffStatResult.stdout) : zeroDiffStat;
        const shortHashResult = await runGit(
          ["rev-parse", "--short", headSha],
          { cwd: projectRoot, timeoutMs: 10_000 }
        );
        const commitHash = shortHashResult.exitCode === 0
          ? shortHashResult.stdout.trim()
          : headSha.slice(0, 8);

        laneSummariesById.set(laneId, {
          laneId,
          laneName: lane.name,
          position: i,
          headSha,
          commitHash,
          commitCount,
          diffStat
        });
      } catch {
        laneSummariesById.set(laneId, {
          laneId,
          laneName: lane.name,
          position: i,
          headSha: null,
          commitHash: "",
          commitCount: 0,
          diffStat: zeroDiffStat
        });
      }
    }

    const pairwiseResults: IntegrationPairwiseResult[] = [];
    const blockedLaneIds = new Set<string>();
    for (let i = 0; i < sourceLaneIds.length; i++) {
      const laneAId = sourceLaneIds[i]!;
      const laneA = laneSummariesById.get(laneAId);
      if (!laneA) continue;

      for (let j = i + 1; j < sourceLaneIds.length; j++) {
        const laneBId = sourceLaneIds[j]!;
        const laneB = laneSummariesById.get(laneBId);
        if (!laneB) continue;

        if (!laneA.headSha || !laneB.headSha) {
          continue;
        }

        const mergeTreeResult = await runGitMergeTree({
          cwd: projectRoot,
          mergeBase: baseSha,
          branchA: laneA.headSha,
          branchB: laneB.headSha,
          timeoutMs: 30_000
        });
        if (mergeTreeResult.exitCode === 128) {
          logger.warn("prs.merge_tree_fatal", {
            laneAId,
            laneBId,
            exitCode: mergeTreeResult.exitCode,
            stderr: mergeTreeResult.stderr.trim()
          });
          blockedLaneIds.add(laneAId);
          blockedLaneIds.add(laneBId);
          continue;
        }
        const hasConflict = mergeTreeResult.conflicts.length > 0;
        if (!hasConflict && mergeTreeResult.exitCode !== 0) {
          logger.warn("prs.merge_tree_unknown", {
            laneAId,
            laneBId,
            exitCode: mergeTreeResult.exitCode,
            stderr: mergeTreeResult.stderr.trim(),
            stdoutPreview: mergeTreeResult.stdout.replace(/\0/g, "\\0").slice(0, 300)
          });
          blockedLaneIds.add(laneAId);
          blockedLaneIds.add(laneBId);
          continue;
        }
        const conflictingFiles: IntegrationProposalStep["conflictingFiles"] = [];

        if (hasConflict) {
          const treeOid = mergeTreeResult.treeOid;
          const conflictPaths = mergeTreeResult.conflicts.map((conflict) => conflict.path);
          logger.info("prs.merge_tree_conflict_parse", {
            laneAId,
            laneBId,
            exitCode: mergeTreeResult.exitCode,
            treeOid: treeOid ?? "(null)",
            stdoutLen: mergeTreeResult.stdout.length,
            stderrLen: mergeTreeResult.stderr.length,
            stdoutPreview: mergeTreeResult.stdout.replace(/\0/g, "\\0").slice(0, 500),
            stderrPreview: mergeTreeResult.stderr.slice(0, 300),
            parsedPathCount: conflictPaths.length,
            parsedPaths: conflictPaths.slice(0, 10)
          });
          for (const filePath of conflictPaths) {
            if (treeOid) {
              const detail = await extractConflictDetail(treeOid, filePath, projectRoot);
              conflictingFiles.push({
                path: filePath,
                conflictType: detail.conflictType,
                conflictMarkers: detail.conflictMarkers,
                oursExcerpt: detail.oursExcerpt || null,
                theirsExcerpt: detail.theirsExcerpt || null,
                diffHunk: detail.diffHunk || null
              });
            } else {
              // No tree OID: generate excerpts from per-file diffs against base
              let oursExcerpt: string | null = null;
              let theirsExcerpt: string | null = null;
              try {
                const [diffA, diffB] = await Promise.all([
                  runGit(["diff", `${baseSha}..${laneA.headSha}`, "--", filePath], { cwd: projectRoot, timeoutMs: 10_000 }),
                  runGit(["diff", `${baseSha}..${laneB.headSha}`, "--", filePath], { cwd: projectRoot, timeoutMs: 10_000 })
                ]);
                if (diffA.exitCode === 0 && diffA.stdout.trim()) oursExcerpt = diffA.stdout.slice(0, 500);
                if (diffB.exitCode === 0 && diffB.stdout.trim()) theirsExcerpt = diffB.stdout.slice(0, 500);
              } catch { /* best-effort */ }
              conflictingFiles.push({
                path: filePath,
                conflictType: null,
                conflictMarkers: "",
                oursExcerpt,
                theirsExcerpt,
                diffHunk: null
              });
            }
          }
        }

        pairwiseResults.push({
          laneAId,
          laneAName: laneA.laneName,
          laneBId,
          laneBName: laneB.laneName,
          outcome: hasConflict ? "conflict" : "clean",
          conflictingFiles
        });
      }
    }

    logger.info("prs.integration_pairwise_summary", {
      totalPairs: pairwiseResults.length,
      conflictPairs: pairwiseResults.filter((p) => p.outcome === "conflict").length,
      pairsWithFiles: pairwiseResults.filter((p) => p.conflictingFiles.length > 0).length,
      details: pairwiseResults.map((p) => ({
        laneA: p.laneAName, laneB: p.laneBName,
        outcome: p.outcome, fileCount: p.conflictingFiles.length,
        filePaths: p.conflictingFiles.map((f) => f.path).slice(0, 5)
      }))
    });

    const mergeIntoConflictLaneIds = new Set<string>();
    const mergeIntoFilesByLaneId = new Map<string, Map<string, IntegrationProposalStep["conflictingFiles"][number]>>();
    if (mergeIntoHeadSha) {
      for (const laneId of sourceLaneIds) {
        const laneSummary = laneSummariesById.get(laneId);
        if (!laneSummary?.headSha) continue;
        const mergeTreeResult = await runGitMergeTree({
          cwd: projectRoot,
          mergeBase: baseSha,
          branchA: mergeIntoHeadSha,
          branchB: laneSummary.headSha,
          timeoutMs: 30_000
        });
        if (mergeTreeResult.exitCode === 128 || (!mergeTreeResult.conflicts.length && mergeTreeResult.exitCode !== 0)) {
          mergeIntoConflictLaneIds.add(laneId);
          continue;
        }
        if (mergeTreeResult.conflicts.length === 0) continue;
        mergeIntoConflictLaneIds.add(laneId);
        const fileMap = mergeIntoFilesByLaneId.get(laneId) ?? new Map<string, IntegrationProposalStep["conflictingFiles"][number]>();
        const treeOid = mergeTreeResult.treeOid;
        for (const filePath of mergeTreeResult.conflicts.map((c) => c.path)) {
          if (fileMap.has(filePath)) continue;
          if (treeOid) {
            const detail = await extractConflictDetail(treeOid, filePath, projectRoot);
            fileMap.set(filePath, {
              path: filePath,
              conflictType: detail.conflictType,
              conflictMarkers: detail.conflictMarkers,
              oursExcerpt: detail.oursExcerpt || null,
              theirsExcerpt: detail.theirsExcerpt || null,
              diffHunk: detail.diffHunk || null
            });
          } else {
            let oursExcerpt: string | null = null;
            let theirsExcerpt: string | null = null;
            try {
              const [diffI, diffS] = await Promise.all([
                runGit(["diff", `${baseSha}..${mergeIntoHeadSha}`, "--", filePath], { cwd: projectRoot, timeoutMs: 10_000 }),
                runGit(["diff", `${baseSha}..${laneSummary.headSha}`, "--", filePath], { cwd: projectRoot, timeoutMs: 10_000 })
              ]);
              if (diffI.exitCode === 0 && diffI.stdout.trim()) oursExcerpt = diffI.stdout.slice(0, 500);
              if (diffS.exitCode === 0 && diffS.stdout.trim()) theirsExcerpt = diffS.stdout.slice(0, 500);
            } catch { /* best-effort */ }
            fileMap.set(filePath, {
              path: filePath,
              conflictType: null,
              conflictMarkers: "",
              oursExcerpt,
              theirsExcerpt,
              diffHunk: null
            });
          }
        }
        mergeIntoFilesByLaneId.set(laneId, fileMap);
      }
    }

    const sequentialConflictLaneIds = new Set<string>();
    const sequentialBlockedLaneIds = new Set<string>();
    const sequentialFilesByLaneId = new Map<string, Map<string, IntegrationProposalStep["conflictingFiles"][number]>>();
    const sequentialTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-integration-sim-"));
    const sequentialWorktreePath = path.join(sequentialTempRoot, "worktree");

    try {
      await runGitOrThrow(["worktree", "add", "--detach", sequentialWorktreePath, sequentialStartSha], {
        cwd: projectRoot,
        timeoutMs: 60_000,
      });

      for (const laneId of sourceLaneIds) {
        const lane = laneMap.get(laneId);
        const laneSummary = laneSummariesById.get(laneId);
        if (!lane || !laneSummary?.headSha) {
          sequentialBlockedLaneIds.add(laneId);
          continue;
        }

        const sourceBranch = branchNameFromRef(lane.branchRef);
        const mergeRes = await runGit(
          ["merge", "--no-ff", "-m", `Merge ${lane.name} into integration simulation`, sourceBranch],
          { cwd: sequentialWorktreePath, timeoutMs: 60_000 }
        );

        if (mergeRes.exitCode === 0) {
          continue;
        }

        const statusRes = await runGit(
          ["status", "--porcelain"],
          { cwd: sequentialWorktreePath, timeoutMs: 10_000 }
        );
        const conflictPaths = statusRes.exitCode === 0
          ? parseGitStatusPorcelain(statusRes.stdout).unmergedPaths
          : [];

        sequentialConflictLaneIds.add(laneId);
        const fileMap = sequentialFilesByLaneId.get(laneId) ?? new Map<string, IntegrationProposalStep["conflictingFiles"][number]>();
        for (const filePath of conflictPaths) {
          if (!fileMap.has(filePath)) {
            fileMap.set(filePath, readConflictFilePreviewFromWorktree(sequentialWorktreePath, filePath));
          }
        }
        sequentialFilesByLaneId.set(laneId, fileMap);

        const abortRes = await runGit(
          ["merge", "--abort"],
          { cwd: sequentialWorktreePath, timeoutMs: 10_000 }
        );
        if (abortRes.exitCode !== 0) {
          sequentialBlockedLaneIds.add(laneId);
          break;
        }
      }
    } finally {
      try {
        await runGit(
          ["worktree", "remove", "--force", sequentialWorktreePath],
          { cwd: projectRoot, timeoutMs: 60_000 }
        );
      } catch {
        // Best-effort cleanup only.
      }
      fs.rmSync(sequentialTempRoot, { recursive: true, force: true });
    }

    logger.info("prs.integration_sequential_summary", {
      totalLanes: sourceLaneIds.length,
      conflictingLanes: Array.from(sequentialConflictLaneIds),
      blockedLanes: Array.from(sequentialBlockedLaneIds),
    });

    const conflictingPeersByLaneId = new Map<string, Set<string>>();
    const conflictingFilesByLaneId = new Map<string, Map<string, IntegrationProposalStep["conflictingFiles"][number]>>();
    for (const laneId of sourceLaneIds) {
      conflictingPeersByLaneId.set(laneId, new Set<string>());
      conflictingFilesByLaneId.set(laneId, new Map<string, IntegrationProposalStep["conflictingFiles"][number]>());
    }

    for (const pair of pairwiseResults) {
      if (pair.outcome !== "conflict") continue;
      conflictingPeersByLaneId.get(pair.laneAId)?.add(pair.laneBId);
      conflictingPeersByLaneId.get(pair.laneBId)?.add(pair.laneAId);
      const laneAFiles = conflictingFilesByLaneId.get(pair.laneAId);
      const laneBFiles = conflictingFilesByLaneId.get(pair.laneBId);
      for (const file of pair.conflictingFiles) {
        if (laneAFiles && !laneAFiles.has(file.path)) laneAFiles.set(file.path, file);
        if (laneBFiles && !laneBFiles.has(file.path)) laneBFiles.set(file.path, file);
      }
    }

    for (const [laneId, files] of sequentialFilesByLaneId.entries()) {
      const laneFiles = conflictingFilesByLaneId.get(laneId) ?? new Map<string, IntegrationProposalStep["conflictingFiles"][number]>();
      for (const [filePath, file] of files.entries()) {
        if (!laneFiles.has(filePath)) laneFiles.set(filePath, file);
      }
      conflictingFilesByLaneId.set(laneId, laneFiles);
    }

    for (const [laneId, files] of mergeIntoFilesByLaneId.entries()) {
      const laneFiles = conflictingFilesByLaneId.get(laneId) ?? new Map<string, IntegrationProposalStep["conflictingFiles"][number]>();
      for (const [filePath, file] of files.entries()) {
        if (!laneFiles.has(filePath)) laneFiles.set(filePath, file);
      }
      conflictingFilesByLaneId.set(laneId, laneFiles);
    }

    const laneSummaries: IntegrationLaneSummary[] = sourceLaneIds.map((laneId) => {
      const laneSummary = laneSummariesById.get(laneId);
      const laneName = laneSummary?.laneName ?? laneId;
      const conflictsWith = Array.from(conflictingPeersByLaneId.get(laneId) ?? []);
      conflictsWith.sort((a, b) => (laneOrder.get(a) ?? 0) - (laneOrder.get(b) ?? 0));

      let outcome: IntegrationLaneSummary["outcome"] = "clean";
      if (!laneSummary?.headSha || blockedLaneIds.has(laneId) || sequentialBlockedLaneIds.has(laneId)) {
        outcome = "blocked";
      } else if (conflictsWith.length > 0 || sequentialConflictLaneIds.has(laneId) || mergeIntoConflictLaneIds.has(laneId)) {
        outcome = "conflict";
      }

      return {
        laneId,
        laneName,
        commitHash: laneSummary?.commitHash ?? "",
        commitCount: laneSummary?.commitCount ?? 0,
        outcome,
        conflictsWith,
        diffStat: laneSummary?.diffStat ?? zeroDiffStat
      };
    });

    // Keep `steps` as a projection of lane summaries for current consumers.
    const steps: IntegrationProposalStep[] = laneSummaries.map((laneSummary) => ({
      laneId: laneSummary.laneId,
      laneName: laneSummary.laneName,
      position: laneSummariesById.get(laneSummary.laneId)?.position ?? 0,
      outcome: laneSummary.outcome,
      conflictingFiles: Array.from(conflictingFilesByLaneId.get(laneSummary.laneId)?.values() ?? []),
      diffStat: laneSummary.diffStat
    }));

    let overallOutcome: IntegrationProposal["overallOutcome"] = "clean";
    if (laneSummaries.some((lane) => lane.outcome === "blocked")) {
      overallOutcome = "blocked";
    } else if (laneSummaries.some((lane) => lane.outcome === "conflict")) {
      overallOutcome = "conflict";
    }

    const proposal: IntegrationProposal = {
      proposalId,
      sourceLaneIds,
      baseBranch: args.baseBranch,
      pairwiseResults,
      laneSummaries,
      steps,
      overallOutcome,
      createdAt: now,
      status: "proposed",
      preferredIntegrationLaneId: mergeIntoLaneId || null,
      mergeIntoHeadSha: mergeIntoHeadSha ?? null,
      linkedGroupId: null,
      linkedPrId: null,
      workflowDisplayState: "active",
      cleanupState: "none",
      closedAt: null,
      mergedAt: null,
      completedAt: null,
      cleanupDeclinedAt: null,
      cleanupCompletedAt: null,
    };

    if (args.persist !== false) {
      db.run(
        `insert into integration_proposals(id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json, lane_summaries_json, overall_outcome, created_at, status, preferred_integration_lane_id, merge_into_head_sha) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          proposalId,
          projectId,
          JSON.stringify(sourceLaneIds),
          args.baseBranch,
          JSON.stringify(steps),
          JSON.stringify(pairwiseResults),
          JSON.stringify(laneSummaries),
          overallOutcome,
          now,
          "proposed",
          mergeIntoLaneId || null,
          mergeIntoHeadSha ?? null,
        ]
      );
    }

    return proposal;
  };

  const createIntegrationPrFromExistingLane = async (args: {
    sourceLaneIds: string[];
    integrationLaneId: string;
    baseBranch: string;
    title: string;
    body?: string;
    draft?: boolean;
    allowDirtyWorktree?: boolean;
  }): Promise<CreateIntegrationPrResult> => {
    const lanes = await laneService.list({ includeArchived: false });
    const integrationLane = lanes.find((lane) => lane.id === args.integrationLaneId);
    if (!integrationLane) throw new Error(`Integration lane not found: ${args.integrationLaneId}`);
    assertDirtyWorktreesAllowed({
      lanes,
      laneIds: [...args.sourceLaneIds, integrationLane.id],
      allowDirtyWorktree: args.allowDirtyWorktree
    });

    const groupId = randomUUID();
    const now = nowIso();
    db.run(
      `insert into pr_groups(id, project_id, group_type, created_at) values (?, ?, 'integration', ?)`,
      [groupId, projectId, now]
    );

    try {
      const pr = await createFromLane({
        laneId: integrationLane.id,
        title: args.title,
        body: args.body ?? "",
        draft: Boolean(args.draft),
        baseBranch: args.baseBranch,
        allowDirtyWorktree: true
      });

      const integrationMemberId = randomUUID();
      db.run(
        `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, 0, 'integration')`,
        [integrationMemberId, groupId, pr.id, integrationLane.id]
      );

      for (let i = 0; i < args.sourceLaneIds.length; i += 1) {
        const sourceLaneId = args.sourceLaneIds[i]!;
        const memberId = randomUUID();
        db.run(
          `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
          [memberId, groupId, pr.id, sourceLaneId, i + 1]
        );
      }

      return {
        groupId,
        integrationLaneId: integrationLane.id,
        pr,
        mergeResults: args.sourceLaneIds.map((laneId) => ({ laneId, success: true }))
      };
    } catch (error) {
      db.run("delete from pr_group_members where group_id = ?", [groupId]);
      db.run("delete from pr_groups where id = ? and project_id = ?", [groupId, projectId]);
      throw error;
    }
  };

  const commitIntegration = async (args: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => {
    // Look up proposal
    const proposalRow = db.get<{
      id: string;
      source_lane_ids_json: string;
      base_branch: string;
      steps_json: string;
      integration_lane_id: string | null;
      integration_lane_name: string | null;
      preferred_integration_lane_id: string | null;
    }>(
      `select id, source_lane_ids_json, base_branch, steps_json, integration_lane_id, integration_lane_name, preferred_integration_lane_id from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);

    const sourceLaneIds = JSON.parse(String(proposalRow.source_lane_ids_json)) as string[];
    const existingIntegrationLaneId = asString(proposalRow.integration_lane_id).trim();
    const preferredFromRow = asString(proposalRow.preferred_integration_lane_id).trim() || null;
    const preferredIntegrationLaneId =
      args.preferredIntegrationLaneId !== undefined
        ? (asString(args.preferredIntegrationLaneId).trim() || null)
        : preferredFromRow;
    if (preferredIntegrationLaneId && sourceLaneIds.includes(preferredIntegrationLaneId)) {
      throw new Error("Preferred integration lane cannot be one of the source lanes.");
    }

    let result: CreateIntegrationPrResult;
    if (existingIntegrationLaneId) {
      result = await createIntegrationPrFromExistingLane({
        sourceLaneIds,
        integrationLaneId: existingIntegrationLaneId,
        baseBranch: String(proposalRow.base_branch),
        title: args.title,
        body: args.body,
        draft: args.draft,
        allowDirtyWorktree: args.allowDirtyWorktree
      });
    } else {
      const availableLanes = await laneService.list({ includeArchived: false });
      const dirtyCheckLaneIds = [...sourceLaneIds];
      if (preferredIntegrationLaneId) dirtyCheckLaneIds.push(preferredIntegrationLaneId);
      assertDirtyWorktreesAllowed({
        lanes: availableLanes,
        laneIds: dirtyCheckLaneIds,
        allowDirtyWorktree: args.allowDirtyWorktree,
      });

      const preparedLane = await createIntegrationLaneForProposal({
        proposalId: args.proposalId,
      });

      if (preparedLane.conflictingLanes.length > 0) {
        const refreshedLanes = await laneService.list({ includeArchived: true, includeStatus: false });
        const laneMap = new Map(refreshedLanes.map((lane) => [lane.id, lane]));
        const failedLaneNames = preparedLane.conflictingLanes
          .map((laneId) => laneMap.get(laneId)?.name ?? laneId)
          .join(", ");
        const integrationLaneName =
          laneMap.get(preparedLane.integrationLaneId)?.name
          || asString(proposalRow.integration_lane_name).trim()
          || asString(args.integrationLaneName).trim()
          || `integration/${args.proposalId.slice(0, 8)}`;

        throw new Error(
          `Integration merge blocked. Resolve conflicts for: ${failedLaneNames}. ` +
            `No GitHub PR was created yet; fix merges in lane '${integrationLaneName}' and try again.`
        );
      }

      result = await createIntegrationPrFromExistingLane({
        sourceLaneIds,
        integrationLaneId: preparedLane.integrationLaneId,
        baseBranch: String(proposalRow.base_branch),
        title: args.title,
        body: args.body,
        draft: args.draft,
        allowDirtyWorktree: args.allowDirtyWorktree
      });
    }

    updateIntegrationProposalColumns(args.proposalId, {
      status: "committed",
      integration_lane_name:
        result.integrationLaneId
          ? (
              asString(args.integrationLaneName).trim()
              || asString(proposalRow.integration_lane_name).trim()
              || null
            )
          : null,
      ...(args.preferredIntegrationLaneId !== undefined
        ? { preferred_integration_lane_id: preferredIntegrationLaneId }
        : {}),
      integration_lane_id: result.integrationLaneId,
      linked_group_id: result.groupId,
      linked_pr_id: result.pr.id,
      workflow_display_state: "active",
      cleanup_state: "none",
      closed_at: null,
      merged_at: null,
      completed_at: null,
      cleanup_declined_at: null,
      cleanup_completed_at: null,
      title: args.title,
      body: args.body ?? "",
      draft: args.draft ? 1 : 0,
    });

    return result;
  };

  const GITHUB_SNAPSHOT_TTL_MS = 120_000;
  let cachedGithubSnapshot: GitHubPrSnapshot | null = null;
  let cachedGithubSnapshotAt = 0;
  let githubSnapshotInFlight: Promise<GitHubPrSnapshot> | null = null;

  const getGithubSnapshotUncached = async (): Promise<GitHubPrSnapshot> => {
    const githubStatus = await githubService.getStatus();
    if (!githubStatus.tokenStored) {
      throw new Error("GitHub token missing. Set it in Settings to sync pull requests.");
    }

    const repo = githubStatus.repo;
    if (!repo) {
      return {
        repo: null,
        viewerLogin: githubStatus.userLogin,
        repoPullRequests: [],
        externalPullRequests: [],
        syncedAt: nowIso(),
      };
    }

    const lanes = await laneService.list({ includeArchived: true, includeStatus: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    const pullRequestRows = listRows();
    const linkedPrByRepoKey = new Map(
      pullRequestRows.map((row) => [`${row.repo_owner}/${row.repo_name}#${row.github_pr_number}`, row] as const)
    );
    const groupRows = db.all<{ pr_id: string; group_id: string; group_type: "queue" | "integration" }>(
      `select gm.pr_id, gm.group_id, g.group_type
       from pr_group_members gm
       join pr_groups g on g.id = gm.group_id
       where g.project_id = ?`,
      [projectId]
    );
    const groupByPrId = new Map(groupRows.map((row) => [row.pr_id, row] as const));
    const workflowRows = await loadIntegrationWorkflowRows();
    const workflowByPrId = new Map<string, IntegrationProposalRow>();
    for (const row of workflowRows) {
      const linkedPrId = asString(row.linked_pr_id).trim();
      if (linkedPrId) workflowByPrId.set(linkedPrId, row);
    }

    const deriveAdeKind = (
      workflow: IntegrationProposalRow | null,
      group: { group_type: string } | null | undefined,
      linked: PullRequestRow | null,
    ): GitHubPrListItem["adeKind"] => {
      if (workflow) return "integration";
      if (group?.group_type === "queue") return "queue";
      if (group?.group_type === "integration") return "integration";
      if (linked) return "single";
      return null;
    };

    const toGitHubState = (rawPr: any): PrState => {
      if (Boolean(rawPr?.draft)) return "draft";
      if (rawPr?.merged_at) return "merged";
      return asString(rawPr?.state).toLowerCase() === "closed" ? "closed" : "open";
    };

    const toGitHubItem = (rawPr: any, scope: "repo" | "external"): GitHubPrListItem => {
      const rawRepo = rawPr?.base?.repo ?? rawPr?.repository ?? {};
      const repositoryUrl = asString(rawPr?.repository_url);
      const repositoryParts = repositoryUrl
        ? repositoryUrl.split("/").filter(Boolean).slice(-2)
        : [];
      const repoOwner = asString(rawRepo?.owner?.login) || repositoryParts[0] || repo.owner;
      const repoName = asString(rawRepo?.name) || repositoryParts[1] || repo.name;
      const githubPrNumber = Number(rawPr?.number) || 0;
      const linkedPrRow = linkedPrByRepoKey.get(`${repoOwner}/${repoName}#${githubPrNumber}`) ?? null;
      const workflowRow = linkedPrRow ? workflowByPrId.get(linkedPrRow.id) ?? null : null;
      const groupRow = linkedPrRow ? groupByPrId.get(linkedPrRow.id) ?? null : null;

      return {
        id: asString(rawPr?.node_id) || `${scope}-${repoOwner}-${repoName}-${githubPrNumber}`,
        scope,
        repoOwner,
        repoName,
        githubPrNumber,
        githubUrl: asString(rawPr?.html_url) || "",
        title: asString(rawPr?.title) || `PR #${githubPrNumber}`,
        state: toGitHubState(rawPr),
        isDraft: Boolean(rawPr?.draft),
        baseBranch: asString(rawPr?.base?.ref) || null,
        headBranch: asString(rawPr?.head?.ref) || null,
        author: asString(rawPr?.user?.login) || null,
        createdAt: asString(rawPr?.created_at) || nowIso(),
        updatedAt: asString(rawPr?.updated_at) || asString(rawPr?.created_at) || nowIso(),
        linkedPrId: linkedPrRow?.id ?? null,
        linkedGroupId: asString(workflowRow?.linked_group_id).trim() || groupRow?.group_id || null,
        linkedLaneId: linkedPrRow?.lane_id ?? null,
        linkedLaneName: linkedPrRow ? (laneById.get(linkedPrRow.lane_id)?.name ?? linkedPrRow.lane_id) : null,
        adeKind: deriveAdeKind(workflowRow, groupRow, linkedPrRow),
        workflowDisplayState: workflowRow ? parseWorkflowDisplayState(workflowRow.workflow_display_state) : null,
        cleanupState: workflowRow ? parseCleanupState(workflowRow.cleanup_state) : null,
        labels: Array.isArray(rawPr?.labels)
          ? rawPr.labels
              .filter((l: any) => l?.name)
              .map((l: any) => ({ name: String(l.name), color: String(l.color || "cccccc"), description: l.description != null ? String(l.description) : null }))
          : [],
        isBot: asString(rawPr?.user?.type).toLowerCase() === "bot",
        commentCount: Number(rawPr?.comments) || 0,
      };
    };

    const repoPullRequestsRaw = await fetchAllPages<any>({
      path: `/repos/${repo.owner}/${repo.name}/pulls`,
      query: { state: "all", sort: "updated", direction: "desc" },
    });

    const externalPullRequestsRaw = githubStatus.userLogin
      ? await fetchAllPages<any>({
          path: "/search/issues",
          query: {
            q: `is:pr involves:${githubStatus.userLogin} archived:false -repo:${repo.owner}/${repo.name}`,
            sort: "updated",
            order: "desc",
          },
          select: (payload) => Array.isArray(payload?.items) ? payload.items : [],
        })
      : [];

    return {
      repo,
      viewerLogin: githubStatus.userLogin,
      repoPullRequests: repoPullRequestsRaw.map((rawPr) => toGitHubItem(rawPr, "repo")),
      externalPullRequests: externalPullRequestsRaw
        .filter((rawPr) => rawPr?.pull_request)
        .map((rawPr) => toGitHubItem(rawPr, "external")),
      syncedAt: nowIso(),
    };
  };

  const getGithubSnapshot = async (options?: { force?: boolean }): Promise<GitHubPrSnapshot> => {
    const force = options?.force === true;
    if (!force && cachedGithubSnapshot && Date.now() - cachedGithubSnapshotAt < GITHUB_SNAPSHOT_TTL_MS) {
      return cachedGithubSnapshot;
    }
    if (!force && githubSnapshotInFlight) {
      return githubSnapshotInFlight;
    }

    const request = getGithubSnapshotUncached()
      .then((snapshot) => {
        cachedGithubSnapshot = snapshot;
        cachedGithubSnapshotAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        if (githubSnapshotInFlight === request) {
          githubSnapshotInFlight = null;
        }
      });

    githubSnapshotInFlight = request;
    return request;
  };

  const landQueueNext = async (args: LandQueueNextArgs): Promise<LandResult> => {
    // Find the group members sorted by position
    const members = db.all<PrGroupMemberLookupRow>(
      `select gm.group_id, gm.pr_id, gm.lane_id, gm.position, gm.role,
              l.name as lane_name, pr.github_pr_number as pr_number
       from pr_group_members gm
       left join lanes l on l.id = gm.lane_id
       left join pull_requests pr on pr.id = gm.pr_id
       where gm.group_id = ?
       order by gm.position asc`,
      [args.groupId]
    );

    if (!members.length) throw new Error(`No members in group: ${args.groupId}`);

    // Find first open PR in the queue
    for (const member of members) {
      const row = getRow(member.pr_id);
      if (!row) continue;
      const state = (row.state ?? "").toLowerCase();
      if (state === "open" || state === "draft") {
        return await land({ prId: member.pr_id, method: args.method, archiveLane: args.archiveLane });
      }
    }

    throw new Error("No open PRs remaining in queue");
  };

  const getPrHealth = async (prId: string): Promise<PrHealth> => {
    const row = getRow(prId);
    if (!row) throw new Error(`PR not found: ${prId}`);

    const summary = rowToSummary(row);
    const status = await computeStatus(summary);

    let analysis: PrConflictAnalysis | null = null;
    try { analysis = await getConflictAnalysis(prId); } catch { /* skip */ }

    let context: PrMergeContext | null = null;
    try { context = await getMergeContext(prId); } catch { /* skip */ }

    return {
      prId,
      laneId: row.lane_id,
      state: summary.state,
      checksStatus: summary.checksStatus,
      reviewStatus: summary.reviewStatus,
      conflictAnalysis: analysis,
      rebaseNeeded: (status.behindBaseBy ?? 0) > 0,
      behindBy: status.behindBaseBy ?? 0,
      mergeContext: context
    };
  };

  const getQueueState = async (groupId: string): Promise<QueueLandingState | null> => {
    const row = db.get<{
      id: string; group_id: string; state: string;
      entries_json: string; current_position: number;
      started_at: string; completed_at: string | null;
      config_json?: string | null;
      active_pr_id?: string | null;
      active_resolver_run_id?: string | null;
      last_error?: string | null;
      wait_reason?: string | null;
      updated_at?: string | null;
    }>(
      `select * from queue_landing_state where group_id = ? order by started_at desc limit 1`,
      [groupId]
    );
    if (!row) return null;
    return {
      queueId: String(row.id),
      groupId: String(row.group_id),
      groupName: null,
      targetBranch: null,
      state: String(row.state) as QueueLandingState["state"],
      entries: JSON.parse(String(row.entries_json)),
      currentPosition: Number(row.current_position),
      activePrId: row.active_pr_id ? String(row.active_pr_id) : null,
      activeResolverRunId: row.active_resolver_run_id ? String(row.active_resolver_run_id) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      waitReason: row.wait_reason ? String(row.wait_reason) as QueueLandingState["waitReason"] : null,
      config: row.config_json ? JSON.parse(String(row.config_json)) : {
        method: "squash",
        archiveLane: false,
        autoResolve: false,
        ciGating: true,
        resolverProvider: null,
        resolverModel: null,
        reasoningEffort: null,
        permissionMode: "guarded_edit",
        confidenceThreshold: null,
        originSurface: "manual",
        originMissionId: null,
        originRunId: null,
        originLabel: null,
      },
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : String(row.started_at),
    };
  };

  const listGroupPrs = async (groupId: string): Promise<PrSummary[]> => {
    const members = db.all<PrGroupMemberLookupRow>(
      `select gm.group_id, gm.pr_id, gm.lane_id, gm.position, gm.role,
              l.name as lane_name, pr.github_pr_number as pr_number
       from pr_group_members gm
       left join lanes l on l.id = gm.lane_id
       left join pull_requests pr on pr.id = gm.pr_id
       where gm.group_id = ?
       order by gm.position asc`,
      [groupId]
    );
    return members
      .map((m) => getRow(m.pr_id))
      .filter((r): r is PullRequestRow => r != null)
      .map(rowToSummary);
  };

  const reorderQueuePrs = async (args: ReorderQueuePrsArgs): Promise<void> => {
    const groupRow = db.get<{ id: string; group_type: string }>(
      `select id, group_type
       from pr_groups
       where id = ? and project_id = ?`,
      [args.groupId, projectId],
    );
    if (!groupRow || groupRow.group_type !== "queue") {
      throw new Error("Queue group not found.");
    }

    const queueState = db.get<{ state: string }>(
      `select state
       from queue_landing_state
       where group_id = ? and project_id = ?
       order by started_at desc
       limit 1`,
      [args.groupId, projectId],
    );
    if (queueState && (queueState.state === "landing" || queueState.state === "paused")) {
      throw new Error("Queue order cannot change while landing is active or paused.");
    }

    const members = db.all<{ pr_id: string; position: number }>(
      `select pr_id, position
       from pr_group_members
       where group_id = ? and role = 'source'
       order by position asc`,
      [args.groupId],
    );
    if (members.length < 2) return;

    const requestedPrIds = args.prIds.map((value) => value.trim()).filter(Boolean);
    const existingPrIds = members.map((member) => String(member.pr_id));
    if (
      requestedPrIds.length !== existingPrIds.length
      || new Set(requestedPrIds).size !== requestedPrIds.length
      || requestedPrIds.some((prId) => !existingPrIds.includes(prId))
    ) {
      throw new Error("Queue reorder request does not match the current queue members.");
    }

    const basePosition = Math.min(...members.map((member) => Number(member.position) || 0));
    db.run("BEGIN");
    try {
      requestedPrIds.forEach((prId, index) => {
        db.run(
          `update pr_group_members
           set position = ?
           where group_id = ? and pr_id = ? and role = 'source'`,
          [basePosition + index, args.groupId, prId],
        );
      });
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  };

  const listWithConflicts = async (): Promise<PrWithConflicts[]> => {
    const rows = listRows();
    const results: PrWithConflicts[] = [];
    for (const row of rows) {
      const summary = rowToSummary(row);
      let conflictAnalysis: PrConflictAnalysis | null = null;
      try {
        conflictAnalysis = await getConflictAnalysis(row.id);
      } catch {
        // Conflict analysis may fail for archived lanes; skip gracefully.
      }
      results.push({ ...summary, conflictAnalysis });
    }
    return results;
  };

  const listIntegrationProposals = async (): Promise<IntegrationProposal[]> => {
    db.run(
      `delete from integration_proposals
       where project_id = ?
         and status = 'proposed'
         and (integration_lane_id is null or integration_lane_id = '')
         and json_array_length(source_lane_ids_json) = 1
         and json_extract(source_lane_ids_json, '$[0]') in (
           select lane_id from pull_requests
           where project_id = ? and state in ('open', 'draft', 'merged')
         )`,
      [projectId, projectId],
    );
    const rows = listIntegrationProposalRows({ where: `status = 'proposed'` });
    const lanes = await laneService.list({ includeArchived: true, includeStatus: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    return await Promise.all(rows.map((row) => hydrateIntegrationProposalRow(row, laneById)));
  };

  const listIntegrationWorkflows = async (
    args: ListIntegrationWorkflowsArgs = {}
  ): Promise<IntegrationProposal[]> => {
    const rows = await loadIntegrationWorkflowRows();
    const lanes = await laneService.list({ includeArchived: true, includeStatus: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    const hydrated = await Promise.all(rows.map((row) => hydrateIntegrationProposalRow(row, laneById)));
    const view = args.view ?? "active";
    if (view === "all") return hydrated;
    return hydrated.filter((proposal) => proposal.workflowDisplayState === view);
  };

  const dismissIntegrationCleanup = async (
    args: DismissIntegrationCleanupArgs
  ): Promise<IntegrationProposal> => {
    const now = nowIso();
    updateIntegrationProposalColumns(args.proposalId, {
      cleanup_state: "declined",
      workflow_display_state: "history",
      cleanup_declined_at: now,
    });
    const rows = listIntegrationProposalRows({ where: `id = ?`, params: [args.proposalId] });
    const row = rows[0];
    if (!row) throw new Error(`Proposal not found: ${args.proposalId}`);
    const lanes = await laneService.list({ includeArchived: true, includeStatus: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    return await hydrateIntegrationProposalRow({
      ...row,
      cleanup_state: "declined",
      workflow_display_state: "history",
      cleanup_declined_at: now,
    }, laneById);
  };

  const cleanupIntegrationWorkflow = async (
    args: CleanupIntegrationWorkflowArgs
  ): Promise<CleanupIntegrationWorkflowResult> => {
    const row = db.get<IntegrationProposalRow>(
      `select * from integration_proposals where id = ? and project_id = ?`,
      [args.proposalId, projectId]
    );
    if (!row) throw new Error(`Proposal not found: ${args.proposalId}`);

    const sourceLaneIds = JSON.parse(String(row.source_lane_ids_json)) as string[];
    const requestedSourceLaneIds = Array.isArray(args.archiveSourceLaneIds)
      ? args.archiveSourceLaneIds.filter((laneId): laneId is string => typeof laneId === "string" && laneId.trim().length > 0)
      : [];
    const targetLaneIds = new Set<string>();
    if (args.archiveIntegrationLane !== false) {
      const integrationLaneId = asString(row.integration_lane_id).trim();
      if (integrationLaneId) targetLaneIds.add(integrationLaneId);
    }
    for (const laneId of requestedSourceLaneIds) {
      if (sourceLaneIds.includes(laneId)) targetLaneIds.add(laneId);
    }

    const linkedGroupId = asString(row.linked_group_id).trim();
    if (linkedGroupId) {
      db.run(`delete from pr_group_members where group_id = ?`, [linkedGroupId]);
      db.run(`delete from pr_groups where id = ? and project_id = ?`, [linkedGroupId, projectId]);
    }

    const laneList = await laneService.list({ includeArchived: true, includeStatus: false });
    const laneById = new Map(laneList.map((lane) => [lane.id, lane]));
    const archivedLaneIds: string[] = [];
    const skippedLaneIds: string[] = [];

    for (const laneId of targetLaneIds) {
      const lane = laneById.get(laneId);
      if (!lane || lane.archivedAt) {
        skippedLaneIds.push(laneId);
        continue;
      }
      try {
        laneService.archive({ laneId });
        archivedLaneIds.push(laneId);
      } catch {
        skippedLaneIds.push(laneId);
      }
    }

    const completedAt = nowIso();
    updateIntegrationProposalColumns(args.proposalId, {
      cleanup_state: "completed",
      workflow_display_state: "history",
      cleanup_completed_at: completedAt,
    });

    return {
      proposalId: args.proposalId,
      archivedLaneIds,
      skippedLaneIds,
      workflowDisplayState: "history",
      cleanupState: "completed",
    };
  };

  const updateIntegrationProposal = (args: UpdateIntegrationProposalArgs): void => {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (args.title !== undefined) { sets.push("title = ?"); params.push(args.title); }
    if (args.body !== undefined) { sets.push("body = ?"); params.push(args.body); }
    if (args.draft !== undefined) { sets.push("draft = ?"); params.push(args.draft ? 1 : 0); }
    if (args.integrationLaneName !== undefined) { sets.push("integration_lane_name = ?"); params.push(args.integrationLaneName); }
    if (args.preferredIntegrationLaneId !== undefined) {
      sets.push("preferred_integration_lane_id = ?");
      params.push(args.preferredIntegrationLaneId?.trim() || null);
    }
    if (args.mergeIntoHeadSha !== undefined) {
      sets.push("merge_into_head_sha = ?");
      params.push(args.mergeIntoHeadSha?.trim() || null);
    }
    if (args.clearIntegrationBinding) {
      sets.push("integration_lane_id = ?");
      params.push(null);
      sets.push("resolution_state_json = ?");
      params.push(null);
    }
    if (sets.length === 0) return;
    params.push(args.proposalId);
    db.run(`update integration_proposals set ${sets.join(", ")} where id = ?`, params);
  };

  const deleteIntegrationProposal = async (args: DeleteIntegrationProposalArgs): Promise<DeleteIntegrationProposalResult> => {
    const proposalRow = db.get<{
      id: string;
      integration_lane_id: string | null;
    }>(
      `select id, integration_lane_id from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);
    let deletedIntegrationLane = false;
    const integrationLaneId = asString(proposalRow.integration_lane_id).trim() || null;
    if (args.deleteIntegrationLane && integrationLaneId) {
      try {
        await laneService.delete({
          laneId: integrationLaneId,
          force: true,
        });
        deletedIntegrationLane = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Lane not found")) throw error;
      }
    }
    db.run(`delete from integration_proposals where id = ?`, [args.proposalId]);
    return {
      proposalId: args.proposalId,
      integrationLaneId,
      deletedIntegrationLane,
    };
  };

  // B1: Create integration lane for a proposal, merge clean steps
  const createIntegrationLaneForProposal = async (
    args: CreateIntegrationLaneForProposalArgs
  ): Promise<CreateIntegrationLaneForProposalResult> => {
    const proposalRow = db.get<{
      id: string; source_lane_ids_json: string; base_branch: string;
      steps_json: string; overall_outcome: string; integration_lane_name: string | null;
      integration_lane_id: string | null; preferred_integration_lane_id: string | null;
      merge_into_head_sha: string | null;
      resolution_state_json: string | null; created_at: string;
    }>(
      `select id, source_lane_ids_json, base_branch, steps_json, overall_outcome, integration_lane_name, integration_lane_id, preferred_integration_lane_id, merge_into_head_sha, resolution_state_json, created_at from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);

    const steps = JSON.parse(String(proposalRow.steps_json)) as IntegrationProposalStep[];
    const allLanes = await laneService.list({ includeArchived: false });
    const preflight = buildIntegrationPreflight(allLanes, steps.map((step) => step.laneId), String(proposalRow.base_branch));
    if (!preflight.uniqueSourceLaneIds.length) throw new Error("No source lanes are available for this proposal.");
    if (preflight.missingSourceLaneIds.length > 0) {
      throw new Error(`Source lanes not found: ${preflight.missingSourceLaneIds.join(", ")}`);
    }
    if (!preflight.baseLane) {
      throw new Error(`Could not map base branch "${String(proposalRow.base_branch)}" to an active lane. Create or attach that lane first.`);
    }
    const laneMap = new Map(allLanes.map((l) => [l.id, l]));
    const preferredIntegrationLaneId = asString(proposalRow.preferred_integration_lane_id).trim();
    if (preferredIntegrationLaneId && preflight.uniqueSourceLaneIds.includes(preferredIntegrationLaneId)) {
      throw new Error("Preferred integration lane cannot be one of the source lanes.");
    }
    const dirtyCheckLaneIds = [...preflight.uniqueSourceLaneIds];
    if (preferredIntegrationLaneId) dirtyCheckLaneIds.push(preferredIntegrationLaneId);
    assertDirtyWorktreesAllowed({
      lanes: allLanes,
      laneIds: dirtyCheckLaneIds,
      allowDirtyWorktree: args.allowDirtyWorktree,
    });
    const existingIntegrationLaneId = asString(proposalRow.integration_lane_id).trim();
    if (existingIntegrationLaneId) {
      const existingLane = laneMap.get(existingIntegrationLaneId);
      if (existingLane) {
        const existingState = proposalRow.resolution_state_json
          ? JSON.parse(String(proposalRow.resolution_state_json)) as IntegrationResolutionState
          : null;
        const mergedCleanSet = new Set(
          Object.entries(existingState?.stepResolutions ?? {})
            .filter(([, resolution]) => resolution === "merged-clean" || resolution === "resolved")
            .map(([laneId]) => laneId)
        );
        if (mergedCleanSet.size === 0) {
          for (const step of steps) {
            if (step.outcome === "clean") mergedCleanSet.add(step.laneId);
          }
        }
        return {
          integrationLaneId: existingLane.id,
          mergedCleanLanes: steps.filter((step) => mergedCleanSet.has(step.laneId)).map((step) => step.laneId),
          conflictingLanes: steps.filter((step) => !mergedCleanSet.has(step.laneId)).map((step) => step.laneId),
        };
      }
    }
    const shortId = args.proposalId.slice(0, 8);
    const integrationLaneName = String(proposalRow.integration_lane_name ?? "").trim() || `integration/${shortId}`;
    let integrationLane: LaneSummary;
    if (preferredIntegrationLaneId) {
      const adopt = laneMap.get(preferredIntegrationLaneId);
      if (!adopt) throw new Error(`Preferred integration lane not found: ${preferredIntegrationLaneId}`);
      const storedMergeHead = asString(proposalRow.merge_into_head_sha).trim();
      try {
        const currentHead = (await runGitOrThrow(
          ["rev-parse", "HEAD"],
          { cwd: adopt.worktreePath, timeoutMs: 10_000 }
        )).trim();
        if (storedMergeHead && currentHead && storedMergeHead !== currentHead) {
          logger.warn("prs.integration_merge_into_head_drift", {
            proposalId: args.proposalId,
            preferredIntegrationLaneId,
            storedHead: storedMergeHead,
            currentHead,
          });
        }
      } catch (error) {
        logger.warn("prs.integration_merge_into_head_read_failed", {
          proposalId: args.proposalId,
          preferredIntegrationLaneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      integrationLane = adopt;
    } else {
      integrationLane = await laneService.createChild({
        parentLaneId: preflight.baseLane.id,
        name: integrationLaneName,
        description: `Integration lane for proposal ${args.proposalId}`
      });
    }

    const mergedCleanLanes: string[] = [];
    const conflictingLanes: string[] = [];

    for (const step of steps) {
      if (step.outcome === "clean") {
        const sourceLane = laneMap.get(step.laneId);
        if (!sourceLane) {
          conflictingLanes.push(step.laneId);
          continue;
        }
        const sourceBranch = branchNameFromRef(sourceLane.branchRef);
        const mergeRes = await runGit(
          ["merge", "--no-ff", "-m", `Merge ${sourceLane.name} into integration`, sourceBranch],
          { cwd: integrationLane.worktreePath, timeoutMs: 60_000 }
        );
        if (mergeRes.exitCode !== 0) {
          await runGit(["merge", "--abort"], { cwd: integrationLane.worktreePath, timeoutMs: 10_000 });
          conflictingLanes.push(step.laneId);
        } else {
          mergedCleanLanes.push(step.laneId);
        }
      } else if (step.outcome === "conflict") {
        conflictingLanes.push(step.laneId);
      }
    }

    // Build initial resolution state
    const stepResolutions: Record<string, IntegrationStepResolution> = {};
    for (const step of steps) {
      if (mergedCleanLanes.includes(step.laneId)) {
        stepResolutions[step.laneId] = "merged-clean";
      } else if (conflictingLanes.includes(step.laneId)) {
        stepResolutions[step.laneId] = "pending";
      }
    }

    const createdSnapshot = await readIntegrationLaneSnapshot(integrationLane.worktreePath);
    const resolutionState: IntegrationResolutionState = {
      integrationLaneId: integrationLane.id,
      stepResolutions,
      activeWorkerStepId: null,
      activeLaneId: null,
      createdSnapshot,
      currentSnapshot: createdSnapshot,
      laneChangeStatus: getIntegrationLaneChangeStatus(createdSnapshot, createdSnapshot),
      updatedAt: nowIso()
    };

    db.run(
      `update integration_proposals set integration_lane_id = ?, integration_lane_name = ?, resolution_state_json = ? where id = ?`,
      [integrationLane.id, integrationLane.name, JSON.stringify(resolutionState), args.proposalId]
    );

    return { integrationLaneId: integrationLane.id, mergedCleanLanes, conflictingLanes };
  };

  // B2: Start integration resolution — attempt merge, detect conflicts, return result for orchestrator
  const startIntegrationResolution = async (
    args: StartIntegrationResolutionArgs
  ): Promise<StartIntegrationResolutionResult> => {
    const proposalRow = db.get<{
      id: string; integration_lane_id: string | null; resolution_state_json: string | null;
      steps_json: string;
    }>(
      `select id, integration_lane_id, resolution_state_json, steps_json from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);
    if (!proposalRow.integration_lane_id) throw new Error("Integration lane not created yet. Call createIntegrationLaneForProposal first.");

    const integrationLaneId = String(proposalRow.integration_lane_id);
    const allLanes = await laneService.list({ includeArchived: false });
    const integrationLane = allLanes.find((l) => l.id === integrationLaneId);
    if (!integrationLane) throw new Error(`Integration lane not found: ${integrationLaneId}`);

    const sourceLane = allLanes.find((l) => l.id === args.laneId);
    if (!sourceLane) throw new Error(`Source lane not found: ${args.laneId}`);

    // Attempt merge
    const sourceBranch = branchNameFromRef(sourceLane.branchRef);
    const mergeRes = await runGit(
      ["merge", "--no-ff", "-m", `Merge ${sourceLane.name} into integration`, sourceBranch],
      { cwd: integrationLane.worktreePath, timeoutMs: 60_000 }
    );

    // If merge succeeded without conflicts, mark step as merged-clean and return
    if (mergeRes.exitCode === 0) {
      const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
        ? JSON.parse(String(proposalRow.resolution_state_json))
        : { integrationLaneId, stepResolutions: {}, activeWorkerStepId: null, activeLaneId: null, updatedAt: nowIso() };

      resolutionState.stepResolutions[args.laneId] = "merged-clean";
      resolutionState.updatedAt = nowIso();

      db.run(
        `update integration_proposals set resolution_state_json = ? where id = ?`,
        [JSON.stringify(resolutionState), args.proposalId]
      );

      logger.info("prs.integration_resolution.no_conflicts", {
        proposalId: args.proposalId,
        laneId: args.laneId,
        message: "Merge succeeded without conflicts; no AI resolution needed"
      });

      return { conflictFiles: [], integrationLaneId, mergedClean: true };
    }

    // Get conflicting files from git status
    const statusRes = await runGit(
      ["status", "--porcelain"],
      { cwd: integrationLane.worktreePath, timeoutMs: 10_000 }
    );
    if (statusRes.exitCode !== 0) {
      throw new Error(`git status failed in integration lane: ${statusRes.stderr.trim()}`);
    }
    const conflictFiles = parseGitStatusPorcelain(statusRes.stdout).unmergedPaths;

    // Abort the failed merge so the orchestrator worker can re-attempt in a controlled way
    await runGit(["merge", "--abort"], { cwd: integrationLane.worktreePath, timeoutMs: 10_000 });

    // Update resolution state — mark as pending, worker step will be set by orchestrator via markResolutionWorkerActive
    const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
      ? JSON.parse(String(proposalRow.resolution_state_json))
      : { integrationLaneId, stepResolutions: {}, activeWorkerStepId: null, activeLaneId: null, updatedAt: nowIso() };

    resolutionState.stepResolutions[args.laneId] = "pending";
    resolutionState.activeWorkerStepId = null;
    resolutionState.activeLaneId = args.laneId;
    resolutionState.updatedAt = nowIso();

    db.run(
      `update integration_proposals set resolution_state_json = ? where id = ?`,
      [JSON.stringify(resolutionState), args.proposalId]
    );

    logger.info("prs.integration_resolution.conflicts_detected", {
      proposalId: args.proposalId,
      laneId: args.laneId,
      conflictFileCount: conflictFiles.length,
      message: "Merge had conflicts; aborted merge, awaiting orchestrator worker"
    });

    return { conflictFiles, integrationLaneId, mergedClean: false };
  };

  // B3: Mark resolution worker active — called by orchestrator after spawning a worker
  const markResolutionWorkerActive = (proposalId: string, laneId: string, workerStepId: string): void => {
    const proposalRow = db.get<{
      id: string; resolution_state_json: string | null;
    }>(
      `select id, resolution_state_json from integration_proposals where id = ?`,
      [proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${proposalId}`);

    const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
      ? JSON.parse(String(proposalRow.resolution_state_json))
      : { integrationLaneId: "", stepResolutions: {}, activeWorkerStepId: null, activeLaneId: null, updatedAt: nowIso() };

    resolutionState.stepResolutions[laneId] = "resolving";
    resolutionState.activeWorkerStepId = workerStepId;
    resolutionState.activeLaneId = laneId;
    resolutionState.updatedAt = nowIso();

    db.run(
      `update integration_proposals set resolution_state_json = ? where id = ?`,
      [JSON.stringify(resolutionState), proposalId]
    );
  };

  // B4: Recheck integration step after resolution
  const recheckIntegrationStep = async (
    args: RecheckIntegrationStepArgs
  ): Promise<RecheckIntegrationStepResult> => {
    const proposalRow = db.get<{
      id: string; integration_lane_id: string | null; resolution_state_json: string | null;
      steps_json: string;
    }>(
      `select id, integration_lane_id, resolution_state_json, steps_json from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);
    if (!proposalRow.integration_lane_id) throw new Error("Integration lane not created yet");

    const integrationLaneId = String(proposalRow.integration_lane_id);
    const allLanes = await laneService.list({ includeArchived: false });
    const integrationLane = allLanes.find((l) => l.id === integrationLaneId);
    if (!integrationLane) throw new Error(`Integration lane not found: ${integrationLaneId}`);

    // Check git status for unmerged files
    const statusRes = await runGit(
      ["status", "--porcelain"],
      { cwd: integrationLane.worktreePath, timeoutMs: 10_000 }
    );
    if (statusRes.exitCode !== 0) {
      throw new Error(`git status failed in integration lane: ${statusRes.stderr.trim()}`);
    }
    const statusSnapshot = parseGitStatusPorcelain(statusRes.stdout);
    const conflictFiles = statusSnapshot.unmergedPaths;
    const conflictMarkerFiles = conflictFiles.length === 0
      ? readConflictMarkerFiles(integrationLane.worktreePath, statusSnapshot.changedPaths)
      : [];
    const remainingConflictFiles = conflictFiles.length > 0 ? conflictFiles : conflictMarkerFiles;

    const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
      ? JSON.parse(String(proposalRow.resolution_state_json))
      : { integrationLaneId, stepResolutions: {}, activeWorkerStepId: null, activeLaneId: null, updatedAt: nowIso() };

    let resolution: IntegrationStepResolution;
    let message: string | null = null;
    if (remainingConflictFiles.length === 0) {
      resolution = "resolved";
      resolutionState.stepResolutions[args.laneId] = "resolved";
      if (resolutionState.activeLaneId === args.laneId) {
        resolutionState.activeWorkerStepId = null;
        resolutionState.activeLaneId = null;
      }
    } else {
      resolution = "failed";
      resolutionState.stepResolutions[args.laneId] = "failed";
      if (resolutionState.activeLaneId === args.laneId) {
        resolutionState.activeWorkerStepId = null;
        resolutionState.activeLaneId = null;
      }
      message = conflictFiles.length > 0
        ? `Recheck failed: ${conflictFiles.length} unmerged file${conflictFiles.length === 1 ? "" : "s"} remain in the integration lane.`
        : `Recheck failed: merge conflict markers remain in ${conflictMarkerFiles.join(", ")}.`;
    }
    resolutionState.updatedAt = nowIso();

    // Check if all steps are resolved
    const steps = JSON.parse(String(proposalRow.steps_json)) as IntegrationProposalStep[];
    const allResolved = steps.every((step) => {
      const stepRes = resolutionState.stepResolutions[step.laneId];
      return stepRes === "merged-clean" || stepRes === "resolved";
    });

    // Update DB
    db.run(
      `update integration_proposals set resolution_state_json = ? where id = ?`,
      [JSON.stringify(resolutionState), args.proposalId]
    );

    if (allResolved) {
      db.run(`update integration_proposals set overall_outcome = 'clean' where id = ?`, [args.proposalId]);
    }

    return { resolution, remainingConflictFiles, allResolved, message };
  };

  // B5: Get integration resolution state
  const getIntegrationResolutionState = (proposalId: string): IntegrationResolutionState | null => {
    const row = db.get<{ resolution_state_json: string | null }>(
      `select resolution_state_json from integration_proposals where id = ?`,
      [proposalId]
    );
    if (!row?.resolution_state_json) return null;
    return JSON.parse(String(row.resolution_state_json)) as IntegrationResolutionState;
  };

  return {
    async createFromLane(args: CreatePrFromLaneArgs): Promise<PrSummary> {
      return await createFromLane(args);
    },

    async linkToLane(args: LinkPrToLaneArgs): Promise<PrSummary> {
      return await linkToLane(args);
    },

    getForLane(laneId: string): PrSummary | null {
      const row = getRowForLane(laneId);
      return row ? rowToSummary(row) : null;
    },

    listAll(): PrSummary[] {
      return listRows().map(rowToSummary);
    },

    async refresh(args: { prId?: string; prIds?: string[] } = {}): Promise<PrSummary[]> {
      const requestedPrIds = [
        ...(args.prId ? [args.prId] : []),
        ...((args.prIds ?? []).map((prId) => String(prId ?? "").trim()).filter(Boolean)),
      ];
      if (requestedPrIds.length > 0) {
        const refreshed: PrSummary[] = [];
        for (const prId of [...new Set(requestedPrIds)]) {
          refreshed.push(await refreshOne(prId));
        }
        return refreshed;
      }

      const rows = listRows();
      const nowMs = Date.now();
      const hotPrIds = new Set(getHotRefreshPrIds(nowMs));
      const staleCandidates = rows
        .filter((row) => !hotPrIds.has(row.id) && isBackgroundRefreshCandidate(row, nowMs))
        .sort(compareBackgroundRefreshPriority)
        .slice(0, BACKGROUND_REFRESH_MAX_PRS);
      const hotCandidates = rows
        .filter((row) => hotPrIds.has(row.id))
        .sort(compareBackgroundRefreshPriority);
      const candidates = [...hotCandidates, ...staleCandidates];
      const seenCandidateIds = new Set<string>();
      for (const row of candidates) {
        if (seenCandidateIds.has(row.id)) continue;
        seenCandidateIds.add(row.id);
        try {
          await refreshOne(row.id);
        } catch (error) {
          logger.warn("prs.refresh_failed", { prId: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }

      return listRows().map(rowToSummary);
    },

    markHotRefresh(prIds: string[]): void {
      markHotRefresh(prIds);
    },

    getHotRefreshDelayMs(): number | null {
      return getHotRefreshDelayMs();
    },

    getHotRefreshPrIds(): string[] {
      return getHotRefreshPrIds();
    },

    invalidateGithubSnapshot(): void {
      invalidateGithubSnapshotCache();
    },

    async getStatus(prId: string): Promise<PrStatus> {
      const row = getRow(prId);
      if (!row) throw new Error(`PR not found: ${prId}`);
      const status = await computeStatus(rowToSummary(row));
      upsertSnapshotRow({ prId, status });
      return status;
    },

    async getChecks(prId: string): Promise<PrCheck[]> {
      const checks = await getChecks(prId);
      upsertSnapshotRow({ prId, checks });
      return checks;
    },

    async getComments(prId: string): Promise<PrComment[]> {
      const comments = await getComments(prId);
      upsertSnapshotRow({ prId, comments });
      return comments;
    },

    async getReviews(prId: string): Promise<PrReview[]> {
      const reviews = await getReviews(prId);
      upsertSnapshotRow({ prId, reviews });
      return reviews;
    },

    async getReviewThreads(prId: string): Promise<PrReviewThread[]> {
      const row = requireRow(prId);
      const repo = repoFromRow(row);
      return await fetchReviewThreads(repo, Number(row.github_pr_number));
    },

    async updateDescription(args: UpdatePrDescriptionArgs): Promise<void> {
      return await updateDescription(args);
    },

    async delete(args: DeletePrArgs): Promise<DeletePrResult> {
      return await deletePr(args);
    },

    async draftDescription(args: DraftPrDescriptionArgs): Promise<{ title: string; body: string }> {
      return await draftDescription(args);
    },

    async land(args: LandPrArgs): Promise<LandResult> {
      return await land(args);
    },

    async landStack(args: LandStackArgs): Promise<LandResult[]> {
      return await landStack(args);
    },

    async openInGitHub(prId: string): Promise<void> {
      const row = getRow(prId);
      if (!row) throw new Error(`PR not found: ${prId}`);
      await openExternal(row.github_url);
    },

    async createQueuePrs(args: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> {
      return await createQueuePrs(args);
    },

    async createIntegrationPr(args: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> {
      return await createIntegrationPr(args);
    },

    async createIntegrationLane(args: {
      sourceLaneIds: string[];
      integrationLaneName: string;
      baseBranch: string;
      description?: string;
      allowDirtyWorktree?: boolean;
      missionId?: string | null;
      laneRole?: "mission_root" | "worker" | "integration" | "result" | null;
    }): Promise<{
      integrationLane: LaneSummary;
      mergeResults: Array<{ laneId: string; success: boolean; error?: string }>;
    }> {
      return await createIntegrationLane(args);
    },

    async simulateIntegration(args: SimulateIntegrationArgs): Promise<IntegrationProposal> {
      return await simulateIntegration(args);
    },

    async commitIntegration(args: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> {
      return await commitIntegration(args);
    },

    async landStackEnhanced(args: LandStackEnhancedArgs): Promise<LandResult[]> {
      return await landStackEnhanced(args);
    },

    async landQueueNext(args: LandQueueNextArgs): Promise<LandResult> {
      return await landQueueNext(args);
    },

    async reorderQueuePrs(args: ReorderQueuePrsArgs): Promise<void> {
      return await reorderQueuePrs(args);
    },

    async getPrHealth(prId: string): Promise<PrHealth> {
      return await getPrHealth(prId);
    },

    async getQueueState(groupId: string): Promise<QueueLandingState | null> {
      return await getQueueState(groupId);
    },

    async listGroupPrs(groupId: string): Promise<PrSummary[]> {
      return await listGroupPrs(groupId);
    },

    async getConflictAnalysis(prId: string): Promise<PrConflictAnalysis> {
      return await getConflictAnalysis(prId);
    },

    async getMergeContext(prId: string): Promise<PrMergeContext> {
      return await getMergeContext(prId);
    },

    async listWithConflicts(): Promise<PrWithConflicts[]> {
      return await listWithConflicts();
    },

    async getGithubSnapshot(options?: { force?: boolean }): Promise<GitHubPrSnapshot> {
      return await getGithubSnapshot(options);
    },

    async listIntegrationProposals(): Promise<IntegrationProposal[]> {
      return await listIntegrationProposals();
    },

    async listIntegrationWorkflows(args: ListIntegrationWorkflowsArgs = {}): Promise<IntegrationProposal[]> {
      return await listIntegrationWorkflows(args);
    },

    updateIntegrationProposal(args: UpdateIntegrationProposalArgs): void {
      return updateIntegrationProposal(args);
    },

    async deleteIntegrationProposal(args: DeleteIntegrationProposalArgs): Promise<DeleteIntegrationProposalResult> {
      return await deleteIntegrationProposal(args);
    },

    async dismissIntegrationCleanup(args: DismissIntegrationCleanupArgs): Promise<IntegrationProposal> {
      return await dismissIntegrationCleanup(args);
    },

    async cleanupIntegrationWorkflow(args: CleanupIntegrationWorkflowArgs): Promise<CleanupIntegrationWorkflowResult> {
      return await cleanupIntegrationWorkflow(args);
    },

    async createIntegrationLaneForProposal(args: CreateIntegrationLaneForProposalArgs): Promise<CreateIntegrationLaneForProposalResult> {
      return await createIntegrationLaneForProposal(args);
    },

    async startIntegrationResolution(args: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult> {
      return await startIntegrationResolution(args);
    },

    getIntegrationResolutionState(proposalId: string): IntegrationResolutionState | null {
      return getIntegrationResolutionState(proposalId);
    },

    async recheckIntegrationStep(args: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult> {
      return await recheckIntegrationStep(args);
    },

    markResolutionWorkerActive(proposalId: string, laneId: string, workerStepId: string): void {
      return markResolutionWorkerActive(proposalId, laneId, workerStepId);
    },

    setAgentChatService(_svc: ReturnType<typeof createAgentChatService>): void {
      // Reserved for future PR<->chat linking.
    },

    async refreshSnapshots(args: { prId?: string } = {}): Promise<{ refreshedCount: number }> {
      const rows = args.prId ? [requireRow(args.prId)] : listRows();
      for (const row of rows) {
        await refreshSnapshotData(row.id);
      }
      return { refreshedCount: rows.length };
    },

    listSnapshots(args: { prId?: string } = {}): PullRequestSnapshotHydration[] {
      return listSnapshotRows(args);
    },

    // ------------------------------------------------------------------
    // PR Detail Overhaul Methods
    // ------------------------------------------------------------------

    async getDetail(prId: string): Promise<PrDetail> {
      const detail = await getDetailSnapshot(prId);
      upsertSnapshotRow({ prId, detail });
      return detail;
    },

    async getFiles(prId: string): Promise<PrFile[]> {
      const files = await getFilesSnapshot(prId);
      upsertSnapshotRow({ prId, files });
      return files;
    },

    async getActionRuns(prId: string): Promise<PrActionRun[]> {
      const row = requireRow(prId);
      const repo = repoFromRow(row);
      const pr = await fetchPr(repo, Number(row.github_pr_number));
      const headSha = asString(pr?.head?.sha);
      if (!headSha) return [];

      const { data: runsData } = await githubService.apiRequest<any>({
        method: "GET",
        path: `/repos/${repo.owner}/${repo.name}/actions/runs`,
        query: { head_sha: headSha, per_page: 100 }
      });
      const rawRuns: any[] = Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs : [];

      const runs: PrActionRun[] = await Promise.all(
        rawRuns.map(async (run: any): Promise<PrActionRun> => {
          const runId = Number(run?.id);
          let jobs: PrActionJob[] = [];
          try {
            const { data: jobsData } = await githubService.apiRequest<any>({
              method: "GET",
              path: `/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/jobs`
            });
            const rawJobs: any[] = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
            jobs = rawJobs.map((j: any): PrActionJob => ({
              id: Number(j?.id) || 0,
              name: asString(j?.name) || "",
              status: toJobStatus(j?.status),
              conclusion: toJobConclusion(j?.conclusion),
              startedAt: asString(j?.started_at) || null,
              completedAt: asString(j?.completed_at) || null,
              steps: Array.isArray(j?.steps)
                ? j.steps.map((st: any): PrActionStep => ({
                    name: asString(st?.name) || "",
                    status: toJobStatus(st?.status),
                    conclusion: toJobConclusion(st?.conclusion),
                    number: Number(st?.number) || 0,
                    startedAt: asString(st?.started_at) || null,
                    completedAt: asString(st?.completed_at) || null
                  }))
                : []
            }));
          } catch {
            // Jobs fetch failed; return empty jobs array
          }
          return {
            id: runId,
            name: asString(run?.name) || "",
            status: toRunStatus(run?.status),
            conclusion: toRunConclusion(run?.conclusion),
            headSha,
            htmlUrl: asString(run?.html_url) || "",
            createdAt: asString(run?.created_at) || "",
            updatedAt: asString(run?.updated_at) || "",
            jobs
          };
        })
      );
      return runs;
    },

    async getActivity(prId: string): Promise<PrActivityEvent[]> {
      const row = requireRow(prId);
      const repo = repoFromRow(row);
      const prNumber = Number(row.github_pr_number);

      const [comments, reviews, checks, timelineEvents] = await Promise.all([
        getComments(prId).catch(() => [] as PrComment[]),
        getReviews(prId).catch(() => [] as PrReview[]),
        getChecks(prId).catch(() => [] as PrCheck[]),
        fetchAllPages<any>({
          path: `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/timeline`
        }).catch(() => [] as any[])
      ]);

      const events: PrActivityEvent[] = [];
      const seenIds = new Set<string>();

      for (const c of comments) {
        const id = `comment-${c.id}`;
        seenIds.add(id);
        events.push({
          id,
          type: "comment",
          author: c.author,
          avatarUrl: c.authorAvatarUrl || null,
          body: c.body,
          timestamp: c.createdAt || "",
          metadata: { source: c.source, path: c.path, line: c.line, url: c.url }
        });
      }

      for (const r of reviews) {
        const id = `review-${r.reviewer}-${r.submittedAt || ""}`;
        seenIds.add(id);
        events.push({
          id,
          type: "review",
          author: r.reviewer,
          avatarUrl: r.reviewerAvatarUrl || null,
          body: r.body,
          timestamp: r.submittedAt || "",
          metadata: { state: r.state }
        });
      }

      for (const ch of checks) {
        const id = `ci-${ch.name}`;
        seenIds.add(id);
        events.push({
          id,
          type: "ci_run",
          author: "github-actions",
          avatarUrl: null,
          body: `${ch.name}: ${ch.conclusion ?? ch.status}`,
          timestamp: ch.startedAt || ch.completedAt || "",
          metadata: {
            status: ch.status,
            conclusion: ch.conclusion,
            detailsUrl: ch.detailsUrl
          }
        });
      }

      // Process GitHub timeline events for deployments, force-pushes, commits, etc.
      for (const entry of timelineEvents) {
        const eventType = asString(entry?.event);
        const nodeId = asString(entry?.node_id || entry?.id);
        if (!eventType || !nodeId) continue;

        if (eventType === "deployed") {
          const id = `deploy-${nodeId}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const env = asString(entry?.deployment?.environment)
            || asString(entry?.deployment_environment)
            || asString(entry?.environment);
          const creator = asString(entry?.actor?.login)
            || asString(entry?.performed_via_github_app?.name)
            || asString(entry?.deployment?.creator?.login);
          events.push({
            id,
            type: "deployment",
            author: creator || "github-actions",
            avatarUrl: asString(entry?.actor?.avatar_url) || asString(entry?.deployment?.creator?.avatar_url) || null,
            body: env ? `Deployed to **${env}**` : "Deployed",
            timestamp: asString(entry?.created_at) || asString(entry?.deployment?.created_at) || "",
            metadata: {
              environment: env,
              url: asString(entry?.deployment?.url) || null,
              statusesUrl: asString(entry?.deployment?.statuses_url) || null,
            }
          });
        } else if (eventType === "head_ref_force_pushed") {
          const id = `force-push-${nodeId}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const actor = asString(entry?.actor?.login);
          const beforeSha = asString(entry?.before_commit_sha).slice(0, 7);
          const afterSha = asString(entry?.after_commit_sha).slice(0, 7);
          events.push({
            id,
            type: "force_push",
            author: actor || "unknown",
            avatarUrl: asString(entry?.actor?.avatar_url) || null,
            body: beforeSha && afterSha
              ? `Force-pushed branch from ${beforeSha} to ${afterSha}`
              : "Force-pushed branch",
            timestamp: asString(entry?.created_at) || "",
            metadata: {
              beforeSha: asString(entry?.before_commit_sha),
              afterSha: asString(entry?.after_commit_sha),
            }
          });
        } else if (eventType === "committed") {
          const sha = asString(entry?.sha).slice(0, 7);
          const id = `commit-${sha || nodeId}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          events.push({
            id,
            type: "commit",
            author: asString(entry?.author?.name || entry?.committer?.name) || "unknown",
            avatarUrl: null,
            body: asString(entry?.message?.split("\n")[0]),
            timestamp: asString(entry?.author?.date || entry?.committer?.date) || "",
            metadata: {
              sha: asString(entry?.sha),
              shortSha: sha,
              url: asString(entry?.html_url),
            }
          });
        } else if (eventType === "labeled" || eventType === "unlabeled") {
          const id = `label-${nodeId}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const labelName = asString(entry?.label?.name);
          events.push({
            id,
            type: "label",
            author: asString(entry?.actor?.login) || "unknown",
            avatarUrl: asString(entry?.actor?.avatar_url) || null,
            body: `${eventType === "labeled" ? "Added" : "Removed"} label: ${labelName}`,
            timestamp: asString(entry?.created_at) || "",
            metadata: {
              action: eventType,
              label: labelName,
              color: asString(entry?.label?.color),
            }
          });
        } else if (eventType === "review_requested") {
          const id = `review-req-${nodeId}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const reviewer = asString(entry?.requested_reviewer?.login);
          events.push({
            id,
            type: "review_request",
            author: asString(entry?.actor?.login) || "unknown",
            avatarUrl: asString(entry?.actor?.avatar_url) || null,
            body: reviewer ? `Requested review from ${reviewer}` : "Requested a review",
            timestamp: asString(entry?.created_at) || "",
            metadata: { reviewer }
          });
        }
      }

      // Sort descending by timestamp
      events.sort((a, b) => {
        const aTs = a.timestamp ? Date.parse(a.timestamp) : 0;
        const bTs = b.timestamp ? Date.parse(b.timestamp) : 0;
        return bTs - aTs;
      });

      return events;
    },

    async addComment(args: AddPrCommentArgs): Promise<PrComment> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      const { data } = await githubService.apiRequest<any>({
        method: "POST",
        path: `/repos/${repo.owner}/${repo.name}/issues/${Number(row.github_pr_number)}/comments`,
        body: { body: args.body }
      });
      const comment: PrComment = {
        id: String(data?.id ?? ""),
        author: asString(data?.user?.login) || "",
        authorAvatarUrl: asString(data?.user?.avatar_url) || null,
        body: asString(data?.body) || null,
        source: "issue",
        url: asString(data?.html_url) || null,
        path: null,
        line: null,
        createdAt: asString(data?.created_at) || null,
        updatedAt: asString(data?.updated_at) || null
      };
      return comment;
    },

    async replyToReviewThread(args: ReplyToPrReviewThreadArgs): Promise<PrReviewThreadComment> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      const threads = await fetchReviewThreads(repo, Number(row.github_pr_number));
      if (!threads.some((t) => t.id === args.threadId)) {
        throw new Error(`Thread ${args.threadId} does not belong to PR ${args.prId}`);
      }
      const data = await graphqlRequest<{
        addPullRequestReviewThreadReply?: {
          comment?: {
            id?: unknown;
            body?: unknown;
            url?: unknown;
            createdAt?: unknown;
            updatedAt?: unknown;
            author?: {
              login?: unknown;
              avatarUrl?: unknown;
            } | null;
          } | null;
        } | null;
      }>(
        `
          mutation AdeReplyToReviewThread($threadId: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
              comment {
                id
                body
                url
                createdAt
                updatedAt
                author {
                  login
                  avatarUrl
                }
              }
            }
          }
        `,
        {
          threadId: args.threadId,
          body: args.body,
        },
      );

      const comment = data.addPullRequestReviewThreadReply?.comment;
      if (!comment) {
        throw new Error("GitHub did not return the review-thread reply.");
      }
      return {
        id: asString(comment.id) || String(randomUUID()),
        author: asString(comment.author?.login) || "unknown",
        authorAvatarUrl: asString(comment.author?.avatarUrl) || null,
        body: asString(comment.body) || null,
        url: asString(comment.url) || null,
        createdAt: asString(comment.createdAt) || null,
        updatedAt: asString(comment.updatedAt) || null,
      };
    },

    async resolveReviewThread(args: ResolvePrReviewThreadArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      const threads = await fetchReviewThreads(repo, Number(row.github_pr_number));
      if (!threads.some((t) => t.id === args.threadId)) {
        throw new Error(`Thread ${args.threadId} does not belong to PR ${args.prId}`);
      }
      await graphqlRequest(
        `
          mutation AdeResolveReviewThread($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread {
                id
                isResolved
              }
            }
          }
        `,
        { threadId: args.threadId },
      );
    },

    async updateTitle(args: UpdatePrTitleArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "PATCH",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
        body: { title: args.title }
      });
      await refreshOne(args.prId);
    },

    async updateBody(args: UpdatePrBodyArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "PATCH",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
        body: { body: args.body }
      });
      await refreshOne(args.prId);
    },

    async setLabels(args: SetPrLabelsArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "PUT",
        path: `/repos/${repo.owner}/${repo.name}/issues/${Number(row.github_pr_number)}/labels`,
        body: { labels: args.labels }
      });
      await refreshOne(args.prId);
    },

    async requestReviewers(args: RequestPrReviewersArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "POST",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}/requested_reviewers`,
        body: { reviewers: args.reviewers }
      });
      markHotRefresh([args.prId]);
      await refreshOne(args.prId);
    },

    async submitReview(args: SubmitPrReviewArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "POST",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}/reviews`,
        body: { event: args.event, body: args.body ?? "" }
      });
      markHotRefresh([args.prId]);
      await refreshOne(args.prId);
    },

    async closePr(args: ClosePrArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "PATCH",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
        body: { state: "closed" }
      });
      db.run(
        `update pull_requests set state = ?, updated_at = ? where id = ? and project_id = ?`,
        ["closed", nowIso(), row.id, projectId]
      );
      markHotRefresh([args.prId]);
      await refreshOne(args.prId);
    },

    async reopenPr(args: ReopenPrArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      await githubService.apiRequest({
        method: "PATCH",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}`,
        body: { state: "open" }
      });
      db.run(
        `update pull_requests set state = ?, updated_at = ? where id = ? and project_id = ?`,
        ["open", nowIso(), row.id, projectId]
      );
      markHotRefresh([args.prId]);
      await refreshOne(args.prId);
    },

    async rerunChecks(args: RerunPrChecksArgs): Promise<void> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);

      if (args.checkRunIds?.length) {
        // Rerun specific check runs
        for (const crId of args.checkRunIds) {
          await githubService.apiRequest({
            method: "POST",
            path: `/repos/${repo.owner}/${repo.name}/check-runs/${crId}/rerequest`,
            body: {}
          });
        }
      } else {
        // Rerun all failed runs: get action runs and rerun failed ones
        const pr = await fetchPr(repo, Number(row.github_pr_number));
        const headSha = asString(pr?.head?.sha);
        if (!headSha) return;
        const { data: runsData } = await githubService.apiRequest<any>({
          method: "GET",
          path: `/repos/${repo.owner}/${repo.name}/actions/runs`,
          query: { head_sha: headSha, per_page: 100 }
        });
        const rawRuns: any[] = Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs : [];
        for (const run of rawRuns) {
          const conclusion = asString(run?.conclusion).toLowerCase();
          if (conclusion === "failure" || conclusion === "timed_out") {
            try {
              await githubService.apiRequest({
                method: "POST",
                path: `/repos/${repo.owner}/${repo.name}/actions/runs/${Number(run.id)}/rerun-failed-jobs`,
                body: {}
              });
            } catch {
              // Best-effort: some runs may not be rerunnable
            }
          }
        }
      }
      markHotRefresh([args.prId]);
      await refreshOne(args.prId);
    },

    async aiReviewSummary(args: AiReviewSummaryArgs): Promise<AiReviewSummary> {
      const row = requireRow(args.prId);
      const repo = repoFromRow(row);
      let files: PrFile[] = [];
      try {
        const data = await fetchAllPages<any>({
          path: `/repos/${repo.owner}/${repo.name}/pulls/${Number(row.github_pr_number)}/files`
        });
        files = data.map((f: any) => ({
          filename: asString(f?.filename) || "",
          status: toFileStatus(f?.status),
          additions: Number(f?.additions) || 0,
          deletions: Number(f?.deletions) || 0,
          patch: asString(f?.patch) || null,
          previousFilename: asString(f?.previous_filename) || null
        }));
      } catch {
        // Continue without files
      }

      if (aiIntegrationService) {
        const diffSummary = files
          .map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`)
          .join("\n");

        const prompt = [
          "You are a code reviewer. Analyze the following PR changes and return a JSON object with this exact shape:",
          '{"summary": string, "potentialIssues": string[], "recommendations": string[], "mergeReadiness": "ready" | "needs_work" | "blocked"}',
          "",
          `PR Title: ${row.title ?? "Untitled"}`,
          "",
          "Changed files:",
          diffSummary || "(no files)",
          "",
          "Patches:",
          ...files.slice(0, 10).map((f) => `--- ${f.filename} ---\n${f.patch ?? "(binary or too large)"}`),
          "",
          "Return ONLY the JSON object, no markdown."
        ].join("\n");

        try {
          const draft = await aiIntegrationService.draftPrDescription({
            laneId: row.lane_id,
            cwd: projectRoot,
            prompt,
            ...(args.model ? { model: args.model } : {})
          });
          const rawJson = extractFirstJsonObject(draft.text);
          if (rawJson) {
            const obj = JSON.parse(rawJson) as Record<string, unknown>;
            return {
              summary: typeof obj.summary === "string" ? obj.summary : "AI review completed.",
              potentialIssues: Array.isArray(obj.potentialIssues)
                ? obj.potentialIssues.filter((i): i is string => typeof i === "string")
                : [],
              recommendations: Array.isArray(obj.recommendations)
                ? obj.recommendations.filter((r): r is string => typeof r === "string")
                : [],
              mergeReadiness:
                obj.mergeReadiness === "ready" || obj.mergeReadiness === "needs_work" || obj.mergeReadiness === "blocked"
                  ? obj.mergeReadiness
                  : "needs_work"
            };
          }
        } catch (error) {
          logger.warn("prs.ai_review_summary_failed", {
            prId: args.prId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Fallback: return a basic summary based on file stats
      const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
      const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
      return {
        summary: `This PR modifies ${files.length} file(s) with +${totalAdditions}/-${totalDeletions} changes.`,
        potentialIssues: [],
        recommendations: ["Review the changes manually for a detailed assessment."],
        mergeReadiness: "needs_work"
      };
    }
  };
}
