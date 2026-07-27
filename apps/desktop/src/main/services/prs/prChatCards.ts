import type {
  AdeCardIcon,
  AdeCardPayload,
  AdeCardProgress,
  AdeCardRow,
} from "../../../shared/adeCard";
import type {
  AgentChatEmitAdeCardArgs,
  AgentChatSessionSummary,
  PrActionJob,
  PrActionRun,
  PrCheck,
  PrReview,
  PrReviewThread,
  PrSummary,
} from "../../../shared/types";
import { pipelineStateOf } from "../../../shared/prPipelineState";
import { latestRunsByWorkflow } from "./workflowGraph";

export type PrCardChange = {
  pr: PrSummary;
  previousState: PrSummary["state"] | null;
  previousChecksStatus: PrSummary["checksStatus"] | null;
  previousReviewStatus: PrSummary["reviewStatus"] | null;
  previousMergeConflicts: boolean | null;
  previousBehindBaseBy: number | null;
};

export type PrCardDataSource = {
  getActionRuns(prId: string): Promise<PrActionRun[]>;
  getChecks(prId: string): Promise<PrCheck[]>;
  getReviews(prId: string): Promise<PrReview[]>;
  getReviewThreads(prId: string): Promise<PrReviewThread[]>;
};

export type PrCardChatSink = {
  listSessions(
    laneId?: string,
    options?: { includeArchived?: boolean },
  ): Promise<AgentChatSessionSummary[]>;
  emitAdeCard(args: AgentChatEmitAdeCardArgs): Promise<void>;
};

function prNavTarget(pr: PrSummary, detailTab: "overview" | "files" | "checks") {
  return {
    kind: "pr" as const,
    prId: pr.id,
    prNumber: pr.githubPrNumber,
    laneId: pr.laneId,
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    detailTab,
  };
}

function timeMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestRun(runs: PrActionRun[]): PrActionRun | null {
  return [...runs].sort((left, right) => (
    timeMs(right.createdAt) - timeMs(left.createdAt)
    || right.id - left.id
  ))[0] ?? null;
}

type JobBucket = keyof AdeCardProgress | "skipped" | "unknown";

function itemBucket(item: PrActionJob | PrCheck): JobBucket {
  return pipelineStateOf(item);
}

function jobIcon(bucket: JobBucket): AdeCardIcon {
  if (bucket === "passed") return "pass";
  if (bucket === "failed") return "fail";
  if (bucket === "running") return "running";
  if (bucket === "queued") return "queued";
  if (bucket === "skipped") return "skipped";
  return "info";
}

function jobPriority(bucket: JobBucket): number {
  if (bucket === "failed") return 0;
  if (bucket === "running") return 1;
  if (bucket === "queued") return 2;
  if (bucket === "unknown") return 3;
  if (bucket === "skipped") return 4;
  return 5;
}

function compactCardText(value: string, maxChars = 480): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

function ciRows(runs: PrActionRun[], checks: PrCheck[]): {
  rows: AdeCardRow[];
  progress: AdeCardProgress;
  other: number;
} {
  const jobs = runs.flatMap((run) => run.jobs);
  const items: Array<PrActionJob | PrCheck> = jobs.length > 0 ? jobs : checks;
  const progress: AdeCardProgress = {
    passed: 0,
    failed: 0,
    running: 0,
    queued: 0,
  };

  const ranked = items
    .map((item) => ({ item, bucket: itemBucket(item) }))
    .sort((left, right) => (
      jobPriority(left.bucket) - jobPriority(right.bucket)
      || left.item.name.localeCompare(right.item.name)
    ));
  for (const entry of ranked) {
    if (entry.bucket in progress) progress[entry.bucket as keyof AdeCardProgress] += 1;
  }
  return {
    progress,
    other: ranked.filter((entry) => entry.bucket === "skipped" || entry.bucket === "unknown").length,
    rows: ranked.slice(0, 3).map(({ item, bucket }) => ({
      icon: jobIcon(bucket),
      text: item.name,
      detail: bucket,
      tone: bucket === "failed"
        ? "warning"
        : bucket === "passed"
          ? "success"
          : bucket === "running" || bucket === "queued"
            ? "accent"
            : "neutral",
    })),
  };
}

export function selectPrCardSession(
  sessions: AgentChatSessionSummary[],
): AgentChatSessionSummary | null {
  return sessions
    .filter((session) => (session.surface ?? "work") === "work" && session.archivedAt == null)
    .sort((left, right) => (
      timeMs(right.lastActivityAt) - timeMs(left.lastActivityAt)
      || right.sessionId.localeCompare(left.sessionId)
    ))[0] ?? null;
}

