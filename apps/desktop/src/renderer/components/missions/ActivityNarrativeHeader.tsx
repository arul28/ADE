import {
  CheckCircle,
  Lightning,
  Robot,
  ChatCircle,
} from "@phosphor-icons/react";
import type { OrchestratorRunGraph } from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import {
  NOISY_EVENT_TYPES,
  filterExecutionSteps,
  narrativeForEvent,
  narrativeSummary,
  iconForEventType,
  iconHexForEventType,
  type SteeringEntry,
} from "./missionHelpers";

export function ActivityNarrativeHeader({
  runGraph,
  steeringLog
}: {
  runGraph: OrchestratorRunGraph | null;
  steeringLog: SteeringEntry[];
}) {
  if (!runGraph) {
    return (
      <div className="px-3 py-3 text-center" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-xs" style={{ color: COLORS.textMuted }}>No orchestrator run yet. Start a run to see activity.</div>
      </div>
    );
  }

  const steps = filterExecutionSteps(runGraph.steps);
  const totalSteps = steps.length;
  const succeededCount = steps.filter((s) => s.status === "succeeded").length;
  const runningCount = steps.filter((s) => s.status === "running").length;
  const pendingCount = steps.filter((s) => s.status === "pending" || s.status === "ready" || s.status === "blocked").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;

  const runningAttempts = runGraph.attempts.filter((a) => a.status === "running");
  const activeExecutorKinds = [...new Set(runningAttempts.map((a) => a.executorKind))];
  const activeAgentCount = runningAttempts.length;

  const progressParts: string[] = [];
  progressParts.push(`${succeededCount}/${totalSteps} steps done`);
  if (runningCount > 0) progressParts.push(`${runningCount} running`);
  if (pendingCount > 0) progressParts.push(`${pendingCount} pending`);
  if (failedCount > 0) progressParts.push(`${failedCount} failed`);
  if (skippedCount > 0) progressParts.push(`${skippedCount} skipped`);
  const progressLine = progressParts.join(" \u2022 ");

  const workersLine = activeAgentCount > 0
    ? `${activeAgentCount} agent${activeAgentCount !== 1 ? "s" : ""} active (${activeExecutorKinds.join(", ")})`
    : "No agents currently active";

  const timeline = runGraph.timeline ?? [];
  const latestMeaningful = [...timeline].reverse().find(
    (ev) => !NOISY_EVENT_TYPES.has(ev.eventType)
  );
  const lastActionLine = latestMeaningful
    ? `Last: ${narrativeForEvent(latestMeaningful)}`
    : null;

  const recentEvents = timeline
    .filter((ev) => !NOISY_EVENT_TYPES.has(ev.eventType))
    .slice(0, 5);
  const narrativeLines = narrativeSummary(recentEvents, steeringLog);

  return (
    <div className="space-y-2">
      <div className="px-3 py-2.5" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px] mb-2" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          Timeline summary
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textSecondary }}>
            <CheckCircle size={12} weight="regular" className="shrink-0" style={{ color: COLORS.success }} />
            <span>{progressLine}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textSecondary }}>
            <Robot size={12} weight="regular" className="shrink-0" style={{ color: COLORS.accent }} />
            <span>{workersLine}</span>
          </div>
          {lastActionLine && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textMuted }}>
              <Lightning size={12} weight="regular" className="shrink-0" style={{ color: COLORS.warning }} />
              <span className="truncate">{lastActionLine}</span>
            </div>
          )}
        </div>
      </div>

      {(narrativeLines.length > 0 || steeringLog.length > 0) && (
        <div className="px-3 py-2.5" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="text-[10px] font-bold uppercase tracking-[1px] mb-1.5" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>RECENT ACTIVITY</div>
          <div className="space-y-1">
            {steeringLog.map((d, i) => (
              <div key={`steer-${i}`} className="flex items-start gap-2">
                <ChatCircle size={12} weight="regular" className="shrink-0 mt-0.5" style={{ color: "#06B6D4" }} />
                <div className="flex-1 min-w-0">
                  <span className="text-[11px]" style={{ color: "#06B6D4" }}>User directive: {d.directive}</span>
                  <span className="ml-2 text-[10px]" style={{ color: COLORS.textMuted }}>{relativeWhen(d.appliedAt)}</span>
                </div>
              </div>
            ))}
            {recentEvents.map((ev, i) => {
              const Icon = iconForEventType(ev.eventType);
              const hex = iconHexForEventType(ev.eventType, ev.reason);
              return (
                <div key={`ev-${ev.id ?? i}`} className="flex items-start gap-2">
                  <Icon className="h-3 w-3 shrink-0 mt-0.5" style={{ color: hex }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[11px]" style={{ color: COLORS.textSecondary }}>{narrativeForEvent(ev)}</span>
                    <span className="ml-2 text-[10px]" style={{ color: COLORS.textMuted }}>{relativeWhen(ev.createdAt)}</span>
                  </div>
                </div>
              );
            })}
            {narrativeLines.length === 0 && steeringLog.length === 0 && (
              <div className="text-[11px]" style={{ color: COLORS.textMuted }}>Processing events...</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
