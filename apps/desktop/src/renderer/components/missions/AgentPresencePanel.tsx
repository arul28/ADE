import { useMemo } from "react";
import type { OrchestratorStep, OrchestratorAttempt } from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type AgentPresencePanelProps = {
  steps: OrchestratorStep[];
  attempts: OrchestratorAttempt[];
  selectedAgent: string | null;
  onSelectAgent: (stepKey: string | null) => void;
  agentColors: Map<string, string>;
};

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  running: { icon: "\u25CF", color: COLORS.success },
  pending: { icon: "\u25CC", color: COLORS.textMuted },
  succeeded: { icon: "\u2713", color: COLORS.success },
  failed: { icon: "\u2717", color: COLORS.danger },
  blocked: { icon: "\u23F8", color: COLORS.warning },
  skipped: { icon: "\u25CB", color: COLORS.textMuted },
  superseded: { icon: "\u2248", color: COLORS.warning },
  canceled: { icon: "\u25CB", color: COLORS.textMuted },
  ready: { icon: "\u25CB", color: COLORS.info }
};

function formatStepElapsed(step: OrchestratorStep, attempts: OrchestratorAttempt[]): string {
  if (step.status !== "running") return "";
  const activeAttempt = attempts.find(
    (a) => a.stepId === step.id && a.status === "running"
  );
  if (!activeAttempt) return "";
  const ms = Math.max(0, Date.now() - Date.parse(activeAttempt.createdAt));
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function AgentPresencePanel({
  steps,
  attempts,
  selectedAgent,
  onSelectAgent,
  agentColors
}: AgentPresencePanelProps) {
  const sortedSteps = useMemo(() => {
    return [...steps].sort((a, b) => {
      const order: Record<string, number> = {
        running: 0,
        blocked: 1,
        pending: 2,
        ready: 3,
        succeeded: 4,
        failed: 5,
        skipped: 6,
        superseded: 7,
        canceled: 8
      };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });
  }, [steps]);

  return (
    <aside
      className="w-[180px] shrink-0 flex flex-col overflow-y-auto"
      style={{ background: COLORS.cardBg, borderRight: `1px solid ${COLORS.border}` }}
    >
      <div className="px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
        <div
          className="text-[9px] font-semibold uppercase tracking-wider"
          style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, letterSpacing: "1px" }}
        >
          AGENTS
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {sortedSteps.map((step) => {
          const statusInfo = STATUS_ICONS[step.status] ?? STATUS_ICONS.pending;
          const isSelected = selectedAgent === step.stepKey;
          const elapsed = formatStepElapsed(step, attempts);
          const agentColor = agentColors.get(step.stepKey) ?? COLORS.textMuted;

          return (
            <button
              key={step.id}
              onClick={() => onSelectAgent(step.stepKey)}
              className="w-full px-2 py-1.5 text-left transition-colors flex items-center gap-1.5"
              style={
                isSelected
                  ? { background: `${agentColor}12`, borderLeft: `3px solid ${agentColor}`, color: COLORS.textPrimary }
                  : { color: COLORS.textSecondary }
              }
              onMouseEnter={(e) => {
                if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              <span style={{ color: statusInfo.color, fontSize: "12px" }}>{statusInfo.icon}</span>
              <div className="flex-1 min-w-0">
                <div
                  className="truncate text-xs"
                  style={{ fontFamily: MONO_FONT }}
                >
                  {step.stepKey}
                </div>
                {elapsed && (
                  <div className="text-[9px]" style={{ color: COLORS.textDim }}>
                    {elapsed}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
