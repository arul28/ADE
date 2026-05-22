import React from "react";
import { Info, WarningCircle } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { sessionStatusDot, sanitizeTerminalInlineText } from "../../lib/terminalAttention";
import {
  getStaleRunningCliSessionAgeHours,
  primarySessionLabel,
  preferredSessionLabel,
} from "../../lib/sessions";
import { relativeTimeCompact } from "../../lib/format";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { ToolLogo } from "./ToolLogos";
import { SmartTooltip } from "../ui/SmartTooltip";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";

const DELTA_CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  fontFamily: MONO_FONT,
  letterSpacing: "0",
  borderRadius: 4,
};

function getPreviewLine(session: TerminalSessionSummary, primaryText: string): string | null {
  const summary = preferredSessionLabel(session.summary);
  if (summary && summary !== primaryText) return summary;
  const preview = sanitizeTerminalInlineText(session.lastOutputPreview, 120);
  if (preview && preview !== primaryText) return preview;
  const goal = preferredSessionLabel(session.goal);
  if (goal && goal !== primaryText) return goal;
  return null;
}

export const SessionCard = React.memo(function SessionCard({
  session,
  lane,
  isSelected,
  isMultiSelected,
  onSelect,
  onInfoClick,
  onContextMenu,
  compact = false,
}: {
  session: TerminalSessionSummary;
  lane: LaneSummary | null;
  isSelected: boolean;
  isMultiSelected?: boolean;
  onSelect: (id: string, event: React.MouseEvent) => void;
  onInfoClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  compact?: boolean;
}) {
  const dot = sessionStatusDot(session);
  const delta = useSessionDelta(session.id, true);
  const primaryText = primarySessionLabel(session);
  const previewLine = getPreviewLine(session, primaryText);
  const staleAgeHours = getStaleRunningCliSessionAgeHours(session);
  const isHighlighted = isSelected || isMultiSelected;
  const highlightedBorder = isHighlighted
    ? "1px solid rgba(255,255,255,0.08)"
    : "1px solid transparent";
  const laneAccent = lane?.color ?? null;
  const useLaneGlow = Boolean(isHighlighted && laneAccent);
  const laneTint = useLaneGlow
    ? `color-mix(in srgb, ${laneAccent} 14%, transparent)`
    : null;
  const laneRing = useLaneGlow
    ? `color-mix(in srgb, ${laneAccent} 32%, transparent)`
    : null;
  const stoppedBySignal = session.exitCode === 130 || session.exitCode === 143;
  const showClaudeCacheTimer = shouldShowClaudeCacheTtl({
    provider: session.toolType === "claude-chat" ? "claude" : null,
    status: session.runtimeState === "idle" ? "idle" : "active",
    idleSinceAt: session.chatIdleSinceAt,
    awaitingInput: session.runtimeState === "waiting-input",
  });
  const orchestratorRole = session.orchestratorRole
    ?? (session.toolType?.endsWith("-orchestrated") ? "worker" as const : null);
  const hasDeltaChips = Boolean(delta && (delta.insertions > 0 || delta.deletions > 0));
  const hasFooterMeta =
    showClaudeCacheTimer || hasDeltaChips || (session.exitCode != null && session.exitCode !== 0);

  return (
    <div className="group relative" onContextMenu={onContextMenu}>
      <button
        type="button"
        className={cn(
          "relative w-full overflow-hidden text-left transition-all duration-100 rounded-lg border-l-2",
          useLaneGlow
            ? "border-l-transparent"
            : isHighlighted
              ? "border-l-accent bg-white/[0.06] hover:bg-white/[0.07]"
              : "border-l-transparent bg-transparent hover:bg-white/[0.03]",
          isMultiSelected && "ring-1 ring-accent/35",
        )}
        style={{
          borderTop: highlightedBorder,
          borderRight: highlightedBorder,
          borderBottom: highlightedBorder,
          ...(useLaneGlow
            ? {
                background: laneTint ?? undefined,
                boxShadow: `inset 0 0 0 1px ${laneRing}`,
                borderLeftColor: laneAccent ?? undefined,
              }
            : {}),
        }}
        onClick={(event) => onSelect(session.id, event)}
      >
        <div className={cn("flex items-stretch", compact ? "gap-2 px-2 py-1" : "gap-2.5 px-2.5 py-2")}>
          {/* Logo — vertically centered against full card height */}
          <div className="flex shrink-0 self-stretch items-center justify-center">
            <ToolLogo toolType={session.toolType} size={compact ? 18 : 26} />
          </div>

          {/* Content — 3 rows */}
          <div className="min-w-0 flex-1">
            {/* Row 1: Title + status dot + relative time */}
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-semibold text-fg/90",
                  compact ? "text-[11px]" : "text-[13px]",
                )}
              >
                {primaryText}
              </span>
              {orchestratorRole === "lead" ? (
                <span className="ade-orchestrator-badge shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
                  Orchestrator
                </span>
              ) : null}
              {orchestratorRole === "worker" ? (
                <span className="shrink-0 rounded-full border border-white/[0.10] bg-white/[0.05] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-fg/70">
                  Worker
                </span>
              ) : null}
              {staleAgeHours != null ? (
                <span
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300"
                  aria-label="Old running session"
                  title={`Old running session. This CLI or shell session has been running for about ${staleAgeHours} hours. Stop the runtime if it is no longer being used.`}
                >
                  <WarningCircle size={11} weight="fill" />
                </span>
              ) : null}
              <span
                title={dot.label}
                className={cn(
                  "shrink-0 rounded-full",
                  compact ? "h-2.5 w-2.5" : "h-3 w-3",
                  dot.cls,
                  dot.spinning && "animate-spin",
                )}
              />
              <span className={cn("shrink-0 text-muted-fg/45 tabular-nums", compact ? "text-[9px]" : "text-[10px]")}>
                {relativeTimeCompact(session.endedAt ?? session.startedAt)}
              </span>
            </div>

            {/* Row 2: Summary/preview line (conditional) */}
            {previewLine && !compact ? (
              <div className="mt-0.5 min-w-0">
                <span className="block truncate text-[10px] text-muted-fg/50 leading-snug">
                  {previewLine}
                </span>
              </div>
            ) : null}

            {/* Row 3: Cache badge + Delta chips + Exit code */}
            {hasFooterMeta ? (
              <div className={cn("flex items-center gap-1.5 min-w-0", compact ? "mt-px" : "mt-0.5")}>
                {showClaudeCacheTimer ? (
                  <ClaudeCacheTtlBadge idleSinceAt={session.chatIdleSinceAt} />
                ) : null}

                {hasDeltaChips && delta ? (
                  <>
                    {delta.insertions > 0 ? (
                      <span
                        className="border border-emerald-500/30 bg-emerald-500/15 px-1 py-0.5 text-emerald-300 leading-none shrink-0"
                        style={DELTA_CHIP_STYLE}
                      >
                        +{delta.insertions}
                      </span>
                    ) : null}
                    {delta.deletions > 0 ? (
                      <span
                        className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                        style={DELTA_CHIP_STYLE}
                      >
                        -{delta.deletions}
                      </span>
                    ) : null}
                  </>
                ) : null}

                {session.exitCode != null && session.exitCode !== 0 ? (
                  <span
                    className={cn(
                      "px-1 py-0.5 leading-none shrink-0 border",
                      stoppedBySignal
                        ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                        : "border-red-500/30 bg-red-500/15 text-red-300",
                    )}
                    style={DELTA_CHIP_STYLE}
                  >
                    {stoppedBySignal ? "STOPPED" : `EXIT ${session.exitCode}`}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </button>

      {/* Hover actions — bottom-right so they don’t compete with title row */}
      <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <SmartTooltip content={{ label: "Session details", description: "View session info and management actions." }}>
          <button
            type="button"
            className="inline-flex items-center justify-center h-5 w-5 rounded-full border border-white/[0.08] bg-white/[0.06] text-muted-fg/60 hover:text-fg hover:bg-white/[0.10] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent"
            onMouseDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); onInfoClick(e); }}
            aria-label="Session details"
          >
            <Info size={10} weight="regular" />
          </button>
        </SmartTooltip>
      </div>
    </div>
  );
});
