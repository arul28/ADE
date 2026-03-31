import React from "react";
import {
  X,
  CircleNotch,
  CheckCircle,
  Warning,
  ChatText,
  CopySimple,
  ArrowsClockwise,
  Eye,
  Trash,
  ArrowUp,
  GitBranch,
  Play,
} from "@phosphor-icons/react";
import type { AiPermissionMode, PipelineSettings, PrCheck } from "../../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../../lanes/laneDesignTokens";
import { PrPipelineSettings } from "./PrPipelineSettings";
import { AgentChatPane } from "../../chat/AgentChatPane";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueItemSeverity = "critical" | "major" | "minor";
export type IssueItemSource = "coderabbit" | "codex" | "copilot" | "human" | "ade";
export type IssueItemState = "new" | "in_progress" | "fixed" | "dismissed" | "escalated";

export type IssueInventoryItem = {
  id: string;
  state: IssueItemState;
  severity: IssueItemSeverity;
  headline: string;
  filePath: string | null;
  line: number | null;
  source: IssueItemSource;
  dismissReason: string | null;
  agentSessionId: string | null;
};

export type ConvergenceStatus = {
  state: "not_started" | "converging" | "stalled" | "complete";
  currentRound: number;
  maxRounds: number;
};

export type PrConvergencePanelProps = {
  open: boolean;
  prNumber: number;
  prTitle: string;
  headBranch: string;
  baseBranch: string;
  items: IssueInventoryItem[];
  convergence: ConvergenceStatus;
  checks: PrCheck[];
  modelId: string;
  reasoningEffort: string;
  permissionMode: AiPermissionMode;
  busy: boolean;
  agentSessionId: string | null;
  autoConverge: boolean;
  pipelineSettings: PipelineSettings;
  onPipelineSettingsChange: (settings: Partial<PipelineSettings>) => void;
  onOpenChange: (open: boolean) => void;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: AiPermissionMode) => void;
  onRunNextRound: (additionalInstructions: string) => Promise<void>;
  onAutoConvergeChange: (enabled: boolean) => void;
  onCopyPrompt: (additionalInstructions: string) => Promise<void>;
  onMarkDismissed: (itemIds: string[], reason: string) => void;
  onMarkEscalated: (itemIds: string[]) => void;
  onResetInventory: () => void;
  pauseReason?: string | null;
  onResumePause?: () => void;
  onDismissPause?: () => void;
  convergenceMerged?: boolean;
  onDismissMerged?: () => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<IssueItemSeverity, string> = {
  critical: "#EF4444",
  major: "#F59E0B",
  minor: "#6B7280",
};

const SOURCE_META: Record<IssueItemSource, { label: string; color: string }> = {
  coderabbit: { label: "CR", color: "#22C55E" },
  codex: { label: "CX", color: "#3B82F6" },
  copilot: { label: "CP", color: "#A855F7" },
  human: { label: "HM", color: "#E5E7EB" },
  ade: { label: "ADE", color: "#A78BFA" },
};

const STATE_META: Record<
  IssueItemState,
  { label: string; accent: string; defaultExpanded: boolean; icon: React.ReactNode }
> = {
  new: {
    label: "Review Comments",
    accent: "#F59E0B",
    defaultExpanded: true,
    icon: <ChatText size={13} weight="fill" />,
  },
  in_progress: {
    label: "In Progress",
    accent: "#A78BFA",
    defaultExpanded: true,
    icon: <CircleNotch size={13} weight="bold" />,
  },
  fixed: {
    label: "Fixed",
    accent: "#22C55E",
    defaultExpanded: false,
    icon: <CheckCircle size={13} weight="fill" />,
  },
  dismissed: {
    label: "Dismissed",
    accent: "#6B7280",
    defaultExpanded: false,
    icon: <Trash size={13} />,
  },
  escalated: {
    label: "Escalated",
    accent: "#F97316",
    defaultExpanded: true,
    icon: <ArrowUp size={13} weight="bold" />,
  },
};

const STATE_ORDER: IssueItemState[] = ["escalated", "new", "in_progress", "fixed", "dismissed"];