export function buildPrCiCard(args: {
  pr: PrSummary;
  runs: PrActionRun[];
  checks: PrCheck[];
}): AdeCardPayload {
  const { pr, runs, checks } = args;
  const latestRuns = latestRunsByWorkflow(runs);
  const run = newestRun(latestRuns);
  const attempt = Math.max(1, ...latestRuns.map((entry) => entry.runAttempt ?? 1));
  const episodeHead = pr.headSha?.trim()
    || run?.headSha?.trim()
    || `${pr.githubPrNumber}:unknown-head`;
  const episode = `${episodeHead}:${attempt}`;
  const { rows, progress, other } = ciRows(latestRuns, checks);
  const state = pr.checksStatus === "pending" ? "live" : "terminal";
  const title = pr.checksStatus === "passing"
    ? "CI passed"
    : pr.checksStatus === "failing"
      ? "CI failed"
      : "CI is running";
  const tone = pr.checksStatus === "failing"
    ? "warning"
    : pr.checksStatus === "passing"
      ? "success"
      : "accent";
  const total = progress.passed + progress.failed + progress.running + progress.queued + other;

  return {
    cardId: `pr-ci:${pr.id}:${episode}`,
    variant: "pr_ci",
    state,
    title,
    subtitle: `PR #${pr.githubPrNumber}${run?.name ? ` · ${run.name}` : ""}`,
    metrics: total > 0
      ? [
          { label: "passed", value: String(progress.passed), tone: "success" },
          { label: "failed", value: String(progress.failed), tone: "warning" },
          { label: "active", value: String(progress.running + progress.queued), tone: "accent" },
          ...(other > 0 ? [{ label: "other", value: String(other), tone: "neutral" as const }] : []),
        ]
      : [{ label: "status", value: pr.checksStatus, tone }],
    rows,
    progress,
    navTarget: prNavTarget(pr, "checks"),
    fallbackText: `PR #${pr.githubPrNumber} ${title.toLowerCase()}.`,
  };
}

export function buildPrReviewCard(args: {
  pr: PrSummary;
  reviews: PrReview[];
  threads: PrReviewThread[];
}): AdeCardPayload {
  const { pr, reviews, threads } = args;
  const relevantReviews = reviews.filter((review) => review.state === pr.reviewStatus);
  const latest = [...relevantReviews].sort((left, right) => (
    timeMs(right.submittedAt) - timeMs(left.submittedAt)
    || right.reviewer.localeCompare(left.reviewer)
  ))[0] ?? null;
  const unresolved = threads.filter((thread) => !thread.isResolved).length;
  const reviewState = latest?.state ?? pr.reviewStatus;
  const title = reviewState === "changes_requested"
    ? "Changes requested"
    : reviewState === "approved"
      ? "Review approved"
      : "Review requested";
  const reviewer = latest?.reviewer?.trim() || "Reviewer";
  const reviewIdentity = latest?.submittedAt
    ? `${reviewer}:${latest.submittedAt}`
    : `${pr.headSha?.trim() || "head"}:${reviewState}`;

  return {
    cardId: `pr-review:${pr.id}:${reviewIdentity}`,
    variant: "pr_review",
    state: "terminal",
    title,
    subtitle: `PR #${pr.githubPrNumber} · ${reviewer}`,
    metrics: [
      {
        label: unresolved === 1 ? "unresolved thread" : "unresolved threads",
        value: String(unresolved),
        tone: unresolved > 0 ? "warning" : "success",
      },
    ],
    rows: latest?.body?.trim()
      ? [{
          icon: reviewState === "changes_requested" ? "fail" : "info",
          text: compactCardText(latest.body),
          tone: reviewState === "changes_requested" ? "warning" : "neutral",
        }]
      : [],
    navTarget: prNavTarget(pr, "overview"),
    fallbackText: `${reviewer} ${title.toLowerCase()} on PR #${pr.githubPrNumber}.`,
  };
}

export function buildPrMergedCard(pr: PrSummary): AdeCardPayload {
  return {
    cardId: `pr-merged:${pr.id}`,
    variant: "pr_merged",
    state: "terminal",
    title: "Pull request merged",
    subtitle: `PR #${pr.githubPrNumber} · ${pr.baseBranch}`,
    metrics: [
      { label: "additions", value: `+${pr.additions}`, tone: "success" },
      { label: "deletions", value: `−${pr.deletions}`, tone: "neutral" },
    ],
    navTarget: prNavTarget(pr, "overview"),
    fallbackText: `PR #${pr.githubPrNumber} was merged into ${pr.baseBranch}.`,
  };
}

