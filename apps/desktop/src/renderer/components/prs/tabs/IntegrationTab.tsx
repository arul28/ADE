import React from "react";
import { GitMerge, GitBranch, Lightning, Eye, Sparkle, Trash, ArrowRight, ArrowSquareOut, CheckCircle, Warning, XCircle, Clock, GithubLogo, CircleNotch, ArrowsClockwise, CaretDown, CaretRight, Robot, Gear } from "@phosphor-icons/react";
import type {
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
import { ConflictFilePreview } from "../ConflictFilePreview";

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

type ConflictPreviewFile = {
  path: string;
  conflictMarkers: string;
  oursExcerpt: string | null;
  theirsExcerpt: string | null;
  diffHunk: string | null;
};

type ProposalLaneCard = {
  laneId: string;
  laneName: string;
  outcome: "clean" | "conflict" | "blocked" | "pending";
  commitHash: string | null;
  commitCount: number | null;
  baseBranch: string;
  position: number;
};

type ProposalConflictPair = {
  key: string;
  laneAId: string;
  laneAName: string;
  laneBId: string;
  laneBName: string;
  outcome: "conflict" | "blocked";
  fileCount: number;
  files: ConflictPreviewFile[];
};

function readQueryParam(name: string): string | null {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get(name);
    if (fromSearch) return fromSearch;
    const hash = window.location.hash ?? "";
    const queryIndex = hash.indexOf("?");
    if (queryIndex >= 0) {
      return new URLSearchParams(hash.slice(queryIndex + 1)).get(name);
    }
    return null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toOutcome(value: unknown): "clean" | "conflict" | "blocked" | "pending" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "clean" || normalized === "ready" || normalized === "merge-ready") return "clean";
  if (normalized === "conflict" || normalized === "conflicted" || normalized === "conflict-predicted") return "conflict";
  if (normalized === "blocked" || normalized === "error") return "blocked";
  return "pending";
}

