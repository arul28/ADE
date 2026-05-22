import React from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowsClockwise,
  ArrowRight,
  CaretDown,
  ClockCounterClockwise,
  GitBranch,
  MagnifyingGlass,
  Play,
  Plus,
  Sparkle,
  ArrowClockwise,
  ArrowSquareOut,
  Checks,
  CopySimple,
} from "@phosphor-icons/react";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import type { LaneSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import { ResizeGutter } from "../ui/ResizeGutter";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { Group, Panel } from "react-resizable-panels";
import { ReviewLaunchModelControls } from "../shared/ReviewLaunchModelControls";
import {
  cancelReviewRun,
  listReviewLaunchContext,
  listReviewRuns,
  getReviewRunDetail,
  onReviewEvent,
  recordReviewFeedback,
  rerunReview,
  startReviewRun,
} from "./reviewApi";
import { ReviewFindingCard, type FindingActionRequest } from "./ReviewFindingCard";
import { ReviewLearningsPanel } from "./ReviewLearningsPanel";
import {
  formatReviewFindingForClipboard,
  formatReviewFindingsForClipboard,
} from "./reviewFindingCopy";
import type {
  ReviewArtifact,
  ReviewFinding,
  ReviewLaunchCommit,
  ReviewLaunchContext,
  ReviewRun,
  ReviewRunConfig,
  ReviewRunDetail,
  ReviewRunStatus,
  ReviewTarget,
  ReviewTargetMode,
} from "./reviewTypes";
import { buildReviewSearch, readReviewRunId } from "./reviewRouteState";

const REVIEW_CARD_SURFACE = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/75";
const REVIEW_INSET_SURFACE = "rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/45";
const REVIEW_TOGGLE_ACTIVE = "bg-sky-500/15 text-[#F5FAFF] ring-1 ring-sky-400/30";
const REVIEW_LIST_ACTIVE = "border-sky-400/28 bg-sky-500/[0.08]";
const REVIEW_INPUT_FOCUS = "focus:border-sky-400/45";

const REVIEW_SIDEBAR_WIDTH_KEY = "ade.review.sidebarWidth";
const REVIEW_SIDEBAR_MIN_PX = 280;
const REVIEW_SIDEBAR_MAX_PX = 520;
const REVIEW_SIDEBAR_DEFAULT_PX = 360;

function readPersistedReviewSidebarPx(): number {
  try {
    const raw = localStorage.getItem(REVIEW_SIDEBAR_WIDTH_KEY);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= REVIEW_SIDEBAR_MIN_PX && value <= REVIEW_SIDEBAR_MAX_PX) {
        return value;
      }
    }
  } catch {
    /* ignore */
  }
  return REVIEW_SIDEBAR_DEFAULT_PX;
}

