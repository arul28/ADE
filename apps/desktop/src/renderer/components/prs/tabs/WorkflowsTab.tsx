import React from "react";
import {
  ArrowsClockwise,
  CaretRight,
  CheckCircle,
  Clock,
  GitBranch,
  GithubLogo,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "../../ui/EmptyState";
import type {
  IntegrationProposal,
  LaneSummary,
  PrMergeContext,
  PrWithConflicts,
} from "../../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { PrLaneCleanupBanner } from "../shared/PrLaneCleanupBanner";
import { formatTimestampShort } from "../shared/prFormatters";
import { QueueTab } from "./QueueTab";
import { RebaseTab } from "./RebaseTab";
import { IntegrationTab } from "./IntegrationTab";
import { usePrs } from "../state/PrsContext";
import { getQueueWorkflowBucket } from "./queueWorkflowModel";

const CATEGORY_THEMES = {
  integration: { color: "#8B5CF6", bg: "rgba(139, 92, 246, 0.08)", border: "rgba(139, 92, 246, 0.20)", bgSubtle: "rgba(139, 92, 246, 0.04)" },
  queue: { color: "#F59E0B", bg: "rgba(245, 158, 11, 0.08)", border: "rgba(245, 158, 11, 0.20)", bgSubtle: "rgba(245, 158, 11, 0.04)" },
  rebase: { color: "#14B8A6", bg: "rgba(20, 184, 166, 0.08)", border: "rgba(20, 184, 166, 0.20)", bgSubtle: "rgba(20, 184, 166, 0.04)" },
} as const;

export type WorkflowCategory = "integration" | "queue" | "rebase";
type WorkflowView = "active" | "history";

type WorkflowsTabProps = {
  activeCategory: WorkflowCategory;
  onChangeCategory: (category: WorkflowCategory) => void;
  onRefreshAll: () => Promise<void>;
  selectedPrId: string | null;
  onSelectPr: (prId: string | null) => void;
  onOpenGitHubTab: (prId: string) => void;
  integrationRefreshNonce?: number;
};

type QueueGroupSummary = {
  groupId: string;
  name: string | null;
  targetBranch: string | null;
  bucket: WorkflowView;
  members: Array<{ prId: string; laneId: string; laneName: string; position: number; pr: PrWithConflicts | null }>;
  landingState: import("../../../../shared/types").QueueLandingState | null;
};

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "clean": return COLORS.success;
    case "conflict": return COLORS.warning;
    default: return COLORS.danger;
  }
}

function cleanupBadgeStyle(cleanupState: string | null | undefined): React.CSSProperties | null {
  switch (cleanupState) {
    case "required":
      return inlineBadge(COLORS.warning, { background: `${COLORS.warning}18`, fontWeight: 600 });
    case "completed":
      return inlineBadge(COLORS.success, { background: `${COLORS.success}18`, fontWeight: 600 });
    case "declined":
      return inlineBadge(COLORS.textSecondary, { background: "rgba(255,255,255,0.06)", fontWeight: 600 });
    default:
      return null;
  }
}

