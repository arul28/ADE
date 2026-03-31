import React from "react";
import { Info, Play } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { sessionStatusDot } from "../../lib/terminalAttention";
import { primarySessionLabel, secondarySessionLabel } from "../../lib/sessions";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { ToolLogo } from "./ToolLogos";

function truncateSummary(text: string | null, maxWords = 8): string {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + "...";
}

const DELTA_CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  fontFamily: MONO_FONT,
  letterSpacing: "0",
  borderRadius: 4,
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
          "relative w-full overflow-hidden text-left transition-all duration-100 rounded-md",
          isSelected
            ? "bg-white/[0.05] hover:bg-white/[0.06]"
            : "bg-transparent hover:bg-white/[0.03]",
        )}
        style={{
          border: isSelected ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
        }}
        onClick={() => onSelect(session.id)}
      >
        <div className="px-2 py-1.5">
          {/* Top row */}
          <div className="flex items-center gap-2 min-w-0">
            <span
              title={dot.label}
              className={cn("h-2 w-2 shrink-0 rounded-full", dot.cls, dot.spinning && "animate-spin")}
            />
            <ToolLogo toolType={session.toolType} size={11} />
            <span
              className="min-w-0 flex-1 truncate text-[11px]"
              style={{ fontWeight: isSelected ? 500 : 400 }}
            >
              {primaryText}
            </span>
          </div>

          {/* Bottom row */}
          <div className="mt-0.5 flex items-center gap-1.5 pl-[18px] min-w-0">
            <span className="shrink-0 text-[10px] text-muted-fg/50">
              {session.laneName}
            </span>
            {secondaryText ? (
              <span className="truncate text-[10px] text-muted-fg/70">
                {secondaryText}
              </span>
            ) : null}

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
      <div className="absolute right-1.5 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          className="inline-flex items-center justify-center h-5 w-5 rounded-full text-muted-fg/60 hover:text-fg transition-colors"
          style={{
            border: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(255,255,255,0.04)",
          }}
          onClick={(e) => { e.stopPropagation(); onInfoClick(e); }}
          title="Session details"
        >
          <Info size={10} weight="regular" />
        </button>

        {canResume ? (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-muted-fg/60 hover:text-fg transition-colors text-[10px] font-medium"
            style={{
              border: "1px solid rgba(255,255,255,0.06)",
              background: "rgba(255,255,255,0.04)",
            }}
            disabled={resumingSessionId != null}
            onClick={(e) => { e.stopPropagation(); onResume(); }}
            title="Resume"
          >
            <Play size={9} weight="regular" />
            Resume
          </button>
        ) : null}
      </div>
    </div>
  );
});
