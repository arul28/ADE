import React from "react";
import {
  ArrowsClockwise,
  ArrowSquareOut,
  ArrowUp,
  ChatText,
  CheckCircle,
  CircleNotch,
  CopySimple,
  Eye,
  GitBranch,
  Play,
  Sparkle,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type {
  AiPermissionMode,
  ConvergenceStatus,
  IssueInventoryItem,
  IssueInventorySnapshot,
  IssueInventoryState,
  PipelineSettings,
  PrCheck,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
import { PrPipelineSettings } from "./PrPipelineSettings";
import { PrResolverLaunchControls } from "./PrResolverLaunchControls";

export type PathToMergeRuntimeState = {
  phase: "idle" | "launching" | "working" | "polling" | "paused" | "converged" | "merged" | "stopped" | "error";
  currentRound: number;
  maxRounds: number;
  autoConverge: boolean;
  agentSessionId: string | null;
  sessionHref: string | null;
  sessionLaneId: string | null;
  pauseReason: string | null;
  pollerPhase: "idle" | "waiting_checks" | "waiting_comments" | "polling" | "paused";
};

export type PrConvergencePanelProps = {
  prNumber: number;
  prTitle: string;
  headBranch: string;
  baseBranch: string;
  snapshot: IssueInventorySnapshot | null;
  checks: PrCheck[];
  runtime: PathToMergeRuntimeState;
  modelId: string;
  reasoningEffort: string;
  permissionMode: AiPermissionMode;
  busy: boolean;
  additionalInstructions: string;
  onAdditionalInstructionsChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: AiPermissionMode) => void;
  onAutoConvergeChange: (enabled: boolean) => void;
  onLaunchAgent: (additionalInstructions: string) => Promise<void>;
  onStartNextRound: (additionalInstructions: string) => Promise<void>;
  onCopyPrompt: (additionalInstructions: string) => Promise<void>;
  onStop: () => Promise<void> | void;
  onViewSession?: (href: string) => void;
  onMarkDismissed: (itemIds: string[], reason: string) => void;
  onMarkEscalated: (itemIds: string[]) => void;
  onResetInventory: () => void;
  pipelineSettings: PipelineSettings;
  onPipelineSettingsChange: (settings: Partial<PipelineSettings>) => void;
};

type ItemGroupKey = IssueInventoryState | "sent_to_agent";

const SOURCE_META: Record<string, { label: string; color: string }> = {
  coderabbit: { label: "CodeRabbit", color: "#22C55E" },
  codex: { label: "Codex", color: "#3B82F6" },
  copilot: { label: "Copilot", color: "#A855F7" },
  ade: { label: "ADE", color: "#A78BFA" },
  human: { label: "Human", color: "#E5E7EB" },
  unknown: { label: "Unknown", color: "#9CA3AF" },
};

const STATE_META: Record<ItemGroupKey, { label: string; accent: string; icon: React.ReactNode }> = {
  new: { label: "New", accent: "#F59E0B", icon: <ChatText size={13} weight="fill" /> },
  sent_to_agent: { label: "Working", accent: "#A78BFA", icon: <CircleNotch size={13} weight="bold" /> },
  fixed: { label: "Fixed", accent: "#22C55E", icon: <CheckCircle size={13} weight="fill" /> },
  dismissed: { label: "Dismissed", accent: "#6B7280", icon: <Trash size={13} /> },
  escalated: { label: "Escalated", accent: "#F97316", icon: <ArrowUp size={13} weight="bold" /> },
};

const STATE_ORDER: ItemGroupKey[] = ["escalated", "new", "sent_to_agent", "fixed", "dismissed"];

const STATUS_META: Record<PathToMergeRuntimeState["phase"], { label: string; color: string; background: string; border: string }> = {
  idle: { label: "Idle", color: COLORS.textMuted, background: "rgba(255,255,255,0.03)", border: COLORS.border },
  launching: { label: "Launching", color: COLORS.warning, background: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)" },
  working: { label: "Agent working", color: COLORS.accent, background: `${COLORS.accent}10`, border: `${COLORS.accent}25` },
  polling: { label: "Polling for replies", color: COLORS.warning, background: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)" },
  paused: { label: "Paused", color: "#F59E0B", background: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)" },
  converged: { label: "Converged", color: COLORS.success, background: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.25)" },
  merged: { label: "Merged", color: COLORS.success, background: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.25)" },
  stopped: { label: "Stopped", color: COLORS.textDim, background: "rgba(255,255,255,0.02)", border: COLORS.border },
  error: { label: "Error", color: COLORS.danger, background: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)" },
};

function itemState(item: IssueInventoryItem): ItemGroupKey {
  return item.state;
}

function groupItems(items: IssueInventoryItem[]): Record<ItemGroupKey, IssueInventoryItem[]> {
  const grouped: Record<ItemGroupKey, IssueInventoryItem[]> = {
    new: [],
    sent_to_agent: [],
    fixed: [],
    dismissed: [],
    escalated: [],
  };
  for (const item of items) {
    grouped[itemState(item)].push(item);
  }
  return grouped;
}

function formatLocation(item: IssueInventoryItem): string | null {
  if (!item.filePath) return null;
  return item.line != null ? `${item.filePath}:${item.line}` : item.filePath;
}

function bodyPreview(body: string | null): string | null {
  const value = (body ?? "").trim();
  if (!value) return null;
  return value.replace(/\s+/g, " ");
}

function itemSummary(item: IssueInventoryItem): string {
  const latestAuthor = item.threadLatestCommentAuthor ?? item.author;
  if (!latestAuthor) return "Latest reply";
  return `Latest reply by ${latestAuthor}`;
}

function sourceMeta(source: string | null | undefined): { label: string; color: string } {
  if (!source) return SOURCE_META.unknown;
  return SOURCE_META[source] ?? { label: source, color: COLORS.textMuted };
}

function displaySourceMeta(item: IssueInventoryItem): { label: string; color: string } {
  if (item.source !== "unknown" && item.source !== "human") return sourceMeta(item.source);
  const author = (item.threadLatestCommentAuthor ?? item.author ?? "").trim();
  if (!author) return sourceMeta(item.source);
  return {
    label: author.replace(/\[bot\]$/i, ""),
    color: item.source === "human" ? SOURCE_META.human.color : COLORS.textMuted,
  };
}

function StatusPill({ phase }: { phase: PathToMergeRuntimeState["phase"] }) {
  const meta = STATUS_META[phase];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 6,
        border: `1px solid ${meta.border}`,
        background: meta.background,
        color: meta.color,
        fontFamily: MONO_FONT,
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {phase === "working" || phase === "polling" || phase === "launching" ? (
        <CircleNotch size={11} weight="bold" style={{ animation: "ptmSpin 1s linear infinite" }} />
      ) : null}
      {meta.label}
    </span>
  );
}