function buildQueueWorkflowGroups(args: {
  prs: PrWithConflicts[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  lanes: LaneSummary[];
  queueStates: Record<string, import("../../../../shared/types").QueueLandingState>;
}): QueueGroupSummary[] {
  const laneById = new Map(args.lanes.map((lane) => [lane.id, lane]));
  const prById = new Map(args.prs.map((pr) => [pr.id, pr] as const));
  const groupMap = new Map<string, QueueGroupSummary>();

  function toMembers(entries: Array<{ prId: string; laneId: string; laneName: string; position: number }>): QueueGroupSummary["members"] {
    return entries.map((entry) => ({
      prId: entry.prId,
      laneId: entry.laneId,
      laneName: laneById.get(entry.laneId)?.name ?? entry.laneName,
      position: entry.position,
      pr: prById.get(entry.prId) ?? null,
    }));
  }

  for (const queueState of Object.values(args.queueStates)) {
    const members = toMembers(queueState.entries);
    groupMap.set(queueState.groupId, {
      groupId: queueState.groupId,
      name: queueState.groupName,
      targetBranch: queueState.targetBranch,
      bucket: getQueueWorkflowBucket({ landingState: queueState, members }),
      landingState: queueState,
      members,
    });
  }

  for (const pr of args.prs) {
    const context = args.mergeContextByPrId[pr.id];
    if (!context?.groupId || context.groupType !== "queue") continue;
    if (groupMap.has(context.groupId)) continue;
    const members = toMembers(context.members);
    const landingState = args.queueStates[context.groupId] ?? null;
    groupMap.set(context.groupId, {
      groupId: context.groupId,
      name: null,
      targetBranch: pr.baseBranch ?? null,
      bucket: getQueueWorkflowBucket({ landingState, members }),
      landingState,
      members,
    });
  }

  return [...groupMap.values()].sort((a, b) => {
    const aTs = Date.parse(a.landingState?.updatedAt ?? "");
    const bTs = Date.parse(b.landingState?.updatedAt ?? "");
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
    return (a.name ?? a.groupId).localeCompare(b.name ?? b.groupId);
  });
}

function QueueHistoryPanel({
  groups,
  lanes,
  onOpenGitHubTab,
  loading,
}: {
  groups: QueueGroupSummary[];
  lanes: LaneSummary[];
  onOpenGitHubTab: (prId: string) => void;
  loading?: boolean;
}) {
  const navigate = useNavigate();
  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane] as const)), [lanes]);

  if (loading && !groups.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
        <ArrowsClockwise size={16} className="animate-spin" style={{ color: COLORS.textMuted }} />
        <span style={{ fontSize: 13, color: COLORS.textMuted, fontFamily: SANS_FONT }}>Loading queue history...</span>
      </div>
    );
  }

  if (!groups.length) {
    return <EmptyState title="No queue history" description="Completed and cancelled queue workflows will appear here." />;
  }

  const theme = CATEGORY_THEMES.queue;
  return (
    <div style={{ display: "grid", gap: 14, padding: 16 }}>
      {groups.map((group) => (
        <div key={group.groupId} style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border, borderLeft: `3px solid ${theme.color}` })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                {group.name ?? `Queue ${group.groupId.slice(0, 8)}`}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                target <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{group.targetBranch ?? "main"}</span> · <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{group.members.length}</span> PRs
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {group.landingState ? <span style={inlineBadge(group.landingState.state === "completed" ? COLORS.success : theme.color, { background: `${group.landingState.state === "completed" ? COLORS.success : theme.color}18`, fontWeight: 600 })}>{group.landingState.state}</span> : null}
            </div>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {group.members.map((member) => (
              <div key={member.prId} style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, fontFamily: SANS_FONT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {member.pr?.title ?? member.laneName}
                    </div>
                    <div style={{ marginTop: 3, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                      {member.laneName}
                    </div>
                  </div>
                  {member.pr ? (
                    <button type="button" onClick={() => onOpenGitHubTab(member.prId)} style={outlineButton({ height: 30, borderColor: theme.border, color: theme.color, background: theme.bgSubtle })}>
                      <GithubLogo size={14} /> Open PR
                    </button>
                  ) : null}
                </div>
                <PrLaneCleanupBanner
                  pr={member.pr}
                  lane={laneById.get(member.laneId) ?? null}
                  compact
                  onNavigate={(path) => navigate(path)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RebaseHistoryPanel({
  needs,
}: {
  needs: import("../../../../shared/types").RebaseNeed[];
}) {
  if (!needs.length) {
    return <EmptyState title="No rebase history" description="Deferred, dismissed, and recently resolved rebase items will appear here." />;
  }

  const theme = CATEGORY_THEMES.rebase;
  const statusColors: Record<string, string> = {
    "dismissed": "#EF4444",
    "deferred": "#F59E0B",
    "resolved recently": COLORS.success,
  };

  return (
    <div style={{ display: "grid", gap: 14, padding: 16 }}>
      {needs.map((need) => {
        const statusLabel = need.dismissedAt
          ? "dismissed"
          : need.deferredUntil && new Date(need.deferredUntil) > new Date()
            ? "deferred"
            : "resolved recently";
        const timestamp = need.dismissedAt ?? need.deferredUntil ?? null;
        const badgeColor = statusColors[statusLabel] ?? theme.color;
        return (
          <div key={need.laneId} style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border, borderLeft: `3px solid ${theme.color}` })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>{need.laneName}</div>
                <div style={{ marginTop: 5, fontSize: 12, color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                  base <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{need.baseBranch}</span> · behind <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: badgeColor, fontWeight: 600 }}>{need.behindBy}</span>
                </div>
              </div>
              <span style={inlineBadge(badgeColor, { background: `${badgeColor}18`, fontWeight: 600, borderRadius: 8 })}>{statusLabel}</span>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              {timestamp ? <>Updated <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{formatTimestampShort(timestamp)}</span></> : "Captured in workflow history."}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IntegrationWorkflowsTab({
  workflows,
  lanes,
  prs,
  view,
  busy,
  onRefresh,
  onOpenGitHubTab,
}: {
  workflows: IntegrationProposal[];
  lanes: LaneSummary[];
  prs: PrWithConflicts[];
  view: WorkflowView;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onOpenGitHubTab: (prId: string) => void;
}) {
  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);
  const prById = React.useMemo(() => new Map(prs.map((pr) => [pr.id, pr] as const)), [prs]);

  const [selectedWorkflowId, setSelectedWorkflowId] = React.useState<string | null>(null);
  const [archiveIntegrationLane, setArchiveIntegrationLane] = React.useState(true);
  const [archiveSourceLaneIds, setArchiveSourceLaneIds] = React.useState<string[]>([]);
  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (workflows.length === 0) {
      setSelectedWorkflowId(null);
      return;
    }
    if (selectedWorkflowId && workflows.some((workflow) => workflow.proposalId === selectedWorkflowId)) return;
    setSelectedWorkflowId(workflows[0]?.proposalId ?? null);
  }, [workflows, selectedWorkflowId]);

  const selectedWorkflow = React.useMemo(
    () => workflows.find((workflow) => workflow.proposalId === selectedWorkflowId) ?? null,
    [workflows, selectedWorkflowId],
  );

  React.useEffect(() => {
    if (!selectedWorkflow) return;
    setArchiveIntegrationLane(Boolean(selectedWorkflow.integrationLaneId));
    setArchiveSourceLaneIds([]);
    setActionError(null);
  }, [selectedWorkflow?.proposalId]);

  const linkedPr = selectedWorkflow?.linkedPrId ? prById.get(selectedWorkflow.linkedPrId) ?? null : null;

  const toggleSourceLane = React.useCallback((laneId: string) => {
    setArchiveSourceLaneIds((current) => (
      current.includes(laneId)
        ? current.filter((entry) => entry !== laneId)
        : [...current, laneId]
    ));
  }, []);

  const handleDismissCleanup = React.useCallback(async () => {
    if (!selectedWorkflow) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await window.ade.prs.dismissIntegrationCleanup({ proposalId: selectedWorkflow.proposalId });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [onRefresh, selectedWorkflow]);

  const handleCleanup = React.useCallback(async () => {
    if (!selectedWorkflow) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await window.ade.prs.cleanupIntegrationWorkflow({
        proposalId: selectedWorkflow.proposalId,
        archiveIntegrationLane,
        archiveSourceLaneIds,
      });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [archiveIntegrationLane, archiveSourceLaneIds, onRefresh, selectedWorkflow]);

  if (!workflows.length) {
    return (
      <EmptyState
        title={view === "active" ? "No active integration workflows" : "No integration history"}
        description={view === "active" ? "Create an integration workflow to merge multiple lanes into one GitHub PR." : "Completed, cleaned up, and deferred integration workflows will appear here."}
      />
    );
  }

  const theme = CATEGORY_THEMES.integration;

  const stageSteps = [
    { label: "Proposal", num: 1 },
    { label: "Lane", num: 2 },
    { label: "PR", num: 3 },
    { label: "Cleanup", num: 4 },
  ];
  const getStageProgress = (wf: IntegrationProposal): number => {
    if (wf.cleanupState === "completed") return 4;
    if (wf.linkedPrId) return 3;
    if (wf.integrationLaneId) return 2;
    return 1;
  };

  return (
    <div style={{ display: "flex", minHeight: 0, height: "100%" }}>
      <div style={{ width: 340, borderRight: `1px solid ${theme.border}`, overflow: "auto", flexShrink: 0 }}>
        {workflows.map((workflow) => {
          const selected = workflow.proposalId === selectedWorkflowId;
          const oc = outcomeColor(workflow.overallOutcome);
          const cleanupBadge = cleanupBadgeStyle(workflow.cleanupState);
          return (
            <button
              key={workflow.proposalId}
              type="button"
              onClick={() => setSelectedWorkflowId(workflow.proposalId)}
              style={{
                display: "flex",
                width: "100%",
                flexDirection: "row",
                gap: 12,
                padding: "14px 16px",
                textAlign: "left",
                border: "none",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                background: selected ? theme.bg : "transparent",
                cursor: "pointer",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
              onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = selected ? theme.bg : "transparent"; }}
            >
              {/* Colored outcome sidebar */}
              <div style={{ width: 4, borderRadius: 4, flexShrink: 0, background: oc, alignSelf: "stretch" }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {workflow.title || workflow.integrationLaneName || `Integration ${workflow.proposalId.slice(0, 8)}`}
                  </div>
                  <span style={inlineBadge(workflow.status === "proposed" ? COLORS.info : theme.color, { background: `${workflow.status === "proposed" ? COLORS.info : theme.color}18`, fontWeight: 600, flexShrink: 0 })}>{workflow.status}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <span style={inlineBadge(oc, { background: `${oc}18`, fontWeight: 600 })}>
                    {workflow.overallOutcome}
                  </span>
                  {cleanupBadge ? <span style={cleanupBadge}>{workflow.cleanupState}</span> : null}
                </div>
                <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                  {workflow.sourceLaneIds.map((laneId) => laneById.get(laneId)?.name ?? laneId).join(" + ")}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 20 }}>
        {!selectedWorkflow ? (
          <EmptyState title="No workflow selected" description="Choose an integration workflow to inspect its stages." />
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {actionError ? (
              <div style={{ ...cardStyle({ borderColor: `${COLORS.danger}40`, background: "rgba(239,68,68,0.06)" }), fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger }}>
                {actionError}
              </div>
            ) : null}

            {/* Header card */}
            <div style={{ ...cardStyle({ background: theme.bgSubtle, borderColor: theme.border }), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                  {selectedWorkflow.title || selectedWorkflow.integrationLaneName || "Integration workflow"}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                  Created <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{formatTimestampShort(selectedWorkflow.createdAt)}</span>
                </div>
              </div>
              <button type="button" onClick={() => void onRefresh()} style={outlineButton({ borderColor: theme.border, color: theme.color })}>
                <ArrowsClockwise size={14} /> {busy ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {/* Stage stepper timeline */}
            <div style={{ display: "flex", alignItems: "center", gap: 0, padding: "4px 0" }}>
              {stageSteps.map((step, i) => {
                const progress = getStageProgress(selectedWorkflow);
                const isComplete = progress >= step.num;
                const isCurrent = progress === step.num;
                const dotColor = isComplete ? theme.color : COLORS.textDim;
                return (
                  <React.Fragment key={step.num}>
                    {i > 0 && (
                      <div style={{ flex: 1, height: 2, background: isComplete ? theme.color : "rgba(255,255,255,0.08)", borderRadius: 1, transition: "background 200ms" }} />
                    )}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                      <div style={{
                        width: isCurrent ? 14 : 10,
                        height: isCurrent ? 14 : 10,
                        borderRadius: "50%",
                        background: isComplete ? dotColor : "transparent",
                        border: isComplete ? "none" : `2px solid ${COLORS.textDim}`,
                        boxShadow: isCurrent ? `0 0 0 4px ${theme.color}30` : "none",
                        transition: "all 200ms",
                      }} />
                      <span style={{ fontSize: 10, fontFamily: SANS_FONT, fontWeight: isCurrent ? 700 : 500, color: isComplete ? theme.color : COLORS.textMuted }}>
                        {step.label}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>

            {/* Stage 1: Proposal */}
            <div style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border })}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10, color: theme.color }}>Stage 1 -- Proposal</div>
              <div style={{ fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.7, color: COLORS.textSecondary }}>
                {selectedWorkflow.body?.trim() || "Tracking the lane bundle and merge analysis for this integration."}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                {selectedWorkflow.sourceLaneIds.map((laneId) => (
                  <span key={laneId} style={inlineBadge(theme.color, { background: theme.bg, fontWeight: 600 })}>
                    {laneById.get(laneId)?.name ?? laneId}
                  </span>
                ))}
              </div>
            </div>

            {/* Stage 2: Integration Lane */}
            <div style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border })}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10, color: theme.color }}>Stage 2 -- Integration Lane</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                    {selectedWorkflow.integrationLaneName || selectedWorkflow.integrationLaneId || "Pending lane creation"}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                    {selectedWorkflow.integrationLaneId ? <>lane <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{selectedWorkflow.integrationLaneId}</span></> : "No integration lane has been created yet."}
                  </div>
                </div>
                <span style={inlineBadge(outcomeColor(selectedWorkflow.overallOutcome), { background: `${outcomeColor(selectedWorkflow.overallOutcome)}18`, fontWeight: 600 })}>
                  {selectedWorkflow.overallOutcome}
                </span>
              </div>
            </div>

            {/* Stage 3: GitHub PR */}
            <div style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border })}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10, color: theme.color }}>Stage 3 -- GitHub PR</div>
              {linkedPr ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                      <span style={{ fontFamily: MONO_FONT, fontSize: 13 }}>#{linkedPr.githubPrNumber}</span> {linkedPr.title}
                    </div>
                    <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                      {linkedPr.headBranch} → {linkedPr.baseBranch}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 0 }}>
                    {(() => {
                      const stateCol = linkedPr.state === "merged" ? COLORS.success : linkedPr.state === "closed" ? COLORS.textMuted : theme.color;
                      return <span style={inlineBadge(stateCol, { background: `${stateCol}18`, fontWeight: 600 })}>{linkedPr.state}</span>;
                    })()}
                    <button type="button" onClick={() => void window.ade.app.openExternal(linkedPr.githubUrl)} style={outlineButton({ height: 30, borderColor: theme.border, color: theme.color, background: theme.bgSubtle })}>
                      <GithubLogo size={14} /> Open on GitHub
                    </button>
                    <button type="button" onClick={() => onOpenGitHubTab(linkedPr.id)} style={outlineButton({ height: 30, borderColor: theme.border, color: theme.color, background: theme.bgSubtle })}>
                      <CaretRight size={14} /> GitHub Tab
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
                  No GitHub PR linked yet. Commit the workflow to create the PR.
                </div>
              )}
            </div>

            {/* Stage 4: Cleanup */}
            <div style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border })}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10, color: theme.color }}>Stage 4 -- Cleanup</div>
              {selectedWorkflow.cleanupState === "required" || selectedWorkflow.cleanupState === "declined" ? (
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
                    Ready for cleanup. Integration lane is preselected; source lanes are optional.
                  </div>
                  <div style={{ padding: 14, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                    {selectedWorkflow.integrationLaneId ? (
                      <label style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary, cursor: "pointer", padding: "4px 0" }}>
                        <input type="checkbox" checked={archiveIntegrationLane} onChange={(event) => setArchiveIntegrationLane(event.target.checked)} style={{ accentColor: theme.color }} />
                        Archive <span style={{ fontWeight: 600 }}>{selectedWorkflow.integrationLaneName || selectedWorkflow.integrationLaneId}</span>
                      </label>
                    ) : null}
                    <div style={{ display: "grid", gap: 6, marginTop: selectedWorkflow.integrationLaneId ? 8 : 0 }}>
                      {selectedWorkflow.sourceLaneIds.map((laneId) => (
                        <label key={laneId} style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary, cursor: "pointer", padding: "4px 0" }}>
                          <input type="checkbox" checked={archiveSourceLaneIds.includes(laneId)} onChange={() => toggleSourceLane(laneId)} style={{ accentColor: theme.color }} />
                          Archive {laneById.get(laneId)?.name ?? laneId}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button type="button" disabled={actionBusy} onClick={() => void handleCleanup()} style={primaryButton({ background: theme.color, color: "#fff" })}>
                      <Trash size={14} /> {actionBusy ? "Cleaning..." : "Cleanup Selected"}
                    </button>
                    <button type="button" disabled={actionBusy} onClick={() => void handleDismissCleanup()} style={outlineButton({ borderColor: theme.border, color: COLORS.textSecondary })}>
                      <Clock size={14} /> Not Now
                    </button>
                  </div>
                </div>
              ) : (() => {
                const cleanupCol = selectedWorkflow.cleanupState === "completed" ? COLORS.success : COLORS.info;
                return (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={inlineBadge(cleanupCol, { background: `${cleanupCol}18`, fontWeight: 600 })}>
                    {selectedWorkflow.cleanupState}
                  </span>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
                    {selectedWorkflow.cleanupState === "completed"
                      ? <>Cleanup finished <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{formatTimestampShort(selectedWorkflow.cleanupCompletedAt ?? null)}</span>.</>
                      : "Cleanup will be offered when the linked PR is closed or merged."}
                  </div>
                </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowsTab({
  activeCategory,
  onChangeCategory,
  onRefreshAll,
  selectedPrId,
  onSelectPr,
  onOpenGitHubTab,
  integrationRefreshNonce = 0,
}: WorkflowsTabProps) {
  const {
    prs,
    lanes,
    mergeContextByPrId,
    mergeMethod,
    selectedQueueGroupId,
    setSelectedQueueGroupId,
    selectedRebaseItemId,
    setSelectedRebaseItemId,
    rebaseNeeds,
    queueStates,
    loading: prsLoading,
    resolverModel,
    resolverReasoningLevel,
    resolverPermissionMode,
    setResolverModel,
    setResolverReasoningLevel,
    setResolverPermissionMode,
  } = usePrs();

  const navigate = useNavigate();
  const [view, setView] = React.useState<WorkflowView>("active");
  const [integrationWorkflows, setIntegrationWorkflows] = React.useState<IntegrationProposal[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadWorkflows = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.ade.prs.listIntegrationWorkflows({ view: "all" });
      setIntegrationWorkflows(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const refreshWorkflows = React.useCallback(async () => {
    await Promise.all([
      onRefreshAll().catch(() => {}),
      loadWorkflows(),
    ]);
  }, [loadWorkflows, onRefreshAll]);

  const queueWorkflowGroups = React.useMemo(
    () => buildQueueWorkflowGroups({ prs, mergeContextByPrId, lanes, queueStates }),
    [prs, mergeContextByPrId, lanes, queueStates],
  );
  const integrationByView = React.useMemo(() => ({
    active: integrationWorkflows.filter((workflow) => workflow.workflowDisplayState === "active"),
    history: integrationWorkflows.filter((workflow) => workflow.workflowDisplayState === "history"),
  }), [integrationWorkflows]);
  const queueByView = React.useMemo(() => ({
    active: queueWorkflowGroups.filter((group) => group.bucket === "active"),
    history: queueWorkflowGroups.filter((group) => group.bucket === "history"),
  }), [queueWorkflowGroups]);
  const rebaseByView = React.useMemo(() => ({
    active: rebaseNeeds.filter((need) => !need.dismissedAt && !(need.deferredUntil && new Date(need.deferredUntil) > new Date()) && need.behindBy > 0),
    history: rebaseNeeds.filter((need) => need.dismissedAt || (need.deferredUntil && new Date(need.deferredUntil) > new Date()) || need.behindBy === 0),
  }), [rebaseNeeds]);

  const counts = {
    integration: integrationByView[view].length,
    queue: queueByView[view].length,
    rebase: rebaseByView[view].length,
  };

  const activeTheme = CATEGORY_THEMES[activeCategory];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderBottom: `1px solid ${activeTheme.border}` }}>
        {/* Active / History toggle - pill style */}
        <div style={{ display: "flex", alignItems: "center", borderRadius: 10, background: "rgba(255,255,255,0.04)", padding: 2, border: "1px solid rgba(255,255,255,0.06)" }}>
          {(["active", "history"] as WorkflowView[]).map((mode) => {
            const selected = view === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 28,
                  padding: "0 14px",
                  fontSize: 12,
                  fontWeight: selected ? 600 : 500,
                  fontFamily: SANS_FONT,
                  color: selected ? COLORS.textPrimary : COLORS.textMuted,
                  background: selected ? "rgba(255,255,255,0.10)" : "transparent",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "all 150ms ease",
                  textTransform: "capitalize" as const,
                }}
              >
                {mode === "active" ? <><CheckCircle size={13} weight={selected ? "fill" : "regular"} style={{ marginRight: 5 }} />{mode}</> : <><Clock size={13} weight={selected ? "fill" : "regular"} style={{ marginRight: 5 }} />{mode}</>}
              </button>
            );
          })}
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.08)" }} />

        {/* Category buttons with individual color themes */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {([
            { id: "integration" as WorkflowCategory, label: "Integration", icon: GitBranch },
            { id: "queue" as WorkflowCategory, label: "Queue", icon: CaretRight },
            { id: "rebase" as WorkflowCategory, label: "Rebase", icon: Sparkle },
          ]).map((category) => {
            const selected = activeCategory === category.id;
            const catTheme = CATEGORY_THEMES[category.id];
            const Icon = category.icon;
            const count = counts[category.id];
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => onChangeCategory(category.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  height: 30,
                  padding: "0 12px",
                  fontSize: 12,
                  fontWeight: selected ? 600 : 500,
                  fontFamily: SANS_FONT,
                  color: selected ? catTheme.color : COLORS.textMuted,
                  background: selected ? catTheme.bg : "transparent",
                  border: `1px solid ${selected ? catTheme.border : "rgba(255,255,255,0.06)"}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "all 150ms ease",
                }}
              >
                <Icon size={14} weight={selected ? "fill" : "regular"} /> {category.label}
                {count > 0 ? (
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: 18,
                    height: 18,
                    padding: "0 5px",
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    color: selected ? "#fff" : COLORS.textMuted,
                    background: selected ? catTheme.color : "rgba(255,255,255,0.08)",
                    borderRadius: 9,
                  }}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: loading ? activeTheme.color : COLORS.textMuted }}>
            {loading ? "Refreshing..." : "Workflows"}
          </div>
          <button type="button" onClick={() => void refreshWorkflows()} style={outlineButton({ height: 28, padding: "0 10px", borderColor: activeTheme.border, color: activeTheme.color })}>
            <ArrowsClockwise size={14} /> Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.06)", color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0 }}>
        {activeCategory === "integration" ? (
          view === "active" ? (
            <IntegrationTab
              prs={prs}
              lanes={lanes}
              mergeContextByPrId={mergeContextByPrId}
              mergeMethod={mergeMethod}
              selectedPrId={selectedPrId}
              onSelectPr={onSelectPr}
              onRefresh={refreshWorkflows}
              refreshNonce={integrationRefreshNonce}
            />
          ) : (
            <IntegrationWorkflowsTab
              workflows={integrationByView.history}
              lanes={lanes}
              prs={prs}
              view={view}
              busy={loading}
              onRefresh={refreshWorkflows}
              onOpenGitHubTab={onOpenGitHubTab}
            />
          )
        ) : null}

        {activeCategory === "queue" ? (
          view === "active" ? (
            <QueueTab
              prs={prs}
              lanes={lanes}
              mergeContextByPrId={mergeContextByPrId}
              mergeMethod={mergeMethod}
              workflowView="active"
              selectedGroupId={selectedQueueGroupId}
              onSelectGroup={setSelectedQueueGroupId}
              onRefresh={refreshWorkflows}
            />
          ) : (
            <QueueHistoryPanel groups={queueByView.history} lanes={lanes} onOpenGitHubTab={onOpenGitHubTab} loading={prsLoading} />
          )
        ) : null}

        {activeCategory === "rebase" ? (
          view === "active" ? (
            <RebaseTab
              rebaseNeeds={rebaseByView.active}
              lanes={lanes}
              selectedItemId={selectedRebaseItemId}
              onSelectItem={setSelectedRebaseItemId}
              resolverModel={resolverModel}
              resolverReasoningLevel={resolverReasoningLevel}
              resolverPermissionMode={resolverPermissionMode}
              onResolverChange={(model, level) => {
                setResolverModel(model);
                setResolverReasoningLevel(level);
              }}
              onResolverPermissionChange={setResolverPermissionMode}
              onRefresh={refreshWorkflows}
              onNavigate={(path) => navigate(path)}
            />
          ) : (
            <RebaseHistoryPanel needs={rebaseByView.history} />
          )
        ) : null}
      </div>
    </div>
  );
}
