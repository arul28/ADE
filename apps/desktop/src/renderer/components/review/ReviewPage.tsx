import React from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowsClockwise,
  CaretDown,
  ClockCounterClockwise,
  GitBranch,
  MagnifyingGlass,
  Play,
  Sparkle,
  ArrowClockwise,
  ArrowSquareOut,
  FileText,
} from "@phosphor-icons/react";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import type { LaneSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { AgentChatPane } from "../chat/AgentChatPane";
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
import type {
  ReviewArtifact,
  ReviewEvidenceEntry,
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

const REVIEW_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "launch" }, defaultSize: 36, minSize: 28 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 28 },
  ],
};

type LaunchDraft = {
  laneId: string;
  targetMode: ReviewTargetMode;
  compareKind: "default_branch" | "lane";
  compareLaneId: string;
  baseCommit: string;
  headCommit: string;
  modelId: string;
  reasoningEffort: string;
  maxFiles: number;
  maxDiffChars: number;
  maxPromptChars: number;
  maxFindings: number;
  maxFindingsPerPass: number;
  maxPublishedFindings: number;
};

const DEFAULT_REVIEW_LAUNCH_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";
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

function toSeverityTone(severity: string): string {
  const normalized = severity.toLowerCase();
  if (normalized.includes("crit")) return "border-red-400/25 bg-red-400/[0.10] text-red-200";
  if (normalized.includes("high")) return "border-orange-400/25 bg-orange-400/[0.10] text-orange-200";
  if (normalized.includes("medium")) return "border-amber-400/25 bg-amber-400/[0.10] text-amber-200";
  if (normalized.includes("low")) return "border-sky-400/25 bg-sky-400/[0.10] text-sky-200";
  return "border-zinc-400/20 bg-zinc-400/[0.08] text-zinc-200";
}

function toFindingClassTone(value: string): string {
  switch (value) {
    case "intent_drift":
      return "border-fuchsia-400/25 bg-fuchsia-400/[0.10] text-fuchsia-200";
    case "incomplete_rollout":
      return "border-cyan-400/25 bg-cyan-400/[0.10] text-cyan-200";
    case "late_stage_regression":
      return "border-rose-400/25 bg-rose-400/[0.10] text-rose-200";
    default:
      return "border-zinc-400/20 bg-zinc-400/[0.08] text-zinc-200";
  }
}

function toFindingClassLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
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

function formatConfidence(value: number | string): string {
  if (typeof value === "number") {
    if (value <= 1) return `${Math.round(value * 100)}%`;
    return `${Math.round(value)}%`;
  }
  return value;
}

function normalizeEvidence(evidence: ReviewFinding["evidence"] | null | undefined): ReviewEvidenceEntry[] {
  if (!evidence) return [];
  return evidence.map((entry) => entry as ReviewEvidenceEntry);
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
    default:
      return artifactType.replaceAll("_", " ");
  }
}

function isContextArtifactType(artifactType: string): boolean {
  return artifactType === "provenance_brief" || artifactType === "rule_overlays" || artifactType === "validation_signals";
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
  const publications = (value.publications ?? nested?.publications ?? []) as NormalizedDetail["publications"];
  const chatSession = (value.chatSession ?? nested?.chatSession ?? null) as ReviewRunDetail["chatSession"];
  return {
    ...run,
    findings,
    artifacts,
    publications,
    chatSession,
  };
}

function laneDisplayName(lane: LaneSummary | null | undefined): string {
  if (!lane) return "Unknown lane";
  return lane.name?.trim().length ? lane.name : lane.id;
}

function MetaCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
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
    <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03]">
            <Icon size={15} weight="bold" className="text-[#A78BFA]" />
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
          className="h-10 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/20 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus:border-[#A78BFA55]"
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
        <div className="rounded-xl border border-white/[0.06] bg-black/15 p-3">
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
        budgets: {
          maxFiles: draft.maxFiles,
          maxDiffChars: draft.maxDiffChars,
          maxPromptChars: draft.maxPromptChars,
          maxFindings: draft.maxFindings,
          maxFindingsPerPass: draft.maxFindingsPerPass,
          maxPublishedFindings: draft.maxPublishedFindings,
        },
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
        budgets: {
          maxFiles: draft.maxFiles,
          maxDiffChars: draft.maxDiffChars,
          maxPromptChars: draft.maxPromptChars,
          maxFindings: draft.maxFindings,
          maxFindingsPerPass: draft.maxFindingsPerPass,
          maxPublishedFindings: draft.maxPublishedFindings,
        },
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
      budgets: {
        maxFiles: draft.maxFiles,
        maxDiffChars: draft.maxDiffChars,
        maxPromptChars: draft.maxPromptChars,
        maxFindings: draft.maxFindings,
        maxFindingsPerPass: draft.maxFindingsPerPass,
        maxPublishedFindings: draft.maxPublishedFindings,
      },
      publishBehavior: "local_only",
    },
  };
}

