import fs from "node:fs";
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
  DeletePrArgs,
  DeletePrResult,
  GitHubRepoRef,
  IntegrationLaneSummary,
  IntegrationPairwiseResult,
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
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createAgentChatService } from "../chat/agentChatService";
import { runGit, runGitOrThrow } from "../git/git";
import { extractFirstJsonObject } from "../ai/utils";
import { asNumber, asString, nowIso, parseDiffNameOnly } from "../shared/utils";

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

function parseMergeTreeConflictPaths(output: string): string[] {
  // git merge-tree --write-tree uses NUL bytes (\0) to separate sections
  // (tree OID, conflicted file info, informational messages).
  // Replace NUL bytes with newlines so the line-based parser can process all sections.
  const lines = output.replace(/\0/g, "\n").split("\n");
  const seen = new Set<string>();
  const paths: string[] = [];
  const addPath = (candidate: string | undefined) => {
    const value = (candidate ?? "").trim();
    if (!value.length || seen.has(value)) return;
    // Skip placeholder entries
    if (value.startsWith("(") && value.endsWith(")")) return;
    // Skip bare OIDs (tree OID on first line of --write-tree output; SHA-1 or SHA-256)
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(value)) return;
    seen.add(value);
    paths.push(value);
  };

  // Collect all CONFLICT lines up-front so we can do efficient lookups.
  const conflictLineTexts = lines
    .map((l) => (l ?? "").trim())
    .filter((l) => l.startsWith("CONFLICT"));

  // Also detect if any line looks like a bare path (used for the catch-all at the end of the loop).
  // A bare path is a non-empty line that doesn't match any known prefix and looks like a file path.
  // We'll use this regex to test: contains a '/' or a '.ext' and no spaces at the start.
  // Known prefixes in git merge-tree informational messages (section after file list).
  const GIT_MSG_PREFIXES = [
    "CONFLICT", "Auto-merging", "Removing", "Adding", "Skipping",
    "Merging", "Already", "Applying", "Using", "Falling", "Updating",
    "warning:", "error:", "hint:", "fatal:", "note:"
  ];
  const looksLikePath = (l: string) => {
    if (l.length === 0 || l.length > 500) return false;
    // Exclude known git message prefixes
    for (const prefix of GIT_MSG_PREFIXES) {
      if (l.startsWith(prefix)) return false;
    }
    // Exclude stage entries (handled by stageMatch)
    if (/^[0-7]{6}\s/.test(l)) return false;
    // Exclude "changed in both" markers.
    if (/^\s*(?:changed|added|removed|modified) in both\s*$/i.test(l)) return false;
    // Exclude bare OIDs
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(l)) return false;
    // A bare conflict path from git has no leading/trailing whitespace (already trimmed)
    // and typically looks like a relative file path: contains '/' or has a file extension.
    // Paths with spaces exist but are rare in code repos; to avoid false-positives
    // from sentence-like lines, require that the line looks path-like.
    return /\//.test(l) || /\.\w+$/.test(l);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.length) continue;

    // --write-tree "Conflicted file info" section: "<mode> <oid> <stage>\t<filename>"
    // e.g. "100644 abc123def456... 2\tpath/to/file.ts"
    // Stages: 1=base, 2=ours, 3=theirs — any file here is conflicted.
    const stageMatch = line.match(/^[0-7]{6}\s+[0-9a-f]{40,64}\s+[123]\s+(.+)$/i);
    if (stageMatch?.[1]) {
      addPath(stageMatch[1]);
      continue;
    }

    // "CONFLICT (content): Merge conflict in path/to/file"
    const mergeConflictMatch = line.match(/^CONFLICT \([^)]+\): (?:Merge conflict in |content )(.+)$/);
    if (mergeConflictMatch?.[1]) {
      addPath(mergeConflictMatch[1]);
      continue;
    }

    // "CONFLICT (modify/delete): path/to/file deleted in HEAD and modified in feature"
    // "CONFLICT (rename/delete): path/to/file renamed to ... was deleted in ..."
    // Use a NON-greedy match before the first " deleted| renamed| modified| added" to get the path.
    const actionMatch = line.match(
      /^CONFLICT \([^)]+\):\s+(.+?)\s+(?:deleted|renamed|modified|added|was)\s/
    );
    if (actionMatch?.[1]) {
      addPath(actionMatch[1]);
      continue;
    }

    // "CONFLICT (rename/rename): ... in path/to/file ..."
    // Fallback: capture path after " in " when there's no action word before the path.
    const conflictInMatch = line.match(/^CONFLICT \([^)]+\):.*\bMerge conflict in (.+?)(?:\s*$)/);
    if (conflictInMatch?.[1]) {
      addPath(conflictInMatch[1]);
      continue;
    }

    // Catch-all: any CONFLICT line with a path-like token after the colon
    const genericConflict = line.match(/^CONFLICT \([^)]+\):\s+(.+)$/);
    if (genericConflict?.[1]) {
      // Try to extract a file path from the message: a/b/c.ext or a/b/c (with slash)
      const pathTokens = genericConflict[1].match(/(?:^|\s)([\w./@-]+(?:\/[\w.@-]+)+(?:\.\w+)?)(?:\s|$)/g)
        ?? genericConflict[1].match(/(?:^|\s)([\w./-]+\.\w+)(?:\s|$)/g);
      if (pathTokens) {
        for (const token of pathTokens) addPath(token.trim());
      }
      continue;
    }

    // "Auto-merging path/to/file" — always extract the path. When --write-tree is used,
    // the CONFLICT line may not immediately follow (it can appear later in the
    // informational messages section, separated from Auto-merging by other lines).
    // If the file truly auto-merged cleanly it will be deduplicated by `addPath` anyway,
    // and the conflict status is already determined by the exit code + structured section.
    const autoMergeMatch = line.match(/^Auto-merging (.+)$/);
    if (autoMergeMatch?.[1]) {
      // Check if any CONFLICT line exists anywhere in the output that mentions this path,
      // or if the structured section already captured it. If the structured section
      // captured this path, addPath deduplicates. Otherwise look for a nearby CONFLICT.
      const nextLine = (lines[i + 1] ?? "").trim();
      if (nextLine.startsWith("CONFLICT")) {
        addPath(autoMergeMatch[1]);
      } else if (seen.has(autoMergeMatch[1].trim())) {
        // Already captured from the structured section — skip
      } else {
        // Check if there's any CONFLICT line in the entire output mentioning this file
        const filePath = autoMergeMatch[1].trim();
        const hasConflictForFile = conflictLineTexts.some((lt) => lt.includes(filePath));
        if (hasConflictForFile) addPath(filePath);
      }
      continue;
    }

    // Merge-tree output: lines that look like file paths with conflict markers.
    // "changed in both" / "added in both" patterns from old merge-tree format
    const bothMatch = line.match(/^\s*(?:changed|added|removed|modified) in both\s*$/i);
    if (bothMatch) {
      // The path is usually on the previous line
      const prevLine = (lines[i - 1] ?? "").trim();
      if (prevLine && !prevLine.startsWith("CONFLICT") && !prevLine.startsWith("Auto-merging")) {
        addPath(prevLine);
      }
      continue;
    }

    // --write-tree bare path fallback: git merge-tree --write-tree outputs conflicted
    // file paths as bare lines (one per line) between the tree OID and the messages
    // section. These lines don't have any prefix — just the file path.
    if (looksLikePath(line)) {
      addPath(line);
    }
  }

  return paths;
}

