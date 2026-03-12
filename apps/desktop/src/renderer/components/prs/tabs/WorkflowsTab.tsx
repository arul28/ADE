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
  Warning,
} from "@phosphor-icons/react";
import { EmptyState } from "../../ui/EmptyState";
import type {
  IntegrationProposal,
  LaneSummary,
  PrMergeContext,
  PrWithConflicts,
} from "../../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { QueueTab } from "./QueueTab";
import { RebaseTab } from "./RebaseTab";
import { usePrs } from "../state/PrsContext";

export type WorkflowCategory = "integration" | "queue" | "rebase";
type WorkflowView = "active" | "history";

type WorkflowsTabProps = {
  activeCategory: WorkflowCategory;
  onChangeCategory: (category: WorkflowCategory) => void;
  onRefreshAll: () => Promise<void>;
  onOpenGitHubTab: (prId: string) => void;
};

type QueueGroupSummary = {
  groupId: string;
  name: string | null;
  targetBranch: string | null;
  bucket: WorkflowView;
  members: Array<{ prId: string; laneId: string; laneName: string; position: number; pr: PrWithConflicts | null }>;
  landingState: import("../../../../shared/types").QueueLandingState | null;
  rehearsalState: import("../../../../shared/types").QueueRehearsalState | null;
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "---";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildQueueWorkflowGroups(args: {
  prs: PrWithConflicts[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  lanes: LaneSummary[];
  queueStates: Record<string, import("../../../../shared/types").QueueLandingState>;
  queueRehearsals: Record<string, import("../../../../shared/types").QueueRehearsalState>;
}): QueueGroupSummary[] {
  const laneById = new Map(args.lanes.map((lane) => [lane.id, lane]));
  const prById = new Map(args.prs.map((pr) => [pr.id, pr] as const));
  const groupMap = new Map<string, QueueGroupSummary>();

  for (const queueState of Object.values(args.queueStates)) {
    groupMap.set(queueState.groupId, {
      groupId: queueState.groupId,
      name: queueState.groupName,
      targetBranch: queueState.targetBranch,
      bucket: queueState.state === "completed" || queueState.state === "cancelled" ? "history" : "active",
      landingState: queueState,
      rehearsalState: args.queueRehearsals[queueState.groupId] ?? null,
      members: queueState.entries.map((entry) => ({
        prId: entry.prId,
        laneId: entry.laneId,
        laneName: laneById.get(entry.laneId)?.name ?? entry.laneName,
        position: entry.position,
        pr: prById.get(entry.prId) ?? null,
      })),
    });
  }

  for (const rehearsalState of Object.values(args.queueRehearsals)) {
    const existing = groupMap.get(rehearsalState.groupId);
    const rehearsalBucket: WorkflowView = rehearsalState.state === "running" || rehearsalState.state === "paused" ? "active" : "history";
    if (existing) {
      existing.rehearsalState = rehearsalState;
      existing.bucket = existing.bucket === "active" ? "active" : rehearsalBucket;
      continue;
    }
    groupMap.set(rehearsalState.groupId, {
      groupId: rehearsalState.groupId,
      name: rehearsalState.groupName,
      targetBranch: rehearsalState.targetBranch,
      bucket: rehearsalBucket,
      landingState: args.queueStates[rehearsalState.groupId] ?? null,
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

  for (const pr of args.prs) {
    const context = args.mergeContextByPrId[pr.id];
    if (!context?.groupId || context.groupType !== "queue") continue;
    if (groupMap.has(context.groupId)) continue;
    groupMap.set(context.groupId, {
      groupId: context.groupId,
      name: null,
      targetBranch: pr.baseBranch ?? null,
      bucket: pr.state === "open" || pr.state === "draft" ? "active" : "history",
      landingState: args.queueStates[context.groupId] ?? null,
      rehearsalState: args.queueRehearsals[context.groupId] ?? null,
      members: context.members.map((member) => ({
        prId: member.prId,
        laneId: member.laneId,
        laneName: member.laneName,
        position: member.position,
        pr: prById.get(member.prId) ?? null,
      })),
    });
  }

  return [...groupMap.values()].sort((a, b) => {
    const aTs = Date.parse(a.landingState?.updatedAt ?? a.rehearsalState?.updatedAt ?? "");
    const bTs = Date.parse(b.landingState?.updatedAt ?? b.rehearsalState?.updatedAt ?? "");
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
    return (a.name ?? a.groupId).localeCompare(b.name ?? b.groupId);
  });
}

function QueueHistoryPanel({
  groups,
  onOpenGitHubTab,
}: {
  groups: QueueGroupSummary[];
  onOpenGitHubTab: (prId: string) => void;
}) {
  if (!groups.length) {
    return <EmptyState title="No queue history" description="Completed and cancelled queue workflows will appear here." />;
  }

  return (
    <div style={{ display: "grid", gap: 12, padding: 16 }}>
      {groups.map((group) => (
        <div key={group.groupId} style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                {group.name ?? `Queue ${group.groupId.slice(0, 8)}`}
              </div>
              <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                target {group.targetBranch ?? "main"} · {group.members.length} PRs
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {group.landingState ? <span style={inlineBadge(group.landingState.state === "completed" ? COLORS.success : COLORS.warning)}>{group.landingState.state}</span> : null}
              {group.rehearsalState ? <span style={inlineBadge(COLORS.info)}>rehearsal {group.rehearsalState.state}</span> : null}
            </div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {group.members.map((member) => (
              <div key={member.prId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                    {member.pr?.title ?? member.laneName}
                  </div>
                  <div style={{ marginTop: 2, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    {member.laneName}
                  </div>
                </div>
                {member.pr ? (
                  <button type="button" onClick={() => onOpenGitHubTab(member.prId)} style={outlineButton({ height: 28 })}>
                    <GithubLogo size={14} /> Open PR
                  </button>
                ) : null}
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

  return (
    <div style={{ display: "grid", gap: 12, padding: 16 }}>
      {needs.map((need) => {
        const statusLabel = need.dismissedAt
          ? "dismissed"
          : need.deferredUntil && new Date(need.deferredUntil) > new Date()
            ? "deferred"
            : "resolved recently";
        const timestamp = need.dismissedAt ?? need.deferredUntil ?? null;
        return (
          <div key={need.laneId} style={cardStyle()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>{need.laneName}</div>
                <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                  base {need.baseBranch} · behind {need.behindBy}
                </div>
              </div>
              <span style={inlineBadge(statusLabel === "resolved recently" ? COLORS.success : COLORS.warning)}>{statusLabel}</span>
            </div>
            <div style={{ marginTop: 10, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
              {timestamp ? `Updated ${formatTimestamp(timestamp)}` : "Captured in workflow history."}
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

  return (
    <div style={{ display: "flex", minHeight: 0, height: "100%" }}>
      <div style={{ width: 340, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto", flexShrink: 0 }}>
        {workflows.map((workflow) => {
          const selected = workflow.proposalId === selectedWorkflowId;
          const cleanupBadge = workflow.cleanupState === "required"
            ? inlineBadge(COLORS.warning)
            : workflow.cleanupState === "completed"
              ? inlineBadge(COLORS.success)
              : workflow.cleanupState === "declined"
                ? inlineBadge(COLORS.textSecondary)
                : null;
          return (
            <button
              key={workflow.proposalId}
              type="button"
              onClick={() => setSelectedWorkflowId(workflow.proposalId)}
              style={{
                display: "flex",
                width: "100%",
                flexDirection: "column",
                gap: 8,
                padding: "14px 16px",
                textAlign: "left",
                border: "none",
                borderLeft: selected ? "3px solid #A78BFA" : "3px solid transparent",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                background: selected ? "rgba(167, 139, 250, 0.08)" : "transparent",
                cursor: "pointer",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
              onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                  {workflow.title || workflow.integrationLaneName || `Integration ${workflow.proposalId.slice(0, 8)}`}
                </div>
                <span style={inlineBadge(workflow.status === "proposed" ? COLORS.info : COLORS.accent)}>{workflow.status}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <span style={inlineBadge(workflow.overallOutcome === "clean" ? COLORS.success : workflow.overallOutcome === "conflict" ? COLORS.warning : COLORS.danger)}>
                  {workflow.overallOutcome}
                </span>
                {cleanupBadge ? <span style={cleanupBadge}>{workflow.cleanupState}</span> : null}
              </div>
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                {workflow.sourceLaneIds.map((laneId) => laneById.get(laneId)?.name ?? laneId).join(" + ")}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 16 }}>
        {!selectedWorkflow ? (
          <EmptyState title="No workflow selected" description="Choose an integration workflow to inspect its stages." />
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {actionError ? (
              <div style={{ ...cardStyle({ borderColor: `${COLORS.danger}40`, color: COLORS.danger }), fontFamily: MONO_FONT, fontSize: 11 }}>
                {actionError}
              </div>
            ) : null}

            <div style={{ ...cardStyle(), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                  {selectedWorkflow.title || selectedWorkflow.integrationLaneName || "Integration workflow"}
                </div>
                <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                  created {formatTimestamp(selectedWorkflow.createdAt)}
                </div>
              </div>
              <button type="button" onClick={() => void onRefresh()} style={outlineButton()}>
                <ArrowsClockwise size={14} /> {busy ? "Refreshing..." : "Refresh Workflows"}
              </button>
            </div>

            <div style={cardStyle()}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10 }}>Stage 1 · Proposal</div>
              <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: 1.7, color: COLORS.textSecondary }}>
                {selectedWorkflow.body?.trim() || "This workflow proposal is tracking the lane bundle and merge analysis for the integration run."}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                {selectedWorkflow.sourceLaneIds.map((laneId) => (
                  <span key={laneId} style={inlineBadge(COLORS.textSecondary)}>
                    {laneById.get(laneId)?.name ?? laneId}
                  </span>
                ))}
              </div>
            </div>

            <div style={cardStyle()}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10 }}>Stage 2 · Integration Lane</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                    {selectedWorkflow.integrationLaneName || selectedWorkflow.integrationLaneId || "Pending lane creation"}
                  </div>
                  <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    {selectedWorkflow.integrationLaneId ? `lane ${selectedWorkflow.integrationLaneId}` : "No integration lane has been created yet."}
                  </div>
                </div>
                <span style={inlineBadge(selectedWorkflow.overallOutcome === "clean" ? COLORS.success : selectedWorkflow.overallOutcome === "conflict" ? COLORS.warning : COLORS.danger)}>
                  {selectedWorkflow.overallOutcome}
                </span>
              </div>
            </div>

            <div style={cardStyle()}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10 }}>Stage 3 · GitHub PR</div>
              {linkedPr ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                      #{linkedPr.githubPrNumber} {linkedPr.title}
                    </div>
                    <div style={{ marginTop: 4, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                      {linkedPr.headBranch} → {linkedPr.baseBranch}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <span style={inlineBadge(linkedPr.state === "merged" ? COLORS.success : linkedPr.state === "closed" ? COLORS.textMuted : COLORS.accent)}>
                      {linkedPr.state}
                    </span>
                    <button type="button" onClick={() => void window.ade.app.openExternal(linkedPr.githubUrl)} style={outlineButton({ height: 28 })}>
                      <GithubLogo size={14} /> Open In GitHub
                    </button>
                    <button type="button" onClick={() => onOpenGitHubTab(linkedPr.id)} style={outlineButton({ height: 28 })}>
                      <CaretRight size={14} /> Open In GitHub Tab
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>
                  No GitHub PR is linked yet. Commit the workflow to create the PR.
                </div>
              )}
            </div>

            <div style={cardStyle()}>
              <div style={{ ...LABEL_STYLE, marginBottom: 10 }}>Stage 4 · Cleanup</div>
              {selectedWorkflow.cleanupState === "required" || selectedWorkflow.cleanupState === "declined" ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>
                    This workflow is ready for cleanup. The integration lane is preselected; source lanes are optional.
                  </div>
                  {selectedWorkflow.integrationLaneId ? (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                      <input type="checkbox" checked={archiveIntegrationLane} onChange={(event) => setArchiveIntegrationLane(event.target.checked)} />
                      Archive {selectedWorkflow.integrationLaneName || selectedWorkflow.integrationLaneId}
                    </label>
                  ) : null}
                  <div style={{ display: "grid", gap: 8 }}>
                    {selectedWorkflow.sourceLaneIds.map((laneId) => (
                      <label key={laneId} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                        <input type="checkbox" checked={archiveSourceLaneIds.includes(laneId)} onChange={() => toggleSourceLane(laneId)} />
                        Archive {laneById.get(laneId)?.name ?? laneId}
                      </label>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" disabled={actionBusy} onClick={() => void handleCleanup()} style={primaryButton()}>
                      <Trash size={14} /> {actionBusy ? "Cleaning..." : "Cleanup Selected"}
                    </button>
                    <button type="button" disabled={actionBusy} onClick={() => void handleDismissCleanup()} style={outlineButton()}>
                      <Clock size={14} /> Not Now
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={inlineBadge(
                    selectedWorkflow.cleanupState === "completed"
                      ? COLORS.success
                      : COLORS.info
                  )}>
                    {selectedWorkflow.cleanupState}
                  </span>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary }}>
                    {selectedWorkflow.cleanupState === "completed"
                      ? `Cleanup finished ${formatTimestamp(selectedWorkflow.cleanupCompletedAt ?? null)}.`
                      : "Cleanup will be offered when the linked GitHub PR is closed or merged."}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowsTab({ activeCategory, onChangeCategory, onRefreshAll, onOpenGitHubTab }: WorkflowsTabProps) {
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
    queueRehearsals,
    resolverModel,
    resolverReasoningLevel,
    resolverPermissionMode,
    setResolverModel,
    setResolverReasoningLevel,
    setResolverPermissionMode,
  } = usePrs();

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
    () => buildQueueWorkflowGroups({ prs, mergeContextByPrId, lanes, queueStates, queueRehearsals }),
    [prs, mergeContextByPrId, lanes, queueStates, queueRehearsals],
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {(["active", "history"] as WorkflowView[]).map((mode) => {
            const selected = view === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                style={selected ? primaryButton({ height: 28, padding: "0 10px" }) : outlineButton({ height: 28, padding: "0 10px" })}
              >
                {mode}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {([
            { id: "integration", label: "Integration", icon: GitBranch },
            { id: "queue", label: "Queue", icon: CaretRight },
            { id: "rebase", label: "Rebase", icon: Sparkle },
          ] as Array<{ id: WorkflowCategory; label: string; icon: React.ElementType }>).map((category) => {
            const selected = activeCategory === category.id;
            const Icon = category.icon;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => onChangeCategory(category.id)}
                style={selected ? primaryButton({ height: 28, padding: "0 10px" }) : outlineButton({ height: 28, padding: "0 10px" })}
              >
                <Icon size={14} /> {category.label} {counts[category.id] > 0 ? `(${counts[category.id]})` : ""}
              </button>
            );
          })}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
            {loading ? "Refreshing workflow state..." : "ADE workflow state"}
          </div>
          <button type="button" onClick={() => void refreshWorkflows()} style={outlineButton({ height: 28, padding: "0 10px" })}>
            <ArrowsClockwise size={14} /> Refresh Workflows
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.06)", color: COLORS.danger, fontFamily: MONO_FONT, fontSize: 11 }}>
          {error}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0 }}>
        {activeCategory === "integration" ? (
          <IntegrationWorkflowsTab
            workflows={integrationByView[view]}
            lanes={lanes}
            prs={prs}
            view={view}
            busy={loading}
            onRefresh={refreshWorkflows}
            onOpenGitHubTab={onOpenGitHubTab}
          />
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
            <QueueHistoryPanel groups={queueByView.history} onOpenGitHubTab={onOpenGitHubTab} />
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
            />
          ) : (
            <RebaseHistoryPanel needs={rebaseByView.history} />
          )
        ) : null}
      </div>
    </div>
  );
}