function RuntimeSummary({
  runtime,
  convergence,
}: {
  runtime: PathToMergeRuntimeState;
  convergence: ConvergenceStatus | null;
}) {
  const currentRound = runtime.currentRound > 0 ? runtime.currentRound : convergence?.currentRound ?? 0;
  const maxRounds = runtime.maxRounds > 0 ? runtime.maxRounds : convergence?.maxRounds ?? 5;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        padding: "10px 12px",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <span style={inlineBadge(COLORS.textSecondary, { background: "rgba(255,255,255,0.03)" })}>
        Round {currentRound || 0} of {maxRounds}
      </span>
      <StatusPill phase={runtime.phase} />
      {runtime.autoConverge ? (
        <span style={inlineBadge(COLORS.accent, { background: `${COLORS.accent}10` })}>Auto-converge</span>
      ) : (
        <span style={inlineBadge(COLORS.textMuted, { background: "rgba(255,255,255,0.03)" })}>Manual launch</span>
      )}
      {runtime.pauseReason ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: "#F59E0B" }}>{runtime.pauseReason}</span>
      ) : null}
    </div>
  );
}

function SummaryCounts({ items }: { items: IssueInventoryItem[] }) {
  const grouped = groupItems(items);
  const counts: Array<{ key: ItemGroupKey; color: string }> = [
    { key: "new", color: "#F59E0B" },
    { key: "sent_to_agent", color: "#A78BFA" },
    { key: "fixed", color: "#22C55E" },
    { key: "dismissed", color: "#6B7280" },
    { key: "escalated", color: "#F97316" },
  ];
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {counts.map((entry) => (
        <span
          key={entry.key}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 8px",
            borderRadius: 6,
            border: `1px solid ${COLORS.border}`,
            background: "rgba(255,255,255,0.02)",
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.textSecondary,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: entry.color,
              opacity: grouped[entry.key].length > 0 ? 1 : 0.35,
            }}
          />
          {STATE_META[entry.key].label}
          <strong style={{ color: COLORS.textPrimary }}>{grouped[entry.key].length}</strong>
        </span>
      ))}
    </div>
  );
}

