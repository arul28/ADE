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
  PrChecksStatus,
  PrReview,
  PrReviewThread,
  PrSummary,
} from "../../../shared/types";
import { pipelineStateOf } from "../../../shared/prPipelineState";
import { isCiProducerCheck } from "../../../shared/prChecksRollup";
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

/** Rows the CI group shows before it starts counting. The rest is `+N more`. */
const CI_ROW_CAP = 3;
/** The non-CI group is context, not the headline, so it gets fewer rows. */
const OTHER_ROW_CAP = 2;
/** Required contexts named inline before the list collapses into `+N more`. */
const MISSING_REQUIRED_CAP = 3;

type RankedItem = { item: PrActionJob | PrCheck; bucket: JobBucket };

function rankItems(items: Array<PrActionJob | PrCheck>): RankedItem[] {
  return items
    .map((item) => ({ item, bucket: itemBucket(item) }))
    .sort((left, right) => (
      jobPriority(left.bucket) - jobPriority(right.bucket)
      || left.item.name.localeCompare(right.item.name)
    ));
}

function rowTone(bucket: JobBucket): AdeCardRow["tone"] {
  if (bucket === "failed") return "warning";
  if (bucket === "passed") return "success";
  if (bucket === "running" || bucket === "queued") return "accent";
  return "neutral";
}

function toRows(entries: RankedItem[], group: "CI" | "Other"): AdeCardRow[] {
  return entries.map(({ item, bucket }) => ({
    icon: jobIcon(bucket),
    text: item.name,
    // The group name travels in `detail` so every surface — desktop, TUI, iOS —
    // shows the split without needing a new payload field to render headers.
    detail: `${group} · ${bucket}`,
    tone: rowTone(bucket),
  }));
}

function countBuckets(entries: RankedItem[]): { progress: AdeCardProgress; other: number } {
  const progress: AdeCardProgress = { passed: 0, failed: 0, running: 0, queued: 0 };
  for (const entry of entries) {
    if (entry.bucket in progress) progress[entry.bucket as keyof AdeCardProgress] += 1;
  }
  return {
    progress,
    other: entries.filter((entry) => entry.bucket === "skipped" || entry.bucket === "unknown").length,
  };
}

/**
 * Split everything we fetched into the CI group and the everything-else group.
 *
 * Actions jobs are CI by construction — they only exist because a workflow run
 * produced them. Check rows are classified by `isCiProducerCheck`, the same
 * predicate the rollup uses, so the headline and the rows can never go back to
 * disagreeing about what counts as CI. A check GitHub names as a preview or
 * review bot lands in "Other" and cannot carry the headline; a slug-less row is
 * CI-eligible, because `appSlug` only started being populated in this change
 * and failing legacy rows closed would report "CI has not run" for every one of
 * them. Any check whose name a job already covers is dropped so the same work
 * is not counted twice once both endpoints answered.
 */
function groupCheckItems(runs: PrActionRun[], checks: PrCheck[]): {
  ci: RankedItem[];
  other: RankedItem[];
} {
  const jobs = runs.flatMap((run) => run.jobs);
  const jobNames = new Set(jobs.map((job) => job.name));
  const remaining = checks.filter((check) => !jobNames.has(check.name));
  return {
    ci: rankItems([...jobs, ...remaining.filter((check) => isCiProducerCheck(check.appSlug))]),
    other: rankItems(remaining.filter((check) => !isCiProducerCheck(check.appSlug))),
  };
}

function formatContextList(contexts: readonly string[], limit = MISSING_REQUIRED_CAP): string {
  if (contexts.length <= limit) return contexts.join(", ");
  return `${contexts.slice(0, limit).join(", ")}, +${contexts.length - limit} more`;
}

export function selectPrCardSession(
  sessions: AgentChatSessionSummary[],
): AgentChatSessionSummary | null {
  return selectPrCardSessions(sessions)[0] ?? null;
}

/**
 * Route a PR card to every live chat that explicitly worked on the PR. Older
 * PR rows have no edge, so they retain the historic single most-recent-lane
 * fallback instead of disappearing from chat altogether.
 */
