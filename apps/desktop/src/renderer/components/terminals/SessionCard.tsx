import React from "react";
import { Info, Play } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { sessionStatusDot } from "../../lib/terminalAttention";
import { primarySessionLabel, secondarySessionLabel } from "../../lib/sessions";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { ToolLogo } from "./ToolLogos";

/** Tool-type accent gradient for left bar — more vibrant, colorful palette */
function toolAccentGradient(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat" || toolType === "claude-orchestrated")
    return "from-orange-500/80 to-orange-500/10";
  if (toolType === "codex" || toolType === "codex-chat" || toolType === "codex-orchestrated")
    return "from-blue-500/70 to-blue-500/10";
  if (toolType === "ai-chat") return "from-teal-500/70 to-teal-500/10";
  if (toolType === "shell") return "from-emerald-500/60 to-emerald-500/10";
  return "from-violet-500/50 to-violet-500/10";
}


function truncateSummary(text: string | null, maxWords = 8): string {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + "...";
}

const DELTA_CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  borderRadius: 0,
};

const SELECTED_CARD_BASE: React.CSSProperties = {
  background: "#A78BFA12",
  border: "1px solid #A78BFA30",
  borderLeftWidth: 3,
  borderLeftColor: COLORS.accent,
};

const UNSELECTED_CARD_BASE: React.CSSProperties = {
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
};

const INFO_BUTTON_STYLE: React.CSSProperties = {
  borderRadius: 0,
  border: `1px solid ${COLORS.outlineBorder}`,
  background: COLORS.cardBg,
};

const RESUME_BUTTON_STYLE: React.CSSProperties = {
  borderRadius: 0,
  border: `1px solid ${COLORS.outlineBorder}`,
  background: COLORS.cardBg,
  fontSize: 11,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
};

export const SessionCard = React.memo(function SessionCard({
  session,
  isSelected,
  onSelect,
  onResume,
  onInfoClick,
  onContextMenu,
  resumingSessionId,
}: {
  session: TerminalSessionSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onResume: () => void;
  onInfoClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  resumingSessionId: string | null;
}) {
  const dot = sessionStatusDot(session);
  const canResume = session.status !== "running" && Boolean(session.resumeCommand);
  const isEnded = session.status !== "running";
  const delta = useSessionDelta(session.id, isEnded);
  const primaryText = primarySessionLabel(session);
  const secondaryText = truncateSummary(secondarySessionLabel(session), 20);

  return (
    <div className="group relative" onContextMenu={onContextMenu}>
      <button
        type="button"
        className={cn(
          "relative w-full overflow-hidden text-left transition-all duration-150",
          isSelected ? "hover:brightness-110" : "hover:bg-[#1A1720]",
        )}
        style={{
          fontFamily: MONO_FONT,
          borderRadius: 0,
          ...(isSelected ? SELECTED_CARD_BASE : UNSELECTED_CARD_BASE),
        }}
        onClick={() => onSelect(session.id)}
      >
        {/* Left accent gradient bar */}
        <div className={cn("absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b", toolAccentGradient(session.toolType))} />

        <div className="pl-3.5 pr-2 py-2">
          {/* Top row: logo + title + status */}
          <div className="flex items-center gap-2 min-w-0">
            <span
              title={dot.label}
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot.cls, dot.spinning && "animate-spin")}
            />
            <ToolLogo toolType={session.toolType} size={12} />
            <span
              className="min-w-0 flex-1 truncate text-xs font-semibold"
              style={{
                fontFamily: MONO_FONT,
                color: isSelected ? COLORS.accent : undefined,
              }}
            >
              {primaryText}
            </span>
          </div>

          {/* Bottom row: summary + badges */}
          <div className="mt-1 flex items-center gap-1.5 pl-[14px] min-w-0">
            <span
              className="shrink-0"
              style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.accent }}
            >
              {session.laneName}
            </span>
            {secondaryText ? (
              <span
                className="truncate"
                style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}
              >
                {secondaryText}
              </span>
            ) : null}

            {/* Delta chips for ended sessions */}
            {delta && (delta.insertions > 0 || delta.deletions > 0) ? (
              <>
                <span
                  className="border border-emerald-500/30 bg-emerald-500/15 px-1 py-0.5 text-emerald-300 leading-none shrink-0"
                  style={DELTA_CHIP_STYLE}
                >
                  +{delta.insertions}
                </span>
                <span
                  className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                  style={DELTA_CHIP_STYLE}
                >
                  -{delta.deletions}
                </span>
              </>
            ) : null}

            {session.exitCode != null && session.exitCode !== 0 ? (
              <span
                className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                style={DELTA_CHIP_STYLE}
              >
                EXIT {session.exitCode}
              </span>
            ) : null}
          </div>
        </div>
      </button>

      {/* Hover actions */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {/* Info button */}
        <button
          type="button"
          className="inline-flex items-center justify-center h-5 w-5 text-muted-fg hover:text-fg transition-colors"
          style={INFO_BUTTON_STYLE}
          onClick={(e) => { e.stopPropagation(); onInfoClick(e); }}
          title="Session details"
        >
          <Info size={11} weight="regular" />
        </button>

        {/* Resume button */}
        {canResume ? (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-muted-fg hover:text-fg transition-colors"
            style={RESUME_BUTTON_STYLE}
            disabled={resumingSessionId != null}
            onClick={(e) => { e.stopPropagation(); onResume(); }}
            title="Resume"
          >
            <Play size={10} weight="regular" />
            RESUME
          </button>
        ) : null}
      </div>
    </div>
  );
});
