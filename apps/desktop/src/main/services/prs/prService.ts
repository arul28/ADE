import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreatePrFromLaneArgs,
  CreateQueuePrsArgs,
  CreateQueuePrsResult,
  CreateStackedPrsArgs,
  CreateStackedPrsResult,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  CreateIntegrationLaneForProposalArgs,
  CreateIntegrationLaneForProposalResult,
  CommitIntegrationArgs,
  DeletePrArgs,
  DeletePrResult,
  GitHubRepoRef,
  IntegrationProposal,
  IntegrationProposalStep,
  IntegrationResolutionState,
  IntegrationStepResolution,
  LandResult,
  LandPrArgs,
  LandQueueNextArgs,
  LandStackArgs,
  LandStackEnhancedArgs,
  LaneSummary,
  LinkPrToLaneArgs,
  MergeMethod,
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
  RecheckIntegrationStepArgs,
  RecheckIntegrationStepResult,
  SimulateIntegrationArgs,
  StartIntegrationResolutionArgs,
  StartIntegrationResolutionResult,
  UpdateIntegrationProposalArgs,
  UpdatePrDescriptionArgs
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";
import type { createGithubService } from "../github/githubService";
import type { createPackService } from "../packs/packService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createAgentChatService } from "../chat/agentChatService";
import { runGit, runGitOrThrow } from "../git/git";

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

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function branchNameFromRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length);
  return trimmed;
}

function normalizeBranchName(ref: string): string {
  const branch = branchNameFromRef(ref);
  if (branch.startsWith("origin/")) return branch.slice("origin/".length);
  return branch;
}

