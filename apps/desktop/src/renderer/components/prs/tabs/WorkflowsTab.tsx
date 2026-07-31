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
  OperationRecord,
  PrMergeContext,
  PrWithConflicts,
} from "../../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { formatTimestampShort } from "../shared/prFormatters";
import { RebaseTab } from "./RebaseTab";
import { IntegrationTab } from "./IntegrationTab";
import { rebaseNeedItemKey } from "../shared/rebaseNeedUtils";
import { filterRebaseAttentionStatuses } from "../shared/rebaseAttentionUtils";
import { usePrs } from "../state/PrsContext";
import {
  getActiveRebaseNeeds,
  getRebaseHistoryOperations,
  getRebaseOperationLabel,
  parseRebaseOperationMetadata,
  sortRebaseHistoryOperations,
} from "./rebaseWorkflowModel";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";

const CATEGORY_THEMES = {
  integration: { color: "#8B5CF6", bg: "rgba(139, 92, 246, 0.08)", border: "rgba(139, 92, 246, 0.20)", bgSubtle: "rgba(139, 92, 246, 0.04)" },
  rebase: { color: "#14B8A6", bg: "rgba(20, 184, 166, 0.08)", border: "rgba(20, 184, 166, 0.20)", bgSubtle: "rgba(20, 184, 166, 0.04)" },
} as const;

export type WorkflowCategory = "integration" | "rebase";
type WorkflowView = "active" | "history";
const WORKFLOWS_VIEW_STORAGE_KEY = "ade:prs:workflows:view";
const WORKFLOWS_CACHE_TTL_MS = 120_000;
const WORKFLOWS_CACHE_DISABLED = import.meta.env.MODE === "test";
const REBASE_HISTORY_OPERATION_LIMIT = 100;
const REBASE_HISTORY_PULL_OPERATION_LIMIT = 1000;

type WorkflowsWarmCache = {
  view: WorkflowView;
  integrationWorkflows: IntegrationProposal[];
  cachedAt: number;
};

const workflowsWarmCacheByProject = new Map<string, WorkflowsWarmCache>();

function workflowsCacheKey(projectRoot?: string | null): string {
  const root = projectRoot?.trim();
  return root || "__default_project__";
}

function workflowsViewStorageKey(projectRoot?: string | null): string {
  const root = projectRoot?.trim();
  return root ? `${WORKFLOWS_VIEW_STORAGE_KEY}:${root}` : WORKFLOWS_VIEW_STORAGE_KEY;
}

function readWorkflowView(projectRoot?: string | null): WorkflowView {
  try {
    const value = window.localStorage.getItem(workflowsViewStorageKey(projectRoot));
    if (value === "active" || value === "history") return value;
  } catch {
    /* ignore */
  }
  return "active";
}

function writeWorkflowView(projectRoot: string | null, view: WorkflowView): void {
  try {
    window.localStorage.setItem(workflowsViewStorageKey(projectRoot), view);
  } catch {
    /* ignore */
  }
}

type WorkflowsTabProps = {
  activeCategory: WorkflowCategory;
  onChangeCategory: (category: WorkflowCategory) => void;
  onRefreshAll: () => Promise<void>;
  selectedPrId: string | null;
  onSelectPr: (prId: string | null) => void;
  onOpenGitHubTab: (prId: string) => void;
  integrationRefreshNonce?: number;
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
      return inlineBadge(COLORS.warning, { background: "color-mix(in srgb, var(--color-warning) 18%, transparent)", fontWeight: 600 });
    case "completed":
      return inlineBadge(COLORS.success, { background: "color-mix(in srgb, var(--color-success) 18%, transparent)", fontWeight: 600 });
    case "declined":
      return inlineBadge(COLORS.textSecondary, { background: "rgba(255,255,255,0.06)", fontWeight: 600 });
    default:
      return null;
  }
}

