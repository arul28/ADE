import React from "react";
import { ArrowsDownUp, Clock, CheckCircle, Warning, Sparkle, Eye, XCircle, GitCommit, FileText, CaretDown, CaretRight, ArrowRight, CircleNotch } from "@phosphor-icons/react";
import type { AiPermissionMode, GitCommitSummary, LaneSummary, RebaseNeed, RebaseRun, RebaseScope } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig } from "../../ui/PaneTilingLayout";
import { UrgencyGroup } from "../shared/UrgencyGroup";
import { branchNameFromRef, resolveLaneBaseBranch } from "../shared/laneBranchTargets";
import { StatusDot } from "../shared/StatusDot";
import { PR_TAB_TILING_TREE } from "../shared/tilingConstants";
import { PrResolverLaunchControls } from "../shared/PrResolverLaunchControls";
import { formatTimeAgo } from "../shared/prFormatters";

type RebaseTabProps = {
  rebaseNeeds: RebaseNeed[];
  lanes: LaneSummary[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  resolverModel: string;
  resolverReasoningLevel: string;
  resolverPermissionMode: AiPermissionMode;
  onResolverChange: (model: string, level: string) => void;
  onResolverPermissionChange: (mode: AiPermissionMode) => void;
  onRefresh: () => Promise<void>;
  onNavigate: (path: string) => void;
};

type RebaseSectionKey = "lane_base" | "pr_target";

function rebaseNeedKey(need: RebaseNeed): string {
  return `${need.laneId}:${need.prId ?? "base"}:${need.baseBranch}`;
}

function rebaseRunKey(args: { laneId: string; baseBranch?: string | null }): string {
  return `${args.laneId}:${branchNameFromRef(args.baseBranch)}`;
}

/* ── inline style constants ── */
const S = {
  mainBg: "#0F0D14",
  cardBg: "#13101A",
  headerBg: "#0C0A10",
  borderDefault: "#1E1B26",
  borderSubtle: "#27272A",
  textPrimary: "#FAFAFA",
  textSecondary: "#A1A1AA",
  textMuted: "#71717A",
  textDisabled: "#52525B",
  accent: "#A78BFA",
  accentSubtleBg: "#A78BFA18",
  accentBorder: "#A78BFA30",
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
  info: "#3B82F6",
} as const;

export function RebaseTab({
  rebaseNeeds,
  lanes,
  selectedItemId,
  onSelectItem,
  resolverModel,
  resolverReasoningLevel,
  resolverPermissionMode,
  onResolverChange,
  onResolverPermissionChange,
  onRefresh,
  onNavigate,
}: RebaseTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [rebaseBusy, setRebaseBusy] = React.useState(false);
  const [rebaseError, setRebaseError] = React.useState<string | null>(null);
  const [resolverLaunching, setResolverLaunching] = React.useState(false);
  const [resolverExpanded, setResolverExpanded] = React.useState(false);
  const [forcePushAfterRebase, setForcePushAfterRebase] = React.useState(true);
  const [runScope, setRunScope] = React.useState<RebaseScope>("lane_only");
  const [activeRun, setActiveRun] = React.useState<RebaseRun | null>(null);
  const [runLogs, setRunLogs] = React.useState<string[]>([]);
  const [selectedPushLaneIds, setSelectedPushLaneIds] = React.useState<string[]>([]);
  const activeRunIdRef = React.useRef<string | null>(null);

  const refreshRebaseNeeds = React.useCallback(async () => {
    try {
      await window.ade.rebase.scanNeeds();
    } catch {
      /* best effort */
    }
  }, []);

  // Drift commits state
  const [driftCommits, setDriftCommits] = React.useState<GitCommitSummary[]>([]);
  const [driftCommitsLoading, setDriftCommitsLoading] = React.useState(false);
  const [driftCommitsExpanded, setDriftCommitsExpanded] = React.useState(true);
  const [commitFilesMap, setCommitFilesMap] = React.useState<Record<string, string[]>>({});
  const [expandedCommitSha, setExpandedCommitSha] = React.useState<string | null>(null);

  const [collapsed, setCollapsed] = React.useState<Record<RebaseSectionKey, boolean>>({
    lane_base: false,
    pr_target: false,
  });

  const getLaneBaseBranch = React.useCallback((laneId: string): string => {
    const lane = laneById.get(laneId) ?? null;
    return resolveLaneBaseBranch({
      lane,
      lanes,
      primaryBranchRef: null,
    });
  }, [laneById, lanes]);

  const isPrTargetNeed = React.useCallback((need: RebaseNeed): boolean => {
    if (!need.prId) return false;
    const laneBaseBranch = branchNameFromRef(getLaneBaseBranch(need.laneId));
    return laneBaseBranch.length > 0 && laneBaseBranch !== branchNameFromRef(need.baseBranch);
  }, [getLaneBaseBranch]);

  const grouped = React.useMemo(() => {
    const groups: Record<RebaseSectionKey, RebaseNeed[]> = {
      lane_base: [],
      pr_target: [],
    };
    for (const need of rebaseNeeds) {
      groups[isPrTargetNeed(need) ? "pr_target" : "lane_base"].push(need);
    }
    groups.lane_base.sort((a, b) => b.behindBy - a.behindBy);
    groups.pr_target.sort((a, b) => b.behindBy - a.behindBy);
    return groups;
  }, [isPrTargetNeed, rebaseNeeds]);

  const selectedNeed = React.useMemo(() => {
    if (!selectedItemId) return null;
    return rebaseNeeds.find((need) => rebaseNeedKey(need) === selectedItemId) ?? null;
  }, [rebaseNeeds, selectedItemId]);

  const selectedNeedRunKey = React.useMemo(
    () => (selectedNeed ? rebaseRunKey({ laneId: selectedNeed.laneId, baseBranch: selectedNeed.baseBranch }) : null),
    [selectedNeed],
  );

  const selectedLane = React.useMemo(
    () => (selectedNeed ? laneById.get(selectedNeed.laneId) ?? null : null),
    [selectedNeed, laneById],
  );

  const hasChildren = (selectedLane?.childCount ?? 0) > 0;
  const selectedNeedIsPrTarget = React.useMemo(
    () => (selectedNeed ? isPrTargetNeed(selectedNeed) : false),
    [isPrTargetNeed, selectedNeed],
  );

  const activeRunKeyRef = React.useRef<string | null>(null);

  // Auto-default scope based on children
  React.useEffect(() => {
    if (!hasChildren && runScope === "lane_and_descendants") {
      setRunScope("lane_only");
    }
  }, [hasChildren, runScope]);

  React.useEffect(() => {
    if (!activeRun) {
      setSelectedPushLaneIds([]);
      return;
    }
    const pushable = activeRun.lanes
      .filter((lane) => lane.status === "succeeded" && !activeRun.pushedLaneIds.includes(lane.laneId))
      .map((lane) => lane.laneId);
    setSelectedPushLaneIds((prev) => {
      const kept = prev.filter((laneId) => pushable.includes(laneId));
      if (kept.length > 0) return kept;
      return pushable;
    });
  }, [activeRun]);

  // Auto-select first item in highest-urgency group
  React.useEffect(() => {
    if (rebaseNeeds.length === 0 && selectedItemId === null) return;
    if (selectedItemId && rebaseNeeds.some((need) => rebaseNeedKey(need) === selectedItemId)) return;
    const first = grouped.lane_base[0] ?? grouped.pr_target[0];
    onSelectItem(first ? rebaseNeedKey(first) : null);
  }, [rebaseNeeds, selectedItemId, grouped, onSelectItem]);

  React.useEffect(() => {
    setRebaseError(null);
  }, [selectedItemId]);

  React.useEffect(() => {
    activeRunIdRef.current = activeRun?.runId ?? null;
    activeRunKeyRef.current = activeRun
      ? rebaseRunKey({ laneId: activeRun.rootLaneId, baseBranch: activeRun.baseBranch })
      : null;
  }, [activeRun]);

  // Subscribe to rebase events
  React.useEffect(() => {
    const unsubscribe = window.ade.lanes.rebaseSubscribe((event) => {
      if (event.type === "rebase-run-updated") {
        const incomingRunKey = rebaseRunKey({
          laneId: event.run.rootLaneId,
          baseBranch: event.run.baseBranch,
        });
        setActiveRun((prev) => {
          if (prev?.runId) {
            if (event.run.runId !== prev.runId) return prev;
            activeRunKeyRef.current = incomingRunKey;
            return event.run;
          }
          if (!selectedNeedRunKey || incomingRunKey !== selectedNeedRunKey) return prev;
          activeRunKeyRef.current = incomingRunKey;
          return event.run;
        });
        if (event.run.state !== "running") {
          void refreshRebaseNeeds();
        }
      } else if (event.type === "rebase-run-log") {
        setRunLogs((prev) => {
          const activeRunId = activeRunIdRef.current;
          if (!activeRunId || event.runId !== activeRunId) return prev;
          const line = `[${new Date(event.timestamp).toLocaleTimeString()}] ${event.message}`;
          const next = [...prev, line];
          return next.slice(-80);
        });
      }
    });
    return unsubscribe;
  }, [refreshRebaseNeeds, selectedNeedRunKey]);

  // Fetch drift commits when selected need changes
  const driftSourceLaneId = React.useMemo(() => {
    if (!selectedNeed || selectedNeed.behindBy === 0) return null;
    if (selectedNeedIsPrTarget) {
      const baseBranch = branchNameFromRef(selectedNeed.baseBranch);
      if (!baseBranch) return null;
      return lanes.find((lane) => branchNameFromRef(lane.branchRef) === baseBranch)?.id ?? null;
    }
    return selectedLane?.parentLaneId ? (laneById.get(selectedLane.parentLaneId)?.id ?? null) : null;
  }, [laneById, lanes, selectedLane?.parentLaneId, selectedNeed, selectedNeedIsPrTarget]);

  React.useEffect(() => {
    if (!selectedNeed || selectedNeed.behindBy === 0) {
      setDriftCommits([]);
      setCommitFilesMap({});
      setExpandedCommitSha(null);
      return;
    }

    if (selectedNeedIsPrTarget && !driftSourceLaneId) {
      setDriftCommits([]);
      setCommitFilesMap({});
      setExpandedCommitSha(null);
      return;
    }

    if (!driftSourceLaneId) {
      setDriftCommits([]);
      setCommitFilesMap({});
      setExpandedCommitSha(null);
      return;
    }

    let cancelled = false;
    setDriftCommitsLoading(true);
    window.ade.git.listRecentCommits({ laneId: driftSourceLaneId, limit: selectedNeed.behindBy })
      .then((commits) => {
        if (!cancelled) setDriftCommits(commits);
      })
      .catch(() => {
        if (!cancelled) setDriftCommits([]);
      })
      .finally(() => {
        if (!cancelled) setDriftCommitsLoading(false);
      });

    return () => { cancelled = true; };
  }, [driftSourceLaneId, selectedNeed?.behindBy, selectedNeed?.laneId, selectedNeedIsPrTarget]);

  // Load files for expanded commit
  const parentLaneId = driftSourceLaneId;
  React.useEffect(() => {
    if (!expandedCommitSha || commitFilesMap[expandedCommitSha] || !parentLaneId) return;
    window.ade.git.listCommitFiles({ laneId: parentLaneId, commitSha: expandedCommitSha })
      .then((files) => {
        setCommitFilesMap((prev) => ({ ...prev, [expandedCommitSha]: files }));
      })
      .catch(() => {
        setCommitFilesMap((prev) => ({ ...prev, [expandedCommitSha]: [] }));
      });
  }, [expandedCommitSha, commitFilesMap, parentLaneId]);

  const handleRebase = async (aiAssisted: boolean, pushMode: "none" | "review_then_push" = "none") => {
    if (!selectedNeed) return;
    setRebaseError(null);
    const requestedNeedRunKey = selectedNeedRunKey;

    if (selectedNeedIsPrTarget && selectedLane?.parentLaneId) {
      setRebaseError("PR-target rebases are only supported for lanes that are already detached from a parent lane.");
      return;
    }

    if (aiAssisted) {
      if (selectedNeedIsPrTarget) {
        setRebaseError("AI-assisted rebase currently only supports lane-base rebases.");
        return;
      }
      setResolverLaunching(true);
      try {
        const result = await window.ade.prs.rebaseResolutionStart({
          laneId: selectedNeed.laneId,
          modelId: resolverModel,
          reasoning: resolverReasoningLevel || null,
          permissionMode: resolverPermissionMode,
          forcePushAfterRebase,
        });
        onNavigate(result.href);
      } catch (err: unknown) {
        setRebaseError(err instanceof Error ? err.message : String(err));
      } finally {
        setResolverLaunching(false);
      }
      return;
    }

    setRebaseBusy(true);
    try {
      const started = await window.ade.lanes.rebaseStart({
        laneId: selectedNeed.laneId,
        scope: runScope,
        pushMode,
        actor: "user",
        ...(selectedNeedIsPrTarget ? { baseBranchOverride: selectedNeed.baseBranch } : {}),
      });
      activeRunKeyRef.current = requestedNeedRunKey;
      setActiveRun(started.run);
      setRunLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Started run ${started.runId}`].slice(-80));
      const pushable = started.run.lanes.filter((lane) => lane.status === "succeeded").map((lane) => lane.laneId);
      setSelectedPushLaneIds(pushable);
      if (started.run.state === "failed") {
        setRebaseError(started.run.error ?? "Rebase run failed.");
      } else if (pushMode === "review_then_push" && pushable.length > 0) {
        // Auto-push all succeeded lanes when "Rebase and Push" was clicked
        setRunLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Auto-pushing ${pushable.length} lane(s)...`].slice(-80));
        const pushed = await window.ade.lanes.rebasePush({ runId: started.runId, laneIds: pushable });
        setActiveRun(pushed);
        setRunLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] Push complete`].slice(-80));
      }
      await refreshRebaseNeeds();
      await onRefresh();
    } catch (err: unknown) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy(false);
    }
  };
  const activeRunMatchesSelectedNeed = Boolean(
    activeRun
      && selectedNeedRunKey
      && activeRunKeyRef.current === selectedNeedRunKey,
  );
  const activeRunForSelectedNeed = activeRunMatchesSelectedNeed ? activeRun : null;
  const selectedRunIsActive = activeRunMatchesSelectedNeed && activeRun?.state === "running";
  const selectedRunLane = React.useMemo(
    () => (activeRunMatchesSelectedNeed && selectedNeed ? activeRun?.lanes.find((lane) => lane.laneId === selectedNeed.laneId) ?? null : null),
    [activeRun, activeRunMatchesSelectedNeed, selectedNeed],
  );
  const selectedNeedResolvedByRun = Boolean(
    selectedRunLane
      && activeRunMatchesSelectedNeed
      && activeRun?.state === "completed"
      && (selectedRunLane.status === "succeeded" || selectedRunLane.status === "skipped"),
  );

  const handleAbortRun = async () => {
    if (!activeRun) return;
    setRebaseBusy(true);
    setRebaseError(null);
    try {
      const next = await window.ade.lanes.rebaseAbort({ runId: activeRun.runId });
      setActiveRun(next);
      await refreshRebaseNeeds();
      await onRefresh();
    } catch (err: unknown) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy(false);
    }
  };

  const handleRollbackRun = async () => {
    if (!activeRun) return;
    setRebaseBusy(true);
    setRebaseError(null);
    try {
      const next = await window.ade.lanes.rebaseRollback({ runId: activeRun.runId });
      setActiveRun(next);
      await refreshRebaseNeeds();
      await onRefresh();
    } catch (err: unknown) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy(false);
    }
  };

  const handlePushSelected = async () => {
    if (!activeRun || selectedPushLaneIds.length === 0) return;
    setRebaseBusy(true);
    setRebaseError(null);
    try {
      const next = await window.ade.lanes.rebasePush({ runId: activeRun.runId, laneIds: selectedPushLaneIds });
      setActiveRun(next);
      await refreshRebaseNeeds();
      await onRefresh();
    } catch (err: unknown) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (!selectedNeed) return;
    try {
      await window.ade.rebase.dismiss(selectedNeed.laneId);
      await onRefresh();
    } catch {
      /* swallow */
    }
  };

  const handleDefer = async () => {
    if (!selectedNeed) return;
    const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    try {
      await window.ade.rebase.defer(selectedNeed.laneId, until);
      await onRefresh();
    } catch {
      /* swallow */
    }
  };

  const renderNeedItem = (need: RebaseNeed) => {
    const itemKey = rebaseNeedKey(need);
    const isSelected = itemKey === selectedItemId;
    const laneName = laneById.get(need.laneId)?.name ?? need.laneId;
    const kindLabel = isPrTargetNeed(need) ? "PR TARGET" : "LANE BASE";
    return (
      <button
        key={itemKey}
        type="button"
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs transition-colors duration-100",
        )}
        style={{
          borderRadius: 0,
          borderLeft: isSelected ? `3px solid ${S.accent}` : "3px solid transparent",
          backgroundColor: isSelected ? "#A78BFA12" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.backgroundColor = "#13101A66";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
        }}
        onClick={() => onSelectItem(itemKey)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot
            color={need.conflictPredicted ? S.warning : need.behindBy > 0 ? S.info : S.success}
            pulse={need.conflictPredicted}
          />
          <div className="min-w-0">
            <div className="font-mono font-bold truncate" style={{ fontSize: 11, color: S.textPrimary }}>
              {laneName}
            </div>
            <div className="font-mono truncate" style={{ fontSize: 10, color: S.textMuted }}>
              {kindLabel} · {need.baseBranch}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {need.behindBy > 0 && (
            <span
              className="font-mono font-bold uppercase"
              style={{
                fontSize: 10,
                letterSpacing: "1px",
                color: S.info,
                backgroundColor: "#3B82F618",
                border: "1px solid #3B82F630",
                padding: "2px 6px",
                borderRadius: 0,
              }}
            >
              {need.behindBy} BEHIND
            </span>
          )}
          {need.conflictPredicted && (
            <span
              className="font-mono font-bold uppercase"
              style={{
                fontSize: 10,
                letterSpacing: "1px",
                color: S.warning,
                backgroundColor: "#F59E0B18",
                border: "1px solid #F59E0B30",
                padding: "2px 6px",
                borderRadius: 0,
              }}
            >
              CONFLICTS
            </span>
          )}
        </div>
      </button>
    );
  };

  const urgencyGroups: Array<{ key: RebaseSectionKey; title: string; color: string; icon: typeof Warning }> = [
    { key: "lane_base", title: "Rebase Against Lane Base", color: S.info, icon: ArrowsDownUp },
    { key: "pr_target", title: "Rebase Against PR Target", color: S.warning, icon: Warning },
  ];

  const resolverTargetLaneId = React.useMemo(() => {
    if (!selectedNeed) return null;
    const baseBranch = branchNameFromRef(selectedNeed.baseBranch);
    if (!baseBranch) return null;
    return lanes.find((lane) => branchNameFromRef(lane.branchRef) === baseBranch)?.id ?? null;
  }, [lanes, selectedNeed]);

  const shouldRenderDriftPanel = !selectedNeedIsPrTarget || Boolean(driftSourceLaneId);

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(
    () => ({
      list: {
        title: "Rebase Status",
        icon: ArrowsDownUp,
        bodyClassName: "overflow-auto",
        children: (
          <div style={{ backgroundColor: S.mainBg }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: `1px solid ${S.borderDefault}`,
              }}
            >
              <span
                className="font-mono font-bold uppercase"
                style={{
                  fontSize: 10,
                  letterSpacing: "1px",
                  color: S.textSecondary,
                }}
              >
                REBASE / DRIFT STATE
              </span>
            </div>

            {rebaseNeeds.length === 0 ? (
              <div style={{ padding: 16 }}>
                <EmptyState
                  title="All lanes up to date"
                  description="No lanes need rebasing against their lane base or an open PR target."
                />
              </div>
            ) : (
              <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                {urgencyGroups
                  .filter((g) => grouped[g.key].length > 0)
                  .map((g) => (
                    <UrgencyGroup
                      key={g.key}
                      title={g.title}
                      count={grouped[g.key].length}
                      color={g.color}
                      collapsed={collapsed[g.key]}
                      onToggle={() => setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                    >
                      <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                        {grouped[g.key].map(renderNeedItem)}
                      </div>
                    </UrgencyGroup>
                  ))}
              </div>
            )}
          </div>
        ),
      },
      detail: {
        title: selectedNeed
          ? `Rebase: ${laneById.get(selectedNeed.laneId)?.name ?? selectedNeed.laneId}`
          : "Rebase Detail",
        icon: Eye,
        bodyClassName: "overflow-auto",
        children: selectedNeed ? (
          <div style={{ backgroundColor: S.mainBg, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            {/* ── Header Card ── */}
            <div
              style={{
                backgroundColor: S.cardBg,
                border: `1px solid ${S.borderDefault}`,
                padding: "16px 20px",
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div
                    className="font-bold"
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 18,
                      color: S.textPrimary,
                    }}
                  >
                    {laneById.get(selectedNeed.laneId)?.name ?? selectedNeed.laneId}
                  </div>
                  <div className="flex items-center gap-3" style={{ marginTop: 6 }}>
                    <span
                      className="font-mono"
                      style={{ fontSize: 11, color: S.textMuted }}
                    >
                      {selectedNeedIsPrTarget ? "PR target" : "base"}: {selectedNeed.baseBranch}
                    </span>
                    {selectedNeed.prId && (
                      <span
                        className="font-mono font-bold uppercase"
                        style={{
                          fontSize: 10,
                          letterSpacing: "1px",
                          color: S.info,
                          backgroundColor: "#3B82F618",
                          border: "1px solid #3B82F630",
                          padding: "2px 6px",
                        }}
                      >
                        PR LINKED
                      </span>
                    )}
                    {hasChildren && (
                      <span
                        className="font-mono"
                        style={{ fontSize: 10, color: S.textMuted }}
                      >
                        {selectedLane?.childCount} child lane{(selectedLane?.childCount ?? 0) !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {selectedNeedIsPrTarget ? (
              <div
                style={{
                  backgroundColor: S.headerBg,
                  padding: "8px 12px",
                  fontSize: 11,
                  color: S.textMuted,
                  marginTop: -4,
                }}
              >
                Rebasing from this section will move the lane&apos;s stored base branch onto {selectedNeed.baseBranch} after the rebase succeeds.
              </div>
            ) : null}

            {shouldRenderDriftPanel ? (
              <>
                {/* ── Drift Analysis Card ── */}
                <div
                  style={{
                    backgroundColor: S.cardBg,
                    border: `1px solid ${S.borderDefault}`,
                    padding: 20,
                  }}
                >
                  <div
                    className="font-mono font-bold uppercase"
                    style={{
                      fontSize: 10,
                      letterSpacing: "1px",
                      color: S.textSecondary,
                      marginBottom: 14,
                    }}
                  >
                    DRIFT ANALYSIS
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
                    {/* Behind By */}
                    <div style={{ backgroundColor: S.headerBg, padding: 12 }}>
                      <div
                        className="font-mono font-bold uppercase"
                        style={{ fontSize: 10, letterSpacing: "1px", color: S.textMuted, marginBottom: 6 }}
                      >
                        BEHIND BY
                      </div>
                      <div
                        className="font-mono font-bold"
                        style={{
                          fontSize: 20,
                          color: selectedNeed.behindBy > 5 ? S.warning : selectedNeed.behindBy > 0 ? S.info : S.success,
                        }}
                      >
                        {selectedNeed.behindBy}
                        <span
                          className="font-mono"
                          style={{ fontSize: 11, color: S.textMuted, marginLeft: 4, fontWeight: 400 }}
                        >
                          commit{selectedNeed.behindBy !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>

                    {/* Conflict Status */}
                    <div style={{ backgroundColor: S.headerBg, padding: 12 }}>
                      <div
                        className="font-mono font-bold uppercase"
                        style={{ fontSize: 10, letterSpacing: "1px", color: S.textMuted, marginBottom: 6 }}
                      >
                        CONFLICTS
                      </div>
                      <div
                        className="font-mono font-bold uppercase"
                        style={{
                          fontSize: 14,
                          color: selectedNeed.conflictPredicted ? S.error : S.success,
                        }}
                      >
                        {selectedNeed.conflictPredicted ? "PREDICTED" : "NONE"}
                      </div>
                    </div>

                    {/* Overlapping Files */}
                    <div style={{ backgroundColor: S.headerBg, padding: 12 }}>
                      <div
                        className="font-mono font-bold uppercase"
                        style={{ fontSize: 10, letterSpacing: "1px", color: S.textMuted, marginBottom: 6 }}
                      >
                        FILE OVERLAPS
                      </div>
                      <div
                        className="font-mono font-bold"
                        style={{
                          fontSize: 14,
                          color: selectedNeed.conflictingFiles.length > 0 ? S.warning : S.success,
                        }}
                      >
                        {selectedNeed.conflictingFiles.length > 0
                          ? `${selectedNeed.conflictingFiles.length} file${selectedNeed.conflictingFiles.length !== 1 ? "s" : ""}`
                          : "CLEAN"}
                      </div>
                    </div>

                    {/* Rebase Risk */}
                    <div style={{ backgroundColor: S.headerBg, padding: 12 }}>
                      <div
                        className="font-mono font-bold uppercase"
                        style={{ fontSize: 10, letterSpacing: "1px", color: S.textMuted, marginBottom: 6 }}
                      >
                        RISK LEVEL
                      </div>
                      <div
                        className="font-mono font-bold uppercase"
                        style={{
                          fontSize: 14,
                          color: selectedNeed.conflictPredicted
                            ? S.error
                            : selectedNeed.conflictingFiles.length > 0
                              ? S.warning
                              : S.success,
                        }}
                      >
                        {selectedNeed.conflictPredicted
                          ? "HIGH"
                          : selectedNeed.conflictingFiles.length > 0
                            ? "MEDIUM"
                            : "LOW"}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── New Commits on Base ── */}
                <div
                  style={{
                    backgroundColor: S.cardBg,
                    border: `1px solid ${S.borderDefault}`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setDriftCommitsExpanded((v) => !v)}
                    className="flex w-full items-center justify-between"
                    style={{
                      padding: "14px 20px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <GitCommit size={14} style={{ color: S.info }} />
                      <span
                        className="font-mono font-bold uppercase"
                        style={{ fontSize: 10, letterSpacing: "1px", color: S.textSecondary }}
                      >
                        NEW COMMITS ON {selectedNeed.baseBranch.toUpperCase()}
                      </span>
                      <span
                        className="font-mono font-bold"
                        style={{
                          fontSize: 10,
                          color: S.info,
                          backgroundColor: "#3B82F618",
                          border: "1px solid #3B82F630",
                          padding: "1px 6px",
                        }}
                      >
                        {selectedNeed.behindBy}
                      </span>
                    </div>
                    {driftCommitsExpanded
                      ? <CaretDown size={12} style={{ color: S.textMuted }} />
                      : <CaretRight size={12} style={{ color: S.textMuted }} />}
                  </button>

                  {driftCommitsExpanded && (
                    <div style={{ borderTop: `1px solid ${S.borderDefault}` }}>
                      {driftCommitsLoading ? (
                        <div style={{ padding: "12px 20px", fontSize: 11, color: S.textMuted }} className="font-mono">
                          Loading commits...
                        </div>
                      ) : driftCommits.length === 0 ? (
                        <div style={{ padding: "12px 20px", fontSize: 11, color: S.textMuted }} className="font-mono">
                          No commit details available. The parent lane may not be tracked locally.
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          {driftCommits.map((commit) => {
                            const isExpanded = expandedCommitSha === commit.sha;
                            const files = commitFilesMap[commit.sha];
                            const overlappingFiles = files
                              ? files.filter((f) => selectedNeed.conflictingFiles.includes(f))
                              : [];
                            return (
                              <div key={commit.sha}>
                                <button
                                  type="button"
                                  onClick={() => setExpandedCommitSha(isExpanded ? null : commit.sha)}
                                  className="flex w-full items-center gap-3 text-left"
                                  style={{
                                    padding: "8px 20px",
                                    background: "none",
                                    border: "none",
                                    borderBottom: `1px solid ${S.borderDefault}`,
                                    cursor: "pointer",
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#13101A66"; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                                >
                                  <span
                                    className="font-mono font-bold"
                                    style={{ fontSize: 10, color: S.accent, flexShrink: 0 }}
                                  >
                                    {commit.shortSha}
                                  </span>
                                  <span
                                    className="truncate"
                                    style={{ fontSize: 12, color: S.textPrimary, flex: 1, fontFamily: "var(--font-sans)" }}
                                  >
                                    {commit.subject}
                                  </span>
                                  <span
                                    className="font-mono"
                                    style={{ fontSize: 10, color: S.textMuted, flexShrink: 0 }}
                                  >
                                    {commit.authorName}
                                  </span>
                                  <span
                                    className="font-mono"
                                    style={{ fontSize: 10, color: S.textDisabled, flexShrink: 0 }}
                                  >
                                    {formatTimeAgo(commit.authoredAt)}
                                  </span>
                                  {isExpanded
                                    ? <CaretDown size={10} style={{ color: S.textMuted, flexShrink: 0 }} />
                                    : <CaretRight size={10} style={{ color: S.textMuted, flexShrink: 0 }} />}
                                </button>
                                {isExpanded && (
                                  <div style={{ padding: "8px 20px 8px 48px", borderBottom: `1px solid ${S.borderDefault}`, background: S.headerBg }}>
                                    {!files ? (
                                      <div className="font-mono" style={{ fontSize: 10, color: S.textMuted }}>Loading files...</div>
                                    ) : files.length === 0 ? (
                                      <div className="font-mono" style={{ fontSize: 10, color: S.textMuted }}>No files changed</div>
                                    ) : (
                                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                        {files.map((f) => {
                                          const isOverlap = selectedNeed.conflictingFiles.includes(f);
                                          return (
                                            <div key={f} className="flex items-center gap-2 font-mono" style={{ fontSize: 10 }}>
                                              <FileText size={10} style={{ color: isOverlap ? S.warning : S.textMuted, flexShrink: 0 }} />
                                              <span style={{ color: isOverlap ? S.warning : S.textSecondary }}>
                                                {f}
                                              </span>
                                              {isOverlap && (
                                                <span style={{ fontSize: 9, color: S.warning, backgroundColor: "#F59E0B18", padding: "0 4px" }}>
                                                  OVERLAP
                                                </span>
                                              )}
                                            </div>
                                          );
                                        })}
                                        {overlappingFiles.length > 0 && (
                                          <div className="font-mono" style={{ fontSize: 10, color: S.warning, marginTop: 4 }}>
                                            {overlappingFiles.length} file{overlappingFiles.length !== 1 ? "s" : ""} overlap with your branch
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ── File Overlap Analysis ── */}
                <div
                  style={{
                    backgroundColor: S.cardBg,
                    border: `1px solid ${S.borderDefault}`,
                    padding: 20,
                  }}
                >
                  <div
                    className="font-mono font-bold uppercase"
                    style={{
                      fontSize: 10,
                      letterSpacing: "1px",
                      color: S.textSecondary,
                      marginBottom: 12,
                    }}
                  >
                    FILE OVERLAP ANALYSIS
                  </div>

                  {selectedNeed.conflictingFiles.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div className="font-mono" style={{ fontSize: 11, color: S.warning, marginBottom: 4 }}>
                        {selectedNeed.conflictingFiles.length} file{selectedNeed.conflictingFiles.length !== 1 ? "s" : ""} modified in both your branch and {selectedNeed.baseBranch}
                      </div>
                      {selectedNeed.conflictingFiles.map((f) => (
                        <div
                          key={f}
                          className="font-mono flex items-center gap-2"
                          style={{
                            backgroundColor: "#F59E0B0A",
                            border: "1px solid #F59E0B20",
                            padding: "8px 12px",
                            fontSize: 11,
                            color: "#F5D08B",
                          }}
                        >
                          <Warning size={12} weight="fill" style={{ color: S.warning, flexShrink: 0 }} />
                          <span style={{ flex: 1, minWidth: 0 }}>{f}</span>
                          <ArrowRight size={10} style={{ color: S.textMuted }} />
                          <span style={{ fontSize: 10, color: S.textMuted }}>both modified</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2" style={{
                      backgroundColor: "#22C55E08",
                      border: "1px solid #22C55E20",
                      padding: "10px 14px",
                    }}>
                      <CheckCircle size={14} weight="fill" style={{ color: S.success, flexShrink: 0 }} />
                      <span className="font-mono" style={{ fontSize: 11, color: "#86EFAC" }}>
                        No file overlaps detected — clean rebase expected
                      </span>
                    </div>
                  )}
                </div>
              </>
            ) : null}

            {/* ── Rebase Actions ── */}
            <div
              style={{
                backgroundColor: S.cardBg,
                border: `1px solid ${S.borderDefault}`,
                padding: 20,
              }}
            >
              <div
                className="font-mono font-bold uppercase"
                style={{
                  fontSize: 10,
                  letterSpacing: "1px",
                  color: S.textSecondary,
                  marginBottom: 14,
                }}
              >
                REBASE ACTIONS
              </div>

              {/* Scope selector */}
              <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
                <span className="font-mono" style={{ fontSize: 10, color: S.textMuted }}>Scope:</span>
                <button
                  type="button"
                  onClick={() => setRunScope("lane_only")}
                  disabled={selectedRunIsActive}
                  style={{
                    fontSize: 10,
                    padding: "4px 8px",
                    border: `1px solid ${runScope === "lane_only" ? S.accentBorder : S.borderSubtle}`,
                    background: runScope === "lane_only" ? S.accentSubtleBg : "transparent",
                    color: runScope === "lane_only" ? S.accent : S.textSecondary,
                    cursor: selectedRunIsActive ? "not-allowed" : "pointer",
                  }}
                >
                  CURRENT LANE ONLY
                </button>
                {hasChildren && (
                  <button
                    type="button"
                    onClick={() => setRunScope("lane_and_descendants")}
                    disabled={selectedRunIsActive}
                    style={{
                      fontSize: 10,
                      padding: "4px 8px",
                      border: `1px solid ${runScope === "lane_and_descendants" ? S.accentBorder : S.borderSubtle}`,
                      background: runScope === "lane_and_descendants" ? S.accentSubtleBg : "transparent",
                      color: runScope === "lane_and_descendants" ? S.accent : S.textSecondary,
                      cursor: selectedRunIsActive ? "not-allowed" : "pointer",
                    }}
                  >
                    LANE + {selectedLane?.childCount} CHILD{(selectedLane?.childCount ?? 0) !== 1 ? "REN" : ""}
                  </button>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 14 }}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={selectedNeedIsPrTarget || rebaseBusy || resolverLaunching || selectedNeed.behindBy === 0 || selectedRunIsActive || selectedNeedResolvedByRun}
                  onClick={() => {
                    if (resolverExpanded) {
                      void handleRebase(true);
                    } else {
                      setResolverExpanded(true);
                    }
                  }}
                  style={{ borderRadius: 0 }}
                >
                  {resolverLaunching
                    ? <CircleNotch size={14} className="mr-1 animate-spin" />
                    : <Sparkle size={14} weight="regular" className="mr-1" />}
                  <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                    {resolverLaunching ? "LAUNCHING..." : "REBASE WITH AI"}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0 || selectedRunIsActive || selectedNeedResolvedByRun}
                  onClick={() => void handleRebase(false, "none")}
                  style={{ borderRadius: 0, borderColor: S.borderSubtle }}
                >
                  <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                    REBASE NOW (LOCAL ONLY)
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0 || selectedRunIsActive || selectedNeedResolvedByRun}
                  onClick={() => void handleRebase(false, "review_then_push")}
                  style={{ borderRadius: 0, borderColor: S.borderSubtle }}
                >
                  <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                    REBASE AND PUSH
                  </span>
                </Button>
                <div style={{ width: 1, height: 24, background: S.borderSubtle }} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedNeedIsPrTarget || rebaseBusy}
                  onClick={() => void handleDefer()}
                  style={{ borderRadius: 0, borderColor: S.borderSubtle }}
                >
                  <Clock size={12} className="mr-1" />
                  <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                    DEFER 4H
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedNeedIsPrTarget || rebaseBusy}
                  onClick={() => void handleDismiss()}
                  style={{ borderRadius: 0, borderColor: S.borderSubtle, color: S.textMuted }}
                >
                  <XCircle size={12} className="mr-1" />
                  <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                    DISMISS
                  </span>
                </Button>
              </div>

              {/* Group context */}
              {selectedNeed.groupContext && (
                <div
                  style={{
                    backgroundColor: S.headerBg,
                    padding: "8px 12px",
                    fontSize: 11,
                    color: S.textMuted,
                    marginBottom: 14,
                  }}
                  className="font-mono"
                >
                  Part of group:{" "}
                  <span style={{ color: S.textPrimary, fontWeight: 600 }}>{selectedNeed.groupContext}</span>
                </div>
              )}

              {/* AI Resolver config — only shown after clicking "Rebase with AI" */}
              {resolverExpanded && (
                <div
                  data-resolver-config
                  style={{
                    backgroundColor: S.headerBg,
                    border: `1px solid ${S.accentBorder}`,
                    padding: "12px 14px",
                    marginBottom: 14,
                  }}
                >
                  <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                    <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px", color: S.accent }}>
                      AI REBASE CONFIGURATION
                    </span>
                    <button
                      type="button"
                      onClick={() => setResolverExpanded(false)}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}
                    >
                      <XCircle size={14} style={{ color: S.textMuted }} />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <PrResolverLaunchControls
                      modelId={resolverModel}
                      reasoningEffort={resolverReasoningLevel}
                      permissionMode={resolverPermissionMode}
                      onModelChange={(nextModelId) => onResolverChange(nextModelId, resolverReasoningLevel)}
                      onReasoningEffortChange={(nextReasoning) => onResolverChange(resolverModel, nextReasoning)}
                      onPermissionModeChange={onResolverPermissionChange}
                      disabled={resolverLaunching}
                    />
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 10,
                        fontFamily: "var(--font-mono, monospace)",
                        fontWeight: 600,
                        letterSpacing: "0.5px",
                        color: forcePushAfterRebase ? S.accent : S.textMuted,
                        cursor: resolverLaunching ? "not-allowed" : "pointer",
                        opacity: resolverLaunching ? 0.5 : 1,
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={forcePushAfterRebase}
                        onChange={(e) => setForcePushAfterRebase(e.target.checked)}
                        disabled={resolverLaunching}
                        style={{ accentColor: S.accent, cursor: "inherit" }}
                      />
                      FORCE PUSH AFTER REBASE
                    </label>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={resolverLaunching || selectedNeed.behindBy === 0}
                      onClick={() => void handleRebase(true)}
                      style={{ borderRadius: 0 }}
                    >
                      {resolverLaunching
                        ? <CircleNotch size={14} className="mr-1 animate-spin" />
                        : <Sparkle size={14} className="mr-1" />}
                      <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                        {resolverLaunching ? "LAUNCHING..." : "LAUNCH AI RESOLVER"}
                      </span>
                    </Button>
                  </div>
                </div>
              )}

              {/* Active run status */}
              {activeRunForSelectedNeed ? (() => {
                const run = activeRunForSelectedNeed;
                const isFailed = run.state === "failed";
                const conflictLane = run.lanes.find((l) => l.status === "conflict");
                const conflictFiles = conflictLane?.conflictingFiles ?? [];

                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: `1px solid ${S.borderDefault}`, paddingTop: 14 }}>
                    {/* Conflict summary for failed runs */}
                    {isFailed && conflictLane ? (
                      <div style={{
                        backgroundColor: "#EF44440A",
                        border: `1px solid #EF444430`,
                        padding: 16,
                      }}>
                        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
                          <Warning size={16} weight="fill" style={{ color: S.error }} />
                          <span style={{ fontSize: 13, fontWeight: 600, color: S.textPrimary, fontFamily: "var(--font-sans)" }}>
                            Rebase failed — conflicts detected
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: S.textSecondary, marginBottom: 12, lineHeight: 1.5 }}>
                          The rebase of <span style={{ color: S.textPrimary, fontWeight: 600 }}>{conflictLane.laneName}</span> onto{" "}
                          <span style={{ color: S.textPrimary, fontWeight: 600 }}>{selectedNeed.baseBranch}</span> hit merge conflicts.
                          The worktree has been automatically restored to its pre-rebase state.
                        </div>
                        {conflictFiles.length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px", color: S.textMuted, marginBottom: 6 }}>
                              CONFLICTING FILES
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {conflictFiles.map((f) => (
                                <div
                                  key={f}
                                  className="font-mono flex items-center gap-2"
                                  style={{
                                    backgroundColor: "#EF44440A",
                                    border: "1px solid #EF444420",
                                    padding: "6px 10px",
                                    fontSize: 11,
                                    color: "#FCA5A5",
                                  }}
                                >
                                  <FileText size={12} style={{ color: S.error, flexShrink: 0 }} />
                                  {f}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              setResolverExpanded(true);
                              // Scroll up so the config panel is visible
                              setTimeout(() => {
                                document.querySelector("[data-resolver-config]")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                              }, 50);
                            }}
                            style={{ borderRadius: 0 }}
                          >
                            <Sparkle size={14} className="mr-1" />
                            <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                              RESOLVE WITH AI
                            </span>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={rebaseBusy}
                            onClick={() => {
                              setActiveRun(null);
                              setRunLogs([]);
                            }}
                            style={{ borderRadius: 0, borderColor: S.borderSubtle }}
                          >
                            <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                              DISMISS
                            </span>
                          </Button>
                        </div>
                      </div>
                    ) : (
                      /* Normal run status header */
                      <>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div
                              className="font-mono font-bold uppercase"
                              style={{ fontSize: 10, letterSpacing: "1px", color: S.textSecondary }}
                            >
                              {run.state === "running" ? "REBASING" : run.state === "completed" ? "REBASE COMPLETE" : "REBASE RUN"}
                            </div>
                            <span
                              className="font-mono font-bold uppercase"
                              style={{
                                fontSize: 9,
                                letterSpacing: "1px",
                                padding: "2px 6px",
                                color: run.state === "completed" ? S.success
                                  : run.state === "running" ? S.info
                                  : S.textMuted,
                                backgroundColor: run.state === "completed" ? "#22C55E18"
                                  : run.state === "running" ? "#3B82F618"
                                  : "transparent",
                                border: `1px solid ${
                                  run.state === "completed" ? "#22C55E30"
                                  : run.state === "running" ? "#3B82F630"
                                  : S.borderSubtle
                                }`,
                              }}
                            >
                              {run.state.toUpperCase()}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {run.state === "running" && (
                              <Button size="sm" variant="outline" disabled={rebaseBusy} onClick={() => void handleAbortRun()} style={{ borderRadius: 0, borderColor: S.borderSubtle }}>
                                <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>ABORT</span>
                              </Button>
                            )}
                            {run.canRollback && (
                              <Button size="sm" variant="outline" disabled={rebaseBusy} onClick={() => void handleRollbackRun()} style={{ borderRadius: 0, borderColor: S.borderSubtle }}>
                                <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>ROLLBACK</span>
                              </Button>
                            )}
                            {selectedPushLaneIds.length > 0 && (
                              <Button size="sm" variant="primary" disabled={rebaseBusy} onClick={() => void handlePushSelected()} style={{ borderRadius: 0 }}>
                                <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>PUSH</span>
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Lane statuses */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {run.lanes.map((lane) => {
                            const statusColor = lane.status === "succeeded"
                              ? S.success
                              : lane.status === "running"
                                ? S.info
                                : lane.status === "conflict"
                                  ? S.error
                                  : lane.status === "blocked"
                                    ? S.warning
                                    : S.textMuted;
                            const pushable = lane.status === "succeeded" && !run.pushedLaneIds.includes(lane.laneId);
                            return (
                              <div
                                key={lane.laneId}
                                className="flex items-center gap-3"
                                style={{
                                  border: `1px solid ${S.borderSubtle}`,
                                  background: S.headerBg,
                                  padding: "8px 12px",
                                }}
                              >
                                {pushable ? (
                                  <input
                                    type="checkbox"
                                    checked={selectedPushLaneIds.includes(lane.laneId)}
                                    onChange={(event) => {
                                      const checked = event.target.checked;
                                      setSelectedPushLaneIds((prev) => {
                                        if (checked) return [...new Set([...prev, lane.laneId])];
                                        return prev.filter((id) => id !== lane.laneId);
                                      });
                                    }}
                                    style={{ flexShrink: 0 }}
                                  />
                                ) : (
                                  <StatusDot color={statusColor} pulse={lane.status === "running"} />
                                )}
                                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: S.textPrimary, fontFamily: "var(--font-sans)", fontWeight: 600 }}>
                                  {lane.laneName}
                                </span>
                                <span
                                  className="font-mono font-bold uppercase"
                                  style={{
                                    fontSize: 9,
                                    letterSpacing: "1px",
                                    color: statusColor,
                                    padding: "2px 6px",
                                    backgroundColor: `${statusColor}18`,
                                    border: `1px solid ${statusColor}30`,
                                  }}
                                >
                                  {lane.status === "conflict" ? "CONFLICTS" : lane.status.toUpperCase()}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* Run logs — collapsed by default, toggleable */}
                    {runLogs.length > 0 && (
                      <details style={{ fontSize: 10, color: S.textMuted }}>
                        <summary className="font-mono" style={{ cursor: "pointer", userSelect: "none", padding: "4px 0" }}>
                          Run logs ({runLogs.length})
                        </summary>
                        <div
                          style={{
                            border: `1px solid ${S.borderSubtle}`,
                            background: S.headerBg,
                            maxHeight: 140,
                            overflow: "auto",
                            padding: "8px 10px",
                            fontFamily: "var(--font-sans)",
                            marginTop: 4,
                          }}
                        >
                          {runLogs.map((line, index) => (
                            <div key={`${line}-${index}`}>{line}</div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })() : (
                <div style={{
                  fontSize: 11,
                  color: S.textMuted,
                  borderTop: `1px solid ${S.borderDefault}`,
                  paddingTop: 12,
                }}>
                  No active rebase run. Choose an action above to start.
                </div>
              )}
            </div>

            {/* ── Error Banner ── */}
            {rebaseError && (
              <div
                style={{
                  backgroundColor: "#EF44440A",
                  border: `1px solid #EF444430`,
                  padding: "10px 14px",
                  fontSize: 11,
                  color: "#FCA5A5",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
                className="font-mono"
              >
                <XCircle size={14} weight="fill" style={{ color: S.error, flexShrink: 0, marginTop: 1 }} />
                {rebaseError}
              </div>
            )}

          </div>
        ) : (
          <div
            className="flex h-full items-center justify-center"
            style={{ backgroundColor: S.mainBg }}
          >
            <EmptyState title="No lane selected" description="Select a lane to view rebase status and resolve conflicts." />
          </div>
        ),
      },
    }),
    [
      rebaseNeeds,
      selectedNeed,
      selectedItemId,
      selectedLane,
      hasChildren,
      grouped,
      collapsed,
      laneById,
      resolverModel,
      resolverReasoningLevel,
      rebaseBusy,
      rebaseError,
      resolverLaunching,
      resolverExpanded,
      runScope,
      activeRun,
      runLogs,
      selectedPushLaneIds,
      selectedRunIsActive,
      driftCommits,
      driftCommitsLoading,
      driftCommitsExpanded,
      commitFilesMap,
      expandedCommitSha,
      onSelectItem,
      resolverPermissionMode,
      onRefresh,
      onResolverChange,
      onResolverPermissionChange,
      onNavigate,
    ],
  );

  return <PaneTilingLayout layoutId="prs:rebase:v1" tree={PR_TAB_TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