const CONVERGENCE_STATUS_STYLE: Record<
  ConvergenceStatus["state"],
  { bg: string; color: string; borderColor: string; label: string; pulse: boolean }
> = {
  not_started: {
    bg: "rgba(107,114,128,0.12)",
    color: "#9CA3AF",
    borderColor: "rgba(107,114,128,0.25)",
    label: "Not started",
    pulse: false,
  },
  converging: {
    bg: "rgba(34,197,94,0.10)",
    color: "#4ADE80",
    borderColor: "rgba(34,197,94,0.30)",
    label: "Converging",
    pulse: true,
  },
  stalled: {
    bg: "rgba(245,158,11,0.10)",
    color: "#FBBF24",
    borderColor: "rgba(245,158,11,0.30)",
    label: "Stalled",
    pulse: false,
  },
  complete: {
    bg: "rgba(34,197,94,0.14)",
    color: "#22C55E",
    borderColor: "rgba(34,197,94,0.35)",
    label: "Complete",
    pulse: false,
  },
};

// ---------------------------------------------------------------------------
// Keyframes (injected once)
// ---------------------------------------------------------------------------

const STYLE_ID = "pr-convergence-panel-keyframes";

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes convergePulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
    @keyframes convergeSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes convergeSlideDown {
      from { opacity: 0; max-height: 0; }
      to { opacity: 1; max-height: 2000px; }
    }
    @keyframes convergeFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes convergeDotStep {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.35); }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RoundIndicator({ current, max }: { current: number; max: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 10,
          fontWeight: 700,
          color: COLORS.textSecondary,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        Round {current} of {max}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        {Array.from({ length: max }, (_, i) => {
          const isCurrent = i + 1 === current;
          const isComplete = i + 1 < current;
          let dotColor = "rgba(255,255,255,0.12)";
          if (isComplete) dotColor = COLORS.success;
          else if (isCurrent) dotColor = COLORS.accent;
          return (
            <div
              key={i}
              style={{
                width: isCurrent ? 8 : 6,
                height: isCurrent ? 8 : 6,
                borderRadius: 999,
                background: dotColor,
                border: isCurrent ? `1.5px solid ${COLORS.accent}` : "none",
                boxShadow: isCurrent ? `0 0 6px ${COLORS.accent}50` : "none",
                transition: "all 0.3s ease",
                animation: isCurrent ? "convergeDotStep 1.8s ease-in-out infinite" : "none",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ConvergenceStatusPill({ status }: { status: ConvergenceStatus["state"] }) {
  const meta = CONVERGENCE_STATUS_STYLE[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 10px",
        borderRadius: 999,
        background: meta.bg,
        border: `1px solid ${meta.borderColor}`,
        color: meta.color,
        fontFamily: MONO_FONT,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        animation: meta.pulse ? "convergePulse 2s ease-in-out infinite" : "none",
      }}
    >
      {meta.pulse ? (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: meta.color,
            boxShadow: `0 0 4px ${meta.color}`,
          }}
        />
      ) : null}
      {meta.label}
    </span>
  );
}

function StatsBar({ items }: { items: IssueInventoryItem[] }) {
  const counts: Record<IssueItemState, number> = { new: 0, in_progress: 0, fixed: 0, dismissed: 0, escalated: 0 };
  for (const item of items) {
    counts[item.state]++;
  }

  const stats: Array<{ label: string; count: number; color: string }> = [
    { label: "new", count: counts.new, color: "#F59E0B" },
    { label: "fixed", count: counts.fixed, color: "#22C55E" },
    { label: "dismissed", count: counts.dismissed, color: "#6B7280" },
    { label: "escalated", count: counts.escalated, color: "#F97316" },
  ];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "8px 16px",
        background: "rgba(255,255,255,0.015)",
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      {stats.map((stat) => (
        <div key={stat.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: stat.color,
              opacity: stat.count > 0 ? 1 : 0.3,
            }}
          />
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: stat.count > 0 ? COLORS.textPrimary : COLORS.textDim,
            }}
          >
            {stat.count}
          </span>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 10,
              color: COLORS.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {stat.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: IssueItemSeverity }) {
  const color = SEVERITY_COLORS[severity];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 7px",
        borderRadius: 4,
        background: `${color}18`,
        color,
        fontFamily: MONO_FONT,
        fontSize: 9,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {severity}
    </span>
  );
}

function SourceTag({ source }: { source: IssueItemSource }) {
  const meta = SOURCE_META[source];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 6px",
        borderRadius: 4,
        background: `${meta.color}14`,
        color: meta.color,
        fontFamily: MONO_FONT,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.04em",
      }}
    >
      {meta.label}
    </span>
  );
}

