import React from "react";
import { Terminal } from "@phosphor-icons/react";
import type { TerminalSessionSummary, TerminalSessionStatus } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { LaunchPanel } from "./LaunchPanel";
import type { SessionContextMenuState } from "./SessionContextMenu";
import type { InfoPopoverState } from "./SessionInfoPopover";
import { cn } from "../ui/cn";

export function SessionListPane({
  lanes,
  filtered,
  runningFiltered,
  endedFiltered,
  loading,
  filterLaneId,
  setFilterLaneId,
  filterStatus,
  setFilterStatus,
  q,
  setQ,
  selectedSessionId,
  onSelectSession,
  onResume,
  resumingSessionId,
  onLaunchPty,
  onLaunchChat,
  onInfoClick,
  onContextMenu,
}: {
  lanes: { id: string; name: string }[];
  filtered: TerminalSessionSummary[];
  runningFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  loading: boolean;
  filterLaneId: string;
  setFilterLaneId: (v: string) => void;
  filterStatus: TerminalSessionStatus | "all";
  setFilterStatus: (v: TerminalSessionStatus | "all") => void;
  q: string;
  setQ: (v: string) => void;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResume: (session: TerminalSessionSummary) => void;
  resumingSessionId: string | null;
  onLaunchPty: (laneId: string, profile: "claude" | "codex" | "shell") => void;
  onLaunchChat: (laneId: string, provider: "claude" | "codex") => void;
  onInfoClick: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContextMenu: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
}) {
  const statusOptions = [
    { value: "all" as const, label: "All" },
    { value: "running" as const, label: "Running" },
    { value: "completed" as const, label: "Ended" },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Launch panel */}
      <LaunchPanel
        lanes={lanes}
        onLaunchPty={onLaunchPty}
        onLaunchChat={onLaunchChat}
      />

      {/* Filters */}
      <div className="px-3 py-2 space-y-2">
        {/* Lane filter chips */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none pb-0.5">
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-all",
              filterLaneId === "all"
                ? "bg-accent/15 text-accent"
                : "bg-muted/30 text-muted-fg/70 hover:bg-muted/50 hover:text-muted-fg",
            )}
            onClick={() => setFilterLaneId("all")}
          >
            All
          </button>
          {lanes.map((l) => (
            <button
              key={l.id}
              type="button"
              className={cn(
                "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-all truncate max-w-[100px]",
                filterLaneId === l.id
                  ? "bg-accent/15 text-accent"
                  : "bg-muted/30 text-muted-fg/70 hover:bg-muted/50 hover:text-muted-fg",
              )}
              onClick={() => setFilterLaneId(l.id)}
              title={l.name}
            >
              {l.name}
            </button>
          ))}
        </div>

        {/* Status toggle pills */}
        <div className="flex items-center gap-1">
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
                filterStatus === opt.value
                  ? "bg-accent/15 text-accent"
                  : "bg-transparent text-muted-fg/60 hover:text-muted-fg",
              )}
              onClick={() => setFilterStatus(opt.value === "completed" ? opt.value : opt.value as TerminalSessionStatus | "all")}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Search bar */}
        <input
          className="h-7 w-full rounded-md border border-border/10 bg-surface-recessed px-2.5 text-xs text-fg outline-none placeholder:text-muted-fg/40 hover:border-accent/20 focus:border-accent/30 transition-colors"
          placeholder="Search by name, lane, type..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
            <div className="mb-3 rounded-lg bg-emerald-500/10 p-3">
              <Terminal size={20} weight="regular" className="text-emerald-500/60" />
            </div>
            <div className="text-xs font-semibold text-fg/50">No terminal sessions</div>
            <div className="mt-1 text-xs text-muted-fg/50 leading-relaxed max-w-[220px]">
              Start a new session to begin working.
            </div>
          </div>
        ) : (
          <div className="px-2 pb-2">
            {/* Running group */}
            {runningFiltered.length > 0 && (
              <div>
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg/80 backdrop-blur-md px-2 py-1.5 mb-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                    Running · {runningFiltered.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {runningFiltered.map((s) => (
                    <SessionCard
                      key={s.id}
                      session={s}
                      isSelected={selectedSessionId === s.id}
                      onSelect={onSelectSession}
                      onResume={() => onResume(s)}
                      onInfoClick={(e) => onInfoClick(s, e)}
                      onContextMenu={(e) => { e.preventDefault(); onContextMenu(s, e); }}
                      resumingSessionId={resumingSessionId}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Ended group */}
            {endedFiltered.length > 0 && (
              <div className={runningFiltered.length > 0 ? "mt-2" : ""}>
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg/80 backdrop-blur-md px-2 py-1.5 mb-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-border" />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-fg/60">
                    Ended · {endedFiltered.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {endedFiltered.map((s) => (
                    <SessionCard
                      key={s.id}
                      session={s}
                      isSelected={selectedSessionId === s.id}
                      onSelect={onSelectSession}
                      onResume={() => onResume(s)}
                      onInfoClick={(e) => onInfoClick(s, e)}
                      onContextMenu={(e) => { e.preventDefault(); onContextMenu(s, e); }}
                      resumingSessionId={resumingSessionId}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
