import React from "react";
import { CaretDown, CaretUp, Terminal, X } from "@phosphor-icons/react";
import type { LaneSummary, ProcessDefinition, ProcessEvent, ProcessRuntime } from "../../../shared/types";
import { formatDurationMs } from "../../lib/format";
import { commandArrayToLine } from "../../lib/shell";
import { TerminalView } from "../terminals/TerminalView";
import { COLORS, inlineBadge, LABEL_STYLE, MONO_FONT, processStatusColor } from "../lanes/laneDesignTokens";
import { formatProcessStatus, hasInspectableProcessOutput, isActiveProcessStatus } from "./processUtils";

type MonitorFocusTarget =
  | { kind: "process"; id: string }
  | { kind: "shell"; id: string };

export type RunShellSession = {
  sessionId: string;
  ptyId: string;
  title: string;
  laneId: string;
};

type ProcessMonitorProps = {
  runtimes: ProcessRuntime[];
  processDefinitions: Record<string, ProcessDefinition>;
  processNames: Record<string, string>;
  lanes: LaneSummary[];
  shellSessions?: RunShellSession[];
  focusTarget?: MonitorFocusTarget | null;
  focusSequence?: number;
  onKill: (runtime: ProcessRuntime) => void;
  onCloseShell?: (sessionId: string) => void;
};

const GRID_COLUMNS = "minmax(0, 1.5fr) 110px 90px 90px 110px 54px";
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

function sortRuntimes(runtimes: ProcessRuntime[]): ProcessRuntime[] {
  return [...runtimes].sort((left, right) => {
    const activeDelta = Number(isActiveProcessStatus(right.status)) - Number(isActiveProcessStatus(left.status));
    if (activeDelta !== 0) return activeDelta;
    const rightValue = Date.parse(right.updatedAt || right.startedAt || right.endedAt || "");
    const leftValue = Date.parse(left.updatedAt || left.startedAt || left.endedAt || "");
    return (Number.isFinite(rightValue) ? rightValue : 0) - (Number.isFinite(leftValue) ? leftValue : 0);
  });
}

