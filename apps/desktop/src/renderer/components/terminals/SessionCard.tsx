import React from "react";
import { Info, Play } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { sessionIndicatorState } from "../../lib/terminalAttention";
import { ToolLogo } from "./ToolLogos";
import { useSessionDelta } from "./useSessionDelta";
import { cn } from "../ui/cn";

/** Tool-type accent gradient for left bar — Claude=warm orange, Codex=cool silver, Shell=dark */
function toolAccentGradient(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat" || toolType === "claude-orchestrated")
    return "from-orange-400/70 to-orange-400/10";
  if (toolType === "codex" || toolType === "codex-chat" || toolType === "codex-orchestrated")
    return "from-slate-300/60 to-slate-300/10";
  if (toolType === "shell") return "from-zinc-500/50 to-zinc-500/10";
  return "from-border/20 to-transparent";
}

/** Tool-type badge color */
function toolBadgeClass(toolType: string | null | undefined): string {
  if (toolType === "claude" || toolType === "claude-chat") return "bg-orange-500/15 text-orange-400";
  if (toolType === "codex" || toolType === "codex-chat") return "bg-slate-400/15 text-slate-300";
  return "bg-zinc-500/15 text-zinc-400";
}

function statusDot(session: TerminalSessionSummary): { cls: string; spinning: boolean; label: string } {
  const ind = sessionIndicatorState({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
  });
  if (ind === "running-active")
    return { cls: "border-2 border-emerald-500 border-t-transparent bg-transparent", spinning: true, label: "Running" };
  if (ind === "running-needs-attention")
    return { cls: "border-2 border-amber-400 border-t-transparent bg-transparent", spinning: true, label: "Needs input" };
  if (ind === "failed") return { cls: "bg-red-500", spinning: false, label: "Failed" };
  if (ind === "disposed") return { cls: "bg-red-400/70", spinning: false, label: "Stopped" };
  return { cls: "bg-sky-500/70", spinning: false, label: "Completed" };
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
          "relative w-full overflow-hidden rounded-lg text-left transition-all duration-150",
          "bg-card/60 backdrop-blur-sm border",
          isSelected
            ? "border-accent/30 bg-accent/8 shadow-sm"
            : "border-border/10 hover:border-border/20 hover:bg-card/80",
        )}
        onClick={() => onSelect(session.id)}
      >
        {/* Left accent gradient bar */}
        <div className={cn("absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg bg-gradient-to-b", toolAccentGradient(session.toolType))} />

        <div className="pl-3.5 pr-2 py-2">
          {/* Top row: logo + title + status */}
          <div className="flex items-center gap-2 min-w-0">
            <ToolLogo toolType={session.toolType} size={16} />
            <span
              title={dot.label}
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot.cls, dot.spinning && "animate-spin")}
            />
            <span className={cn("min-w-0 flex-1 truncate text-xs font-semibold", isSelected && "text-accent")}>
              {(session.goal ?? session.title).trim()}
            </span>
          </div>

          {/* Bottom row: summary + badges */}
          <div className="mt-1 flex items-center gap-1.5 pl-[26px] min-w-0">
            {summary ? (
              <span className="truncate text-[11px] text-muted-fg/60 max-w-[160px]">{summary}</span>
            ) : null}

            <span className="truncate text-[11px] text-muted-fg/50">{session.laneName}</span>

            {session.toolType ? (
              <span className={cn("rounded px-1 py-0.5 text-[10.5px] font-medium leading-none shrink-0", toolBadgeClass(session.toolType))}>
                {session.toolType}
              </span>
            ) : null}

            {/* Delta chips for ended sessions */}
            {delta && (delta.insertions > 0 || delta.deletions > 0) ? (
              <>
                <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-mono font-medium text-emerald-400 leading-none shrink-0">
                  +{delta.insertions}
                </span>
                <span className="rounded bg-red-500/15 px-1 py-0.5 text-[10px] font-mono font-medium text-red-400 leading-none shrink-0">
                  -{delta.deletions}
                </span>
              </>
            ) : null}

            {session.exitCode != null && session.exitCode !== 0 ? (
              <span className="rounded bg-red-500/15 px-1 py-0.5 text-[10.5px] font-mono font-medium text-red-400 leading-none shrink-0">
                exit {session.exitCode}
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
          className="inline-flex items-center justify-center h-5 w-5 rounded border border-border/20 bg-card/90 backdrop-blur-sm text-muted-fg hover:text-fg transition-colors"
          onClick={(e) => { e.stopPropagation(); onInfoClick(e); }}
          title="Session details"
        >
          <Info size={11} weight="regular" />
        </button>

        {/* Resume button */}
        {canResume ? (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded border border-border/20 bg-card/90 backdrop-blur-sm px-1.5 py-0.5 text-[11px] text-muted-fg hover:text-fg transition-colors"
            disabled={resumingSessionId != null}
            onClick={(e) => { e.stopPropagation(); onResume(); }}
            title="Resume"
          >
            <Play size={10} weight="regular" />
            Resume
          </button>
        ) : null}
      </div>
    </div>
  );
}