function IssueRow({
  item,
  showAgent,
}: {
  item: IssueInventoryItem;
  showAgent?: boolean;
}) {
  let location: string | null = null;
  if (item.filePath) {
    location = item.line != null ? `${item.filePath}:${item.line}` : item.filePath;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${COLORS.border}`,
        animation: "convergeFadeIn 0.25s ease-out",
      }}
    >
      <SeverityBadge severity={item.severity} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.textPrimary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.headline}
        </div>
        {location ? (
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: COLORS.textMuted,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {location}
          </div>
        ) : null}
      </div>
      {showAgent && item.agentSessionId ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 7px",
            borderRadius: 4,
            background: `${COLORS.accent}14`,
            color: COLORS.accent,
            fontFamily: MONO_FONT,
            fontSize: 9,
          }}
        >
          <CircleNotch size={10} weight="bold" style={{ animation: "convergeSpin 1s linear infinite" }} />
          agent
        </span>
      ) : null}
      {item.state === "fixed" ? (
        <CheckCircle size={15} weight="fill" style={{ color: COLORS.success, flexShrink: 0 }} />
      ) : null}
      <SourceTag source={item.source} />
    </div>
  );
}

function FixedRow({ item }: { item: IssueInventoryItem }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 6,
        background: "rgba(255,255,255,0.01)",
      }}
    >
      <CheckCircle size={13} weight="fill" style={{ color: COLORS.success, flexShrink: 0 }} />
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          color: COLORS.textSecondary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {item.headline}
      </span>
      <SourceTag source={item.source} />
    </div>
  );
}

function DismissedRow({ item }: { item: IssueInventoryItem }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 6,
        background: "rgba(255,255,255,0.01)",
        opacity: 0.65,
      }}
      title={item.dismissReason ?? undefined}
    >
      <Trash size={12} style={{ color: COLORS.textDim, flexShrink: 0 }} />
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          color: COLORS.textMuted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {item.headline}
      </span>
      {item.dismissReason ? (
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 9,
            color: COLORS.textDim,
            flexShrink: 0,
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.dismissReason}
        </span>
      ) : null}
    </div>
  );
}

function CheckRow({ check }: { check: PrCheck }) {
  const isPassing = check.conclusion === "success";
  const isFailing = check.conclusion === "failure";
  const isRunning = check.status === "in_progress";
  let statusColor: string = COLORS.textDim;
  if (isPassing) statusColor = COLORS.success;
  else if (isFailing) statusColor = COLORS.danger;
  else if (isRunning) statusColor = COLORS.warning;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 12px",
        borderRadius: 6,
        background: "rgba(255,255,255,0.015)",
      }}
    >
      {isRunning ? (
        <CircleNotch
          size={13}
          weight="bold"
          style={{ color: statusColor, animation: "convergeSpin 1s linear infinite", flexShrink: 0 }}
        />
      ) : isPassing ? (
        <CheckCircle size={13} weight="fill" style={{ color: statusColor, flexShrink: 0 }} />
      ) : isFailing ? (
        <Warning size={13} weight="fill" style={{ color: statusColor, flexShrink: 0 }} />
      ) : (
        <Eye size={13} style={{ color: statusColor, flexShrink: 0 }} />
      )}
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          fontWeight: 500,
          color: COLORS.textPrimary,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {check.name}
      </span>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 9,
          fontWeight: 700,
          color: statusColor,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {isRunning ? "running" : check.conclusion ?? check.status}
      </span>
    </div>
  );
}

function AutoConvergeSwitch({
  enabled,
  onChange,
  remainingRounds,
  disabled,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  remainingRounds: number;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        style={{
          position: "relative",
          width: 36,
          height: 20,
          borderRadius: 999,
          border: `1px solid ${enabled ? `${COLORS.accent}50` : COLORS.border}`,
          background: enabled ? `${COLORS.accent}30` : "rgba(255,255,255,0.04)",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: 0,
          transition: "all 0.25s ease",
          opacity: disabled ? 0.45 : 1,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: 999,
            background: enabled ? COLORS.accent : COLORS.textMuted,
            boxShadow: enabled ? `0 0 6px ${COLORS.accent}40` : "none",
            transition: "all 0.25s ease",
          }}
        />
      </button>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontWeight: 600,
            color: enabled ? COLORS.textPrimary : COLORS.textMuted,
          }}
        >
          Auto-Converge
        </span>
        {enabled ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.accent }}>
            Will auto-run up to {remainingRounds} more round{remainingRounds !== 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PrConvergencePanel({
  open,
  prNumber,
  prTitle,
  headBranch,
  baseBranch,
  items,
  convergence,
  checks,
  modelId,
  reasoningEffort,
  permissionMode,
  busy,
  agentSessionId,
  autoConverge,
  pipelineSettings,
  onPipelineSettingsChange,
  onOpenChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onRunNextRound,
  onAutoConvergeChange,
  onCopyPrompt,
  onMarkDismissed: _onMarkDismissed,
  onMarkEscalated: _onMarkEscalated,
  onResetInventory: _onResetInventory,
  pauseReason,
  onResumePause,
  onDismissPause,
  convergenceMerged,
  onDismissMerged,
}: PrConvergencePanelProps) {
  const [additionalInstructions, setAdditionalInstructions] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    ensureKeyframes();
  }, []);

  React.useEffect(() => {
    if (open) {
      setAdditionalInstructions("");
    }
  }, [open]);

  if (!open) return null;

  // Group items by state
  const grouped: Record<IssueItemState, IssueInventoryItem[]> = {
    new: [],
    in_progress: [],
    fixed: [],
    dismissed: [],
    escalated: [],
  };
  for (const item of items) {
    grouped[item.state].push(item);
  }

  const reviewCommentItems = [...grouped.escalated, ...grouped.new, ...grouped.in_progress, ...grouped.fixed, ...grouped.dismissed];
  const failingChecks = checks.filter((c) => c.conclusion === "failure");
  const runningChecks = checks.filter((c) => c.status === "in_progress");
  const allChecksPassing = failingChecks.length === 0 && runningChecks.length === 0;
  const passingChecks = checks.filter((c) => c.conclusion === "success");
  const otherChecks = checks.filter(
    (c) => c.conclusion !== "failure" && c.conclusion !== "success" && c.status !== "in_progress",
  );
  const orderedChecks = [...failingChecks, ...runningChecks, ...otherChecks, ...passingChecks];

  const hasNewItems = grouped.new.length > 0;
  const atMaxRounds = convergence.currentRound >= convergence.maxRounds;
  const canRunNext = hasNewItems && !atMaxRounds && !busy;
  const remainingRounds = Math.max(0, convergence.maxRounds - convergence.currentRound);

  const truncatedTitle =
    prTitle.length > 60 ? `${prTitle.slice(0, 59)}...` : prTitle;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3, 4, 10, 0.78)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 140,
        overflowY: "auto",
        padding: "32px 20px",
      }}
      onClick={() => {
        if (!busy) onOpenChange(false);
      }}
    >
      <div
        ref={scrollRef}
        role="dialog"
        aria-modal="true"
        aria-label="Path to Merge"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1200px, calc(100vw - 40px))",
          maxHeight: "min(800px, calc(100vh - 64px))",
          display: "flex",
          flexDirection: "column",
          background: "#0F0D14",
          border: `1px solid rgba(255,255,255,0.07)`,
          borderRadius: 18,
          boxShadow: "0 40px 120px rgba(0,0,0,0.7), 0 0 1px rgba(255,255,255,0.08) inset",
          overflow: "hidden",
          animation: "convergeFadeIn 0.2s ease-out",
        }}
      >
        {/* ---- Header ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            padding: "18px 20px 14px",
            borderBottom: `1px solid ${COLORS.border}`,
            background: "linear-gradient(180deg, rgba(15,13,20,1) 0%, rgba(15,13,20,0.95) 100%)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 10,
                  fontWeight: 800,
                  color: COLORS.accent,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                }}
              >
                Path to Merge
              </span>
              {autoConverge && (
                <>
                  <span
                    style={{
                      width: 1,
                      height: 12,
                      background: "rgba(255,255,255,0.08)",
                    }}
                  />
                  <RoundIndicator current={convergence.currentRound} max={pipelineSettings.maxRounds} />
                  <ConvergenceStatusPill status={convergence.state} />
                </>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: `${COLORS.accent}14`,
                  color: COLORS.accent,
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                #{prNumber}
              </span>
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  color: COLORS.textPrimary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 400,
                }}
              >
                {truncatedTitle}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <GitBranch size={12} style={{ color: COLORS.textDim }} />
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                {headBranch}
              </span>
              <span style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim }}>
                into
              </span>
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                {baseBranch}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.03)",
              cursor: busy ? "default" : "pointer",
              color: COLORS.textMuted,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "all 0.15s ease",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* ---- Stats bar ---- */}
        <StatsBar items={items} />

        {/* ---- Three-column body ---- */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 300px",
            gap: 16,
            flex: 1,
            minHeight: 0,
            padding: "16px 20px",
            overflow: "hidden",
          }}
        >
          {/* Left: Review Comments */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.015)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderBottom: `1px solid ${COLORS.border}`,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <ChatText size={14} weight="fill" style={{ color: "#F59E0B" }} />
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  fontWeight: 700,
                  color: COLORS.textPrimary,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Review Comments
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: "#F59E0B",
                }}
              >
                {reviewCommentItems.length}
              </span>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
              {reviewCommentItems.length > 0 ? (
                <>
                  {STATE_ORDER.map((state) => {
                    const stateItems = grouped[state];
                    if (stateItems.length === 0) return null;
                    const meta = STATE_META[state];
                    return (
                      <div key={state} style={{ marginBottom: 8 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 4px",
                            borderBottom: `1px solid ${meta.accent}20`,
                            marginBottom: 4,
                          }}
                        >
                          <span style={{ color: meta.accent, display: "inline-flex", alignItems: "center" }}>
                            {state === "in_progress" ? (
                              <span style={{ animation: "convergeSpin 1.2s linear infinite", display: "inline-flex" }}>
                                {meta.icon}
                              </span>
                            ) : (
                              meta.icon
                            )}
                          </span>
                          <span
                            style={{
                              fontFamily: SANS_FONT,
                              fontSize: 10,
                              fontWeight: 700,
                              color: meta.accent,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                            }}
                          >
                            {meta.label}
                          </span>
                          <span
                            style={{
                              marginLeft: "auto",
                              fontFamily: MONO_FONT,
                              fontSize: 9,
                              fontWeight: 600,
                              color: meta.accent,
                            }}
                          >
                            {stateItems.length}
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {stateItems.map((item) => {
                            if (state === "fixed") return <FixedRow key={item.id} item={item} />;
                            if (state === "dismissed") return <DismissedRow key={item.id} item={item} />;
                            return <IssueRow key={item.id} item={item} showAgent={state === "in_progress"} />;
                          })}
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                <div
                  style={{
                    padding: "28px 16px",
                    textAlign: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      color: COLORS.textMuted,
                      lineHeight: 1.6,
                    }}
                  >
                    No issues have been inventoried yet. Run the first round to discover issues from review comments.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Middle: CI Checks */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "rgba(255,255,255,0.015)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderBottom: `1px solid ${COLORS.border}`,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Play size={14} weight="fill" style={{ color: allChecksPassing ? COLORS.success : COLORS.danger }} />
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  fontWeight: 700,
                  color: COLORS.textPrimary,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                CI Checks
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: allChecksPassing ? COLORS.success : COLORS.danger,
                }}
              >
                {allChecksPassing ? "all passing" : `${failingChecks.length} failing`}
              </span>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
              {orderedChecks.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {orderedChecks.map((check) => (
                    <CheckRow key={check.name} check={check} />
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    padding: "28px 16px",
                    textAlign: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 12,
                      color: COLORS.textMuted,
                      lineHeight: 1.6,
                    }}
                  >
                    No CI checks found.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Settings column */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              minHeight: 0,
              overflow: "auto",
            }}
          >
            {/* Pipeline Settings */}
            <div
              style={{
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                background: "rgba(255,255,255,0.015)",
                padding: 14,
              }}
            >
              <div
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 10,
                  fontWeight: 700,
                  color: COLORS.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 10,
                }}
              >
                Pipeline Settings
              </div>
              <PrPipelineSettings
                settings={pipelineSettings}
                onSettingsChange={onPipelineSettingsChange}
                autoConverge={autoConverge}
                onAutoConvergeChange={onAutoConvergeChange}
                modelId={modelId}
                reasoningEffort={reasoningEffort}
                permissionMode={permissionMode}
                onModelChange={onModelChange}
                onReasoningEffortChange={onReasoningEffortChange}
                onPermissionModeChange={onPermissionModeChange}
                disabled={busy}
              />
            </div>

            {/* Additional Instructions */}
            <div
              style={{
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                background: "rgba(255,255,255,0.015)",
                padding: 14,
              }}
            >
              <div
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 10,
                  fontWeight: 700,
                  color: COLORS.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 6,
                }}
              >
                Additional Instructions
              </div>
              <div
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  color: COLORS.textMuted,
                  marginBottom: 8,
                  lineHeight: 1.5,
                }}
              >
                Add custom instructions that will be injected into the agent&apos;s prompt for this round. Use this to guide the agent&apos;s approach or add context.
              </div>
              <textarea
                value={additionalInstructions}
                onChange={(e) => setAdditionalInstructions(e.target.value)}
                placeholder="Add instructions for this round..."
                disabled={busy}
                style={{
                  width: "100%",
                  minHeight: 64,
                  resize: "vertical",
                  padding: 10,
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: "rgba(255,255,255,0.02)",
                  color: COLORS.textPrimary,
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  lineHeight: 1.6,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* Agent session embed */}
            {agentSessionId ? (
              <div
                style={{
                  border: `1px solid ${COLORS.accentBorder}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  minHeight: 200,
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                }}
              >
                <div
                  style={{
                    padding: "8px 12px",
                    background: `${COLORS.accent}08`,
                    borderBottom: `1px solid ${COLORS.border}`,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <CircleNotch
                    size={12}
                    weight="bold"
                    style={{ color: COLORS.accent, animation: "convergeSpin 1s linear infinite" }}
                  />
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 10,
                      fontWeight: 700,
                      color: COLORS.accent,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Agent Session
                  </span>
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <AgentChatPane
                    laneId={null}
                    lockSessionId={agentSessionId}
                    hideSessionTabs
                    availableModelIdsOverride={[modelId]}
                    modelSelectionLocked
                    permissionModeLocked
                    presentation={{
                      mode: "resolver",
                      title: "Convergence Round",
                      subtitle: `Round ${convergence.currentRound} of ${convergence.maxRounds}`,
                      accentColor: COLORS.accent,
                      chips: [
                        { label: modelId, tone: "accent" },
                        { label: `round ${convergence.currentRound}`, tone: "warning" },
                      ],
                      showMcpStatus: false,
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* ---- Pause banner (rebase needed) ---- */}
        {pauseReason ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 20px",
              background: "rgba(245, 158, 11, 0.08)",
              borderTop: `1px solid rgba(245, 158, 11, 0.25)`,
              borderBottom: `1px solid rgba(245, 158, 11, 0.15)`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
              <Warning size={16} weight="fill" style={{ color: "#F59E0B", flexShrink: 0 }} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: "#F59E0B", lineHeight: 1.4 }}>
                Paused: {pauseReason}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {onResumePause && (
                <button
                  type="button"
                  onClick={onResumePause}
                  style={outlineButton({
                    height: 28,
                    padding: "0 10px",
                    borderRadius: 6,
                    color: "#F59E0B",
                    borderColor: "rgba(245, 158, 11, 0.30)",
                    fontSize: 11,
                  })}
                >
                  <span style={{ fontFamily: SANS_FONT, fontSize: 11 }}>Resume</span>
                </button>
              )}
              {onDismissPause && (
                <button
                  type="button"
                  onClick={onDismissPause}
                  style={outlineButton({
                    height: 28,
                    padding: "0 10px",
                    borderRadius: 6,
                    color: COLORS.textDim,
                    borderColor: `${COLORS.border}`,
                    fontSize: 11,
                  })}
                >
                  <span style={{ fontFamily: SANS_FONT, fontSize: 11 }}>Dismiss</span>
                </button>
              )}
            </div>
          </div>
        ) : null}

        {/* ---- Merged celebration banner ---- */}
        {convergenceMerged ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 20px",
              background: "rgba(34, 197, 94, 0.08)",
              borderTop: `1px solid rgba(34, 197, 94, 0.25)`,
              borderBottom: `1px solid rgba(34, 197, 94, 0.15)`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
              <CheckCircle size={16} weight="fill" style={{ color: "#22C55E", flexShrink: 0 }} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: "#22C55E", fontWeight: 600, lineHeight: 1.4 }}>
                Merged! PR was auto-merged after convergence completed.
              </span>
            </div>
            {onDismissMerged && (
              <button
                type="button"
                onClick={onDismissMerged}
                style={outlineButton({
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 6,
                  color: COLORS.textDim,
                  borderColor: `${COLORS.border}`,
                  fontSize: 11,
                })}
              >
                <span style={{ fontFamily: SANS_FONT, fontSize: 11 }}>Dismiss</span>
              </button>
            )}
          </div>
        ) : null}

        {/* ---- Sticky action bar ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 20px",
            borderTop: `1px solid ${COLORS.border}`,
            background: "linear-gradient(180deg, rgba(15,13,20,0.96) 0%, rgba(15,13,20,1) 100%)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {autoConverge && (
              <span style={{
                fontFamily: MONO_FONT,
                fontSize: 9,
                fontWeight: 700,
                color: COLORS.accent,
                background: `${COLORS.accent}14`,
                border: `1px solid ${COLORS.accent}30`,
                borderRadius: 4,
                padding: "3px 7px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}>
                Auto-Converge
              </span>
            )}
            {pipelineSettings.autoMerge && (
              <span style={{
                fontFamily: MONO_FONT,
                fontSize: 9,
                fontWeight: 700,
                color: "#22C55E",
                background: "rgba(34, 197, 94, 0.10)",
                border: "1px solid rgba(34, 197, 94, 0.25)",
                borderRadius: 4,
                padding: "3px 7px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}>
                Auto-Merge
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onCopyPrompt(additionalInstructions)}
              style={outlineButton({
                height: 34,
                padding: "0 12px",
                borderRadius: 8,
                color: COLORS.info,
                borderColor: `${COLORS.info}30`,
                opacity: busy ? 0.45 : 1,
              })}
            >
              <CopySimple size={13} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 11 }}>Copy Prompt</span>
            </button>
            <button
              type="button"
              disabled={!canRunNext}
              onClick={() => void onRunNextRound(additionalInstructions)}
              style={primaryButton({
                height: 34,
                padding: "0 16px",
                borderRadius: 8,
                opacity: canRunNext ? 1 : 0.45,
                background: canRunNext ? COLORS.accent : "rgba(255,255,255,0.06)",
                color: canRunNext ? "#0F0D14" : COLORS.textDim,
                fontWeight: 700,
              })}
            >
              {busy ? (
                <CircleNotch size={13} weight="bold" style={{ animation: "convergeSpin 1s linear infinite" }} />
              ) : (
                <ArrowsClockwise size={13} weight="bold" />
              )}
              <span style={{ fontFamily: SANS_FONT, fontSize: 11 }}>
                {busy ? "Running..." : autoConverge ? `Start Round ${convergence.currentRound}` : "Launch Agent"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
