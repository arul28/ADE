import React from "react";
import { CaretDown, CaretUp, Terminal, X } from "@phosphor-icons/react";
import type { ProcessDefinition, ProcessEvent, ProcessRuntime } from "../../../shared/types";
import { formatDurationMs } from "../../lib/format";
import { commandArrayToLine } from "../../lib/shell";
import { TerminalView } from "../terminals/TerminalView";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, processStatusColor } from "../lanes/laneDesignTokens";
import { formatProcessStatus, hasInspectableProcessOutput, isActiveProcessStatus } from "./processUtils";

type MonitorFocusTarget =
  | { kind: "process"; id: string }
  | { kind: "shell"; id: string };

export type RunShellSession = {
  sessionId: string;
  ptyId: string;
  title: string;
};

type ProcessMonitorProps = {
  laneId: string | null;
  runtimes: ProcessRuntime[];
  processDefinitions: Record<string, ProcessDefinition>;
  processNames: Record<string, string>;
  shellSessions?: RunShellSession[];
  focusTarget?: MonitorFocusTarget | null;
  focusSequence?: number;
  onKill: (processId: string) => void;
  onCloseShell?: (sessionId: string) => void;
};

const GRID_COLUMNS = "1fr 80px 80px 80px 50px";
const LOG_TAIL_MAX_BYTES = 220_000;

function normalizeLog(raw: string): string {
  return raw.replace(/\u0000/g, "");
}

function formatEndedAt(
  value: string | null,
  locale: string | undefined = typeof navigator !== "undefined" ? navigator.language : undefined,
  options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" },
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(locale, options);
}