function persistReviewSidebarPx(px: number): void {
  try {
    localStorage.setItem(REVIEW_SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

type LaunchDraft = {
  laneId: string;
  targetMode: ReviewTargetMode;
  compareKind: "default_branch" | "lane";
  compareLaneId: string;
  baseCommit: string;
  headCommit: string;
  modelId: string;
  reasoningEffort: string;
  codexFastMode: boolean;
};

const DEFAULT_REVIEW_LAUNCH_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4";
const DEFAULT_REVIEW_REASONING_EFFORT = "medium";

type NormalizedRun = Omit<ReviewRun, "createdAt" | "startedAt" | "updatedAt"> & {
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

type NormalizedDetail = Omit<ReviewRunDetail, "createdAt" | "startedAt" | "updatedAt"> & {
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

function toReviewStatusTone(status: ReviewRunStatus): string {
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

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

function formatRunTimingFooter(run: Pick<NormalizedRun, "startedAt" | "endedAt" | "status">): string {
  const startedLabel = `Started ${formatTime(run.startedAt)}`;
  if (run.endedAt) {
    return `${startedLabel} · Completed ${formatTime(run.endedAt)}`;
  }
  if (run.status === "running" || run.status === "queued") {
    return `${startedLabel} · In progress`;
  }
  return startedLabel;
}

function formatRunSummaryFooter(run: Pick<NormalizedRun, "id" | "startedAt" | "endedAt" | "status">): string {
  const timingFooter = formatRunTimingFooter(run);
  const runId = run.id.trim();
  if (!runId) return timingFooter;
  return `Run ${runId} · ${timingFooter}`;
}

function formatRelativeTime(value: string | null | undefined): string {
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

function toTargetModeLabel(mode: ReviewTargetMode): string {
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

function toSelectionModeLabel(value: ReviewRunConfig["selectionMode"]): string {
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

function toPassLabel(value: string): string {
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

function readArtifactMetaString(artifact: ReviewArtifact, key: string): string | null {
  const value = artifact.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readArtifactMetaNumber(artifact: ReviewArtifact, key: string): number | null {
  const value = artifact.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readArtifactMetaCount(artifact: ReviewArtifact, keys: string[]): number | null {
  for (const key of keys) {
    const numericValue = readArtifactMetaNumber(artifact, key);
    if (numericValue !== null) {
      return numericValue;
    }

    const value = artifact.metadata?.[key];
    if (Array.isArray(value)) {
      return value.length;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function toContextArtifactLabel(artifactType: string): string {
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

function isContextArtifactType(artifactType: string): boolean {
  return artifactType === "provenance_brief"
    || artifactType === "rule_overlays"
    || artifactType === "validation_signals"
    || artifactType === "changed_file_manifest"
    || artifactType === "risk_map";
}

function normalizeTimestamp(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function normalizeRun(run: ReviewRun | Record<string, unknown>): NormalizedRun {
  const value = run as Record<string, unknown>;
  const nested = value.run && typeof value.run === "object" ? (value.run as Record<string, unknown>) : null;
  const target = (value.target ?? nested?.target) as ReviewTarget;
  const config = (value.config ?? nested?.config) as ReviewRunConfig;
  const severitySummary = value.severitySummary ?? nested?.severitySummary ?? nested?.severityCounts ?? null;
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
    errorMessage: (value.errorMessage ?? value.error ?? nested?.errorMessage ?? nested?.error ?? null) as string | null,
    findingCount: Number(value.findingCount ?? value.findingsCount ?? nested?.findingCount ?? nested?.findingsCount ?? 0),
    severitySummary: (severitySummary ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 }) as NormalizedRun["severitySummary"],
    chatSessionId: (value.chatSessionId ?? nested?.chatSessionId ?? null) as string | null,
    createdAt: normalizeTimestamp(value.createdAt, nested?.createdAt, value.startedAt, nested?.startedAt),
    startedAt: normalizeTimestamp(value.startedAt, nested?.startedAt, value.createdAt, nested?.createdAt),
    endedAt: (value.endedAt ?? nested?.endedAt ?? value.completedAt ?? nested?.completedAt ?? null) as string | null,
    updatedAt: normalizeTimestamp(value.updatedAt, nested?.updatedAt, value.endedAt, nested?.endedAt, value.createdAt, nested?.createdAt),
  };
}

function normalizeDetail(detail: ReviewRunDetail | Record<string, unknown>): NormalizedDetail {
  const value = detail as Record<string, unknown>;
  const run = normalizeRun(value);
  const nested = value.run && typeof value.run === "object" ? (value.run as Record<string, unknown>) : null;
  const findings = (value.findings ?? nested?.findings ?? []) as ReviewFinding[];
  const artifacts = (value.artifacts ?? nested?.artifacts ?? []) as ReviewArtifact[];
  const reviewerRuns = (value.reviewerRuns ?? nested?.reviewerRuns ?? []) as NormalizedDetail["reviewerRuns"];
  const candidateFindings = (value.candidateFindings ?? nested?.candidateFindings ?? []) as NormalizedDetail["candidateFindings"];
  const publications = (value.publications ?? nested?.publications ?? []) as NormalizedDetail["publications"];
  const chatSession = (value.chatSession ?? nested?.chatSession ?? null) as ReviewRunDetail["chatSession"];
  return {
    ...run,
    findings,
    artifacts,
    reviewerRuns,
    candidateFindings,
    publications,
    chatSession,
  };
}

function laneDisplayName(lane: LaneSummary | null | undefined): string {
  if (!lane) return "Unknown lane";
  return lane.name?.trim().length ? lane.name : lane.id;
}

function branchDisplayName(ref: string | null | undefined): string | null {
  const normalized = (ref ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
  return normalized.length ? normalized : null;
}

function ScopeBranchNode({
  label,
  caption,
  emphasized = false,
}: {
  label: string;
  caption: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-lg border px-3 py-2.5",
        emphasized
          ? "border-teal-400/25 bg-teal-500/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          : "border-white/[0.08] bg-[var(--color-muted)]/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch size={12} weight="bold" className={emphasized ? "shrink-0 text-teal-400" : "shrink-0 text-[#8FA1B8]"} />
        <span className="truncate font-mono text-[11px] font-semibold text-[#F5FAFF]">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-[#94A3B8]">{caption}</div>
    </div>
  );
}

function ReviewLaunchScopeVisual({
  targetMode,
  compareKind,
  title,
  description,
  laneName,
  compareLaneName,
  baseRefLabel,
  branchRefLabel,
  baseCommitLabel,
  headCommitLabel,
}: {
  targetMode: ReviewTargetMode;
  compareKind: LaunchDraft["compareKind"];
  title: string;
  description: string;
  laneName: string;
  compareLaneName: string | null;
  baseRefLabel: string;
  branchRefLabel: string;
  baseCommitLabel: string | null;
  headCommitLabel: string | null;
}) {
  let leftNode = { label: branchRefLabel, caption: laneName, emphasized: true };
  let rightNode = { label: baseRefLabel, caption: "Base ref", emphasized: false };
  const connectorLabel = "vs.";

  if (targetMode === "lane_diff" && compareKind === "lane") {
    leftNode = {
      label: branchRefLabel,
      caption: laneName,
      emphasized: true,
    };
    rightNode = {
      label: compareLaneName ?? "Comparison lane",
      caption: "Compare against",
      emphasized: false,
    };
  } else if (targetMode === "commit_range") {
    leftNode = {
      label: headCommitLabel ?? "Later commit",
      caption: "Included head",
      emphasized: true,
    };
    rightNode = {
      label: baseCommitLabel ?? "Earlier commit",
      caption: "Excluded base",
      emphasized: false,
    };
  } else if (targetMode === "working_tree") {
    leftNode = {
      label: "Working tree",
      caption: "Staged + unstaged + untracked",
      emphasized: true,
    };
    rightNode = {
      label: "HEAD commit",
      caption: "Checked-out tip",
      emphasized: false,
    };
  }

  return (
    <div className={cn(REVIEW_INSET_SURFACE, "p-3")}>
      <div className="flex items-stretch gap-2">
        <ScopeBranchNode label={leftNode.label} caption={leftNode.caption} emphasized={leftNode.emphasized} />
        <div className="flex shrink-0 flex-col items-center justify-center gap-1 px-0.5 pt-3">
          <div className="flex items-center gap-0.5">
            <div className="h-px w-3 bg-white/[0.08]" />
            <ArrowRight size={12} weight="bold" className="text-sky-400" />
            <div className="h-px w-3 bg-white/[0.08]" />
          </div>
          <span className="font-mono text-[8px] font-bold tracking-[0.14em] text-sky-400/75">
            {connectorLabel}
          </span>
        </div>
        <ScopeBranchNode label={rightNode.label} caption={rightNode.caption} emphasized={rightNode.emphasized} />
      </div>
      <div className="mt-3 text-sm font-semibold text-[#F5FAFF]">{title}</div>
      <div className="mt-1 text-[11px] leading-relaxed text-[#C5D2E6]">{description}</div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={cn(REVIEW_INSET_SURFACE, "p-3")}>
      <div className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</div>
      <div className="mt-1 break-all text-xs text-[#F5FAFF]">{value}</div>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn(REVIEW_CARD_SURFACE, "p-4")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-sky-500/[0.06]">
            <Icon size={15} weight="bold" className="text-sky-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#F5FAFF]">{title}</div>
          </div>
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function formatTargetSummary(target: ReviewTarget, compareLabel?: string | null): string {
  if (target.mode === "lane_diff") {
    return compareLabel ? `Lane diff against ${compareLabel}` : "Lane diff against upstream / default branch";
  }
  if (target.mode === "commit_range") {
    return `Commit range ${target.baseCommit.slice(0, 7)}..${target.headCommit.slice(0, 7)}`;
  }
  if (target.mode === "pr") {
    return "Pull request review";
  }
  return "Uncommitted changes";
}

function describeRunTarget(run: Pick<ReviewRun, "target" | "targetLabel" | "compareTarget">): string {
  return run.targetLabel?.trim() || formatTargetSummary(run.target, run.compareTarget?.label ?? null);
}

function formatSeveritySummary(summary: ReviewRun["severitySummary"] | null | undefined): string {
  const ordered = ["critical", "high", "medium", "low", "info"] as const;
  const parts = ordered.flatMap((severity) => {
    const count = Number(summary?.[severity] ?? 0);
    if (count <= 0) return [];
    return `${count} ${severity}`;
  });
  return parts.length > 0 ? parts.join(", ") : "0 actionable";
}

function formatPublicationOutcome(detail: Pick<ReviewRunDetail, "config" | "publications"> | null | undefined): string {
  if (!detail || detail.config.publishBehavior !== "auto_publish") return "No findings published.";
  const publishedCount = detail.publications?.filter((publication) => publication.status === "published").length ?? 0;
  if (publishedCount === 0) return "No findings published.";
  return `${publishedCount} publication${publishedCount === 1 ? "" : "s"} completed.`;
}

function failedReviewers(detail: NormalizedDetail | null | undefined): NonNullable<NormalizedDetail["reviewerRuns"]> {
  return detail?.reviewerRuns.filter((reviewer) => reviewer.status === "failed") ?? [];
}

function formatReviewerFailureLabels(reviewers: NonNullable<NormalizedDetail["reviewerRuns"]>): string {
  return reviewers
    .map((reviewer) => reviewer.label || reviewer.reviewerKey)
    .filter(Boolean)
    .join(", ");
}

function formatReviewCompleteLine(run: NormalizedRun, detail: NormalizedDetail | null): string {
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

function formatReviewEvidenceLine(run: NormalizedRun, detail: NormalizedDetail | null): string | null {
  if (run.status !== "completed") return null;
  const failed = failedReviewers(detail);
  if (failed.length > 0) {
    const totalCount = detail?.reviewerRuns.length ?? 0;
    const completedCount = detail?.reviewerRuns.filter((reviewer) => reviewer.status === "completed").length ?? 0;
    const failedLabel = formatReviewerFailureLabels(failed);
    return `Partial review: ${completedCount}/${totalCount} specialist reviewers completed${failedLabel ? `; failed: ${failedLabel}` : ""}. ADE adjudicated only completed reviewer outputs and kept the run local.`;
  }
  const summary = run.summary?.trim() ?? "";
  const exposesProcessCopy = /\b(candidate|publication threshold|multi-pass review kept)\b/i.test(summary);
  if (summary && !exposesProcessCopy) {
    return summary;
  }

  const reviewerCount = detail?.reviewerRuns.length ?? 0;
  if (reviewerCount > 0) {
    const finishedCount = detail?.reviewerRuns.filter((reviewer) => reviewer.status === "completed").length ?? 0;
    return `${finishedCount} specialist reviewer${finishedCount === 1 ? "" : "s"} completed. Evidence and saved artifacts are available below.`;
  }

  return "Evidence and saved artifacts are available below.";
}

function formatCompareTargetDescription(
  run: Pick<NormalizedRun, "target" | "compareTarget">,
): string {
  if (run.target.mode === "working_tree") {
    return "Comparing against the current HEAD commit in this lane.";
  }
  if (run.target.mode === "commit_range") {
    return `Comparing selected commits ${run.target.baseCommit.slice(0, 7)}..${run.target.headCommit.slice(0, 7)}.`;
  }
  const label = run.compareTarget?.label ?? run.compareTarget?.branchRef ?? run.compareTarget?.ref ?? null;
  if (label) {
    const normalized = branchDisplayName(label) ?? label;
    return `Comparing against local ${normalized}. Fetch or pull first when you want latest remote changes included.`;
  }
  return "Comparing against the local configured base. Fetch or pull first when you want latest remote changes included.";
}

function resolveRunCompareKind(config: ReviewRunConfig): LaunchDraft["compareKind"] {
  return config.compareAgainst.kind === "lane" ? "lane" : "default_branch";
}

function buildRunScopeCopy(
  run: Pick<NormalizedRun, "target" | "targetLabel" | "compareTarget" | "config">,
  lane: LaneSummary | null,
  compareLane: LaneSummary | null,
  defaultBranchLabel: string,
): { title: string; description: string } {
  const laneLabel = laneDisplayName(lane);
  const branchRefLabel = branchDisplayName(lane?.branchRef) ?? laneLabel;
  const baseLabel = branchDisplayName(lane?.baseRef) ?? defaultBranchLabel;
  const laneIsPrimary = lane?.laneType === "primary";
  const defaultCompareLabel = laneIsPrimary ? `local origin/${baseLabel}` : `local ${baseLabel}`;
  const compareKind = resolveRunCompareKind(run.config);
  const selectionLabel = toSelectionModeLabel(run.config.selectionMode);

  if (run.target.mode === "lane_diff") {
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
  if (run.target.mode === "commit_range") {
    const baseShort = run.target.baseCommit.slice(0, 7);
    const headShort = run.target.headCommit.slice(0, 7);
    return {
      title: run.targetLabel?.trim() || `${laneLabel}: commit range ${baseShort}..${headShort}`,
      description: `Reviewed commits after ${baseShort} through ${headShort}. The base commit is excluded; the head commit is included. Selection: ${selectionLabel}.`,
    };
  }
  if (run.target.mode === "working_tree") {
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

function buildRunScopeVisualProps(
  run: NormalizedRun,
  lane: LaneSummary | null,
  compareLane: LaneSummary | null,
  defaultBranchLabel: string,
): React.ComponentProps<typeof ReviewLaunchScopeVisual> {
  const compareKind = resolveRunCompareKind(run.config);
  const scopeCopy = buildRunScopeCopy(run, lane, compareLane, defaultBranchLabel);
  const laneLabel = laneDisplayName(lane);
  const branchRefLabel = branchDisplayName(lane?.branchRef) ?? laneLabel;
  const baseLabel = branchDisplayName(lane?.baseRef) ?? defaultBranchLabel;
  const laneIsPrimary = lane?.laneType === "primary";
  const defaultCompareLabel = laneIsPrimary ? `local origin/${baseLabel}` : `local ${baseLabel}`;
  const resolvedCompareLabel = run.compareTarget?.label
    ?? branchDisplayName(run.compareTarget?.branchRef)
    ?? branchDisplayName(run.compareTarget?.ref)
    ?? null;

  return {
    targetMode: run.target.mode,
    compareKind,
    title: scopeCopy.title,
    description: scopeCopy.description,
    laneName: laneLabel,
    compareLaneName: compareKind === "lane"
      ? (compareLane ? laneDisplayName(compareLane) : run.compareTarget?.label ?? null)
      : null,
    baseRefLabel: resolvedCompareLabel ?? defaultCompareLabel,
    branchRefLabel,
    baseCommitLabel: run.target.mode === "commit_range" ? run.target.baseCommit.slice(0, 7) : null,
    headCommitLabel: run.target.mode === "commit_range" ? run.target.headCommit.slice(0, 7) : null,
  };
}

function isLaunchDraftComplete(draft: LaunchDraft): boolean {
  if (!draft.laneId.trim()) return false;
  if (draft.targetMode === "lane_diff" && draft.compareKind === "lane" && !draft.compareLaneId.trim()) return false;
  if (draft.targetMode === "commit_range" && (!draft.baseCommit.trim() || !draft.headCommit.trim())) return false;
  return true;
}

function orderLaunchCommits(commits: ReviewLaunchCommit[]): ReviewLaunchCommit[] {
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

function getCommitIndex(order: Map<string, number>, sha: string): number | null {
  if (!sha.trim()) return null;
  const value = order.get(sha.trim());
  return typeof value === "number" ? value : null;
}

function isCommitRangeOrdered(baseCommit: string, headCommit: string, order: Map<string, number>): boolean {
  const baseIndex = getCommitIndex(order, baseCommit);
  const headIndex = getCommitIndex(order, headCommit);
  if (baseIndex === null || headIndex === null) return false;
  return headIndex < baseIndex;
}

function getCommitRangeValidationMessage(
  draft: Pick<LaunchDraft, "targetMode" | "baseCommit" | "headCommit">,
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

function describeLaunchCommit(commit: ReviewLaunchCommit | null | undefined): string {
  if (!commit) return "Not selected";
  return `${commit.shortSha} · ${formatRelativeTime(commit.authoredAt)} · ${commit.subject || "No subject"}`;
}

function CommitSelectField({
  label,
  helper,
  value,
  options,
  selectedCommit,
  disabled,
  onChange,
}: {
  label: string;
  helper: string;
  value: string;
  options: ReviewLaunchCommit[];
  selectedCommit: ReviewLaunchCommit | null;
  disabled: boolean;
  onChange: (sha: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</span>
      <div className="relative">
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className={cn("h-10 w-full appearance-none rounded-xl border border-white/[0.08] bg-[var(--color-muted)]/55 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60", REVIEW_INPUT_FOCUS)}
        >
          <option value="">{disabled ? "Not enough commits" : `Choose ${label.toLowerCase()}...`}</option>
          {options.map((commit) => (
            <option key={commit.sha} value={commit.sha}>
              {describeLaunchCommit(commit)}
            </option>
          ))}
        </select>
        <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA1B8]" />
      </div>
      <div className="text-[11px] text-[#94A3B8]">{helper}</div>
      {selectedCommit ? (
        <div className={cn(REVIEW_INSET_SURFACE, "p-3")}>
          <div className="flex flex-wrap items-center gap-2">
            <Chip className="text-[9px]">{selectedCommit.shortSha}</Chip>
            <Chip className="text-[9px]">{formatRelativeTime(selectedCommit.authoredAt)}</Chip>
            <Chip className="text-[9px]">{selectedCommit.pushed ? "Remote" : "Local only"}</Chip>
          </div>
          <div className="mt-2 text-xs font-medium text-[#F5FAFF]">{selectedCommit.subject || "No subject"}</div>
          <div className="mt-1 text-[11px] text-[#94A3B8]">{formatTime(selectedCommit.authoredAt)}</div>
        </div>
      ) : null}
    </label>
  );
}

function buildTargetConfig(
  targetMode: ReviewTargetMode,
  draft: LaunchDraft,
): { target: ReviewTarget; config: ReviewRunConfig } {
  if (targetMode === "lane_diff") {
    const compareAgainst: ReviewRunConfig["compareAgainst"] = draft.compareKind === "lane"
      ? { kind: "lane", laneId: draft.compareLaneId || draft.laneId }
      : { kind: "default_branch" };
    return {
      target: { mode: "lane_diff", laneId: draft.laneId },
      config: {
        compareAgainst,
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: draft.modelId.trim(),
        reasoningEffort: draft.reasoningEffort.trim() || null,
        codexFastMode: draft.codexFastMode,
        publishBehavior: "local_only",
      },
    };
  }

  if (targetMode === "commit_range") {
    return {
      target: { mode: "commit_range", laneId: draft.laneId, baseCommit: draft.baseCommit.trim(), headCommit: draft.headCommit.trim() },
      config: {
        compareAgainst: { kind: "default_branch" },
        selectionMode: "selected_commits",
        dirtyOnly: false,
        modelId: draft.modelId.trim(),
        reasoningEffort: draft.reasoningEffort.trim() || null,
        codexFastMode: draft.codexFastMode,
        publishBehavior: "local_only",
      },
    };
  }

  return {
    target: { mode: "working_tree", laneId: draft.laneId },
    config: {
      compareAgainst: { kind: "default_branch" },
      selectionMode: "dirty_only",
      dirtyOnly: true,
      modelId: draft.modelId.trim(),
      reasoningEffort: draft.reasoningEffort.trim() || null,
      codexFastMode: draft.codexFastMode,
      publishBehavior: "local_only",
    },
  };
}

export function ReviewPage({ active = true }: { active?: boolean } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const lanes = useAppStore((s) => s.lanes ?? []);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const selectLane = useAppStore((s) => s.selectLane);

  const laneOptions = React.useMemo(() => lanes.filter((lane) => Boolean(lane?.id)), [lanes]);
  const laneById = React.useMemo(() => new Map(laneOptions.map((lane) => [lane.id, lane])), [laneOptions]);
  const defaultLaneId = selectedLaneId && laneById.has(selectedLaneId) ? selectedLaneId : laneOptions[0]?.id ?? null;

  const defaultSidebarPx = React.useMemo(() => readPersistedReviewSidebarPx(), []);

  const [launchContext, setLaunchContext] = React.useState<ReviewLaunchContext | null>(null);
  const [runs, setRuns] = React.useState<NormalizedRun[]>([]);
  const [detail, setDetail] = React.useState<NormalizedDetail | null>(null);
  const [loadingRuns, setLoadingRuns] = React.useState(false);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [loadingLaunch, setLoadingLaunch] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(readReviewRunId(location.search));
  const [launching, setLaunching] = React.useState(false);
  const [launchModalOpen, setLaunchModalOpen] = React.useState(false);
  const [copyAllFindingsState, setCopyAllFindingsState] = React.useState<"idle" | "copied" | "error">("idle");
  const [launchDraft, setLaunchDraft] = React.useState<LaunchDraft>(() => ({
    laneId: defaultLaneId ?? "",
    targetMode: "lane_diff",
    compareKind: "default_branch",
    compareLaneId: "",
    baseCommit: "",
    headCommit: "",
    modelId: DEFAULT_REVIEW_LAUNCH_MODEL_ID,
    reasoningEffort: DEFAULT_REVIEW_REASONING_EFFORT,
    codexFastMode: false,
  }));
  const recommendedModelHydratedRef = React.useRef(false);

  const selectedLane = laneById.get(launchDraft.laneId) ?? laneById.get(defaultLaneId ?? "") ?? null;
  const selectedDetail = React.useMemo(
    () => (detail && detail.id === selectedRunId ? detail : null),
    [detail, selectedRunId],
  );
  const selectedRun = React.useMemo(
    () => selectedDetail ?? (selectedRunId ? runs.find((run) => run.id === selectedRunId) ?? null : runs[0] ?? null),
    [runs, selectedDetail, selectedRunId],
  );
  const selectedRunLane = React.useMemo(
    () => (selectedRun ? laneById.get(selectedRun.laneId) ?? null : null),
    [laneById, selectedRun],
  );
  const selectedRunCompareLane = React.useMemo(() => {
    if (!selectedRun || selectedRun.config.compareAgainst.kind !== "lane") return null;
    return laneById.get(selectedRun.config.compareAgainst.laneId) ?? null;
  }, [laneById, selectedRun]);
  const selectedRunScopeVisual = React.useMemo(() => {
    if (!selectedRun) return null;
    return buildRunScopeVisualProps(
      selectedRun,
      selectedRunLane,
      selectedRunCompareLane,
      launchContext?.defaultBranchName?.trim() || "default branch",
    );
  }, [launchContext?.defaultBranchName, selectedRun, selectedRunCompareLane, selectedRunLane]);
  const selectedPassArtifacts = React.useMemo(
    () => selectedDetail?.artifacts?.filter((artifact) => artifact.artifactType === "pass_findings") ?? [],
    [selectedDetail?.artifacts],
  );
  const selectedAdjudicationArtifact = React.useMemo(
    () => selectedDetail?.artifacts?.find((artifact) => artifact.artifactType === "adjudication_result") ?? null,
    [selectedDetail?.artifacts],
  );
  const selectedMergedArtifact = React.useMemo(
    () => selectedDetail?.artifacts?.find((artifact) => artifact.artifactType === "merged_findings") ?? null,
    [selectedDetail?.artifacts],
  );
  const selectedContextArtifacts = React.useMemo(
    () => selectedDetail?.artifacts?.filter((artifact) => isContextArtifactType(String(artifact.artifactType))) ?? [],
    [selectedDetail?.artifacts],
  );
  const selectedReviewerTranscripts = React.useMemo(
    () => selectedDetail?.reviewerRuns.filter((reviewer) => Boolean(reviewer.chatSessionId)) ?? [],
    [selectedDetail?.reviewerRuns],
  );

  React.useEffect(() => {
    if (!launchDraft.laneId && defaultLaneId) {
      setLaunchDraft((prev) => ({ ...prev, laneId: defaultLaneId }));
    }
  }, [defaultLaneId, launchDraft.laneId]);

  React.useEffect(() => {
    if (copyAllFindingsState === "idle") return undefined;
    const timer = window.setTimeout(() => setCopyAllFindingsState("idle"), 1_500);
    return () => window.clearTimeout(timer);
  }, [copyAllFindingsState]);

  React.useEffect(() => {
    const nextRunId = readReviewRunId(location.search);
    setSelectedRunId((current) => current === nextRunId ? current : nextRunId);
  }, [location.search]);

  React.useEffect(() => {
    if (selectedRunId === null && runs.length > 0) {
      setSelectedRunId(runs[0]?.id ?? null);
    }
  }, [runs, selectedRunId]);

  React.useEffect(() => {
    if (!selectedRunId || selectedDetail || runs.length === 0) return;
    if (runs.some((run) => run.id === selectedRunId)) return;
    setSelectedRunId(runs[0]?.id ?? null);
  }, [runs, selectedDetail, selectedRunId]);

  React.useEffect(() => {
    const nextSearch = buildReviewSearch(selectedRunId);
    if (location.search === nextSearch) return;
    void navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  }, [location.pathname, location.search, navigate, selectedRunId]);

  const refreshLaunchContext = React.useCallback(async () => {
    setLoadingLaunch(true);
    try {
      const next = await listReviewLaunchContext();
      setLaunchContext(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingLaunch(false);
    }
  }, []);

  const refreshRuns = React.useCallback(async (laneId?: string | null) => {
    setLoadingRuns(true);
    try {
      const next = await listReviewRuns({ laneId: laneId ?? null, limit: 120 });
      const normalized = next.map((run) => normalizeRun(run));
      setRuns(normalized);
      setError(null);
      if (selectedRunId && normalized.some((run) => run.id === selectedRunId)) {
        return normalized;
      }
      if (!selectedRunId && normalized.length > 0) {
        setSelectedRunId(normalized[0]?.id ?? null);
      }
      return normalized;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoadingRuns(false);
    }
  }, [selectedRunId]);

  const loadDetail = React.useCallback(async (runId: string | null, options?: { clearError?: boolean }) => {
    if (!runId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const next = await getReviewRunDetail(runId);
      setDetail(next ? normalizeDetail(next) : null);
      if (options?.clearError !== false) {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  React.useEffect(() => {
    if (!active) return;
    void refreshLaunchContext();
  }, [active, refreshLaunchContext]);

  React.useEffect(() => {
    if (!active) return;
    void refreshRuns();
  }, [active, refreshRuns]);

  React.useEffect(() => {
    if (!active) return;
    void loadDetail(selectedRunId);
  }, [active, loadDetail, selectedRunId]);

  React.useEffect(() => {
    if (!active) return;
    const unsub = onReviewEvent((event) => {
      if (event.type === "suppressions-updated") return;
      void refreshRuns();
      const eventRunId = "runId" in event ? event.runId : undefined;
      if (eventRunId === selectedRunId) {
        void loadDetail(selectedRunId);
      }
    });
    return () => {
      try {
        unsub();
      } catch {
        // ignore bridge teardown issues
      }
    };
  }, [active, loadDetail, refreshRuns, selectedRunId]);

  React.useEffect(() => {
    if (!launchContext?.defaultLaneId || launchDraft.laneId) return;
    setLaunchDraft((prev) => ({ ...prev, laneId: launchContext.defaultLaneId ?? defaultLaneId ?? "" }));
  }, [defaultLaneId, launchContext?.defaultLaneId, launchDraft.laneId]);

  React.useEffect(() => {
    const recommendedModelId = launchContext?.recommendedModelId?.trim();
    if (!recommendedModelId || recommendedModelHydratedRef.current) return;
    recommendedModelHydratedRef.current = true;
    setLaunchDraft((prev) => {
      const currentModelId = prev.modelId.trim();
      if (currentModelId && currentModelId !== DEFAULT_REVIEW_LAUNCH_MODEL_ID) {
        return prev;
      }
      if (currentModelId === recommendedModelId) return prev;
      return { ...prev, modelId: recommendedModelId };
    });
  }, [launchContext?.recommendedModelId]);

  React.useEffect(() => {
    setLaunchDraft((prev) => {
      if (prev.targetMode !== "commit_range") return prev;
      const laneCommits = orderLaunchCommits(launchContext?.recentCommitsByLane?.[prev.laneId] ?? []);
      if (laneCommits.length < 2) {
        if (!prev.baseCommit && !prev.headCommit) return prev;
        return { ...prev, baseCommit: "", headCommit: "" };
      }
      const commitOrder = new Map(laneCommits.map((commit, index) => [commit.sha, index]));
      let nextHeadCommit = prev.headCommit;
      let nextBaseCommit = prev.baseCommit;
      if (!nextHeadCommit || !commitOrder.has(nextHeadCommit)) {
        nextHeadCommit = laneCommits[0]?.sha ?? "";
      }
      if (!nextBaseCommit || !commitOrder.has(nextBaseCommit)) {
        nextBaseCommit = laneCommits[1]?.sha ?? "";
      }
      if (!isCommitRangeOrdered(nextBaseCommit, nextHeadCommit, commitOrder)) {
        nextHeadCommit = laneCommits[0]?.sha ?? "";
        nextBaseCommit = laneCommits[1]?.sha ?? "";
      }
      if (nextBaseCommit === prev.baseCommit && nextHeadCommit === prev.headCommit) {
        return prev;
      }
      return {
        ...prev,
        baseCommit: nextBaseCommit,
        headCommit: nextHeadCommit,
      };
    });
  }, [launchContext?.recentCommitsByLane, launchDraft.laneId, launchDraft.targetMode]);

  const defaultBranchLabel = launchContext?.defaultBranchName?.trim() || "default branch";
  const selectedCompareLane = launchDraft.compareKind === "lane"
    ? laneById.get(launchDraft.compareLaneId) ?? null
    : null;
  const selectedLaneBranchLabel = branchDisplayName(selectedLane?.branchRef) ?? laneDisplayName(selectedLane);
  const selectedLaneBaseLabel = branchDisplayName(selectedLane?.baseRef) ?? defaultBranchLabel;
  const selectedLaneIsPrimary = selectedLane?.laneType === "primary";
  const selectedLaneDefaultCompareLabel = selectedLaneIsPrimary
    ? `local origin/${selectedLaneBaseLabel}`
    : `local ${selectedLaneBaseLabel}`;
  const defaultCompareOptionLabel = selectedLaneIsPrimary
    ? `Compare with origin/${selectedLaneBaseLabel}`
    : `Compare with ${selectedLaneBaseLabel}`;
  const selectedLaneCommits = React.useMemo(
    () => orderLaunchCommits(launchContext?.recentCommitsByLane?.[launchDraft.laneId] ?? []),
    [launchContext?.recentCommitsByLane, launchDraft.laneId],
  );
  const commitOrder = React.useMemo(
    () => new Map(selectedLaneCommits.map((commit, index) => [commit.sha, index])),
    [selectedLaneCommits],
  );
  const selectedBaseCommit = React.useMemo(
    () => selectedLaneCommits.find((commit) => commit.sha === launchDraft.baseCommit) ?? null,
    [selectedLaneCommits, launchDraft.baseCommit],
  );
  const selectedHeadCommit = React.useMemo(
    () => selectedLaneCommits.find((commit) => commit.sha === launchDraft.headCommit) ?? null,
    [selectedLaneCommits, launchDraft.headCommit],
  );
  const baseCommitOptions = React.useMemo(() => {
    if (selectedLaneCommits.length < 2) return [];
    const headIndex = getCommitIndex(commitOrder, launchDraft.headCommit);
    const candidates = headIndex === null
      ? selectedLaneCommits.slice(1)
      : selectedLaneCommits.filter((_, index) => index > headIndex);
    return [...candidates].reverse();
  }, [commitOrder, launchDraft.headCommit, selectedLaneCommits]);
  const headCommitOptions = React.useMemo(() => {
    if (selectedLaneCommits.length < 2) return [];
    const baseIndex = getCommitIndex(commitOrder, launchDraft.baseCommit);
    const candidates = baseIndex === null
      ? selectedLaneCommits.slice(0, -1)
      : selectedLaneCommits.filter((_, index) => index < baseIndex);
    return [...candidates].reverse();
  }, [commitOrder, launchDraft.baseCommit, selectedLaneCommits]);
  const commitRangeValidationMessage = React.useMemo(
    () => getCommitRangeValidationMessage(launchDraft, commitOrder),
    [commitOrder, launchDraft],
  );
  const launchValidationMessage = React.useMemo(() => {
    if (!launchDraft.laneId.trim()) return "Choose a lane before launching a review.";
    if (launchDraft.targetMode === "lane_diff" && launchDraft.compareKind === "lane" && !launchDraft.compareLaneId.trim()) {
      return "Choose another lane to compare against.";
    }
    return commitRangeValidationMessage;
  }, [commitRangeValidationMessage, launchDraft]);
  const launchScope = React.useMemo(() => {
    const laneLabel = laneDisplayName(selectedLane);
    if (launchDraft.targetMode === "lane_diff") {
      if (launchDraft.compareKind === "lane") {
        return {
          title: selectedCompareLane
            ? `${laneLabel} against ${laneDisplayName(selectedCompareLane)}`
            : `${laneLabel} against another lane`,
          description: selectedCompareLane
            ? `Review how ${laneLabel} differs from ${laneDisplayName(selectedCompareLane)}.`
            : "Choose the comparison lane to finish the lane-to-lane review setup.",
        };
      }
      return {
        title: selectedLaneIsPrimary
          ? `${laneLabel}: local ${selectedLaneBranchLabel} vs ${selectedLaneDefaultCompareLabel}`
          : `${laneLabel}: branch changes vs ${selectedLaneDefaultCompareLabel}`,
        description: selectedLaneIsPrimary
          ? `Reviews local commits on ${selectedLaneBranchLabel} against ${selectedLaneDefaultCompareLabel}. Fetch or pull first when you want latest remote changes included.`
          : `Reviews changes on ${selectedLaneBranchLabel} since it split from ${selectedLaneDefaultCompareLabel}. Pull or merge remote changes into ${selectedLaneBaseLabel} first when you want them included.`,
      };
    }
    if (launchDraft.targetMode === "commit_range") {
      return {
        title: `${laneLabel}: selected commit range`,
        description: selectedBaseCommit && selectedHeadCommit
          ? `Review commits after ${selectedBaseCommit.shortSha} and up to ${selectedHeadCommit.shortSha}. The earlier base commit is excluded; the later head commit is included.`
          : "Review only a slice of this lane's history. Pick the earlier commit first, then the later commit.",
      };
    }
    return {
      title: `${laneLabel}: uncommitted changes`,
      description: "Review the staged, unstaged, and untracked changes currently in this lane. This compares the working tree to the checked-out HEAD commit, not to another lane.",
    };
  }, [
    launchDraft.compareKind,
    launchDraft.targetMode,
    selectedBaseCommit,
    selectedCompareLane,
    selectedHeadCommit,
    selectedLane,
    selectedLaneBaseLabel,
    selectedLaneBranchLabel,
    selectedLaneDefaultCompareLabel,
    selectedLaneIsPrimary,
  ]);
  const launchReady = isLaunchDraftComplete(launchDraft) && !launchValidationMessage;

  const handleSelectRun = React.useCallback((runId: string) => {
    setSelectedRunId(runId);
    setSearchParams((prev) => {
      if (runId) prev.set("runId", runId);
      else prev.delete("runId");
      return prev;
    });
  }, [setSearchParams]);

  const handleLaunch = React.useCallback(async () => {
    const lane = laneById.get(launchDraft.laneId) ?? null;
    if (!lane) {
      setError("Choose a lane before launching a review.");
      return;
    }
    if (launchValidationMessage) {
      setError(launchValidationMessage);
      return;
    }
    const { target, config } = buildTargetConfig(launchDraft.targetMode, launchDraft);
    setLaunching(true);
    setError(null);
    try {
      const result = await startReviewRun({ target, config });
      if (!result.runId) {
        setError("Review launch did not return a run id.");
        return;
      }
      const nextRunId = result.runId;
      await refreshRuns();
      setSelectedRunId(nextRunId);
      setSearchParams((prev) => {
        prev.set("runId", nextRunId);
        return prev;
      });
      setLaunchModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }, [launchDraft, laneById, launchValidationMessage, refreshRuns, setSearchParams]);

  const handleRerun = React.useCallback(async (run: NormalizedRun | null) => {
    if (!run) return;
    setLaunching(true);
    setError(null);
    try {
      const result = await rerunReview(run.id);
      if (!result.runId) {
        setError("Review rerun did not return a new run id.");
        return;
      }
      const nextRunId = result.runId;
      await refreshRuns();
      setSelectedRunId(nextRunId);
      setSearchParams((prev) => {
        prev.set("runId", nextRunId);
        return prev;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }, [refreshRuns, setSearchParams]);

  const updateDraft = React.useCallback(<K extends keyof LaunchDraft>(key: K, value: LaunchDraft[K]) => {
    setLaunchDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleCommitSelection = React.useCallback((kind: "base" | "head", sha: string) => {
    setLaunchDraft((prev) => {
      if (prev.targetMode !== "commit_range") return prev;
      let nextBaseCommit = kind === "base" ? sha : prev.baseCommit;
      let nextHeadCommit = kind === "head" ? sha : prev.headCommit;
      const selectedIndex = getCommitIndex(commitOrder, sha);
      if (selectedIndex !== null) {
        if (kind === "base") {
          const currentHeadIndex = getCommitIndex(commitOrder, nextHeadCommit);
          if (currentHeadIndex === null || currentHeadIndex >= selectedIndex) {
            nextHeadCommit = selectedLaneCommits[selectedIndex - 1]?.sha ?? "";
          }
        } else {
          const currentBaseIndex = getCommitIndex(commitOrder, nextBaseCommit);
          if (currentBaseIndex === null || currentBaseIndex <= selectedIndex) {
            nextBaseCommit = selectedLaneCommits[selectedIndex + 1]?.sha ?? "";
          }
        }
      }
      return {
        ...prev,
        baseCommit: nextBaseCommit,
        headCommit: nextHeadCommit,
      };
    });
  }, [commitOrder, selectedLaneCommits]);

  const resolveFindingTarget = React.useCallback((finding: ReviewFinding): { laneId: string; target: string; rootPath: string | null } | null => {
    const path = finding.filePath?.trim();
    const laneId = selectedRun?.laneId ?? launchDraft.laneId;
    if (!path || !laneId) return null;
    const lane = laneById.get(laneId) ?? null;
    const rootPath = lane?.worktreePath ?? null;
    const target = rootPath && path.startsWith(rootPath)
      ? path.slice(rootPath.length).replace(/^\/+/, "")
      : path.startsWith("/") ? path.replace(/^\//, "") : path;
    return { laneId, target, rootPath };
  }, [laneById, launchDraft.laneId, selectedRun?.laneId]);

  const handleOpenFindingInFiles = React.useCallback((finding: ReviewFinding) => {
    const resolved = resolveFindingTarget(finding);
    if (!resolved) return;
    void navigate("/files", {
      state: {
        openFilePath: resolved.target,
        laneId: resolved.laneId,
      },
    });
  }, [navigate, resolveFindingTarget]);

  const handleOpenFindingInEditor = React.useCallback((finding: ReviewFinding) => {
    const resolved = resolveFindingTarget(finding);
    if (!resolved?.rootPath) return;
    const appBridge = (window as Window & { ade?: { app?: { openPathInEditor?: (arg: { rootPath: string; target: string }) => Promise<void> } } }).ade?.app;
    void (appBridge?.openPathInEditor?.({ rootPath: resolved.rootPath, target: resolved.target }) ?? Promise.resolve()).catch(() => {});
  }, [resolveFindingTarget]);

  const handleOpenTranscriptInWork = React.useCallback((sessionId: string | null | undefined, laneId: string) => {
    if (!sessionId) return;
    selectLane(laneId);
    focusSession(sessionId);
    void navigate("/work");
  }, [focusSession, navigate, selectLane]);

  const [showLearnings, setShowLearnings] = React.useState(false);
  const [severityFilter, setSeverityFilter] = React.useState<"all" | "critical" | "high" | "medium" | "low" | "info">("all");
  const [showSuppressed, setShowSuppressed] = React.useState(false);
  const [feedbackError, setFeedbackError] = React.useState<string | null>(null);
  const [cancelInFlight, setCancelInFlight] = React.useState(false);
  const [refreshingTab, setRefreshingTab] = React.useState(false);

  const refreshReviewTab = React.useCallback(async () => {
    setRefreshingTab(true);
    try {
      await Promise.all([
        refreshLaunchContext(),
        refreshRuns(),
        selectedRunId ? loadDetail(selectedRunId, { clearError: false }) : Promise.resolve(),
      ]);
    } finally {
      setRefreshingTab(false);
    }
  }, [loadDetail, refreshLaunchContext, refreshRuns, selectedRunId]);

  const handleFindingAction = React.useCallback(async (req: FindingActionRequest) => {
    setFeedbackError(null);
    try {
      await recordReviewFeedback({
        findingId: req.finding.id,
        kind: req.kind,
        reason: req.reason ?? null,
        note: req.note ?? null,
        snoozeDurationMs: req.snoozeDurationMs ?? null,
        suppression: req.suppression ?? null,
      });
      if (selectedRunId) await loadDetail(selectedRunId);
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDetail, selectedRunId]);

  const copyTextToClipboard = React.useCallback(async (text: string) => {
    if (window.ade?.app?.writeClipboardText) {
      await window.ade.app.writeClipboardText(text);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("Clipboard is not available.");
  }, []);

  const handleCopyFinding = React.useCallback(async (finding: ReviewFinding) => {
    await copyTextToClipboard(formatReviewFindingForClipboard(finding));
  }, [copyTextToClipboard]);

  const handleCopyAllFindings = React.useCallback(async (findings: ReviewFinding[]) => {
    try {
      await copyTextToClipboard(formatReviewFindingsForClipboard({
        findings,
        targetLabel: selectedRun?.targetLabel ?? null,
        summary: selectedRun?.summary ?? null,
      }));
      setCopyAllFindingsState("copied");
    } catch {
      setCopyAllFindingsState("error");
    }
  }, [copyTextToClipboard, selectedRun?.summary, selectedRun?.targetLabel]);

  const handleCancelRun = React.useCallback(async (run: NormalizedRun) => {
    if (run.status !== "running" && run.status !== "queued") return;
    setCancelInFlight(true);
    try {
      await cancelReviewRun(run.id);
      await refreshRuns();
      if (selectedRunId === run.id) await loadDetail(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelInFlight(false);
    }
  }, [loadDetail, refreshRuns, selectedRunId]);

  const launchFormContent = (
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="font-mono text-[11px] font-medium tracking-[0.02em] text-[#8FA1B8]">Lane to review</span>
        <div className="relative">
          <select
            className={cn("h-9 w-full appearance-none rounded-xl border border-white/[0.08] bg-[var(--color-muted)]/55 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors", REVIEW_INPUT_FOCUS)}
            value={launchDraft.laneId}
            onChange={(e) => updateDraft("laneId", e.target.value)}
          >
            {laneOptions.map((lane) => (
              <option key={lane.id} value={lane.id}>{lane.name}</option>
            ))}
          </select>
          <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA1B8]" />
        </div>
      </label>

      <label className="grid gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Target mode</span>
        <div className={cn("grid grid-cols-3 gap-1 p-1", REVIEW_INSET_SURFACE)}>
          {([
            ["lane_diff", "Lane diff"],
            ["commit_range", "Commit range"],
            ["working_tree", "Uncommitted changes"],
          ] as Array<[ReviewTargetMode, string]>).map(([mode, label]) => {
            const active = launchDraft.targetMode === mode;
            return (
              <button
                key={mode}
                type="button"
                className={cn(
                  "rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors",
                  active ? REVIEW_TOGGLE_ACTIVE : "text-[#94A3B8] hover:text-[#F5FAFF]"
                )}
                onClick={() => updateDraft("targetMode", mode)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </label>

      {launchDraft.targetMode === "lane_diff" ? (
        <div className={cn("grid gap-2 p-3", REVIEW_INSET_SURFACE)}>
          <label className="grid gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Compare against</span>
            <div className={cn("grid grid-cols-2 gap-1 p-1", REVIEW_INSET_SURFACE)}>
              {(["default_branch", "lane"] as const).map((kind) => {
                const active = launchDraft.compareKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={cn(
                      "rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors",
                      active ? REVIEW_TOGGLE_ACTIVE : "text-[#94A3B8] hover:text-[#F5FAFF]"
                    )}
                    onClick={() => updateDraft("compareKind", kind)}
                  >
                    {kind === "default_branch" ? defaultCompareOptionLabel : "Another lane"}
                  </button>
                );
              })}
            </div>
          </label>
          {launchDraft.compareKind === "lane" ? (
            <label className="grid gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Compare lane</span>
              <div className="relative">
                <select
                  className={cn("h-9 w-full appearance-none rounded-xl border border-white/[0.08] bg-[var(--color-muted)]/55 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors", REVIEW_INPUT_FOCUS)}
                  value={launchDraft.compareLaneId}
                  onChange={(e) => updateDraft("compareLaneId", e.target.value)}
                >
                  <option value="">Choose lane...</option>
                  {laneOptions.filter((lane) => lane.id !== launchDraft.laneId).map((lane) => (
                    <option key={lane.id} value={lane.id}>{lane.name}</option>
                  ))}
                </select>
                <CaretDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA1B8]" />
              </div>
            </label>
          ) : null}
        </div>
      ) : null}

      <ReviewLaunchScopeVisual
        targetMode={launchDraft.targetMode}
        compareKind={launchDraft.compareKind}
        title={launchScope.title}
        description={launchScope.description}
        laneName={laneDisplayName(selectedLane)}
        compareLaneName={selectedCompareLane ? laneDisplayName(selectedCompareLane) : null}
        baseRefLabel={selectedLaneDefaultCompareLabel}
        branchRefLabel={selectedLaneBranchLabel ?? laneDisplayName(selectedLane)}
        baseCommitLabel={selectedBaseCommit?.shortSha ?? null}
        headCommitLabel={selectedHeadCommit?.shortSha ?? null}
      />

      {launchDraft.targetMode === "commit_range" ? (
        <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
          <div className="text-[11px] text-[#C5D2E6]">
            Review only part of this lane's history. Commit lists are ordered from earlier to later so you can pick the start and end of the range without typing raw SHAs.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <CommitSelectField
              label="Earlier commit (base)"
              helper="Start just after this commit. ADE excludes the base commit itself."
              value={launchDraft.baseCommit}
              options={baseCommitOptions}
              selectedCommit={selectedBaseCommit}
              disabled={selectedLaneCommits.length < 2}
              onChange={(sha) => handleCommitSelection("base", sha)}
            />
            <CommitSelectField
              label="Later commit (head)"
              helper="Stop at this commit. ADE includes the head commit."
              value={launchDraft.headCommit}
              options={headCommitOptions}
              selectedCommit={selectedHeadCommit}
              disabled={selectedLaneCommits.length < 2}
              onChange={(sha) => handleCommitSelection("head", sha)}
            />
          </div>
          {launchDraft.laneId && selectedLaneCommits.length < 2 ? (
            <div className="text-[11px] text-[#94A3B8]">
              At least two recent commits are needed to review a commit range. Choose a lane with more history.
            </div>
          ) : null}
          {selectedLaneCommits.length >= 2 && commitRangeValidationMessage ? (
            <div className="text-[11px] text-amber-200">{commitRangeValidationMessage}</div>
          ) : null}
        </div>
      ) : null}

      {launchDraft.targetMode === "working_tree" ? (
        <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
          <div className="text-[11px] text-[#C5D2E6]">
            Review the current staged, unstaged, and untracked changes in the selected lane. This mode compares the working tree against the lane's current HEAD commit. It does not compare against another lane.
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Model and reasoning</span>
        <ReviewLaunchModelControls
          modelId={launchDraft.modelId}
          reasoningEffort={launchDraft.reasoningEffort}
          codexFastMode={launchDraft.codexFastMode}
          onModelChange={(value) => updateDraft("modelId", value)}
          onReasoningEffortChange={(value) => updateDraft("reasoningEffort", value)}
          onCodexFastModeChange={(value) => updateDraft("codexFastMode", value)}
          disabled={launching}
        />
        <p className="text-[13px] text-[#C5D2E6]">
          This is read only and the model can only read and inspect files.
        </p>
      </div>
    </div>
  );

  const launchPane = (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-[var(--color-surface-recessed)]/35 px-1 pt-1">
      <SectionCard
        title="Review runs"
        icon={ClockCounterClockwise}
        action={(
          <Button size="sm" variant="ghost" onClick={() => setShowLearnings((prev) => !prev)}>
            <GitBranch size={12} />
            {showLearnings ? "Hide learnings" : "Learnings"}
          </Button>
        )}
      >
        <div className="space-y-2">
          <div className="text-[11px] text-[#94A3B8]">
            Pick a saved run here to inspect it on the right.
          </div>
          {runs.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
              No review runs yet in this workspace. Use Launch new review above to start one.
            </div>
          ) : runs.map((run) => {
            const active = run.id === selectedRunId;
            const runLane = laneById.get(run.laneId) ?? null;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => handleSelectRun(run.id)}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition-colors",
                  active ? REVIEW_LIST_ACTIVE : "border-white/[0.06] bg-[var(--color-muted)]/35 hover:bg-[var(--color-muted)]/50"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#F5FAFF]">
                      {describeRunTarget(run)}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[#94A3B8]">
                      {formatTime(run.startedAt)} · {laneDisplayName(runLane)}
                    </div>
                  </div>
                  <Chip className={cn("text-[9px]", toReviewStatusTone(run.status))}>{run.status}</Chip>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Chip className="text-[9px]">findings {run.findingCount}</Chip>
                  {run.severitySummary ? Object.entries(run.severitySummary).slice(0, 2).map(([severity, count]) => (
                    <Chip key={severity} className="text-[9px]">{severity}:{count}</Chip>
                  )) : null}
                  <Chip className="text-[9px]">{toTargetModeLabel(run.target.mode)}</Chip>
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );

  const detailPane = showLearnings ? (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-5">
      <ReviewLearningsPanel onClose={() => setShowLearnings(false)} />
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-bg)]">
      {selectedRun ? (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
          <SectionCard title="Review scope" icon={GitBranch}>
            {selectedRunScopeVisual ? <ReviewLaunchScopeVisual {...selectedRunScopeVisual} /> : null}
          </SectionCard>

          <section className={cn(REVIEW_CARD_SURFACE, "p-4")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip className={cn("text-[9px]", toReviewStatusTone(selectedRun.status))}>{selectedRun.status}</Chip>
                  <Chip className="text-[9px]">{toTargetModeLabel(selectedRun.target.mode)}</Chip>
                  <Chip className="text-[9px]">{selectedRun.config.publishBehavior === "auto_publish" ? "publishing enabled" : "local only"}</Chip>
                  <Chip className="text-[9px]">{selectedRun.config.modelId}</Chip>
                </div>
                <div className="mt-3 text-lg font-semibold text-[#F5FAFF]">
                  {formatReviewCompleteLine(selectedRun, selectedDetail)}
                </div>
                <div className="mt-1 text-sm text-[#93A4B8]">
                  {formatCompareTargetDescription(selectedRun)}
                </div>
                {formatReviewEvidenceLine(selectedRun, selectedDetail) ? (
                  <div className="mt-2 text-sm text-[#C5D2E6]">{formatReviewEvidenceLine(selectedRun, selectedDetail)}</div>
                ) : null}
                {selectedRun.errorMessage ? (
                  <div className="mt-2 text-sm text-red-200">{selectedRun.errorMessage}</div>
                ) : null}
                <div className="mt-3 font-mono text-[10px] text-[#94A3B8]">
                  {formatRunSummaryFooter(selectedRun)}
                </div>
                <div className="mt-4 grid gap-1.5 border-t border-white/[0.06] pt-3">
                  <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Model and reasoning</span>
                  <ReviewLaunchModelControls
                    modelId={selectedRun.config.modelId}
                    reasoningEffort={selectedRun.config.reasoningEffort ?? DEFAULT_REVIEW_REASONING_EFFORT}
                    codexFastMode={selectedRun.config.codexFastMode ?? false}
                    onModelChange={() => undefined}
                    onReasoningEffortChange={() => undefined}
                    onCodexFastModeChange={() => undefined}
                    disabled
                  />
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => void handleRerun(selectedRun)} disabled={launching}>
                <ArrowClockwise size={12} weight="regular" />
                {launching ? "Rerunning" : "Rerun"}
              </Button>
            </div>
          </section>

          {selectedContextArtifacts.length > 0 ? (
            <details className={REVIEW_CARD_SURFACE}>
              <summary className="cursor-pointer list-none px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5FAFF]">Review process</div>
                    <div className="mt-1 text-xs text-[#94A3B8]">Specialist reviewers, context, and validation signals.</div>
                  </div>
                  <Chip className="text-[9px]">{selectedDetail?.reviewerRuns.length ?? 0} reviewers</Chip>
                </div>
              </summary>
              <div className="grid gap-3 px-4 pb-4">
                {selectedDetail?.reviewerRuns.length ? (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                    {selectedDetail.reviewerRuns.map((reviewer) => (
                      <article key={reviewer.id} className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className={cn("text-[9px]", toReviewStatusTone(reviewer.status as ReviewRunStatus))}>{reviewer.status}</Chip>
                          <Chip className="text-[9px]">{toPassLabel(reviewer.reviewerKey)}</Chip>
                        </div>
                        <div className="mt-2 text-xs font-semibold text-[#F5FAFF]">{reviewer.label}</div>
                        <div className="mt-1 text-[11px] text-[#94A3B8]">{reviewer.candidateCount} candidates, {reviewer.keptCount} used</div>
                        {reviewer.summary ? <div className="mt-2 text-[11px] text-[#C5D2E6]">{reviewer.summary}</div> : null}
                        {reviewer.chatSessionId ? (
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenTranscriptInWork(reviewer.chatSessionId, selectedRun.laneId)}
                            aria-label={`Open ${reviewer.label} transcript in Work`}
                          >
                            <ArrowSquareOut size={12} />
                            Open in Work
                          </Button>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}
                <SectionCard title="Context used for this review" icon={Sparkle}>
                  <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-3">
                  {selectedContextArtifacts.map((artifact) => {
                    const artifactType = String(artifact.artifactType);
                    const countValue =
                      artifactType === "provenance_brief"
                        ? readArtifactMetaCount(artifact, ["provenanceCount", "missionCount", "workerDigestCount", "sessionDeltaCount", "priorReviewCount"])
                        : artifactType === "rule_overlays"
                          ? readArtifactMetaCount(artifact, ["ruleCount", "matchedRuleCount", "overlayCount", "pathCount"])
                          : readArtifactMetaCount(artifact, ["signalCount", "checkCount", "testRunCount", "issueCount"]);
                    const detailChips =
                      artifactType === "provenance_brief"
                        ? [
                            readArtifactMetaCount(artifact, ["missionCount", "missionsCount"]) ? `missions ${readArtifactMetaCount(artifact, ["missionCount", "missionsCount"])}` : null,
                            readArtifactMetaCount(artifact, ["workerDigestCount", "workerCount"]) ? `workers ${readArtifactMetaCount(artifact, ["workerDigestCount", "workerCount"])}` : null,
                            readArtifactMetaCount(artifact, ["sessionDeltaCount", "sessionCount"]) ? `sessions ${readArtifactMetaCount(artifact, ["sessionDeltaCount", "sessionCount"])}` : null,
                          ].filter((value): value is string => Boolean(value))
                        : artifactType === "rule_overlays"
                          ? [
                              readArtifactMetaCount(artifact, ["ruleCount", "matchedRuleCount"]) ? `rules ${readArtifactMetaCount(artifact, ["ruleCount", "matchedRuleCount"])}` : null,
                              readArtifactMetaCount(artifact, ["pathCount"]) ? `paths ${readArtifactMetaCount(artifact, ["pathCount"])}` : null,
                            ].filter((value): value is string => Boolean(value))
                          : [
                              readArtifactMetaCount(artifact, ["signalCount"]) ? `signals ${readArtifactMetaCount(artifact, ["signalCount"])}` : null,
                              readArtifactMetaCount(artifact, ["checkCount", "testRunCount"]) ? `checks ${readArtifactMetaCount(artifact, ["checkCount", "testRunCount"])}` : null,
                              readArtifactMetaCount(artifact, ["issueCount"]) ? `issues ${readArtifactMetaCount(artifact, ["issueCount"])}` : null,
                            ].filter((value): value is string => Boolean(value));

                    return (
                      <article key={artifact.id} className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">{toContextArtifactLabel(artifactType)}</Chip>
                          {countValue !== null ? <Chip className="text-[9px]">{countValue} items</Chip> : null}
                          {detailChips.map((chip) => (
                            <Chip key={`${artifact.id}-${chip}`} className="text-[9px]">
                              {chip}
                            </Chip>
                          ))}
                        </div>
                        <div className="mt-2 text-sm font-semibold text-[#F5FAFF]">{artifact.title}</div>
                        <div className="mt-1 text-xs text-[#C5D2E6]">
                          {readArtifactMetaString(artifact, "summary") ?? "Compact review context captured for this run."}
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2">
                          <MetaCard label="Created" value={formatTime(artifact.createdAt)} />
                          <MetaCard label="Mime type" value={artifact.mimeType} />
                        </div>
                        {artifact.contentText || artifact.metadata ? (
                          <details className={cn("mt-3", REVIEW_INSET_SURFACE)}>
                            <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-semibold text-[#C5D2E6]">
                              Debug payload
                            </summary>
                            <div className="grid gap-2 px-3 pb-3">
                              {artifact.contentText ? (
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                                  {artifact.contentText}
                                </pre>
                              ) : null}
                              {artifact.metadata ? (
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#B7C4D7]">
                                  {JSON.stringify(artifact.metadata, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          </details>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </div>
                </SectionCard>
              </div>
            </details>
          ) : null}

          {(selectedPassArtifacts.length > 0 || selectedAdjudicationArtifact || selectedMergedArtifact) ? (
            <details className={REVIEW_CARD_SURFACE}>
              <summary className="cursor-pointer list-none px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5FAFF]">Reviewer outputs</div>
                    <div className="mt-1 text-xs text-[#94A3B8]">Candidate counts, merge results, and filtered signals.</div>
                  </div>
                  <Chip className="text-[9px]">{selectedDetail?.candidateFindings.length ?? 0} candidates</Chip>
                </div>
              </summary>
              <div className="space-y-3 px-4 pb-4">
                {selectedPassArtifacts.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    {selectedPassArtifacts.map((artifact) => (
                      <article key={artifact.id} className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">{toPassLabel(readArtifactMetaString(artifact, "passKey") ?? artifact.title)}</Chip>
                          <Chip className="text-[9px]">{readArtifactMetaNumber(artifact, "keptCount") ?? 0} used</Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          {readArtifactMetaString(artifact, "summary") ?? "No summary recorded for this pass."}
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2">
                          <MetaCard label="Candidates" value={readArtifactMetaNumber(artifact, "totalParsedCount") ?? "—"} />
                          <MetaCard label="Used" value={readArtifactMetaNumber(artifact, "keptCount") ?? "—"} />
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}

                {(selectedAdjudicationArtifact || selectedMergedArtifact) ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {selectedAdjudicationArtifact ? (
                      <article className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">Adjudication</Chip>
                          <Chip className="text-[9px]">accepted {readArtifactMetaNumber(selectedAdjudicationArtifact, "acceptedCount") ?? 0}</Chip>
                          <Chip className="text-[9px]">rejected {readArtifactMetaNumber(selectedAdjudicationArtifact, "rejectedCount") ?? 0}</Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          Merged overlaps and filtered low-signal candidates before findings became final.
                        </div>
                      </article>
                    ) : null}
                    {selectedMergedArtifact ? (
                      <article className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">Final result</Chip>
                          <Chip className="text-[9px]">findings {readArtifactMetaNumber(selectedMergedArtifact, "findingCount") ?? 0}</Chip>
                          <Chip className="text-[9px]">
                            {selectedRun.config.publishBehavior === "auto_publish" ? "ready to post" : "strong evidence"} {readArtifactMetaNumber(selectedMergedArtifact, "publicationEligibleCount") ?? 0}
                          </Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          {selectedRun.summary ?? "No merged summary recorded."}
                        </div>
                      </article>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          {selectedDetail?.publications?.length ? (
            <SectionCard title="Publication" icon={ArrowSquareOut}>
              <div className="space-y-2">
                {selectedDetail.publications.map((publication) => (
                  <article key={publication.id} className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip className="text-[9px]">{publication.destination.kind}</Chip>
                      <Chip className={cn("text-[9px]", publication.status === "published" ? "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300" : "border-red-400/20 bg-red-400/[0.08] text-red-300")}>
                        {publication.status}
                      </Chip>
                      <div className="text-sm font-semibold text-[#F5FAFF]">
                        {publication.destination.repoOwner}/{publication.destination.repoName} #{publication.destination.prNumber}
                      </div>
                    </div>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      <MetaCard label="Created" value={formatTime(publication.createdAt)} />
                      <MetaCard label="Completed" value={formatTime(publication.completedAt)} />
                      <MetaCard label="Inline comments" value={publication.inlineComments.length} />
                      <MetaCard label="Summary findings" value={publication.summaryFindingIds.length} />
                      <MetaCard label="Review URL" value={publication.reviewUrl ?? "not returned"} />
                      <MetaCard label="Remote review id" value={publication.remoteReviewId ?? "not returned"} />
                    </div>
                    {publication.errorMessage ? (
                      <div className="mt-3 text-sm text-red-200">{publication.errorMessage}</div>
                    ) : null}
                    <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                      {publication.summaryBody}
                    </pre>
                  </article>
                ))}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title={`Findings (${selectedRun.findingCount})`} icon={MagnifyingGlass}>
            {(() => {
              const rawFindings = selectedDetail?.findings ?? [];
              const detailUnavailable = selectedDetail == null;
              const suppressedCount = rawFindings.filter((f) => f.suppressionMatch != null).length;
              const severityMatches = severityFilter === "all"
                ? rawFindings
                : rawFindings.filter((f) => f.severity === severityFilter);
              const visible = severityMatches.filter((f) => showSuppressed || f.suppressionMatch == null);
              return (
                <>
                  {feedbackError ? (
                    <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-200">
                      {feedbackError}
                    </div>
                  ) : null}
                  {selectedRun.status === "running" || selectedRun.status === "queued" ? (
                    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100">
                      <span>Review {selectedRun.status === "queued" ? "queued" : "running"}. Findings appear as passes complete.</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleCancelRun(selectedRun)}
                        disabled={cancelInFlight}
                      >
                        {cancelInFlight ? "Cancelling…" : "Cancel run"}
                      </Button>
                    </div>
                  ) : null}
                  {selectedRun.status === "failed" ? (
                    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-red-400/30 bg-red-400/[0.06] px-3 py-2 text-[11px] text-red-200">
                      <span>{selectedRun.errorMessage ?? "Review run failed."}</span>
                      <Button size="sm" variant="ghost" onClick={() => void handleRerun(selectedRun)}>
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {rawFindings.length > 0 ? (
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="text-[#6E7F92] uppercase tracking-[0.14em]">Severity:</span>
                        {(["all", "critical", "high", "medium", "low", "info"] as const).map((sev) => {
                          const count = sev === "all" ? rawFindings.length : rawFindings.filter((f) => f.severity === sev).length;
                          if (sev !== "all" && count === 0) return null;
                          return (
                            <button
                              key={sev}
                              type="button"
                              onClick={() => setSeverityFilter(sev)}
                              className={cn(
                                "rounded-full border px-2 py-0.5 font-medium transition",
                                severityFilter === sev
                                  ? "border-sky-400/40 bg-sky-400/[0.10] text-sky-100"
                                  : "border-white/[0.08] bg-white/[0.02] text-[#93A4B8] hover:border-white/[0.16]",
                              )}
                            >
                              {sev} <span className="text-[#6E7F92]">{count}</span>
                            </button>
                          );
                        })}
                        {suppressedCount > 0 ? (
                          <label className="inline-flex items-center gap-1.5 text-[10px] text-[#93A4B8]">
                            <input
                              type="checkbox"
                              checked={showSuppressed}
                              onChange={(e) => setShowSuppressed(e.target.checked)}
                              className="h-3 w-3 accent-sky-400"
                            />
                            Show {suppressedCount} filtered
                          </label>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleCopyAllFindings(rawFindings)}
                        title="Copy all findings from this run as one message."
                      >
                        {copyAllFindingsState === "copied" ? <Checks size={12} /> : <CopySimple size={12} />}
                        {copyAllFindingsState === "copied" ? "Copied" : copyAllFindingsState === "error" ? "Copy failed" : "Copy all findings"}
                      </Button>
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {detailUnavailable && loadingDetail ? (
                      <div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-3 text-xs text-sky-100">
                        Loading findings and evidence for this run...
                      </div>
                    ) : detailUnavailable && selectedRun.findingCount > 0 ? (
                      <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-100">
                        Findings are still loading or unavailable. Refresh this run before treating the review as empty.
                      </div>
                    ) : visible.length > 0 ? visible.map((finding, index) => (
                      <ReviewFindingCard
                        key={finding.id ?? `${finding.title}-${index}`}
                        finding={finding}
                        onRequestAction={handleFindingAction}
                        onCopyFinding={handleCopyFinding}
                        onOpenInFiles={finding.filePath ? handleOpenFindingInFiles : undefined}
                        onOpenInEditor={finding.filePath ? handleOpenFindingInEditor : undefined}
                      />
                    )) : rawFindings.length > 0 ? (
                      <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                        No findings match the current filters. {!showSuppressed && suppressedCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => setShowSuppressed(true)}
                            className="ml-1 text-sky-300 hover:text-sky-200 underline underline-offset-2"
                          >
                            Show {suppressedCount} filtered findings
                          </button>
                        ) : null}
                      </div>
                    ) : selectedRun.status === "completed" ? (
                      <EmptyState
                        icon={MagnifyingGlass}
                        title="No findings"
                        description="The review passes found nothing actionable in this diff. That could mean the diff was clean or the target was too small to review."
                      />
                    ) : (
                      <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                        Findings will appear here once the review completes.
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </SectionCard>

          <details className={REVIEW_CARD_SURFACE}>
            <summary className="cursor-pointer list-none px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[#F5FAFF]">Artifacts</div>
                  <div className="mt-1 text-xs text-[#94A3B8]">Raw diff, prompts, payloads, and provenance for audit.</div>
                </div>
                <Chip className="text-[9px]">{selectedDetail?.artifacts?.length ?? 0} saved</Chip>
              </div>
            </summary>
            <div className="space-y-2 px-4 pb-4">
              {selectedDetail?.artifacts?.length ? selectedDetail.artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip className="text-[9px]">{toContextArtifactLabel(String(artifact.artifactType))}</Chip>
                    <div className="text-sm font-semibold text-[#F5FAFF]">{artifact.title}</div>
                    <span className="text-[11px] text-[#94A3B8]">{artifact.mimeType}</span>
                  </div>
                  {artifact.contentText ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">{artifact.contentText}</pre> : null}
                  {artifact.metadata ? (
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-[var(--color-surface-recessed)]/80 p-3 font-mono text-[11px] leading-relaxed text-[#B7C4D7]">
                      {JSON.stringify(artifact.metadata, null, 2)}
                    </pre>
                  ) : null}
                </div>
              )) : (
                <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                  No artifacts were captured for this run.
                </div>
              )}
            </div>
          </details>

          <SectionCard title="Review agent transcript" icon={Sparkle}>
            {selectedDetail?.chatSession ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                <div>
                  <div className="text-sm font-semibold text-[#F5FAFF]">Review agent transcript available</div>
                  <div className="mt-1 text-xs text-[#94A3B8]">
                    Open the saved read-only session in Work when you need the full turn-by-turn trace.
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleOpenTranscriptInWork(selectedDetail.chatSession?.sessionId, selectedDetail.chatSession?.laneId ?? selectedRun.laneId)}
                >
                  <ArrowSquareOut size={12} />
                  Open in Work
                </Button>
              </div>
            ) : selectedReviewerTranscripts.length > 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#F5FAFF]">Specialist reviewer transcripts available</div>
                    <div className="mt-1 text-xs text-[#94A3B8]">
                      Open the saved read-only sessions in Work when you need the full turn-by-turn trace.
                    </div>
                  </div>
                  <Chip className="text-[9px]">{selectedReviewerTranscripts.length} linked</Chip>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedReviewerTranscripts.map((reviewer) => (
                    <Button
                      key={reviewer.id}
                      size="sm"
                      variant="outline"
                      onClick={() => handleOpenTranscriptInWork(reviewer.chatSessionId, selectedRun.laneId)}
                      aria-label={`Open ${reviewer.label} transcript in Work`}
                    >
                      <ArrowSquareOut size={12} />
                      {reviewer.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-white/[0.06] bg-[var(--color-muted)]/40 p-3 text-xs text-[#94A3B8]">
                No transcript session was linked to this run.
              </div>
            )}
          </SectionCard>
        </div>
      ) : loadingDetail ? (
        <div className="flex h-full items-center justify-center text-sm text-[#94A3B8]">Loading review detail…</div>
      ) : (
        <EmptyState
          icon={MagnifyingGlass}
          title="Select a review run"
          description="Open a saved run on the left to inspect findings, evidence, and the transcript."
        />
      )}
    </div>
  );


  return (
    <div className="flex h-full min-w-0 flex-col bg-bg text-fg">
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-sky-400/20 bg-sky-500/10">
            <MagnifyingGlass size={16} weight="regular" className="text-sky-400" />
          </div>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-[#FAFAFA]">Review</div>
            <div className="text-[11px] text-[#94A3B8]">Pick a saved run on the left, then inspect findings and evidence on the right.</div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => setLaunchModalOpen(true)} aria-label="Launch new review">
            <Plus size={12} weight="bold" />
            Launch new review
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refreshReviewTab()} disabled={refreshingTab}>
            <ArrowsClockwise size={12} weight="regular" className={cn(refreshingTab && "animate-spin")} />
            Refresh runs
          </Button>
        </div>
      </div>

      <LaneDialogShell
        open={launchModalOpen}
        onOpenChange={setLaunchModalOpen}
        title="Launch review"
        description="Choose a lane and review target, then start a read-only inspection run."
        icon={Sparkle}
        busy={launching}
        widthClassName="w-[min(760px,calc(100vw-1rem))]"
      >
        {launchFormContent}
        <div className="mt-4 flex justify-end gap-2 border-t border-white/[0.06] pt-4">
          <Button size="sm" variant="ghost" onClick={() => setLaunchModalOpen(false)} disabled={launching}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void handleLaunch()} disabled={launching || !launchReady}>
            <Play size={12} weight="bold" />
            {launching ? "Launching" : "Start review"}
          </Button>
        </div>
      </LaneDialogShell>

      {error && !loadingRuns ? (
        <div role="alert" className="border-b border-red-400/15 bg-red-500/[0.06] px-6 py-2.5 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-hidden">
        <Group id="review-layout" orientation="horizontal" className="flex h-full min-h-0">
          <Panel
            id="review-runs-sidebar"
            data-testid="pane-launch"
            defaultSize={defaultSidebarPx}
            minSize={REVIEW_SIDEBAR_MIN_PX}
            maxSize={REVIEW_SIDEBAR_MAX_PX}
            onResize={(size) => persistReviewSidebarPx(size.inPixels)}
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden" }}
          >
            {launchPane}
          </Panel>
          <ResizeGutter orientation="vertical" />
          <Panel
            id="review-run-detail"
            data-testid="pane-detail"
            minSize="28%"
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden" }}
          >
            {detailPane}
          </Panel>
        </Group>
      </div>
    </div>
  );
}
