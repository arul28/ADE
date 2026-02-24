import React, { useState } from "react";
import {
  CheckCircle,
  Warning,
  CaretDown,
  CaretRight,
  Users,
  Stack,
  ArrowsClockwise,
  GitPullRequest,
  Shield
} from "@phosphor-icons/react";
import type {
  ExecutionPlanPreview as ExecutionPlanPreviewType,
  ExecutionPlanPhase,
  ExecutionPlanStepPreview,
  OrchestratorWorkerRole
} from "../../../shared/types";
/* ── Helpers ── */

const ROLE_BADGE_STYLES: Record<OrchestratorWorkerRole, React.CSSProperties> = {
  planning: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  implementation: { background: "#A78BFA18", color: "#A78BFA", border: "1px solid #A78BFA30" },
  testing: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  code_review: { background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430" },
  test_review: { background: "#14B8A618", color: "#14B8A6", border: "1px solid #14B8A630" },
  integration: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" },
  merge: { background: "#F9731618", color: "#F97316", border: "1px solid #F9731630" }
};

const ROLE_LABELS: Record<OrchestratorWorkerRole, string> = {
  planning: "PLANNING",
  implementation: "IMPLEMENTATION",
  testing: "TESTING",
  code_review: "CODE REVIEW",
  test_review: "TEST REVIEW",
  integration: "INTEGRATION",
  merge: "MERGE"
};

const EXECUTOR_BADGE_STYLES: Record<string, React.CSSProperties> = {
  claude: { background: "#A78BFA18", color: "#A78BFA" },
  codex: { background: "#22C55E18", color: "#22C55E" },
  shell: { background: "#F59E0B18", color: "#F59E0B" },
  manual: { background: "#3B82F618", color: "#3B82F6" }
};

const FALLBACK_ROLE_STYLE: React.CSSProperties = { background: "#1E1B26", color: "#71717A", border: "1px solid #27272A" };
const FALLBACK_EXECUTOR_STYLE: React.CSSProperties = { background: "#1E1B26", color: "#71717A" };

const badgeBase: React.CSSProperties = {
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 9,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
  padding: "3px 8px",
  borderRadius: 0
};

function RoleBadge({ role }: { role: OrchestratorWorkerRole }) {
  return (
    <span
      style={{
        ...badgeBase,
        ...(ROLE_BADGE_STYLES[role] ?? FALLBACK_ROLE_STYLE)
      }}
    >
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

/* ── Phase Row ── */

function PhaseSection({ phase }: { phase: ExecutionPlanPhase }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div style={{ background: "#0C0A10", border: "1px solid #1E1B26", borderRadius: 0 }}>
      <button
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors"
        style={{ background: hovered ? "#1A1720" : "transparent" }}
      >
        {expanded
          ? <CaretDown size={12} weight="regular" style={{ color: "#71717A", flexShrink: 0 }} />
          : <CaretRight size={12} weight="regular" style={{ color: "#71717A", flexShrink: 0 }} />
        }
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                fontWeight: 700,
                color: "#FAFAFA",
                textTransform: "uppercase",
                letterSpacing: "1px"
              }}
            >
              {phase.phase.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}
            </span>
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9,
                color: "#71717A"
              }}
            >
              {phase.stepCount} step{phase.stepCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            style={{
              ...badgeBase,
              ...(EXECUTOR_BADGE_STYLES[phase.executorKind] ?? FALLBACK_EXECUTOR_STYLE)
            }}
          >
            {phase.model !== "default" ? phase.model : phase.executorKind}
          </span>
          {phase.gatePolicy !== "none" && phase.gatePolicy !== "off" && (
            <span
              style={{
                ...badgeBase,
                background: "#3B82F618",
                color: "#3B82F6",
                border: "1px solid #3B82F630"
              }}
            >
              {phase.gatePolicy}
            </span>
          )}
          {phase.recoveryEnabled && (
            <ArrowsClockwise size={12} weight="regular" style={{ color: "#F59E0B" }} />
          )}
        </div>
      </button>

      {expanded && phase.steps.length > 0 && (
        <div className="px-2.5 py-1.5 space-y-1" style={{ borderTop: "1px solid #1E1B26" }}>
          {phase.steps.map((step) => (
            <StepRow key={step.stepKey} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Step Row ── */

function StepRow({ step }: { step: ExecutionPlanStepPreview }) {
  return (
    <div className="flex items-center gap-2 py-1 pl-5">
      <div className="flex-1 min-w-0">
        <div
          className="truncate"
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            color: "#FAFAFA"
          }}
        >
          {step.title}
        </div>
        {step.dependencies.length > 0 && (
          <div
            className="truncate"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 9,
              color: "#71717A"
            }}
          >
            depends on: {step.dependencies.join(", ")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <RoleBadge role={step.role} />
        <span
          style={{
            ...badgeBase,
            ...(EXECUTOR_BADGE_STYLES[step.executorKind] ?? FALLBACK_EXECUTOR_STYLE)
          }}
        >
          {step.executorKind}
        </span>
      </div>
    </div>
  );
}

/* ── Main Component ── */

type ExecutionPlanPreviewProps = {
  preview: ExecutionPlanPreviewType | null;
};

export function ExecutionPlanPreview({ preview }: ExecutionPlanPreviewProps) {
  if (!preview) {
    return (
      <div
        className="px-3 py-3 text-center"
        style={{ background: "#13101A", border: "1px solid #1E1B26", borderRadius: 0 }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 12,
            color: "#71717A"
          }}
        >
          No execution plan available
        </div>
      </div>
    );
  }

  const { strategy, teamSummary, phases, recoveryPolicy, integrationPrPlan, aligned, driftNotes } = preview;

  return (
    <div
      className="space-y-2.5 p-3"
      style={{ background: "#13101A", border: "1px solid #1E1B26", borderRadius: 0 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Stack size={14} weight="regular" style={{ color: "#A78BFA" }} />
          <span
            style={{
              fontFamily: "Space Grotesk, sans-serif",
              fontSize: 13,
              fontWeight: 700,
              color: "#FAFAFA"
            }}
          >
            Execution Plan
          </span>
        </div>
        {aligned ? (
          <span className="flex items-center gap-1">
            <CheckCircle size={12} weight="regular" style={{ color: "#22C55E" }} />
            <span
              style={{
                color: "#22C55E",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px"
              }}
            >
              ALIGNED
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Warning size={12} weight="regular" style={{ color: "#F59E0B" }} />
            <span
              style={{
                color: "#F59E0B",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px"
              }}
            >
              DRIFT DETECTED
            </span>
          </span>
        )}
      </div>

      {/* Strategy line */}
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
          color: "#A1A1AA",
          lineHeight: 1.5
        }}
      >
        {strategy}
      </div>

      {/* Team summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <Users size={12} weight="regular" style={{ color: "#71717A" }} />
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "#71717A"
            }}
          >
            {teamSummary.workerCount} worker{teamSummary.workerCount !== 1 ? "s" : ""}
          </span>
        </div>
        {teamSummary.parallelLanes > 0 && (
          <div className="flex items-center gap-1">
            <Stack size={12} weight="regular" style={{ color: "#71717A" }} />
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "#71717A"
              }}
            >
              {teamSummary.parallelLanes} lane{teamSummary.parallelLanes !== 1 ? "s" : ""}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1 flex-wrap">
          {teamSummary.roles.map((role) => (
            <RoleBadge key={role} role={role} />
          ))}
        </div>
      </div>

      {/* Phase list */}
      {phases.length > 0 && (
        <div className="space-y-1">
          {phases.map((phase) => (
            <PhaseSection key={phase.phase} phase={phase} />
          ))}
        </div>
      )}

      {/* Recovery policy */}
      {recoveryPolicy.enabled && (
        <div className="flex items-center gap-2">
          <Shield size={12} weight="regular" style={{ color: "#F59E0B", flexShrink: 0 }} />
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "#71717A"
            }}
          >
            Auto-recovery: up to {recoveryPolicy.maxIterations} iteration{recoveryPolicy.maxIterations !== 1 ? "s" : ""}
            {recoveryPolicy.onExhaustion !== "fail" && (
              <span style={{ marginLeft: 4, fontSize: 9 }}>
                (on exhaustion: {recoveryPolicy.onExhaustion.replace(/_/g, " ")})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Integration PR plan */}
      {integrationPrPlan.enabled && (
        <div className="flex items-center gap-2">
          <GitPullRequest size={12} weight="regular" style={{ color: "#22C55E", flexShrink: 0 }} />
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "#71717A"
            }}
          >
            Will create integration PR when complete
            {integrationPrPlan.draft && " (draft)"}
          </span>
        </div>
      )}

      {/* Drift notes */}
      {driftNotes.length > 0 && (
        <div
          className="px-2 py-1.5 space-y-0.5"
          style={{ background: "#F59E0B08", border: "1px solid #F59E0B30", borderRadius: 0 }}
        >
          <div
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#F59E0B",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            DRIFT NOTES
          </div>
          {driftNotes.map((note, i) => (
            <div
              key={i}
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9,
                color: "#F59E0B",
                opacity: 0.8
              }}
            >
              {note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
