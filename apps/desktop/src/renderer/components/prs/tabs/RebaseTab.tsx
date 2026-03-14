import React from "react";
import { ArrowsDownUp, Clock, CheckCircle, Warning, Sparkle, Eye, XCircle } from "@phosphor-icons/react";
import type { AiPermissionMode, LaneSummary, RebaseNeed, RebaseRun, RebaseScope } from "../../../../shared/types";
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
  const [runScope, setRunScope] = React.useState<RebaseScope>("lane_and_descendants");
  const [activeRun, setActiveRun] = React.useState<RebaseRun | null>(null);
  const [runLogs, setRunLogs] = React.useState<string[]>([]);
  const [selectedPushLaneIds, setSelectedPushLaneIds] = React.useState<string[]>([]);
  const activeRunIdRef = React.useRef<string | null>(null);

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
    // Sort attention by behindBy desc
    groups.attention.sort((a, b) => b.behindBy - a.behindBy);
    groups.clean.sort((a, b) => b.behindBy - a.behindBy);
    return groups;
  }, [rebaseNeeds]);

  const selectedNeed = React.useMemo(
    () => rebaseNeeds.find((n) => n.laneId === selectedItemId) ?? null,
    [rebaseNeeds, selectedItemId],
  );

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

  // Auto-select first item in highest-urgency group (guard against no-op updates when list is empty and nothing selected)
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
  }, [selectedNeed]);

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
      }
      await onRefresh();
    } catch (err: unknown) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy(false);
    }
  };
  const selectedRunIsActive = activeRun?.state === "running";

  const handleAbortRun = async () => {
    if (!activeRun) return;
    setRebaseBusy(true);
    setRebaseError(null);
    try {
      const next = await window.ade.lanes.rebaseAbort({ runId: activeRun.runId });
      setActiveRun(next);
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
    const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // 4 hours
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
              {need.behindBy} UPDATES
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

  const paneConfigs: Record<string, PaneConfig> = React.useMemo(
    () => ({
      list: {
        title: "Rebase Status",
        icon: ArrowsDownUp,
        bodyClassName: "overflow-auto",
        children: (
          <div style={{ backgroundColor: S.mainBg }}>
            {/* Panel header */}
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
          <div style={{ backgroundColor: S.mainBg, padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
            {/* ── Header Card ── */}
            <div
              style={{
                backgroundColor: S.cardBg,
                border: `1px solid ${S.borderDefault}`,
                borderRadius: 0,
                padding: 20,
              }}
            >
              <div className="flex items-center justify-between gap-3">
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
                  <div
                    className="font-mono"
                    style={{
                      fontSize: 11,
                      color: S.textMuted,
                      marginTop: 4,
                    }}
                  >
                    base: {selectedNeed.baseBranch}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0}
                  onClick={() => void handleRebase(true)}
                  style={{ borderRadius: 0 }}
                >
                  <Sparkle size={14} weight="regular" className="mr-1" />
                  REBASE WITH AI
                </Button>
              </div>
            </div>

            {/* ── Drift Analysis Card ── */}
            <div
              style={{
                backgroundColor: S.cardBg,
                border: `1px solid ${S.borderDefault}`,
                borderRadius: 0,
                padding: 20,
              }}
            >
              <div
                className="font-mono font-bold uppercase"
                style={{
                  fontSize: 10,
                  letterSpacing: "1px",
                  color: S.textSecondary,
                  marginBottom: 16,
                }}
              >
                DRIFT ANALYSIS
              </div>

              {/* Stat grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {/* Behind By */}
                <div
                  style={{
                    backgroundColor: S.headerBg,
                    borderRadius: 0,
                    padding: 12,
                  }}
                >
                  <div
                    className="font-mono font-bold uppercase"
                    style={{
                      fontSize: 10,
                      letterSpacing: "1px",
                      color: S.textMuted,
                      marginBottom: 6,
                    }}
                  >
                    NEW UPDATES
                  </div>
                  <div
                    className="font-mono font-bold"
                    style={{
                      fontSize: 16,
                      color: selectedNeed.behindBy > 5 ? S.warning : S.textPrimary,
                    }}
                  >
                    {selectedNeed.behindBy}
                    <span
                      className="font-mono"
                      style={{ fontSize: 11, color: S.textMuted, marginLeft: 4, fontWeight: 400 }}
                    >
                      on main
                    </span>
                  </div>
                </div>

                {/* Conflict Predicted */}
                <div
                  style={{
                    backgroundColor: S.headerBg,
                    borderRadius: 0,
                    padding: 12,
                  }}
                >
                  <div
                    className="font-mono font-bold uppercase"
                    style={{
                      fontSize: 10,
                      letterSpacing: "1px",
                      color: S.textMuted,
                      marginBottom: 6,
                    }}
                  >
                    CONFLICT PREDICTED
                  </div>
                  <div
                    className="font-mono font-bold uppercase"
                    style={{
                      fontSize: 14,
                      color: selectedNeed.conflictPredicted ? S.warning : S.success,
                    }}
                  >
                    {selectedNeed.conflictPredicted ? "YES" : "NO"}
                  </div>
                </div>

                {/* Linked PR */}
                <div
                  style={{
                    backgroundColor: S.headerBg,
                    borderRadius: 0,
                    padding: 12,
                  }}
                >
                  <div
                    className="font-mono font-bold uppercase"
                    style={{
                      fontSize: 10,
                      letterSpacing: "1px",
                      color: S.textMuted,
                      marginBottom: 6,
                    }}
                  >
                    LINKED PR
                  </div>
                  <div
                    className="font-mono font-bold"
                    style={{
                      fontSize: 14,
                      color: selectedNeed.prId ? S.info : S.textMuted,
                    }}
                  >
                    {selectedNeed.prId ? "PR LINKED" : "NONE"}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Commits Affecting Rebase (conflicting files) ── */}
            {selectedNeed.conflictingFiles.length > 0 && (
              <div
                style={{
                  backgroundColor: S.cardBg,
                  border: `1px solid ${S.borderDefault}`,
                  borderRadius: 0,
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
                  FILES WITH OVERLAPPING CHANGES
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {selectedNeed.conflictingFiles.map((f) => (
                    <div
                      key={f}
                      className="font-mono"
                      style={{
                        backgroundColor: "#F59E0B0A",
                        border: "1px solid #F59E0B20",
                        borderRadius: 0,
                        padding: "8px 12px",
                        fontSize: 11,
                        color: "#F5D08B",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Warning size={12} weight="fill" style={{ color: S.warning, flexShrink: 0 }} />
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Rebase Run Control Center ── */}
            <div
              style={{
                backgroundColor: S.cardBg,
                border: `1px solid ${S.borderDefault}`,
                borderRadius: 0,
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
                REBASE RUN CONTROL CENTER
              </div>

              <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
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
                    color: runScope === "lane_only" ? S.accent : S.textSecondary
                  }}
                >
                  CURRENT LANE ONLY
                </button>
                <button
                  type="button"
                  onClick={() => setRunScope("lane_and_descendants")}
                  disabled={selectedRunIsActive}
                  style={{
                    fontSize: 10,
                    padding: "4px 8px",
                    border: `1px solid ${runScope === "lane_and_descendants" ? S.accentBorder : S.borderSubtle}`,
                    background: runScope === "lane_and_descendants" ? S.accentSubtleBg : "transparent",
                    color: runScope === "lane_and_descendants" ? S.accent : S.textSecondary
                  }}
                >
                  LANE + CHILDREN
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
                <Button size="sm" variant="outline" disabled>
                  CONTINUE
                </Button>
                <Button size="sm" variant="outline" disabled>
                  SKIP LANE
                </Button>
                <Button size="sm" variant="outline" disabled={rebaseBusy || !activeRun || activeRun.state !== "running"} onClick={() => void handleAbortRun()}>
                  ABORT
                </Button>
                <Button size="sm" variant="outline" disabled={rebaseBusy || !activeRun || !activeRun.canRollback} onClick={() => void handleRollbackRun()}>
                  ROLLBACK RUN
                </Button>
                <Button size="sm" variant="primary" disabled={rebaseBusy || !activeRun || selectedPushLaneIds.length === 0} onClick={() => void handlePushSelected()}>
                  PUSH SELECTED
                </Button>
              </div>

              {activeRun ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div
                    style={{
                      background: S.headerBg,
                      border: `1px solid ${S.borderSubtle}`,
                      padding: "10px 12px",
                      fontSize: 11,
                      color: S.textSecondary,
                      fontFamily: "JetBrains Mono, monospace",
                    }}
                  >
                    run {activeRun.runId.slice(0, 8)} | {activeRun.scope === "lane_only" ? "lane only" : "lane + children"} | state: {activeRun.state}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                <div style={{ fontSize: 11, color: S.textMuted }}>
                  No active rebase run yet. Start from the actions below.
                </div>
              )}
            </div>

            {/* ── Resolution Card ── */}
            <div
              style={{
                backgroundColor: S.cardBg,
                border: `1px solid ${S.borderDefault}`,
                borderRadius: 0,
                padding: 20,
              }}
            >
              <div className="flex items-center justify-between gap-2" style={{ marginBottom: 16 }}>
                <div
                  className="font-mono font-bold uppercase"
                  style={{
                    fontSize: 10,
                    letterSpacing: "1px",
                    color: S.textSecondary,
                  }}
                >
                  RESOLUTION
                </div>
                <span className="font-mono" style={{ fontSize: 10, color: S.textMuted }}>
                  Pick the model here, then it locks once the resolver starts.
                </span>
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0 || selectedRunIsActive}
                  onClick={() => void handleRebase(true)}
                  style={{ borderRadius: 0 }}
                >
                  <Sparkle size={14} weight="regular" className="mr-1" />
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    REBASE WITH AI
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0 || selectedRunIsActive}
                  onClick={() => void handleRebase(false, "none")}
                  style={{
                    borderRadius: 0,
                    borderColor: S.borderSubtle,
                  }}
                >
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    REBASE NOW (LOCAL ONLY)
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0 || selectedRunIsActive}
                  onClick={() => void handleRebase(false, "review_then_push")}
                  style={{
                    borderRadius: 0,
                    borderColor: S.borderSubtle,
                  }}
                >
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    REBASE AND PUSH (REVIEW THEN PUSH)
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleDefer()}
                  style={{
                    borderRadius: 0,
                    borderColor: S.borderSubtle,
                  }}
                >
                  <Clock size={12} className="mr-1" />
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    DEFER 4H
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleDismiss()}
                  style={{
                    borderRadius: 0,
                    borderColor: S.borderSubtle,
                    color: S.textMuted,
                  }}
                >
                  <XCircle size={12} className="mr-1" />
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    DISMISS
                  </span>
                </Button>
              </div>

              {/* Group context */}
              {selectedNeed.groupContext && (
                <div
                  style={{
                    marginTop: 16,
                    backgroundColor: S.headerBg,
                    borderRadius: 0,
                    padding: "8px 12px",
                    fontSize: 11,
                    color: S.textMuted,
                  }}
                  className="font-mono"
                >
                  Part of group:{" "}
                  <span style={{ color: S.textPrimary, fontWeight: 600 }}>
                    {selectedNeed.groupContext}
                  </span>
                </div>
              )}

              {resolverOpen && resolverTargetLaneId ? (
                <div style={{ marginTop: 16 }}>
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
            </div>

            {/* ── Error Banner ── */}
            {rebaseError && (
              <div
                style={{
                  backgroundColor: "#EF44440A",
                  border: `1px solid #EF444430`,
                  borderRadius: 0,
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
      grouped,
      collapsed,
      laneById,
      resolverModel,
      resolverReasoningLevel,
      rebaseBusy,
      rebaseError,
      resolverOpen,
      resolverTargetLaneId,
      onSelectItem,
      onRefresh,
      onResolverChange,
    ],
  );

  return <PaneTilingLayout layoutId="prs:rebase:v1" tree={PR_TAB_TILING_TREE} panes={paneConfigs} className="flex-1 min-h-0" />;
}
