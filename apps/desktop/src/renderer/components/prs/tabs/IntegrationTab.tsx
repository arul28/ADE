import React from "react";
import { GitMerge, Lightning, Eye, Sparkle, Trash, ArrowRight, CheckCircle, Warning, XCircle, Clock, GithubLogo } from "@phosphor-icons/react";
import type {
  IntegrationProposal,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrWithConflicts,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { PrConflictBadge } from "../PrConflictBadge";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";

const TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "list" }, defaultSize: 36, minSize: 20 },
    { node: { type: "pane", id: "detail" }, defaultSize: 64, minSize: 30 },
  ],
};

function normalizeBranchName(ref: string): string {
  const trimmed = ref.trim();
  const branch = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

/* ---- Outcome dot with design-system colors ---- */

function OutcomeDot({ outcome }: { outcome: "clean" | "conflict" | "blocked" | "pending" }) {
  const config = {
    clean:   { icon: CheckCircle, color: "#22C55E" },
    conflict:{ icon: Warning,     color: "#F59E0B" },
    blocked: { icon: XCircle,     color: "#EF4444" },
    pending: { icon: Clock,       color: "#71717A" },
  }[outcome];
  const Icon = config.icon;
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ width: 20, height: 20, background: `${config.color}18` }}
    >
      <Icon size={12} weight="fill" style={{ color: config.color }} />
    </span>
  );
}

/* ---- State badge ---- */

function StateBadge({ state }: { state: string }) {
  const map: Record<string, { label: string; bg: string; fg: string; border: string }> = {
    draft:  { label: "DRAFT",  bg: "#A78BFA18", fg: "#A78BFA", border: "#A78BFA30" },
    open:   { label: "OPEN",   bg: "#3B82F618", fg: "#3B82F6", border: "#3B82F630" },
    merged: { label: "MERGED", bg: "#22C55E18", fg: "#22C55E", border: "#22C55E30" },
    closed: { label: "CLOSED", bg: "#71717A18", fg: "#71717A", border: "#71717A30" },
  };
  const s = map[state] ?? map.closed;
  return (
    <span
      className="font-mono font-bold tracking-[1px] uppercase"
      style={{
        fontSize: 10,
        padding: "2px 8px",
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
      }}
    >
      {s.label}
    </span>
  );
}

/* ---- Overall outcome badge ---- */

function OutcomeBadge({ outcome }: { outcome: "clean" | "conflict" | "blocked" }) {
  const map = {
    clean:    { label: "CLEAN",    bg: "#22C55E18", fg: "#22C55E", border: "#22C55E30" },
    conflict: { label: "CONFLICT", bg: "#F59E0B18", fg: "#F59E0B", border: "#F59E0B30" },
    blocked:  { label: "BLOCKED",  bg: "#EF444418", fg: "#EF4444", border: "#EF444430" },
  };
  const s = map[outcome];
  return (
    <span
      className="font-mono font-bold tracking-[1px] uppercase"
      style={{
        fontSize: 10,
        padding: "3px 10px",
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
      }}
    >
      {s.label}
    </span>
  );
}

/* ---- Section header ---- */

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono font-bold uppercase tracking-[1px]"
      style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}
    >
      {children}
    </div>
  );
}

/* ---- Lane chip ---- */

function LaneChip({ name, variant = "default" }: { name: string; variant?: "default" | "accent" }) {
  const isAccent = variant === "accent";
  return (
    <span
      className="font-mono font-bold uppercase tracking-[1px] inline-flex items-center"
      style={{
        fontSize: 10,
        padding: "4px 10px",
        background: isAccent ? "#A78BFA18" : "#13101A",
        color: isAccent ? "#A78BFA" : "#FAFAFA",
        border: `1px solid ${isAccent ? "#A78BFA30" : "#1E1B26"}`,
      }}
    >
      {name}
    </span>
  );
}

/* ---- Status badge for lane readiness ---- */

