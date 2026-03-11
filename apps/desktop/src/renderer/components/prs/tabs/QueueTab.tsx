import React from "react";
import { ArrowsDownUp, Trash, GithubLogo, CheckCircle, XCircle, Circle, Sparkle } from "@phosphor-icons/react";
import type {
  LandResult,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrSummary,
  PrWithConflicts,
  QueueLandingState,
  QueueRehearsalState,
} from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig } from "../../ui/PaneTilingLayout";
import { PrRebaseBanner } from "../PrRebaseBanner";
import { usePrs } from "../state/PrsContext";
import { PR_TAB_TILING_TREE } from "../shared/tilingConstants";
import { normalizeBranchName } from "../shared/prHelpers";
import { PrAiResolverPanel } from "../shared/PrAiResolverPanel";

type QueueGroup = {
  groupId: string;
  name: string | null;
  targetBranch: string | null;
  members: Array<{ prId: string; laneId: string; laneName: string; position: number; pr: PrWithConflicts | null }>;
  landingState: QueueLandingState | null;
  rehearsalState: QueueRehearsalState | null;
};

/* ---------- Status badge for queue group list items ---------- */
function GroupStatusBadge({ members }: { members: QueueGroup["members"] }) {
  const hasOpen = members.some((m) => m.pr?.state === "open" || m.pr?.state === "draft");
  if (hasOpen) {
    return (
      <span
        className="font-mono text-[10px] font-bold uppercase tracking-[1px] px-1.5 py-0.5"
        style={{ color: "#22C55E", background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)" }}
      >
        ONLINE
      </span>
    );
  }
  return (
    <span
      className="font-mono text-[10px] font-bold uppercase tracking-[1px] px-1.5 py-0.5"
      style={{ color: "#71717A", background: "rgba(113,113,122,0.10)", border: "1px solid rgba(113,113,122,0.25)" }}
    >
      OFFLINE
    </span>
  );
}

function checksConfig(status: PrSummary["checksStatus"]): { color: string; bg: string; border: string; icon: React.ReactNode } {
  if (status === "passing") {
    return { color: "#22C55E", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.25)", icon: <CheckCircle size={11} weight="fill" style={{ color: "#22C55E" }} /> };
  }
  if (status === "failing") {
    return { color: "#EF4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)", icon: <XCircle size={11} weight="fill" style={{ color: "#EF4444" }} /> };
  }
  return { color: "#F59E0B", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)", icon: <Circle size={11} weight="fill" style={{ color: "#F59E0B" }} /> };
}

function ChecksBadge({ status }: { status: PrSummary["checksStatus"] | undefined }) {
  if (!status || status === "none") return null;
  const config = checksConfig(status);
  return (
    <span
      className="font-mono font-bold uppercase tracking-[1px]"
      style={{
        fontSize: 10,
        color: config.color,
        background: config.bg,
        border: `1px solid ${config.border}`,
        padding: "2px 6px",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {config.icon}
      CI
    </span>
  );
}

type QueueTabProps = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  mergeMethod: MergeMethod;
  workflowView?: "active" | "history";
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  onRefresh: () => Promise<void>;
};

function getQueueWorkflowBucket(group: QueueGroup): "active" | "history" {
  if (group.landingState && (group.landingState.state === "completed" || group.landingState.state === "cancelled")) {
    return "history";
  }
  if (group.rehearsalState && (
    group.rehearsalState.state === "completed"
    || group.rehearsalState.state === "failed"
    || group.rehearsalState.state === "cancelled"
  )) {
    return group.landingState ? "active" : "history";
  }
  const hasOpenMembers = group.members.some((member) => member.pr?.state === "open" || member.pr?.state === "draft");
  return hasOpenMembers ? "active" : "history";
}

export function QueueTab({
  prs,
  lanes,
  mergeContextByPrId,
  mergeMethod,
  workflowView = "active",
  selectedGroupId,
  onSelectGroup,
  onRefresh,
}: QueueTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const {
    rebaseNeeds,
    autoRebaseStatuses,
    queueStates,
    queueRehearsals,
    setActiveTab,
    resolverModel,
    resolverReasoningLevel,
    setResolverModel,
    setResolverReasoningLevel
  } = usePrs();

  const [landBusy, setLandBusy] = React.useState(false);
  const [landError, setLandError] = React.useState<string | null>(null);
  const [landResult, setLandResult] = React.useState<LandResult | null>(null);
  const [archiveOnLand, setArchiveOnLand] = React.useState(false);
  const [queueCiGating, setQueueCiGating] = React.useState(true);
  const [autoResolveAll, setAutoResolveAll] = React.useState(false);
  const [queueActionBusy, setQueueActionBusy] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);
  const [resolverConfig, setResolverConfig] = React.useState<{ sourceLaneId: string; targetLaneId: string } | null>(null);

  // Build queue groups from merge contexts
  const queueGroups = React.useMemo(() => {
    const groupMap = new Map<string, QueueGroup>();
    const prById = new Map(prs.map((pr) => [pr.id, pr] as const));

    for (const queueState of Object.values(queueStates)) {
      groupMap.set(queueState.groupId, {
        groupId: queueState.groupId,
        name: queueState.groupName,
        targetBranch: queueState.targetBranch,
        landingState: queueState,
        rehearsalState: queueRehearsals[queueState.groupId] ?? null,
        members: queueState.entries.map((entry) => ({
          prId: entry.prId,
          laneId: entry.laneId,
          laneName: laneById.get(entry.laneId)?.name ?? entry.laneName,
          position: entry.position,
          pr: prById.get(entry.prId) ?? null,
        })),
      });
    }

    for (const rehearsalState of Object.values(queueRehearsals)) {
      const existing = groupMap.get(rehearsalState.groupId);
      if (existing) {
        existing.rehearsalState = rehearsalState;
        existing.targetBranch = existing.targetBranch ?? rehearsalState.targetBranch;
        continue;
      }
      groupMap.set(rehearsalState.groupId, {
        groupId: rehearsalState.groupId,
        name: rehearsalState.groupName,
        targetBranch: rehearsalState.targetBranch,
        landingState: queueStates[rehearsalState.groupId] ?? null,
        rehearsalState,
        members: rehearsalState.entries.map((entry) => ({
          prId: entry.prId,
          laneId: entry.laneId,
          laneName: laneById.get(entry.laneId)?.name ?? entry.laneName,
          position: entry.position,
          pr: prById.get(entry.prId) ?? null,
        })),
      });
    }

    for (const pr of prs) {
      const ctx = mergeContextByPrId[pr.id];
      if (!ctx?.groupId || ctx.groupType !== "queue") continue;
      let group = groupMap.get(ctx.groupId);
      if (!group) {
        group = {
          groupId: ctx.groupId,
          name: null,
          targetBranch: pr.baseBranch ?? null,
          members: [],
          landingState: queueStates[ctx.groupId] ?? null,
          rehearsalState: queueRehearsals[ctx.groupId] ?? null,
        };
        groupMap.set(ctx.groupId, group);
      }
      group.targetBranch = group.targetBranch ?? pr.baseBranch ?? null;
      if (!group.members.some((member) => member.prId === pr.id)) {
        const member = ctx.members?.find((m) => m.prId === pr.id);
        group.members.push({
          prId: pr.id,
          laneId: pr.laneId,
          laneName: laneById.get(pr.laneId)?.name ?? pr.laneId,
          position: member?.position ?? group.members.length,
          pr,
        });
      }
    }
    // Sort members by position within each group
    for (const group of groupMap.values()) {
      group.members.sort((a, b) => a.position - b.position);
    }
    return [...groupMap.values()];
  }, [prs, mergeContextByPrId, laneById, queueStates, queueRehearsals]);

  const visibleQueueGroups = React.useMemo(
    () => queueGroups.filter((group) => getQueueWorkflowBucket(group) === workflowView),
    [queueGroups, workflowView],
  );

  const selectedGroup = React.useMemo(
    () => visibleQueueGroups.find((g) => g.groupId === selectedGroupId) ?? null,
    [visibleQueueGroups, selectedGroupId]
  );

  React.useEffect(() => {
    if (selectedGroup?.landingState) {
      setArchiveOnLand(selectedGroup.landingState.config.archiveLane);
      setQueueCiGating(selectedGroup.landingState.config.ciGating);
      setAutoResolveAll(selectedGroup.landingState.config.autoResolve);
      return;
    }
    if (selectedGroup?.rehearsalState) {
      setAutoResolveAll(selectedGroup.rehearsalState.config.autoResolve);
    }
  }, [selectedGroup?.landingState, selectedGroup?.rehearsalState]);

  // Auto-select first group (guard against no-op updates when list is empty and nothing selected)
  React.useEffect(() => {
    if (visibleQueueGroups.length === 0 && selectedGroupId === null) return;
    if (selectedGroupId && visibleQueueGroups.some((g) => g.groupId === selectedGroupId)) return;
    onSelectGroup(visibleQueueGroups[0]?.groupId ?? null);
  }, [visibleQueueGroups, selectedGroupId, onSelectGroup]);

  const handleLandNext = async () => {
    if (!selectedGroup) return;
    setLandBusy(true); setLandError(null); setLandResult(null);
    try {
      const result = await window.ade.prs.landQueueNext({ groupId: selectedGroup.groupId, method: mergeMethod, archiveLane: archiveOnLand });
      setLandResult(result);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally { setLandBusy(false); }
  };

  const handleStartQueueAutomation = async (autoResolve: boolean) => {
    if (!selectedGroup) return;
    setQueueActionBusy(true);
    setLandError(null);
    try {
      await window.ade.prs.startQueueAutomation({
        groupId: selectedGroup.groupId,
        method: mergeMethod,
        archiveLane: archiveOnLand,
        autoResolve,
        ciGating: queueCiGating,
        resolverModel,
        reasoningEffort: resolverReasoningLevel,
        permissionMode: "guarded_edit",
        originSurface: "queue",
        originLabel: selectedGroup.name ?? selectedGroup.groupId,
      });
      setAutoResolveAll(autoResolve);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueActionBusy(false);
    }
  };

  const handleResumeQueueAutomation = async (autoResolve: boolean) => {
    if (!selectedGroup?.landingState) return;
    setQueueActionBusy(true);
    setLandError(null);
    try {
      await window.ade.prs.resumeQueueAutomation({
        queueId: selectedGroup.landingState.queueId,
        method: mergeMethod,
        archiveLane: archiveOnLand,
        autoResolve,
        ciGating: queueCiGating,
        resolverModel,
        reasoningEffort: resolverReasoningLevel,
        permissionMode: "guarded_edit",
      });
      setAutoResolveAll(autoResolve);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueActionBusy(false);
    }
  };

  const handlePauseQueueAutomation = async () => {
    if (!selectedGroup?.landingState) return;
    setQueueActionBusy(true);
    setLandError(null);
    try {
      await window.ade.prs.pauseQueueAutomation(selectedGroup.landingState.queueId);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueActionBusy(false);
    }
  };

  const handleCancelQueueAutomation = async () => {
    if (!selectedGroup?.landingState) return;
    setQueueActionBusy(true);
    setLandError(null);
    try {
      await window.ade.prs.cancelQueueAutomation(selectedGroup.landingState.queueId);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueActionBusy(false);
    }
  };

  const handleStartQueueRehearsal = async () => {
    if (!selectedGroup) return;
    setQueueActionBusy(true);
    setLandError(null);
    try {
      await window.ade.prs.startQueueRehearsal({
        groupId: selectedGroup.groupId,
        method: mergeMethod,
        autoResolve: autoResolveAll,
        resolverModel,
        reasoningEffort: resolverReasoningLevel,
        permissionMode: "guarded_edit",
        preserveScratchLane: true,
        originSurface: "queue",
        originLabel: selectedGroup.name ?? selectedGroup.groupId,
      });
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueActionBusy(false);
    }
  };

  const handleCancelQueueRehearsal = async () => {
    if (!selectedGroup?.rehearsalState) return;
    setQueueActionBusy(true);
    setLandError(null);
    try {
      await window.ade.prs.cancelQueueRehearsal(selectedGroup.rehearsalState.rehearsalId);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueActionBusy(false);
    }
  };

  const handleDeletePr = async (prId: string) => {
    setDeleteBusy(true); setLandError(null);
    try {
      await window.ade.prs.delete({ prId, closeOnGitHub: deleteCloseGh });
      setDeleteTarget(null);
      await onRefresh();
    } catch (err: unknown) {
      setLandError(err instanceof Error ? err.message : String(err));
    } finally { setDeleteBusy(false); }
  };

  /* ---------- Stat counters for selected group ---------- */
  const stats = React.useMemo(() => {
    if (!selectedGroup) return { landed: 0, pending: 0, failed: 0, processing: false };
    let landed = 0, pending = 0, failed = 0, processing = false;
    const entries = selectedGroup.landingState?.entries ?? [];
    if (entries.length > 0) {
      for (const entry of entries) {
        if (entry.state === "landed") landed++;
        else if (entry.state === "failed") failed++;
        else {
          pending++;
          if (entry.state === "landing" || entry.state === "resolving") processing = true;
        }
      }
      return { landed, pending, failed, processing };
    }
    const rehearsalEntries = selectedGroup.rehearsalState?.entries ?? [];
    if (rehearsalEntries.length > 0) {
      for (const entry of rehearsalEntries) {
        if (entry.state === "ready" || entry.state === "resolved") landed++;
        else if (entry.state === "failed" || entry.state === "blocked") failed++;
        else {
          pending++;
          if (entry.state === "rehearsing" || entry.state === "resolving") processing = true;
        }
      }
      return { landed, pending, failed, processing };
    }
    for (const m of selectedGroup.members) {
      const st = m.pr?.state;
      if (st === "merged") landed++;
      else if (st === "closed") failed++;
      else { pending++; if (st === "open") processing = true; }
    }
    return { landed, pending, failed, processing };
  }, [selectedGroup]);

  const pad2 = (n: number) => String(n).padStart(2, "0");

  const resolveTargetLaneId = React.useCallback((member: QueueGroup["members"][number]): string | null => {
    const targetBranch = normalizeBranchName(member.pr?.baseBranch ?? selectedGroup?.targetBranch ?? "");
    if (!targetBranch) return null;
    const lane = lanes.find((entry) => normalizeBranchName(entry.branchRef) === targetBranch);
    return lane?.id ?? null;
  }, [lanes, selectedGroup?.targetBranch]);

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(() => ({
    list: {
      title: "Queue Groups",
      bodyClassName: "overflow-auto",
      children: (
        <div style={{ padding: 8 }}>
          {/* Section header */}
          <div
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{ fontSize: 10, color: "#71717A", padding: "8px 8px 12px" }}
          >
            QUEUE GROUPS
          </div>

          {!visibleQueueGroups.length ? (
            <EmptyState title="No queue groups" description="Create a queue to open sequential PRs across lanes for ordered landing." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {visibleQueueGroups.map((group) => {
                const isSelected = group.groupId === selectedGroupId;
                return (
                  <button
                    key={group.groupId}
                    type="button"
                    className="w-full text-left font-mono transition-colors duration-100"
                    style={{
                      padding: "12px 12px 12px 14px",
                      borderLeft: isSelected ? "3px solid #A78BFA" : "3px solid transparent",
                      background: isSelected ? "rgba(167,139,250,0.07)" : "transparent",
                      borderRadius: 0,
                    }}
                    onClick={() => onSelectGroup(group.groupId)}
                    onMouseEnter={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = "rgba(167,139,250,0.04)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span className="font-bold" style={{ fontSize: 12, color: "#FAFAFA" }}>
                        {group.name ?? `Queue ${group.groupId.slice(0, 8)}`}
                      </span>
                      <GroupStatusBadge members={group.members} />
                    </div>
                    <div
                      className="font-mono"
                      style={{ marginTop: 6, fontSize: 11, color: "#71717A", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <span>{group.members.length} PRs</span>
                      <span style={{ color: "#52525B" }}>&middot;</span>
                      <span>target: {group.targetBranch ?? "main"}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ),
    },
    detail: {
      title: selectedGroup ? `Queue: ${selectedGroup.name ?? selectedGroup.groupId.slice(0, 8)}` : "Queue Detail",
      bodyClassName: "overflow-auto",
      children: selectedGroup ? (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20 }}>

          {/* ===== Rebase banners for member lanes ===== */}
          {selectedGroup.members.map((m) => (
            <PrRebaseBanner key={m.laneId} laneId={m.laneId} rebaseNeeds={rebaseNeeds} autoRebaseStatuses={autoRebaseStatuses} onTabChange={(tab) => setActiveTab(tab as "normal" | "queue" | "integration" | "rebase")} />
          ))}

          {/* ===== Header card ===== */}
          <div
            style={{
              background: "#13101A",
              border: "1px solid #1E1B26",
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div className="font-bold" style={{ fontSize: 16, color: "#FAFAFA", fontFamily: "'Space Grotesk', sans-serif" }}>
                {selectedGroup.name ?? `Queue ${selectedGroup.groupId.slice(0, 8)}`}
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 4 }}>
                {selectedGroup.members.length} PRs in pipeline
                {selectedGroup.landingState ? ` · land ${selectedGroup.landingState.state.replace(/_/g, " ")}` : ""}
                {selectedGroup.rehearsalState ? ` · rehearse ${selectedGroup.rehearsalState.state.replace(/_/g, " ")}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label
                style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#71717A", cursor: "pointer" }}
                className="font-mono"
              >
                <input
                  type="checkbox"
                  checked={archiveOnLand}
                  onChange={(e) => setArchiveOnLand(e.target.checked)}
                  style={{ accentColor: "#A78BFA" }}
                />
                Archive lane
              </label>
              <button
                type="button"
                disabled={landBusy}
                onClick={() => void handleLandNext()}
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 11,
                  background: "#A78BFA",
                  color: "#0F0D14",
                  border: "none",
                  padding: "8px 16px",
                  cursor: landBusy ? "not-allowed" : "pointer",
                  opacity: landBusy ? 0.4 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <ArrowsDownUp size={13} weight="bold" />
                {landBusy ? "LANDING..." : "LAND NEXT"}
              </button>
              {selectedGroup.landingState?.state === "landing" ? (
                <>
                  <button
                    type="button"
                    disabled={queueActionBusy}
                    onClick={() => void handlePauseQueueAutomation()}
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{
                      fontSize: 11,
                      background: "transparent",
                      color: "#F59E0B",
                      border: "1px solid rgba(245,158,11,0.35)",
                      padding: "8px 12px",
                      cursor: queueActionBusy ? "not-allowed" : "pointer",
                      opacity: queueActionBusy ? 0.4 : 1,
                    }}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    disabled={queueActionBusy}
                    onClick={() => void handleCancelQueueAutomation()}
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{
                      fontSize: 11,
                      background: "transparent",
                      color: "#EF4444",
                      border: "1px solid rgba(239,68,68,0.35)",
                      padding: "8px 12px",
                      cursor: queueActionBusy ? "not-allowed" : "pointer",
                      opacity: queueActionBusy ? 0.4 : 1,
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={queueActionBusy}
                    onClick={() => void (
                      selectedGroup.rehearsalState?.state === "running"
                        ? handleCancelQueueRehearsal()
                        : handleStartQueueRehearsal()
                    )}
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{
                      fontSize: 11,
                      background: selectedGroup.rehearsalState?.state === "running" ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)",
                      color: selectedGroup.rehearsalState?.state === "running" ? "#FCA5A5" : "#4ADE80",
                      border: selectedGroup.rehearsalState?.state === "running"
                        ? "1px solid rgba(248,113,113,0.28)"
                        : "1px solid rgba(74,222,128,0.28)",
                      padding: "8px 12px",
                      cursor: queueActionBusy ? "not-allowed" : "pointer",
                      opacity: queueActionBusy ? 0.4 : 1,
                    }}
                  >
                    {selectedGroup.rehearsalState?.state === "running" ? "Cancel Rehearsal" : "Rehearse Queue"}
                  </button>
                  <button
                    type="button"
                    disabled={queueActionBusy}
                    onClick={() => void (
                      selectedGroup.landingState?.state === "paused"
                        ? handleResumeQueueAutomation(false)
                        : handleStartQueueAutomation(false)
                    )}
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{
                      fontSize: 11,
                      background: "rgba(59,130,246,0.12)",
                      color: "#60A5FA",
                      border: "1px solid rgba(96,165,250,0.28)",
                      padding: "8px 12px",
                      cursor: queueActionBusy ? "not-allowed" : "pointer",
                      opacity: queueActionBusy ? 0.4 : 1,
                    }}
                  >
                    {selectedGroup.landingState?.state === "paused" ? "Resume Auto-land" : "Auto-land"}
                  </button>
                  <button
                    type="button"
                    disabled={queueActionBusy}
                    onClick={() => void (
                      selectedGroup.landingState?.state === "paused"
                        ? handleResumeQueueAutomation(true)
                        : handleStartQueueAutomation(true)
                    )}
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{
                      fontSize: 11,
                      background: "rgba(167,139,250,0.12)",
                      color: "#A78BFA",
                      border: "1px solid rgba(167,139,250,0.28)",
                      padding: "8px 12px",
                      cursor: queueActionBusy ? "not-allowed" : "pointer",
                      opacity: queueActionBusy ? 0.4 : 1,
                    }}
                  >
                    {selectedGroup.landingState?.state === "paused" ? "Resume + Resolve" : "Auto-land + Resolve"}
                  </button>
                </>
              )}
            </div>
          </div>

          {resolverConfig ? (
            <PrAiResolverPanel
              key={`${resolverConfig.sourceLaneId}:${resolverConfig.targetLaneId}`}
              title="QUEUE AI RESOLVER"
              description="Resolve this queue member inline, using the same chat transcript UI as Work and Missions."
              context={{
                sourceTab: "queue",
                sourceLaneId: resolverConfig.sourceLaneId,
                targetLaneId: resolverConfig.targetLaneId,
                laneId: resolverConfig.sourceLaneId,
                scenario: "single-merge",
              }}
              modelId={resolverModel}
              reasoningEffort={resolverReasoningLevel}
              onModelChange={(model, effort) => {
                setResolverModel(model);
                setResolverReasoningLevel(effort || "medium");
              }}
              onCompleted={() => {
                void onRefresh();
              }}
              onDismiss={() => setResolverConfig(null)}
              startLabel="Start Queue Resolver"
            />
          ) : null}

          {/* ===== Queue Status section ===== */}
          <div>
            <div
              className="font-mono font-bold uppercase tracking-[1px]"
              style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}
            >
              QUEUE STATUS
            </div>
            <div
              style={{
                background: "#13101A",
                border: "1px solid #1E1B26",
                padding: 16,
              }}
            >
              {/* Processing indicator */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                {selectedGroup.landingState?.state === "paused" || selectedGroup.rehearsalState?.state === "paused" ? (
                  <>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        background: "#F59E0B",
                        display: "inline-block",
                      }}
                    />
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 11, color: "#F59E0B" }}>
                      PAUSED
                    </span>
                  </>
                ) : stats.processing || selectedGroup.rehearsalState?.state === "running" ? (
                  <>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        background: "#22C55E",
                        display: "inline-block",
                        animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                      }}
                    />
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 11, color: "#22C55E" }}>
                      PROCESSING
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ width: 8, height: 8, background: "#71717A", display: "inline-block" }} />
                    <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 11, color: "#71717A" }}>
                      IDLE
                    </span>
                  </>
                )}
              </div>

              <div className="grid gap-2 md:grid-cols-2" style={{ marginBottom: 16 }}>
                <div className="font-mono text-[10px]" style={{ color: "#A1A1AA" }}>
                  <div>mode: {selectedGroup.landingState?.config.method ?? mergeMethod}</div>
                  <div>archive lane: {(selectedGroup.landingState?.config.archiveLane ?? archiveOnLand) ? "yes" : "no"}</div>
                  <div>ci gating: {(selectedGroup.landingState?.config.ciGating ?? queueCiGating) ? "on" : "off"}</div>
                </div>
                <div className="font-mono text-[10px]" style={{ color: "#A1A1AA" }}>
                  <div>auto resolve: {(selectedGroup.landingState?.config.autoResolve ?? autoResolveAll) ? "on" : "off"}</div>
                  <div>resolver model: {selectedGroup.landingState?.config.resolverModel ?? resolverModel}</div>
                  <div>reasoning: {selectedGroup.landingState?.config.reasoningEffort ?? resolverReasoningLevel}</div>
                </div>
              </div>

              {selectedGroup.rehearsalState ? (
                <div className="font-mono text-[10px]" style={{ color: "#A1A1AA", marginBottom: 16 }}>
                  <div>rehearsal: {selectedGroup.rehearsalState.state.replace(/_/g, " ")}</div>
                  <div>scratch lane: {selectedGroup.rehearsalState.scratchLaneId ?? "allocating"}</div>
                  <div>rehearsal id: {selectedGroup.rehearsalState.rehearsalId}</div>
                </div>
              ) : null}

              {selectedGroup.landingState?.lastError ? (
                <div
                  className="font-mono"
                  style={{
                    marginBottom: 16,
                    fontSize: 10,
                    color: selectedGroup.landingState.waitReason === "ci" || selectedGroup.landingState.waitReason === "review" ? "#F59E0B" : "#EF4444",
                    background: selectedGroup.landingState.waitReason === "ci" || selectedGroup.landingState.waitReason === "review"
                      ? "rgba(245,158,11,0.08)"
                      : "rgba(239,68,68,0.08)",
                    border: selectedGroup.landingState.waitReason === "ci" || selectedGroup.landingState.waitReason === "review"
                      ? "1px solid rgba(245,158,11,0.20)"
                      : "1px solid rgba(239,68,68,0.20)",
                    padding: "8px 10px",
                  }}
                >
                  {selectedGroup.landingState.lastError}
                </div>
              ) : null}

              {selectedGroup.rehearsalState?.lastError ? (
                <div
                  className="font-mono"
                  style={{
                    marginBottom: 16,
                    fontSize: 10,
                    color: selectedGroup.rehearsalState.state === "paused" ? "#F59E0B" : "#EF4444",
                    background: selectedGroup.rehearsalState.state === "paused"
                      ? "rgba(245,158,11,0.08)"
                      : "rgba(239,68,68,0.08)",
                    border: selectedGroup.rehearsalState.state === "paused"
                      ? "1px solid rgba(245,158,11,0.20)"
                      : "1px solid rgba(239,68,68,0.20)",
                    padding: "8px 10px",
                  }}
                >
                  {selectedGroup.rehearsalState.lastError}
                </div>
              ) : null}

              {/* Stat counters */}
              <div style={{ display: "flex", gap: 24 }}>
                {/* LANDED */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <span className="font-mono font-bold" style={{ fontSize: 28, color: "#22C55E", lineHeight: 1 }}>
                    {pad2(stats.landed)}
                  </span>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}
                  >
                    COMPLETE
                  </span>
                </div>
                {/* PENDING */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <span className="font-mono font-bold" style={{ fontSize: 28, color: "#A1A1AA", lineHeight: 1 }}>
                    {pad2(stats.pending)}
                  </span>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}
                  >
                    PENDING
                  </span>
                </div>
                {/* FAILED */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                  <span className="font-mono font-bold" style={{ fontSize: 28, color: "#EF4444", lineHeight: 1 }}>
                    {pad2(stats.failed)}
                  </span>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 10, color: "#71717A", marginTop: 6 }}
                  >
                    BLOCKED
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ===== Members / Pipeline section ===== */}
          <div>
            <div
              className="font-mono font-bold uppercase tracking-[1px]"
              style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}
            >
              MEMBERS
            </div>
            <div
              style={{
                background: "#13101A",
                border: "1px solid #1E1B26",
                padding: 16,
              }}
            >
              {selectedGroup.members.map((member, idx) => {
                const isLast = idx === selectedGroup.members.length - 1;
                const queueEntry = selectedGroup.landingState?.entries.find((entry) => entry.prId === member.prId) ?? null;
                const rehearsalEntry = selectedGroup.rehearsalState?.entries.find((entry) => entry.prId === member.prId) ?? null;
                const entryState = queueEntry?.state ?? (member.pr?.state === "merged" ? "landed" : member.pr?.state === "closed" ? "failed" : "pending");
                const isLanded = entryState === "landed";
                const isActive = entryState === "landing" || entryState === "resolving";
                const isFailed = entryState === "failed";
                const isPaused = entryState === "paused";

                // Dot color
                const dotColor = isLanded ? "#22C55E" : isActive ? "#3B82F6" : isPaused ? "#F59E0B" : isFailed ? "#EF4444" : "#52525B";

                // Status badge text + colors
                let badgeLabel = "PENDING";
                let badgeColor = "#A1A1AA";
                let badgeBg = "rgba(161,161,170,0.08)";
                let badgeBorder = "rgba(161,161,170,0.20)";
                if (isLanded) {
                  badgeLabel = "LANDED";
                  badgeColor = "#22C55E";
                  badgeBg = "rgba(34,197,94,0.08)";
                  badgeBorder = "rgba(34,197,94,0.25)";
                } else if (isActive) {
                  badgeLabel = entryState === "resolving" ? "RESOLVING" : "LANDING";
                  badgeColor = "#3B82F6";
                  badgeBg = "rgba(59,130,246,0.08)";
                  badgeBorder = "rgba(59,130,246,0.25)";
                } else if (isPaused) {
                  badgeLabel = "PAUSED";
                  badgeColor = "#F59E0B";
                  badgeBg = "rgba(245,158,11,0.08)";
                  badgeBorder = "rgba(245,158,11,0.25)";
                } else if (isFailed) {
                  badgeLabel = "FAILED";
                  badgeColor = "#EF4444";
                  badgeBg = "rgba(239,68,68,0.08)";
                  badgeBorder = "rgba(239,68,68,0.25)";
                }

                return (
                  <div key={member.prId}>
                    <div style={{ display: "flex", alignItems: "stretch" }}>
                      {/* Connector column */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 32, flexShrink: 0 }}>
                        <div
                          style={{
                            width: 10,
                            height: 10,
                            background: dotColor,
                            flexShrink: 0,
                            marginTop: 6,
                            ...(isActive ? { boxShadow: `0 0 8px ${dotColor}80` } : {}),
                          }}
                        />
                        {!isLast && (
                          <div
                            style={{
                              width: 1,
                              flex: 1,
                              minHeight: 24,
                              background: isLanded ? "#22C55E" : "#1E1B26",
                              opacity: isLanded ? 0.5 : 1,
                            }}
                          />
                        )}
                      </div>

                      {/* Node content */}
                      <div
                        style={{
                          flex: 1,
                          padding: "8px 12px",
                          marginBottom: isLast ? 0 : 2,
                          background: isActive
                            ? "rgba(59,130,246,0.05)"
                            : isLanded
                              ? "rgba(34,197,94,0.03)"
                              : "transparent",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            {/* Position number */}
                            <span
                              className="font-mono font-bold"
                              style={{ fontSize: 11, color: "#52525B", minWidth: 18, textAlign: "center" }}
                            >
                              {pad2(member.position + 1)}
                            </span>
                            {/* Lane name */}
                            <span
                              className="font-mono font-bold"
                              style={{
                                fontSize: 12,
                                color: "#FAFAFA",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {member.laneName}
                            </span>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                            {/* Checks badge */}
                            {member.pr && <ChecksBadge status={member.pr.checksStatus} />}
                            {/* Status badge */}
                            <span
                              className="font-mono font-bold uppercase tracking-[1px]"
                              style={{
                                fontSize: 10,
                                color: badgeColor,
                                background: badgeBg,
                                border: `1px solid ${badgeBorder}`,
                                padding: "2px 6px",
                              }}
                            >
                              {badgeLabel}
                            </span>
                            {/* Open in GitHub */}
                            {member.pr && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); void window.ade.prs.openInGitHub(member.prId); }}
                                style={{
                                  padding: 2,
                                  background: "transparent",
                                  border: "none",
                                  color: "#52525B",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#FAFAFA"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#52525B"; }}
                                title="Open in GitHub"
                              >
                                <GithubLogo size={13} />
                              </button>
                            )}
                            {/* Delete button (not on landed items) */}
                            {!isLanded && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const targetLaneId = resolveTargetLaneId(member);
                                  if (!targetLaneId) {
                                    setLandError(`Cannot find a lane matching base branch "${member.pr?.baseBranch ?? selectedGroup?.targetBranch ?? "unknown"}".`);
                                    return;
                                  }
                                  setResolverConfig({ sourceLaneId: member.laneId, targetLaneId });
                                }}
                                style={{
                                  padding: "2px 6px",
                                  background: "rgba(167,139,250,0.12)",
                                  border: "1px solid rgba(167,139,250,0.28)",
                                  color: "#A78BFA",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  fontSize: 10,
                                  fontFamily: "monospace",
                                  textTransform: "uppercase",
                                  letterSpacing: "1px",
                                }}
                                title="Resolve this queue member against its base branch with AI"
                              >
                                <Sparkle size={11} />
                                Resolve
                              </button>
                            )}
                            {!isLanded && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setDeleteTarget(deleteTarget === member.prId ? null : member.prId); }}
                                style={{
                                  padding: 2,
                                  background: "transparent",
                                  border: "none",
                                  color: "#52525B",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#EF4444"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#52525B"; }}
                                title="Remove PR"
                              >
                                <Trash size={13} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* PR number + title */}
                        {member.pr && (
                          <div
                            className="font-mono"
                            style={{
                              marginTop: 4,
                              fontSize: 11,
                              color: "#71717A",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span style={{ color: "#52525B" }}>#{member.pr.githubPrNumber}</span>
                            {" "}
                            <span>{member.pr.title}</span>
                          </div>
                        )}
                        {queueEntry?.error ? (
                          <div className="font-mono" style={{ marginTop: 4, fontSize: 10, color: isPaused ? "#F59E0B" : "#EF4444" }}>
                            {queueEntry.error}
                          </div>
                        ) : null}
                        {queueEntry?.resolvedByAi ? (
                          <div className="font-mono" style={{ marginTop: 4, fontSize: 10, color: "#A78BFA" }}>
                            Resolved with AI{queueEntry.resolverRunId ? ` · job ${queueEntry.resolverRunId.slice(0, 8)}` : ""}
                          </div>
                        ) : null}
                        {rehearsalEntry ? (
                          <div className="font-mono" style={{ marginTop: 4, fontSize: 10, color: rehearsalEntry.state === "failed" || rehearsalEntry.state === "blocked" ? "#F59E0B" : "#4ADE80" }}>
                            Rehearsal: {rehearsalEntry.state.replace(/_/g, " ")}
                            {rehearsalEntry.resolvedByAi ? ` · AI fixed` : ""}
                            {rehearsalEntry.changedFiles?.length ? ` · ${rehearsalEntry.changedFiles.length} files` : ""}
                          </div>
                        ) : null}
                        {rehearsalEntry?.error ? (
                          <div className="font-mono" style={{ marginTop: 4, fontSize: 10, color: rehearsalEntry.state === "blocked" ? "#F59E0B" : "#EF4444" }}>
                            {rehearsalEntry.error}
                          </div>
                        ) : null}

                        {/* Delete confirmation inline */}
                        {deleteTarget === member.prId && (
                          <div
                            style={{
                              marginTop: 8,
                              background: "rgba(239,68,68,0.05)",
                              border: "1px solid rgba(239,68,68,0.15)",
                              padding: 10,
                            }}
                          >
                            <div className="font-mono" style={{ fontSize: 11, color: "#EF4444", marginBottom: 8 }}>
                              REMOVE THIS PR FROM THE QUEUE?
                            </div>
                            <label
                              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#A1A1AA", cursor: "pointer", marginBottom: 8 }}
                              className="font-mono"
                            >
                              <input
                                type="checkbox"
                                checked={deleteCloseGh}
                                onChange={(e) => setDeleteCloseGh(e.target.checked)}
                                style={{ accentColor: "#A78BFA" }}
                              />
                              Also close on GitHub
                            </label>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <button
                                type="button"
                                disabled={deleteBusy}
                                onClick={() => void handleDeletePr(member.prId)}
                                className="font-mono font-bold uppercase tracking-[1px]"
                                style={{
                                  fontSize: 10,
                                  padding: "4px 10px",
                                  background: "transparent",
                                  border: "1px solid rgba(239,68,68,0.40)",
                                  color: "#EF4444",
                                  cursor: deleteBusy ? "not-allowed" : "pointer",
                                  opacity: deleteBusy ? 0.4 : 1,
                                }}
                              >
                                {deleteBusy ? "REMOVING..." : "CONFIRM"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(null)}
                                className="font-mono font-bold uppercase tracking-[1px]"
                                style={{
                                  fontSize: 10,
                                  padding: "4px 10px",
                                  background: "transparent",
                                  border: "1px solid #27272A",
                                  color: "#A1A1AA",
                                  cursor: "pointer",
                                }}
                              >
                                CANCEL
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ===== Errors / results banners ===== */}
          {landError && (
            <div
              className="font-mono"
              style={{
                background: "rgba(239,68,68,0.06)",
                border: "1px solid rgba(239,68,68,0.20)",
                padding: "10px 14px",
                fontSize: 11,
                color: "#EF4444",
              }}
            >
              {landError}
            </div>
          )}
          {landResult && (
            <div
              className="font-mono"
              style={{
                background: landResult.success ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)",
                border: `1px solid ${landResult.success ? "rgba(34,197,94,0.20)" : "rgba(239,68,68,0.20)"}`,
                padding: "10px 14px",
                fontSize: 11,
                color: landResult.success ? "#22C55E" : "#EF4444",
              }}
            >
              {landResult.success ? `Landed PR #${landResult.prNumber}` : `Failed: ${landResult.error ?? "unknown"}`}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No queue selected" description="Select a queue group to manage landing order." />
        </div>
      ),
    },
  }), [
    visibleQueueGroups,
    selectedGroup,
    selectedGroupId,
    landBusy,
    landError,
    landResult,
    archiveOnLand,
    queueCiGating,
    autoResolveAll,
    queueActionBusy,
    mergeMethod,
    resolverModel,
    resolverReasoningLevel,
    deleteTarget,
    deleteBusy,
    deleteCloseGh,
    rebaseNeeds,
    autoRebaseStatuses,
    resolverConfig,
    setActiveTab,
    onSelectGroup,
    onRefresh,
  ]);

  return (
    <PaneTilingLayout layoutId="prs:queue:v1" tree={PR_TAB_TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />
  );
}
