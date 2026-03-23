import React from "react";
import {
  ArrowsDownUp,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  GitBranch,
  GithubLogo,
  Sparkle,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type {
  LandResult,
  LaneSummary,
  MergeMethod,
  PrMergeContext,
  PrStatus,
  PrSummary,
  PrWithConflicts,
  QueueLandingEntry,
  QueueLandingState,
  RebaseResult,
} from "../../../../shared/types";
import { getModelById } from "../../../../shared/modelRegistry";
import { EmptyState } from "../../ui/EmptyState";
import { PaneTilingLayout, type PaneConfig } from "../../ui/PaneTilingLayout";
import { usePrs } from "../state/PrsContext";
import { PR_TAB_TILING_TREE } from "../shared/tilingConstants";
import { PrResolverLaunchControls } from "../shared/PrResolverLaunchControls";
import {
  buildManualLandWarnings,
  findQueueMemberSelection,
  getQueueWorkflowBucket,
} from "./queueWorkflowModel";

type QueueMember = {
  prId: string;
  laneId: string;
  laneName: string;
  position: number;
  pr: PrWithConflicts | null;
};

type QueueGroup = {
  groupId: string;
  name: string | null;
  targetBranch: string | null;
  members: QueueMember[];
  landingState: QueueLandingState | null;
};

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

type QueueRebaseScope = "next" | "all";
type QueueRebaseMode = "ai" | "local" | "push";

type BatchRebaseItemResult = {
  laneId: string;
  laneName: string;
  success: boolean;
  pushed: boolean;
  error: string | null;
};

type BatchRebaseSummary = {
  mode: QueueRebaseMode;
  scope: QueueRebaseScope;
  targetLaneIds: string[];
  results: BatchRebaseItemResult[];
  stoppedEarly: boolean;
  failedLaneId: string | null;
  finishedAt: string;
};

type ColorTheme = { color: string; bg: string; border: string };

const THEME_GREEN: ColorTheme = { color: "#22C55E", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.24)" };
const THEME_RED: ColorTheme = { color: "#EF4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.24)" };
const THEME_AMBER: ColorTheme = { color: "#F59E0B", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.24)" };
const THEME_BLUE: ColorTheme = { color: "#60A5FA", bg: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.24)" };
const THEME_MUTED: ColorTheme = { color: "#A1A1AA", bg: "rgba(161,161,170,0.08)", border: "rgba(161,161,170,0.20)" };
const BADGE_CLASS = "font-mono font-bold uppercase tracking-[1px]";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function queueGroupLabel(group: QueueGroup): string {
  return group.name?.trim() || `Queue ${group.groupId.slice(0, 8)}`;
}

function getChecksBadge(status: PrSummary["checksStatus"] | undefined): { label: string; theme: ColorTheme } | null {
  if (!status || status === "none") return null;
  if (status === "passing") return { label: "CI passing", theme: THEME_GREEN };
  if (status === "failing") return { label: "CI failing", theme: THEME_RED };
  return { label: "CI running", theme: THEME_AMBER };
}

function getReviewBadge(status: PrSummary["reviewStatus"] | undefined): { label: string; theme: ColorTheme } | null {
  if (!status || status === "none") return null;
  if (status === "approved") return { label: "Approved", theme: THEME_GREEN };
  if (status === "changes_requested") return { label: "Changes requested", theme: THEME_RED };
  return { label: "Review pending", theme: THEME_AMBER };
}

function describeMergeability(status: PrStatus | null, loading: boolean): { label: string; theme: ColorTheme } {
  if (loading) return { label: "Checking mergeability", theme: THEME_MUTED };
  if (!status) return { label: "PR state unavailable", theme: THEME_MUTED };
  if (status.mergeConflicts) return { label: "Merge conflicts", theme: THEME_RED };
  if (status.isMergeable) return { label: "Mergeable", theme: THEME_GREEN };
  return { label: "Mergeability pending", theme: THEME_AMBER };
}

function describeQueueEntry(entry: QueueLandingEntry | null, member: QueueMember): { label: string; theme: ColorTheme } {
  if (entry) {
    switch (entry.state) {
      case "landed":
        return { label: "Landed", theme: THEME_GREEN };
      case "failed":
        return { label: "Blocked", theme: THEME_RED };
      case "paused":
        return { label: "Paused", theme: THEME_AMBER };
      case "landing":
        return { label: "Landing", theme: THEME_BLUE };
      case "resolving":
        return { label: "Resolving", theme: THEME_BLUE };
      case "rebasing":
        return { label: "Rebasing", theme: THEME_BLUE };
      case "skipped":
        return { label: "Skipped", theme: THEME_MUTED };
      default:
        return { label: "Pending", theme: THEME_MUTED };
    }
  }

  if (member.pr?.state === "merged") return { label: "Landed", theme: THEME_GREEN };
  if (member.pr?.state === "closed") return { label: "Closed", theme: THEME_RED };
  if (member.pr?.state === "draft") return { label: "Draft", theme: THEME_MUTED };
  return { label: "Pending", theme: THEME_MUTED };
}

function describePrHealth(pr: QueueMember["pr"] | null): string | null {
  if (!pr) return null;
  const parts: string[] = [];
  if (pr.checksStatus === "passing") parts.push("CI passing");
  else if (pr.checksStatus === "failing") parts.push("CI failing");
  else if (pr.checksStatus === "pending") parts.push("CI running");

  if (pr.reviewStatus === "approved") parts.push("approved");
  else if (pr.reviewStatus === "changes_requested") parts.push("changes requested");
  else if (pr.reviewStatus === "requested") parts.push("review pending");

  return parts.length > 0 ? parts.join(" · ") : null;
}

function buildQueueGroups(args: {
  prs: PrWithConflicts[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  lanes: LaneSummary[];
  queueStates: Record<string, QueueLandingState>;
}): QueueGroup[] {
  const laneById = new Map(args.lanes.map((lane) => [lane.id, lane] as const));
  const prById = new Map(args.prs.map((pr) => [pr.id, pr] as const));
  const groupMap = new Map<string, QueueGroup>();

  const toMembers = (
    entries: Array<{ prId: string; laneId: string; laneName: string; position: number }>,
  ): QueueMember[] =>
    entries.map((entry) => ({
      prId: entry.prId,
      laneId: entry.laneId,
      laneName: laneById.get(entry.laneId)?.name ?? entry.laneName,
      position: entry.position,
      pr: prById.get(entry.prId) ?? null,
    }));

  for (const queueState of Object.values(args.queueStates)) {
    groupMap.set(queueState.groupId, {
      groupId: queueState.groupId,
      name: queueState.groupName,
      targetBranch: queueState.targetBranch,
      landingState: queueState,
      members: toMembers(queueState.entries),
    });
  }

  for (const pr of args.prs) {
    const context = args.mergeContextByPrId[pr.id];
    if (!context?.groupId || context.groupType !== "queue") continue;
    const existing = groupMap.get(context.groupId);
    if (existing) {
      if (!existing.members.some((member) => member.prId === pr.id)) {
        const contextMember = context.members.find((member) => member.prId === pr.id);
        existing.members.push({
          prId: pr.id,
          laneId: pr.laneId,
          laneName: laneById.get(pr.laneId)?.name ?? pr.laneId,
          position: contextMember?.position ?? existing.members.length,
          pr,
        });
      }
      if (!existing.targetBranch) existing.targetBranch = pr.baseBranch ?? null;
      continue;
    }

    groupMap.set(context.groupId, {
      groupId: context.groupId,
      name: null,
      targetBranch: pr.baseBranch ?? null,
      landingState: args.queueStates[context.groupId] ?? null,
      members: toMembers(context.members),
    });
  }

  return [...groupMap.values()]
    .map((group) => ({
      ...group,
      members: [...group.members].sort((a, b) => a.position - b.position),
    }))
    .sort((a, b) => {
      const aTs = Date.parse(a.landingState?.updatedAt ?? "");
      const bTs = Date.parse(b.landingState?.updatedAt ?? "");
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
      return queueGroupLabel(a).localeCompare(queueGroupLabel(b));
    });
}

function reorderQueueMemberIds(prIds: string[], draggedPrId: string, targetPrId: string): string[] {
  const draggedIndex = prIds.indexOf(draggedPrId);
  const targetIndex = prIds.indexOf(targetPrId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return prIds;
  const next = [...prIds];
  const [moved] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

function providerForModel(modelId: string): "codex" | "claude" {
  const descriptor = getModelById(modelId);
  if (descriptor?.family === "anthropic" || descriptor?.cliCommand === "claude") return "claude";
  return "codex";
}

function MiniBadge({
  label,
  theme,
}: {
  label: string;
  theme: ColorTheme;
}) {
  return (
    <span
      className={BADGE_CLASS}
      style={{
        fontSize: 10,
        color: theme.color,
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        padding: "2px 6px",
      }}
    >
      {label}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className={BADGE_CLASS} style={{ fontSize: 10, color: "#71717A" }}>
      {children}
    </div>
  );
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
  const {
    rebaseNeeds,
    queueStates,
    setActiveTab,
    setSelectedPrId,
    setSelectedRebaseItemId,
    resolverModel,
    resolverReasoningLevel,
    resolverPermissionMode,
    setResolverModel,
    setResolverReasoningLevel,
    setResolverPermissionMode,
  } = usePrs();

  const queueGroups = React.useMemo(
    () => buildQueueGroups({ prs, mergeContextByPrId, lanes, queueStates }),
    [prs, mergeContextByPrId, lanes, queueStates],
  );

  const visibleQueueGroups = React.useMemo(
    () => queueGroups.filter((group) => getQueueWorkflowBucket(group) === workflowView),
    [queueGroups, workflowView],
  );

  React.useEffect(() => {
    if (selectedGroupId && visibleQueueGroups.some((group) => group.groupId === selectedGroupId)) return;
    onSelectGroup(visibleQueueGroups[0]?.groupId ?? null);
  }, [onSelectGroup, selectedGroupId, visibleQueueGroups]);

  const selectedGroup = React.useMemo(
    () => visibleQueueGroups.find((group) => group.groupId === selectedGroupId) ?? null,
    [selectedGroupId, visibleQueueGroups],
  );

  const selection = React.useMemo(() => findQueueMemberSelection(selectedGroup), [selectedGroup]);
  const currentMember = selection.currentMember;
  const currentIndex = selection.currentIndex;
  const nextMember = selection.nextMember;

  const [currentPrStatus, setCurrentPrStatus] = React.useState<PrStatus | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(false);
  const [archiveOnLand, setArchiveOnLand] = React.useState(false);
  const [landBusy, setLandBusy] = React.useState(false);
  const [landResult, setLandResult] = React.useState<LandResult | null>(null);
  const [pageError, setPageError] = React.useState<string | null>(null);
  const [showLandWarnings, setShowLandWarnings] = React.useState(false);
  const [deleteTargetPrId, setDeleteTargetPrId] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteCloseGh, setDeleteCloseGh] = React.useState(false);
  const [draggedPrId, setDraggedPrId] = React.useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = React.useState(false);
  const [rebaseScope, setRebaseScope] = React.useState<QueueRebaseScope>("next");
  const [rebaseBusy, setRebaseBusy] = React.useState<QueueRebaseMode | null>(null);
  const [showAiRebaseControls, setShowAiRebaseControls] = React.useState(false);
  const [rebaseSummary, setRebaseSummary] = React.useState<BatchRebaseSummary | null>(null);
  const [queueActionBusy, setQueueActionBusy] = React.useState<"resume" | "pause" | "cancel" | null>(null);

  React.useEffect(() => {
    setArchiveOnLand(Boolean(selectedGroup?.landingState?.config.archiveLane));
    setShowLandWarnings(false);
    setPageError(null);
    setLandResult(null);
    setRebaseSummary(null);
    setShowAiRebaseControls(false);
    setDeleteTargetPrId(null);
  }, [selectedGroup?.groupId, selectedGroup?.landingState?.config.archiveLane]);

  React.useEffect(() => {
    if (!currentMember?.prId) {
      setCurrentPrStatus(null);
      return;
    }
    let cancelled = false;
    setStatusLoading(true);
    window.ade.prs.getStatus(currentMember.prId)
      .then((status) => {
        if (!cancelled) setCurrentPrStatus(status);
      })
      .catch(() => {
        if (!cancelled) setCurrentPrStatus(null);
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentMember?.prId, selectedGroup?.landingState?.updatedAt]);

  const queueEntryByPrId = React.useMemo(() => {
    const entries = selectedGroup?.landingState?.entries ?? [];
    return new Map(entries.map((entry) => [entry.prId, entry] as const));
  }, [selectedGroup?.landingState?.entries]);

  const visibleRebaseNeeds = React.useMemo(
    () => rebaseNeeds.filter((need) => need.behindBy > 0),
    [rebaseNeeds],
  );
  const rebaseNeedByLaneId = React.useMemo(
    () => new Map(visibleRebaseNeeds.map((need) => [need.laneId, need] as const)),
    [visibleRebaseNeeds],
  );

  const remainingMembers = React.useMemo(() => {
    if (!selectedGroup) return [] as QueueMember[];
    if (currentIndex < 0) return selectedGroup.members;
    return selectedGroup.members.slice(currentIndex);
  }, [currentIndex, selectedGroup]);

  const affectedRebaseMembers = React.useMemo(
    () => remainingMembers.filter((member) => rebaseNeedByLaneId.has(member.laneId)),
    [rebaseNeedByLaneId, remainingMembers],
  );

  const nextAffectedMember = affectedRebaseMembers[0] ?? null;
  const affectedLaneNamesSummary = React.useMemo(
    () => affectedRebaseMembers.map((member) => member.laneName).join(", "),
    [affectedRebaseMembers],
  );
  const rebaseTargets = React.useMemo(() => {
    if (rebaseScope === "all") return affectedRebaseMembers;
    return nextAffectedMember ? [nextAffectedMember] : [];
  }, [affectedRebaseMembers, nextAffectedMember, rebaseScope]);

  const queueStats = React.useMemo(() => {
    if (!selectedGroup) return { landed: 0, pending: 0, failed: 0 };
    let landed = 0;
    let pending = 0;
    let failed = 0;
    for (const member of selectedGroup.members) {
      const entry = queueEntryByPrId.get(member.prId) ?? null;
      if (entry?.state === "landed" || member.pr?.state === "merged") landed += 1;
      else if (entry?.state === "failed" || member.pr?.state === "closed") failed += 1;
      else pending += 1;
    }
    return { landed, pending, failed };
  }, [queueEntryByPrId, selectedGroup]);

  const manualLandWarnings = React.useMemo(
    () => buildManualLandWarnings({ status: currentPrStatus, memberSummary: currentMember?.pr ?? null }),
    [currentMember?.pr, currentPrStatus],
  );

  const mergeability = React.useMemo(
    () => describeMergeability(currentPrStatus, statusLoading),
    [currentPrStatus, statusLoading],
  );

  const queueIsAutomationLocked = selectedGroup?.landingState?.state === "landing" || selectedGroup?.landingState?.state === "paused";

  const openPrView = React.useCallback((prId: string) => {
    setSelectedPrId(prId);
    setActiveTab("normal");
  }, [setActiveTab, setSelectedPrId]);

  const openRebaseTab = React.useCallback((laneId: string) => {
    setSelectedRebaseItemId(laneId);
    setActiveTab("rebase");
  }, [setActiveTab, setSelectedRebaseItemId]);

  const handleLandCurrentPr = React.useCallback(async () => {
    if (!selectedGroup) return;
    setLandBusy(true);
    setPageError(null);
    setLandResult(null);
    try {
      const result = await window.ade.prs.landQueueNext({
        groupId: selectedGroup.groupId,
        method: mergeMethod,
        archiveLane: archiveOnLand,
      });
      setLandResult(result);
      await onRefresh();
    } catch (error) {
      setPageError(formatError(error));
    } finally {
      setLandBusy(false);
    }
  }, [archiveOnLand, mergeMethod, onRefresh, selectedGroup]);

  const handlePrimaryLand = React.useCallback(async () => {
    if (manualLandWarnings.length > 0 && !showLandWarnings) {
      setShowLandWarnings(true);
      return;
    }
    setShowLandWarnings(false);
    await handleLandCurrentPr();
  }, [handleLandCurrentPr, manualLandWarnings.length, showLandWarnings]);

  const runQueueAutomationAction = React.useCallback(async (
    action: "resume" | "pause" | "cancel",
  ) => {
    if (!selectedGroup?.landingState) return;
    setQueueActionBusy(action);
    setPageError(null);
    try {
      if (action === "pause") {
        await window.ade.prs.pauseQueueAutomation(selectedGroup.landingState.queueId);
      } else if (action === "cancel") {
        await window.ade.prs.cancelQueueAutomation(selectedGroup.landingState.queueId);
      } else {
        await window.ade.prs.resumeQueueAutomation({
          queueId: selectedGroup.landingState.queueId,
          method: mergeMethod,
          archiveLane: archiveOnLand,
          autoResolve: Boolean(selectedGroup.landingState.config.autoResolve),
          ciGating: Boolean(selectedGroup.landingState.config.ciGating),
          resolverModel,
          reasoningEffort: resolverReasoningLevel,
          permissionMode: resolverPermissionMode,
        });
      }
      await onRefresh();
    } catch (error) {
      setPageError(formatError(error));
    } finally {
      setQueueActionBusy(null);
    }
  }, [archiveOnLand, mergeMethod, onRefresh, resolverModel, resolverPermissionMode, resolverReasoningLevel, selectedGroup]);

  const handleDeletePr = React.useCallback(async (prId: string) => {
    setDeleteBusy(true);
    setPageError(null);
    try {
      await window.ade.prs.delete({ prId, closeOnGitHub: deleteCloseGh });
      setDeleteTargetPrId(null);
      await onRefresh();
    } catch (error) {
      setPageError(formatError(error));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteCloseGh, onRefresh]);

  /** Entry states that indicate the PR has been removed from `pr_group_members` on the backend. */
  const terminalEntryStates = React.useMemo<Set<QueueLandingEntry["state"]>>(
    () => new Set(["landed", "skipped"]),
    [],
  );

  /** Returns true when a member's queue entry has a terminal state (landed/skipped). */
  const isMemberTerminal = React.useCallback(
    (prId: string): boolean => {
      const entry = queueEntryByPrId.get(prId);
      return entry != null && terminalEntryStates.has(entry.state);
    },
    [queueEntryByPrId, terminalEntryStates],
  );

  const handleDropMember = React.useCallback(async (targetPrId: string) => {
    if (!selectedGroup || !draggedPrId || draggedPrId === targetPrId) {
      setDraggedPrId(null);
      return;
    }
    if (queueIsAutomationLocked) {
      setPageError("Queue order cannot change while landing is active or paused.");
      setDraggedPrId(null);
      return;
    }
    // Reconcile: only include members that are still current on the backend.
    // Landed / skipped PRs are removed from pr_group_members by prService.land(),
    // so sending them to reorderQueuePrs() would cause a rejection.
    const currentMemberPrIds = selectedGroup.members
      .filter((member) => !isMemberTerminal(member.prId))
      .map((member) => member.prId);
    const orderedPrIds = reorderQueueMemberIds(
      currentMemberPrIds,
      draggedPrId,
      targetPrId,
    );
    if (orderedPrIds.join(",") === currentMemberPrIds.join(",")) {
      setDraggedPrId(null);
      return;
    }
    setReorderBusy(true);
    setPageError(null);
    try {
      await window.ade.prs.reorderQueuePrs({ groupId: selectedGroup.groupId, prIds: orderedPrIds });
      await onRefresh();
    } catch (error) {
      setPageError(formatError(error));
    } finally {
      setReorderBusy(false);
      setDraggedPrId(null);
    }
  }, [draggedPrId, isMemberTerminal, onRefresh, queueIsAutomationLocked, selectedGroup]);

  const handleRebase = React.useCallback(async (mode: QueueRebaseMode) => {
    if (rebaseTargets.length === 0) return;
    setRebaseBusy(mode);
    setRebaseSummary(null);
    setPageError(null);
    const results: BatchRebaseItemResult[] = [];
    let stoppedEarly = false;
    let failedLaneId: string | null = null;
    try {
      for (const member of rebaseTargets) {
        const rebaseResult: RebaseResult = await window.ade.rebase.execute({
          laneId: member.laneId,
          aiAssisted: mode === "ai",
          provider: providerForModel(resolverModel),
          modelId: resolverModel,
          reasoningEffort: resolverReasoningLevel,
          permissionMode: resolverPermissionMode,
        });

        if (!rebaseResult.success) {
          results.push({
            laneId: member.laneId,
            laneName: member.laneName,
            success: false,
            pushed: false,
            error: rebaseResult.error ?? "Rebase failed.",
          });
          stoppedEarly = true;
          failedLaneId = member.laneId;
          break;
        }

        let pushed = false;
        let pushError: string | null = null;
        if (mode === "push") {
          try {
            await window.ade.git.push({ laneId: member.laneId, forceWithLease: true });
            pushed = true;
          } catch (error) {
            pushError = formatError(error);
          }
        }

        if (pushError) {
          results.push({
            laneId: member.laneId,
            laneName: member.laneName,
            success: false,
            pushed: false,
            error: pushError,
          });
          stoppedEarly = true;
          failedLaneId = member.laneId;
          break;
        }

        results.push({
          laneId: member.laneId,
          laneName: member.laneName,
          success: true,
          pushed,
          error: null,
        });
      }

      await onRefresh();
      setRebaseSummary({
        mode,
        scope: rebaseScope,
        targetLaneIds: rebaseTargets.map((member) => member.laneId),
        results,
        stoppedEarly,
        failedLaneId,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      setPageError(formatError(error));
    } finally {
      setRebaseBusy(null);
    }
  }, [onRefresh, rebaseScope, rebaseTargets, resolverModel, resolverPermissionMode, resolverReasoningLevel]);

  const paneConfigs: Record<string, PaneConfig> = {
    list: {
      title: "Queues",
      bodyClassName: "overflow-auto",
      children: (
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel>{workflowView === "history" ? "Queue history" : "Active queues"}</SectionLabel>
          {!visibleQueueGroups.length ? (
            <EmptyState
              title={workflowView === "history" ? "No queue history" : "No queues"}
              description={workflowView === "history" ? "Completed or cancelled queue runs will appear here." : "Create a queue to land PRs in a specific order."}
            />
          ) : visibleQueueGroups.map((group) => {
            const isSelected = group.groupId === selectedGroupId;
            const stats = {
              open: group.members.filter((member) => member.pr?.state === "open" || member.pr?.state === "draft").length,
              merged: group.members.filter((member) => member.pr?.state === "merged").length,
            };
            return (
              <button
                key={group.groupId}
                type="button"
                onClick={() => onSelectGroup(group.groupId)}
                className="w-full text-left transition-colors duration-100"
                style={{
                  borderLeft: isSelected ? "3px solid #A78BFA" : "3px solid transparent",
                  border: `1px solid ${isSelected ? "rgba(167,139,250,0.28)" : "#1E1B26"}`,
                  background: isSelected ? "rgba(167,139,250,0.08)" : "#13101A",
                  padding: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#FAFAFA" }}>{queueGroupLabel(group)}</div>
                    <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 4 }}>
                      target {group.targetBranch ?? "main"} · {group.members.length} lanes
                    </div>
                  </div>
                  <MiniBadge
                    label={stats.open > 0 ? `${stats.open} open` : stats.merged > 0 ? `${stats.merged} landed` : "idle"}
                    theme={stats.open > 0 ? THEME_BLUE : stats.merged > 0 ? THEME_GREEN : THEME_MUTED}
                  />
                </div>
              </button>
            );
          })}
        </div>
      ),
    },
    detail: {
      title: selectedGroup ? queueGroupLabel(selectedGroup) : "Queue detail",
      bodyClassName: "overflow-auto",
      children: selectedGroup ? (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
          <div
            style={{
              border: "1px solid #1E1B26",
              background: "#13101A",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#FAFAFA" }}>{queueGroupLabel(selectedGroup)}</div>
                <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 4 }}>
                  target {selectedGroup.targetBranch ?? "main"} · {selectedGroup.members.length} lanes · {queueStats.landed} landed / {queueStats.pending} pending / {queueStats.failed} blocked
                </div>
              </div>
              {selectedGroup.landingState?.state && selectedGroup.landingState.state !== "idle" ? (
                <MiniBadge
                  label={selectedGroup.landingState.state.replace(/_/g, " ")}
                  theme={selectedGroup.landingState.state === "paused" ? THEME_AMBER : selectedGroup.landingState.state === "completed" ? THEME_GREEN : THEME_BLUE}
                />
              ) : null}
            </div>

            <SectionLabel>Queue members</SectionLabel>
            {queueIsAutomationLocked ? (
              <div style={{ fontSize: 11, color: "#A1A1AA", lineHeight: "18px" }}>
                Queue order is locked while the queue run is {selectedGroup.landingState?.state}. Pause or finish the run before reordering lanes.
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "#71717A", lineHeight: "18px" }}>
                Drag the members below to change the landing order. Queue order updates immediately and keeps the remaining queue positions intact.
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {selectedGroup.members.map((member, index) => {
                const queueEntry = queueEntryByPrId.get(member.prId) ?? null;
                const status = describeQueueEntry(queueEntry, member);
                const healthSummary = describePrHealth(member.pr);
                const rebaseNeed = rebaseNeedByLaneId.get(member.laneId) ?? null;
                const memberTerminal = isMemberTerminal(member.prId);
                const dragDisabled = queueIsAutomationLocked || memberTerminal || selectedGroup.members.length <= 1;
                const marker =
                  currentMember?.prId === member.prId
                    ? { label: "Current", theme: THEME_BLUE }
                    : nextMember?.prId === member.prId
                      ? { label: "Next", theme: THEME_MUTED }
                      : null;

                return (
                  <div
                    key={member.prId}
                    draggable={!dragDisabled}
                    onDragStart={() => { if (!memberTerminal) setDraggedPrId(member.prId); }}
                    onDragEnd={() => setDraggedPrId(null)}
                    onDragOver={(event) => {
                      if (!queueIsAutomationLocked && !memberTerminal) event.preventDefault();
                    }}
                    onDrop={() => void handleDropMember(member.prId)}
                    style={{
                      border: `1px solid ${draggedPrId === member.prId ? "rgba(167,139,250,0.35)" : "#27212F"}`,
                      background: draggedPrId === member.prId ? "rgba(167,139,250,0.08)" : "#18141F",
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      opacity: reorderBusy && draggedPrId === member.prId ? 0.6 : memberTerminal ? 0.6 : 1,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
                        <button
                          type="button"
                          disabled={dragDisabled}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: dragDisabled ? "#3F3F46" : "#71717A",
                            padding: 0,
                            cursor: dragDisabled ? "not-allowed" : "grab",
                            marginTop: 2,
                          }}
                          title={queueIsAutomationLocked ? "Queue order is locked while the queue run is active." : memberTerminal ? "This PR has already landed or been skipped." : "Drag to reorder queue lanes"}
                        >
                          <ArrowsDownUp size={14} />
                        </button>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span className="font-mono" style={{ fontSize: 11, color: "#71717A" }}>
                              {pad2(index + 1)}
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#FAFAFA" }}>{member.laneName}</span>
                            <MiniBadge label={status.label} theme={status.theme} />
                            {marker ? <MiniBadge label={marker.label} theme={marker.theme} /> : null}
                            {rebaseNeed ? <MiniBadge label={`${rebaseNeed.behindBy} behind`} theme={THEME_BLUE} /> : null}
                          </div>
                          <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 4 }}>
                            {member.pr?.githubPrNumber != null ? `#${member.pr.githubPrNumber}` : "No PR"} · {member.pr?.title ?? "PR metadata unavailable"}
                          </div>
                          {healthSummary ? (
                            <div style={{ fontSize: 11, color: "#A1A1AA", marginTop: 4, lineHeight: "18px" }}>
                              {healthSummary}
                            </div>
                          ) : null}
                          {rebaseNeed ? (
                            <div style={{ fontSize: 11, color: rebaseNeed.conflictPredicted ? "#FCD34D" : "#93C5FD", marginTop: 4, lineHeight: "18px" }}>
                              Needs rebase against {rebaseNeed.baseBranch}: {rebaseNeed.behindBy} commit{rebaseNeed.behindBy === 1 ? "" : "s"} behind
                              {rebaseNeed.conflictPredicted ? " with conflicts predicted." : "."}
                            </div>
                          ) : null}
                          {queueEntry?.error ? (
                            <div style={{ fontSize: 11, color: "#FCA5A5", marginTop: 4, lineHeight: "18px" }}>
                              {queueEntry.error}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {member.pr ? (
                          <>
                            <button
                              type="button"
                              onClick={() => openPrView(member.prId)}
                              className={BADGE_CLASS}
                              style={{
                                fontSize: 10,
                                background: "transparent",
                                color: "#60A5FA",
                                border: "1px solid rgba(96,165,250,0.24)",
                                padding: "6px 8px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                              }}
                            >
                              <ArrowSquareOut size={12} />
                              Open PR
                            </button>
                            <button
                              type="button"
                              onClick={() => void window.ade.prs.openInGitHub(member.prId)}
                              style={{
                                padding: 6,
                                background: "transparent",
                                border: "1px solid #27212F",
                                color: "#A1A1AA",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                              }}
                              title="Open in GitHub"
                            >
                              <GithubLogo size={12} />
                            </button>
                          </>
                        ) : null}
                        {member.pr?.state !== "merged" ? (
                          <button
                            type="button"
                            disabled={queueIsAutomationLocked}
                            onClick={() => setDeleteTargetPrId(deleteTargetPrId === member.prId ? null : member.prId)}
                            style={{
                              padding: 6,
                              background: "transparent",
                              border: "1px solid #27212F",
                              color: queueIsAutomationLocked ? "#52525B" : deleteTargetPrId === member.prId ? "#FCA5A5" : "#A1A1AA",
                              cursor: queueIsAutomationLocked ? "not-allowed" : "pointer",
                              opacity: queueIsAutomationLocked ? 0.5 : 1,
                              display: "inline-flex",
                              alignItems: "center",
                            }}
                            title={queueIsAutomationLocked ? "Cannot remove while queue automation is active" : "Remove from queue"}
                          >
                            <Trash size={12} />
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {deleteTargetPrId === member.prId ? (
                      <div style={{ border: "1px solid rgba(239,68,68,0.24)", background: "rgba(239,68,68,0.06)", padding: 10 }}>
                        <div className={BADGE_CLASS} style={{ fontSize: 10, color: "#FCA5A5", marginBottom: 8 }}>
                          Remove this PR from the queue?
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#A1A1AA", marginBottom: 10 }}>
                          <input
                            type="checkbox"
                            checked={deleteCloseGh}
                            onChange={(event) => setDeleteCloseGh(event.target.checked)}
                            style={{ accentColor: "#A78BFA" }}
                          />
                          Also close the GitHub PR.
                        </label>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button
                            type="button"
                            disabled={deleteBusy}
                            onClick={() => void handleDeletePr(member.prId)}
                            className={BADGE_CLASS}
                            style={{
                              fontSize: 10,
                              color: "#0F0D14",
                              background: "#FCA5A5",
                              border: "none",
                              padding: "7px 10px",
                              cursor: deleteBusy ? "not-allowed" : "pointer",
                              opacity: deleteBusy ? 0.5 : 1,
                            }}
                          >
                            {deleteBusy ? "Removing..." : "Confirm remove"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTargetPrId(null)}
                            className={BADGE_CLASS}
                            style={{
                              fontSize: 10,
                              color: "#A1A1AA",
                              background: "transparent",
                              border: "1px solid #27212F",
                              padding: "7px 10px",
                              cursor: "pointer",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              border: "1px solid #1E1B26",
              background: "#13101A",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#FAFAFA" }}>Current lane and landing controls</div>
                <div style={{ fontSize: 12, color: "#A1A1AA", marginTop: 4, lineHeight: "18px" }}>
                  Review the current queue lane, rebase follow-up, and landing state before merging the next PR into {selectedGroup.targetBranch ?? "main"}.
                </div>
              </div>
              {currentMember ? (
                <button
                  type="button"
                  onClick={() => openPrView(currentMember.prId)}
                  className={BADGE_CLASS}
                  style={{
                    fontSize: 10,
                    color: "#60A5FA",
                    background: "transparent",
                    border: "1px solid rgba(96,165,250,0.24)",
                    padding: "7px 10px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <ArrowSquareOut size={12} />
                  Open current PR
                </button>
              ) : null}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div style={{ border: "1px solid #27212F", padding: 12, background: "rgba(96,165,250,0.04)" }}>
                <SectionLabel>Current queue lane</SectionLabel>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#FAFAFA", marginTop: 8 }}>
                  {currentMember?.laneName ?? "No active lane"}
                </div>
                <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 6, lineHeight: "18px" }}>
                  {currentMember
                    ? `Step ${pad2(currentIndex + 1)} of ${pad2(selectedGroup.members.length)}`
                    : "All queue members are complete."}
                </div>
                {nextMember ? (
                  <div style={{ fontSize: 11, color: "#A1A1AA", marginTop: 6, lineHeight: "18px" }}>
                    Next up: {nextMember.laneName}
                  </div>
                ) : null}
              </div>

              <div style={{ border: "1px solid #27212F", padding: 12, background: "rgba(34,197,94,0.04)" }}>
                <SectionLabel>Current PR readiness</SectionLabel>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  <MiniBadge label={mergeability.label} theme={mergeability.theme} />
                  {(() => {
                    const checksBadge = getChecksBadge(currentMember?.pr?.checksStatus);
                    return checksBadge ? <MiniBadge label={checksBadge.label} theme={checksBadge.theme} /> : null;
                  })()}
                  {(() => {
                    const reviewBadge = getReviewBadge(currentMember?.pr?.reviewStatus);
                    return reviewBadge ? <MiniBadge label={reviewBadge.label} theme={reviewBadge.theme} /> : null;
                  })()}
                </div>
                {currentMember?.pr ? (
                  <div style={{ fontSize: 12, color: "#A1A1AA", marginTop: 8, lineHeight: "18px" }}>
                    #{currentMember.pr.githubPrNumber ?? "?"} · {currentMember.pr.title}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "#71717A", marginTop: 8 }}>
                    No current PR is available.
                  </div>
                )}
                {currentPrStatus?.behindBaseBy ? (
                  <div style={{ fontSize: 11, color: "#93C5FD", marginTop: 8 }}>
                    GitHub reports this PR is {currentPrStatus.behindBaseBy} commit{currentPrStatus.behindBaseBy === 1 ? "" : "s"} behind its base branch.
                  </div>
                ) : null}
              </div>

              <div style={{ border: "1px solid #27212F", padding: 12, background: "rgba(245,158,11,0.04)" }}>
                <SectionLabel>Land current PR</SectionLabel>
                <div style={{ fontSize: 12, color: "#A1A1AA", marginTop: 8, lineHeight: "18px" }}>
                  Merge the current queue PR when it is ready. ADE will advance the queue after the landing succeeds.
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 11, color: "#A1A1AA" }}>
                  <input
                    type="checkbox"
                    checked={archiveOnLand}
                    onChange={(event) => setArchiveOnLand(event.target.checked)}
                    style={{ accentColor: "#A78BFA" }}
                  />
                  Archive the landed lane afterward.
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={!currentMember || landBusy}
                    onClick={() => void handlePrimaryLand()}
                    className={BADGE_CLASS}
                    style={{
                      fontSize: 10,
                      color: "#0F0D14",
                      background: "#A78BFA",
                      border: "none",
                      padding: "8px 12px",
                      cursor: !currentMember || landBusy ? "not-allowed" : "pointer",
                      opacity: !currentMember || landBusy ? 0.5 : 1,
                    }}
                  >
                    {landBusy ? "Landing..." : "Land current PR"}
                  </button>
                  {selectedGroup.landingState?.state === "landing" ? (
                    <button
                      type="button"
                      disabled={queueActionBusy === "pause"}
                      onClick={() => void runQueueAutomationAction("pause")}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: "#A1A1AA",
                        background: "transparent",
                        border: "1px solid #27212F",
                        padding: "8px 12px",
                        cursor: "pointer",
                      }}
                    >
                      {queueActionBusy === "pause" ? "Pausing..." : "Pause queue"}
                    </button>
                  ) : null}
                  {selectedGroup.landingState?.state === "paused" ? (
                    <button
                      type="button"
                      disabled={queueActionBusy === "resume"}
                      onClick={() => void runQueueAutomationAction("resume")}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: "#0F0D14",
                        background: "#FCD34D",
                        border: "none",
                        padding: "8px 12px",
                        cursor: "pointer",
                      }}
                    >
                      {queueActionBusy === "resume" ? "Resuming..." : "Resume queue"}
                    </button>
                  ) : null}
                  {selectedGroup.landingState?.state === "landing" || selectedGroup.landingState?.state === "paused" ? (
                    <button
                      type="button"
                      disabled={queueActionBusy === "cancel"}
                      onClick={() => void runQueueAutomationAction("cancel")}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: "#FCA5A5",
                        background: "transparent",
                        border: "1px solid rgba(239,68,68,0.24)",
                        padding: "8px 12px",
                        cursor: "pointer",
                      }}
                    >
                      {queueActionBusy === "cancel" ? "Canceling..." : "Cancel queue"}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {showLandWarnings && manualLandWarnings.length > 0 ? (
              <div style={{ border: "1px solid rgba(245,158,11,0.24)", background: "rgba(245,158,11,0.08)", padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Warning size={14} weight="fill" style={{ color: "#F59E0B" }} />
                  <span className={BADGE_CLASS} style={{ fontSize: 10, color: "#F59E0B" }}>
                    Review before landing
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
                  {manualLandWarnings.map((warning) => (
                    <div key={warning} style={{ fontSize: 11, color: "#FDE68A", lineHeight: "18px" }}>
                      {warning}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div
            style={{
              border: "1px solid #1E1B26",
              background: "#13101A",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#FAFAFA" }}>Rebase follow-up</div>
                <div style={{ fontSize: 12, color: "#A1A1AA", marginTop: 4, lineHeight: "18px" }}>
                  {affectedRebaseMembers.length > 0
                    ? `${affectedRebaseMembers.length} queued lane${affectedRebaseMembers.length === 1 ? "" : "s"} need rebasing before the queue is back on a clean base: ${affectedLaneNamesSummary}.`
                    : "No queued lanes currently need a rebase."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const laneId = nextAffectedMember?.laneId ?? currentMember?.laneId ?? null;
                  if (laneId) openRebaseTab(laneId);
                }}
                disabled={!nextAffectedMember && !currentMember}
                className={BADGE_CLASS}
                style={{
                  fontSize: 10,
                  color: "#60A5FA",
                  background: "transparent",
                  border: "1px solid rgba(96,165,250,0.24)",
                  padding: "7px 10px",
                  cursor: !nextAffectedMember && !currentMember ? "not-allowed" : "pointer",
                  opacity: !nextAffectedMember && !currentMember ? 0.5 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <GitBranch size={12} />
                Open rebase tab
              </button>
            </div>

            {affectedRebaseMembers.length > 0 ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {affectedRebaseMembers.map((member) => {
                    const need = rebaseNeedByLaneId.get(member.laneId)!;
                    return (
                      <div
                        key={member.laneId}
                        style={{
                          border: "1px solid #27212F",
                          background: "#18141F",
                          padding: 12,
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 12,
                        }}
                      >
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#FAFAFA" }}>{member.laneName}</span>
                            <MiniBadge label={`${need.behindBy} behind ${need.baseBranch}`} theme={THEME_BLUE} />
                            {need.conflictPredicted ? <MiniBadge label="Conflicts predicted" theme={THEME_AMBER} /> : null}
                          </div>
                          <div className="font-mono" style={{ fontSize: 11, color: "#71717A", marginTop: 4 }}>
                            Position {pad2(member.position + 1)} · {member.pr?.title ?? "PR metadata unavailable"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => openRebaseTab(member.laneId)}
                          className={BADGE_CLASS}
                          style={{
                            fontSize: 10,
                            color: "#A1A1AA",
                            background: "transparent",
                            border: "1px solid #27212F",
                            padding: "7px 10px",
                            cursor: "pointer",
                          }}
                        >
                          Inspect
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div style={{ border: "1px solid #27212F", background: "#18141F", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <SectionLabel>Scope</SectionLabel>
                    <button
                      type="button"
                      onClick={() => setRebaseScope("next")}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: rebaseScope === "next" ? "#0F0D14" : "#A1A1AA",
                        background: rebaseScope === "next" ? "#A78BFA" : "transparent",
                        border: `1px solid ${rebaseScope === "next" ? "#A78BFA" : "#27212F"}`,
                        padding: "6px 8px",
                        cursor: "pointer",
                      }}
                    >
                      Next lane only
                    </button>
                    <button
                      type="button"
                      onClick={() => setRebaseScope("all")}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: rebaseScope === "all" ? "#0F0D14" : "#A1A1AA",
                        background: rebaseScope === "all" ? "#A78BFA" : "transparent",
                        border: `1px solid ${rebaseScope === "all" ? "#A78BFA" : "#27212F"}`,
                        padding: "6px 8px",
                        cursor: "pointer",
                      }}
                    >
                      All affected lanes
                    </button>
                    <span style={{ fontSize: 11, color: "#71717A" }}>
                      {rebaseTargets.length === 0
                        ? "No target lanes selected."
                        : rebaseTargets.map((member) => member.laneName).join(", ")}
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      disabled={rebaseTargets.length === 0 || Boolean(rebaseBusy)}
                      onClick={() => setShowAiRebaseControls((value) => !value)}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: showAiRebaseControls ? "#0F0D14" : "#A78BFA",
                        background: showAiRebaseControls ? "#A78BFA" : "transparent",
                        border: `1px solid ${showAiRebaseControls ? "#A78BFA" : "rgba(167,139,250,0.24)"}`,
                        padding: "8px 12px",
                        cursor: rebaseTargets.length === 0 || rebaseBusy ? "not-allowed" : "pointer",
                        opacity: rebaseTargets.length === 0 || rebaseBusy ? 0.5 : 1,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {rebaseBusy === "ai" ? <CircleNotch size={12} className="animate-spin" /> : <Sparkle size={12} />}
                      Rebase with AI
                    </button>
                    <button
                      type="button"
                      disabled={rebaseTargets.length === 0 || Boolean(rebaseBusy)}
                      onClick={() => {
                        setShowAiRebaseControls(false);
                        void handleRebase("local");
                      }}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: "#60A5FA",
                        background: "transparent",
                        border: "1px solid rgba(96,165,250,0.24)",
                        padding: "8px 12px",
                        cursor: rebaseTargets.length === 0 || rebaseBusy ? "not-allowed" : "pointer",
                        opacity: rebaseTargets.length === 0 || rebaseBusy ? 0.5 : 1,
                      }}
                    >
                      {rebaseBusy === "local" ? "Rebasing..." : "Rebase now (local only)"}
                    </button>
                    <button
                      type="button"
                      disabled={rebaseTargets.length === 0 || Boolean(rebaseBusy)}
                      onClick={() => {
                        setShowAiRebaseControls(false);
                        void handleRebase("push");
                      }}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: "#34D399",
                        background: "transparent",
                        border: "1px solid rgba(52,211,153,0.24)",
                        padding: "8px 12px",
                        cursor: rebaseTargets.length === 0 || rebaseBusy ? "not-allowed" : "pointer",
                        opacity: rebaseTargets.length === 0 || rebaseBusy ? 0.5 : 1,
                      }}
                    >
                      {rebaseBusy === "push" ? "Rebasing + pushing..." : "Rebase and push"}
                    </button>
                  </div>

                  {showAiRebaseControls ? (
                    <div
                      style={{
                        border: "1px solid rgba(167,139,250,0.24)",
                        background: "rgba(167,139,250,0.08)",
                        padding: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                      }}
                    >
                      <div>
                        <div className={BADGE_CLASS} style={{ fontSize: 10, color: "#C4B5FD" }}>
                          AI rebase settings
                        </div>
                        <div style={{ fontSize: 11, color: "#D4D4D8", marginTop: 6, lineHeight: "18px" }}>
                          Choose the model and permissions for the queue AI rebase, then start the run for the selected scope.
                        </div>
                      </div>

                      <PrResolverLaunchControls
                        modelId={resolverModel}
                        reasoningEffort={resolverReasoningLevel}
                        permissionMode={resolverPermissionMode}
                        onModelChange={setResolverModel}
                        onReasoningEffortChange={(value) => setResolverReasoningLevel(value || "medium")}
                        onPermissionModeChange={(mode) => setResolverPermissionMode(mode)}
                        disabled={Boolean(rebaseBusy)}
                      />

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          disabled={rebaseTargets.length === 0 || Boolean(rebaseBusy)}
                          onClick={() => void handleRebase("ai")}
                          className={BADGE_CLASS}
                          style={{
                            fontSize: 10,
                            color: "#0F0D14",
                            background: "#A78BFA",
                            border: "none",
                            padding: "8px 12px",
                            cursor: rebaseTargets.length === 0 || rebaseBusy ? "not-allowed" : "pointer",
                            opacity: rebaseTargets.length === 0 || rebaseBusy ? 0.5 : 1,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {rebaseBusy === "ai" ? <CircleNotch size={12} className="animate-spin" /> : <Sparkle size={12} />}
                          Start AI rebase
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(rebaseBusy)}
                          onClick={() => setShowAiRebaseControls(false)}
                          className={BADGE_CLASS}
                          style={{
                            fontSize: 10,
                            color: "#A1A1AA",
                            background: "transparent",
                            border: "1px solid #27212F",
                            padding: "8px 12px",
                            cursor: rebaseBusy ? "not-allowed" : "pointer",
                            opacity: rebaseBusy ? 0.5 : 1,
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div style={{ fontSize: 11, color: "#71717A", lineHeight: "18px" }}>
                    Batch rebases stop at the first failure so the queue does not quietly drift. Use the Rebase tab for detailed lane history, aborts, rollbacks, and any follow-up after a partial run.
                  </div>
                </div>
              </>
            ) : null}

            {rebaseSummary ? (
              <div
                style={{
                  border: `1px solid ${rebaseSummary.failedLaneId ? "rgba(245,158,11,0.24)" : "rgba(34,197,94,0.24)"}`,
                  background: rebaseSummary.failedLaneId ? "rgba(245,158,11,0.08)" : "rgba(34,197,94,0.06)",
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {rebaseSummary.failedLaneId ? (
                    <Warning size={14} weight="fill" style={{ color: "#F59E0B" }} />
                  ) : (
                    <CheckCircle size={14} weight="fill" style={{ color: "#22C55E" }} />
                  )}
                  <span className={BADGE_CLASS} style={{ fontSize: 10, color: rebaseSummary.failedLaneId ? "#F59E0B" : "#22C55E" }}>
                    {rebaseSummary.failedLaneId ? "Queue rebase stopped early" : "Queue rebase finished"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#FAFAFA", lineHeight: "18px" }}>
                  {rebaseSummary.failedLaneId
                    ? `ADE rebased ${rebaseSummary.results.filter((result) => result.success).length} lane(s) and stopped on ${rebaseSummary.results.find((result) => result.laneId === rebaseSummary.failedLaneId)?.laneName ?? rebaseSummary.failedLaneId}.`
                    : `ADE finished ${rebaseSummary.mode === "push" ? "rebase and push" : rebaseSummary.mode === "ai" ? "AI rebase" : "local rebase"} for ${rebaseSummary.results.length} lane(s).`}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {rebaseSummary.results.map((result) => (
                    <div key={result.laneId} className="font-mono" style={{ fontSize: 11, color: result.success ? "#BBF7D0" : "#FED7AA", lineHeight: "18px" }}>
                      {result.success ? "✓" : "!"} {result.laneName}
                      {result.success && result.pushed ? " — rebased and pushed" : result.success ? " — rebased locally" : ` — ${result.error ?? "failed"}`}
                    </div>
                  ))}
                </div>
                {rebaseSummary.failedLaneId ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => openRebaseTab(rebaseSummary.failedLaneId!)}
                      className={BADGE_CLASS}
                      style={{
                        fontSize: 10,
                        color: "#60A5FA",
                        background: "transparent",
                        border: "1px solid rgba(96,165,250,0.24)",
                        padding: "7px 10px",
                        cursor: "pointer",
                      }}
                    >
                      Open failed lane in rebase tab
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {pageError ? (
            <div style={{ border: "1px solid rgba(239,68,68,0.24)", background: "rgba(239,68,68,0.08)", padding: 12, color: "#FCA5A5", fontSize: 12 }}>
              {pageError}
            </div>
          ) : null}

          {landResult ? (
            <div
              style={{
                border: `1px solid ${landResult.success ? "rgba(34,197,94,0.24)" : "rgba(239,68,68,0.24)"}`,
                background: landResult.success ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.08)",
                padding: 12,
                fontSize: 12,
                color: landResult.success ? "#BBF7D0" : "#FCA5A5",
              }}
            >
              {landResult.success ? `Landed PR #${landResult.prNumber}. Queue state has been refreshed.` : `Landing failed: ${landResult.error ?? "unknown error"}`}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState title="No queue selected" description="Choose a queue from the left to manage landing order, rebase follow-up, and current PR readiness." />
        </div>
      ),
    },
  };

  return (
    <PaneTilingLayout
      layoutId="prs:queue:v1"
      tree={PR_TAB_TILING_TREE}
      panes={paneConfigs}
      className="flex-1 min-h-0"
    />
  );
}
