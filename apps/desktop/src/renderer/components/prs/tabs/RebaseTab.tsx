import React from "react";
import { ArrowsDownUp, Clock, CheckCircle, Warning, Sparkle, Eye, XCircle } from "@phosphor-icons/react";
import type { LaneSummary, RebaseNeed } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { cn } from "../../ui/cn";
import { PaneTilingLayout, type PaneConfig } from "../../ui/PaneTilingLayout";
import { UrgencyGroup } from "../shared/UrgencyGroup";
import { StatusDot } from "../shared/StatusDot";
import { ModelSelector } from "../shared/ModelSelector";
import { ResolverTerminalModal } from "../../conflicts/modals/ResolverTerminalModal";
import { PR_TAB_TILING_TREE } from "../shared/tilingConstants";

type RebaseTabProps = {
  rebaseNeeds: RebaseNeed[];
  lanes: LaneSummary[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  resolverModel: string;
  resolverReasoningLevel: string;
  onResolverChange: (model: string, level: string) => void;
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
  onResolverChange,
  onRefresh,
}: RebaseTabProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [rebaseBusy, setRebaseBusy] = React.useState(false);
  const [rebaseError, setRebaseError] = React.useState<string | null>(null);
  const [resolverOpen, setResolverOpen] = React.useState(false);

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

  const handleRebase = async (aiAssisted: boolean) => {
    if (!selectedNeed) return;
    setRebaseError(null);

    if (aiAssisted) {
      // For AI-assisted: validate that we can resolve the target lane, then open modal
      if (!resolverTargetLaneId) {
        setRebaseError(`Cannot find a lane matching base branch "${selectedNeed.baseBranch}". Create the lane first or sync manually.`);
        return;
      }
      setResolverOpen(true);
      return;
    }

    // Manual rebase
    setRebaseBusy(true);
    try {
      await window.ade.rebase.execute({ laneId: selectedNeed.laneId, aiAssisted: false });
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
    { key: "attention", title: "Needs Sync", color: S.warning, icon: Warning },
    { key: "clean", title: "Ready to Sync", color: S.info, icon: ArrowsDownUp },
    { key: "recent", title: "Recently Synced", color: S.accent, icon: Clock },
    { key: "upToDate", title: "Up to Date", color: S.success, icon: CheckCircle },
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
        title: "Sync Status",
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
                SYNC / DRIFT STATE
              </span>
            </div>

            {rebaseNeeds.length === 0 ? (
              <div style={{ padding: 16 }}>
                <EmptyState
                  title="All lanes up to date"
                  description="No lanes need syncing. This view auto-populates when lanes fall behind their base branch."
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
          ? `Sync: ${laneById.get(selectedNeed.laneId)?.name ?? selectedNeed.laneId}`
          : "Sync Detail",
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
                  SYNC WITH AI
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
                <ModelSelector
                  model={resolverModel}
                  reasoningLevel={resolverReasoningLevel}
                  onChange={onResolverChange}
                />
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0}
                  onClick={() => void handleRebase(true)}
                  style={{ borderRadius: 0 }}
                >
                  <Sparkle size={14} weight="regular" className="mr-1" />
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    SYNC WITH AI
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rebaseBusy || selectedNeed.behindBy === 0}
                  onClick={() => void handleRebase(false)}
                  style={{
                    borderRadius: 0,
                    borderColor: S.borderSubtle,
                  }}
                >
                  <span
                    className="font-mono font-bold uppercase"
                    style={{ fontSize: 10, letterSpacing: "1px" }}
                  >
                    SYNC MANUALLY
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

            {/* ── Resolver Modal ── */}
            {resolverOpen && resolverTargetLaneId && (
              <ResolverTerminalModal
                open={resolverOpen}
                onOpenChange={setResolverOpen}
                sourceLaneId={selectedNeed.laneId}
                targetLaneId={resolverTargetLaneId}
                cwdLaneId={selectedNeed.laneId}
                scenario="single-merge"
                onCompleted={() => void onRefresh()}
              />
            )}
          </div>
        ) : (
          <div
            className="flex h-full items-center justify-center"
            style={{ backgroundColor: S.mainBg }}
          >
            <EmptyState title="No lane selected" description="Select a lane to view sync status and resolve conflicts." />
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
