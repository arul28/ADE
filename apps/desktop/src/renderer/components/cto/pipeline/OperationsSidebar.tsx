import React from "react";
import { Lightning } from "@phosphor-icons/react";
import type {
  CtoFlowPolicyRevision,
  LinearConnectionStatus,
  LinearIngressStatus,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearWorkflowMatchCandidate,
  LinearWorkflowRunDetail,
  LinearWorkflowSource,
} from "../../../../shared/types";
import { TimelineEntry } from "../shared/TimelineEntry";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { selectCls, textareaCls } from "../shared/designTokens";
import { cn } from "../../ui/cn";

function formatEndpoint(status: LinearIngressStatus["relay"] | LinearIngressStatus["localWebhook"]): string {
  if (!status?.status) return "not configured";
  if (!status.configured && status.status === "disabled") return "disabled";
  const base = status.status.replace(/_/g, " ");
  const delivery = status.lastDeliveryAt
    ? ` \u00b7 last event ${new Date(status.lastDeliveryAt).toLocaleTimeString()}`
    : "";
  return `${base}${delivery}`;
}

function formatQueueRunStatus(item: LinearSyncQueueItem): string {
  if (item.status === "escalated") return "Awaiting supervisor";
  if (item.status === "resolved") return "Completed";
  return item.status.replace(/_/g, " ");
}

type TimelineItem = {
  id: string;
  timestamp: string;
  title: string;
  subtitle: string;
  status: string;
  statusVariant: "info" | "success" | "warning" | "error" | "muted";
  payload: Record<string, unknown> | null;
};

type RunMatchSummary = {
  reason: string;
  matchedSignals: string[];
  routeTags: string[];
  nextStepsPreview: string[];
  matchedCandidate: LinearWorkflowMatchCandidate | null;
};

type DelegatedEmployeeOption = { value: string; label: string };

