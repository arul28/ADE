import React from "react";
import {
  GitMerge,
  Lightning,
  Sparkle,
  Trash,
  Plus,
  ArrowRight,
  CheckCircle,
  Warning,
  XCircle,
  Clock,
  GithubLogo,
  CaretDown,
  CaretRight,
} from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import type {
  CreateIntegrationPrResult,
  IntegrationProposal,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrWithConflicts,
  RiskMatrixEntry,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PrConflictBadge } from "../PrConflictBadge";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";
import { useAppStore } from "../../../state/appStore";

function normalizeBranchName(ref: string): string {
  const trimmed = ref.trim();
  const branch = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

type IntegrationTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

// ---- Sidebar List Item ----
function SidebarItem({
  pr,
  isSelected,
  mergeContext,
  laneById,
  onClick,
}: {
  pr: PrWithConflicts;
  isSelected: boolean;
  mergeContext: PrMergeContext | undefined;
  laneById: Map<string, LaneSummary>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-xs transition-all duration-150",
        isSelected
          ? "border-l-2 border-l-accent bg-accent/8 pl-3"
          : "border-l-2 border-l-transparent hover:bg-card/40 hover:pl-3.5",
      )}
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-fg/60">#{pr.githubPrNumber}</span>
          <span className={cn("truncate font-medium", isSelected ? "text-fg" : "text-fg/80")}>{pr.title}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-fg/60">
          <span>{mergeContext?.sourceLaneIds.length ?? 0} sources</span>
          <ArrowRight size={9} weight="bold" className="text-muted-fg/40" />
          <span className="text-fg/60">{laneById.get(mergeContext?.targetLaneId ?? pr.laneId)?.name ?? "target"}</span>
        </div>
      </div>
      <div className="shrink-0 mt-0.5 opacity-80 group-hover:opacity-100 transition-opacity">
        <PrConflictBadge riskLevel={pr.conflictAnalysis?.riskLevel ?? null} overlappingFileCount={pr.conflictAnalysis?.overlapCount} />
      </div>
    </button>
  );
}

// ---- Status dot for pipeline steps ----
function OutcomeDot({ outcome }: { outcome: "clean" | "conflict" | "blocked" | "pending" }) {
  const config = {
    clean: { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-400/15" },
    conflict: { icon: Warning, color: "text-amber-400", bg: "bg-amber-400/15" },
    blocked: { icon: XCircle, color: "text-red-400", bg: "bg-red-400/15" },
    pending: { icon: Clock, color: "text-muted-fg/50", bg: "bg-muted/20" },
  }[outcome];
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center justify-center w-5 h-5 rounded-full", config.bg)}>
      <Icon size={12} weight="fill" className={config.color} />
    </span>
  );
}

// ---- State chip for PR status ----
function StateChip({ state }: { state: string }) {
  const styles: Record<string, string> = {
    open: "text-emerald-400 bg-emerald-400/10",
    merged: "text-violet-400 bg-violet-400/10",
    closed: "text-red-400 bg-red-400/10",
    draft: "text-muted-fg bg-muted/30",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", styles[state] ?? styles.draft)}>
      {state}
    </span>
  );
}