function RebaseHistoryPanel({
  operations,
  loading,
}: {
  operations: OperationRecord[];
  loading?: boolean;
}) {
  if (loading && !operations.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
        <ArrowsClockwise size={16} className="animate-spin" style={{ color: COLORS.textMuted }} />
        <span style={{ fontSize: 13, color: COLORS.textMuted, fontFamily: SANS_FONT }}>Loading rebase history...</span>
      </div>
    );
  }

  if (!operations.length) {
    return <EmptyState title="No ADE rebase history yet" description="Completed, failed, and canceled ADE rebase operations will appear here." />;
  }

  const theme = CATEGORY_THEMES.rebase;
  const statusColors: Record<string, string> = {
    succeeded: COLORS.success,
    failed: COLORS.danger,
    canceled: COLORS.warning,
    running: theme.color,
  };
  const shortSha = (sha: string | null) => sha ? sha.slice(0, 8) : "unknown";

  return (
    <div style={{ display: "grid", gap: 14, padding: 16 }}>
      {operations.map((operation) => {
        const metadata = parseRebaseOperationMetadata(operation);
        const badgeColor = statusColors[operation.status] ?? theme.color;
        const target =
          typeof metadata.baseTargetRef === "string" ? metadata.baseTargetRef
            : typeof metadata.baseBranchRef === "string" ? metadata.baseBranchRef
              : typeof metadata.parentBranchRef === "string" ? metadata.parentBranchRef
                : null;
        const actor = typeof metadata.actor === "string" ? metadata.actor : null;
        return (
          <div key={operation.id} style={cardStyle({ background: theme.bgSubtle, borderColor: theme.border, borderLeft: `3px solid ${theme.color}` })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT }}>{operation.laneName ?? operation.laneId ?? "Unknown lane"}</div>
                <div style={{ marginTop: 5, fontSize: 12, color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                  {getRebaseOperationLabel(operation)}
                  {target ? <> · target <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{target}</span></> : null}
                  {actor ? <> · actor <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{actor}</span></> : null}
                </div>
              </div>
              <span style={inlineBadge(badgeColor, { background: `${badgeColor}18`, fontWeight: 600, borderRadius: 8 })}>{operation.status}</span>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              Started <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{formatTimestampShort(operation.startedAt)}</span>
              {operation.endedAt ? <> · ended <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{formatTimestampShort(operation.endedAt)}</span></> : null}
              {" · "}
              <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{shortSha(operation.preHeadSha)} {"->"} {shortSha(operation.postHeadSha)}</span>
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
              <div style={{ ...cardStyle({ borderColor: "color-mix(in srgb, var(--color-error) 40%, transparent)", background: "rgba(239,68,68,0.06)" }), fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger }}>
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
    selectedRebaseItemId,
    setSelectedRebaseItemId,
    rebaseNeeds,
    autoRebaseStatuses,
    resolverModel,
    resolverReasoningLevel,
    resolverPermissionMode,
    setResolverModel,
    setResolverReasoningLevel,
    setResolverPermissionMode,
  } = usePrs();

  const navigate = useNavigate();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const cacheKey = workflowsCacheKey(projectRoot);
  const warmCache = !WORKFLOWS_CACHE_DISABLED ? workflowsWarmCacheByProject.get(cacheKey) ?? null : null;
  const [view, setViewRaw] = React.useState<WorkflowView>(() => warmCache?.view ?? readWorkflowView(projectRoot));
  const [integrationWorkflows, setIntegrationWorkflows] = React.useState<IntegrationProposal[]>(
    () => warmCache?.integrationWorkflows ?? [],
  );
  const [loading, setLoading] = React.useState(() => !warmCache);
  const [rebaseHistoryOperations, setRebaseHistoryOperations] = React.useState<OperationRecord[]>([]);
  const [rebaseHistoryLoading, setRebaseHistoryLoading] = React.useState(true);
  const [workflowError, setWorkflowError] = React.useState<string | null>(null);
  const [rebaseHistoryError, setRebaseHistoryError] = React.useState<string | null>(null);
  const workflowsLoadedRef = React.useRef(Boolean(warmCache));

  const setView = React.useCallback((next: WorkflowView) => {
    setViewRaw(next);
    writeWorkflowView(projectRoot, next);
  }, [projectRoot]);

  React.useEffect(() => {
    const cached = !WORKFLOWS_CACHE_DISABLED ? workflowsWarmCacheByProject.get(workflowsCacheKey(projectRoot)) ?? null : null;
    setViewRaw(cached?.view ?? readWorkflowView(projectRoot));
  }, [projectRoot]);

  const loadWorkflows = React.useCallback(async (options?: { silent?: boolean; skipFreshCache?: boolean }) => {
    const cached = !WORKFLOWS_CACHE_DISABLED ? workflowsWarmCacheByProject.get(cacheKey) ?? null : null;
    if (
      options?.skipFreshCache
      && cached
      && Date.now() - cached.cachedAt < WORKFLOWS_CACHE_TTL_MS
    ) {
      setLoading(false);
      return;
    }
    if (!options?.silent) setLoading(true);
    setWorkflowError(null);
    try {
      const next = await window.ade.prs.listIntegrationWorkflows({ view: "all" });
      workflowsLoadedRef.current = true;
      setIntegrationWorkflows(next);
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cacheKey]);

  const loadRebaseHistory = React.useCallback(async () => {
    setRebaseHistoryLoading(true);
    try {
      const operationGroups = await Promise.all([
        window.ade.history.listOperations({ kind: "lane_rebase", limit: REBASE_HISTORY_OPERATION_LIMIT }),
        window.ade.history.listOperations({ kind: "git_sync_rebase", limit: REBASE_HISTORY_OPERATION_LIMIT }),
        window.ade.history.listOperations({ kind: "git_pull", limit: REBASE_HISTORY_PULL_OPERATION_LIMIT }),
      ]);
      const operationsById = new Map<string, OperationRecord>();
      for (const operation of getRebaseHistoryOperations(operationGroups.flat())) {
        operationsById.set(operation.id, operation);
      }
      setRebaseHistoryOperations(sortRebaseHistoryOperations(Array.from(operationsById.values())));
      setRebaseHistoryError(null);
    } catch (err) {
      setRebaseHistoryError(err instanceof Error ? `Rebase history unavailable: ${err.message}` : `Rebase history unavailable: ${String(err)}`);
      setRebaseHistoryOperations([]);
    } finally {
      setRebaseHistoryLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadWorkflows({ silent: Boolean(warmCache), skipFreshCache: true });
  }, [loadWorkflows, warmCache]);

  React.useEffect(() => {
    void loadRebaseHistory();
  }, [loadRebaseHistory]);

  React.useEffect(() => {
    if (WORKFLOWS_CACHE_DISABLED) return;
    if (!workflowsLoadedRef.current && integrationWorkflows.length === 0) return;
    workflowsWarmCacheByProject.set(cacheKey, {
      view,
      integrationWorkflows,
      cachedAt: Date.now(),
    });
  }, [cacheKey, integrationWorkflows, view]);

  const refreshWorkflows = React.useCallback(async () => {
    await Promise.all([
      onRefreshAll().catch(() => {}),
      loadWorkflows(),
      loadRebaseHistory(),
    ]);
  }, [loadRebaseHistory, loadWorkflows, onRefreshAll]);

  const integrationByView = React.useMemo(() => ({
    active: integrationWorkflows.filter((workflow) => workflow.workflowDisplayState === "active"),
    history: integrationWorkflows.filter((workflow) => workflow.workflowDisplayState === "history"),
  }), [integrationWorkflows]);
  const rebaseByView = React.useMemo(() => ({
    active: getActiveRebaseNeeds(rebaseNeeds),
    history: rebaseHistoryOperations,
  }), [rebaseHistoryOperations, rebaseNeeds]);
  const rebaseAttentionByView = React.useMemo(() => ({
    active: filterRebaseAttentionStatuses({
      autoRebaseStatuses,
      visibleRebaseNeeds: rebaseByView.active,
      view: "active",
    }),
    history: [] as typeof autoRebaseStatuses,
  }), [autoRebaseStatuses, rebaseByView.active]);

  React.useEffect(() => {
    if (activeCategory !== "rebase" || !selectedRebaseItemId) return;
    const activeKeys = new Set(rebaseByView.active.map(rebaseNeedItemKey));
    if (activeKeys.has(selectedRebaseItemId)) {
      if (view !== "active") setView("active");
      return;
    }
    const activeAttentionLaneIds = new Set(rebaseAttentionByView.active.map((status) => status.laneId));
    if (activeAttentionLaneIds.has(selectedRebaseItemId)) {
      if (view !== "active") setView("active");
      return;
    }
    const historyAttentionLaneIds = new Set(rebaseAttentionByView.history.map((status) => status.laneId));
    if (historyAttentionLaneIds.has(selectedRebaseItemId) && view !== "history") {
      setView("history");
    }
  }, [activeCategory, rebaseAttentionByView.active, rebaseAttentionByView.history, rebaseByView.active, rebaseByView.history, selectedRebaseItemId, setView, view]);

  const counts = {
    integration: integrationByView[view].length,
    rebase: view === "history"
      ? rebaseHistoryOperations.length
      : rebaseByView.active.length + rebaseAttentionByView.active.length,
  };

  const activeTheme = CATEGORY_THEMES[activeCategory];
  const error = workflowError ?? rebaseHistoryError;

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
            { id: "rebase" as WorkflowCategory, label: "Rebase/Merge", icon: Sparkle },
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

        {activeCategory === "rebase" ? (
          view === "active" ? (
            <RebaseTab
              rebaseNeeds={rebaseByView.active}
              attentionStatuses={rebaseAttentionByView.active}
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
            <RebaseHistoryPanel operations={rebaseHistoryOperations} loading={rebaseHistoryLoading} />
          )
        ) : null}
      </div>
    </div>
  );
}