export function selectPrCardSessions(
  sessions: AgentChatSessionSummary[],
  chatSessionIds?: readonly string[] | null,
): AgentChatSessionSummary[] {
  const eligible = sessions
    .filter((session) => (session.surface ?? "work") === "work" && session.archivedAt == null)
    .sort((left, right) => (
      timeMs(right.lastActivityAt) - timeMs(left.lastActivityAt)
      || right.sessionId.localeCompare(left.sessionId)
    ));
  const linkedIds = new Set(
    (chatSessionIds ?? []).map((sessionId) => String(sessionId ?? "").trim()).filter(Boolean),
  );
  if (linkedIds.size > 0) {
    return eligible.filter((session) => linkedIds.has(session.sessionId));
  }
  return eligible.slice(0, 1);
}

/**
 * Presentation per rollup state, as one exhaustive map rather than three
 * parallel ternary ladders over the same discriminant.
 *
 * `not_run` and `none` are deliberately neutral: the card reports an absence,
 * and an absence is not an alarm — only a real red job earns the warning tone.
 * `none` used to fall through to "CI is running", which was its own small lie.
 *
 * Being a `Record<PrChecksStatus, …>` makes the next state a compile error
 * here instead of three silent `else` arms.
 */
const CI_CARD_PRESENTATION: Record<
  PrChecksStatus,
  { title: string; tone: "success" | "warning" | "accent" | "neutral"; state: "live" | "terminal" }
> = {
  passing: { title: "CI passed", tone: "success", state: "terminal" },
  failing: { title: "CI failed", tone: "warning", state: "terminal" },
  pending: { title: "CI is running", tone: "accent", state: "live" },
  not_run: { title: "CI has not run", tone: "neutral", state: "terminal" },
  none: { title: "No checks reported", tone: "neutral", state: "terminal" },
};

