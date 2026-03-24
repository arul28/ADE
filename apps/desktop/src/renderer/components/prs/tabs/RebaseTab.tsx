import React from "react";
import { ArrowsDownUp, Clock, CheckCircle, Warning, Sparkle, Eye, XCircle, GitCommit, FileText, CaretDown, CaretRight, ArrowRight } from "@phosphor-icons/react";
import type { AiPermissionMode, GitCommitSummary, LaneSummary, RebaseNeed, RebaseRun, RebaseScope } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig } from "../../ui/PaneTilingLayout";
import { UrgencyGroup } from "../shared/UrgencyGroup";
import { StatusDot } from "../shared/StatusDot";
import { PR_TAB_TILING_TREE } from "../shared/tilingConstants";
import { PrAiResolverPanel } from "../shared/PrAiResolverPanel";

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
};

type UrgencyCategory = "attention" | "clean" | "recent" | "upToDate";

function categorize(need: RebaseNeed): UrgencyCategory {
  if (need.dismissedAt) return "upToDate";
  if (need.deferredUntil && new Date(need.deferredUntil) > new Date()) return "upToDate";
  if (need.behindBy === 0) return "upToDate";
  if (need.conflictPredicted) return "attention";
  return "clean";
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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
}: RebaseTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [rebaseBusy, setRebaseBusy] = React.useState(false);
  const [rebaseError, setRebaseError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);
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

  const [collapsed, setCollapsed] = React.useState<Record<UrgencyCategory, boolean>>({
    attention: false,
    clean: false,
    recent: true,
    upToDate: true,
  });

  const grouped = React.useMemo(() => {
    const groups: Record<UrgencyCategory, RebaseNeed[]> = {
      attention: [],
      clean: [],
      recent: [],
      upToDate: [],
    };
    for (const need of rebaseNeeds) {
      groups[categorize(need)].push(need);
    }
    groups.attention.sort((a, b) => b.behindBy - a.behindBy);
    groups.clean.sort((a, b) => b.behindBy - a.behindBy);
    return groups;
  }, [rebaseNeeds]);

  const selectedNeed = React.useMemo(
    () => rebaseNeeds.find((n) => n.laneId === selectedItemId) ?? null,
    [rebaseNeeds, selectedItemId],
  );

  const selectedLane = React.useMemo(
    () => (selectedNeed ? laneById.get(selectedNeed.laneId) ?? null : null),
    [selectedNeed, laneById],
  );

  const hasChildren = (selectedLane?.childCount ?? 0) > 0;

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
    if (selectedItemId && rebaseNeeds.some((n) => n.laneId === selectedItemId)) return;
    const first = grouped.attention[0] ?? grouped.clean[0] ?? grouped.recent[0] ?? grouped.upToDate[0];
    onSelectItem(first?.laneId ?? null);
  }, [rebaseNeeds, selectedItemId, grouped, onSelectItem]);

  React.useEffect(() => {
    setRebaseError(null);
  }, [selectedItemId]);

  React.useEffect(() => {
    activeRunIdRef.current = activeRun?.runId ?? null;
  }, [activeRun]);

  // Subscribe to rebase events
  React.useEffect(() => {
    const unsubscribe = window.ade.lanes.rebaseSubscribe((event) => {
      if (event.type === "rebase-run-updated") {
        setActiveRun((prev) => {
          if (prev?.runId) {
            return event.run.runId === prev.runId ? event.run : prev;
          }
          if (!selectedNeed || event.run.rootLaneId !== selectedNeed.laneId) return prev;
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
  }, [refreshRebaseNeeds, selectedNeed]);

  // Fetch drift commits when selected need changes
  React.useEffect(() => {
    if (!selectedNeed || selectedNeed.behindBy === 0) {
      setDriftCommits([]);
      setCommitFilesMap({});
      setExpandedCommitSha(null);
      return;
    }

    const parentLane = selectedLane?.parentLaneId ? laneById.get(selectedLane.parentLaneId) : null;
    if (!parentLane) {
      setDriftCommits([]);
      return;
    }

    let cancelled = false;
    setDriftCommitsLoading(true);
    window.ade.git.listRecentCommits({ laneId: parentLane.id, limit: selectedNeed.behindBy })
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
  }, [selectedNeed?.laneId, selectedNeed?.behindBy, selectedLane?.parentLaneId, laneById]);

  // Load files for expanded commit
  const parentLaneId = selectedLane?.parentLaneId ? (laneById.get(selectedLane.parentLaneId)?.id ?? null) : null;
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

    if (aiAssisted) {
      if (!resolverTargetLaneId) {
        setRebaseError(`Cannot find a lane matching base branch "${selectedNeed.baseBranch}". Create the lane first or sync manually.`);
        return;
      }
      setResolverOpen(true);
      return;
    }

    setRebaseBusy(true);
    try {
      const started = await window.ade.lanes.rebaseStart({
        laneId: selectedNeed.laneId,
        scope: runScope,
        pushMode,
        actor: "user"
      });
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
  const selectedRunIsActive = activeRun?.state === "running";
  const selectedRunLane = React.useMemo(
    () => (selectedNeed ? activeRun?.lanes.find((lane) => lane.laneId === selectedNeed.laneId) ?? null : null),
    [activeRun, selectedNeed],
  );
  const selectedNeedResolvedByRun = Boolean(
    selectedRunLane
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
    const isSelected = need.laneId === selectedItemId;
    const laneName = laneById.get(need.laneId)?.name ?? need.laneId;
    return (
      <button
        key={need.laneId}
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
        onClick={() => onSelectItem(need.laneId)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot
            color={need.conflictPredicted ? S.warning : need.behindBy > 0 ? S.info : S.success}
            pulse={need.conflictPredicted}
          />
          <span
            className="font-mono font-bold truncate"
            style={{ fontSize: 11, color: S.textPrimary }}
          >
            {laneName}
          </span>
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

  const urgencyGroups: Array<{ key: UrgencyCategory; title: string; color: string; icon: typeof Warning }> = [
    { key: "attention", title: "Needs Rebase", color: S.warning, icon: Warning },
    { key: "clean", title: "Ready To Rebase", color: S.info, icon: ArrowsDownUp },
    { key: "recent", title: "Deferred", color: S.accent, icon: Clock },
    { key: "upToDate", title: "Resolved Recently", color: S.success, icon: CheckCircle },
  ];

  const resolverTargetLaneId = React.useMemo(() => {
    if (!selectedNeed) return null;
    return lanes.find((l) => {
      const ref = l.branchRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
      const base = selectedNeed.baseBranch.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
      return ref === base;
    })?.id ?? null;
  }, [lanes, selectedNeed]);

  // Compute file overlap between drift commits and the lane's own files
  const driftTouchedFiles = React.useMemo(() => {
    const files = new Set<string>();
    for (const fileList of Object.values(commitFilesMap)) {
      for (const f of fileList) files.add(f);
    }
    return files;
  }, [commitFilesMap]);

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
                  description="No lanes need rebasing. This view auto-populates when lanes fall behind their base branch."
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
                      fontFamily: "'Space Grotesk', sans-serif",
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
                      base: {selectedNeed.baseBranch}
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
                                style={{ fontSize: 12, color: S.textPrimary, flex: 1, fontFamily: "'Space Grotesk', sans-serif" }}
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
                                {timeAgo(commit.authoredAt)}
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
                  disabled={rebaseBusy || selectedNeed.behindBy === 0 || selectedRunIsActive || selectedNeedResolvedByRun}
                  onClick={() => void handleRebase(true)}
                  style={{ borderRadius: 0 }}
                >
                  <Sparkle size={14} weight="regular" className="mr-1" />
                  <span className="font-mono font-bold uppercase" style={{ fontSize: 10, letterSpacing: "1px" }}>
                    REBASE WITH AI
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

              {/* AI Resolver (inline) */}
              {resolverOpen && resolverTargetLaneId ? (
                <div style={{ marginBottom: 14 }}>
                  <PrAiResolverPanel
                    key={selectedNeed.laneId}
                    title="REBASE AI RESOLVER"
                    description="Launch the resolver inline, watch tool calls and reasoning stream into chat, and follow up without leaving this pane."
                    context={{
                      sourceTab: "rebase",
                      sourceLaneId: selectedNeed.laneId,
                      targetLaneId: resolverTargetLaneId,
                      laneId: selectedNeed.laneId,
                      scenario: "single-merge",
                    }}
                    modelId={resolverModel}
                    reasoningEffort={resolverReasoningLevel}
                    permissionMode={resolverPermissionMode}
                    onModelChange={onResolverChange}
                    onPermissionModeChange={onResolverPermissionChange}
                    onCompleted={() => {
                      void onRefresh();
                    }}
                    onDismiss={() => setResolverOpen(false)}
                    startLabel="Start Rebase Resolver"
                  />
                </div>
              ) : null}

              {/* Active run status */}
              {activeRun ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `1px solid ${S.borderDefault}`, paddingTop: 14 }}>
                  <div className="flex items-center justify-between">
                    <div
                      className="font-mono font-bold uppercase"
                      style={{ fontSize: 10, letterSpacing: "1px", color: S.textSecondary }}
                    >
                      ACTIVE RUN
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={rebaseBusy || activeRun.state !== "running"} onClick={() => void handleAbortRun()}>
                        ABORT
                      </Button>
                      <Button size="sm" variant="outline" disabled={rebaseBusy || !activeRun.canRollback} onClick={() => void handleRollbackRun()}>
                        ROLLBACK
                      </Button>
                      <Button size="sm" variant="primary" disabled={rebaseBusy || selectedPushLaneIds.length === 0} onClick={() => void handlePushSelected()}>
                        PUSH SELECTED
                      </Button>
                    </div>
                  </div>

                  <div
                    style={{
                      background: S.headerBg,
                      border: `1px solid ${S.borderSubtle}`,
                      padding: "8px 12px",
                      fontSize: 11,
                      color: S.textSecondary,
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    run {activeRun.runId.slice(0, 8)} | {activeRun.scope === "lane_only" ? "lane only" : "lane + children"} | state:{" "}
                    <span style={{
                      color: activeRun.state === "completed" ? S.success
                        : activeRun.state === "failed" ? S.error
                        : activeRun.state === "running" ? S.info
                        : S.textSecondary
                    }}>
                      {activeRun.state.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {activeRun.lanes.map((lane) => {
                      const statusColor = lane.status === "succeeded"
                        ? S.success
                        : lane.status === "running"
                          ? S.info
                          : lane.status === "conflict"
                            ? S.error
                            : lane.status === "blocked"
                              ? S.warning
                              : S.textMuted;
                      const pushable = lane.status === "succeeded" && !activeRun.pushedLaneIds.includes(lane.laneId);
                      return (
                        <label
                          key={lane.laneId}
                          className="flex items-center gap-2"
                          style={{
                            border: `1px solid ${S.borderSubtle}`,
                            background: S.headerBg,
                            padding: "6px 8px",
                            fontSize: 11,
                            color: S.textSecondary,
                            fontFamily: "JetBrains Mono, monospace"
                          }}
                        >
                          <input
                            type="checkbox"
                            disabled={!pushable}
                            checked={selectedPushLaneIds.includes(lane.laneId)}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedPushLaneIds((prev) => {
                                if (checked) return [...new Set([...prev, lane.laneId])];
                                return prev.filter((id) => id !== lane.laneId);
                              });
                            }}
                          />
                          <span style={{ minWidth: 140, color: S.textPrimary }}>{lane.laneName}</span>
                          <span style={{ color: statusColor }}>{lane.status.toUpperCase()}</span>
                          {lane.error ? <span style={{ color: S.error }} className="truncate">{lane.error}</span> : null}
                        </label>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      border: `1px solid ${S.borderSubtle}`,
                      background: S.headerBg,
                      maxHeight: 160,
                      overflow: "auto",
                      padding: "8px 10px",
                      fontSize: 10,
                      color: S.textMuted,
                      fontFamily: "JetBrains Mono, monospace"
                    }}
                  >
                    {(runLogs.length > 0 ? runLogs : ["No run logs yet."]).map((line, index) => (
                      <div key={`${line}-${index}`}>{line}</div>
                    ))}
                  </div>
                </div>
              ) : (
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
      resolverOpen,
      resolverTargetLaneId,
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
      driftTouchedFiles,
      onSelectItem,
      onRefresh,
      onResolverChange,
    ],
  );

  return <PaneTilingLayout layoutId="prs:rebase:v1" tree={PR_TAB_TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