export function ProcessMonitor({
  laneId,
  runtimes,
  processDefinitions,
  processNames,
  shellSessions = [],
  focusTarget = null,
  focusSequence = 0,
  onKill,
  onCloseShell,
}: ProcessMonitorProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [activeView, setActiveView] = React.useState<MonitorFocusTarget | null>(null);
  const [logText, setLogText] = React.useState("");
  const [logLoading, setLogLoading] = React.useState(false);
  const [logError, setLogError] = React.useState<string | null>(null);
  const [pauseAutoscroll, setPauseAutoscroll] = React.useState(false);
  const activeViewRef = React.useRef<MonitorFocusTarget | null>(null);
  activeViewRef.current = activeView;
  const laneIdRef = React.useRef<string | null>(laneId);
  laneIdRef.current = laneId;
  const logRef = React.useRef<HTMLDivElement | null>(null);

  const activeRuntimes = runtimes.filter((runtime) => isActiveProcessStatus(runtime.status));
  const activeCount = activeRuntimes.length;
  const inspectableRuntimes = React.useMemo(
    () => runtimes.filter((runtime) => hasInspectableProcessOutput(runtime)),
    [runtimes],
  );
  const activeRuntime = activeView?.kind === "process"
    ? inspectableRuntimes.find((runtime) => runtime.processId === activeView.id) ?? null
    : null;
  const activeShell = activeView?.kind === "shell"
    ? shellSessions.find((session) => session.sessionId === activeView.id) ?? null
    : null;
  const activeRuntimeHasTerminal = Boolean(
    activeRuntime
    && activeRuntime.sessionId
    && activeRuntime.ptyId
    && isActiveProcessStatus(activeRuntime.status),
  );

  React.useEffect(() => {
    const hasActiveProcess = activeView?.kind === "process"
      && inspectableRuntimes.some((runtime) => runtime.processId === activeView.id);
    const hasActiveShell = activeView?.kind === "shell"
      && shellSessions.some((session) => session.sessionId === activeView.id);
    if (hasActiveProcess || hasActiveShell) return;

    const preferredProcess =
      inspectableRuntimes.find((runtime) => isActiveProcessStatus(runtime.status))
      ?? inspectableRuntimes.find((runtime) => runtime.status === "crashed")
      ?? inspectableRuntimes[0]
      ?? null;

    if (preferredProcess) {
      setActiveView({ kind: "process", id: preferredProcess.processId });
      return;
    }
    if (shellSessions.length > 0) {
      setActiveView({ kind: "shell", id: shellSessions[shellSessions.length - 1]!.sessionId });
      return;
    }
    setActiveView(null);
  }, [activeView, inspectableRuntimes, shellSessions]);

  React.useEffect(() => {
    if (!focusTarget) return;
    setExpanded(true);
    setPauseAutoscroll(false);
    setActiveView(focusTarget);
  }, [focusSequence, focusTarget]);

  React.useEffect(() => {
    const unsubscribe = window.ade.processes.onEvent((event: ProcessEvent) => {
      if (event.type !== "log") return;
      if (event.laneId !== laneIdRef.current) return;
      const current = activeViewRef.current;
      if (!current || current.kind !== "process" || event.processId !== current.id) return;
      setLogText((prev) => {
        const next = normalizeLog(`${prev}${event.chunk}`);
        return next.length > LOG_TAIL_MAX_BYTES ? next.slice(-LOG_TAIL_MAX_BYTES) : next;
      });
    });
    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, []);

  React.useEffect(() => {
    if (!laneId || !activeRuntime || activeView?.kind !== "process" || activeRuntimeHasTerminal) {
      setLogText("");
      setLogError(null);
      setLogLoading(false);
      return;
    }
    let cancelled = false;
    const processId = activeRuntime.processId;
    setPauseAutoscroll(false);
    setLogError(null);
    setLogLoading(true);
    setLogText("");
    window.ade.processes
      .getLogTail({ laneId, processId, maxBytes: LOG_TAIL_MAX_BYTES })
      .then((log) => {
        const current = activeViewRef.current;
        if (cancelled || !current || current.kind !== "process" || current.id !== processId) return;
        setLogText(normalizeLog(log));
        setLogLoading(false);
      })
      .catch((error) => {
        const current = activeViewRef.current;
        if (cancelled || !current || current.kind !== "process" || current.id !== processId) return;
        setLogText("");
        setLogError(error instanceof Error ? error.message : String(error));
        setLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRuntime, activeRuntimeHasTerminal, activeView, laneId]);

  React.useEffect(() => {
    if (pauseAutoscroll) return;
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logText, pauseAutoscroll]);

  const activeDefinition = activeRuntime ? processDefinitions[activeRuntime.processId] ?? null : null;
  const activeCommand = activeDefinition ? commandArrayToLine(activeDefinition.command) : null;
  const activeCwd = activeDefinition?.cwd?.trim()?.length ? activeDefinition.cwd : ".";
  const logPlaceholder = logLoading
    ? "Loading recent output..."
    : activeRuntime && isActiveProcessStatus(activeRuntime.status)
      ? "Waiting for output..."
      : "(no output yet)";

  return (
    <div
      style={{
        background: COLORS.recessedBg,
        borderTop: `1px solid ${COLORS.border}`,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
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
          {activeCount} active
        </span>

        {!expanded ? (
          <div style={{ display: "flex", gap: 6, flex: 1, overflow: "hidden" }}>
            {activeRuntimes.slice(0, 8).map((runtime) => (
              <span
                key={runtime.processId}
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: COLORS.textSecondary,
                  background: `${processStatusColor(runtime.status)}18`,
                  border: `1px solid ${processStatusColor(runtime.status)}30`,
                  padding: "1px 6px",
                  whiteSpace: "nowrap",
                  borderRadius: 0,
                }}
              >
                {processNames[runtime.processId] ?? runtime.processId}
                {runtime.ports.length > 0 ? ` :${runtime.ports[0]}` : ""}
              </span>
            ))}
            {activeRuntimes.length > 8 ? (
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                +{activeRuntimes.length - 8}
              </span>
            ) : null}
            {shellSessions.length > 0 ? (
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  color: COLORS.textSecondary,
                  background: `${COLORS.info}18`,
                  border: `1px solid ${COLORS.info}30`,
                  padding: "1px 6px",
                  whiteSpace: "nowrap",
                  borderRadius: 0,
                }}
              >
                {shellSessions.length} shell{shellSessions.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {inspectableRuntimes.length > 0 ? (
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
                {inspectableRuntimes.length} output tab{inspectableRuntimes.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        ) : <div style={{ flex: 1 }} />}
      </button>

      {expanded ? (
        <div
          style={{
            maxHeight: 400,
            overflowY: "auto",
            padding: "0 16px 12px",
          }}
        >
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
            runtimes.map((runtime) => (
              <div
                key={runtime.processId}
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
                  {processNames[runtime.processId] ?? runtime.processId}
                </span>
                <span style={inlineBadge(processStatusColor(runtime.status), { fontSize: 9, padding: "1px 6px" })}>
                  {formatProcessStatus(runtime)}
                </span>
                <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                  {(runtime.uptimeMs ?? 0) > 0 ? formatDurationMs(runtime.uptimeMs ?? 0) : "—"}
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
                  {runtime.ports.length > 0 ? runtime.ports.map((port) => `:${port}`).join(", ") : "\u2014"}
                </span>
                <button
                  type="button"
                  onClick={() => onKill(runtime.processId)}
                  disabled={!isActiveProcessStatus(runtime.status)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    background: "transparent",
                    border: `1px solid ${isActiveProcessStatus(runtime.status) ? `${COLORS.danger}30` : COLORS.border}`,
                    borderRadius: 0,
                    color: isActiveProcessStatus(runtime.status) ? COLORS.danger : COLORS.textDim,
                    cursor: isActiveProcessStatus(runtime.status) ? "pointer" : "default",
                    opacity: isActiveProcessStatus(runtime.status) ? 1 : 0.4,
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
              {activeRuntime && !activeRuntimeHasTerminal && logText ? (
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(logText).catch(() => {})}
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textMuted,
                    background: "transparent",
                    border: `1px solid ${COLORS.border}`,
                    padding: "4px 8px",
                    cursor: "pointer",
                  }}
                >
                  Copy logs
                </button>
              ) : null}
            </div>

            {inspectableRuntimes.length === 0 && shellSessions.length === 0 ? (
              <div
                style={{
                  padding: "10px 0 2px",
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textDim,
                }}
              >
                Start a command or open a shell to inspect output here.
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
                  {inspectableRuntimes.map((runtime) => {
                    const isSelected = activeView?.kind === "process" && activeView.id === runtime.processId;
                    const label = processNames[runtime.processId] ?? runtime.processId;
                    return (
                      <button
                        key={runtime.processId}
                        type="button"
                        onClick={() => setActiveView({ kind: "process", id: runtime.processId })}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                          padding: "6px 10px",
                          background: isSelected ? COLORS.hoverBg : "transparent",
                          border: `1px solid ${isSelected ? COLORS.accent : COLORS.border}`,
                          color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
                          cursor: "pointer",
                          fontFamily: MONO_FONT,
                          fontSize: 11,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                        {!isActiveProcessStatus(runtime.status) ? (
                          <span style={inlineBadge(processStatusColor(runtime.status), { fontSize: 8, padding: "1px 5px" })}>
                            {formatProcessStatus(runtime)}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}

                  {shellSessions.map((session) => {
                    const isSelected = activeView?.kind === "shell" && activeView.id === session.sessionId;
                    return (
                      <div
                        key={session.sessionId}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          minWidth: 0,
                          border: `1px solid ${isSelected ? COLORS.info : COLORS.border}`,
                          background: isSelected ? `${COLORS.info}14` : "transparent",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveView({ kind: "shell", id: session.sessionId })}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            minWidth: 0,
                            padding: "6px 10px",
                            background: "transparent",
                            border: "none",
                            color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
                            cursor: "pointer",
                            fontFamily: MONO_FONT,
                            fontSize: 11,
                            whiteSpace: "nowrap",
                          }}
                        >
                          <Terminal size={12} weight="regular" />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{session.title}</span>
                        </button>
                        {onCloseShell ? (
                          <button
                            type="button"
                            onClick={() => onCloseShell(session.sessionId)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 24,
                              height: 24,
                              marginRight: 4,
                              background: "transparent",
                              border: "none",
                              color: COLORS.textDim,
                              cursor: "pointer",
                            }}
                            title="Close shell"
                          >
                            <X size={10} weight="bold" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {activeRuntime ? (
                  <div
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.pageBg,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "10px 12px",
                        borderBottom: `1px solid ${COLORS.border}`,
                        background: COLORS.recessedBg,
                      }}
                    >
                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: 11,
                              fontWeight: 700,
                              color: COLORS.textPrimary,
                            }}
                          >
                            {processNames[activeRuntime.processId] ?? activeRuntime.processId}
                          </span>
                          <span style={inlineBadge(processStatusColor(activeRuntime.status), { fontSize: 8, padding: "1px 5px" })}>
                            {formatProcessStatus(activeRuntime)}
                          </span>
                          {activeRuntime.lastEndedAt ? (
                            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                              ended {formatEndedAt(activeRuntime.lastEndedAt)}
                            </span>
                          ) : null}
                        </div>
                        {activeCommand ? (
                          <div
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: 10,
                              color: COLORS.textSecondary,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={activeCommand}
                          >
                            {activeCommand}
                          </div>
                        ) : null}
                        <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                          cwd {activeCwd}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onKill(activeRuntime.processId)}
                        disabled={!isActiveProcessStatus(activeRuntime.status)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 24,
                          height: 24,
                          background: COLORS.cardBg,
                          border: `1px solid ${isActiveProcessStatus(activeRuntime.status) ? `${COLORS.danger}30` : COLORS.border}`,
                          color: isActiveProcessStatus(activeRuntime.status) ? COLORS.danger : COLORS.textDim,
                          cursor: isActiveProcessStatus(activeRuntime.status) ? "pointer" : "default",
                          opacity: isActiveProcessStatus(activeRuntime.status) ? 1 : 0.45,
                        }}
                        title="Kill process"
                      >
                        <X size={12} weight="bold" />
                      </button>
                    </div>

                    {!activeRuntimeHasTerminal && logError ? (
                      <div
                        style={{
                          padding: "10px 12px 0",
                          fontFamily: MONO_FONT,
                          fontSize: 11,
                          color: COLORS.danger,
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {logError}
                      </div>
                    ) : null}

                    {activeRuntimeHasTerminal && activeRuntime?.sessionId && activeRuntime?.ptyId ? (
                      <div style={{ height: 220 }}>
                        <TerminalView
                          ptyId={activeRuntime.ptyId}
                          sessionId={activeRuntime.sessionId}
                          isActive
                          isVisible
                          className="h-full w-full"
                        />
                      </div>
                    ) : (
                      <div
                        ref={logRef}
                        onScroll={(event) => {
                          const element = event.currentTarget;
                          const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                          setPauseAutoscroll(distanceFromBottom > 24);
                        }}
                        style={{
                          height: 220,
                          overflowY: "auto",
                          overflowX: "hidden",
                          padding: 12,
                          border: `1px solid ${COLORS.border}`,
                          borderWidth: "1px 0 0",
                        }}
                      >
                        <pre
                          style={{
                            margin: 0,
                            fontFamily: MONO_FONT,
                            fontSize: 11,
                            color: COLORS.textPrimary,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            lineHeight: 1.5,
                          }}
                        >
                          {logText || logPlaceholder}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : activeShell ? (
                  <div
                    style={{
                      border: `1px solid ${COLORS.border}`,
                      background: COLORS.pageBg,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "10px 12px",
                        borderBottom: `1px solid ${COLORS.border}`,
                        background: COLORS.recessedBg,
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                        <span
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: 11,
                            fontWeight: 700,
                            color: COLORS.textPrimary,
                          }}
                        >
                          {activeShell.title}
                        </span>
                        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                          Interactive shell for the selected lane
                        </span>
                      </div>
                      {onCloseShell ? (
                        <button
                          type="button"
                          onClick={() => onCloseShell(activeShell.sessionId)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 24,
                            height: 24,
                            background: COLORS.cardBg,
                            border: `1px solid ${COLORS.border}`,
                            color: COLORS.textDim,
                            cursor: "pointer",
                          }}
                          title="Close shell"
                        >
                          <X size={12} weight="bold" />
                        </button>
                      ) : null}
                    </div>

                    <div style={{ height: 220 }}>
                      <TerminalView
                        ptyId={activeShell.ptyId}
                        sessionId={activeShell.sessionId}
                        isActive
                        isVisible
                        className="h-full w-full"
                      />
                    </div>
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
                    Select a process or shell to inspect output.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