// ---- Inline Creation Form ----
function CreationForm({
  lanes,
  onCreated,
  onCancel,
}: {
  lanes: LaneSummary[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const appLanes = useAppStore((s) => s.lanes);
  const primaryLane = React.useMemo(() => appLanes.find((l) => l.laneType === "primary") ?? null, [appLanes]);
  const nonPrimaryLanes = React.useMemo(() => lanes.filter((l) => l.laneType !== "primary"), [lanes]);

  const [selectedSources, setSelectedSources] = React.useState<string[]>([]);
  const [integrationName, setIntegrationName] = React.useState("integration");
  const [prTitle, setPrTitle] = React.useState("");
  const [prBody, setPrBody] = React.useState("");
  const [draft, setDraft] = React.useState(false);

  // Risk assessment
  const [riskRows, setRiskRows] = React.useState<Array<{ laneAId: string; laneBId: string; riskLevel: RiskMatrixEntry["riskLevel"] | "unknown" }>>([]);
  const [riskLoading, setRiskLoading] = React.useState(false);

  // Simulation
  const [simulateResult, setSimulateResult] = React.useState<IntegrationProposal | null>(null);
  const [simulateBusy, setSimulateBusy] = React.useState(false);
  const [simulated, setSimulated] = React.useState(false);

  // Creation
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Config section expanded
  const [configExpanded, setConfigExpanded] = React.useState(false);

  const pairKey = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);

  const toggleSource = (laneId: string) => {
    setSelectedSources((prev) =>
      prev.includes(laneId) ? prev.filter((id) => id !== laneId) : [...prev, laneId],
    );
    // Reset simulation when sources change
    setSimulateResult(null);
    setSimulated(false);
  };

  // Fetch risk when sources change (2+ selected)
  React.useEffect(() => {
    if (selectedSources.length < 2) {
      setRiskRows([]);
      return;
    }
    let cancelled = false;
    setRiskLoading(true);
    window.ade.conflicts
      .getBatchAssessment()
      .then((assessment) => {
        if (cancelled) return;
        const matrix = assessment?.matrix ?? [];
        const matrixByPair = new Map(matrix.map((entry) => [pairKey(entry.laneAId, entry.laneBId), entry]));
        const rows: typeof riskRows = [];
        const unique = Array.from(new Set(selectedSources));
        for (let i = 0; i < unique.length; i++) {
          for (let j = i + 1; j < unique.length; j++) {
            const a = unique[i]!;
            const b = unique[j]!;
            const match = matrixByPair.get(pairKey(a, b));
            rows.push({ laneAId: a, laneBId: b, riskLevel: match?.riskLevel ?? "unknown" });
          }
        }
        setRiskRows(rows);
      })
      .catch(() => {
        if (!cancelled) setRiskRows([]);
      })
      .finally(() => {
        if (!cancelled) setRiskLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedSources]);

  const baseBranch = primaryLane?.branchRef ?? "main";

  const handleSimulate = async () => {
    setSimulateBusy(true);
    setError(null);
    setSimulateResult(null);
    try {
      const result = await window.ade.prs.simulateIntegration({ sourceLaneIds: selectedSources, baseBranch });
      setSimulateResult(result);
      setSimulated(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimulateBusy(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      await window.ade.prs.createIntegration({
        sourceLaneIds: selectedSources,
        integrationLaneName: integrationName,
        baseBranch,
        title: prTitle || `Integration: ${integrationName}`,
        body: prBody,
        draft,
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const laneMap = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="flex flex-col gap-6 p-5 overflow-auto h-full"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-fg">New Integration</h2>
          <p className="text-xs text-muted-fg/60 mt-0.5">Select source lanes to merge into an integration branch</p>
        </div>
        <button
          onClick={onCancel}
          className="text-xs text-muted-fg hover:text-fg transition-colors px-2 py-1 rounded hover:bg-muted/20"
        >
          Cancel
        </button>
      </div>

      {/* Step 1: Source lanes */}
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-fg">Source lanes</div>
        <div className="grid grid-cols-2 gap-2">
          {nonPrimaryLanes.map((lane) => {
            const isSelected = selectedSources.includes(lane.id);
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => toggleSource(lane.id)}
                className={cn(
                  "group relative rounded-lg p-3 text-left transition-all duration-150",
                  isSelected
                    ? "bg-accent/10 ring-1 ring-accent/30"
                    : "bg-card/30 hover:bg-card/50",
                )}
              >
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "w-2 h-2 rounded-full transition-all duration-200",
                    isSelected ? "bg-accent scale-125" : "bg-muted-fg/25 group-hover:bg-muted-fg/40",
                  )} />
                  <span className={cn("text-xs font-medium truncate", isSelected ? "text-fg" : "text-fg/70")}>
                    {lane.name}
                  </span>
                </div>
                <div className="mt-1 ml-4 text-[10px] text-muted-fg/50 truncate font-mono">{lane.branchRef}</div>
              </button>
            );
          })}
        </div>
        {nonPrimaryLanes.length === 0 && (
          <div className="text-xs text-muted-fg/50 italic py-4 text-center">No non-primary lanes available</div>
        )}
      </div>

      {/* Conflict preview (when 2+ sources selected) */}
      {selectedSources.length >= 2 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="space-y-2"
        >
          <div className="text-xs font-medium text-muted-fg">Pairwise risk</div>
          {riskLoading ? (
            <div className="flex items-center gap-2 py-2">
              <div className="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin" />
              <span className="text-[11px] text-muted-fg/60">Checking conflicts...</span>
            </div>
          ) : riskRows.length > 0 ? (
            <div className="space-y-1">
              {riskRows.map((row) => {
                const nameA = laneMap.get(row.laneAId)?.name ?? row.laneAId;
                const nameB = laneMap.get(row.laneBId)?.name ?? row.laneBId;
                const riskColor = {
                  high: "text-red-400",
                  medium: "text-amber-400",
                  low: "text-emerald-400",
                  none: "text-emerald-400",
                  unknown: "text-muted-fg/50",
                }[row.riskLevel];
                const riskBg = {
                  high: "bg-red-400/8",
                  medium: "bg-amber-400/8",
                  low: "bg-emerald-400/8",
                  none: "bg-emerald-400/8",
                  unknown: "bg-muted/15",
                }[row.riskLevel];
                return (
                  <div key={`${row.laneAId}:${row.laneBId}`} className={cn("rounded-md px-3 py-2 text-xs flex items-center justify-between", riskBg)}>
                    <div className="flex items-center gap-1.5 text-fg/70 min-w-0">
                      <span className="truncate">{nameA}</span>
                      <ArrowRight size={9} weight="bold" className="text-muted-fg/30 shrink-0" />
                      <span className="truncate">{nameB}</span>
                    </div>
                    <span className={cn("capitalize text-[11px] font-medium shrink-0 ml-2", riskColor)}>
                      {row.riskLevel}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-[11px] text-muted-fg/40 py-1">No risk data available</div>
          )}
        </motion.div>
      )}

      {/* Step 2: Configuration (collapsible) */}
      {selectedSources.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-3"
        >
          <button
            type="button"
            onClick={() => setConfigExpanded(!configExpanded)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-fg hover:text-fg transition-colors"
          >
            {configExpanded ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
            Configuration
          </button>

          <AnimatePresence>
            {configExpanded && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="rounded-lg bg-card/25 p-4 space-y-3">
                  <div>
                    <label className="block text-[11px] text-muted-fg/60 mb-1.5">Integration lane name</label>
                    <input
                      type="text"
                      value={integrationName}
                      onChange={(e) => setIntegrationName(e.target.value)}
                      className="w-full rounded-md bg-muted/15 px-3 py-2 text-xs text-fg placeholder:text-muted-fg/30 focus:outline-none focus:ring-1 focus:ring-accent/30 transition-shadow"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted-fg/60 mb-1.5">PR title</label>
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      className="w-full rounded-md bg-muted/15 px-3 py-2 text-xs text-fg placeholder:text-muted-fg/30 focus:outline-none focus:ring-1 focus:ring-accent/30 transition-shadow"
                      placeholder={`Integration: ${integrationName}`}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted-fg/60 mb-1.5">Description</label>
                    <textarea
                      value={prBody}
                      onChange={(e) => setPrBody(e.target.value)}
                      rows={3}
                      className="w-full rounded-md bg-muted/15 px-3 py-2 text-xs text-fg placeholder:text-muted-fg/30 focus:outline-none focus:ring-1 focus:ring-accent/30 resize-none transition-shadow"
                      placeholder="Optional PR description..."
                    />
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-muted-fg/60 cursor-pointer hover:text-muted-fg transition-colors">
                    <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="rounded" />
                    Create as draft
                  </label>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Simulation results */}
      {simulateResult && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-2"
        >
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-muted-fg">Simulation result</div>
            <span className={cn(
              "text-[10px] font-medium rounded-md px-1.5 py-0.5",
              simulateResult.overallOutcome === "clean" ? "text-emerald-400 bg-emerald-400/10" :
              simulateResult.overallOutcome === "conflict" ? "text-amber-400 bg-amber-400/10" :
              "text-red-400 bg-red-400/10",
            )}>
              {simulateResult.overallOutcome}
            </span>
          </div>
          <div className="space-y-1">
            {simulateResult.steps.map((step) => (
              <div key={step.laneId} className="rounded-md bg-muted/10 px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <OutcomeDot outcome={step.outcome} />
                  <span className="text-xs text-fg/80">{step.laneName}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-fg/50">
                  <span className="text-emerald-400/70">+{step.diffStat.insertions}</span>
                  <span className="text-red-400/70">-{step.diffStat.deletions}</span>
                  <span>{step.diffStat.filesChanged} files</span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-500/8 px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {/* Action bar */}
      {selectedSources.length > 0 && (
        <div className="flex items-center gap-2 pt-2">
          <Button
            size="sm"
            variant="outline"
            disabled={simulateBusy || selectedSources.length < 2}
            onClick={() => void handleSimulate()}
          >
            <Lightning size={12} weight="fill" className="mr-1" />
            {simulateBusy ? "Simulating..." : "Simulate"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={creating || selectedSources.length < 2 || !integrationName.trim()}
            onClick={() => void handleCreate()}
          >
            <GitMerge size={12} weight="regular" className="mr-1" />
            {creating ? "Creating..." : "Create Integration PR"}
          </Button>
        </div>
      )}
    </motion.div>
  );
}

// ---- Detail View for existing integration PR ----
function DetailView({
  pr,
  mergeContext,
  mergeSourcesResolved,
  resolverTargetLaneId,
  laneById,
  onRefresh,
}: {
  pr: PrWithConflicts;
  mergeContext: PrMergeContext | null;
  mergeSourcesResolved: Array<{ laneId: string; laneName: string }>;
  resolverTargetLaneId: string | null;
  laneById: Map<string, LaneSummary>;
  onRefresh: () => Promise<void>;
}) {
  const [simulateResult, setSimulateResult] = React.useState<IntegrationProposal | null>(null);
  const [simulateBusy, setSimulateBusy] = React.useState(false);
  const [simulateError, setSimulateError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [deleteExpanded, setDeleteExpanded] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);
  const [pipelineExpanded, setPipelineExpanded] = React.useState(true);

  // Reset on PR change
  React.useEffect(() => {
    setSimulateResult(null);
    setSimulateError(null);
    setDeleteExpanded(false);
  }, [pr.id]);

  const handleSimulate = async () => {
    const sourceIds = mergeContext?.sourceLaneIds ?? [pr.laneId];
    setSimulateBusy(true);
    setSimulateError(null);
    setSimulateResult(null);
    try {
      const result = await window.ade.prs.simulateIntegration({ sourceLaneIds: sourceIds, baseBranch: pr.baseBranch });
      setSimulateResult(result);
    } catch (err: unknown) {
      setSimulateError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimulateBusy(false);
    }
  };

  const handleDelete = async () => {
    setDeleteBusy(true);
    try {
      await window.ade.prs.delete({ prId: pr.id, closeOnGitHub: deleteCloseGh });
      setDeleteExpanded(false);
      await onRefresh();
    } catch (err: unknown) {
      setSimulateError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const hasConflicts = simulateResult?.overallOutcome === "conflict" || simulateResult?.overallOutcome === "blocked";

  return (
    <motion.div
      key={pr.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex flex-col gap-5 p-5 overflow-auto h-full"
    >
      {/* Summary header */}
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-sm text-muted-fg/50">#{pr.githubPrNumber}</span>
              <StateChip state={pr.state} />
            </div>
            <h2 className="text-base font-semibold text-fg mt-1 leading-snug">{pr.title}</h2>
          </div>
          <PrConflictBadge riskLevel={pr.conflictAnalysis?.riskLevel ?? null} overlappingFileCount={pr.conflictAnalysis?.overlapCount} />
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-fg/50">
          <span className="tabular-nums">+{pr.additions} -{pr.deletions}</span>
          <span>{pr.headBranch}</span>
          <ArrowRight size={9} weight="bold" />
          <span>{pr.baseBranch}</span>
        </div>
      </div>

      {/* Source lanes pipeline */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setPipelineExpanded(!pipelineExpanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-fg hover:text-fg transition-colors"
        >
          {pipelineExpanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
          Source lanes
          <span className="text-muted-fg/40 font-normal ml-1">{mergeSourcesResolved.length} lanes</span>
        </button>

        <AnimatePresence>
          {pipelineExpanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="relative pl-4">
                {/* Vertical connector line */}
                <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gradient-to-b from-border/30 via-border/20 to-transparent" />

                <div className="space-y-1">
                  {mergeSourcesResolved.map((source, idx) => {
                    const simStep = simulateResult?.steps.find((s) => s.laneId === source.laneId);
                    return (
                      <div
                        key={source.laneId}
                        className="relative flex items-center gap-3 rounded-md bg-card/25 px-3 py-2.5 transition-colors hover:bg-card/35"
                      >
                        {/* Node dot on the connector */}
                        <div className="absolute -left-4 top-1/2 -translate-y-1/2">
                          {simStep ? (
                            <OutcomeDot outcome={simStep.outcome} />
                          ) : (
                            <div className="w-2.5 h-2.5 rounded-full bg-muted-fg/20 ring-2 ring-bg" />
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-fg/80 truncate">{source.laneName}</span>
                            {simStep && (
                              <span className={cn(
                                "text-[10px] font-medium",
                                simStep.outcome === "clean" ? "text-emerald-400/70" :
                                simStep.outcome === "conflict" ? "text-amber-400/70" :
                                "text-red-400/70",
                              )}>
                                {simStep.outcome}
                              </span>
                            )}
                          </div>
                          {simStep && (
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-fg/40">
                              <span className="text-emerald-400/50">+{simStep.diffStat.insertions}</span>
                              <span className="text-red-400/50">-{simStep.diffStat.deletions}</span>
                              <span>{simStep.diffStat.filesChanged} files</span>
                            </div>
                          )}
                          {simStep && simStep.conflictingFiles.length > 0 && (
                            <div className="mt-1 text-[10px] text-amber-400/60">
                              {simStep.conflictingFiles.map((f) => f.path).join(", ")}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Target */}
                <div className="relative mt-1 flex items-center gap-3 rounded-md bg-accent/6 px-3 py-2">
                  <div className="absolute -left-4 top-1/2 -translate-y-1/2">
                    <div className="w-2.5 h-2.5 rounded-full bg-accent ring-2 ring-bg" />
                  </div>
                  <GitMerge size={12} weight="fill" className="text-accent/60" />
                  <span className="text-xs font-medium text-accent/80">
                    {laneById.get(resolverTargetLaneId ?? "")?.name ?? pr.baseBranch}
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Simulation section */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={simulateBusy} onClick={() => void handleSimulate()}>
            <Lightning size={12} weight="fill" className="mr-1" />
            {simulateBusy ? "Simulating..." : "Simulate Merge"}
          </Button>
          {simulateResult && (
            <span className={cn(
              "text-[10px] font-medium rounded-md px-2 py-0.5",
              simulateResult.overallOutcome === "clean" ? "text-emerald-400 bg-emerald-400/10" :
              simulateResult.overallOutcome === "conflict" ? "text-amber-400 bg-amber-400/10" :
              "text-red-400 bg-red-400/10",
            )}>
              {simulateResult.overallOutcome}
            </span>
          )}
        </div>
        {simulateError && (
          <div className="rounded-md bg-red-500/8 px-3 py-2 text-xs text-red-300">{simulateError}</div>
        )}
      </div>

      {/* Conflict zone */}
      {hasConflicts && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="rounded-lg bg-amber-500/5 p-4 space-y-3"
        >
          <div className="flex items-center gap-2">
            <Warning size={14} weight="fill" className="text-amber-400" />
            <span className="text-xs font-medium text-amber-300">Conflicts detected</span>
          </div>
          <div className="space-y-1">
            {simulateResult?.steps.filter((s) => s.conflictingFiles.length > 0).map((step) => (
              <div key={step.laneId} className="text-[11px] text-amber-300/70">
                <span className="text-fg/60">{step.laneName}:</span>{" "}
                {step.conflictingFiles.map((f) => f.path).join(", ")}
              </div>
            ))}
          </div>
          <Button size="sm" variant="primary" onClick={() => setResolverOpen(true)}>
            <Sparkle size={13} weight="fill" className="mr-1" />
            Fix with AI
          </Button>
        </motion.div>
      )}

      {/* Actions footer */}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={() => void window.ade.prs.openInGitHub(pr.id)}>
          <GithubLogo size={13} weight="regular" className="mr-1" />
          Open on GitHub
        </Button>
        {!hasConflicts && (
          <Button size="sm" variant="primary" onClick={() => setResolverOpen(true)}>
            <Sparkle size={13} weight="fill" className="mr-1" />
            Resolve with AI
          </Button>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setDeleteExpanded(!deleteExpanded)}
            className="flex items-center gap-1 text-[11px] text-muted-fg/40 hover:text-red-400/70 transition-colors px-2 py-1 rounded hover:bg-red-400/5"
          >
            <Trash size={11} weight="regular" />
            Remove
          </button>
        </div>
      </div>

      {/* Delete confirmation (inline, not modal) */}
      <AnimatePresence>
        {deleteExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="rounded-lg bg-red-500/5 p-3 space-y-2.5">
              <div className="text-xs text-red-300/80">Remove this integration PR from ADE?</div>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-fg/60 cursor-pointer hover:text-muted-fg transition-colors">
                <input type="checkbox" checked={deleteCloseGh} onChange={(e) => setDeleteCloseGh(e.target.checked)} className="rounded" />
                Also close on GitHub
              </label>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={deleteBusy}
                  onClick={() => void handleDelete()}
                  className="text-red-300 hover:bg-red-500/10"
                >
                  {deleteBusy ? "Removing..." : "Confirm"}
                </Button>
                <button
                  type="button"
                  onClick={() => setDeleteExpanded(false)}
                  className="text-[11px] text-muted-fg hover:text-fg transition-colors px-2 py-1"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ResolverTerminalModal
        open={resolverOpen}
        onOpenChange={setResolverOpen}
        sourceLaneId={mergeSourcesResolved[0]?.laneId ?? pr.laneId}
        sourceLaneIds={mergeSourcesResolved.length > 1 ? mergeSourcesResolved.map((s) => s.laneId) : undefined}
        targetLaneId={resolverTargetLaneId}
        cwdLaneId={resolverTargetLaneId}
        scenario={mergeSourcesResolved.length > 1 ? "integration-merge" : "single-merge"}
        onCompleted={() => void onRefresh()}
      />
    </motion.div>
  );
}

// ---- Main Integration Tab ----
export function IntegrationTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedPrId, onSelectPr, onRefresh }: IntegrationTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const [creatingNew, setCreatingNew] = React.useState(false);

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);
  const selectedMergeContext = selectedPr ? mergeContextByPrId[selectedPr.id] ?? null : null;

  // Auto-select first PR
  React.useEffect(() => {
    if (prs.length === 0 && selectedPrId === null) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    onSelectPr(prs[0]?.id ?? null);
  }, [prs, selectedPrId, onSelectPr]);

  // When entering creation mode, deselect PR
  React.useEffect(() => {
    if (creatingNew) onSelectPr(null);
  }, [creatingNew, onSelectPr]);

  // When a PR is selected, exit creation mode
  React.useEffect(() => {
    if (selectedPrId) setCreatingNew(false);
  }, [selectedPrId]);

  const mergeSourcesResolved = React.useMemo(() => {
    if (!selectedPr) return [];
    const sourceIds = selectedMergeContext?.sourceLaneIds ?? [selectedPr.laneId];
    return sourceIds.map((id) => ({ laneId: id, laneName: laneById.get(id)?.name ?? id }));
  }, [selectedPr, selectedMergeContext, laneById]);

  const resolverTargetLaneId = React.useMemo(() => {
    if (selectedMergeContext?.targetLaneId) return selectedMergeContext.targetLaneId;
    if (!selectedPr) return null;
    return lanes.find((l) => normalizeBranchName(l.branchRef) === normalizeBranchName(selectedPr.baseBranch))?.id ?? null;
  }, [lanes, selectedPr, selectedMergeContext]);

  return (
    <div className="flex h-full min-h-0">
      {/* Left sidebar */}
      <div className="w-[280px] shrink-0 flex flex-col border-r border-border/10 overflow-hidden">
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-xs font-medium text-muted-fg/60">Integrations</span>
          <button
            type="button"
            onClick={() => setCreatingNew(true)}
            className={cn(
              "flex items-center gap-1 text-[11px] rounded-md px-2 py-1 transition-all duration-150",
              creatingNew
                ? "text-accent bg-accent/10"
                : "text-muted-fg hover:text-accent hover:bg-accent/5",
            )}
          >
            <Plus size={11} weight="bold" />
            New
          </button>
        </div>

        {/* PR list */}
        <div className="flex-1 overflow-auto px-2 pb-2">
          {prs.length === 0 && !creatingNew ? (
            <div className="flex flex-col items-center justify-center h-full px-4 text-center">
              <GitMerge size={28} weight="regular" className="text-muted-fg/20 mb-3" />
              <div className="text-xs text-muted-fg/50">No integration PRs yet</div>
              <button
                type="button"
                onClick={() => setCreatingNew(true)}
                className="mt-3 text-[11px] text-accent hover:text-accent/80 transition-colors"
              >
                Create your first integration
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {prs.map((pr) => (
                <SidebarItem
                  key={pr.id}
                  pr={pr}
                  isSelected={pr.id === selectedPrId && !creatingNew}
                  mergeContext={mergeContextByPrId[pr.id]}
                  laneById={laneById}
                  onClick={() => {
                    onSelectPr(pr.id);
                    setCreatingNew(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <AnimatePresence mode="wait">
          {creatingNew ? (
            <CreationForm
              key="creation"
              lanes={lanes}
              onCreated={() => {
                setCreatingNew(false);
                void onRefresh();
              }}
              onCancel={() => {
                setCreatingNew(false);
                if (prs.length > 0) onSelectPr(prs[0]!.id);
              }}
            />
          ) : selectedPr ? (
            <DetailView
              key={`detail-${selectedPr.id}`}
              pr={selectedPr}
              mergeContext={selectedMergeContext}
              mergeSourcesResolved={mergeSourcesResolved}
              resolverTargetLaneId={resolverTargetLaneId}
              laneById={laneById}
              onRefresh={onRefresh}
            />
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex h-full items-center justify-center"
            >
              <div className="text-center">
                <GitMerge size={36} weight="regular" className="text-muted-fg/15 mx-auto mb-3" />
                <div className="text-sm text-muted-fg/40">Select an integration PR</div>
                <div className="text-xs text-muted-fg/25 mt-1">or create a new one</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
