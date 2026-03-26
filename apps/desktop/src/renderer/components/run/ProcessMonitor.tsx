import React from "react";
import { CaretUp, CaretDown, Terminal, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge, processStatusColor } from "../lanes/laneDesignTokens";
import { formatDurationMs } from "../../lib/format";
import { TerminalView } from "../terminals/TerminalView";
import type { ProcessRuntime, TerminalSessionSummary } from "../../../shared/types";
import { isRunOwnedSession } from "../../lib/sessions";

type ProcessMonitorProps = {
  laneId: string | null;
  runtimes: ProcessRuntime[];
  processNames: Record<string, string>; // processId -> display name
  onKill: (processId: string) => void;
};

const GRID_COLUMNS = "1fr 80px 80px 80px 50px";

export function ProcessMonitor({ laneId, runtimes, processNames, onKill }: ProcessMonitorProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [sessions, setSessions] = React.useState<TerminalSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;
  const activeRuntimes = runtimes.filter((r) => r.status !== "stopped");
  const activeCount = activeRuntimes.length;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null;

  const refreshSessions = React.useCallback(async () => {
    if (!laneId) {
      setSessions([]);
      return;
    }
    try {
      const rows = await window.ade.sessions.list({ laneId, limit: 80 });
      setSessions(
        rows.filter((session) => isRunOwnedSession(session) && session.ptyId),
      );
    } catch {
      // best effort
    }
  }, [laneId]);

  React.useEffect(() => {
    void refreshSessions();
  }, [refreshSessions, runtimes.length]);

  React.useEffect(() => {
    if (sessions.length === 0) {
      setActiveSessionId(null);
      return;
    }
    if (sessions.some((session) => session.id === activeSessionId)) return;
    setActiveSessionId(sessions[0]?.id ?? null);
  }, [activeSessionId, sessions]);

  React.useEffect(() => {
    const unsubData = window.ade.pty.onData((event) => {
      if (!sessionsRef.current.some((session) => session.id === event.sessionId)) {
        void refreshSessions();
        return;
      }
      setSessions((prev) =>
        prev.map((session) =>
          session.id === event.sessionId
            ? { ...session, lastOutputPreview: event.data.slice(-240) }
            : session,
        ),
      );
    });
    const unsubExit = window.ade.pty.onExit((event) => {
      if (!sessionsRef.current.some((session) => session.id === event.sessionId)) return;
      void refreshSessions();
    });
    return () => {
      try {
        unsubData();
        unsubExit();
      } catch {
        // ignore
      }
    };
  }, [refreshSessions]);

  const closeSession = React.useCallback(async (session: TerminalSessionSummary) => {
    if (!session.ptyId) return;
    try {
      await window.ade.pty.dispose({ ptyId: session.ptyId, sessionId: session.id });
    } finally {
      await refreshSessions();
    }
  }, [refreshSessions]);

  return (
    <div
      style={{
        background: COLORS.recessedBg,
        borderTop: `1px solid ${COLORS.border}`,
        flexShrink: 0,
      }}
    >
      {/* Collapsed bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          height: 36,
          padding: "0 16px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {expanded ? (
          <CaretDown size={12} weight="bold" style={{ color: COLORS.textMuted }} />
        ) : (
          <CaretUp size={12} weight="bold" style={{ color: COLORS.textMuted }} />
        )}

        <span
          style={inlineBadge(activeCount > 0 ? COLORS.success : COLORS.textMuted, {
            fontSize: 9,
            padding: "1px 6px",
          })}
        >
          {activeCount} ACTIVE
        </span>

        {/* Inline pills for running processes */}
        {!expanded && (
          <div style={{ display: "flex", gap: 6, flex: 1, overflow: "hidden" }}>
            {activeRuntimes.slice(0, 8).map((rt) => (
              <span
                key={rt.processId}
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: COLORS.textSecondary,
                  background: `${processStatusColor(rt.status)}18`,
                  border: `1px solid ${processStatusColor(rt.status)}30`,
                  padding: "1px 6px",
                  whiteSpace: "nowrap",
                  borderRadius: 0,
                }}
              >
                {processNames[rt.processId] ?? rt.processId}
                {rt.ports.length > 0 && ` :${rt.ports[0]}`}
              </span>
            ))}
            {activeRuntimes.length > 8 && (
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: COLORS.textDim,
                }}
              >
                +{activeRuntimes.length - 8}
              </span>
            )}
            {sessions.length > 0 && (
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: COLORS.textSecondary,
                  background: `${COLORS.accent}18`,
                  border: `1px solid ${COLORS.accent}30`,
                  padding: "1px 6px",
                  whiteSpace: "nowrap",
                  borderRadius: 0,
                }}
              >
                {sessions.length} inspector tab{sessions.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Expanded table */}
      {expanded && (
        <div
          style={{
            maxHeight: 360,
            overflowY: "auto",
            padding: "0 16px 12px",
          }}
        >
          {/* Table header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: GRID_COLUMNS,
              gap: 8,
              padding: "6px 0",
              borderBottom: `1px solid ${COLORS.border}`,
              ...LABEL_STYLE,
              fontSize: 9,
            }}
          >
            <span>Name</span>
            <span>Status</span>
            <span>Uptime</span>
            <span>Ports</span>
            <span />
          </div>

          {/* Rows */}
          {runtimes.length === 0 ? (
            <div
              style={{
                padding: "12px 0",
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: COLORS.textDim,
                textAlign: "center",
              }}
            >
              No processes
            </div>
          ) : (
            runtimes.map((rt) => (
              <div
                key={rt.processId}
                style={{
                  display: "grid",
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: 8,
                  padding: "6px 0",
                  borderBottom: `1px solid ${COLORS.border}`,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    fontWeight: 600,
                    color: COLORS.textPrimary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {processNames[rt.processId] ?? rt.processId}
                </span>
                <span style={inlineBadge(processStatusColor(rt.status), { fontSize: 9, padding: "1px 6px" })}>
                  {rt.status}
                </span>
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textMuted,
                  }}
                >
                  {(rt.uptimeMs ?? 0) > 0 ? formatDurationMs(rt.uptimeMs ?? 0) : "—"}
                </span>
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textMuted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {rt.ports.length > 0 ? rt.ports.map((p) => `:${p}`).join(", ") : "\u2014"}
                </span>
                <button
                  type="button"
                  onClick={() => onKill(rt.processId)}
                  disabled={rt.status === "stopped"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    background: "transparent",
                    border: `1px solid ${rt.status === "stopped" ? COLORS.border : COLORS.danger + "30"}`,
                    borderRadius: 0,
                    color: rt.status === "stopped" ? COLORS.textDim : COLORS.danger,
                    cursor: rt.status === "stopped" ? "default" : "pointer",
                    opacity: rt.status === "stopped" ? 0.4 : 1,
                  }}
                  title="Kill process"
                >
                  <X size={12} weight="bold" />
                </button>
              </div>
            ))
          )}

          <div
            style={{
              marginTop: 14,
              borderTop: `1px solid ${COLORS.border}`,
              paddingTop: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Terminal size={14} weight="regular" style={{ color: COLORS.textMuted }} />
                <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Output</span>
              </div>
            </div>

            {sessions.length === 0 ? (
              <div
                style={{
                  padding: "10px 0 2px",
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textDim,
                }}
              >
                Start a command to open its inspector terminal here.
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    overflowX: "auto",
                    paddingBottom: 8,
                  }}
                >
                  {sessions.map((session) => {
                    const isActive = session.id === activeSession?.id;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => setActiveSessionId(session.id)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                          padding: "6px 10px",
                          background: isActive ? COLORS.hoverBg : "transparent",
                          border: `1px solid ${isActive ? COLORS.accent : COLORS.border}`,
                          color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                          cursor: "pointer",
                          fontFamily: MONO_FONT,
                          fontSize: 11,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {session.title}
                        </span>
                        {session.status !== "running" && (
                          <span style={inlineBadge(processStatusColor("exited"), { fontSize: 8, padding: "1px 5px" })}>
                            ended
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {activeSession?.ptyId ? (
                  <div
                    style={{
                      height: 220,
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.pageBg,
                      position: "relative",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void closeSession(activeSession)}
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        zIndex: 2,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 24,
                        height: 24,
                        background: COLORS.cardBg,
                        border: `1px solid ${COLORS.border}`,
                        color: COLORS.textMuted,
                        cursor: "pointer",
                      }}
                      title="Close inspector terminal"
                    >
                      <X size={12} weight="bold" />
                    </button>
                    <TerminalView ptyId={activeSession.ptyId} sessionId={activeSession.id} className="h-full" />
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "10px 0 2px",
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      color: COLORS.textDim,
                    }}
                  >
                    This inspector terminal has ended.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
