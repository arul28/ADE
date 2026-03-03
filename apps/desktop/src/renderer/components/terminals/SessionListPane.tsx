import React from "react";
import { Terminal } from "@phosphor-icons/react";
import type { TerminalSessionSummary, TerminalSessionStatus } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { LaunchPanel } from "./LaunchPanel";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

/* ── inline style helpers ─────────────────────────────────────────── */

const chipBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 10px",
  fontSize: 9,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  borderRadius: 0,
  cursor: "pointer",
  transition: "all 150ms",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const chipActive: React.CSSProperties = {
  ...chipBase,
  color: COLORS.accent,
  background: `${COLORS.accent}18`,
  border: `1px solid ${COLORS.accent}30`,
};

const chipInactive: React.CSSProperties = {
  ...chipBase,
  color: COLORS.textMuted,
  background: "transparent",
  border: `1px solid ${COLORS.outlineBorder}`,
};

function statusPillStyle(
  active: boolean,
  variant: "all" | "running" | "ended",
): React.CSSProperties {
  if (!active) {
    return {
      ...chipBase,
      color: COLORS.textMuted,
      background: "transparent",
      border: `1px solid ${COLORS.outlineBorder}`,
    };
  }
  switch (variant) {
    case "all":
      return {
        ...chipBase,
        color: COLORS.accent,
        background: `${COLORS.accent}18`,
        border: `1px solid ${COLORS.accent}30`,
      };
    case "running":
      return {
        ...chipBase,
        color: COLORS.success,
        background: `${COLORS.success}18`,
        border: `1px solid ${COLORS.success}30`,
      };
    case "ended":
      return {
        ...chipBase,
        color: COLORS.info,
        background: `${COLORS.info}15`,
        border: `1px solid ${COLORS.info}30`,
      };
  }
}

const searchInputStyle: React.CSSProperties = {
  height: 28,
  width: "100%",
  borderRadius: 0,
  border: `1px solid ${COLORS.outlineBorder}`,
  background: COLORS.recessedBg,
  padding: "0 10px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  outline: "none",
};

const groupHeaderBg: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  marginBottom: 4,
  background: `${COLORS.pageBg}E6`, // 90% opacity
  backdropFilter: "blur(8px)",
};

const groupLabelBase: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  flexShrink: 0,
};

const headerLineBase: React.CSSProperties = {
  flex: 1,
  height: 1,
  marginLeft: 8,
};

/* ── component ────────────────────────────────────────────────────── */

export function SessionListPane({
  lanes,
  filtered,
  runningFiltered,
  endedFiltered,
  loading: _loading,
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
  onLaunchPty: (laneId: string, profile: "claude" | "codex" | "shell", tracked?: boolean) => void;
  onLaunchChat: (laneId: string) => void;
  onInfoClick: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContextMenu: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
}) {
  const statusOptions = [
    { value: "all" as const, label: "ALL", variant: "all" as const },
    { value: "running" as const, label: "RUNNING", variant: "running" as const },
    { value: "completed" as const, label: "ENDED", variant: "ended" as const },
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
      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Lane filter chips */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none pb-0.5">
          <button
            type="button"
            style={filterLaneId === "all" ? chipActive : chipInactive}
            onClick={() => setFilterLaneId("all")}
          >
            ALL
          </button>
          {lanes.map((l) => (
            <button
              key={l.id}
              type="button"
              style={{
                ...(filterLaneId === l.id ? chipActive : chipInactive),
                maxWidth: 100,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
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
              style={statusPillStyle(filterStatus === opt.value, opt.variant)}
              onClick={() => setFilterStatus(opt.value === "completed" ? opt.value : opt.value as TerminalSessionStatus | "all")}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Search bar */}
        <input
          style={searchInputStyle}
          placeholder="SEARCH BY NAME, LANE, TYPE..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = COLORS.accent;
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = COLORS.outlineBorder;
          }}
        />
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-auto">
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
            <div
              style={{
                marginBottom: 12,
                padding: 12,
                borderRadius: 0,
                background: `${COLORS.accent}15`,
                border: `1px solid ${COLORS.accent}25`,
              }}
            >
              <Terminal size={20} weight="regular" style={{ color: COLORS.accent }} />
            </div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: COLORS.textSecondary,
              }}
            >
              NO TERMINAL SESSIONS
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                fontFamily: MONO_FONT,
                color: COLORS.textMuted,
                lineHeight: 1.5,
                maxWidth: 220,
              }}
            >
              Start a new session to begin working.
            </div>
          </div>
        ) : (
          <div className="px-2 pb-2">
            {/* Running group */}
            {runningFiltered.length > 0 && (
              <div>
                <div style={groupHeaderBg}>
                  <span
                    style={{
                      height: 6,
                      width: 6,
                      borderRadius: 0,
                      background: COLORS.success,
                      animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ ...groupLabelBase, color: COLORS.success }}>
                    RUNNING &middot; {runningFiltered.length}
                  </span>
                  <span
                    style={{
                      ...headerLineBase,
                      background: `linear-gradient(to right, ${COLORS.success}40, transparent)`,
                    }}
                  />
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
              <div className={runningFiltered.length > 0 ? "mt-4" : ""}>
                <div style={groupHeaderBg}>
                  <span
                    style={{
                      height: 6,
                      width: 6,
                      borderRadius: 0,
                      background: COLORS.textDim,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ ...groupLabelBase, color: COLORS.textMuted }}>
                    ENDED &middot; {endedFiltered.length}
                  </span>
                  <span
                    style={{
                      ...headerLineBase,
                      background: `linear-gradient(to right, ${COLORS.textMuted}30, transparent)`,
                    }}
                  />
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
