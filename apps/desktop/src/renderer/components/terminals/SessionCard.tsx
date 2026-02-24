import React from "react";
import { Info, Play } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { sessionIndicatorState } from "../../lib/terminalAttention";
import { ToolLogo } from "./ToolLogos";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

/** Tool-type accent gradient for left bar — more vibrant, colorful palette */
function toolAccentGradient(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat" || toolType === "claude-orchestrated")
    return "from-orange-500/80 to-orange-500/10";
  if (toolType === "codex" || toolType === "codex-chat" || toolType === "codex-orchestrated")
    return "from-blue-500/70 to-blue-500/10";
  if (toolType === "shell") return "from-emerald-500/60 to-emerald-500/10";
  return "from-violet-500/50 to-violet-500/10";
}

/** Tool-type badge color — vibrant with borders */
function toolBadgeClass(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat")
    return "bg-orange-500/20 text-orange-300 border border-orange-500/30";
  if (toolType === "codex" || toolType === "codex-chat")
    return "bg-blue-500/20 text-blue-300 border border-blue-500/30";
  return "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
}

function statusDot(session: TerminalSessionSummary): { cls: string; spinning: boolean; label: string } {
  const ind = sessionIndicatorState({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
  });
  if (ind === "running-active")
    return { cls: "border-2 border-emerald-400 border-t-transparent bg-transparent", spinning: true, label: "Running" };
  if (ind === "running-needs-attention")
    return { cls: "border-2 border-amber-300 border-t-transparent bg-transparent", spinning: true, label: "Needs input" };
  if (ind === "failed") return { cls: "bg-red-400", spinning: false, label: "Failed" };
  if (ind === "disposed") return { cls: "bg-red-400/80", spinning: false, label: "Stopped" };
  return { cls: "bg-sky-400/80", spinning: false, label: "Completed" };
}

function truncateSummary(text: string | null, maxWords = 8): string {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + "...";
}

export function SessionCard({
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
  const dot = statusDot(session);
  const canResume = session.status !== "running" && Boolean(session.resumeCommand);
  const isEnded = session.status !== "running";
  const delta = useSessionDelta(session.id, isEnded);
  const summary = truncateSummary(session.summary ?? session.goal ?? session.title);

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
          ...(isSelected
            ? {
                background: "#A78BFA12",
                border: "1px solid #A78BFA30",
                borderLeftWidth: 3,
                borderLeftColor: COLORS.accent,
              }
            : {
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.border}`,
              }),
        }}
        onClick={() => onSelect(session.id)}
      >
        {/* Left accent gradient bar */}
        <div className={cn("absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b", toolAccentGradient(session.toolType))} />

        <div className="pl-3.5 pr-2 py-2">
          {/* Top row: logo + title + status */}
          <div className="flex items-center gap-2 min-w-0">
            <ToolLogo toolType={session.toolType} size={16} />
            <span
              title={dot.label}
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot.cls, dot.spinning && "animate-spin")}
            />
            <span
              className="min-w-0 flex-1 truncate text-xs font-semibold"
              style={{
                fontFamily: MONO_FONT,
                color: isSelected ? COLORS.accent : undefined,
              }}
            >
              {(session.goal ?? session.title).trim()}
            </span>
          </div>

          {/* Bottom row: summary + badges */}
          <div className="mt-1 flex items-center gap-1.5 pl-[26px] min-w-0">
            {summary ? (
              <span
                className="truncate max-w-[160px]"
                style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}
              >
                {summary}
              </span>
            ) : null}

            <span
              className="truncate"
              style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim }}
            >
              {session.laneName}
            </span>

            {session.toolType ? (
              <span
                className={cn("px-1 py-0.5 leading-none shrink-0", toolBadgeClass(session.toolType))}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  borderRadius: 0,
                }}
              >
                {session.toolType}
              </span>
            ) : null}

            {/* Delta chips for ended sessions */}
            {delta && (delta.insertions > 0 || delta.deletions > 0) ? (
              <>
                <span
                  className="border border-emerald-500/30 bg-emerald-500/15 px-1 py-0.5 text-emerald-300 leading-none shrink-0"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    borderRadius: 0,
                  }}
                >
                  +{delta.insertions}
                </span>
                <span
                  className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    borderRadius: 0,
                  }}
                >
                  -{delta.deletions}
                </span>
              </>
            ) : null}

            {session.exitCode != null && session.exitCode !== 0 ? (
              <span
                className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  textTransform: "uppercase",
                  letterSpacing: "1px",
                  borderRadius: 0,
                }}
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
          style={{
            borderRadius: 0,
            border: `1px solid ${COLORS.outlineBorder}`,
            background: COLORS.cardBg,
          }}
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
            style={{
              borderRadius: 0,
              border: `1px solid ${COLORS.outlineBorder}`,
              background: COLORS.cardBg,
              fontSize: 11,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
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
}
