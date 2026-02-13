import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreatePrFromLaneArgs,
  GitHubRepoRef,
  LandResult,
  LandPrArgs,
  LandStackArgs,
  LinkPrToLaneArgs,
  MergeMethod,
  PrCheck,
  PrChecksStatus,
  PrReview,
  PrReviewStatus,
  PrState,
  PrStatus,
  PrSummary,
  UpdatePrDescriptionArgs
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";
import type { createGithubService } from "../github/githubService";
import type { createPackService } from "../packs/packService";
import type { createHostedAgentService } from "../hosted/hostedAgentService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createByokLlmService } from "../byok/byokLlmService";
import { runGit } from "../git/git";

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

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value);
}

function branchNameFromRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length);
  return trimmed;
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

export function createPrService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  operationService,
  githubService,
  packService,
  hostedAgentService,
  byokLlmService,
  projectConfigService,
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
  hostedAgentService?: ReturnType<typeof createHostedAgentService>;
  byokLlmService?: ReturnType<typeof createByokLlmService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  openExternal: (url: string) => Promise<void>;
}) {
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

  const draftDescription = async (laneId: string): Promise<{ title: string; body: string }> => {
    const lane = (await laneService.list({ includeArchived: true })).find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);

    const template = readPrTemplate(projectRoot);
    const lanePack = packService.getLanePack(laneId);
    const packBody = lanePack.body;

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
    if (providerMode === "hosted" && hostedAgentService?.getStatus().enabled) {
      const result = await hostedAgentService.requestPrDescription({
        laneId,
        prContext: context
      });
      return {
        title: result.title || lane.name,
        body: result.body
      };
    }

    if (providerMode === "byok" && byokLlmService) {
      const draft = await byokLlmService.draftPrDescription({
        laneId,
        prContext: context
      });
      const defaultTitle = lane.name.replace(/[-_/]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
      return {
        title: defaultTitle || lane.name,
        body: draft.body
      };
    }

    // Guest/CLI fallback: deterministic content.
    const defaultTitle = lane.name.replace(/[-_/]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
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
    const lane = (await laneService.list({ includeArchived: true })).find((entry) => entry.id === args.laneId);
    if (!lane) throw new Error(`Lane not found: ${args.laneId}`);

    const repo = await githubService.getRepoOrThrow();
    const headBranch = branchNameFromRef(lane.branchRef);
    const parentLane = lane.parentLaneId ? (await laneService.list({ includeArchived: true })).find((entry) => entry.id === lane.parentLaneId) ?? null : null;
    const baseBranch = (args.baseBranch ?? branchNameFromRef(parentLane?.branchRef ?? lane.baseRef)).trim();

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

    async getReviews(prId: string): Promise<PrReview[]> {
      return await getReviews(prId);
    },

    async updateDescription(args: UpdatePrDescriptionArgs): Promise<void> {
      return await updateDescription(args);
    },

    async draftDescription(laneId: string): Promise<{ title: string; body: string }> {
      return await draftDescription(laneId);
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
    }
  };
}
