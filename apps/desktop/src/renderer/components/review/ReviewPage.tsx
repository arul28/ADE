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
import {
  listReviewLaunchContext,
  listReviewRuns,
  getReviewRunDetail,
  onReviewEvent,
  rerunReview,
  startReviewRun,
} from "./reviewApi";
import type {
  ReviewArtifact,
  ReviewEvidenceEntry,
  ReviewFinding,
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
};

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

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
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
  return "Dirty working tree";
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
    modelId: getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex",
    reasoningEffort: "medium",
    maxFiles: 25,
    maxDiffChars: 120_000,
    maxPromptChars: 60_000,
    maxFindings: 8,
  }));

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
      void refreshRuns();
      if (event.runId === selectedRunId) {
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
    const laneCommits = launchContext?.recentCommitsByLane?.[launchDraft.laneId] ?? [];
    if (laneCommits.length < 2) return;
    setLaunchDraft((prev) => {
      if (prev.targetMode !== "commit_range") return prev;
      if (prev.baseCommit || prev.headCommit) return prev;
      const [head, base] = laneCommits;
      return {
        ...prev,
        baseCommit: base?.sha ?? "",
        headCommit: head?.sha ?? "",
      };
    });
  }, [launchContext?.recentCommitsByLane, launchDraft.laneId, launchDraft.targetMode]);

  const selectedLaneCommits = launchContext?.recentCommitsByLane?.[launchDraft.laneId] ?? [];
  const activeRuns = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const totalFindings = runs.reduce((sum, run) => sum + (run.findingCount ?? 0), 0);
  const launchReady = isLaunchDraftComplete(launchDraft);

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
    if (launchDraft.targetMode === "lane_diff" && launchDraft.compareKind === "lane" && !launchDraft.compareLaneId.trim()) {
      setError("Choose another lane to compare against.");
      return;
    }
    if (launchDraft.targetMode === "commit_range" && (!launchDraft.baseCommit.trim() || !launchDraft.headCommit.trim())) {
      setError("Enter both the base and head commit for a commit-range review.");
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
  }, [launchDraft, laneById, refreshRuns, setSearchParams]);

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
                ["working_tree", "Working tree"],
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

          {launchDraft.targetMode === "lane_diff" ? (
            <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
              <div className="text-[11px] text-[#C5D2E6]">
                Default compares this lane against its upstream / default branch. You can switch to another lane when you want a lane-to-lane review.
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
                        {kind === "default_branch" ? "Default branch" : "Another lane"}
                      </button>
                    );
                  })}
                </div>
              </label>
              {launchDraft.compareKind === "lane" ? (
                <label className="grid gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Compare lane</span>
                  <select
                    className="h-9 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none transition-colors focus:border-[#A78BFA55]"
                    value={launchDraft.compareLaneId}
                    onChange={(e) => updateDraft("compareLaneId", e.target.value)}
                  >
                    <option value="">Choose lane...</option>
                    {laneOptions.filter((lane) => lane.id !== launchDraft.laneId).map((lane) => (
                      <option key={lane.id} value={lane.id}>{lane.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}

          {launchDraft.targetMode === "commit_range" ? (
            <div className="grid gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
              <div className="text-[11px] text-[#C5D2E6]">
                Review only the commits between the base and head revision. The base commit is excluded; the head commit is included.
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Base commit</span>
                  <input
                    value={launchDraft.baseCommit}
                    onChange={(e) => updateDraft("baseCommit", e.target.value)}
                    placeholder="abc1234"
                    className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none placeholder:text-[#64748B] focus:border-[#A78BFA55]"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Head commit</span>
                  <input
                    value={launchDraft.headCommit}
                    onChange={(e) => updateDraft("headCommit", e.target.value)}
                    placeholder="def4567"
                    className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none placeholder:text-[#64748B] focus:border-[#A78BFA55]"
                  />
                </label>
              </div>
              {launchDraft.laneId && selectedLaneCommits.length < 2 ? (
                <div className="text-[11px] text-[#94A3B8]">
                  At least two recent commits are needed to auto-fill this range. Enter the base and head SHAs manually or choose a lane with more history.
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Model</span>
              <input
                value={launchDraft.modelId}
                onChange={(e) => updateDraft("modelId", e.target.value)}
                placeholder="openai/gpt-5.4-codex"
                className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none placeholder:text-[#64748B] focus:border-[#A78BFA55]"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[1px] text-[#8FA1B8]">Reasoning</span>
              <select
                value={launchDraft.reasoningEffort}
                onChange={(e) => updateDraft("reasoningEffort", e.target.value)}
                className="h-9 rounded-xl border border-white/[0.08] bg-black/20 px-3 text-sm text-[#F5FAFF] outline-none transition-colors focus:border-[#A78BFA55]"
              >
                {["low", "medium", "high", "xhigh", "max"].map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-4 gap-2">
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
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-[11px] text-[#94A3B8]">
            Reviews are saved locally. The transcript is attached as supporting context.
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Saved runs"
        icon={ClockCounterClockwise}
        action={(
          <Button size="sm" variant="ghost" onClick={() => void refreshRuns()} disabled={loadingRuns}>
            <ArrowsClockwise size={12} weight="regular" className={cn(loadingRuns && "animate-spin")} />
            Refresh
          </Button>
        )}
      >
        <div className="space-y-2">
          {runs.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
              No saved review runs yet in this workspace.
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
                  <Chip className="text-[9px]">{run.target.mode}</Chip>
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );

  const detailPane = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {selectedRun ? (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
          <section className="rounded-2xl border border-white/[0.08] bg-black/15 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip className={cn("text-[9px]", toReviewStatusTone(selectedRun.status))}>{selectedRun.status}</Chip>
                  <Chip className="text-[9px]">{selectedRun.target.mode}</Chip>
                  <Chip className="text-[9px]">{selectedRun.config.selectionMode}</Chip>
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

          <SectionCard title="Target and configuration" icon={GitBranch}>
            <div className="grid gap-3 md:grid-cols-2">
              <MetaCard label="Target mode" value={selectedRun.target.mode} />
              <MetaCard label="Review target" value={describeRunTarget(selectedRun)} />
              <MetaCard label="Selection mode" value={selectedRun.config.selectionMode} />
              <MetaCard label="Budget / files" value={selectedRun.config.budgets.maxFiles} />
              <MetaCard label="Budget / diff chars" value={selectedRun.config.budgets.maxDiffChars} />
              <MetaCard label="Budget / prompt chars" value={selectedRun.config.budgets.maxPromptChars} />
              <MetaCard label="Budget / findings" value={selectedRun.config.budgets.maxFindings} />
              <MetaCard label="Compare against" value={"kind" in selectedRun.config.compareAgainst ? selectedRun.config.compareAgainst.kind : "default_branch"} />
            </div>
          </SectionCard>

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
            <div className="space-y-2">
              {selectedDetail?.findings?.length ? selectedDetail.findings.map((finding, index) => {
                const evidence = normalizeEvidence(finding.evidence);
                return (
                  <article key={finding.id ?? `${finding.title}-${index}`} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip className={cn("text-[9px]", toSeverityTone(finding.severity))}>{finding.severity}</Chip>
                          <div className="truncate text-sm font-semibold text-[#F5FAFF]">{finding.title}</div>
                        </div>
                        <div className="mt-1 text-xs text-[#93A4B8]">{finding.body}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1 text-[11px] text-[#94A3B8]">
                        <span>confidence {formatConfidence(finding.confidence)}</span>
                        <span>{finding.anchorState} · {finding.sourcePass}</span>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <Chip className="text-[9px]">{finding.publicationState}</Chip>
                      {finding.filePath ? <Chip className="text-[9px]">{finding.filePath}{finding.line ? `:${finding.line}` : ""}</Chip> : null}
                      {finding.filePath ? (
                        <Button size="sm" variant="ghost" onClick={() => handleOpenFindingInFiles(finding)}>
                          <FileText size={12} />
                          Open in files
                        </Button>
                      ) : null}
                      {finding.filePath ? (
                        <Button size="sm" variant="ghost" onClick={() => handleOpenFindingInEditor(finding)}>
                          <ArrowSquareOut size={12} />
                          Open editor
                        </Button>
                      ) : null}
                    </div>
                    {evidence.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {evidence.map((entry, evidenceIndex) => (
                          <div key={`${finding.id ?? finding.title}-${evidenceIndex}`} className="rounded-lg border border-white/[0.06] bg-black/20 p-2">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8FA1B8]">
                              <span className="font-mono uppercase tracking-[1px]">{entry.kind ?? "evidence"}</span>
                              {entry.summary ? <span>{entry.summary}</span> : null}
                              {entry.filePath ? <span>{entry.filePath}{entry.line ? `:${entry.line}` : ""}</span> : null}
                              {entry.artifactId ? <span>{entry.artifactId}</span> : null}
                            </div>
                            {entry.quote ? <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#D8E3F2]">{entry.quote}</pre> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              }) : (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-xs text-[#94A3B8]">
                  No findings were saved for this run.
                </div>
              )}
            </div>
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
                  {artifact.contentText ? <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#D8E3F2]">{artifact.contentText}</pre> : null}
                  {artifact.metadata ? (
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-[#B7C4D7]">
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
      title: "Launch and history",
      icon: Sparkle,
      bodyClassName: "flex flex-col min-h-0",
      children: launchPane,
    },
    detail: {
      title: "Run detail",
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
            <div className="text-[11px] text-[#94A3B8]">Saved review runs, findings, publication records, and transcript history.</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chip className="text-[9px]">{runs.length} saved</Chip>
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
