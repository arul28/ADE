import React from "react";
import { GitMerge, GitBranch, Lightning, Eye, Sparkle, Trash, ArrowRight, CheckCircle, Warning, XCircle, Clock, GithubLogo, CircleNotch, ArrowsClockwise } from "@phosphor-icons/react";
import type {
  AgentChatProvider,
  IntegrationProposal,
  IntegrationResolutionState,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrWithConflicts,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../../ui/PaneTilingLayout";
import { PrConflictBadge } from "../PrConflictBadge";
import { PrRebaseBanner } from "../PrRebaseBanner";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";
import { usePrs } from "../state/PrsContext";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { IntegrationStepDetail } from "../IntegrationStepDetail";

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
  const { rebaseNeeds, autoRebaseStatuses, setActiveTab } = usePrs();

  const [simulateResult, setSimulateResult] = React.useState<IntegrationProposal | null>(null);
  const [simulateBusy, setSimulateBusy] = React.useState(false);
  const [simulateError, setSimulateError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);

  // Proposals state
  const [proposals, setProposals] = React.useState<IntegrationProposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = React.useState<string | null>(null);
  const [commitBusy, setCommitBusy] = React.useState(false);
  const [commitError, setCommitError] = React.useState<string | null>(null);
  const [resimBusy, setResimBusy] = React.useState(false);
  const [deleteProposalBusy, setDeleteProposalBusy] = React.useState(false);

  // New integration resolution state
  const [expandedStepLaneId, setExpandedStepLaneId] = React.useState<string | null>(null);
  const [resolutionState, setResolutionState] = React.useState<IntegrationResolutionState | null>(null);
  const [activeChatLaneId, setActiveChatLaneId] = React.useState<string | null>(null);
  const [activeChatSessionId, setActiveChatSessionId] = React.useState<string | null>(null);
  const [createLaneBusy, setCreateLaneBusy] = React.useState(false);
  const [resolvingLaneId, setResolvingLaneId] = React.useState<string | null>(null);

  const loadProposals = React.useCallback(async () => {
    try {
      const result = await window.ade.prs.listProposals();
      setProposals(result);
    } catch {
      /* swallow */
    }
  }, []);

  React.useEffect(() => { void loadProposals(); }, [loadProposals]);

  const selectedProposal = React.useMemo(
    () => proposals.find((p) => p.proposalId === selectedProposalId) ?? null,
    [proposals, selectedProposalId],
  );

  const handleSelectPr = (id: string | null) => {
    setSelectedProposalId(null);
    onSelectPr(id);
  };

  const handleSelectProposal = (id: string) => {
    onSelectPr(null);
    setSelectedProposalId(id);
  };

  const selectedPr = React.useMemo(() => prs.find((p) => p.id === selectedPrId) ?? null, [prs, selectedPrId]);
  const selectedMergeContext = selectedPr ? mergeContextByPrId[selectedPr.id] ?? null : null;

  // Auto-select first item (PR or proposal)
  React.useEffect(() => {
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    if (selectedProposalId && proposals.some((p) => p.proposalId === selectedProposalId)) return;
    if (prs.length > 0) {
      handleSelectPr(prs[0].id);
    } else if (proposals.length > 0) {
      handleSelectProposal(proposals[0].proposalId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prs, proposals, selectedPrId, selectedProposalId]);

  const handleCommitProposal = async (p: IntegrationProposal) => {
    setCommitBusy(true);
    setCommitError(null);
    try {
      await window.ade.prs.commitIntegration({
        proposalId: p.proposalId,
        integrationLaneName: p.integrationLaneName || `integration/${Date.now().toString(36)}`,
        title: p.title || "Integration PR",
        body: p.body || "",
        draft: p.draft ?? false,
      });
      setSelectedProposalId(null);
      await loadProposals();
      await onRefresh();
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitBusy(false);
    }
  };

  const handleResimulate = async (p: IntegrationProposal) => {
    setResimBusy(true);
    setCommitError(null);
    try {
      await window.ade.prs.deleteProposal(p.proposalId);
      const result = await window.ade.prs.simulateIntegration({
        sourceLaneIds: p.sourceLaneIds,
        baseBranch: p.baseBranch,
      });
      await loadProposals();
      setSelectedProposalId(result.proposalId);
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setResimBusy(false);
    }
  };

  const handleDeleteProposal = async (proposalId: string) => {
    setDeleteProposalBusy(true);
    setCommitError(null);
    try {
      await window.ade.prs.deleteProposal(proposalId);
      setSelectedProposalId(null);
      await loadProposals();
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteProposalBusy(false);
    }
  };

  // Load resolution state when a proposal is selected
  React.useEffect(() => {
    if (!selectedProposal) {
      setResolutionState(null);
      setExpandedStepLaneId(null);
      setActiveChatLaneId(null);
      setActiveChatSessionId(null);
      return;
    }
    // If the proposal carries inline resolutionState, use it
    if (selectedProposal.resolutionState) {
      setResolutionState(selectedProposal.resolutionState);
      return;
    }
    // Otherwise try to load from backend
    let cancelled = false;
    window.ade.prs.getIntegrationResolutionState(selectedProposal.proposalId)
      .then((state) => { if (!cancelled) setResolutionState(state); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedProposal?.proposalId, selectedProposal?.resolutionState]);

  const handleResolveWithAI = async (stepLaneId: string, provider: AgentChatProvider, model: string, reasoningEffort?: string) => {
    if (!selectedProposal) return;
    setResolvingLaneId(stepLaneId);
    try {
      // 1. If no integration lane exists, create one first
      let currentResState = resolutionState;
      if (!currentResState?.integrationLaneId) {
        setCreateLaneBusy(true);
        try {
          const result = await window.ade.prs.createIntegrationLaneForProposal({
            proposalId: selectedProposal.proposalId,
          });
          currentResState = {
            integrationLaneId: result.integrationLaneId,
            stepResolutions: {},
            activeChatSessionId: null,
            activeLaneId: null,
            updatedAt: new Date().toISOString(),
          };
          // Mark clean lanes as merged-clean
          for (const cleanId of result.mergedCleanLanes) {
            currentResState.stepResolutions[cleanId] = "merged-clean";
          }
          for (const conflictId of result.conflictingLanes) {
            currentResState.stepResolutions[conflictId] = "pending";
          }
          setResolutionState(currentResState);
        } finally {
          setCreateLaneBusy(false);
        }
      }

      // 2. Start resolution for this lane
      const result = await window.ade.prs.startIntegrationResolution({
        proposalId: selectedProposal.proposalId,
        laneId: stepLaneId,
        provider,
        model,
        reasoningEffort,
        autoApprove: false,
      });

      // 3. Update resolution state
      setResolutionState((prev) => prev ? {
        ...prev,
        stepResolutions: { ...prev.stepResolutions, [stepLaneId]: "resolving" },
        activeChatSessionId: result.chatSessionId,
        activeLaneId: stepLaneId,
      } : prev);

      // 4. Show embedded chat
      setActiveChatLaneId(result.integrationLaneId);
      setActiveChatSessionId(result.chatSessionId);
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingLaneId(null);
    }
  };

  const handleRecheck = async (stepLaneId: string) => {
    if (!selectedProposal) return;
    try {
      const result = await window.ade.prs.recheckIntegrationStep({
        proposalId: selectedProposal.proposalId,
        laneId: stepLaneId,
      });
      // Update resolution state
      setResolutionState((prev) => prev ? {
        ...prev,
        stepResolutions: { ...prev.stepResolutions, [stepLaneId]: result.resolution },
      } : prev);
      if (result.allResolved) {
        // Reload proposals to get updated overall outcome
        await loadProposals();
      }
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
    }
  };

  // Compute whether all steps are resolved
  const allStepsResolved = React.useMemo(() => {
    if (!selectedProposal || !resolutionState) return false;
    return selectedProposal.steps.every((step) => {
      const res = resolutionState.stepResolutions[step.laneId];
      return res === "resolved" || res === "merged-clean";
    });
  }, [selectedProposal, resolutionState]);

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

  // Reset + auto-simulate when selecting a different PR
  React.useEffect(() => {
    setSimulateResult(null);
    setSimulateError(null);
    setDeleteConfirm(false);

    if (!selectedPr) return;

    // Auto-run merge simulation so the user sees status immediately
    let cancelled = false;
    const sourceIds = selectedMergeContext?.sourceLaneIds ?? [selectedPr.laneId];

    setSimulateBusy(true);
    window.ade.prs.simulateIntegration({ sourceLaneIds: sourceIds, baseBranch: selectedPr.baseBranch })
      .then((result) => { if (!cancelled) setSimulateResult(result); })
      .catch((err: unknown) => { if (!cancelled) setSimulateError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setSimulateBusy(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-simulate on PR selection change
  }, [selectedPrId]);

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
        {!prs.length && !proposals.length ? (
          <EmptyState
            title="No integration PRs"
            description="Use Create PR to set up an integration branch from multiple lanes."
          />
        ) : (
          <div className="flex flex-col" style={{ gap: 2 }}>
            {/* Proposals */}
            {proposals.map((p) => {
              const isSelected = p.proposalId === selectedProposalId;
              const outcomeColor = p.overallOutcome === "clean" ? "#22C55E" : p.overallOutcome === "conflict" ? "#F59E0B" : "#EF4444";
              return (
                <button
                  key={`proposal-${p.proposalId}`}
                  type="button"
                  className="flex w-full items-start justify-between text-left transition-colors duration-100"
                  style={{
                    padding: "10px 12px",
                    gap: 8,
                    background: isSelected ? "#F59E0B12" : "transparent",
                    borderLeft: isSelected ? "3px solid #F59E0B" : "3px solid transparent",
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "#13101A"; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => handleSelectProposal(p.proposalId)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center" style={{ gap: 6 }}>
                      <span
                        className="truncate font-mono font-semibold"
                        style={{ fontSize: 12, color: "#FAFAFA" }}
                      >
                        {p.title || "Untitled Proposal"}
                      </span>
                    </div>
                    <div className="flex items-center" style={{ gap: 6, marginTop: 6 }}>
                      <span
                        className="font-mono font-bold uppercase tracking-[1px]"
                        style={{
                          fontSize: 9,
                          padding: "1px 6px",
                          background: "#F59E0B18",
                          color: "#F59E0B",
                          border: "1px solid #F59E0B30",
                        }}
                      >
                        PROPOSED
                      </span>
                      <span className="font-mono" style={{ fontSize: 10, color: "#A1A1AA" }}>
                        {p.sourceLaneIds.length} sources
                      </span>
                      <ArrowRight size={9} weight="bold" style={{ color: "#52525B" }} />
                      <span className="font-mono" style={{ fontSize: 10, color: "#A1A1AA" }}>
                        {p.baseBranch}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center shrink-0" style={{ gap: 6 }}>
                    <span
                      className="font-mono font-bold uppercase tracking-[1px]"
                      style={{
                        fontSize: 9,
                        padding: "1px 6px",
                        background: `${outcomeColor}18`,
                        color: outcomeColor,
                      }}
                    >
                      {p.overallOutcome.toUpperCase()}
                    </span>
                  </div>
                </button>
              );
            })}

            {/* Existing PRs */}
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
                  onClick={() => handleSelectPr(pr.id)}
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
        {/* ---- Rebase banners for source lanes ---- */}
        {mergeSourcesResolved.map((s) => (
          <div key={s.laneId} style={{ marginBottom: 12 }}>
            <PrRebaseBanner laneId={s.laneId} rebaseNeeds={rebaseNeeds} autoRebaseStatuses={autoRebaseStatuses} onTabChange={(tab) => setActiveTab(tab as "normal" | "queue" | "integration" | "rebase")} />
          </div>
        ))}

        {/* ---- Header card ---- */}
        <div
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            padding: 20,
            marginBottom: 20,
          }}
        >
          {/* Title row */}
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
              <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 6 }}>
                Merging {mergeSourcesResolved.length} source lane{mergeSourcesResolved.length !== 1 ? "s" : ""} into {selectedPr.baseBranch}
              </div>
            </div>

            <div className="flex items-center shrink-0" style={{ gap: 8 }}>
              <StateBadge state={selectedPr.state} />
              {simulateResult && <OutcomeBadge outcome={simulateResult.overallOutcome} />}
              {!simulateResult && !simulateBusy && (
                <PrConflictBadge
                  riskLevel={selectedPr.conflictAnalysis?.riskLevel ?? null}
                  overlappingFileCount={selectedPr.conflictAnalysis?.overlapCount}
                />
              )}
            </div>
          </div>

          {/* Meta row */}
          <div
            className="flex items-center flex-wrap"
            style={{ gap: 12, marginTop: 14, paddingTop: 14, borderTop: "1px solid #1E1B26" }}
          >
            <div className="flex items-center" style={{ gap: 4 }}>
              <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>HEAD</span>
              <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>{selectedPr.headBranch}</span>
            </div>
            <ArrowRight size={10} weight="bold" style={{ color: "#52525B" }} />
            <div className="flex items-center" style={{ gap: 4 }}>
              <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>BASE</span>
              <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>{selectedPr.baseBranch}</span>
            </div>
            <span className="font-mono" style={{ fontSize: 11, color: "#71717A" }}>
              <span style={{ color: "#22C55E" }}>+{selectedPr.additions}</span>{" "}
              <span style={{ color: "#EF4444" }}>-{selectedPr.deletions}</span>
            </span>

            <div className="flex items-center ml-auto" style={{ gap: 8 }}>
              {/* GitHub link — always visible and prominent */}
              <button
                type="button"
                className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                style={{
                  fontSize: 10,
                  height: 28,
                  padding: "0 10px",
                  background: "#1A1720",
                  color: "#FAFAFA",
                  border: "1px solid #27272A",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#A78BFA50"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#27272A"; }}
                onClick={() => void window.ade.prs.openInGitHub(selectedPr.id)}
              >
                <GithubLogo size={14} weight="regular" style={{ marginRight: 6 }} />
                GITHUB
              </button>
              <Button
                size="sm"
                variant="primary"
                disabled={simulateBusy}
                onClick={() => void handleSimulate()}
              >
                <Lightning size={12} weight="fill" />
                <span>{simulateBusy ? "SIMULATING..." : "SIMULATE MERGE"}</span>
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
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <SectionHeader>SOURCE LANES</SectionHeader>
            <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#A1A1AA" }}>
              {mergeSourcesResolved.length} LANE{mergeSourcesResolved.length !== 1 ? "S" : ""}
            </span>
          </div>
          <div className="flex flex-col" style={{ gap: 4 }}>
            {mergeSourcesResolved.map((s) => {
              const outcome = stepOutcomeByLaneId.get(s.laneId);
              const lane = laneById.get(s.laneId);
              return (
                <div
                  key={s.laneId}
                  className="flex items-center justify-between"
                  style={{
                    padding: "8px 10px",
                    background: outcome === "clean" ? "#22C55E06" : outcome === "conflict" ? "#F59E0B06" : outcome === "blocked" ? "#EF444406" : "#0C0A10",
                    borderLeft: outcome ? `2px solid ${outcome === "clean" ? "#22C55E" : outcome === "conflict" ? "#F59E0B" : outcome === "blocked" ? "#EF4444" : "#27272A"}` : "2px solid #27272A",
                  }}
                >
                  <div className="flex items-center" style={{ gap: 8 }}>
                    {outcome && <OutcomeDot outcome={outcome} />}
                    {!outcome && simulateBusy && (
                      <span className="inline-flex items-center justify-center" style={{ width: 20, height: 20, background: "#71717A18" }}>
                        <Clock size={12} weight="regular" style={{ color: "#71717A" }} className="animate-pulse" />
                      </span>
                    )}
                    <span className="font-mono font-semibold" style={{ fontSize: 12, color: "#FAFAFA" }}>
                      {s.laneName}
                    </span>
                    {lane?.branchRef && (
                      <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>
                        {normalizeBranchName(lane.branchRef)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center" style={{ gap: 6 }}>
                    {outcome && <LaneStatusBadge outcome={outcome} />}
                    {!outcome && simulateBusy && <LaneStatusBadge outcome="pending" />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center" style={{ gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid #1E1B2680" }}>
            <ArrowRight size={12} weight="bold" style={{ color: "#52525B" }} />
            <LaneChip
              name={laneById.get(resolverTargetLaneId ?? "")?.name ?? "target"}
              variant="accent"
            />
            <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>integration target</span>
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

          {simulateBusy ? (
            <div className="flex items-center" style={{ gap: 8, padding: "12px 0" }}>
              <div className="animate-spin" style={{ width: 14, height: 14, border: "2px solid #27272A", borderTopColor: "#A78BFA", borderRadius: "50%" }} />
              <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>Running merge simulation...</span>
            </div>
          ) : simulateResult ? (
            <div>
              {/* Overall outcome */}
              <div style={{ marginBottom: 16 }}>
                <OutcomeBadge outcome={simulateResult.overallOutcome} />
                <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA", marginLeft: 10 }}>
                  {simulateResult.overallOutcome === "clean"
                    ? `All ${simulateResult.steps.length} lanes merge cleanly`
                    : simulateResult.overallOutcome === "conflict"
                    ? "Conflicts detected — resolve before merging"
                    : "Merge blocked"}
                </span>
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
  ) : selectedProposal ? (
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
                <span
                  className="truncate font-bold"
                  style={{ fontSize: 18, color: "#FAFAFA", fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  {selectedProposal.title || "Untitled Proposal"}
                </span>
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 6 }}>
                {selectedProposal.sourceLaneIds.length} source lane{selectedProposal.sourceLaneIds.length !== 1 ? "s" : ""} into {selectedProposal.baseBranch}
                {selectedProposal.createdAt && (
                  <span style={{ marginLeft: 12, color: "#52525B" }}>
                    created {new Date(selectedProposal.createdAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center shrink-0" style={{ gap: 8 }}>
              <span
                className="font-mono font-bold tracking-[1px] uppercase"
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  background: "#F59E0B18",
                  color: "#F59E0B",
                  border: "1px solid #F59E0B30",
                }}
              >
                PROPOSED
              </span>
              <OutcomeBadge outcome={selectedProposal.overallOutcome} />
            </div>
          </div>

          {/* Meta row */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #1E1B26" }}>
            <div className="flex items-center flex-wrap" style={{ gap: 12 }}>
              <div className="flex items-center" style={{ gap: 4 }}>
                <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>SOURCES</span>
                <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>{selectedProposal.sourceLaneIds.length}</span>
              </div>
              <ArrowRight size={10} weight="bold" style={{ color: "#52525B" }} />
              <div className="flex items-center" style={{ gap: 4 }}>
                <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>BASE</span>
                <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>{selectedProposal.baseBranch}</span>
              </div>
              {selectedProposal.integrationLaneName && (
                <>
                  <span style={{ color: "#27272A" }}>|</span>
                  <div className="flex items-center" style={{ gap: 4 }}>
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>BRANCH</span>
                    <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>{selectedProposal.integrationLaneName}</span>
                  </div>
                </>
              )}
              {selectedProposal.draft && (
                <span
                  className="font-mono font-bold tracking-[1px] uppercase"
                  style={{ fontSize: 9, padding: "1px 6px", background: "#A78BFA18", color: "#A78BFA" }}
                >
                  DRAFT
                </span>
              )}
              {resolutionState?.integrationLaneId && (
                <span className="font-mono" style={{ fontSize: 10, color: "#A78BFA" }}>
                  Integration lane active
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ---- Source Lanes (expandable rows) ---- */}
        <div
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <SectionHeader>SOURCE LANES</SectionHeader>
            <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#A1A1AA" }}>
              {selectedProposal.steps.length} LANE{selectedProposal.steps.length !== 1 ? "S" : ""}
            </span>
          </div>
          <div className="flex flex-col" style={{ gap: 4 }}>
            {selectedProposal.steps.map((step) => (
              <IntegrationStepDetail
                key={step.laneId}
                step={step}
                lane={laneById.get(step.laneId)}
                expanded={expandedStepLaneId === step.laneId}
                onToggle={() => setExpandedStepLaneId(expandedStepLaneId === step.laneId ? null : step.laneId)}
                resolution={resolutionState?.stepResolutions[step.laneId]}
                onResolveWithAI={(provider, model, reasoningEffort) =>
                  void handleResolveWithAI(step.laneId, provider, model, reasoningEffort)
                }
                resolving={resolvingLaneId === step.laneId || createLaneBusy}
              />
            ))}
          </div>
          {/* Target lane indicator */}
          <div className="flex items-center" style={{ gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid #1E1B2680" }}>
            <ArrowRight size={12} weight="bold" style={{ color: "#52525B" }} />
            <LaneChip name={selectedProposal.baseBranch} variant="accent" />
            <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>integration target</span>
          </div>
        </div>

        {/* ---- Embedded chat (when resolving) ---- */}
        {activeChatSessionId && activeChatLaneId && (
          <div
            style={{
              background: "#13101A",
              border: "1px solid #1E1B26",
              marginBottom: 20,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "10px 16px",
                borderBottom: "1px solid #1E1B26",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <SectionHeader>AI CONFLICT RESOLUTION</SectionHeader>
              <div className="flex items-center" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (resolutionState?.activeLaneId) {
                      void handleRecheck(resolutionState.activeLaneId);
                    }
                  }}
                >
                  <ArrowsClockwise size={12} weight="regular" />
                  RE-CHECK
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setActiveChatSessionId(null);
                    setActiveChatLaneId(null);
                  }}
                >
                  CLOSE
                </Button>
              </div>
            </div>
            <div style={{ height: 500 }}>
              <AgentChatPane
                laneId={activeChatLaneId}
                lockSessionId={activeChatSessionId}
              />
            </div>
          </div>
        )}

        {/* ---- Action bar ---- */}
        <div style={{ marginBottom: 20 }}>
          <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
            {/* Create PR on GitHub */}
            {(() => {
              const hasUnresolved = selectedProposal.overallOutcome !== "clean" && !allStepsResolved;
              const isDisabled = commitBusy || selectedProposal.overallOutcome === "blocked" || hasUnresolved;
              return (
                <button
                  type="button"
                  disabled={isDisabled}
                  className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                  style={{
                    fontSize: 10,
                    height: 32,
                    padding: "0 14px",
                    background: isDisabled ? "#52525B" : "#22C55E",
                    color: "#0F0D14",
                    border: "none",
                    cursor: isDisabled ? "not-allowed" : "pointer",
                    opacity: isDisabled ? 0.4 : 1,
                  }}
                  onClick={() => void handleCommitProposal(selectedProposal)}
                >
                  {commitBusy ? (
                    <CircleNotch size={12} className="animate-spin" style={{ marginRight: 6 }} />
                  ) : (
                    <GithubLogo size={14} weight="regular" style={{ marginRight: 6 }} />
                  )}
                  {commitBusy ? "CREATING..." : "CREATE PR ON GITHUB"}
                </button>
              );
            })()}

            {/* View in graph */}
            {resolutionState?.integrationLaneId && (
              <button
                type="button"
                className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                style={{
                  fontSize: 10,
                  height: 32,
                  padding: "0 14px",
                  background: "transparent",
                  color: "#A1A1AA",
                  border: "1px solid #27272A",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#A78BFA50"; e.currentTarget.style.color = "#FAFAFA"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#27272A"; e.currentTarget.style.color = "#A1A1AA"; }}
                onClick={() => {
                  window.location.hash = `/graph?focusLane=${resolutionState.integrationLaneId}`;
                }}
              >
                <GitBranch size={14} weight="regular" style={{ marginRight: 6 }} />
                VIEW IN GRAPH
              </button>
            )}

            {/* Re-simulate */}
            <button
              type="button"
              disabled={resimBusy}
              className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
              style={{
                fontSize: 10,
                height: 32,
                padding: "0 14px",
                background: "transparent",
                color: resimBusy ? "#52525B" : "#A78BFA",
                border: "1px solid #A78BFA30",
                cursor: resimBusy ? "not-allowed" : "pointer",
                opacity: resimBusy ? 0.4 : 1,
              }}
              onClick={() => void handleResimulate(selectedProposal)}
            >
              {resimBusy ? (
                <CircleNotch size={12} className="animate-spin" style={{ marginRight: 6 }} />
              ) : (
                <ArrowsClockwise size={14} weight="regular" style={{ marginRight: 6 }} />
              )}
              {resimBusy ? "SIMULATING..." : "RE-SIMULATE"}
            </button>

            {/* Delete proposal */}
            <button
              type="button"
              disabled={deleteProposalBusy}
              className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
              style={{
                fontSize: 10,
                height: 32,
                padding: "0 14px",
                background: "transparent",
                color: deleteProposalBusy ? "#52525B" : "#EF4444",
                border: "1px solid #EF444430",
                cursor: deleteProposalBusy ? "not-allowed" : "pointer",
                opacity: deleteProposalBusy ? 0.4 : 1,
                marginLeft: "auto",
              }}
              onClick={() => void handleDeleteProposal(selectedProposal.proposalId)}
            >
              <Trash size={14} weight="regular" style={{ marginRight: 6 }} />
              {deleteProposalBusy ? "DELETING..." : "DELETE PROPOSAL"}
            </button>
          </div>

          {commitError && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                background: "#EF444410",
                border: "1px solid #EF444425",
              }}
            >
              <span className="font-mono" style={{ fontSize: 11, color: "#EF4444" }}>{commitError}</span>
            </div>
          )}
        </div>

        {/* ---- Description (if any) ---- */}
        {selectedProposal.body && (
          <div
            style={{
              background: "#13101A",
              border: "1px solid #1E1B26",
              padding: 16,
              marginBottom: 20,
            }}
          >
            <SectionHeader>DESCRIPTION</SectionHeader>
            <div className="font-mono" style={{ fontSize: 11, color: "#A1A1AA", whiteSpace: "pre-wrap" }}>
              {selectedProposal.body}
            </div>
          </div>
        )}
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
      title: selectedPr ? `Integration: #${selectedPr.githubPrNumber}` : selectedProposal ? `Proposal: ${selectedProposal.title || "Untitled"}` : "Integration Detail",
      icon: Eye,
      bodyClassName: "overflow-auto",
      children: detailPane,
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [prs, selectedPr, selectedPrId, mergeContextByPrId, laneById, mergeSourcesResolved, resolverTargetLaneId, simulateResult, simulateBusy, simulateError, resolverOpen, deleteConfirm, deleteBusy, deleteCloseGh, hasConflicts, rebaseNeeds, autoRebaseStatuses, setActiveTab, onSelectPr, onRefresh, stepOutcomeByLaneId, proposals, selectedProposal, selectedProposalId, commitBusy, commitError, resimBusy, deleteProposalBusy, expandedStepLaneId, resolutionState, activeChatLaneId, activeChatSessionId, createLaneBusy, resolvingLaneId, allStepsResolved]);

  return <PaneTilingLayout layoutId="prs:integration:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