function normalizeGroupMemberRole(raw: string): PrGroupMemberRole {
  if (raw === "source" || raw === "integration" || raw === "target") return raw;
  return "source";
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

function extractFirstJsonObject(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1).trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  return null;
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

export function createPrService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  operationService,
  githubService,
  packService,
  aiIntegrationService,
  projectConfigService,
  conflictService,
  openExternal
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  operationService: ReturnType<typeof createOperationService>;
  githubService: ReturnType<typeof createGithubService>;
  packService: ReturnType<typeof createPackService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  conflictService?: ReturnType<typeof createConflictService>;
  openExternal: (url: string) => Promise<void>;
}) {
  let agentChatService: ReturnType<typeof createAgentChatService> | undefined;
  const getRow = (prId: string): PullRequestRow | null =>
    db.get<PullRequestRow>(
      `
        select
          id,
          lane_id,
          project_id,
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
        from pull_requests
        where id = ?
          and project_id = ?
        limit 1
      `,
      [prId, projectId]
    );

  const getRowForLane = (laneId: string): PullRequestRow | null =>
    db.get<PullRequestRow>(
      `
        select
          id,
          lane_id,
          project_id,
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
        from pull_requests
        where lane_id = ?
          and project_id = ?
        limit 1
      `,
      [laneId, projectId]
    );

  const listRows = (): PullRequestRow[] =>
    db.all<PullRequestRow>(
      `
        select
          id,
          lane_id,
          project_id,
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
        from pull_requests
        where project_id = ?
        order by updated_at desc
      `,
      [projectId]
    );

  const upsertRow = (summary: Omit<PrSummary, "projectId"> & { projectId?: string }): void => {
    const now = nowIso();
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
        on conflict(project_id, lane_id) do update set
          repo_owner = excluded.repo_owner,
          repo_name = excluded.repo_name,
          github_pr_number = excluded.github_pr_number,
          github_url = excluded.github_url,
          github_node_id = excluded.github_node_id,
          title = excluded.title,
          state = excluded.state,
          base_branch = excluded.base_branch,
          head_branch = excluded.head_branch,
          checks_status = excluded.checks_status,
          review_status = excluded.review_status,
          additions = excluded.additions,
          deletions = excluded.deletions,
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at
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

  const fetchPr = async (repo: GitHubRepoRef, prNumber: number): Promise<any> => {
    const { data } = await githubService.apiRequest<any>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`
    });
    return data;
  };

  const fetchReviews = async (repo: GitHubRepoRef, prNumber: number): Promise<PrReview[]> => {
    const { data } = await githubService.apiRequest<any[]>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`,
      query: { per_page: 100 }
    });

    return (data ?? []).map((entry: any) => ({
      reviewer: asString(entry?.user?.login) || "unknown",
      state: (asString(entry?.state).toLowerCase() === "approved"
        ? "approved"
        : asString(entry?.state).toLowerCase() === "changes_requested"
          ? "changes_requested"
          : asString(entry?.state).toLowerCase() === "dismissed"
            ? "dismissed"
            : "commented") as PrReview["state"],
      body: asString(entry?.body) || null,
      submittedAt: asString(entry?.submitted_at) || null
    }));
  };

  const fetchIssueComments = async (repo: GitHubRepoRef, prNumber: number): Promise<PrComment[]> => {
    const { data } = await githubService.apiRequest<any[]>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/issues/${prNumber}/comments`,
      query: { per_page: 100 }
    });

    return (data ?? []).map((entry: any) => ({
      id: `issue:${asString(entry?.node_id) || String(entry?.id ?? randomUUID())}`,
      author: asString(entry?.user?.login) || "unknown",
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
    const { data } = await githubService.apiRequest<any[]>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`,
      query: { per_page: 100 }
    });

    return (data ?? []).map((entry: any) => ({
      id: `review:${asString(entry?.node_id) || String(entry?.id ?? randomUUID())}`,
      author: asString(entry?.user?.login) || "unknown",
      body: asString(entry?.body) || null,
      source: "review",
      url: asString(entry?.html_url) || null,
      path: asString(entry?.path) || null,
      line: Number.isFinite(Number(entry?.line)) ? Number(entry?.line) : null,
      createdAt: asString(entry?.created_at) || null,
      updatedAt: asString(entry?.updated_at) || null
    }));
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
    const runs = Array.isArray(data?.check_runs) ? data.check_runs : [];
    return runs;
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
    const baseSha = asString(pr?.base?.sha);
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
      updatedAt: nowIso()
    };

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
      const statusRaw = asString(run?.status).toLowerCase();
      const status: PrCheck["status"] =
        statusRaw === "queued" ? "queued" : statusRaw === "in_progress" ? "in_progress" : "completed";
      const conclusionRaw = asString(run?.conclusion).toLowerCase();
      const conclusion: PrCheck["conclusion"] =
        conclusionRaw === "success"
          ? "success"
          : conclusionRaw === "failure" || conclusionRaw === "timed_out" || conclusionRaw === "action_required"
            ? "failure"
            : conclusionRaw === "neutral"
              ? "neutral"
              : conclusionRaw === "skipped"
                ? "skipped"
                : conclusionRaw === "cancelled"
                  ? "cancelled"
                  : null;
      out.push({
        name,
        status,
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

  const draftDescription = async (laneId: string, model?: string): Promise<{ title: string; body: string }> => {
    const lane = (await laneService.list({ includeArchived: true })).find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);

    const template = readPrTemplate(projectRoot);
    const packBody = await (async () => {
      // Use a bounded lane export for AI providers (keeps payload compact + deterministic, and avoids feeding prior narrative).
      try {
        return (await packService.getLaneExport({ laneId, level: "standard" })).content;
      } catch {
        return packService.getLanePack(laneId).body;
      }
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
          ...(model ? { model } : {})
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

    const repo = await githubService.getRepoOrThrow();
    const headBranch = branchNameFromRef(lane.branchRef);
    const parentLane = lane.parentLaneId ? allLanes.find((entry) => entry.id === lane.parentLaneId) ?? null : null;
    const primaryLane = allLanes.find((entry) => entry.laneType === "primary") ?? null;
    const inferredBaseRef = parentLane?.branchRef ?? (lane.parentLaneId ? lane.baseRef : (primaryLane?.branchRef ?? lane.baseRef));
    const baseBranch = (args.baseBranch ?? branchNameFromRef(inferredBaseRef)).trim();

    // Push the branch to remote before creating the PR
    const upstreamCheck = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: lane.worktreePath, timeoutMs: 10_000 }
    );
    if (upstreamCheck.exitCode === 0) {
      await runGitOrThrow(["push"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
    } else {
      await runGitOrThrow(["push", "-u", "origin", headBranch], { cwd: lane.worktreePath, timeoutMs: 60_000 });
    }

    const createdAt = nowIso();
    const created = await githubService.apiRequest<any>({
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
      const headBranch = row.head_branch;
      let branchDeleted = false;
      try {
        await githubService.apiRequest({
          method: "DELETE",
          path: `/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(headBranch)}`
        });
        branchDeleted = true;
      } catch (error) {
        logger.warn("prs.delete_branch_failed", { prId: row.id, headBranch, error: error instanceof Error ? error.message : String(error) });
      }

      await laneService.archive({ laneId: row.lane_id });

      operationService.finish({
        operationId: op.operationId,
        status: "succeeded",
        metadataPatch: { mergeCommitSha, branchDeleted }
      });

      await refreshOne(row.id).catch(() => {});

      return {
        prId: row.id,
        prNumber: Number(row.github_pr_number),
        success: true,
        mergeCommitSha,
        branchDeleted,
        laneArchived: true,
        error: null
      };
    } catch (error) {
      operationService.finish({
        operationId: op.operationId,
        status: "failed",
        metadataPatch: { error: error instanceof Error ? error.message : String(error) }
      });
      return {
        prId: row.id,
        prNumber: Number(row.github_pr_number),
        success: false,
        mergeCommitSha: null,
        branchDeleted: false,
        laneArchived: false,
        error: error instanceof Error ? error.message : String(error)
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

    db.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at) values (?, ?, 'queue', ?, ?, ?, ?, ?)`,
      [groupId, projectId, args.queueName ?? null, args.autoRebase ? 1 : 0, args.ciGating ? 1 : 0, args.targetBranch, now]
    );

    const lanes = await laneService.list({ includeArchived: false });
    const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));

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
          baseBranch: args.targetBranch
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

  /** @deprecated Use createQueuePrs */
  const createStackedPrs = createQueuePrs;

  const createIntegrationPr = async (args: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> => {
    if (!args.sourceLaneIds.length) throw new Error("At least one source lane is required");
    const groupId = randomUUID();
    const now = nowIso();

    // Track resources created during this operation for cleanup on failure.
    let groupInserted = false;
    let integrationLane: LaneSummary | null = null;

    try {
      db.run(
        `insert into pr_groups(id, project_id, group_type, created_at) values (?, ?, 'integration', ?)`,
        [groupId, projectId, now]
      );
      groupInserted = true;

      integrationLane = await laneService.createChild({
        parentLaneId: (await laneService.list({ includeArchived: false })).find((lane) => {
          const base = branchNameFromRef(lane.branchRef);
          return base === args.baseBranch || lane.baseRef === args.baseBranch;
        })?.id ?? args.sourceLaneIds[0]!,
        name: args.integrationLaneName,
        description: `Integration lane for merging: ${args.sourceLaneIds.join(", ")}`
      });

      const mergeResults: Array<{ laneId: string; success: boolean; error?: string }> = [];
      const lanes = await laneService.list({ includeArchived: false });
      const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));

      for (const sourceLaneId of args.sourceLaneIds) {
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
        baseBranch: args.baseBranch
      });

      const integrationMemberId = randomUUID();
      db.run(
        `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, 0, 'integration')`,
        [integrationMemberId, groupId, pr.id, integrationLane.id]
      );

      for (let i = 0; i < args.sourceLaneIds.length; i++) {
        const memberId = randomUUID();
        db.run(
          `insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, 'source')`,
          [memberId, groupId, pr.id, args.sourceLaneIds[i]!, i + 1]
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
      // Archive the integration lane if we created one (best-effort; deletion
      // could fail if the worktree has uncommitted state, so archive is safer).
      if (integrationLane) {
        try {
          laneService.archive({ laneId: integrationLane.id });
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

    const results: LandResult[] = [];
    const landPromises: Promise<LandResult>[] = [];

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
        continue;
      }

      if (row.base_branch !== baseTarget) {
        await retargetBase(row.id, baseTarget).catch((error) => {
          logger.warn("prs.retarget_failed", { prId: row.id, error: error instanceof Error ? error.message : String(error) });
        });
      }

      landPromises.push(land({ prId: row.id, method: args.method }));
    }

    const settled = await Promise.allSettled(landPromises);
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          prId: "",
          prNumber: 0,
          success: false,
          mergeCommitSha: null,
          branchDeleted: false,
          laneArchived: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
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
      if (byBranch) return byBranch.id;
      const byBase = lanes.find((lane) => normalizeBranchName(lane.baseRef) === normalized);
      return byBase?.id ?? null;
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

    if (!group) {
      return {
        prId,
        groupId: null,
        groupType: null,
        sourceLaneIds: [fallbackSourceLaneId],
        targetLaneId: fallbackTargetLaneId,
        members: fallbackMembers
      };
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
      prId,
      groupId: group.group_id,
      groupType,
      sourceLaneIds: sourceLaneIds.length > 0 ? sourceLaneIds : [fallbackSourceLaneId],
      targetLaneId: integrationLaneId ?? fallbackTargetLaneId,
      members: members.length > 0 ? members : fallbackMembers
    };
  };

  const extractConflictDetail = async (
    treeOid: string,
    filePath: string,
    cwd: string
  ): Promise<{ conflictMarkers: string; oursExcerpt: string; theirsExcerpt: string; diffHunk: string }> => {
    try {
      const result = await runGit(
        ["show", `${treeOid}:${filePath}`],
        { cwd, timeoutMs: 10_000 }
      );
      const content = result.stdout;
      if (!content.includes("<<<<<<<")) {
        return { conflictMarkers: "", oursExcerpt: "", theirsExcerpt: "", diffHunk: "" };
      }

      // Extract conflict markers and excerpts
      const markerRegex = /(<<<<<<<[^\n]*\n)([\s\S]*?)(=======\n)([\s\S]*?)(>>>>>>>[^\n]*)/g;
      const markers: string[] = [];
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = markerRegex.exec(content)) !== null) {
        markers.push(match[0]);
        oursLines.push(match[2]!.trim());
        theirsLines.push(match[4]!.trim());
      }

      const conflictMarkers = markers.join("\n---\n").slice(0, 2000);
      const oursExcerpt = oursLines.join("\n---\n").slice(0, 500);
      const theirsExcerpt = theirsLines.join("\n---\n").slice(0, 500);

      // Build a simple diff hunk preview
      const diffHunk = markers.map((m) => m.split("\n").slice(0, 12).join("\n")).join("\n...\n").slice(0, 500);

      return { conflictMarkers, oursExcerpt, theirsExcerpt, diffHunk };
    } catch {
      return { conflictMarkers: "", oursExcerpt: "", theirsExcerpt: "", diffHunk: "" };
    }
  };

  const simulateIntegration = async (args: SimulateIntegrationArgs): Promise<IntegrationProposal> => {
    const proposalId = randomUUID();
    const now = nowIso();
    const lanes = await laneService.list({ includeArchived: false });
    const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
    const steps: IntegrationProposalStep[] = [];

    // Resolve base branch SHA
    const baseResult = await runGitOrThrow(
      ["rev-parse", args.baseBranch],
      { cwd: projectRoot, timeoutMs: 10_000 }
    );
    let currentTreeBase = baseResult.trim();

    for (let i = 0; i < args.sourceLaneIds.length; i++) {
      const laneId = args.sourceLaneIds[i]!;
      const lane = laneMap.get(laneId);
      if (!lane) {
        steps.push({
          laneId,
          laneName: laneId,
          position: i,
          outcome: "blocked",
          conflictingFiles: [],
          diffStat: { insertions: 0, deletions: 0, filesChanged: 0 }
        });
        continue;
      }

      const headResult = await runGitOrThrow(
        ["rev-parse", branchNameFromRef(lane.branchRef)],
        { cwd: projectRoot, timeoutMs: 10_000 }
      );
      const headSha = headResult.trim();

      // git merge-tree --write-tree <base> <source>
      const mergeTreeResult = await runGit(
        ["merge-tree", "--write-tree", currentTreeBase, headSha],
        { cwd: projectRoot, timeoutMs: 30_000 }
      );

      const hasConflict = mergeTreeResult.exitCode !== 0;
      const conflictingFiles: IntegrationProposalStep["conflictingFiles"] = [];

      // The tree OID is always on the first line of stdout, even in conflict case
      const treeOid = mergeTreeResult.stdout.trim().split("\n")[0]?.trim();

      if (hasConflict) {
        // Parse conflicting file paths from stderr/stdout
        const lines = (mergeTreeResult.stdout + "\n" + mergeTreeResult.stderr).split("\n");
        const conflictPaths: string[] = [];
        for (const line of lines) {
          const match = line.match(/CONFLICT \([^)]+\): (?:Merge conflict in |content )(.+)/);
          if (match?.[1]) {
            conflictPaths.push(match[1].trim());
          }
        }
        // Extract detailed conflict info for each file
        for (const filePath of conflictPaths) {
          if (treeOid) {
            const detail = await extractConflictDetail(treeOid, filePath, projectRoot);
            conflictingFiles.push({
              path: filePath,
              conflictMarkers: detail.conflictMarkers,
              oursExcerpt: detail.oursExcerpt || null,
              theirsExcerpt: detail.theirsExcerpt || null,
              diffHunk: detail.diffHunk || null
            });
          } else {
            conflictingFiles.push({ path: filePath, conflictMarkers: "", oursExcerpt: null, theirsExcerpt: null, diffHunk: null });
          }
        }
      } else {
        // On success, use the tree OID for chaining
        if (treeOid) currentTreeBase = treeOid;
      }

      // Count diff stat (use baseBranch ref, not tree OID which git-diff can't resolve)
      const diffStatResult = await runGit(
        ["diff", "--stat", args.baseBranch, headSha],
        { cwd: projectRoot, timeoutMs: 10_000 }
      );
      const statMatch = diffStatResult.stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);

      steps.push({
        laneId,
        laneName: lane.name,
        position: i,
        outcome: hasConflict ? "conflict" : "clean",
        conflictingFiles,
        diffStat: {
          filesChanged: statMatch ? Number(statMatch[1]) : 0,
          insertions: statMatch ? Number(statMatch[2] ?? 0) : 0,
          deletions: statMatch ? Number(statMatch[3] ?? 0) : 0
        }
      });
    }

    const overallOutcome = steps.some((s) => s.outcome === "blocked")
      ? "blocked"
      : steps.some((s) => s.outcome === "conflict")
        ? "conflict"
        : "clean";

    const proposal: IntegrationProposal = {
      proposalId,
      sourceLaneIds: args.sourceLaneIds,
      baseBranch: args.baseBranch,
      steps,
      overallOutcome,
      createdAt: now,
      status: "proposed"
    };

    // Persist in DB
    db.run(
      `insert into integration_proposals(id, project_id, source_lane_ids_json, base_branch, steps_json, overall_outcome, created_at, status) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [proposalId, projectId, JSON.stringify(args.sourceLaneIds), args.baseBranch, JSON.stringify(steps), overallOutcome, now, "proposed"]
    );

    return proposal;
  };

  const commitIntegration = async (args: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => {
    // Look up proposal
    const proposalRow = db.get<{ id: string; source_lane_ids_json: string; base_branch: string; steps_json: string }>(
      `select id, source_lane_ids_json, base_branch, steps_json from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);

    const sourceLaneIds = JSON.parse(String(proposalRow.source_lane_ids_json)) as string[];

    const result = await createIntegrationPr({
      sourceLaneIds,
      integrationLaneName: args.integrationLaneName,
      baseBranch: String(proposalRow.base_branch),
      title: args.title,
      body: args.body,
      draft: args.draft
    });

    db.run(`update integration_proposals set status = 'committed' where id = ?`, [args.proposalId]);

    return result;
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
        return await land({ prId: member.pr_id, method: args.method });
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
    }>(
      `select * from queue_landing_state where group_id = ? order by started_at desc limit 1`,
      [groupId]
    );
    if (!row) return null;
    return {
      queueId: String(row.id),
      groupId: String(row.group_id),
      state: String(row.state) as QueueLandingState["state"],
      entries: JSON.parse(String(row.entries_json)),
      currentPosition: Number(row.current_position),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
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

  const listIntegrationProposals = (): IntegrationProposal[] => {
    const rows = db.all<{
      id: string; source_lane_ids_json: string; base_branch: string;
      steps_json: string; overall_outcome: string; created_at: string;
      title: string; body: string; draft: number;
      integration_lane_name: string; status: string;
      integration_lane_id: string | null; resolution_state_json: string | null;
    }>(
      `select * from integration_proposals where project_id = ? and status = 'proposed' order by created_at desc`,
      [projectId]
    );
    return rows.map((row) => ({
      proposalId: String(row.id),
      sourceLaneIds: JSON.parse(String(row.source_lane_ids_json)) as string[],
      baseBranch: String(row.base_branch),
      steps: JSON.parse(String(row.steps_json)) as IntegrationProposalStep[],
      overallOutcome: String(row.overall_outcome) as IntegrationProposal["overallOutcome"],
      createdAt: String(row.created_at),
      title: String(row.title || ""),
      body: String(row.body || ""),
      draft: Boolean(row.draft),
      integrationLaneName: String(row.integration_lane_name || ""),
      status: String(row.status) as IntegrationProposal["status"],
      integrationLaneId: row.integration_lane_id || null,
      resolutionState: row.resolution_state_json ? JSON.parse(String(row.resolution_state_json)) as IntegrationResolutionState : null
    }));
  };

  const updateIntegrationProposal = (args: UpdateIntegrationProposalArgs): void => {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (args.title !== undefined) { sets.push("title = ?"); params.push(args.title); }
    if (args.body !== undefined) { sets.push("body = ?"); params.push(args.body); }
    if (args.draft !== undefined) { sets.push("draft = ?"); params.push(args.draft ? 1 : 0); }
    if (args.integrationLaneName !== undefined) { sets.push("integration_lane_name = ?"); params.push(args.integrationLaneName); }
    if (sets.length === 0) return;
    params.push(args.proposalId);
    db.run(`update integration_proposals set ${sets.join(", ")} where id = ?`, params);
  };

  const deleteIntegrationProposal = (proposalId: string): void => {
    db.run(`delete from integration_proposals where id = ?`, [proposalId]);
  };

  // B1: Create integration lane for a proposal, merge clean steps
  const createIntegrationLaneForProposal = async (
    args: CreateIntegrationLaneForProposalArgs
  ): Promise<CreateIntegrationLaneForProposalResult> => {
    const proposalRow = db.get<{
      id: string; source_lane_ids_json: string; base_branch: string;
      steps_json: string; overall_outcome: string;
    }>(
      `select id, source_lane_ids_json, base_branch, steps_json, overall_outcome from integration_proposals where id = ?`,
      [args.proposalId]
    );
    if (!proposalRow) throw new Error(`Proposal not found: ${args.proposalId}`);

    const steps = JSON.parse(String(proposalRow.steps_json)) as IntegrationProposalStep[];
    const allLanes = await laneService.list({ includeArchived: false });
    const laneMap = new Map(allLanes.map((l) => [l.id, l]));

    // Find a parent lane to base the integration lane on (use baseBranch's lane or first source lane)
    const baseBranch = String(proposalRow.base_branch);
    const parentLaneId = allLanes.find((l) => {
      const base = branchNameFromRef(l.branchRef);
      return base === baseBranch || l.baseRef === baseBranch;
    })?.id ?? steps[0]?.laneId;

    if (!parentLaneId) throw new Error("No suitable parent lane found for integration lane");

    const shortId = args.proposalId.slice(0, 8);
    const integrationLane = await laneService.createChild({
      parentLaneId,
      name: `integration/${shortId}`,
      description: `Integration lane for proposal ${args.proposalId}`
    });

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

    const resolutionState: IntegrationResolutionState = {
      integrationLaneId: integrationLane.id,
      stepResolutions,
      activeChatSessionId: null,
      activeLaneId: null,
      updatedAt: nowIso()
    };

    db.run(
      `update integration_proposals set integration_lane_id = ?, resolution_state_json = ? where id = ?`,
      [integrationLane.id, JSON.stringify(resolutionState), args.proposalId]
    );

    return { integrationLaneId: integrationLane.id, mergedCleanLanes, conflictingLanes };
  };

  // B2: Start AI-assisted resolution for a conflicting step
  const startIntegrationResolution = async (
    args: StartIntegrationResolutionArgs
  ): Promise<StartIntegrationResolutionResult> => {
    if (!agentChatService) throw new Error("Agent chat service not available");

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

    // Attempt merge (will leave conflict markers in files)
    const sourceBranch = branchNameFromRef(sourceLane.branchRef);
    const mergeRes = await runGit(
      ["merge", "--no-ff", "-m", `Merge ${sourceLane.name} into integration`, sourceBranch],
      { cwd: integrationLane.worktreePath, timeoutMs: 60_000 }
    );

    // Get conflicting files from git status
    const statusRes = await runGit(
      ["status", "--porcelain"],
      { cwd: integrationLane.worktreePath, timeoutMs: 10_000 }
    );
    const conflictFiles = statusRes.stdout
      .split("\n")
      .filter((line) => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DD"))
      .map((line) => line.slice(3).trim());

    // Create agent chat session
    const session = await agentChatService.createSession({
      laneId: integrationLaneId,
      provider: args.provider,
      model: args.model,
      reasoningEffort: args.reasoningEffort
    });

    // Build and send resolution prompt
    const prompt = buildIntegrationResolutionPrompt(conflictFiles, sourceLane.name, args.autoApprove);
    await agentChatService.sendMessage({ sessionId: session.id, text: prompt });

    // Update resolution state
    const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
      ? JSON.parse(String(proposalRow.resolution_state_json))
      : { integrationLaneId, stepResolutions: {}, activeChatSessionId: null, activeLaneId: null, updatedAt: nowIso() };

    resolutionState.stepResolutions[args.laneId] = "resolving";
    resolutionState.activeChatSessionId = session.id;
    resolutionState.activeLaneId = args.laneId;
    resolutionState.updatedAt = nowIso();

    db.run(
      `update integration_proposals set resolution_state_json = ? where id = ?`,
      [JSON.stringify(resolutionState), args.proposalId]
    );

    return { chatSessionId: session.id, integrationLaneId };
  };

  // B3: Build prompt for AI resolution
  const buildIntegrationResolutionPrompt = (
    conflictFiles: string[],
    sourceLaneName: string,
    autoApprove?: boolean
  ): string => {
    const fileList = conflictFiles.map((f) => `  - ${f}`).join("\n");
    const modeInstruction = autoApprove
      ? "Apply changes directly. Resolve all conflicts and commit the result."
      : "Show your proposed changes and wait for approval before committing.";

    return [
      `You are resolving merge conflicts in an integration lane.`,
      `The branch "${sourceLaneName}" is being merged and has conflicts in the following files:`,
      fileList,
      ``,
      `Instructions:`,
      `1. Examine each conflicting file and understand both sides of the conflict.`,
      `2. Resolve all conflicts by editing the files to produce the correct merged result.`,
      `3. After resolving, run \`git add\` on each resolved file and \`git commit\` to finalize the merge.`,
      `4. Explain your resolution choices briefly.`,
      ``,
      modeInstruction
    ].join("\n");
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
    const conflictFiles = statusRes.stdout
      .split("\n")
      .filter((line) => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DD"))
      .map((line) => line.slice(3).trim());

    const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
      ? JSON.parse(String(proposalRow.resolution_state_json))
      : { integrationLaneId, stepResolutions: {}, activeChatSessionId: null, activeLaneId: null, updatedAt: nowIso() };

    let resolution: IntegrationStepResolution;
    if (conflictFiles.length === 0) {
      resolution = "resolved";
      resolutionState.stepResolutions[args.laneId] = "resolved";
      if (resolutionState.activeLaneId === args.laneId) {
        resolutionState.activeChatSessionId = null;
        resolutionState.activeLaneId = null;
      }
    } else {
      resolution = "resolving";
      resolutionState.stepResolutions[args.laneId] = "resolving";
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

    return { resolution, remainingConflictFiles: conflictFiles, allResolved };
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

    async refresh(args: { prId?: string } = {}): Promise<PrSummary[]> {
      if (args.prId) {
        return [await refreshOne(args.prId)];
      }
      const rows = listRows();
      const out: PrSummary[] = [];
      for (const row of rows) {
        try {
          out.push(await refreshOne(row.id));
        } catch (error) {
          logger.warn("prs.refresh_failed", { prId: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return out;
    },

    async getStatus(prId: string): Promise<PrStatus> {
      const row = getRow(prId);
      if (!row) throw new Error(`PR not found: ${prId}`);
      return await computeStatus(rowToSummary(row));
    },

    async getChecks(prId: string): Promise<PrCheck[]> {
      return await getChecks(prId);
    },

    async getComments(prId: string): Promise<PrComment[]> {
      return await getComments(prId);
    },

    async getReviews(prId: string): Promise<PrReview[]> {
      return await getReviews(prId);
    },

    async updateDescription(args: UpdatePrDescriptionArgs): Promise<void> {
      return await updateDescription(args);
    },

    async delete(args: DeletePrArgs): Promise<DeletePrResult> {
      return await deletePr(args);
    },

    async draftDescription(laneId: string, model?: string): Promise<{ title: string; body: string }> {
      return await draftDescription(laneId, model);
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

    async createStackedPrs(args: CreateStackedPrsArgs): Promise<CreateStackedPrsResult> {
      return await createStackedPrs(args);
    },

    async createQueuePrs(args: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> {
      return await createQueuePrs(args);
    },

    async createIntegrationPr(args: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> {
      return await createIntegrationPr(args);
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

    listIntegrationProposals(): IntegrationProposal[] {
      return listIntegrationProposals();
    },

    updateIntegrationProposal(args: UpdateIntegrationProposalArgs): void {
      return updateIntegrationProposal(args);
    },

    deleteIntegrationProposal(proposalId: string): void {
      return deleteIntegrationProposal(proposalId);
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

    setAgentChatService(svc: ReturnType<typeof createAgentChatService>): void {
      agentChatService = svc;
    }
  };
}
