import React, { useMemo } from "react";
import { ChatCircleText, Command, Terminal } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { sortLanesForTabs } from "../lanes/laneUtils";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import type { WorkDraftKind, WorkStatusFilter } from "../../state/appStore";

const STATUS_OPTIONS: ReadonlyArray<{ value: "all" | "running" | "awaiting-input" | "ended"; label: string; color?: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running", color: "var(--color-success)" },
  { value: "awaiting-input", label: "Awaiting", color: "var(--color-warning)" },
  { value: "ended", label: "Ended", color: "var(--color-error)" },
];

const ENTRY_OPTIONS: Array<{
  kind: WorkDraftKind;
  label: string;
  icon: typeof ChatCircleText;
  color: string;
}> = [
  { kind: "chat", label: "New Chat", icon: ChatCircleText, color: "#8B5CF6" },
  { kind: "cli", label: "CLI Tool", icon: Command, color: "#F97316" },
  { kind: "shell", label: "New Shell", icon: Terminal, color: "#22C55E" },
];

export const SessionListPane = React.memo(function SessionListPane({
  lanes,
  filtered,
  runningFiltered,
  awaitingInputFiltered,
  endedFiltered,
  loading: _loading,
  filterLaneId,
  setFilterLaneId,
  filterStatus,
  setFilterStatus,
  q,
  setQ,
  selectedSessionId,
  draftKind,
  showingDraft,
  onShowDraftKind,
  onSelectSession,
  onResume,
  resumingSessionId,
  onInfoClick,
  onContextMenu,
}: {
  lanes: LaneSummary[];
  filtered: TerminalSessionSummary[];
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  loading: boolean;
  filterLaneId: string;
  setFilterLaneId: (v: string) => void;
  filterStatus: WorkStatusFilter;
  setFilterStatus: (v: WorkStatusFilter) => void;
  q: string;
  setQ: (v: string) => void;
  selectedSessionId: string | null;
  draftKind: WorkDraftKind;
  showingDraft: boolean;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onSelectSession: (id: string) => void;
  onResume: (session: TerminalSessionSummary) => void;
  resumingSessionId: string | null;
  onInfoClick: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContextMenu: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
}) {
  const orderedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── New session buttons ── */}
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid rgba(255,255,255, 0.04)",
          display: "flex",
          gap: 4,
          fontFamily: MONO_FONT,
        }}
      >
        {ENTRY_OPTIONS.map((entry) => {
          const Icon = entry.icon;
          const active = showingDraft && draftKind === entry.kind;
          return (
            <button
              key={entry.kind}
              type="button"
              onClick={() => onShowDraftKind(entry.kind)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 10px",
                border: active ? `1px solid ${entry.color}30` : "1px solid transparent",
                borderRadius: 12,
                background: active ? `${entry.color}10` : "transparent",
                color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                fontFamily: MONO_FONT,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                cursor: "pointer",
                transition: "all 120ms",
              }}
            >
              <Icon size={10} weight="bold" style={{ color: entry.color }} />
              {entry.label}
            </button>
          );
        })}
      </div>

      {/* ── Lane filter + status + search ── */}
      <div
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid rgba(255,255,255, 0.04)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontFamily: MONO_FONT,
        }}
      >
        {/* Lane chips — horizontal scroll */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => setFilterLaneId("all")}
            style={{
              padding: "3px 8px",
              fontSize: 9,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              borderRadius: 12,
              border: `1px solid ${filterLaneId === "all" ? "var(--color-fg)" : "rgba(255,255,255, 0.04)"}`,
              background: filterLaneId === "all" ? "var(--color-fg)" : "transparent",
              color: filterLaneId === "all" ? "var(--color-card)" : "var(--color-muted-fg)",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "all 120ms",
            }}
          >
            All lanes
          </button>
          {orderedLanes.map((lane) => (
            <button
              key={lane.id}
              type="button"
              onClick={() => setFilterLaneId(lane.id)}
              title={lane.name}
              style={{
                padding: "3px 8px",
                fontSize: 9,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                borderRadius: 12,
                border: `1px solid ${filterLaneId === lane.id ? "var(--color-fg)" : "rgba(255,255,255, 0.04)"}`,
                background: filterLaneId === lane.id ? "var(--color-fg)" : "transparent",
                color: filterLaneId === lane.id ? "var(--color-card)" : "var(--color-muted-fg)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                maxWidth: 100,
                overflow: "hidden",
                textOverflow: "ellipsis",
                transition: "all 120ms",
              }}
            >
              {lane.name}
            </button>
          ))}
        </div>

        {/* Status filters */}
        <div className="flex items-center gap-1">
          {STATUS_OPTIONS.map((opt) => {
            const active = filterStatus === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFilterStatus(opt.value)}
                style={{
                  padding: "3px 8px",
                  fontSize: 9,
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  borderRadius: 12,
                  border: `1px solid ${active ? (opt.color ?? "var(--color-fg)") : "rgba(255,255,255, 0.04)"}`,
                  background: active && opt.color ? `color-mix(in srgb, ${opt.color} 14%, transparent)` : "transparent",
                  color: active ? (opt.color ?? "var(--color-fg)") : "var(--color-muted-fg)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "all 120ms",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <input
          style={{
            height: 28,
            width: "100%",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255, 0.06)",
            background: "rgba(255,255,255, 0.02)",
            padding: "0 8px",
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: "var(--color-fg)",
            outline: "none",
          }}
          placeholder="Search sessions..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* ── Session list ── */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {filtered.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              padding: "48px 16px",
              textAlign: "center",
            }}
          >
            <Terminal size={18} weight="regular" style={{ color: "var(--color-muted-fg)", opacity: 0.3, marginBottom: 10 }} />
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: "var(--color-fg)",
              }}
            >
              No sessions in this view
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                fontFamily: MONO_FONT,
                color: "var(--color-muted-fg)",
                lineHeight: 1.5,
                maxWidth: 200,
              }}
            >
              Change filters or start a new session above.
            </div>
          </div>
        ) : (
          <div className="px-2 pb-2 pt-1">
            {runningFiltered.length > 0 && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", marginBottom: 4 }}>
                  <span
                    style={{
                      height: 5,
                      width: 5,
                      borderRadius: "50%",
                      background: "var(--color-success)",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: "var(--color-success)" }}>
                    Running · {runningFiltered.length}
                  </span>
                  <span style={{ flex: 1, height: "1px", marginLeft: 6, background: "color-mix(in srgb, var(--color-success) 12%, transparent)" }} />
                </div>
                <div className="space-y-1">
                  {runningFiltered.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isSelected={selectedSessionId === session.id}
                      onSelect={onSelectSession}
                      onResume={() => onResume(session)}
                      onInfoClick={(e) => onInfoClick(session, e)}
                      onContextMenu={(e) => { e.preventDefault(); onContextMenu(session, e); }}
                      resumingSessionId={resumingSessionId}
                    />
                  ))}
                </div>
              </div>
            )}

            {awaitingInputFiltered.length > 0 && (
              <div className={runningFiltered.length > 0 ? "mt-3" : ""}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: "var(--color-warning)" }}>
                    Awaiting input · {awaitingInputFiltered.length}
                  </span>
                  <span style={{ flex: 1, height: "1px", marginLeft: 6, background: "color-mix(in srgb, var(--color-warning) 12%, transparent)" }} />
                </div>
                <div className="space-y-1">
                  {awaitingInputFiltered.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isSelected={selectedSessionId === session.id}
                      onSelect={onSelectSession}
                      onResume={() => onResume(session)}
                      onInfoClick={(e) => onInfoClick(session, e)}
                      onContextMenu={(e) => { e.preventDefault(); onContextMenu(session, e); }}
                      resumingSessionId={resumingSessionId}
                    />
                  ))}
                </div>
              </div>
            )}

            {endedFiltered.length > 0 && (
              <div className={runningFiltered.length > 0 || awaitingInputFiltered.length > 0 ? "mt-3" : ""}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: "var(--color-error)" }}>
                    Ended · {endedFiltered.length}
                  </span>
                  <span style={{ flex: 1, height: "1px", marginLeft: 6, background: "color-mix(in srgb, var(--color-error) 12%, transparent)" }} />
                </div>
                <div className="space-y-1">
                  {endedFiltered.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isSelected={selectedSessionId === session.id}
                      onSelect={onSelectSession}
                      onResume={() => onResume(session)}
                      onInfoClick={(e) => onInfoClick(session, e)}
                      onContextMenu={(e) => { e.preventDefault(); onContextMenu(session, e); }}
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
});