export function buildPrMergeReadyCard(pr: PrSummary): AdeCardPayload {
  return {
    cardId: `pr-merge-ready:${pr.id}:${pr.headSha?.trim() || "head"}`,
    variant: "pr_merge_ready",
    state: "terminal",
    title: "Ready to merge",
    subtitle: `PR #${pr.githubPrNumber} · checks passing · approved`,
    metrics: [
      { label: "checks", value: "passing", tone: "success" },
      { label: "review", value: "approved", tone: "success" },
    ],
    navTarget: prNavTarget(pr, "overview"),
    actions: [{ id: "open", label: "Review merge", kind: "primary" }],
    fallbackText: `PR #${pr.githubPrNumber} is approved with passing checks.`,
  };
}

export function buildPrConflictCard(args: {
  pr: PrSummary;
  kind: "conflict" | "behind";
}): AdeCardPayload {
  const { pr, kind } = args;
  const behind = Math.max(0, pr.behindBaseBy ?? 0);
  const title = kind === "conflict" ? "Merge conflicts appeared" : "Branch fell behind base";
  return {
    cardId: `pr-conflict:${pr.id}:${pr.headSha?.trim() || "head"}:${kind}`,
    variant: "pr_conflict",
    state: "terminal",
    title,
    subtitle: `PR #${pr.githubPrNumber} · ${pr.baseBranch}`,
    metrics: kind === "behind"
      ? [{ label: behind === 1 ? "commit behind" : "commits behind", value: String(behind), tone: "warning" }]
      : [{ label: "merge state", value: "conflicted", tone: "warning" }],
    navTarget: prNavTarget(pr, "overview"),
    fallbackText: kind === "behind"
      ? `PR #${pr.githubPrNumber} is ${behind} commit${behind === 1 ? "" : "s"} behind ${pr.baseBranch}.`
      : `PR #${pr.githubPrNumber} now has merge conflicts.`,
  };
}

export async function emitPrCardsForChange(args: {
  change: PrCardChange;
  dataSource: PrCardDataSource;
  chat: PrCardChatSink;
}): Promise<number> {
  const { change, dataSource, chat } = args;
  const { pr } = change;
  if (!pr.laneId) return 0;

  const checksChanged =
    change.previousChecksStatus != null
    && change.previousChecksStatus !== pr.checksStatus
    && pr.checksStatus !== "none";
  const reviewChanged =
    change.previousReviewStatus != null
    && change.previousReviewStatus !== pr.reviewStatus
    && (pr.reviewStatus === "approved" || pr.reviewStatus === "changes_requested");
  const conflictsAppeared = change.previousMergeConflicts !== true && pr.mergeConflicts === true;
  const fellBehind =
    Math.max(0, change.previousBehindBaseBy ?? 0) === 0
    && Math.max(0, pr.behindBaseBy ?? 0) > 0;
  const wasMergeReady =
    change.previousState === "open"
    && change.previousChecksStatus === "passing"
    && change.previousReviewStatus === "approved"
    && change.previousMergeConflicts !== true
    && Math.max(0, change.previousBehindBaseBy ?? 0) === 0;
  const isMergeReady =
    pr.state === "open"
    && pr.checksStatus === "passing"
    && pr.reviewStatus === "approved"
    && pr.mergeConflicts !== true
    && Math.max(0, pr.behindBaseBy ?? 0) === 0;
  const becameMergeReady = !wasMergeReady && isMergeReady;
  const merged = change.previousState !== "merged" && pr.state === "merged";

  if (
    !checksChanged
    && !reviewChanged
    && !conflictsAppeared
    && !fellBehind
    && !becameMergeReady
    && !merged
  ) {
    return 0;
  }

  const session = selectPrCardSession(
    await chat.listSessions(pr.laneId, { includeArchived: false }),
  );
  if (!session) return 0;

  const cards: AdeCardPayload[] = [];
  if (checksChanged) {
    const [runs, checks] = await Promise.all([
      dataSource.getActionRuns(pr.id).catch(() => []),
      dataSource.getChecks(pr.id).catch(() => []),
    ]);
    cards.push(buildPrCiCard({ pr, runs, checks }));
  }
  if (reviewChanged) {
    const [reviews, threads] = await Promise.all([
      dataSource.getReviews(pr.id).catch(() => []),
      dataSource.getReviewThreads(pr.id).catch(() => []),
    ]);
    cards.push(buildPrReviewCard({ pr, reviews, threads }));
  }
  if (conflictsAppeared) {
    cards.push(buildPrConflictCard({ pr, kind: "conflict" }));
  }
  if (fellBehind) {
    cards.push(buildPrConflictCard({ pr, kind: "behind" }));
  }
  if (becameMergeReady) {
    cards.push(buildPrMergeReadyCard(pr));
  }
  if (merged) {
    cards.push(buildPrMergedCard(pr));
  }

  const results = await Promise.allSettled(cards.map((card) => (
    chat.emitAdeCard({
      sessionId: session.sessionId,
      card,
    })
  )));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to emit ${failures.length} of ${cards.length} PR chat cards.`,
    );
  }
  return cards.length;
}
