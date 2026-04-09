import React from "react";
import { GitBranch, Info, Play } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { sessionStatusDot, sanitizeTerminalInlineText } from "../../lib/terminalAttention";
import { primarySessionLabel, preferredSessionLabel, shortToolTypeLabel } from "../../lib/sessions";
import { relativeTimeCompact } from "../../lib/format";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { ToolLogo } from "./ToolLogos";
import { iconGlyph } from "../graph/graphHelpers";
import { resolveTrackedCliResumeCommand } from "./cliLaunch";
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
  onSelect,
  onResume,
  onInfoClick,
  onContextMenu,
  resumingSessionId,
}: {
  session: TerminalSessionSummary;
  lane: LaneSummary | null;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onResume: () => void;
  onInfoClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  resumingSessionId: string | null;
}) {
  const dot = sessionStatusDot(session);
  const canResume = session.status !== "running" && Boolean(resolveTrackedCliResumeCommand(session));
  const delta = useSessionDelta(session.id, true);
  const primaryText = primarySessionLabel(session);
  const previewLine = getPreviewLine(session, primaryText);
  const laneMarker = lane?.icon ? iconGlyph(lane.icon) : <GitBranch size={11} weight="regular" />;
  const showClaudeCacheTimer = shouldShowClaudeCacheTtl({
    provider: session.toolType === "claude-chat" ? "claude" : null,
    status: session.runtimeState === "idle" ? "idle" : "active",
    idleSinceAt: session.chatIdleSinceAt,
    awaitingInput: session.runtimeState === "waiting-input",
  });

  return (
    <div className="group relative" onContextMenu={onContextMenu}>
      <button
        type="button"
        className={cn(
          "relative w-full overflow-hidden text-left transition-all duration-100 rounded-lg border-l-2",
          isSelected
            ? "border-l-accent bg-white/[0.06] hover:bg-white/[0.07]"
            : "border-l-transparent bg-transparent hover:bg-white/[0.03]",
        )}
        style={{
          borderTop: isSelected ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
          borderRight: isSelected ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
          borderBottom: isSelected ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
        }}
        onClick={() => onSelect(session.id)}
      >
        <div className="flex items-start gap-2.5 px-2.5 py-2">
          {/* Logo */}
          <div className="shrink-0 mt-0.5">
            <ToolLogo toolType={session.toolType} size={22} />
          </div>

          {/* Content — 3 rows */}
          <div className="min-w-0 flex-1">
            {/* Row 1: Status dot + Title + Relative time */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                title={dot.label}
                className={cn("h-2 w-2 shrink-0 rounded-full", dot.cls, dot.spinning && "animate-spin")}
              />
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-fg/90"
                style={{ fontWeight: isSelected ? 600 : 400 }}
              >
                {primaryText}
              </span>
              <span className="shrink-0 text-[10px] text-muted-fg/45 tabular-nums">
                {relativeTimeCompact(session.endedAt ?? session.startedAt)}
              </span>
            </div>

            {/* Row 2: Summary/preview line (conditional) */}
            {previewLine ? (
              <div className="mt-0.5 min-w-0">
                <span className="block truncate text-[10px] text-muted-fg/50 leading-snug">
                  {previewLine}
                </span>
              </div>
            ) : null}

            {/* Row 3: Tool type + Lane + Cache badge + Delta chips + Exit code */}
            <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
              <span className="shrink-0 text-[10px] text-muted-fg/55">
                {shortToolTypeLabel(session.toolType)}
              </span>
              <span className="text-muted-fg/25">&middot;</span>
              <span className="inline-flex shrink-0 items-center justify-center text-muted-fg/55">
                {laneMarker}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-fg/50">
                {lane?.name ?? session.laneName}
              </span>

              {showClaudeCacheTimer ? (
                <ClaudeCacheTtlBadge idleSinceAt={session.chatIdleSinceAt} />
              ) : null}

              {delta ? (
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
                  className="border border-red-500/30 bg-red-500/15 px-1 py-0.5 text-red-300 leading-none shrink-0"
                  style={DELTA_CHIP_STYLE}
                >
                  EXIT {session.exitCode}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </button>

      {/* Hover actions */}
      <div className="absolute right-1.5 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          className="inline-flex items-center justify-center h-5 w-5 rounded-full border border-white/[0.08] bg-white/[0.06] text-muted-fg/60 hover:text-fg hover:bg-white/[0.10] transition-colors"
          onClick={(e) => { e.stopPropagation(); onInfoClick(e); }}
          title="Session details"
        >
          <Info size={10} weight="regular" />
        </button>

        {canResume ? (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-white/[0.08] bg-white/[0.06] text-muted-fg/60 hover:text-fg hover:bg-white/[0.10] transition-colors text-[10px] font-medium"
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