function InventoryRow({
  item,
  busy,
  onDismiss,
  onEscalate,
}: {
  item: IssueInventoryItem;
  busy: boolean;
  onDismiss: (itemId: string) => void;
  onEscalate: (itemId: string) => void;
}) {
  const meta = displaySourceMeta(item);
  const preview = bodyPreview(item.body);
  const location = formatLocation(item);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${COLORS.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 7px",
            borderRadius: 6,
            background: `${meta.color}14`,
            color: meta.color,
            fontFamily: MONO_FONT,
            fontSize: 9,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            flexShrink: 0,
          }}
        >
          {meta.label}
        </span>
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            color: COLORS.textPrimary,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
          title={item.headline}
        >
          {item.headline}
        </div>
        {item.state === "sent_to_agent" ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 7px",
              borderRadius: 6,
              background: `${COLORS.accent}10`,
              color: COLORS.accent,
              fontFamily: MONO_FONT,
              fontSize: 9,
              fontWeight: 700,
            }}
          >
            <CircleNotch size={10} weight="bold" style={{ animation: "ptmSpin 1s linear infinite" }} />
            working
          </span>
        ) : null}
      </div>

      {preview ? (
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            lineHeight: 1.55,
            color: COLORS.textSecondary,
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 3,
            overflow: "hidden",
          }}
        >
          {preview}
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>{itemSummary(item)}</span>
        {location ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>{location}</span>
        ) : null}
        {item.dismissReason ? (
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              color: COLORS.textMuted,
              paddingLeft: 8,
              borderLeft: `1px solid ${COLORS.border}`,
            }}
            title={item.dismissReason}
          >
            {item.dismissReason}
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          disabled={busy || item.state === "fixed" || item.state === "dismissed"}
          style={outlineButton({
            height: 28,
            padding: "0 10px",
            borderRadius: 8,
            opacity: busy || item.state === "fixed" || item.state === "dismissed" ? 0.5 : 1,
          })}
        >
          <Trash size={12} />
          Dismiss
        </button>
        <button
          type="button"
          onClick={() => onEscalate(item.id)}
          disabled={busy || item.state === "fixed" || item.state === "dismissed" || item.state === "escalated"}
          style={outlineButton({
            height: 28,
            padding: "0 10px",
            borderRadius: 8,
            color: "#F97316",
            opacity: busy || item.state === "fixed" || item.state === "dismissed" || item.state === "escalated" ? 0.5 : 1,
          })}
        >
          <ArrowUp size={12} weight="bold" />
          Escalate
        </button>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  accent,
  icon,
}: {
  title: string;
  count: number;
  accent: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 2px 8px",
        borderBottom: `1px solid ${accent}22`,
        marginBottom: 8,
      }}
    >
      <span style={{ color: accent, display: "inline-flex", alignItems: "center" }}>{icon}</span>
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 10,
          fontWeight: 700,
          color: accent,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {title}
      </span>
      <span style={{ marginLeft: "auto", fontFamily: MONO_FONT, fontSize: 10, color: accent }}>{count}</span>
    </div>
  );
}