export function buildPrCiCard(args: {
  pr: PrSummary;
  runs: PrActionRun[];
  checks: PrCheck[];
  /**
   * Why the job/check fetch produced nothing, when it failed.
   *
   * `[]` from a rejected GitHub call and `[]` from a PR that genuinely has no
   * jobs are the same value but not the same fact: swallowing the difference
   * rendered a content-free `[passing status]` chip under a green check while
   * GitHub was returning 403. When this is set, the card says so and offers a
   * retry instead of claiming a clean run.
   */
  fetchError?: string | null;
}): AdeCardPayload {
  const { pr, runs, checks } = args;
  const fetchError = args.fetchError?.trim() || null;
  const latestRuns = latestRunsByWorkflow(runs);
  const run = newestRun(latestRuns);
  const attempt = Math.max(1, ...latestRuns.map((entry) => entry.runAttempt ?? 1));
  const episodeHead = pr.headSha?.trim()
    || run?.headSha?.trim()
    || `${pr.githubPrNumber}:unknown-head`;
  const episode = `${episodeHead}:${attempt}`;
  const groups = groupCheckItems(latestRuns, checks);
  // The headline is the CI group's story. `progress` follows it for the same
  // reason: mixing producers is what let three third-party successes render as
  // "CI passed · 3 jobs" on PR #988 while GitHub Actions never ran.
  const { progress, other } = countBuckets(groups.ci);
  const ciTotal = groups.ci.length;
  const otherTotal = groups.other.length;
  const { title, tone, state } = CI_CARD_PRESENTATION[pr.checksStatus];
  const reason = pr.checksReason?.trim() || null;
  const missingRequired = (pr.checksMissingRequired ?? []).map((c) => c.trim()).filter(Boolean);
  // A partial response is still degraded: the surviving endpoint's rows remain
  // useful, but they are not the complete job inventory. Keep the warning and
  // Retry action alongside those rows instead of presenting them as complete.
  const degraded = fetchError != null;

  const rows: AdeCardRow[] = [
    ...(missingRequired.length > 0
      ? [{
          icon: "queued" as const,
          text: `${missingRequired.length === 1 ? "Required check" : "Required checks"} with no result: ${formatContextList(missingRequired)}`,
          detail: "required",
          tone: "neutral" as const,
        }]
      : []),
    ...toRows(groups.ci.slice(0, CI_ROW_CAP), "CI"),
    // Say the quiet part out loud when the other group is carrying the card:
    // without this row, three green third-party rows read as three green CI rows.
    ...(ciTotal === 0 && !degraded && (otherTotal > 0 || pr.checksStatus === "not_run")
      ? [{
          icon: "info" as const,
          text: "No CI checks reported on this commit",
          detail: "CI",
          tone: "neutral" as const,
        }]
      : []),
    ...toRows(groups.other.slice(0, OTHER_ROW_CAP), "Other"),
  ];
  const truncated = Math.max(0, ciTotal - CI_ROW_CAP) + Math.max(0, otherTotal - OTHER_ROW_CAP);

  const metrics: AdeCardPayload["metrics"] = degraded && ciTotal === 0 && otherTotal === 0
    ? []
    : ciTotal > 0
      ? [
          { label: "passed", value: String(progress.passed), tone: "success" },
          { label: "failed", value: String(progress.failed), tone: "warning" },
          { label: "active", value: String(progress.running + progress.queued), tone: "accent" },
          ...(other > 0 ? [{ label: "other", value: String(other), tone: "neutral" as const }] : []),
          ...(otherTotal > 0
            ? [{ label: "other checks", value: String(otherTotal), tone: "neutral" as const }]
            : []),
        ]
      : otherTotal > 0
        // The whole point of the split: "CI 0 / other checks 3" is the honest
        // reading of a PR that only preview and review apps reported on.
        ? [
            { label: "CI checks", value: "0", tone: "neutral" as const },
            { label: "other checks", value: String(otherTotal), tone: "neutral" as const },
          ]
        : [{ label: "status", value: pr.checksStatus, tone }];

  return {
    cardId: `pr-ci:${pr.id}:${episode}`,
    variant: "pr_ci",
    state,
    title,
    // The reason explains the headline, so it outranks the run name for the one
    // line of subtitle the card gets.
    subtitle: reason
      ? `PR #${pr.githubPrNumber} · ${compactCardText(reason, 160)}`
      : `PR #${pr.githubPrNumber}${run?.name ? ` · ${run.name}` : ""}`,
    metrics,
    rows,
    progress,
    ...(truncated > 0 ? { rowsTruncated: truncated } : {}),
    ...(degraded
      ? {
          degradedReason: `Couldn’t read the job list from GitHub — ${fetchError}`,
          actions: [{ id: "retry", label: "Retry", kind: "primary" as const }],
        }
      : {}),
    navTarget: prNavTarget(pr, "checks"),
    fallbackText: degraded
      ? `PR #${pr.githubPrNumber} checks are ${pr.checksStatus}; job detail unavailable in part (${fetchError}).`
      : `PR #${pr.githubPrNumber} ${title.toLowerCase()}.${reason ? ` ${compactCardText(reason, 160)}` : ""}`,
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

  const sessions = selectPrCardSessions(
    await chat.listSessions(pr.laneId, { includeArchived: false }),
    pr.chatSessionIds,
  );
  if (sessions.length === 0) return 0;

  const cards: AdeCardPayload[] = [];
  if (checksChanged) {
    // Capture the failures instead of `.catch(() => [])`-ing them away: a
    // rate-limited GitHub call and a PR with no jobs both produce `[]`, and
    // only one of them means "everything is fine".
    const [runsResult, checksResult] = await Promise.allSettled([
      dataSource.getActionRuns(pr.id),
      dataSource.getChecks(pr.id),
    ]);
    const runs = runsResult.status === "fulfilled" ? runsResult.value : [];
    const checks = checksResult.status === "fulfilled" ? checksResult.value : [];
    const fetchError = [runsResult, checksResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
      .join("; ") || null;
    cards.push(buildPrCiCard({ pr, runs, checks, fetchError }));
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

  const results = await Promise.allSettled(
    sessions.flatMap((session) => cards.map((card) => (
      chat.emitAdeCard({
        sessionId: session.sessionId,
        card,
      })
    ))),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to emit ${failures.length} of ${cards.length} PR chat cards.`,
    );
  }
  return cards.length;
}