export function ProcessMonitor({
  runtimes,
  processDefinitions,
  processNames,
  lanes,
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
  const logRef = React.useRef<HTMLDivElement | null>(null);

  const orderedRuntimes = React.useMemo(() => sortRuntimes(runtimes), [runtimes]);
  const activeRuntimes = orderedRuntimes.filter((runtime) => isActiveProcessStatus(runtime.status));
  const inspectableRuntimes = React.useMemo(
    () => orderedRuntimes.filter((runtime) => hasInspectableProcessOutput(runtime)),
    [orderedRuntimes],
  );
  const activeRuntime = activeView?.kind === "process"
    ? inspectableRuntimes.find((runtime) => runtime.runId === activeView.id) ?? null
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
      && inspectableRuntimes.some((runtime) => runtime.runId === activeView.id);
    const hasActiveShell = activeView?.kind === "shell"
      && shellSessions.some((session) => session.sessionId === activeView.id);
    if (hasActiveProcess || hasActiveShell) return;

    const preferredProcess =
      inspectableRuntimes.find((runtime) => isActiveProcessStatus(runtime.status))
      ?? inspectableRuntimes[0]
      ?? null;
    if (preferredProcess) {
      setActiveView({ kind: "process", id: preferredProcess.runId });
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
      const current = activeViewRef.current;
      if (!current || current.kind !== "process" || event.runId !== current.id) return;
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
    if (!activeRuntime || activeView?.kind !== "process" || activeRuntimeHasTerminal) {
      setLogText("");
      setLogError(null);
      setLogLoading(false);
      return;
    }
    let cancelled = false;
    setPauseAutoscroll(false);
    setLogError(null);
    setLogLoading(true);
    setLogText("");
    window.ade.processes
      .getLogTail({
        laneId: activeRuntime.laneId,
        processId: activeRuntime.processId,
        runId: activeRuntime.runId,
        maxBytes: LOG_TAIL_MAX_BYTES,
      })
      .then((log) => {
        const current = activeViewRef.current;
        if (cancelled || !current || current.kind !== "process" || current.id !== activeRuntime.runId) return;
        setLogText(normalizeLog(log));
        setLogLoading(false);
      })
      .catch((error) => {
        const current = activeViewRef.current;
        if (cancelled || !current || current.kind !== "process" || current.id !== activeRuntime.runId) return;
        setLogText("");
        setLogError(error instanceof Error ? error.message : String(error));
        setLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRuntime, activeRuntimeHasTerminal, activeView]);

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
  const activeDetailPanel = activeRuntime || activeShell ? (
    <div style={{ margin: "8px 0 12px", border: `1px solid ${COLORS.border}` }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          borderBottom: `1px solid ${COLORS.border}`,
          background: COLORS.pageBg,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textPrimary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {activeRuntime
              ? `${processNames[activeRuntime.processId] ?? activeRuntime.processId} @ ${lanes.find((lane) => lane.id === activeRuntime.laneId)?.name ?? activeRuntime.laneId}`
              : activeShell?.title}
          </div>
          {activeCommand ? (
            <div
              style={{
                marginTop: 4,
                fontFamily: MONO_FONT,
                fontSize: 10,
                color: COLORS.textDim,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activeCommand}
              {`  ·  ${activeCwd}`}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ height: 300, minHeight: 220, overflow: "hidden", background: COLORS.pageBg }}>
        {activeRuntime && activeRuntimeHasTerminal && activeRuntime.sessionId && activeRuntime.ptyId ? (
          <TerminalView
            sessionId={activeRuntime.sessionId}
            ptyId={activeRuntime.ptyId}
            isActive
            isVisible
            className="h-full w-full rounded-none"
          />
        ) : activeShell ? (
          <TerminalView
            sessionId={activeShell.sessionId}
            ptyId={activeShell.ptyId}
            isActive
            isVisible
            className="h-full w-full rounded-none"
          />
        ) : (
          <div
            ref={logRef}
            onScroll={(event) => {
              const target = event.currentTarget;
              const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
              setPauseAutoscroll(!nearBottom);
            }}
            style={{
              height: "100%",
              overflowY: "auto",
              color: COLORS.textPrimary,
              fontFamily: MONO_FONT,
              fontSize: 11,
              lineHeight: 1.5,
              padding: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {logError ? (
              <span style={{ color: COLORS.danger }}>{logError}</span>
            ) : logText ? (
              logText
            ) : (
              <span style={{ color: COLORS.textDim }}>{logPlaceholder}</span>
            )}
          </div>
        )}
      </div>
    </div>
  ) : null;

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

        <span style={inlineBadge(activeRuntimes.length > 0 ? COLORS.success : COLORS.textMuted, { fontSize: 9, padding: "1px 6px" })}>
          {activeRuntimes.length} active
        </span>

        {!expanded ? (
          <div style={{ display: "flex", gap: 6, flex: 1, overflow: "hidden" }}>
            {activeRuntimes.slice(0, 8).map((runtime) => {
              const laneName = lanes.find((lane) => lane.id === runtime.laneId)?.name ?? runtime.laneId;
              return (
                <span
                  key={runtime.runId}
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textSecondary,
                    background: `${processStatusColor(runtime.status)}18`,
                    border: `1px solid ${processStatusColor(runtime.status)}30`,
                    padding: "1px 6px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {(processNames[runtime.processId] ?? runtime.processId)}
                  {` @ ${laneName}`}
                </span>
              );
            })}
            {activeRuntimes.length > 8 ? (
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>+{activeRuntimes.length - 8}</span>
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
                }}
              >
                {shellSessions.length} shell{shellSessions.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        ) : <div style={{ flex: 1 }} />}
      </button>

      {expanded ? (
        <div style={{ maxHeight: "65vh", overflowY: "auto", padding: "0 16px 12px" }}>
          {activeDetailPanel}

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
            <span>Run</span>
            <span>Status</span>
            <span>Lane</span>
            <span>Uptime</span>
            <span>Ended</span>
            <span />
          </div>

          {orderedRuntimes.length === 0 ? (
            <div style={{ padding: "12px 0", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>
              No command sessions yet.
            </div>
          ) : (
            orderedRuntimes.map((runtime) => {
              const laneName = lanes.find((lane) => lane.id === runtime.laneId)?.name ?? runtime.laneId;
              const active = activeView?.kind === "process" && activeView.id === runtime.runId;
              return (
                <div
                  key={runtime.runId}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveView({ kind: "process", id: runtime.runId })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setActiveView({ kind: "process", id: runtime.runId });
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: GRID_COLUMNS,
                    gap: 8,
                    width: "100%",
                    padding: "8px 0",
                    background: active ? COLORS.hoverBg : "transparent",
                    border: "none",
                    borderBottom: `1px solid ${COLORS.border}`,
                    cursor: "pointer",
                    textAlign: "left",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 11,
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
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textSecondary }}>{laneName}</span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                    {runtime.uptimeMs ? formatDurationMs(runtime.uptimeMs) : "—"}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                    {formatEndedAt(runtime.lastEndedAt ?? runtime.endedAt)}
                  </span>
                  {isActiveProcessStatus(runtime.status) ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onKill(runtime);
                      }}
                      style={{
                        width: 24,
                        height: 24,
                        background: "transparent",
                        border: "none",
                        color: COLORS.danger,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      aria-label={`Stop ${processNames[runtime.processId] ?? runtime.processId}`}
                    >
                      <X size={14} weight="bold" />
                    </button>
                  ) : <span />}
                </div>
              );
            })
          )}

          {shellSessions.length > 0 ? (
            <>
              <div
                style={{
                  padding: "10px 0 6px",
                  ...LABEL_STYLE,
                  fontSize: 9,
                }}
              >
                Shells
              </div>
              {shellSessions.map((session) => {
                const active = activeView?.kind === "shell" && activeView.id === session.sessionId;
                const laneName = lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId;
                return (
                  <div
                    key={session.sessionId}
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveView({ kind: "shell", id: session.sessionId })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setActiveView({ kind: "shell", id: session.sessionId });
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      padding: "8px 0",
                      background: active ? COLORS.hoverBg : "transparent",
                      border: "none",
                      borderBottom: `1px solid ${COLORS.border}`,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <Terminal size={14} weight="bold" style={{ color: COLORS.textMuted }} />
                    <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary, flex: 1 }}>
                      {session.title}
                    </span>
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>{laneName}</span>
                    {onCloseShell ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseShell(session.sessionId);
                        }}
                        style={{
                          width: 24,
                          height: 24,
                          background: "transparent",
                          border: "none",
                          color: COLORS.textMuted,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                        aria-label={`Close ${session.title}`}
                      >
                        <X size={14} weight="bold" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : null}

        </div>
      ) : null}
    </div>
  );
}