function LaneStatusBadge({ outcome }: { outcome: "clean" | "conflict" | "blocked" | "pending" }) {
  const map = {
    clean:    { label: "READY",    fg: "#22C55E", bg: "#22C55E18" },
    conflict: { label: "CONFLICT", fg: "#F59E0B", bg: "#F59E0B18" },
    blocked:  { label: "BLOCKED",  fg: "#EF4444", bg: "#EF444418" },
    pending:  { label: "PENDING",  fg: "#71717A", bg: "#71717A18" },
  };
  const s = map[outcome];
  return (
    <span
      className="font-mono font-bold uppercase tracking-[1px]"
      style={{ fontSize: 9, padding: "1px 6px", background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

/* ======== Main component ======== */

type IntegrationTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

export function IntegrationTab({ prs, lanes, mergeContextByPrId, mergeMethod, selectedPrId, onSelectPr, onRefresh }: IntegrationTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [simulateResult, setSimulateResult] = React.useState<IntegrationProposal | null>(null);
  const [simulateBusy, setSimulateBusy] = React.useState(false);
  const [simulateError, setSimulateError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);
  const selectedMergeContext = selectedPr ? mergeContextByPrId[selectedPr.id] ?? null : null;

  // Auto-select first
  React.useEffect(() => {
    if (prs.length === 0 && selectedPrId === null) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    onSelectPr(prs[0]?.id ?? null);
  }, [prs, selectedPrId, onSelectPr]);

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

  const handleSimulate = async () => {
    if (!selectedPr) return;
    const sourceIds = selectedMergeContext?.sourceLaneIds ?? [selectedPr.laneId];
    setSimulateBusy(true); setSimulateError(null); setSimulateResult(null);
    try {
      const result = await window.ade.prs.simulateIntegration({ sourceLaneIds: sourceIds, baseBranch: selectedPr.baseBranch });
      setSimulateResult(result);
    } catch (err: unknown) {
      setSimulateError(err instanceof Error ? err.message : String(err));
    } finally { setSimulateBusy(false); }
  };

  React.useEffect(() => { setSimulateResult(null); setSimulateError(null); setDeleteConfirm(false); }, [selectedPrId]);

  const handleDelete = async () => {
    if (!selectedPr) return;
    setDeleteBusy(true);
    try {
      await window.ade.prs.delete({ prId: selectedPr.id, closeOnGitHub: deleteCloseGh });
      setDeleteConfirm(false);
      onSelectPr(null);
      await onRefresh();
    } catch (err: unknown) {
      setSimulateError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  const hasConflicts = simulateResult?.overallOutcome === "conflict" || simulateResult?.overallOutcome === "blocked";

  /* ---- Build step outcome map for lane status badges ---- */
  const stepOutcomeByLaneId = React.useMemo(() => {
    if (!simulateResult) return new Map<string, "clean" | "conflict" | "blocked" | "pending">();
    return new Map(simulateResult.steps.map((s) => [s.laneId, s.outcome]));
  }, [simulateResult]);

  /* ============================================================
   *  LEFT PANEL — Integration PR List
   * ============================================================ */

  const listPane = (
    <div style={{ background: "#0F0D14", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          padding: "14px 16px 10px",
          borderBottom: "1px solid #1E1B26",
          background: "#0C0A10",
        }}
      >
        <span
          className="font-mono font-bold uppercase tracking-[1px]"
          style={{ fontSize: 10, color: "#A1A1AA" }}
        >
          INTEGRATION PRS
        </span>
      </div>

      {/* List body */}
      <div style={{ padding: 8, overflowY: "auto", height: "calc(100% - 44px)" }}>
        {!prs.length ? (
          <EmptyState
            title="No integration PRs"
            description="Use Create PR to set up an integration branch from multiple lanes."
          />
        ) : (
          <div className="flex flex-col" style={{ gap: 2 }}>
            {prs.map((pr) => {
              const ctx = mergeContextByPrId[pr.id];
              const isSelected = pr.id === selectedPrId;
              return (
                <button
                  key={pr.id}
                  type="button"
                  className="flex w-full items-start justify-between text-left transition-colors duration-100"
                  style={{
                    padding: "10px 12px",
                    gap: 8,
                    background: isSelected ? "#A78BFA12" : "transparent",
                    borderLeft: isSelected ? "3px solid #A78BFA" : "3px solid transparent",
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#13101A"; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => onSelectPr(pr.id)}
                >
                  <div className="min-w-0 flex-1">
                    {/* PR number + title */}
                    <div className="flex items-center" style={{ gap: 6 }}>
                      <span className="font-mono" style={{ fontSize: 11, color: "#71717A" }}>
                        #{pr.githubPrNumber}
                      </span>
                      <span
                        className="truncate font-mono font-semibold"
                        style={{ fontSize: 12, color: "#FAFAFA" }}
                      >
                        {pr.title}
                      </span>
                    </div>

                    {/* Integration badge + source count + arrow + target */}
                    <div className="flex items-center" style={{ gap: 6, marginTop: 6 }}>
                      <span
                        className="font-mono font-bold uppercase tracking-[1px]"
                        style={{
                          fontSize: 9,
                          padding: "1px 6px",
                          background: "#A78BFA18",
                          color: "#A78BFA",
                          border: "1px solid #A78BFA30",
                        }}
                      >
                        INTEGRATION
                      </span>
                      <span className="font-mono" style={{ fontSize: 10, color: "#A1A1AA" }}>
                        {ctx?.sourceLaneIds.length ?? 0} sources
                      </span>
                      <ArrowRight size={9} weight="bold" style={{ color: "#52525B" }} />
                      <span className="font-mono" style={{ fontSize: 10, color: "#A1A1AA" }}>
                        {laneById.get(ctx?.targetLaneId ?? pr.laneId)?.name ?? "target"}
                      </span>
                    </div>
                  </div>

                  {/* Conflict badge */}
                  <div className="flex items-center shrink-0" style={{ gap: 6 }}>
                    <PrConflictBadge
                      riskLevel={pr.conflictAnalysis?.riskLevel ?? null}
                      overlappingFileCount={pr.conflictAnalysis?.overlapCount}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  /* ============================================================
   *  RIGHT PANEL — Integration Detail
   * ============================================================ */

  const detailPane = selectedPr ? (
    <div style={{ background: "#0F0D14", height: "100%", overflowY: "auto" }}>
      <div style={{ padding: 20 }}>
        {/* ---- Header card ---- */}
        <div
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div className="flex items-start justify-between" style={{ gap: 12 }}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center" style={{ gap: 8 }}>
                <span className="font-mono" style={{ fontSize: 18, color: "#71717A" }}>
                  #{selectedPr.githubPrNumber}
                </span>
                <span
                  className="truncate font-bold"
                  style={{ fontSize: 18, color: "#FAFAFA", fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  {selectedPr.title}
                </span>
              </div>
              <div className="flex items-center" style={{ gap: 10, marginTop: 8 }}>
                <span className="font-mono" style={{ fontSize: 11, color: "#71717A" }}>
                  +{selectedPr.additions} -{selectedPr.deletions}
                </span>
                <span className="font-mono" style={{ fontSize: 11, color: "#52525B" }}>
                  {selectedPr.headBranch}
                </span>
                <ArrowRight size={10} weight="bold" style={{ color: "#52525B" }} />
                <span className="font-mono" style={{ fontSize: 11, color: "#52525B" }}>
                  {selectedPr.baseBranch}
                </span>
              </div>
            </div>

            <div className="flex items-center shrink-0" style={{ gap: 8 }}>
              <StateBadge state={selectedPr.state} />
              <PrConflictBadge
                riskLevel={selectedPr.conflictAnalysis?.riskLevel ?? null}
                overlappingFileCount={selectedPr.conflictAnalysis?.overlapCount}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={simulateBusy}
                onClick={() => void handleSimulate()}
                className="ml-2"
                style={{ borderRadius: 0 }}
              >
                <Lightning size={12} weight="fill" className="mr-1" />
                <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 10 }}>
                  {simulateBusy ? "SIMULATING..." : "SIMULATE MERGE"}
                </span>
              </Button>
            </div>
          </div>
        </div>

        {/* ---- Source Lanes section ---- */}
        <div
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            padding: 16,
            marginBottom: 20,
          }}
        >
          <SectionHeader>SOURCE LANES</SectionHeader>
          <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
            {mergeSourcesResolved.map((s) => {
              const outcome = stepOutcomeByLaneId.get(s.laneId);
              return (
                <div key={s.laneId} className="flex items-center" style={{ gap: 6 }}>
                  <LaneChip name={s.laneName} />
                  {outcome && <LaneStatusBadge outcome={outcome} />}
                </div>
              );
            })}
            <ArrowRight size={14} weight="bold" style={{ color: "#52525B", margin: "0 4px" }} />
            <LaneChip
              name={laneById.get(resolverTargetLaneId ?? "")?.name ?? "target"}
              variant="accent"
            />
          </div>
        </div>

        {/* ---- Merge Simulation section ---- */}
        <div
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            padding: 16,
            marginBottom: 20,
          }}
        >
          <SectionHeader>MERGE SIMULATION</SectionHeader>

          {simulateResult ? (
            <div>
              {/* Overall outcome */}
              <div style={{ marginBottom: 16 }}>
                <OutcomeBadge outcome={simulateResult.overallOutcome} />
              </div>

              {/* Step-by-step results */}
              <div className="flex flex-col" style={{ gap: 4 }}>
                {simulateResult.steps.map((step) => {
                  const outcomeColor =
                    step.outcome === "clean" ? "#22C55E" :
                    step.outcome === "conflict" ? "#F59E0B" :
                    step.outcome === "blocked" ? "#EF4444" : "#71717A";
                  return (
                    <div
                      key={step.laneId}
                      style={{
                        background: `${outcomeColor}08`,
                        border: `1px solid ${outcomeColor}15`,
                        padding: "10px 12px",
                      }}
                    >
                      <div className="flex items-center justify-between" style={{ gap: 8 }}>
                        <div className="flex items-center" style={{ gap: 8 }}>
                          <OutcomeDot outcome={step.outcome} />
                          <span className="font-mono font-semibold" style={{ fontSize: 12, color: "#FAFAFA" }}>
                            {step.laneName}
                          </span>
                        </div>
                        <span
                          className="font-mono font-bold uppercase tracking-[1px]"
                          style={{ fontSize: 10, color: outcomeColor }}
                        >
                          {step.outcome}
                        </span>
                      </div>

                      {/* Diff stats */}
                      <div className="font-mono" style={{ marginTop: 6, marginLeft: 28, fontSize: 11, color: "#71717A" }}>
                        <span style={{ color: "#22C55E" }}>+{step.diffStat.insertions}</span>
                        {" "}
                        <span style={{ color: "#EF4444" }}>-{step.diffStat.deletions}</span>
                        <span style={{ color: "#52525B", marginLeft: 8 }}>
                          {step.diffStat.filesChanged} {step.diffStat.filesChanged === 1 ? "file" : "files"}
                        </span>
                      </div>

                      {/* Conflicting files */}
                      {step.conflictingFiles.length > 0 && (
                        <div style={{ marginTop: 6, marginLeft: 28 }}>
                          <span
                            className="font-mono font-bold uppercase tracking-[1px]"
                            style={{ fontSize: 9, color: "#F59E0B", marginBottom: 4, display: "block" }}
                          >
                            CONFLICTING FILES
                          </span>
                          {step.conflictingFiles.map((f) => (
                            <div key={f.path} className="font-mono" style={{ fontSize: 11, color: "#F59E0B", opacity: 0.8 }}>
                              {f.path}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="font-mono" style={{ fontSize: 11, color: "#52525B", padding: "12px 0" }}>
              Run a simulation to preview merge outcomes for each source lane.
            </div>
          )}

          {simulateError && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                background: "#EF444410",
                border: "1px solid #EF444425",
              }}
            >
              <span className="font-mono" style={{ fontSize: 11, color: "#EF4444" }}>{simulateError}</span>
            </div>
          )}
        </div>

        {/* ---- Conflict warning zone ---- */}
        {hasConflicts && (
          <div
            style={{
              background: "#F59E0B08",
              border: "1px solid #F59E0B25",
              padding: 16,
              marginBottom: 20,
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center" style={{ gap: 8 }}>
                <Warning size={16} weight="fill" style={{ color: "#F59E0B" }} />
                <span className="font-mono font-semibold" style={{ fontSize: 12, color: "#F59E0B" }}>
                  Conflicts detected — resolve before merging
                </span>
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setResolverOpen(true)}
                style={{ borderRadius: 0 }}
              >
                <Sparkle size={12} weight="fill" className="mr-1" />
                <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 10 }}>
                  FIX WITH AI
                </span>
              </Button>
            </div>
          </div>
        )}

        {/* ---- Action bar ---- */}
        <div style={{ marginBottom: 20 }}>
          <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
            {/* Open on GitHub - primary */}
            <Button
              size="sm"
              variant="primary"
              onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}
              style={{ borderRadius: 0 }}
            >
              <GithubLogo size={14} weight="regular" className="mr-1" />
              <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 10 }}>
                OPEN ON GITHUB
              </span>
            </Button>

            {/* Resolve with AI - accent outline */}
            {!hasConflicts && (
              <button
                type="button"
                className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                style={{
                  fontSize: 10,
                  height: 28,
                  padding: "0 10px",
                  background: "transparent",
                  color: "#A78BFA",
                  border: "1px solid #A78BFA30",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#A78BFA12"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                onClick={() => setResolverOpen(true)}
              >
                <Sparkle size={12} weight="regular" style={{ marginRight: 4 }} />
                RESOLVE WITH AI
              </button>
            )}

            {/* Remove PR - red outline */}
            <button
              type="button"
              className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
              style={{
                fontSize: 10,
                height: 28,
                padding: "0 10px",
                background: "transparent",
                color: "#EF4444",
                border: "1px solid #EF444430",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#EF444412"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              onClick={() => setDeleteConfirm(true)}
            >
              <Trash size={12} weight="regular" style={{ marginRight: 4 }} />
              REMOVE PR
            </button>
          </div>

          {/* Delete confirmation panel */}
          {deleteConfirm && (
            <div
              style={{
                marginTop: 12,
                padding: 16,
                background: "#EF444408",
                border: "1px solid #EF444420",
              }}
            >
              <div className="font-mono font-semibold" style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>
                Remove this integration PR from ADE?
              </div>
              <label
                className="flex items-center font-mono cursor-pointer"
                style={{ fontSize: 11, color: "#A1A1AA", gap: 6, marginBottom: 12 }}
              >
                <input
                  type="checkbox"
                  checked={deleteCloseGh}
                  onChange={(e) => setDeleteCloseGh(e.target.checked)}
                  style={{ accentColor: "#A78BFA" }}
                />
                Also close on GitHub
              </label>
              <div className="flex items-center" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                  style={{
                    fontSize: 10,
                    height: 28,
                    padding: "0 10px",
                    background: "transparent",
                    color: "#EF4444",
                    border: "1px solid #EF444440",
                    cursor: deleteBusy ? "not-allowed" : "pointer",
                    opacity: deleteBusy ? 0.5 : 1,
                  }}
                  disabled={deleteBusy}
                  onClick={() => void handleDelete()}
                >
                  {deleteBusy ? "REMOVING..." : "CONFIRM REMOVE"}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                  style={{
                    fontSize: 10,
                    height: 28,
                    padding: "0 10px",
                    background: "transparent",
                    color: "#A1A1AA",
                    border: "1px solid #27272A",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#13101A"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  onClick={() => setDeleteConfirm(false)}
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---- Resolver modal (unchanged) ---- */}
        <ResolverTerminalModal
          open={resolverOpen}
          onOpenChange={setResolverOpen}
          sourceLaneId={mergeSourcesResolved[0]?.laneId ?? selectedPr.laneId}
          sourceLaneIds={mergeSourcesResolved.length > 1 ? mergeSourcesResolved.map((s) => s.laneId) : undefined}
          targetLaneId={resolverTargetLaneId}
          cwdLaneId={resolverTargetLaneId}
          scenario={mergeSourcesResolved.length > 1 ? "integration-merge" : "single-merge"}
          onCompleted={() => void onRefresh()}
        />
      </div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center" style={{ background: "#0F0D14" }}>
      <EmptyState
        title="No integration PR selected"
        description="Select an integration PR or create one via the Create PR button."
      />
    </div>
  );

  /* ============================================================
   *  Pane configs for PaneTilingLayout
   * ============================================================ */

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Integration PRs",
      icon: GitMerge,
      bodyClassName: "overflow-auto",
      children: listPane,
    },
    detail: {
      title: selectedPr ? `Integration: #${selectedPr.githubPrNumber}` : "Integration Detail",
      icon: Eye,
      bodyClassName: "overflow-auto",
      children: detailPane,
    },
  }), [prs, selectedPr, selectedPrId, mergeContextByPrId, laneById, mergeSourcesResolved, resolverTargetLaneId, simulateResult, simulateBusy, simulateError, resolverOpen, deleteConfirm, deleteBusy, deleteCloseGh, hasConflicts, onSelectPr, onRefresh, stepOutcomeByLaneId]);

  return <PaneTilingLayout layoutId="prs:integration:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