export function ReviewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const lanes = useAppStore((s) => s.lanes ?? []);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);

  const laneOptions = React.useMemo(() => lanes.filter((lane) => Boolean(lane?.id)), [lanes]);
  const laneById = React.useMemo(() => new Map(laneOptions.map((lane) => [lane.id, lane])), [laneOptions]);
  const defaultLaneId = selectedLaneId && laneById.has(selectedLaneId) ? selectedLaneId : laneOptions[0]?.id ?? null;

  const [launchContext, setLaunchContext] = React.useState<ReviewLaunchContext | null>(null);
  const [runs, setRuns] = React.useState<NormalizedRun[]>([]);
  const [detail, setDetail] = React.useState<NormalizedDetail | null>(null);
  const [loadingRuns, setLoadingRuns] = React.useState(false);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [loadingLaunch, setLoadingLaunch] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(readReviewRunId(location.search));
  const [launching, setLaunching] = React.useState(false);
  const [launchDraft, setLaunchDraft] = React.useState<LaunchDraft>(() => ({
    laneId: defaultLaneId ?? "",
    targetMode: "lane_diff",
    compareKind: "default_branch",
    compareLaneId: "",
    baseCommit: "",
    headCommit: "",
    modelId: DEFAULT_REVIEW_LAUNCH_MODEL_ID,
    reasoningEffort: DEFAULT_REVIEW_REASONING_EFFORT,
    maxFiles: 25,
    maxDiffChars: 120_000,
    maxPromptChars: 60_000,
    maxFindings: 8,
    maxFindingsPerPass: 6,
    maxPublishedFindings: 6,
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

  React.useEffect(() => {
    if (!launchDraft.laneId && defaultLaneId) {
      setLaunchDraft((prev) => ({ ...prev, laneId: defaultLaneId }));
    }
  }, [defaultLaneId, launchDraft.laneId]);

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

  const loadDetail = React.useCallback(async (runId: string | null) => {
    if (!runId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const next = await getReviewRunDetail(runId);
      setDetail(next ? normalizeDetail(next) : null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshLaunchContext();
  }, [refreshLaunchContext]);

  React.useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  React.useEffect(() => {
    void loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  React.useEffect(() => {
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
  }, [loadDetail, refreshRuns, selectedRunId]);

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
        title: `${laneLabel} against ${defaultBranchLabel}`,
        description: `Review the full lane diff by comparing ${laneLabel} against ${defaultBranchLabel}.`,
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
    defaultBranchLabel,
    launchDraft.compareKind,
    launchDraft.targetMode,
    selectedBaseCommit,
    selectedCompareLane,
    selectedHeadCommit,
    selectedLane,
  ]);
  const activeRuns = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const totalFindings = runs.reduce((sum, run) => sum + (run.findingCount ?? 0), 0);
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

  const [showLearnings, setShowLearnings] = React.useState(false);
  const [severityFilter, setSeverityFilter] = React.useState<"all" | "critical" | "high" | "medium" | "low" | "info">("all");
  const [showSuppressed, setShowSuppressed] = React.useState(false);
  const [feedbackError, setFeedbackError] = React.useState<string | null>(null);
  const [cancelInFlight, setCancelInFlight] = React.useState(false);

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

  const launchPane = (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <SectionCard
        title="Launch review"
        icon={Sparkle}
        action={(
          <Button size="sm" variant="primary" onClick={() => void handleLaunch()} disabled={launching || !launchReady}>
            <Play size={12} weight="bold" />
            {launching ? "Launching" : "Start review"}
          </Button>
        )}
      >
        <div className="grid gap-3">
          <label className="grid gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Lane</span>
            <div className="relative">
              <select
                className="h-9 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/20 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors focus:border-[#A78BFA55]"
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
            <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/[0.08] bg-black/15 p-1">
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
                      active ? "bg-[#A78BFA1A] text-[#F5FAFF] ring-1 ring-[#A78BFA33]" : "text-[#94A3B8] hover:text-[#F5FAFF]"
                    )}
                    onClick={() => updateDraft("targetMode", mode)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </label>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip className="text-[9px]">{toTargetModeLabel(launchDraft.targetMode)}</Chip>
              {launchDraft.targetMode === "lane_diff" ? (
                <Chip className="text-[9px]">
                  {launchDraft.compareKind === "lane" ? "Lane to lane" : `Against ${defaultBranchLabel}`}
                </Chip>
              ) : null}
            </div>
            <div className="mt-2 text-sm font-semibold text-[#F5FAFF]">{launchScope.title}</div>
            <div className="mt-1 text-[11px] text-[#C5D2E6]">{launchScope.description}</div>
          </div>

          {launchDraft.targetMode === "lane_diff" ? (
            <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
              <div className="text-[11px] text-[#C5D2E6]">
                Default compares this lane against the primary / default branch. Switch to another lane when you want a lane-to-lane review instead.
              </div>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Compare against</span>
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/[0.08] bg-black/15 p-1">
                  {(["default_branch", "lane"] as const).map((kind) => {
                    const active = launchDraft.compareKind === kind;
                    return (
                      <button
                        key={kind}
                        type="button"
                        className={cn(
                          "rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors",
                          active ? "bg-[#A78BFA1A] text-[#F5FAFF] ring-1 ring-[#A78BFA33]" : "text-[#94A3B8] hover:text-[#F5FAFF]"
                        )}
                        onClick={() => updateDraft("compareKind", kind)}
                      >
                        {kind === "default_branch" ? "Primary / default branch" : "Another lane"}
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
                      className="h-9 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/20 px-3 pr-8 text-sm text-[#F5FAFF] outline-none transition-colors focus:border-[#A78BFA55]"
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

          {launchDraft.targetMode === "commit_range" ? (
            <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
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
            <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
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
              onModelChange={(value) => updateDraft("modelId", value)}
              onReasoningEffortChange={(value) => updateDraft("reasoningEffort", value)}
              disabled={launching}
            />
          </div>

          <details className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
            <summary className="cursor-pointer list-none px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[#F5FAFF]">Advanced review budgets</div>
                  <div className="mt-1 text-[11px] text-[#94A3B8]">
                    These limits keep runs bounded. Most reviews can keep the defaults.
                  </div>
                </div>
                <Chip className="text-[9px]">advanced</Chip>
              </div>
            </summary>
            <div className="grid gap-2 px-3 pb-3 md:grid-cols-3 xl:grid-cols-6">
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Files</span>
                <input
                  type="number"
                  min={1}
                  value={launchDraft.maxFiles}
                  onChange={(e) => updateDraft("maxFiles", Number(e.target.value) || 1)}
                  className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none focus:border-[#A78BFA55]"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Diff chars</span>
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  value={launchDraft.maxDiffChars}
                  onChange={(e) => updateDraft("maxDiffChars", Number(e.target.value) || 1024)}
                  className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none focus:border-[#A78BFA55]"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Prompt chars</span>
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  value={launchDraft.maxPromptChars}
                  onChange={(e) => updateDraft("maxPromptChars", Number(e.target.value) || 1024)}
                  className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none focus:border-[#A78BFA55]"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Findings</span>
                <input
                  type="number"
                  min={1}
                  value={launchDraft.maxFindings}
                  onChange={(e) => updateDraft("maxFindings", Number(e.target.value) || 1)}
                  className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none focus:border-[#A78BFA55]"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Per pass</span>
                <input
                  type="number"
                  min={1}
                  value={launchDraft.maxFindingsPerPass}
                  onChange={(e) => updateDraft("maxFindingsPerPass", Number(e.target.value) || 1)}
                  className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none focus:border-[#A78BFA55]"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Published</span>
                <input
                  type="number"
                  min={1}
                  value={launchDraft.maxPublishedFindings}
                  onChange={(e) => updateDraft("maxPublishedFindings", Number(e.target.value) || 1)}
                  className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none focus:border-[#A78BFA55]"
                />
              </label>
            </div>
          </details>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-[11px] text-[#94A3B8]">
            Every review run is saved locally. Use the list below as the run picker, then inspect the selected run's findings, context, and transcript in the right pane.
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Review runs"
        icon={ClockCounterClockwise}
        action={(
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setShowLearnings((prev) => !prev)}>
              <GitBranch size={12} />
              {showLearnings ? "Hide learnings" : "Learnings"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refreshRuns()} disabled={loadingRuns}>
              <ArrowsClockwise size={12} weight="regular" className={cn(loadingRuns && "animate-spin")} />
              Refresh
            </Button>
          </div>
        )}
      >
        <div className="space-y-2">
          <div className="text-[11px] text-[#94A3B8]">
            Pick a saved run here to inspect it on the right.
          </div>
          {runs.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
              No review runs yet in this workspace. New runs will show up here and open on the right.
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
                  active ? "border-[#A78BFA33] bg-[#A78BFA10]" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05]"
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {selectedRun ? (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip className={cn("text-[9px]", toReviewStatusTone(selectedRun.status))}>{selectedRun.status}</Chip>
                  <Chip className="text-[9px]">{toTargetModeLabel(selectedRun.target.mode)}</Chip>
                  <Chip className="text-[9px]">{toSelectionModeLabel(selectedRun.config.selectionMode)}</Chip>
                  <Chip className="text-[9px]">{selectedRun.config.modelId}</Chip>
                </div>
                <div className="mt-3 text-lg font-semibold text-[#F5FAFF]">
                  {describeRunTarget(selectedRun)}
                </div>
                <div className="mt-1 text-sm text-[#93A4B8]">
                  {selectedRun.summary ?? "No summary has been recorded yet."}
                </div>
                {selectedRun.errorMessage ? (
                  <div className="mt-2 text-sm text-red-200">{selectedRun.errorMessage}</div>
                ) : null}
              </div>
              <Button size="sm" variant="outline" onClick={() => void handleRerun(selectedRun)} disabled={launching}>
                <ArrowClockwise size={12} weight="regular" />
                {launching ? "Rerunning" : "Rerun"}
              </Button>
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetaCard label="Run id" value={selectedRun.id} />
            <MetaCard label="Lane" value={selectedRunLane?.name ?? selectedRun.laneId} />
            <MetaCard label="Started" value={formatTime(selectedRun.startedAt)} />
            <MetaCard label="Completed" value={formatTime(selectedRun.endedAt)} />
            <MetaCard label="Model" value={selectedRun.config.modelId} />
            <MetaCard label="Reasoning" value={selectedRun.config.reasoningEffort ?? "default"} />
            <MetaCard label="Publish" value={selectedRun.config.publishBehavior} />
            <MetaCard label="Chat session" value={selectedRun.chatSessionId ?? "none"} />
          </section>

          <SectionCard title="Launch setup" icon={GitBranch}>
            <div className="grid gap-3 md:grid-cols-2">
              <MetaCard label="Target mode" value={toTargetModeLabel(selectedRun.target.mode)} />
              <MetaCard label="Review target" value={describeRunTarget(selectedRun)} />
              <MetaCard label="Selection mode" value={toSelectionModeLabel(selectedRun.config.selectionMode)} />
              <MetaCard
                label="Comparison"
                value={
                  selectedRun.compareTarget?.label
                  ?? (selectedRun.target.mode === "working_tree"
                    ? "Current HEAD in selected lane"
                    : selectedRun.target.mode === "commit_range"
                      ? "Earlier base commit to later head commit"
                      : "Default branch")
                }
              />
              <MetaCard label="File budget" value={selectedRun.config.budgets.maxFiles} />
              <MetaCard label="Diff budget" value={selectedRun.config.budgets.maxDiffChars} />
              <MetaCard label="Prompt budget" value={selectedRun.config.budgets.maxPromptChars} />
              <MetaCard label="Finding budget" value={selectedRun.config.budgets.maxFindings} />
              <MetaCard label="Per-pass budget" value={selectedRun.config.budgets.maxFindingsPerPass ?? selectedRun.config.budgets.maxFindings} />
              <MetaCard label="Publish budget" value={selectedRun.config.budgets.maxPublishedFindings ?? selectedRun.config.budgets.maxFindings} />
            </div>
          </SectionCard>

          {selectedContextArtifacts.length > 0 ? (
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
                      <article key={artifact.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
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
                        {artifact.contentText ? (
                          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
                            {artifact.contentText}
                          </pre>
                        ) : null}
                        {artifact.metadata ? (
                          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#B7C4D7]">
                            {JSON.stringify(artifact.metadata, null, 2)}
                          </pre>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </div>
            </SectionCard>
          ) : null}

          {(selectedPassArtifacts.length > 0 || selectedAdjudicationArtifact || selectedMergedArtifact) ? (
            <SectionCard title="Passes and adjudication" icon={Sparkle}>
              <div className="space-y-3">
                {selectedPassArtifacts.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    {selectedPassArtifacts.map((artifact) => (
                      <article key={artifact.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">{toPassLabel(readArtifactMetaString(artifact, "passKey") ?? artifact.title)}</Chip>
                          <Chip className="text-[9px]">{readArtifactMetaNumber(artifact, "keptCount") ?? 0} kept</Chip>
                          {(readArtifactMetaNumber(artifact, "budgetTrimmedCount") ?? 0) > 0 ? (
                            <Chip className="text-[9px]">trimmed {readArtifactMetaNumber(artifact, "budgetTrimmedCount")}</Chip>
                          ) : null}
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          {readArtifactMetaString(artifact, "summary") ?? "No summary recorded for this pass."}
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2">
                          <MetaCard label="Parsed" value={readArtifactMetaNumber(artifact, "totalParsedCount") ?? "—"} />
                          <MetaCard label="Saved" value={readArtifactMetaNumber(artifact, "keptCount") ?? "—"} />
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}

                {(selectedAdjudicationArtifact || selectedMergedArtifact) ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {selectedAdjudicationArtifact ? (
                      <article className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">Adjudication</Chip>
                          <Chip className="text-[9px]">accepted {readArtifactMetaNumber(selectedAdjudicationArtifact, "acceptedCount") ?? 0}</Chip>
                          <Chip className="text-[9px]">rejected {readArtifactMetaNumber(selectedAdjudicationArtifact, "rejectedCount") ?? 0}</Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          Merged overlaps, filtered low-signal candidates, and applied the explicit run/publication budgets before findings became final.
                        </div>
                      </article>
                    ) : null}
                    {selectedMergedArtifact ? (
                      <article className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className="text-[9px]">Final result</Chip>
                          <Chip className="text-[9px]">findings {readArtifactMetaNumber(selectedMergedArtifact, "findingCount") ?? 0}</Chip>
                          <Chip className="text-[9px]">publishable {readArtifactMetaNumber(selectedMergedArtifact, "publicationEligibleCount") ?? 0}</Chip>
                        </div>
                        <div className="mt-2 text-xs text-[#C5D2E6]">
                          {selectedRun.summary ?? "No merged summary recorded."}
                        </div>
                      </article>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {selectedDetail?.publications?.length ? (
            <SectionCard title="Publication" icon={ArrowSquareOut}>
              <div className="space-y-2">
                {selectedDetail.publications.map((publication) => (
                  <article key={publication.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
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
                    <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">
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
                    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
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
                        <label className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-[#93A4B8]">
                          <input
                            type="checkbox"
                            checked={showSuppressed}
                            onChange={(e) => setShowSuppressed(e.target.checked)}
                            className="h-3 w-3 accent-violet-400"
                          />
                          Show {suppressedCount} filtered
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {visible.length > 0 ? visible.map((finding, index) => (
                      <ReviewFindingCard
                        key={finding.id ?? `${finding.title}-${index}`}
                        finding={finding}
                        onRequestAction={handleFindingAction}
                        onOpenInFiles={finding.filePath ? handleOpenFindingInFiles : undefined}
                        onOpenInEditor={finding.filePath ? handleOpenFindingInEditor : undefined}
                      />
                    )) : rawFindings.length > 0 ? (
                      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
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
                      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
                        Findings will appear here once the review completes.
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </SectionCard>

          <SectionCard title="Artifacts" icon={FileText}>
            <div className="space-y-2">
              {selectedDetail?.artifacts?.length ? selectedDetail.artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip className="text-[9px]">{artifact.artifactType}</Chip>
                    <div className="text-sm font-semibold text-[#F5FAFF]">{artifact.title}</div>
                    <span className="text-[11px] text-[#94A3B8]">{artifact.mimeType}</span>
                  </div>
                  {artifact.contentText ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">{artifact.contentText}</pre> : null}
                  {artifact.metadata ? (
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#B7C4D7]">
                      {JSON.stringify(artifact.metadata, null, 2)}
                    </pre>
                  ) : null}
                </div>
              )) : (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
                  No artifacts were captured for this run.
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Transcript" icon={Sparkle}>
            {selectedDetail?.chatSession ? (
              <div className="h-[620px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#07101A]">
                <AgentChatPane
                  laneId={selectedDetail.chatSession.laneId}
                  laneLabel={selectedRunLane?.name ?? selectedRun.laneId}
                  initialSessionSummary={selectedDetail.chatSession}
                  lockSessionId={selectedDetail.chatSession.sessionId}
                  hideSessionTabs
                  modelSelectionLocked
                  permissionModeLocked
                  presentation={{
                    mode: "resolver",
                    profile: "standard",
                    title: selectedDetail.chatSession.title ?? "Review transcript",
                    assistantLabel: "Review",
                    messagePlaceholder: "This transcript is locked to the saved review session.",
                  }}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
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

  const paneConfigs: Record<string, PaneConfig> = {
    launch: {
      title: "Launch and saved runs",
      icon: Sparkle,
      bodyClassName: "flex flex-col min-h-0",
      children: launchPane,
    },
    detail: {
      title: "Selected run",
      icon: MagnifyingGlass,
      bodyClassName: "flex flex-col min-h-0",
      children: detailPane,
    },
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg text-fg">
      <div
        className="flex h-16 shrink-0 items-center gap-4 px-6"
        style={{
          background: "linear-gradient(180deg, rgba(167,139,250,0.06) 0%, rgba(167,139,250,0.01) 100%)",
          borderBottom: "1px solid rgba(167,139,250,0.10)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg, rgba(167,139,250,0.18) 0%, rgba(139,92,246,0.08) 100%)",
              border: "1px solid rgba(167,139,250,0.15)",
            }}
          >
            <Sparkle size={16} weight="bold" className="text-[#A78BFA]" />
          </div>
          <div>
            <div className="text-[15px] font-bold tracking-tight text-[#FAFAFA]">Review</div>
            <div className="text-[11px] text-[#94A3B8]">Launch a review on the left, then inspect the selected run on the right.</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chip className="text-[9px]">{runs.length} runs</Chip>
          <Chip className="text-[9px]">{activeRuns} active</Chip>
          <Chip className="text-[9px]">{totalFindings} findings</Chip>
          <Chip className="text-[9px]">{selectedLane ? selectedLane.name : "No lane selected"}</Chip>
          <Chip className="text-[9px]">{launchContext?.defaultBranchName ?? "default branch"}</Chip>
          {loadingLaunch ? <Chip className="text-[9px]">loading context</Chip> : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void refreshLaunchContext()}>
            <ArrowsClockwise size={12} weight="regular" className={cn(loadingLaunch && "animate-spin")} />
            Refresh context
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refreshRuns()}>
            <ArrowsClockwise size={12} weight="regular" />
            Refresh runs
          </Button>
        </div>
      </div>

      {error && !loadingRuns ? (
        <div role="alert" className="border-b border-red-400/15 bg-red-500/[0.06] px-6 py-2.5 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-hidden">
        <PaneTilingLayout
          layoutId="review:tiling:v1"
          tree={REVIEW_TILING_TREE}
          panes={paneConfigs}
          className="flex-1 min-h-0"
        />
      </div>
    </div>
  );
}
