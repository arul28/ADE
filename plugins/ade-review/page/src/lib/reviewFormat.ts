/**
 * Every pure helper `ReviewPage.tsx` (2,265) carried, moved rather than rewritten.
 *
 * These are the sentences the run header prints, the tolerant readers that let
 * an older stored run render, and the commit-range ordering rules. They were
 * module-level functions in the compiled page and they are module-level
 * functions here — the only change is that `LaneSummary` became
 * `PageReviewLaunchLane`, which carries the same four fields these read
 * (`name`, `laneType`, `branchRef`, `baseRef`).
 */

import type {
  PageReviewLaunchLane,
  ReviewArtifact,
  ReviewFinding,
  ReviewLaunchCommit,
  ReviewLaunchDraft,
  ReviewPublication,
  ReviewReviewerRun,
  ReviewRun,
  ReviewRunConfig,
  ReviewRunDetail,
  ReviewRunStatus,
  ReviewTarget,
  ReviewTargetMode,
} from "../types";

/**
 * A run whose three timestamps may be missing.
 *
 * The compiled page's own shape. A run row that arrived from an older schema, or
 * mid-write, has no `startedAt`; `normalizeRun` answers `null` for it and every
 * formatter below prints an em-dash rather than "Invalid Date".
 */
export type NormalizedRun = Omit<ReviewRun, "createdAt" | "startedAt" | "updatedAt"> & {
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

export type NormalizedDetail = Omit<ReviewRunDetail, "createdAt" | "startedAt" | "updatedAt"> & {
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

export function toReviewStatusTone(status: ReviewRunStatus): string {
  switch (status) {
    case "completed":
      return "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300";
    case "running":
    case "queued":
      return "border-amber-400/20 bg-amber-400/[0.08] text-amber-300";
    case "failed":
      return "border-red-400/20 bg-red-400/[0.08] text-red-300";
    case "cancelled":
      return "border-zinc-500/20 bg-zinc-500/[0.08] text-zinc-300";
    default:
      return "border-slate-400/20 bg-slate-400/[0.08] text-slate-300";
  }
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

export function formatRunTimingFooter(
  run: Pick<NormalizedRun, "startedAt" | "endedAt" | "status">,
): string {
  const startedLabel = `Started ${formatTime(run.startedAt)}`;
  if (run.endedAt) {
    return `${startedLabel} · Completed ${formatTime(run.endedAt)}`;
  }
  if (run.status === "running" || run.status === "queued") {
    return `${startedLabel} · In progress`;
  }
  return startedLabel;
}

export function formatRunSummaryFooter(
  run: Pick<NormalizedRun, "id" | "startedAt" | "endedAt" | "status">,
): string {
  const timingFooter = formatRunTimingFooter(run);
  const runId = run.id.trim();
  if (!runId) return timingFooter;
  return `Run ${runId} · ${timingFooter}`;
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "unknown time";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function toTargetModeLabel(mode: ReviewTargetMode): string {
  switch (mode) {
    case "lane_diff":
      return "Lane diff";
    case "commit_range":
      return "Commit range";
    case "working_tree":
      return "Uncommitted changes";
    case "pr":
      return "Pull request";
    default:
      return mode;
  }
}

export function toSelectionModeLabel(value: ReviewRunConfig["selectionMode"]): string {
  switch (value) {
    case "full_diff":
      return "Full diff";
    case "selected_commits":
      return "Selected commits";
    case "dirty_only":
      return "Dirty working tree";
    default:
      return value;
  }
}

export function toPassLabel(value: string): string {
  switch (value) {
    case "diff-risk":
      return "Diff risk";
    case "cross-file-impact":
      return "Cross-file impact";
    case "checks-and-tests":
      return "Checks and tests";
    case "security-data":
      return "Security and data";
    case "ui-regression":
      return "UI and regression";
    default:
      return value;
  }
}

export function readArtifactMetaString(artifact: ReviewArtifact, key: string): string | null {
  const value = artifact.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readArtifactMetaNumber(artifact: ReviewArtifact, key: string): number | null {
  const value = artifact.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readArtifactMetaCount(artifact: ReviewArtifact, keys: string[]): number | null {
  for (const key of keys) {
    const numericValue = readArtifactMetaNumber(artifact, key);
    if (numericValue !== null) return numericValue;

    const value = artifact.metadata?.[key];
    if (Array.isArray(value)) return value.length;

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function toContextArtifactLabel(artifactType: string): string {
  switch (artifactType) {
    case "provenance_brief":
      return "Provenance brief";
    case "rule_overlays":
      return "Rule overlays";
    case "validation_signals":
      return "Validation signals";
    case "changed_file_manifest":
      return "Changed-file manifest";
    case "risk_map":
      return "Risk map";
    case "diff_bundle":
      return "Diff bundle";
    case "pass_prompt":
      return "Reviewer prompt";
    case "pass_output":
      return "Reviewer output";
    case "pass_findings":
      return "Reviewer findings";
    case "adjudication_result":
      return "Adjudication result";
    case "merged_findings":
      return "Merged findings";
    case "review_output":
      return "Review output";
    default:
      return artifactType.replaceAll("_", " ");
  }
}

export function isContextArtifactType(artifactType: string): boolean {
  return (
    artifactType === "provenance_brief"
    || artifactType === "rule_overlays"
    || artifactType === "validation_signals"
    || artifactType === "changed_file_manifest"
    || artifactType === "risk_map"
  );
}

function normalizeTimestamp(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * A run row, however it arrived.
 *
 * Deliberately tolerant, and it was tolerant in the compiled page for the same
 * reason: `review.listRuns` and `review.getRunDetail` have both answered a
 * `{run: …}` envelope and a bare row across schema versions, and a stored run
 * from an older ADE names its counts `findingsCount` and its end `completedAt`.
 * A page that read one spelling would show a blank row for the other.
 */
export function normalizeRun(run: ReviewRun | Record<string, unknown>): NormalizedRun {
  const value = run as Record<string, unknown>;
  const nested = value.run && typeof value.run === "object"
    ? (value.run as Record<string, unknown>)
    : null;
  const target = (value.target ?? nested?.target) as ReviewTarget;
  const config = (value.config ?? nested?.config) as ReviewRunConfig;
  const severitySummary =
    value.severitySummary ?? nested?.severitySummary ?? nested?.severityCounts ?? null;
  return {
    id: String(value.id ?? nested?.id ?? ""),
    projectId: String(value.projectId ?? nested?.projectId ?? ""),
    laneId: String(value.laneId ?? nested?.laneId ?? target?.laneId ?? ""),
    status: String(value.status ?? nested?.status ?? "queued") as ReviewRunStatus,
    target,
    config,
    targetLabel: String(value.targetLabel ?? nested?.targetLabel ?? ""),
    compareTarget: (value.compareTarget ?? nested?.compareTarget ?? null) as NormalizedRun["compareTarget"],
    summary: (value.summary ?? nested?.summary ?? null) as string | null,
    errorMessage: (value.errorMessage
      ?? value.error
      ?? nested?.errorMessage
      ?? nested?.error
      ?? null) as string | null,
    findingCount: Number(
      value.findingCount
      ?? value.findingsCount
      ?? nested?.findingCount
      ?? nested?.findingsCount
      ?? 0,
    ),
    severitySummary: (severitySummary
      ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 }) as NormalizedRun["severitySummary"],
    chatSessionId: (value.chatSessionId ?? nested?.chatSessionId ?? null) as string | null,
    createdAt: normalizeTimestamp(value.createdAt, nested?.createdAt, value.startedAt, nested?.startedAt),
    startedAt: normalizeTimestamp(value.startedAt, nested?.startedAt, value.createdAt, nested?.createdAt),
    endedAt: (value.endedAt
      ?? nested?.endedAt
      ?? value.completedAt
      ?? nested?.completedAt
      ?? null) as string | null,
    updatedAt: normalizeTimestamp(
      value.updatedAt,
      nested?.updatedAt,
      value.endedAt,
      nested?.endedAt,
      value.createdAt,
      nested?.createdAt,
    ),
  };
}

export function normalizeDetail(detail: ReviewRunDetail | Record<string, unknown>): NormalizedDetail {
  const value = detail as Record<string, unknown>;
  const run = normalizeRun(value);
  const nested = value.run && typeof value.run === "object"
    ? (value.run as Record<string, unknown>)
    : null;
  return {
    ...run,
    findings: (value.findings ?? nested?.findings ?? []) as ReviewFinding[],
    artifacts: (value.artifacts ?? nested?.artifacts ?? []) as ReviewArtifact[],
    reviewerRuns: (value.reviewerRuns ?? nested?.reviewerRuns ?? []) as ReviewReviewerRun[],
    candidateFindings: (value.candidateFindings
      ?? nested?.candidateFindings
      ?? []) as NormalizedDetail["candidateFindings"],
    publications: (value.publications ?? nested?.publications ?? []) as ReviewPublication[],
    chatSession: (value.chatSession ?? nested?.chatSession ?? null) as NormalizedDetail["chatSession"],
  };
}

export function laneDisplayName(lane: PageReviewLaunchLane | null | undefined): string {
  if (!lane) return "Unknown lane";
  return lane.name?.trim().length ? lane.name : lane.id;
}

export function branchDisplayName(ref: string | null | undefined): string | null {
  const normalized = (ref ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
  return normalized.length ? normalized : null;
}

export function formatTargetSummary(target: ReviewTarget, compareLabel?: string | null): string {
  if (target.mode === "lane_diff") {
    return compareLabel
      ? `Lane diff against ${compareLabel}`
      : "Lane diff against upstream / default branch";
  }
  if (target.mode === "commit_range") {
    return `Commit range ${target.baseCommit.slice(0, 7)}..${target.headCommit.slice(0, 7)}`;
  }
  if (target.mode === "pr") return "Pull request review";
  return "Uncommitted changes";
}

export function describeRunTarget(
  run: Pick<ReviewRun, "target" | "targetLabel" | "compareTarget">,
): string {
  return run.targetLabel?.trim() || formatTargetSummary(run.target, run.compareTarget?.label ?? null);
}

export function formatSeveritySummary(
  summary: ReviewRun["severitySummary"] | null | undefined,
): string {
  const ordered = ["critical", "high", "medium", "low", "info"] as const;
  const parts = ordered.flatMap((severity) => {
    const count = Number(summary?.[severity] ?? 0);
    if (count <= 0) return [];
    return `${count} ${severity}`;
  });
  return parts.length > 0 ? parts.join(", ") : "0 actionable";
}

export function formatPublicationOutcome(
  detail: Pick<ReviewRunDetail, "config" | "publications"> | null | undefined,
): string {
  if (!detail || detail.config?.publishBehavior !== "auto_publish") return "No findings published.";
  const publishedCount =
    detail.publications?.filter((publication) => publication.status === "published").length ?? 0;
  if (publishedCount === 0) return "No findings published.";
  return `${publishedCount} publication${publishedCount === 1 ? "" : "s"} completed.`;
}

export function failedReviewers(detail: NormalizedDetail | null | undefined): ReviewReviewerRun[] {
  return detail?.reviewerRuns.filter((reviewer) => reviewer.status === "failed") ?? [];
}

export function formatReviewerFailureLabels(reviewers: ReviewReviewerRun[]): string {
  return reviewers
    .map((reviewer) => reviewer.label || reviewer.reviewerKey)
    .filter(Boolean)
    .join(", ");
}

export function formatReviewCompleteLine(
  run: NormalizedRun,
  detail: NormalizedDetail | null,
): string {
  const findingCount = detail?.findings.length ?? run.findingCount ?? 0;
  const countLabel = `${findingCount} ${findingCount === 1 ? "finding" : "findings"}`;
  const severityLabel = formatSeveritySummary(run.severitySummary);
  if (run.status === "completed") {
    const failed = failedReviewers(detail);
    if (failed.length > 0) {
      const failedLabel = formatReviewerFailureLabels(failed);
      return `Review partially complete: ${countLabel} from ${describeRunTarget(run)}. ${severityLabel}. ${failed.length} specialist reviewer${failed.length === 1 ? "" : "s"} failed${failedLabel ? `: ${failedLabel}` : ""}. ${formatPublicationOutcome(detail ?? null)}`;
    }
    return `Review complete: ${countLabel} from ${describeRunTarget(run)}. ${severityLabel}. ${formatPublicationOutcome(detail ?? null)}`;
  }
  if (run.status === "failed") {
    return `Review failed: ${describeRunTarget(run)}. ${run.errorMessage ?? "No error details were recorded."}`;
  }
  if (run.status === "cancelled") {
    return `Review cancelled: ${describeRunTarget(run)}. ${severityLabel}.`;
  }
  return `Review ${run.status}: ${describeRunTarget(run)}. Findings will appear as reviewers finish.`;
}

export function formatReviewEvidenceLine(
  run: NormalizedRun,
  detail: NormalizedDetail | null,
): string | null {
  if (run.status !== "completed") return null;
  const failed = failedReviewers(detail);
  if (failed.length > 0) {
    const totalCount = detail?.reviewerRuns.length ?? 0;
    const completedCount =
      detail?.reviewerRuns.filter((reviewer) => reviewer.status === "completed").length ?? 0;
    const failedLabel = formatReviewerFailureLabels(failed);
    return `Partial review: ${completedCount}/${totalCount} specialist reviewers completed${failedLabel ? `; failed: ${failedLabel}` : ""}. ADE adjudicated only completed reviewer outputs and kept the run local.`;
  }
  const summary = run.summary?.trim() ?? "";
  // The compiled guard, kept: a summary that names the machinery — candidates, a
  // publication threshold — is the engine talking to itself, and the reader gets
  // the reviewer count instead.
  const exposesProcessCopy = /\b(candidate|publication threshold|multi-pass review kept)\b/i.test(summary);
  if (summary && !exposesProcessCopy) return summary;

  const reviewerCount = detail?.reviewerRuns.length ?? 0;
  if (reviewerCount > 0) {
    const finishedCount =
      detail?.reviewerRuns.filter((reviewer) => reviewer.status === "completed").length ?? 0;
    return `${finishedCount} specialist reviewer${finishedCount === 1 ? "" : "s"} completed. Evidence and saved artifacts are available below.`;
  }
  return "Evidence and saved artifacts are available below.";
}

export function formatCompareTargetDescription(
  run: Pick<NormalizedRun, "target" | "compareTarget">,
): string {
  if (run.target?.mode === "working_tree") {
    return "Comparing against the current HEAD commit in this lane.";
  }
  if (run.target?.mode === "commit_range") {
    return `Comparing selected commits ${run.target.baseCommit.slice(0, 7)}..${run.target.headCommit.slice(0, 7)}.`;
  }
  const label = run.compareTarget?.label ?? run.compareTarget?.branchRef ?? run.compareTarget?.ref ?? null;
  if (label) {
    const normalized = branchDisplayName(label) ?? label;
    return `Comparing against local ${normalized}. Fetch or pull first when you want latest remote changes included.`;
  }
  return "Comparing against the local configured base. Fetch or pull first when you want latest remote changes included.";
}

export function resolveRunCompareKind(config: ReviewRunConfig): ReviewLaunchDraft["compareKind"] {
  return config?.compareAgainst?.kind === "lane" ? "lane" : "default_branch";
}

/** The two props the scope diagram's caption pair takes. */
export type ReviewScopeVisualProps = {
  targetMode: ReviewTargetMode;
  compareKind: ReviewLaunchDraft["compareKind"];
  title: string;
  description: string;
  laneName: string;
  compareLaneName: string | null;
  baseRefLabel: string;
  branchRefLabel: string;
  baseCommitLabel: string | null;
  headCommitLabel: string | null;
};

export function buildRunScopeCopy(
  run: Pick<NormalizedRun, "target" | "targetLabel" | "compareTarget" | "config">,
  lane: PageReviewLaunchLane | null,
  compareLane: PageReviewLaunchLane | null,
  defaultBranchLabel: string,
): { title: string; description: string } {
  const laneLabel = laneDisplayName(lane);
  const branchRefLabel = branchDisplayName(lane?.branchRef) ?? laneLabel;
  const baseLabel = branchDisplayName(lane?.baseRef) ?? defaultBranchLabel;
  const laneIsPrimary = lane?.laneType === "primary";
  const defaultCompareLabel = laneIsPrimary ? `local origin/${baseLabel}` : `local ${baseLabel}`;
  const compareKind = resolveRunCompareKind(run.config);
  const selectionLabel = toSelectionModeLabel(run.config?.selectionMode ?? "full_diff");

  if (run.target?.mode === "lane_diff") {
    if (compareKind === "lane") {
      const compareLaneLabel = compareLane
        ? laneDisplayName(compareLane)
        : run.compareTarget?.label ?? "Comparison lane";
      return {
        title: run.targetLabel?.trim() || `${laneLabel} against ${compareLaneLabel}`,
        description: `Reviewed how ${laneLabel} differs from ${compareLaneLabel}. Selection: ${selectionLabel}.`,
      };
    }
    if (run.targetLabel?.trim()) {
      return {
        title: run.targetLabel.trim(),
        description: `${formatCompareTargetDescription(run)} Selection: ${selectionLabel}.`,
      };
    }
    return {
      title: laneIsPrimary
        ? `${laneLabel}: local ${branchRefLabel} vs ${defaultCompareLabel}`
        : `${laneLabel}: branch changes vs ${defaultCompareLabel}`,
      description: `${formatCompareTargetDescription(run)} Selection: ${selectionLabel}.`,
    };
  }
  if (run.target?.mode === "commit_range") {
    const baseShort = run.target.baseCommit.slice(0, 7);
    const headShort = run.target.headCommit.slice(0, 7);
    return {
      title: run.targetLabel?.trim() || `${laneLabel}: commit range ${baseShort}..${headShort}`,
      description: `Reviewed commits after ${baseShort} through ${headShort}. The base commit is excluded; the head commit is included. Selection: ${selectionLabel}.`,
    };
  }
  if (run.target?.mode === "working_tree") {
    return {
      title: run.targetLabel?.trim() || `${laneLabel}: uncommitted changes`,
      description: `${formatCompareTargetDescription(run)} Selection: ${selectionLabel}.`,
    };
  }
  return {
    title: run.targetLabel?.trim() || describeRunTarget(run),
    description: `${formatCompareTargetDescription(run) || "Pull request review."} Selection: ${selectionLabel}.`,
  };
}

export function buildRunScopeVisualProps(
  run: NormalizedRun,
  lane: PageReviewLaunchLane | null,
  compareLane: PageReviewLaunchLane | null,
  defaultBranchLabel: string,
): ReviewScopeVisualProps {
  const compareKind = resolveRunCompareKind(run.config);
  const scopeCopy = buildRunScopeCopy(run, lane, compareLane, defaultBranchLabel);
  const laneLabel = laneDisplayName(lane);
  const branchRefLabel = branchDisplayName(lane?.branchRef) ?? laneLabel;
  const baseLabel = branchDisplayName(lane?.baseRef) ?? defaultBranchLabel;
  const laneIsPrimary = lane?.laneType === "primary";
  const defaultCompareLabel = laneIsPrimary ? `local origin/${baseLabel}` : `local ${baseLabel}`;
  const resolvedCompareLabel =
    run.compareTarget?.label
    ?? branchDisplayName(run.compareTarget?.branchRef)
    ?? branchDisplayName(run.compareTarget?.ref)
    ?? null;

  return {
    targetMode: run.target?.mode ?? "lane_diff",
    compareKind,
    title: scopeCopy.title,
    description: scopeCopy.description,
    laneName: laneLabel,
    compareLaneName:
      compareKind === "lane"
        ? compareLane
          ? laneDisplayName(compareLane)
          : run.compareTarget?.label ?? null
        : null,
    baseRefLabel: resolvedCompareLabel ?? defaultCompareLabel,
    branchRefLabel,
    baseCommitLabel: run.target?.mode === "commit_range" ? run.target.baseCommit.slice(0, 7) : null,
    headCommitLabel: run.target?.mode === "commit_range" ? run.target.headCommit.slice(0, 7) : null,
  };
}

export function isLaunchDraftComplete(draft: ReviewLaunchDraft): boolean {
  if (!draft.laneId.trim()) return false;
  if (draft.targetMode === "lane_diff" && draft.compareKind === "lane" && !draft.compareLaneId.trim()) {
    return false;
  }
  if (draft.targetMode === "commit_range" && (!draft.baseCommit.trim() || !draft.headCommit.trim())) {
    return false;
  }
  if (draft.targetMode === "pr" && !draft.prId.trim()) return false;
  return true;
}

/** Newest first, ties broken by the order the child sent them. */
export function orderLaunchCommits(commits: ReviewLaunchCommit[]): ReviewLaunchCommit[] {
  return commits
    .map((commit, index) => ({ commit, index }))
    .sort((left, right) => {
      const leftTs = Date.parse(left.commit.authoredAt);
      const rightTs = Date.parse(right.commit.authoredAt);
      if (!Number.isNaN(leftTs) && !Number.isNaN(rightTs) && leftTs !== rightTs) {
        return rightTs - leftTs;
      }
      return left.index - right.index;
    })
    .map(({ commit }) => commit);
}

export function getCommitIndex(order: Map<string, number>, sha: string): number | null {
  if (!sha.trim()) return null;
  const value = order.get(sha.trim());
  return typeof value === "number" ? value : null;
}

/** Head must be NEWER than base, and the list is newest-first, so head < base. */
export function isCommitRangeOrdered(
  baseCommit: string,
  headCommit: string,
  order: Map<string, number>,
): boolean {
  const baseIndex = getCommitIndex(order, baseCommit);
  const headIndex = getCommitIndex(order, headCommit);
  if (baseIndex === null || headIndex === null) return false;
  return headIndex < baseIndex;
}

export function getCommitRangeValidationMessage(
  draft: Pick<ReviewLaunchDraft, "targetMode" | "baseCommit" | "headCommit">,
  order: Map<string, number>,
): string | null {
  if (draft.targetMode !== "commit_range") return null;
  if (!draft.baseCommit.trim() || !draft.headCommit.trim()) {
    return "Choose both the earlier base commit and the later head commit.";
  }
  if (!isCommitRangeOrdered(draft.baseCommit, draft.headCommit, order)) {
    return "Choose an earlier base commit and a later head commit.";
  }
  return null;
}

export function describeLaunchCommit(commit: ReviewLaunchCommit | null | undefined): string {
  if (!commit) return "Not selected";
  return `${commit.shortSha} · ${formatRelativeTime(commit.authoredAt)} · ${commit.subject || "No subject"}`;
}

/**
 * The `{target, config}` pair `review.startRun` takes.
 *
 * The compiled page's own function plus the `pr` arm the compiled
 * `PrRequestAiReviewDialog` carried separately — the two built the same pair
 * and only the page had a switch, so the switch grew the fourth case rather
 * than the page growing a second builder.
 */
export function buildTargetConfig(draft: ReviewLaunchDraft): {
  target: ReviewTarget;
  config: ReviewRunConfig;
} {
  const config: ReviewRunConfig = {
    compareAgainst:
      draft.targetMode === "lane_diff" && draft.compareKind === "lane"
        ? { kind: "lane", laneId: draft.compareLaneId || draft.laneId }
        : { kind: "default_branch" },
    selectionMode:
      draft.targetMode === "commit_range"
        ? "selected_commits"
        : draft.targetMode === "working_tree"
          ? "dirty_only"
          : "full_diff",
    dirtyOnly: draft.targetMode === "working_tree",
    modelId: draft.modelId.trim(),
    reasoningEffort: draft.reasoningEffort.trim() || null,
    fastMode: draft.fastMode,
    // A PR review posts back to GitHub; every other target stays on the machine.
    // That is the compiled split, kept: the dialog hard-coded `auto_publish` and
    // the page hard-coded `local_only`.
    publishBehavior: draft.targetMode === "pr" ? draft.publishBehavior : "local_only",
  };

  if (draft.targetMode === "commit_range") {
    return {
      target: {
        mode: "commit_range",
        laneId: draft.laneId,
        baseCommit: draft.baseCommit.trim(),
        headCommit: draft.headCommit.trim(),
      },
      config,
    };
  }
  if (draft.targetMode === "working_tree") {
    return { target: { mode: "working_tree", laneId: draft.laneId }, config };
  }
  if (draft.targetMode === "pr") {
    return { target: { mode: "pr", laneId: draft.laneId, prId: draft.prId.trim() }, config };
  }
  return { target: { mode: "lane_diff", laneId: draft.laneId }, config };
}

/**
 * Why this launch cannot go, in one sentence, or null.
 *
 * The compiled page's `launchValidationMessage` plus the two sentences
 * `plugins/ade-review/launch.js` added for the PR path — the page and the panel
 * refuse the same launches with the same words.
 */
export function launchValidationMessage(
  draft: ReviewLaunchDraft,
  commitOrder: Map<string, number>,
): string | null {
  if (draft.targetMode === "pr" && !draft.laneId.trim()) {
    return "ADE review diffs a local checkout. Open this pull request as a lane first.";
  }
  if (!draft.laneId.trim()) return "Choose a lane before launching a review.";
  if (draft.targetMode === "pr" && !draft.prId.trim()) {
    return "This pull request is not linked in ADE yet.";
  }
  if (draft.targetMode === "lane_diff" && draft.compareKind === "lane" && !draft.compareLaneId.trim()) {
    return "Choose another lane to compare against.";
  }
  return getCommitRangeValidationMessage(draft, commitOrder);
}