function toConflictPreviewFile(file: unknown): ConflictPreviewFile | null {
  if (typeof file === "string" && file.trim().length > 0) {
    return {
      path: file.trim(),
      conflictMarkers: "",
      oursExcerpt: null,
      theirsExcerpt: null,
      diffHunk: null,
    };
  }
  const rec = asRecord(file);
  if (!rec) return null;
  const path = asString(rec.path);
  if (!path) return null;
  return {
    path,
    conflictMarkers: asString(rec.conflictMarkers ?? rec.markerPreview) ?? "",
    oursExcerpt: asString(rec.oursExcerpt),
    theirsExcerpt: asString(rec.theirsExcerpt),
    diffHunk: asString(rec.diffHunk ?? rec.patch),
  };
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
  const [proposalsLoaded, setProposalsLoaded] = React.useState(false);
  const [selectedProposalId, setSelectedProposalId] = React.useState<string | null>(null);
  const [urlProposalId, setUrlProposalId] = React.useState<string | null>(() => readQueryParam("proposalId"));
  const [commitBusy, setCommitBusy] = React.useState(false);
  const [commitError, setCommitError] = React.useState<string | null>(null);
  const [resimBusy, setResimBusy] = React.useState(false);
  const [deleteProposalBusy, setDeleteProposalBusy] = React.useState(false);

  // New integration resolution state
  const [expandedPairKeys, setExpandedPairKeys] = React.useState<string[]>([]);
  const [resolutionState, setResolutionState] = React.useState<IntegrationResolutionState | null>(null);
  const [activeWorkerStepId, setActiveWorkerStepId] = React.useState<string | null>(null);
  const [createLaneBusy, setCreateLaneBusy] = React.useState(false);
  const [resolvingLaneId, setResolvingLaneId] = React.useState<string | null>(null);

  const loadProposals = React.useCallback(async () => {
    try {
      const result = await window.ade.prs.listProposals();
      setProposals(result);
    } catch {
      /* swallow */
    } finally {
      setProposalsLoaded(true);
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

  React.useEffect(() => {
    const syncFromUrl = () => setUrlProposalId(readQueryParam("proposalId"));
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener("hashchange", syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener("hashchange", syncFromUrl);
    };
  }, []);

  React.useEffect(() => {
    if (!proposalsLoaded || !urlProposalId) return;
    if (selectedProposalId === urlProposalId) return;
    if (!proposals.some((p) => p.proposalId === urlProposalId)) return;
    onSelectPr(null);
    setSelectedProposalId(urlProposalId);
  }, [onSelectPr, proposals, proposalsLoaded, selectedProposalId, urlProposalId]);

  // Auto-select first item (PR or proposal)
  React.useEffect(() => {
    if (!proposalsLoaded) return;
    if (selectedPrId && prs.some((p) => p.id === selectedPrId)) return;
    if (selectedProposalId && proposals.some((p) => p.proposalId === selectedProposalId)) return;
    if (urlProposalId) {
      const proposal = proposals.find((p) => p.proposalId === urlProposalId);
      if (proposal) {
        onSelectPr(null);
        setSelectedProposalId(proposal.proposalId);
        return;
      }
    }
    if (prs.length > 0) {
      onSelectPr(prs[0].id);
      setSelectedProposalId(null);
    } else if (proposals.length > 0) {
      onSelectPr(null);
      setSelectedProposalId(proposals[0].proposalId);
    }
  }, [onSelectPr, proposals, proposalsLoaded, prs, selectedPrId, selectedProposalId, urlProposalId]);

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
      setExpandedPairKeys([]);
      setActiveWorkerStepId(null);
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

  React.useEffect(() => {
    if (!selectedProposal) return;
    setExpandedPairKeys([]);
  }, [selectedProposal?.proposalId]);

  const proposalLaneCards = React.useMemo<ProposalLaneCard[]>(() => {
    if (!selectedProposal) return [];
    const sourceOrder = new Map(selectedProposal.sourceLaneIds.map((laneId, index) => [laneId, index]));
    const proposalRecord = asRecord(selectedProposal);
    const rawLaneSummaries = Array.isArray(proposalRecord?.laneSummaries) ? proposalRecord.laneSummaries : null;

    if (rawLaneSummaries && rawLaneSummaries.length > 0) {
      return rawLaneSummaries
        .map((rawLane, index) => {
          const laneRecord = asRecord(rawLane);
          const laneId =
            asString(laneRecord?.laneId ?? laneRecord?.id ?? laneRecord?.sourceLaneId) ??
            selectedProposal.steps[index]?.laneId ??
            `lane-${index + 1}`;
          return {
            laneId,
            laneName: asString(laneRecord?.laneName ?? laneRecord?.name) ?? laneById.get(laneId)?.name ?? laneId,
            outcome: toOutcome(laneRecord?.status ?? laneRecord?.outcome ?? laneRecord?.readiness),
            commitHash:
              asString(
                laneRecord?.commitHash ??
                laneRecord?.headSha ??
                laneRecord?.sha ??
                laneRecord?.commitSha ??
                laneRecord?.latestCommitHash,
              ) ?? null,
            commitCount: asNumber(laneRecord?.commitCount ?? laneRecord?.commits ?? laneRecord?.commitTotal),
            baseBranch: asString(laneRecord?.baseBranch) ?? selectedProposal.baseBranch,
            position: asNumber(laneRecord?.position) ?? sourceOrder.get(laneId) ?? index,
          };
        })
        .sort((a, b) => a.position - b.position);
    }

    if (Array.isArray(selectedProposal.pairwiseResults) && selectedProposal.pairwiseResults.length > 0) {
      const nameByLaneId = new Map<string, string>();
      const outcomeByLaneId = new Map<string, ProposalLaneCard["outcome"]>();

      for (const sourceLaneId of selectedProposal.sourceLaneIds) {
        outcomeByLaneId.set(sourceLaneId, "clean");
      }
      for (const pair of selectedProposal.pairwiseResults) {
        if (pair.laneAId) nameByLaneId.set(pair.laneAId, pair.laneAName || nameByLaneId.get(pair.laneAId) || pair.laneAId);
        if (pair.laneBId) nameByLaneId.set(pair.laneBId, pair.laneBName || nameByLaneId.get(pair.laneBId) || pair.laneBId);
        if (pair.outcome === "conflict") {
          if (pair.laneAId) outcomeByLaneId.set(pair.laneAId, "conflict");
          if (pair.laneBId) outcomeByLaneId.set(pair.laneBId, "conflict");
        }
      }

      return selectedProposal.sourceLaneIds
        .map((laneId, index) => ({
          laneId,
          laneName: nameByLaneId.get(laneId) ?? laneById.get(laneId)?.name ?? laneId,
          outcome: outcomeByLaneId.get(laneId) ?? "clean",
          commitHash: null,
          commitCount: null,
          baseBranch: selectedProposal.baseBranch,
          position: sourceOrder.get(laneId) ?? index,
        }))
        .sort((a, b) => a.position - b.position);
    }

    return selectedProposal.steps
      .map((step, index) => ({
        laneId: step.laneId,
        laneName: step.laneName,
        outcome: step.outcome,
        commitHash: null,
        commitCount: null,
        baseBranch: selectedProposal.baseBranch,
        position: sourceOrder.get(step.laneId) ?? (Number.isFinite(step.position) ? step.position : index),
      }))
      .sort((a, b) => a.position - b.position);
  }, [laneById, selectedProposal]);

  const proposalPairwiseConflicts = React.useMemo<ProposalConflictPair[]>(() => {
    if (!selectedProposal) return [];
    const proposalRecord = asRecord(selectedProposal);
    const pairwiseCandidates: unknown[] = [];
    const possibleArrays = [
      proposalRecord?.pairwiseResults,
      proposalRecord?.pairwiseConflicts,
      proposalRecord?.pairwiseConflictPairs,
      proposalRecord?.conflictingPairs,
      proposalRecord?.pairwisePairs,
      proposalRecord?.conflictPairs,
    ];
    for (const value of possibleArrays) {
      if (Array.isArray(value)) pairwiseCandidates.push(...value);
    }

    // Build a lookup: laneId -> conflictingFiles from steps, so we can enrich
    // pairwise entries that have outcome "conflict" but empty conflictingFiles.
    const stepFilesByLaneId = new Map<string, ConflictPreviewFile[]>();
    for (const step of selectedProposal.steps) {
      if (step.conflictingFiles.length > 0) {
        stepFilesByLaneId.set(
          step.laneId,
          step.conflictingFiles.map((f) => ({
            path: f.path,
            conflictMarkers: f.conflictMarkers ?? "",
            oursExcerpt: f.oursExcerpt ?? null,
            theirsExcerpt: f.theirsExcerpt ?? null,
            diffHunk: f.diffHunk ?? null,
          })),
        );
      }
    }

    if (pairwiseCandidates.length > 0) {
      const normalized = pairwiseCandidates
        .map((rawPair, index) => {
          const pairRecord = asRecord(rawPair);
          if (!pairRecord) return null;
          const laneARecord = asRecord(pairRecord.laneA);
          const laneBRecord = asRecord(pairRecord.laneB);
          const laneAId =
            asString(pairRecord.laneAId ?? laneARecord?.id ?? pairRecord.leftLaneId ?? pairRecord.sourceLaneId) ??
            `pair-${index + 1}-a`;
          const laneBId =
            asString(pairRecord.laneBId ?? laneBRecord?.id ?? pairRecord.rightLaneId ?? pairRecord.targetLaneId) ??
            `${selectedProposal.baseBranch}-${index + 1}`;
          const laneAName =
            asString(pairRecord.laneAName ?? laneARecord?.name ?? pairRecord.leftLaneName ?? pairRecord.sourceLaneName) ??
            laneById.get(laneAId)?.name ??
            laneAId;
          const laneBName =
            asString(pairRecord.laneBName ?? laneBRecord?.name ?? pairRecord.rightLaneName ?? pairRecord.targetLaneName) ??
            laneById.get(laneBId)?.name ??
            laneBId;
          const rawFiles = Array.isArray(pairRecord.files)
            ? pairRecord.files
            : Array.isArray(pairRecord.conflictingFiles)
              ? pairRecord.conflictingFiles
              : Array.isArray(pairRecord.conflicts)
                ? pairRecord.conflicts
                : Array.isArray(pairRecord.paths)
                  ? pairRecord.paths
                  : [];
          let files = rawFiles
            .map((file) => toConflictPreviewFile(file))
            .filter((file): file is ConflictPreviewFile => Boolean(file));
          const outcome = toOutcome(pairRecord.outcome ?? pairRecord.status);

          // Fallback: when pairwise entry has "conflict" outcome but empty files,
          // try to recover file paths from the per-lane step data. The step's
          // conflictingFiles is the union of all pairwise files for that lane,
          // so intersecting the two lane's files gives a reasonable approximation.
          if (files.length === 0 && (outcome === "conflict" || outcome === "blocked")) {
            const aFiles = stepFilesByLaneId.get(laneAId) ?? [];
            const bFiles = stepFilesByLaneId.get(laneBId) ?? [];
            if (aFiles.length > 0 && bFiles.length > 0) {
              const bPathSet = new Set(bFiles.map((f) => f.path));
              const intersection = aFiles.filter((f) => bPathSet.has(f.path));
              files = intersection.length > 0 ? intersection : [...aFiles, ...bFiles];
            } else if (aFiles.length > 0) {
              files = aFiles;
            } else if (bFiles.length > 0) {
              files = bFiles;
            }
            // Deduplicate by path
            const seenPaths = new Set<string>();
            files = files.filter((f) => {
              if (seenPaths.has(f.path)) return false;
              seenPaths.add(f.path);
              return true;
            });
          }

          const fileCount = asNumber(pairRecord.fileCount ?? pairRecord.conflictFileCount ?? pairRecord.count) ?? files.length;
          if (outcome !== "conflict" && outcome !== "blocked" && Math.max(fileCount, files.length) === 0) {
            return null;
          }
          return {
            key: `${laneAId}::${laneBId}::${index}`,
            laneAId,
            laneAName,
            laneBId,
            laneBName,
            outcome: outcome === "blocked" ? "blocked" : "conflict",
            fileCount: Math.max(fileCount, files.length),
            files,
          };
        })
        .filter((pair): pair is ProposalConflictPair => Boolean(pair))
        .sort((a, b) => b.fileCount - a.fileCount || a.laneAName.localeCompare(b.laneAName));
      if (normalized.length > 0) return normalized;
    }

    return selectedProposal.steps
      .filter((step) => step.outcome === "conflict" || step.outcome === "blocked" || step.conflictingFiles.length > 0)
      .map((step, index) => ({
        key: `${step.laneId}::${selectedProposal.baseBranch}::${index}`,
        laneAId: step.laneId,
        laneAName: step.laneName,
        laneBId: selectedProposal.baseBranch,
        laneBName: selectedProposal.baseBranch,
        outcome: step.outcome === "blocked" ? "blocked" : "conflict",
        fileCount: step.conflictingFiles.length,
        files: step.conflictingFiles.map((file) => ({
          path: file.path,
          conflictMarkers: file.conflictMarkers ?? "",
          oursExcerpt: file.oursExcerpt ?? null,
          theirsExcerpt: file.theirsExcerpt ?? null,
          diffHunk: file.diffHunk ?? null,
        })),
      }));
  }, [laneById, selectedProposal]);

  const proposalConflictSteps = React.useMemo(
    () => (selectedProposal ? selectedProposal.steps.filter((step) => step.outcome === "conflict" || step.outcome === "blocked" || step.conflictingFiles.length > 0) : []),
    [selectedProposal],
  );

  const proposalConflictingPairs = proposalPairwiseConflicts;
  const conflictPairCountByLaneId = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const laneId of selectedProposal?.sourceLaneIds ?? []) counts.set(laneId, 0);
    for (const pair of proposalConflictingPairs) {
      counts.set(pair.laneAId, (counts.get(pair.laneAId) ?? 0) + 1);
      counts.set(pair.laneBId, (counts.get(pair.laneBId) ?? 0) + 1);
    }
    return counts;
  }, [proposalConflictingPairs, selectedProposal?.sourceLaneIds]);
  const isLegacySequentialProposal = React.useMemo(() => {
    if (!selectedProposal) return false;
    const hasLaneSummaries = Array.isArray(selectedProposal.laneSummaries) && selectedProposal.laneSummaries.length > 0;
    const hasPairwise = Array.isArray(selectedProposal.pairwiseResults) && selectedProposal.pairwiseResults.length > 0;
    return selectedProposal.sourceLaneIds.length > 1 && !hasLaneSummaries && !hasPairwise;
  }, [selectedProposal]);

  const totalProposalConflictFiles = React.useMemo(() => {
    const pairwiseTotal = proposalConflictingPairs.reduce((sum, pair) => sum + Math.max(pair.fileCount, pair.files.length), 0);
    if (pairwiseTotal > 0) return pairwiseTotal;
    return proposalConflictSteps.reduce((sum, step) => sum + step.conflictingFiles.length, 0);
  }, [proposalConflictSteps, proposalConflictingPairs]);

  const ensureIntegrationLaneForResolution = React.useCallback(async (): Promise<IntegrationResolutionState | null> => {
    if (!selectedProposal) return null;
    if (resolutionState?.integrationLaneId) return resolutionState;
    setCreateLaneBusy(true);
    try {
      const result = await window.ade.prs.createIntegrationLaneForProposal({
        proposalId: selectedProposal.proposalId,
      });
      const nextState: IntegrationResolutionState = {
        integrationLaneId: result.integrationLaneId,
        stepResolutions: {},
        activeWorkerStepId: null,
        activeLaneId: null,
        updatedAt: new Date().toISOString(),
      };
      for (const cleanId of result.mergedCleanLanes) {
        nextState.stepResolutions[cleanId] = "merged-clean";
      }
      for (const conflictId of result.conflictingLanes) {
        nextState.stepResolutions[conflictId] = "pending";
      }
      setResolutionState(nextState);
      return nextState;
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setCreateLaneBusy(false);
    }
  }, [resolutionState, selectedProposal]);

  const handleResolveWithAI = async (stepLaneId: string) => {
    if (!selectedProposal) return;
    setResolvingLaneId(stepLaneId);
    try {
      const resState = await ensureIntegrationLaneForResolution();
      if (!resState?.integrationLaneId) return;

      await window.ade.prs.startIntegrationResolution({
        proposalId: selectedProposal.proposalId,
        laneId: stepLaneId,
      });

      setResolutionState((prev) => prev ? {
        ...prev,
        stepResolutions: { ...prev.stepResolutions, [stepLaneId]: "resolving" },
        activeWorkerStepId: stepLaneId,
        activeLaneId: stepLaneId,
      } : prev);

      setActiveWorkerStepId(stepLaneId);
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingLaneId(null);
    }
  };

  const handleAutoResolveAll = async () => {
    if (!selectedProposal) return;

    // Derive the list of lane IDs that need resolution.
    // Prefer pairwise results (modern proposals), fall back to legacy steps.
    let conflictLaneIds: string[];
    if (proposalConflictingPairs.length > 0) {
      // Collect unique lane IDs from pairwise conflict pairs
      const seen = new Set<string>();
      for (const pair of proposalConflictingPairs) {
        seen.add(pair.laneAId);
        seen.add(pair.laneBId);
      }
      conflictLaneIds = Array.from(seen);
    } else if (proposalConflictSteps.length > 0) {
      conflictLaneIds = proposalConflictSteps.map((step) => step.laneId);
    } else {
      // Nothing to resolve
      setCommitError("No conflicts found to auto-resolve.");
      return;
    }

    const resState = await ensureIntegrationLaneForResolution();
    if (!resState?.integrationLaneId) return;

    for (const laneId of conflictLaneIds) {
      setResolvingLaneId(laneId);
      try {
        await window.ade.prs.startIntegrationResolution({
          proposalId: selectedProposal.proposalId,
          laneId,
        });
        setResolutionState((prev) => prev ? {
          ...prev,
          stepResolutions: { ...prev.stepResolutions, [laneId]: "resolving" },
          activeWorkerStepId: laneId,
          activeLaneId: laneId,
        } : prev);
        setActiveWorkerStepId(laneId);
      } catch (err: unknown) {
        setCommitError(err instanceof Error ? err.message : String(err));
        break;
      } finally {
        setResolvingLaneId(null);
      }
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

  const togglePairExpansion = (key: string) => {
    setExpandedPairKeys((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  };

  const nextManualResolutionLaneId = React.useMemo(() => {
    for (const step of proposalConflictSteps) {
      const status = resolutionState?.stepResolutions[step.laneId];
      if (status !== "resolved" && status !== "merged-clean") return step.laneId;
    }
    return proposalConflictSteps[0]?.laneId ?? null;
  }, [proposalConflictSteps, resolutionState?.stepResolutions]);

  const handleStartManualResolution = () => {
    if (!nextManualResolutionLaneId) return;
    void handleResolveWithAI(nextManualResolutionLaneId);
  };

  // Compute whether all steps are resolved
  const allStepsResolved = React.useMemo(() => {
    if (!selectedProposal || !resolutionState) return false;

    // Check pairwise results first (modern proposals may have empty steps)
    if (proposalConflictingPairs.length > 0) {
      // Collect unique lane IDs involved in conflicts
      const conflictLaneIds = new Set<string>();
      for (const pair of proposalConflictingPairs) {
        conflictLaneIds.add(pair.laneAId);
        conflictLaneIds.add(pair.laneBId);
      }
      if (conflictLaneIds.size === 0) return false;
      return Array.from(conflictLaneIds).every((laneId) => {
        const res = resolutionState.stepResolutions[laneId];
        return res === "resolved" || res === "merged-clean";
      });
    }

    // Fall back to legacy steps — guard against vacuously true when empty
    if (selectedProposal.steps.length === 0) return false;
    return selectedProposal.steps.every((step) => {
      const res = resolutionState.stepResolutions[step.laneId];
      return res === "resolved" || res === "merged-clean";
    });
  }, [selectedProposal, resolutionState, proposalConflictingPairs]);

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
              <button
                className="flex items-center font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 9,
                  gap: 4,
                  padding: "2px 8px",
                  background: "#A78BFA18",
                  color: "#A78BFA",
                  border: "1px solid #A78BFA30",
                  cursor: "pointer",
                }}
                title="View related lanes in the workspace graph"
                onClick={() => {
                  const laneId = selectedPr.laneId;
                  window.location.hash = laneId
                    ? `#/graph?focusLane=${encodeURIComponent(laneId)}`
                    : "#/graph";
                }}
              >
                <ArrowSquareOut size={12} weight="bold" />
                GRAPH
              </button>
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
              const borderColor =
                outcome === "clean" ? "#22C55E" :
                outcome === "conflict" ? "#F59E0B" :
                outcome === "blocked" ? "#EF4444" : "#27272A";
              const step = simulateResult?.steps.find((st) => st.laneId === s.laneId);
              return (
                <div
                  key={s.laneId}
                  style={{
                    padding: "10px 12px",
                    background: outcome === "clean" ? "#22C55E06" : outcome === "conflict" ? "#F59E0B06" : outcome === "blocked" ? "#EF444406" : "#0C0A10",
                    borderLeft: `3px solid ${borderColor}`,
                    border: `1px solid ${borderColor}20`,
                    borderLeftWidth: 3,
                  }}
                >
                  <div className="flex items-center justify-between" style={{ gap: 8 }}>
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
                      {step && (
                        <span className="font-mono" style={{ fontSize: 10, color: "#71717A" }}>
                          {step.diffStat.filesChanged} file{step.diffStat.filesChanged !== 1 ? "s" : ""}
                        </span>
                      )}
                      {outcome && <LaneStatusBadge outcome={outcome} />}
                      {!outcome && simulateBusy && <LaneStatusBadge outcome="pending" />}
                    </div>
                  </div>
                  {step && (
                    <div className="font-mono" style={{ marginTop: 4, marginLeft: 28, fontSize: 10, color: "#52525B" }}>
                      <span style={{ color: "#22C55E" }}>+{step.diffStat.insertions}</span>
                      {" "}
                      <span style={{ color: "#EF4444" }}>-{step.diffStat.deletions}</span>
                      {step.conflictingFiles.length > 0 && (
                        <span style={{ color: "#F59E0B", marginLeft: 8 }}>
                          {step.conflictingFiles.length} conflicting file{step.conflictingFiles.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  )}
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
              <button
                className="flex items-center font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 9,
                  gap: 4,
                  padding: "2px 8px",
                  background: "#A78BFA18",
                  color: "#A78BFA",
                  border: "1px solid #A78BFA30",
                  cursor: "pointer",
                }}
                title="View this proposal in the workspace graph"
                onClick={() => {
                  const integrationLaneId = resolutionState?.integrationLaneId ?? selectedProposal.sourceLaneIds[0];
                  const proposalKey = selectedProposal.proposalId;
                  const params = new URLSearchParams();
                  if (integrationLaneId) params.set("focusLane", integrationLaneId);
                  if (proposalKey) params.set("focusProposal", proposalKey);
                  const qs = params.toString();
                  window.location.hash = qs ? `#/graph?${qs}` : "#/graph";
                }}
              >
                <ArrowSquareOut size={12} weight="bold" />
                VIEW IN GRAPH
              </button>
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

        {isLegacySequentialProposal && (
          <div
            style={{
              background: "#F59E0B08",
              border: "1px solid #F59E0B30",
              padding: 12,
              marginBottom: 20,
            }}
          >
            <div className="flex items-center justify-between" style={{ gap: 10 }}>
              <div>
                <div className="font-mono font-semibold" style={{ fontSize: 11, color: "#F59E0B" }}>
                  Legacy simulation data detected
                </div>
                <div className="font-mono" style={{ fontSize: 10, color: "#D4A857", marginTop: 3 }}>
                  This proposal was generated before pairwise conflict metadata. Outcomes can look queue-like. Re-simulate for accurate pairwise conflicts.
                </div>
              </div>
              <button
                type="button"
                disabled={resimBusy}
                className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                style={{
                  fontSize: 10,
                  height: 28,
                  padding: "0 10px",
                  background: "transparent",
                  color: "#F59E0B",
                  border: "1px solid #F59E0B50",
                  cursor: resimBusy ? "not-allowed" : "pointer",
                  opacity: resimBusy ? 0.5 : 1,
                }}
                onClick={() => void handleResimulate(selectedProposal)}
              >
                {resimBusy ? "SIMULATING..." : "RE-SIMULATE"}
              </button>
            </div>
          </div>
        )}

        {/* ---- Source lanes ---- */}
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
              {proposalLaneCards.length} LANE{proposalLaneCards.length !== 1 ? "S" : ""}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 10,
            }}
          >
            {proposalLaneCards.map((lane) => {
              const pairCount = conflictPairCountByLaneId.get(lane.laneId) ?? 0;
              const borderColor =
                lane.outcome === "conflict" ? "#F59E0B" :
                lane.outcome === "blocked" ? "#EF4444" :
                lane.outcome === "clean" ? "#22C55E" : "#1E1B26";
              const laneInfo = laneById.get(lane.laneId);
              return (
                <div
                  key={`source-lane-${lane.laneId}-${lane.position}`}
                  style={{
                    background: "#0C0A10",
                    border: `1px solid ${borderColor}40`,
                    borderTop: `2px solid ${borderColor}`,
                    padding: 12,
                    minWidth: 0,
                  }}
                >
                  <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 10 }}>
                    <span className="truncate font-mono font-bold" style={{ fontSize: 12, color: "#FAFAFA" }}>
                      {lane.laneName}
                    </span>
                    <LaneStatusBadge outcome={lane.outcome} />
                  </div>
                  <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 4 }}>
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>
                      COMMIT
                    </span>
                    <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>
                      {lane.commitHash ? lane.commitHash.slice(0, 8) : "N/A"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 4 }}>
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>
                      COMMITS
                    </span>
                    <span className="font-mono" style={{ fontSize: 11, color: "#A1A1AA" }}>
                      {lane.commitCount ?? "N/A"}
                    </span>
                  </div>
                  {laneInfo?.branchRef && (
                    <div className="flex items-center justify-between" style={{ gap: 8, marginBottom: 4 }}>
                      <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>
                        BRANCH
                      </span>
                      <span className="font-mono truncate" style={{ fontSize: 10, color: "#71717A", maxWidth: 120 }}>
                        {normalizeBranchName(laneInfo.branchRef)}
                      </span>
                    </div>
                  )}
                  {pairCount > 0 && (
                    <div
                      className="flex items-center"
                      style={{ gap: 4, marginTop: 6, paddingTop: 6, borderTop: "1px solid #1E1B2680" }}
                    >
                      <Warning size={10} weight="fill" style={{ color: "#F59E0B" }} />
                      <span className="font-mono" style={{ fontSize: 9, color: "#F59E0B" }}>
                        Conflicts with {pairCount} other lane{pairCount !== 1 ? "s" : ""}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center" style={{ gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid #1E1B2680" }}>
            <ArrowRight size={12} weight="bold" style={{ color: "#52525B" }} />
            <LaneChip name={selectedProposal.baseBranch} variant="accent" />
            <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>integration target</span>
          </div>
        </div>

        {/* ---- Conflict Analysis (consolidated view) ---- */}
        <div
          style={{
            background: "#13101A",
            border: "1px solid #1E1B26",
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
            <SectionHeader>CONFLICT ANALYSIS</SectionHeader>
            <OutcomeBadge outcome={selectedProposal.overallOutcome} />
          </div>

          {/* ---- Conflict Matrix (visual heatmap grid) ---- */}
          {proposalLaneCards.length > 1 && (
            <div style={{ marginBottom: 16 }}>
              <div
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{ fontSize: 9, color: "#52525B", marginBottom: 8 }}
              >
                CONFLICT MATRIX
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "auto" }}>
                  <thead>
                    <tr>
                      <th style={{ padding: 0, width: 24 }} />
                      {proposalLaneCards.map((col) => (
                        <th
                          key={`matrix-col-${col.laneId}`}
                          className="font-mono font-bold uppercase tracking-[1px]"
                          style={{
                            fontSize: 8,
                            color: "#71717A",
                            padding: "4px 6px",
                            textAlign: "center",
                            maxWidth: 80,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={col.laneName}
                        >
                          {col.laneName.length > 10 ? `${col.laneName.slice(0, 10)}...` : col.laneName}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {proposalLaneCards.map((row) => (
                      <tr key={`matrix-row-${row.laneId}`}>
                        <td
                          className="font-mono font-bold uppercase tracking-[1px]"
                          style={{
                            fontSize: 8,
                            color: "#71717A",
                            padding: "4px 6px",
                            textAlign: "right",
                            maxWidth: 80,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={row.laneName}
                        >
                          {row.laneName.length > 10 ? `${row.laneName.slice(0, 10)}...` : row.laneName}
                        </td>
                        {proposalLaneCards.map((col) => {
                          const isSelf = row.laneId === col.laneId;
                          const pair = proposalConflictingPairs.find(
                            (p) =>
                              (p.laneAId === row.laneId && p.laneBId === col.laneId) ||
                              (p.laneAId === col.laneId && p.laneBId === row.laneId)
                          );
                          const hasConflictCell = Boolean(pair);
                          const cellBg = isSelf
                            ? "#1E1B26"
                            : hasConflictCell
                              ? pair?.outcome === "blocked" ? "#EF444430" : "#F59E0B30"
                              : "#22C55E15";
                          const cellBorder = isSelf
                            ? "#27272A"
                            : hasConflictCell
                              ? pair?.outcome === "blocked" ? "#EF444450" : "#F59E0B50"
                              : "#22C55E30";
                          return (
                            <td
                              key={`matrix-cell-${row.laneId}-${col.laneId}`}
                              style={{
                                width: 32,
                                height: 28,
                                padding: 0,
                                textAlign: "center",
                                background: cellBg,
                                border: `1px solid ${cellBorder}`,
                                cursor: hasConflictCell ? "pointer" : "default",
                              }}
                              title={
                                isSelf
                                  ? row.laneName
                                  : hasConflictCell
                                    ? `${row.laneName} x ${col.laneName}: ${Math.max(pair?.fileCount ?? 0, pair?.files.length ?? 0)} files`
                                    : `${row.laneName} x ${col.laneName}: clean`
                              }
                              onClick={() => {
                                if (pair) togglePairExpansion(pair.key);
                              }}
                            >
                              {isSelf ? (
                                <span style={{ color: "#52525B", fontSize: 10 }}>--</span>
                              ) : hasConflictCell ? (
                                <Warning size={12} weight="fill" style={{ color: pair?.outcome === "blocked" ? "#EF4444" : "#F59E0B" }} />
                              ) : (
                                <CheckCircle size={12} weight="fill" style={{ color: "#22C55E" }} />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ---- Expandable conflict pairs list ---- */}
          {proposalConflictingPairs.length === 0 ? (
            <div
              className="flex items-center"
              style={{
                gap: 8,
                padding: "12px",
                background: "#22C55E08",
                border: "1px solid #22C55E20",
              }}
            >
              <CheckCircle size={16} weight="fill" style={{ color: "#22C55E" }} />
              <span className="font-mono" style={{ fontSize: 11, color: "#22C55E" }}>
                All lanes merge cleanly. No conflicts detected.
              </span>
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 6 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#52525B" }}>
                  CONFLICTING PAIRS
                </span>
                <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#A1A1AA" }}>
                  {proposalConflictingPairs.length} PAIR{proposalConflictingPairs.length !== 1 ? "S" : ""}
                </span>
              </div>
              {proposalConflictingPairs.map((pair) => {
                const expanded = expandedPairKeys.includes(pair.key);
                const pairFileCount = Math.max(pair.fileCount, pair.files.length);
                const resolutionA = resolutionState?.stepResolutions[pair.laneAId];
                const resolutionB = resolutionState?.stepResolutions[pair.laneBId];
                const isResolvedA = resolutionA === "resolved" || resolutionA === "merged-clean";
                const isResolvedB = resolutionB === "resolved" || resolutionB === "merged-clean";
                const isResolved = isResolvedA && isResolvedB;
                return (
                  <div
                    key={`pair-${pair.key}`}
                    style={{
                      background: "#0C0A10",
                      border: isResolved ? "1px solid #22C55E30" : "1px solid #F59E0B25",
                      borderLeft: isResolved ? "3px solid #22C55E" : "3px solid #F59E0B",
                    }}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center justify-between text-left"
                      style={{
                        padding: "10px 12px",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                      }}
                      onClick={() => togglePairExpansion(pair.key)}
                    >
                      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
                        {expanded ? (
                          <CaretDown size={12} weight="bold" style={{ color: "#71717A" }} />
                        ) : (
                          <CaretRight size={12} weight="bold" style={{ color: "#71717A" }} />
                        )}
                        <OutcomeDot outcome={isResolved ? "clean" : pair.outcome} />
                        <span className="truncate font-mono font-semibold" style={{ fontSize: 11, color: "#FAFAFA" }}>
                          {pair.laneAName}
                        </span>
                        <span className="font-mono" style={{ fontSize: 11, color: "#52525B" }}>x</span>
                        <span className="truncate font-mono font-semibold" style={{ fontSize: 11, color: "#FAFAFA" }}>
                          {pair.laneBName}
                        </span>
                      </div>
                      <div className="flex items-center" style={{ gap: 8 }}>
                        {isResolved && (
                          <span
                            className="font-mono font-bold uppercase tracking-[1px]"
                            style={{ fontSize: 8, padding: "1px 5px", background: "#22C55E18", color: "#22C55E" }}
                          >
                            RESOLVED
                          </span>
                        )}
                        <span className="font-mono" style={{ fontSize: 10, color: isResolved ? "#22C55E" : "#F59E0B" }}>
                          {pairFileCount > 0 ? `${pairFileCount} file${pairFileCount !== 1 ? "s" : ""}` : "paths unavailable"}
                        </span>
                      </div>
                    </button>

                    {expanded && (
                      <div style={{ padding: "0 12px 12px" }}>
                        {pair.files.length > 0 ? (
                          <div className="flex flex-col" style={{ gap: 4 }}>
                            {pair.files.map((file) => (
                              <div key={`${pair.key}-${file.path}`}>
                                {/* Reason label */}
                                <div
                                  className="flex items-center"
                                  style={{
                                    gap: 6,
                                    padding: "4px 8px",
                                    marginBottom: 2,
                                    background: "#F59E0B06",
                                  }}
                                >
                                  <Warning size={10} weight="fill" style={{ color: "#F59E0B" }} />
                                  <span className="font-mono" style={{ fontSize: 9, color: "#F59E0B" }}>
                                    Both lanes modified this file
                                  </span>
                                </div>
                                <ConflictFilePreview file={file} />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div
                            className="font-mono"
                            style={{
                              fontSize: 11,
                              color: "#71717A",
                              padding: "8px 10px",
                              background: "#F59E0B06",
                              borderLeft: "2px solid #F59E0B30",
                            }}
                          >
                            Specific file paths will be available after full merge simulation with replay.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ---- Summary bar ---- */}
          {proposalConflictingPairs.length > 0 && (
            <div
              className="flex items-center"
              style={{
                gap: 8,
                marginTop: 14,
                padding: "10px 12px",
                background: selectedProposal.overallOutcome === "conflict" ? "#F59E0B08" : "#EF444408",
                borderTop: `1px solid ${selectedProposal.overallOutcome === "conflict" ? "#F59E0B20" : "#EF444420"}`,
              }}
            >
              <Warning size={14} weight="fill" style={{ color: selectedProposal.overallOutcome === "blocked" ? "#EF4444" : "#F59E0B" }} />
              <span className="font-mono" style={{ fontSize: 11, color: selectedProposal.overallOutcome === "blocked" ? "#EF4444" : "#F59E0B" }}>
                {proposalConflictingPairs.length} lane pair{proposalConflictingPairs.length !== 1 ? "s" : ""} {proposalConflictingPairs.length !== 1 ? "have" : "has"} conflicts
                {totalProposalConflictFiles > 0 && ` across ${totalProposalConflictFiles} file${totalProposalConflictFiles !== 1 ? "s" : ""}`}.
                {selectedProposal.overallOutcome === "blocked"
                  ? " Integration is blocked until issues are resolved."
                  : " Integration cannot proceed without resolution."}
              </span>
            </div>
          )}
        </div>

        {/* ---- Resolve with AI card ---- */}
        {selectedProposal.overallOutcome === "conflict" && (
          <div
            style={{
              background: "#13101A",
              border: "1px solid #A78BFA30",
              borderLeft: "3px solid #A78BFA",
              padding: 0,
              marginBottom: 20,
              overflow: "hidden",
            }}
          >
            {/* Card header */}
            <div
              style={{
                padding: "14px 16px 12px",
                background: "#A78BFA08",
                borderBottom: "1px solid #A78BFA20",
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <Sparkle size={18} weight="fill" style={{ color: "#A78BFA" }} />
                <span
                  className="font-mono font-bold uppercase tracking-[1px]"
                  style={{ fontSize: 12, color: "#A78BFA" }}
                >
                  RESOLVE WITH AI
                </span>
              </div>
              <div className="font-mono" style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}>
                {totalProposalConflictFiles} conflict file{totalProposalConflictFiles === 1 ? "" : "s"} across {proposalConflictingPairs.length} lane pair{proposalConflictingPairs.length !== 1 ? "s" : ""}.
                The orchestrator will spawn workers to resolve conflicts automatically. Model and provider are configured via the mission execution policy.
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ padding: "12px 16px" }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                <button
                  type="button"
                  disabled={!nextManualResolutionLaneId || createLaneBusy || Boolean(resolvingLaneId)}
                  className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                  style={{
                    fontSize: 10,
                    height: 32,
                    padding: "0 14px",
                    background: "transparent",
                    color: "#F59E0B",
                    border: "1px solid #F59E0B50",
                    cursor: !nextManualResolutionLaneId || createLaneBusy || Boolean(resolvingLaneId) ? "not-allowed" : "pointer",
                    opacity: !nextManualResolutionLaneId || createLaneBusy || Boolean(resolvingLaneId) ? 0.5 : 1,
                  }}
                  onClick={() => handleStartManualResolution()}
                >
                  <Robot size={12} weight="fill" style={{ marginRight: 6 }} />
                  {createLaneBusy ? "PREPARING..." : "RESOLVE NEXT LANE"}
                </button>

                <button
                  type="button"
                  disabled={(proposalConflictSteps.length === 0 && proposalConflictingPairs.length === 0) || createLaneBusy || Boolean(resolvingLaneId)}
                  className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                  style={{
                    fontSize: 10,
                    height: 32,
                    padding: "0 14px",
                    background: "#A78BFA",
                    color: "#0F0D14",
                    border: "none",
                    cursor: (proposalConflictSteps.length === 0 && proposalConflictingPairs.length === 0) || createLaneBusy || Boolean(resolvingLaneId) ? "not-allowed" : "pointer",
                    opacity: (proposalConflictSteps.length === 0 && proposalConflictingPairs.length === 0) || createLaneBusy || Boolean(resolvingLaneId) ? 0.5 : 1,
                  }}
                  onClick={() => void handleAutoResolveAll()}
                >
                  <Robot size={12} weight="fill" style={{ marginRight: 6 }} />
                  {resolvingLaneId ? "RESOLVING..." : "AUTO-RESOLVE ALL"}
                </button>
              </div>

              {activeWorkerStepId && (
                <div
                  className="flex items-center"
                  style={{
                    gap: 8,
                    marginTop: 12,
                    padding: "10px 12px",
                    background: "#A78BFA08",
                    border: "1px solid #A78BFA20",
                  }}
                >
                  <Gear size={12} weight="fill" style={{ color: "#A78BFA" }} className="animate-spin" />
                  <span className="font-mono" style={{ fontSize: 11, color: "#A78BFA" }}>
                    Orchestrator worker running
                  </span>
                  <span className="font-mono" style={{ fontSize: 10, color: "#52525B", marginLeft: 4 }}>
                    View worker progress in the Work tab
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- Worker resolution progress (when resolving) ---- */}
        {resolutionState && Object.keys(resolutionState.stepResolutions).length > 0 && selectedProposal && (
          <div
            style={{
              background: "#13101A",
              border: "1px solid #A78BFA30",
              marginBottom: 20,
              overflow: "hidden",
            }}
          >
            {/* Resolution header bar */}
            <div
              style={{
                padding: "10px 16px",
                borderBottom: "1px solid #1E1B26",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "#A78BFA08",
              }}
            >
              <div className="flex items-center" style={{ gap: 10 }}>
                <Robot size={14} weight="fill" style={{ color: "#A78BFA" }} />
                <SectionHeader>WORKER RESOLUTION PROGRESS</SectionHeader>
              </div>
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
                  onClick={() => setActiveWorkerStepId(null)}
                >
                  DISMISS
                </Button>
              </div>
            </div>

            {/* Resolution progress panel */}
            <div
              style={{
                padding: "10px 16px",
                background: "#0C0A10",
              }}
            >
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span
                  className="font-mono font-bold uppercase tracking-[1px]"
                  style={{ fontSize: 9, color: "#52525B" }}
                >
                  RESOLUTION PROGRESS
                </span>
                <span className="font-mono" style={{ fontSize: 10, color: "#71717A" }}>
                  {Object.values(resolutionState.stepResolutions).filter((s) => s === "resolved" || s === "merged-clean").length}
                  {" / "}
                  {Object.keys(resolutionState.stepResolutions).length} lanes processed
                </span>
              </div>
              <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
                {selectedProposal.steps.map((step) => {
                  const status = resolutionState.stepResolutions[step.laneId];
                  const isActive = resolutionState.activeLaneId === step.laneId;
                  const statusConfig = {
                    "resolved":     { label: "RESOLVED",    color: "#22C55E", bg: "#22C55E18" },
                    "merged-clean": { label: "CLEAN",       color: "#22C55E", bg: "#22C55E18" },
                    "resolving":    { label: "WORKER RUNNING", color: "#A78BFA", bg: "#A78BFA18" },
                    "failed":       { label: "FAILED",      color: "#EF4444", bg: "#EF444418" },
                    "pending":      { label: "PENDING",     color: "#71717A", bg: "#71717A18" },
                  }[status ?? "pending"] ?? { label: "PENDING", color: "#71717A", bg: "#71717A18" };
                  return (
                    <div
                      key={`progress-${step.laneId}`}
                      className="flex items-center"
                      style={{
                        gap: 6,
                        padding: "4px 8px",
                        background: isActive ? "#A78BFA12" : "#0F0D14",
                        border: isActive ? "1px solid #A78BFA40" : "1px solid #1E1B26",
                      }}
                    >
                      <span className="font-mono font-semibold truncate" style={{ fontSize: 10, color: "#FAFAFA", maxWidth: 100 }}>
                        {step.laneName}
                      </span>
                      <span
                        className="font-mono font-bold uppercase tracking-[1px]"
                        style={{
                          fontSize: 8,
                          padding: "1px 4px",
                          background: statusConfig.bg,
                          color: statusConfig.color,
                        }}
                      >
                        {statusConfig.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              {/* Active lane status bar */}
              {resolutionState.activeLaneId && (
                <div
                  className="flex items-center"
                  style={{
                    gap: 6,
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: "1px solid #1E1B2680",
                  }}
                >
                  <Gear size={10} weight="fill" style={{ color: "#A78BFA" }} className="animate-spin" />
                  <span className="font-mono" style={{ fontSize: 10, color: "#A78BFA" }}>
                    Orchestrator worker resolving: {proposalLaneCards.find((l) => l.laneId === resolutionState.activeLaneId)?.laneName ?? resolutionState.activeLaneId}
                  </span>
                  <span className="font-mono" style={{ fontSize: 10, color: "#52525B", marginLeft: 8 }}>
                    View worker progress in the Work tab
                  </span>
                </div>
              )}
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
                  window.location.hash = `#/graph?focusLane=${encodeURIComponent(resolutionState.integrationLaneId)}`;
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
  }), [prs, selectedPr, selectedPrId, mergeContextByPrId, laneById, mergeSourcesResolved, resolverTargetLaneId, simulateResult, simulateBusy, simulateError, resolverOpen, deleteConfirm, deleteBusy, deleteCloseGh, hasConflicts, rebaseNeeds, autoRebaseStatuses, setActiveTab, onSelectPr, onRefresh, stepOutcomeByLaneId, proposals, proposalsLoaded, selectedProposal, selectedProposalId, commitBusy, commitError, resimBusy, deleteProposalBusy, expandedPairKeys, resolutionState, activeWorkerStepId, createLaneBusy, resolvingLaneId, allStepsResolved, proposalLaneCards, proposalConflictingPairs, proposalConflictSteps, totalProposalConflictFiles, urlProposalId, conflictPairCountByLaneId, isLegacySequentialProposal, nextManualResolutionLaneId]);

  return <PaneTilingLayout layoutId="prs:integration:v1" tree={TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