function CheckRow({ check }: { check: PrCheck }) {
  const isPassing = check.conclusion === "success";
  const isFailing = check.conclusion === "failure";
  const isRunning = check.status === "in_progress" || check.status === "queued";
  const color = isPassing ? COLORS.success : isFailing ? COLORS.danger : isRunning ? COLORS.warning : COLORS.textDim;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${COLORS.border}`,
      }}
    >
      {isRunning ? (
        <CircleNotch size={13} weight="bold" style={{ color, animation: "ptmSpin 1s linear infinite", flexShrink: 0 }} />
      ) : isPassing ? (
        <CheckCircle size={13} weight="fill" style={{ color, flexShrink: 0 }} />
      ) : isFailing ? (
        <Warning size={13} weight="fill" style={{ color, flexShrink: 0 }} />
      ) : (
        <Eye size={13} style={{ color, flexShrink: 0 }} />
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: SANS_FONT,
          fontSize: 12,
          color: COLORS.textPrimary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {check.name}
      </div>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 9,
          fontWeight: 700,
          color,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {isRunning ? "running" : check.conclusion ?? check.status}
      </span>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        padding: "20px 16px",
        border: `1px dashed ${COLORS.border}`,
        borderRadius: 10,
        background: "rgba(255,255,255,0.015)",
      }}
    >
      <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 4 }}>{title}</div>
      <div style={{ fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.55, color: COLORS.textMuted }}>{description}</div>
    </div>
  );
}

export function PrConvergencePanel({
  prNumber,
  prTitle,
  headBranch,
  baseBranch,
  snapshot,
  checks,
  runtime,
  modelId,
  reasoningEffort,
  permissionMode,
  busy,
  additionalInstructions,
  onAdditionalInstructionsChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onAutoConvergeChange,
  onLaunchAgent,
  onStartNextRound,
  onCopyPrompt,
  onStop,
  onViewSession,
  onMarkDismissed,
  onMarkEscalated,
  onResetInventory,
  pipelineSettings,
  onPipelineSettingsChange,
}: PrConvergencePanelProps) {
  React.useEffect(() => {
    const styleId = "ptm-convergence-keyframes";
    if (typeof document === "undefined" || document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes ptmSpin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }, []);

  const items = snapshot?.items ?? [];
  const grouped = React.useMemo(() => groupItems(items), [items]);
  const convergence = snapshot?.convergence ?? null;
  const failingChecks = checks.filter((check) => check.conclusion === "failure");
  const pendingChecks = checks.filter((check) => check.status === "queued" || check.status === "in_progress");
  const allChecksPassing = checks.length > 0 && failingChecks.length === 0 && pendingChecks.length === 0;
  const hasNewItems = grouped.new.length > 0;
  const sessionActive = runtime.phase === "launching" || runtime.phase === "working" || runtime.phase === "polling";
  const actionDisabled = busy || sessionActive || !hasNewItems;
  const actionLabel = busy || sessionActive
    ? runtime.phase === "launching"
      ? "Launching..."
      : "Working..."
    : runtime.autoConverge
      ? "Start Next Round"
      : "Launch Agent";
  const actionIcon = busy || sessionActive ? <CircleNotch size={13} weight="bold" style={{ animation: "ptmSpin 1s linear infinite" }} /> : <ArrowsClockwise size={13} weight="bold" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", gap: 12, padding: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 13,
                  color: COLORS.accent,
                  fontWeight: 700,
                }}
              >
                #{prNumber}
              </span>
              <span
                style={{
                  fontFamily: SANS_FONT,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COLORS.textPrimary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {prTitle}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                {headBranch}
              </span>
              <span style={{ color: COLORS.textDim }}>into</span>
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                {baseBranch}
              </span>
            </div>
          </div>
          <SummaryCounts items={items} />
        </div>

        <RuntimeSummary runtime={runtime} convergence={convergence} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.3fr) minmax(320px, 0.9fr)",
          gap: 12,
          minHeight: 0,
          flex: 1,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 10 }}>
          <div style={cardStyle({ padding: 14, minHeight: 0, display: "flex", flexDirection: "column" })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ChatText size={14} weight="fill" style={{ color: "#F59E0B" }} />
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: COLORS.textPrimary, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Review comments
                </span>
              </div>
              <button
                type="button"
                onClick={onResetInventory}
                disabled={busy || items.length === 0}
                style={outlineButton({
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 8,
                  opacity: busy || items.length === 0 ? 0.5 : 1,
                })}
              >
                <ArrowsClockwise size={12} />
                Reset
              </button>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingRight: 2 }}>
              {items.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {STATE_ORDER.map((state) => {
                    const stateItems = grouped[state];
                    if (stateItems.length === 0) return null;
                    const meta = STATE_META[state];
                    return (
                      <div key={state}>
                        <SectionHeader title={meta.label} count={stateItems.length} accent={meta.accent} icon={meta.icon} />
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {stateItems.map((item) => (
                            <InventoryRow
                              key={item.id}
                              item={item}
                              busy={busy}
                              onDismiss={(itemId) => onMarkDismissed([itemId], "Dismissed from Path to Merge")}
                              onEscalate={(itemId) => onMarkEscalated([itemId])}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  title="No inventory yet"
                  description="Run the first pass to sync review comments and CI checks into the convergence loop."
                />
              )}
            </div>
          </div>

          <div style={cardStyle({ padding: 14 })}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <GitBranch size={14} style={{ color: COLORS.info }} />
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: COLORS.textPrimary, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Working rules
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onCopyPrompt(additionalInstructions)}
                  style={outlineButton({
                    height: 30,
                    padding: "0 10px",
                    borderRadius: 8,
                    opacity: busy ? 0.5 : 1,
                  })}
                >
                  <CopySimple size={12} />
                  Copy prompt
                </button>
                {runtime.sessionHref ? (
                  <button
                    type="button"
                    onClick={() => onViewSession?.(runtime.sessionHref ?? "")}
                    style={outlineButton({
                      height: 30,
                      padding: "0 10px",
                      borderRadius: 8,
                      color: COLORS.accent,
                      borderColor: `${COLORS.accent}30`,
                    })}
                  >
                    <ArrowSquareOut size={12} />
                    View agent session
                  </button>
                ) : null}
                {runtime.agentSessionId ? (
                  <button
                    type="button"
                    onClick={() => void onStop()}
                    disabled={busy}
                    style={dangerButton({
                      height: 30,
                      padding: "0 10px",
                      borderRadius: 8,
                      opacity: busy ? 0.5 : 1,
                    })}
                  >
                    <Trash size={12} />
                    Stop
                  </button>
                ) : null}
              </div>
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
                Keep the prompt narrow. The convergence loop only sends new issues to the agent, so the instruction box should add context, not repeat the full inventory.
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 10 }}>
          <div style={cardStyle({ padding: 14, minHeight: 0, display: "flex", flexDirection: "column" })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Play size={14} weight="fill" style={{ color: allChecksPassing ? COLORS.success : COLORS.danger }} />
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: COLORS.textPrimary, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  CI checks
                </span>
              </div>
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: allChecksPassing ? COLORS.success : COLORS.warning,
                }}
              >
                {checks.length === 0 ? "No checks" : allChecksPassing ? "All passing" : `${failingChecks.length} failing`}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingRight: 2 }}>
              {checks.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {checks.map((check, i) => <CheckRow key={`${check.name}-${i}`} check={check} />)}
                </div>
              ) : (
                <EmptyState title="No checks found" description="When the PR has GitHub checks, they will appear here alongside the convergence state." />
              )}
            </div>
          </div>

          <div style={cardStyle({ padding: 14, minHeight: 0, display: "flex", flexDirection: "column", gap: 12 })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Sparkle size={14} weight="fill" style={{ color: COLORS.accent }} />
                <span style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 700, color: COLORS.textPrimary, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {runtime.autoConverge ? "Convergence settings" : "Manual launch"}
                </span>
              </div>
              {!runtime.autoConverge ? (
                <button
                  type="button"
                  onClick={() => onAutoConvergeChange(true)}
                  disabled={busy}
                  style={outlineButton({
                    height: 28,
                    padding: "0 10px",
                    borderRadius: 8,
                    color: COLORS.accent,
                    borderColor: `${COLORS.accent}30`,
                    opacity: busy ? 0.5 : 1,
                  })}
                >
                  Enable auto-converge
                </button>
              ) : null}
            </div>

            {!runtime.autoConverge ? (
              <>
                <PrResolverLaunchControls
                  modelId={modelId}
                  reasoningEffort={reasoningEffort}
                  permissionMode={permissionMode}
                  onModelChange={onModelChange}
                  onReasoningEffortChange={onReasoningEffortChange}
                  onPermissionModeChange={onPermissionModeChange}
                  disabled={busy}
                />

                <textarea
                  value={additionalInstructions}
                  onChange={(e) => onAdditionalInstructionsChange(e.target.value)}
                  placeholder="Add instructions for this round..."
                  disabled={busy}
                  style={{
                    width: "100%",
                    minHeight: 96,
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
              </>
            ) : (
              <>
                <PrPipelineSettings
                  settings={pipelineSettings}
                  onSettingsChange={onPipelineSettingsChange}
                  autoConverge={runtime.autoConverge}
                  onAutoConvergeChange={onAutoConvergeChange}
                  modelId={modelId}
                  reasoningEffort={reasoningEffort}
                  permissionMode={permissionMode}
                  onModelChange={onModelChange}
                  onReasoningEffortChange={onReasoningEffortChange}
                  onPermissionModeChange={onPermissionModeChange}
                  disabled={busy}
                />

                <textarea
                  value={additionalInstructions}
                  onChange={(e) => onAdditionalInstructionsChange(e.target.value)}
                  placeholder="Additional instructions for this round..."
                  disabled={busy}
                  style={{
                    width: "100%",
                    minHeight: 92,
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
              </>
            )}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {runtime.autoConverge ? (
                  <span style={inlineBadge(COLORS.accent, { background: `${COLORS.accent}10` })}>Auto-converge ON</span>
                ) : (
                  <span style={inlineBadge(COLORS.textMuted, { background: "rgba(255,255,255,0.03)" })}>Auto-converge OFF</span>
                )}
                {runtime.pollerPhase !== "idle" ? (
                  <span style={inlineBadge(COLORS.warning, { background: "rgba(245,158,11,0.08)" })}>
                    {runtime.pollerPhase === "waiting_checks"
                      ? "Waiting for checks"
                      : runtime.pollerPhase === "waiting_comments"
                        ? "Waiting for comments"
                        : runtime.pollerPhase === "paused"
                          ? "Polling paused"
                          : "Polling"}
                  </span>
                ) : null}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
                <button
                  type="button"
                  disabled={busy || actionDisabled}
                  onClick={() => {
                    if (runtime.autoConverge) {
                      void onStartNextRound(additionalInstructions);
                    } else {
                      void onLaunchAgent(additionalInstructions);
                    }
                  }}
                  style={primaryButton({
                    height: 34,
                    padding: "0 14px",
                    borderRadius: 8,
                    opacity: busy || actionDisabled ? 0.5 : 1,
                    background: runtime.autoConverge ? COLORS.accent : COLORS.textPrimary,
                    color: runtime.autoConverge ? COLORS.pageBg : COLORS.pageBg,
                  })}
                >
                  {actionIcon}
                  {actionLabel}
                </button>
              </div>
            </div>
            {runtime.autoConverge ? (
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.55 }}>
                Auto-converge keeps the agent in the loop until the inventory stops changing and the checks settle. Use the stop button in the header if you need to pause between rounds.
              </div>
            ) : (
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, lineHeight: 1.55 }}>
                Manual launch sends only the current new issues to the agent once. Switch to auto-converge if you want the loop to keep polling for new review feedback.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