type Props = {
  dashboard: LinearSyncDashboard | null;
  ingressStatus: LinearIngressStatus | null;
  queue: LinearSyncQueueItem[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  selectedRunDetail: LinearWorkflowRunDetail | null;
  runDetailLoading: boolean;
  selectedRunQueueItem: LinearSyncQueueItem | null;
  selectedRunMatchSummary: RunMatchSummary | null;
  selectedRunStallSummary: string | null;
  selectedRunDelegationOverride: string;
  showDelegationOverride: boolean;
  canMarkRunComplete: boolean;
  selectedRunTimeline: TimelineItem[];
  reviewNote: string;
  onReviewNoteChange: (note: string) => void;
  queueActionLoading: "approve" | "reject" | "retry" | "complete" | null;
  delegatedEmployeeOptions: DelegatedEmployeeOption[];
  onDelegationOverrideChange: (runId: string, value: string | null) => void;
  policySource: LinearWorkflowSource;
  connection: LinearConnectionStatus | null;
  revisions: CtoFlowPolicyRevision[];
  onActOnRun: (action: "approve" | "reject" | "retry" | "complete") => void;
  onEnsureWebhook: () => void;
};

export function OperationsSidebar({
  dashboard,
  ingressStatus,
  queue,
  selectedRunId,
  onSelectRun,
  selectedRunDetail,
  runDetailLoading,
  selectedRunQueueItem,
  selectedRunMatchSummary,
  selectedRunStallSummary,
  selectedRunDelegationOverride,
  showDelegationOverride,
  canMarkRunComplete,
  selectedRunTimeline,
  reviewNote,
  onReviewNoteChange,
  queueActionLoading,
  delegatedEmployeeOptions,
  onDelegationOverrideChange,
  policySource,
  connection,
  revisions,
  onActOnRun,
  onEnsureWebhook,
}: Props) {
  return (
    <aside
      className="min-h-0 overflow-auto p-3"
      style={{ borderLeft: "1px solid rgba(167,139,250,0.08)", background: "linear-gradient(180deg, rgba(12,10,20,0.4), rgba(8,6,16,0.5))" }}
    >
      <div className="space-y-3">
        {/* Operations */}
        <div
          className="rounded-xl p-3"
          style={{
            background: "linear-gradient(135deg, rgba(96,165,250,0.04), rgba(24,20,35,0.5) 60%)",
            border: "1px solid rgba(96,165,250,0.12)",
            boxShadow: "0 4px 24px rgba(96,165,250,0.03)",
          }}
        >
          <div className="flex items-center gap-2 mb-2.5">
            <div className="h-1.5 w-1.5 rounded-full shadow-[0_0_6px_rgba(96,165,250,0.5)]" style={{ background: "#60A5FA" }} />
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#60A5FA" }}>
              Operations
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            {dashboard ? (
              <>
                {[
                  { label: "Queued", value: dashboard.queue.queued, accent: "#60A5FA" },
                  { label: "Dispatching", value: dashboard.queue.dispatched, accent: "#FBBF24" },
                  { label: "Escalated", value: dashboard.queue.escalated, accent: "#F472B6" },
                  { label: "Failed", value: dashboard.queue.failed, accent: "#EF4444" },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-lg border border-white/[0.06] px-2.5 py-2 transition-all duration-200 hover:border-white/[0.1]"
                    style={{ background: stat.value > 0 ? `${stat.accent}06` : "rgba(255,255,255,0.02)" }}
                  >
                    <div className="text-muted-fg/30">{stat.label}</div>
                    <div
                      className="mt-0.5 font-medium"
                      style={{ color: stat.value > 0 ? stat.accent : "rgba(255,255,255,0.5)" }}
                    >
                      {stat.value}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <div className="col-span-2 text-muted-fg/30">Loading queue summary...</div>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] transition-all duration-200 hover:border-white/[0.1]">
            <span className="text-muted-fg/30">Watch-only hits</span>
            <span className="text-fg">{dashboard?.watchOnlyHits ?? 0}</span>
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/35">
              Recent sync events
            </div>
            {dashboard?.recentEvents?.length ? (
              <div className="space-y-1">
                {dashboard.recentEvents.slice(0, 4).map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] px-2.5 py-1.5 transition-all duration-200 hover:border-white/[0.1] hover:bg-white/[0.02]"
                    style={{ background: "rgba(255,255,255,0.015)" }}
                  >
                    <span className="min-w-0 truncate text-[11px] text-fg/70">
                      {event.message ?? event.eventType}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-fg/30">{event.status ?? "sync"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-fg/25">No recent sync events</div>
            )}
          </div>
        </div>

        {/* Ingress */}
        <div
          className="rounded-xl p-3"
          style={{
            background: "linear-gradient(135deg, rgba(251,191,36,0.04), rgba(24,20,35,0.5) 60%)",
            border: "1px solid rgba(251,191,36,0.12)",
            boxShadow: "0 4px 24px rgba(251,191,36,0.03)",
          }}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full shadow-[0_0_6px_rgba(251,191,36,0.5)]" style={{ background: "#FBBF24" }} />
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#FBBF24" }}>
                Ingress
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="!h-5 !px-1.5 !text-[11px]"
              onClick={onEnsureWebhook}
              data-testid="linear-ensure-webhook-btn"
            >
              <Lightning size={9} />
            </Button>
          </div>
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-fg/35">Relay</span>
              <span className="text-muted-fg/55">
                {ingressStatus ? formatEndpoint(ingressStatus.relay) : "..."}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-fg/35">Local</span>
              <span className="text-muted-fg/55">
                {ingressStatus ? formatEndpoint(ingressStatus.localWebhook) : "..."}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-fg/35">Reconcile</span>
              <span className="text-muted-fg/55">
                {ingressStatus?.reconciliation.enabled
                  ? `${ingressStatus.reconciliation.intervalSec}s`
                  : "off"}
              </span>
            </div>
          </div>
        </div>

        {/* Queue */}
        <div
          className="rounded-xl p-3"
          style={{
            background: "linear-gradient(135deg, rgba(52,211,153,0.04), rgba(24,20,35,0.5) 60%)",
            border: "1px solid rgba(52,211,153,0.12)",
            boxShadow: "0 4px 24px rgba(52,211,153,0.03)",
          }}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full shadow-[0_0_6px_rgba(52,211,153,0.5)]" style={{ background: "#34D399" }} />
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#34D399" }}>
                Queue
              </span>
            </div>
            {dashboard && (
              <div className="flex items-center gap-1.5">
                {[
                  { n: dashboard.queue.queued, color: "#60A5FA", label: "Q" },
                  { n: dashboard.queue.dispatched, color: "#FBBF24", label: "W" },
                  { n: dashboard.queue.escalated, color: "#F472B6", label: "R" },
                  { n: dashboard.queue.failed, color: "#EF4444", label: "F" },
                ].map((s) => (
                  <span
                    key={s.label}
                    className="text-[11px] font-medium"
                    style={{ color: s.n > 0 ? s.color : "rgba(255,255,255,0.12)" }}
                    title={s.label}
                  >
                    {s.n}
                  </span>
                ))}
              </div>
            )}
          </div>
          {queue.length ? (
            <div className="space-y-1">
              {queue.slice(0, 6).map((item) => {
                const statusColor =
                  item.status === "resolved"
                    ? "#34D399"
                    : item.status === "escalated"
                      ? "#F472B6"
                      : item.status === "failed"
                        ? "#EF4444"
                        : "#60A5FA";
                const isSelected = selectedRunId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectRun(item.id)}
                    className={cn(
                      "w-full rounded-lg px-2.5 py-2 text-left transition-all duration-200",
                      isSelected
                        ? "bg-white/[0.05]"
                        : "hover:bg-white/[0.03] hover:translate-x-[1px]",
                    )}
                    style={{
                      borderLeft: `2px solid ${isSelected ? statusColor : `${statusColor}30`}`,
                      boxShadow: isSelected ? `inset 2px 0 8px ${statusColor}10` : undefined,
                    }}
                    data-testid={`linear-run-row-${item.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-fg/70 truncate">{item.identifier}</span>
                      <span className="text-[11px] font-medium shrink-0" style={{ color: statusColor }}>
                        {formatQueueRunStatus(item)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-fg/30 truncate">{item.workflowName}</div>
                    {item.routeReason ? (
                      <div className="mt-1 truncate text-[10px] text-muted-fg/40">{item.routeReason}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-muted-fg/25">No runs yet</div>
          )}
        </div>

        {/* Run detail */}
        {selectedRunId && (
          <div
            className="rounded-xl p-3"
            style={{
              background: "linear-gradient(135deg, rgba(167,139,250,0.06), rgba(24,20,35,0.55) 50%)",
              border: "1px solid rgba(167,139,250,0.16)",
              boxShadow: "0 6px 32px rgba(167,139,250,0.06), inset 0 1px 0 rgba(255,255,255,0.03)",
            }}
            data-testid="linear-run-timeline-card"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(167,139,250,0.6)]" style={{ background: "#A78BFA" }} />
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#A78BFA" }}>
                Run Detail
              </span>
              {selectedRunQueueItem && <Chip>{formatQueueRunStatus(selectedRunQueueItem)}</Chip>}
            </div>
            {runDetailLoading ? (
              <div className="text-xs text-muted-fg/30">Loading...</div>
            ) : !selectedRunDetail ? (
              <div className="text-xs text-muted-fg/30">Unavailable</div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  <Chip>{selectedRunDetail.run.identifier}</Chip>
                  <Chip>{selectedRunDetail.run.targetType}</Chip>
                </div>

                {selectedRunMatchSummary ? (
                  <div
                    className="rounded-lg p-3"
                    style={{ background: "rgba(96,165,250,0.04)", border: "1px solid rgba(96,165,250,0.12)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-medium" style={{ color: "#60A5FA" }}>
                        Why this matched
                      </div>
                      {selectedRunMatchSummary.matchedCandidate ? <Chip>route</Chip> : null}
                    </div>
                    <div className="mt-1 text-xs text-fg/70">{selectedRunMatchSummary.reason}</div>
                    {selectedRunMatchSummary.matchedSignals.length ? (
                      <div className="mt-1 text-[11px] text-muted-fg/60">
                        Signals: {selectedRunMatchSummary.matchedSignals.join(" \u00b7 ")}
                      </div>
                    ) : null}
                    {selectedRunMatchSummary.routeTags.length ? (
                      <div className="mt-1 text-[11px] text-muted-fg/60">
                        Route tags: {selectedRunMatchSummary.routeTags.join(" \u00b7 ")}
                      </div>
                    ) : null}
                    {selectedRunMatchSummary.nextStepsPreview.length ? (
                      <div className="mt-1 text-[11px] text-muted-fg/60">
                        Next steps: {selectedRunMatchSummary.nextStepsPreview.join(" \u00b7 ")}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div
                  className="rounded-lg p-3"
                  style={{ background: "rgba(245,158,11,0.04)", border: "1px solid rgba(245,158,11,0.12)" }}
                >
                  <div className="text-[11px] font-medium" style={{ color: "#FBBF24" }}>
                    Why this is stalled
                  </div>
                  <div className="mt-1 text-xs text-fg/70">
                    {selectedRunStallSummary ?? "Waiting for the next workflow event."}
                  </div>
                  {selectedRunDetail.run.routeContext?.matchedSignals?.length ? (
                    <div className="mt-1 text-[11px] text-muted-fg/60">
                      Matched signals: {selectedRunDetail.run.routeContext.matchedSignals.join(" \u00b7 ")}
                    </div>
                  ) : null}
                </div>

                {showDelegationOverride ? (
                  <div
                    className="rounded-lg p-3"
                    style={{ background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.12)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-medium" style={{ color: "#A78BFA" }}>
                        Delegation override
                      </div>
                      {selectedRunDetail.run.status === "awaiting_delegation" ? (
                        <Chip>required</Chip>
                      ) : (
                        <Chip>optional</Chip>
                      )}
                    </div>
                    <select
                      className={cn(selectCls, "mt-2")}
                      value={selectedRunDelegationOverride || "__auto__"}
                      onChange={(e) =>
                        onDelegationOverrideChange(
                          selectedRunId,
                          e.target.value === "__auto__" ? null : e.target.value,
                        )
                      }
                    >
                      <option value="__auto__">Automatic routing</option>
                      {delegatedEmployeeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-[11px] text-muted-fg/60">
                      Applies to approve, reject, retry, and complete actions on this run.
                    </div>
                  </div>
                ) : null}

                {selectedRunDetail.reviewContext &&
                selectedRunDetail.run.status === "awaiting_human_review" ? (
                  <div
                    className="rounded-lg p-3"
                    style={{ background: "rgba(251,191,36,0.04)", border: "1px solid rgba(251,191,36,0.12)" }}
                  >
                    <div className="text-[11px] font-medium" style={{ color: "#FBBF24" }}>
                      Supervisor action needed
                    </div>
                    <div className="mt-2">
                      <textarea
                        className={textareaCls}
                        rows={2}
                        value={reviewNote}
                        onChange={(e) => onReviewNoteChange(e.target.value)}
                        placeholder="Note..."
                      />
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onActOnRun("approve")}
                        disabled={queueActionLoading !== null}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onActOnRun("reject")}
                        disabled={queueActionLoading !== null}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ) : null}

                {canMarkRunComplete ? (
                  <div
                    className="rounded-lg p-3"
                    style={{ background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.12)" }}
                  >
                    <div className="text-[11px] font-medium" style={{ color: "#A78BFA" }}>
                      Awaiting completion
                    </div>
                    <div className="mt-2">
                      <textarea
                        className={textareaCls}
                        rows={2}
                        value={reviewNote}
                        onChange={(e) => onReviewNoteChange(e.target.value)}
                        placeholder="Completion note..."
                      />
                    </div>
                    <div className="mt-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onActOnRun("complete")}
                        disabled={queueActionLoading !== null}
                      >
                        Complete
                      </Button>
                    </div>
                  </div>
                ) : null}

                {selectedRunDetail.run.status === "failed" ||
                selectedRunDetail.run.status === "cancelled" ||
                selectedRunDetail.run.status === "retry_wait" ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onActOnRun("retry")}
                      disabled={queueActionLoading !== null}
                    >
                      Retry
                    </Button>
                    {selectedRunDetail.run.lastError ? (
                      <span className="text-xs text-warning truncate">
                        {selectedRunDetail.run.lastError}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <div className="space-y-1" data-testid="linear-run-timeline">
                  {selectedRunTimeline.map((entry) => (
                    <TimelineEntry
                      key={entry.id}
                      timestamp={entry.timestamp}
                      title={entry.title}
                      subtitle={entry.subtitle}
                      status={entry.status}
                      statusVariant={entry.statusVariant}
                      defaultExpanded={false}
                    >
                      {entry.payload ? (
                        <pre className="overflow-auto text-xs text-muted-fg whitespace-pre-wrap">
                          {JSON.stringify(entry.payload, null, 2)}
                        </pre>
                      ) : null}
                    </TimelineEntry>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer status */}
        <div className="space-y-1 px-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-fg/25">Source</span>
            <span className="text-muted-fg/40">{policySource === "repo" ? "Repo YAML" : "Generated"}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-fg/25">Linear</span>
            <span style={{ color: connection?.connected ? "#34D399" : "#EF4444" }}>
              {connection?.connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          {revisions.length > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-fg/25">Last save</span>
              <span className="text-muted-fg/40">
                {new Date(revisions[0].createdAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