function parseMergeTreeTreeOid(stdout: string): string | null {
  // The --write-tree output may use NUL bytes to separate sections (oid\0conflict-info\0messages).
  // Replace NUL with newline so the first line is just the OID.
  const first = stdout
    .replace(/\0/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return null;
  // Accept SHA-1 (40 chars) or SHA-256 (64 chars)
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(first) ? first : null;
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
  openExternal
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
  openExternal: (url: string) => Promise<void>;
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

    return (data ?? []).map((entry: any) => {
      const rawState = asString(entry?.state).toLowerCase();
      let state: PrReview["state"];
      if (rawState === "approved") state = "approved";
      else if (rawState === "changes_requested") state = "changes_requested";
      else if (rawState === "dismissed") state = "dismissed";
      else state = "commented";
      return {
        reviewer: asString(entry?.user?.login) || "unknown",
        state,
        body: asString(entry?.body) || null,
        submittedAt: asString(entry?.submitted_at) || null
      };
    });
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
      let conclusion: PrCheck["conclusion"];
      if (conclusionRaw === "success") conclusion = "success";
      else if (conclusionRaw === "failure" || conclusionRaw === "timed_out" || conclusionRaw === "action_required") conclusion = "failure";
      else if (conclusionRaw === "neutral") conclusion = "neutral";
      else if (conclusionRaw === "skipped") conclusion = "skipped";
      else if (conclusionRaw === "cancelled") conclusion = "cancelled";
      else conclusion = null;
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
          path: `/repos/${repo.owner}/${repo.name}/git/refs/heads/${headBranch}`
        });
        branchDeleted = true;
      } catch (error) {
        logger.warn("prs.delete_branch_failed", { prId: row.id, headBranch, error: error instanceof Error ? error.message : String(error) });
      }

      // Remove PR from any group membership before archiving (lane archive blocks if still in a group)
      db.run("delete from pr_group_members where pr_id = ?", [row.id]);

      let laneArchived = false;
      if (args.archiveLane) {
        try {
          await laneService.archive({ laneId: row.lane_id });
          laneArchived = true;
        } catch (archiveErr) {
          logger.warn("prs.lane_archive_failed", { prId: row.id, laneId: row.lane_id, error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr) });
        }
      }

      operationService.finish({
        operationId: op.operationId,
        status: "succeeded",
        metadataPatch: { mergeCommitSha, branchDeleted, laneArchived }
      });

      await refreshOne(row.id).catch(() => {});

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
    const laneOrder = new Map(args.sourceLaneIds.map((laneId, index) => [laneId, index]));
    const zeroDiffStat: IntegrationProposalStep["diffStat"] = { insertions: 0, deletions: 0, filesChanged: 0 };

    // Resolve base branch SHA once, then compare each lane head against it.
    const baseSha = (await runGitOrThrow(
      ["rev-parse", args.baseBranch],
      { cwd: projectRoot, timeoutMs: 10_000 }
    )).trim();

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

    for (let i = 0; i < args.sourceLaneIds.length; i++) {
      const laneId = args.sourceLaneIds[i]!;
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
    for (let i = 0; i < args.sourceLaneIds.length; i++) {
      const laneAId = args.sourceLaneIds[i]!;
      const laneA = laneSummariesById.get(laneAId);
      if (!laneA) continue;

      for (let j = i + 1; j < args.sourceLaneIds.length; j++) {
        const laneBId = args.sourceLaneIds[j]!;
        const laneB = laneSummariesById.get(laneBId);
        if (!laneB) continue;

        if (!laneA.headSha || !laneB.headSha) {
          continue;
        }

        const mergeTreeResult = await runGit(
          ["merge-tree", "--write-tree", "--messages", `--merge-base=${baseSha}`, laneA.headSha, laneB.headSha],
          { cwd: projectRoot, timeoutMs: 30_000 }
        );
        // Exit code 128 indicates a fatal git error (e.g. invalid refs), not a merge conflict.
        // Skip this pair entirely so it doesn't pollute conflict analysis.
        if (mergeTreeResult.exitCode === 128) {
          logger.warn("prs.merge_tree_fatal", {
            laneAId,
            laneBId,
            exitCode: mergeTreeResult.exitCode,
            stderr: mergeTreeResult.stderr.trim()
          });
          continue;
        }
        const hasConflict = mergeTreeResult.exitCode !== 0;
        const conflictingFiles: IntegrationProposalStep["conflictingFiles"] = [];

        if (hasConflict) {
          const treeOid = parseMergeTreeTreeOid(mergeTreeResult.stdout);
          const mergeTreeCombined = `${mergeTreeResult.stdout}\n${mergeTreeResult.stderr}`;
          let conflictPaths = parseMergeTreeConflictPaths(mergeTreeCombined);
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
          if (conflictPaths.length === 0) {
            // Heuristic fallback: overlap of files changed by both lanes from the same base.
            const [changedAResult, changedBResult] = await Promise.all([
              runGit(["diff", "--name-only", `${baseSha}..${laneA.headSha}`], { cwd: projectRoot, timeoutMs: 15_000 }),
              runGit(["diff", "--name-only", `${baseSha}..${laneB.headSha}`], { cwd: projectRoot, timeoutMs: 15_000 })
            ]);
            const changedA = changedAResult.exitCode === 0 ? parseDiffNameOnly(changedAResult.stdout) : [];
            const changedB = changedBResult.exitCode === 0 ? parseDiffNameOnly(changedBResult.stdout) : [];
            const changedASet = new Set(changedA);
            conflictPaths = changedB.filter((path) => changedASet.has(path));
            logger.info("prs.merge_tree_conflict_fallback_heuristic", {
              laneAId,
              laneBId,
              changedACount: changedA.length,
              changedBCount: changedB.length,
              overlapCount: conflictPaths.length,
              overlapPaths: conflictPaths.slice(0, 10)
            });
          }
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

    const conflictingPeersByLaneId = new Map<string, Set<string>>();
    const conflictingFilesByLaneId = new Map<string, Map<string, IntegrationProposalStep["conflictingFiles"][number]>>();
    for (const laneId of args.sourceLaneIds) {
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

    const laneSummaries: IntegrationLaneSummary[] = args.sourceLaneIds.map((laneId) => {
      const laneSummary = laneSummariesById.get(laneId);
      const laneName = laneSummary?.laneName ?? laneId;
      const conflictsWith = Array.from(conflictingPeersByLaneId.get(laneId) ?? []);
      conflictsWith.sort((a, b) => (laneOrder.get(a) ?? 0) - (laneOrder.get(b) ?? 0));

      const outcome: IntegrationLaneSummary["outcome"] = !laneSummary?.headSha
        ? "blocked"
        : conflictsWith.length > 0
          ? "conflict"
          : "clean";

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

    const overallOutcome = laneSummaries.some((lane) => lane.outcome === "blocked")
      ? "blocked"
      : laneSummaries.some((lane) => lane.outcome === "conflict")
        ? "conflict"
        : "clean";

    const proposal: IntegrationProposal = {
      proposalId,
      sourceLaneIds: args.sourceLaneIds,
      baseBranch: args.baseBranch,
      pairwiseResults,
      laneSummaries,
      steps,
      overallOutcome,
      createdAt: now,
      status: "proposed"
    };

    // Persist in DB
    db.run(
      `insert into integration_proposals(id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json, lane_summaries_json, overall_outcome, created_at, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proposalId,
        projectId,
        JSON.stringify(args.sourceLaneIds),
        args.baseBranch,
        JSON.stringify(steps),
        JSON.stringify(pairwiseResults),
        JSON.stringify(laneSummaries),
        overallOutcome,
        now,
        "proposed"
      ]
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
      pairwise_results_json: string | null; lane_summaries_json: string | null;
    }>(
      `select * from integration_proposals where project_id = ? and status = 'proposed' order by created_at desc`,
      [projectId]
    );
    return rows.map((row) => ({
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
      activeWorkerStepId: null,
      activeLaneId: null,
      updatedAt: nowIso()
    };

    db.run(
      `update integration_proposals set integration_lane_id = ?, resolution_state_json = ? where id = ?`,
      [integrationLane.id, JSON.stringify(resolutionState), args.proposalId]
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
    const conflictFiles = statusRes.stdout
      .split("\n")
      .filter((line) => {
        const code = line.slice(0, 2);
        return code === "UU" || code === "AA" || code === "DD" || code === "DU" || code === "UD" || code === "AU" || code === "UA";
      })
      .map((line) => line.slice(3).trim());

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
    const conflictFiles = statusRes.stdout
      .split("\n")
      .filter((line) => {
        const code = line.slice(0, 2);
        return code === "UU" || code === "AA" || code === "DD" || code === "DU" || code === "UD" || code === "AU" || code === "UA";
      })
      .map((line) => line.slice(3).trim());

    const resolutionState: IntegrationResolutionState = proposalRow.resolution_state_json
      ? JSON.parse(String(proposalRow.resolution_state_json))
      : { integrationLaneId, stepResolutions: {}, activeWorkerStepId: null, activeLaneId: null, updatedAt: nowIso() };

    let resolution: IntegrationStepResolution;
    if (conflictFiles.length === 0) {
      resolution = "resolved";
      resolutionState.stepResolutions[args.laneId] = "resolved";
      if (resolutionState.activeLaneId === args.laneId) {
        resolutionState.activeWorkerStepId = null;
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

    markResolutionWorkerActive(proposalId: string, laneId: string, workerStepId: string): void {
      return markResolutionWorkerActive(proposalId, laneId, workerStepId);
    },

    setAgentChatService(_svc: ReturnType<typeof createAgentChatService>): void {
      // Reserved for future PR<->chat linking.
    }
  };
}
