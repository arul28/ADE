import React from "react";
import { CaretUp, CaretDown, Terminal, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge, processStatusColor } from "../lanes/laneDesignTokens";
import { formatDurationMs } from "../../lib/format";
import { commandArrayToLine } from "../../lib/shell";
import type { ProcessDefinition, ProcessEvent, ProcessRuntime } from "../../../shared/types";
import { formatProcessStatus, hasInspectableProcessOutput, isActiveProcessStatus } from "./processUtils";

type ProcessMonitorProps = {
  laneId: string | null;
  runtimes: ProcessRuntime[];
  processDefinitions: Record<string, ProcessDefinition>;
  processNames: Record<string, string>; // processId -> display name
  onKill: (processId: string) => void;
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

export function ProcessMonitor({ laneId, runtimes, processDefinitions, processNames, onKill }: ProcessMonitorProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [activeProcessId, setActiveProcessId] = React.useState<string | null>(null);
  const [logText, setLogText] = React.useState("");
  const [logLoading, setLogLoading] = React.useState(false);
  const [logError, setLogError] = React.useState<string | null>(null);
  const [pauseAutoscroll, setPauseAutoscroll] = React.useState(false);
  const activeProcessIdRef = React.useRef<string | null>(null);
  activeProcessIdRef.current = activeProcessId;
  const laneIdRef = React.useRef<string | null>(laneId);
  laneIdRef.current = laneId;
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const activeRuntimes = runtimes.filter((runtime) => isActiveProcessStatus(runtime.status));
  const activeCount = activeRuntimes.length;
  const inspectableRuntimes = React.useMemo(
    () => runtimes.filter((runtime) => hasInspectableProcessOutput(runtime)),
    [runtimes],
  );
  const activeRuntime = inspectableRuntimes.find((runtime) => runtime.processId === activeProcessId) ?? null;

  React.useEffect(() => {
    if (inspectableRuntimes.length === 0) {
      setActiveProcessId(null);
      return;
    }
    if (activeProcessId && inspectableRuntimes.some((runtime) => runtime.processId === activeProcessId)) return;
    const preferred =
      inspectableRuntimes.find((runtime) => isActiveProcessStatus(runtime.status))
      ?? inspectableRuntimes.find((runtime) => runtime.status === "crashed")
      ?? inspectableRuntimes[0]
      ?? null;
    setActiveProcessId(preferred?.processId ?? null);
  }, [activeProcessId, inspectableRuntimes]);

  React.useEffect(() => {
    const unsubscribe = window.ade.processes.onEvent((event: ProcessEvent) => {
      if (event.type !== "log") return;
      if (event.laneId !== laneIdRef.current) return;
      if (event.processId !== activeProcessIdRef.current) return;
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
    if (!laneId || !activeRuntime) {
      setLogText("");
      setLogError(null);
      setLogLoading(false);
      return;
    }
    let cancelled = false;
    const processId = activeRuntime.processId;
    activeProcessIdRef.current = processId;
    setPauseAutoscroll(false);
    setLogError(null);
    setLogLoading(true);
    window.ade.processes
      .getLogTail({ laneId, processId, maxBytes: LOG_TAIL_MAX_BYTES })
      .then((log) => {
        if (cancelled || activeProcessIdRef.current !== processId) return;
        setLogText(normalizeLog(log));
        setLogLoading(false);
      })
      .catch((error) => {
        if (cancelled || activeProcessIdRef.current !== processId) return;
        setLogText("");
        setLogError(error instanceof Error ? error.message : String(error));
        setLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRuntime, laneId]);

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
            {inspectableRuntimes.length > 0 && (
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
                  {formatProcessStatus(rt)}
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
                  disabled={!isActiveProcessStatus(rt.status)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    background: "transparent",
                    border: `1px solid ${isActiveProcessStatus(rt.status) ? COLORS.danger + "30" : COLORS.border}`,
                    borderRadius: 0,
                    color: isActiveProcessStatus(rt.status) ? COLORS.danger : COLORS.textDim,
                    cursor: isActiveProcessStatus(rt.status) ? "pointer" : "default",
                    opacity: isActiveProcessStatus(rt.status) ? 1 : 0.4,
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

            {inspectableRuntimes.length === 0 ? (
              <div
                style={{
                  padding: "10px 0 2px",
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textDim,
                }}
              >
                Start a command to see its stdout and stderr here.
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
                    const isActive = runtime.processId === activeRuntime?.processId;
                    const label = processNames[runtime.processId] ?? runtime.processId;
                    return (
                      <button
                        key={runtime.processId}
                        type="button"
                        onClick={() => setActiveProcessId(runtime.processId)}
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
                          {label}
                        </span>
                        {!isActiveProcessStatus(runtime.status) && (
                          <span style={inlineBadge(processStatusColor(runtime.status), { fontSize: 8, padding: "1px 5px" })}>
                            {formatProcessStatus(runtime)}
                          </span>
                        )}
                      </button>
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
                            <span
                              style={{
                                fontFamily: MONO_FONT,
                                fontSize: 10,
                                color: COLORS.textDim,
                              }}
                            >
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
                        <div
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: 10,
                            color: COLORS.textDim,
                          }}
                        >
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
                          border: `1px solid ${isActiveProcessStatus(activeRuntime.status) ? COLORS.danger + "30" : COLORS.border}`,
                          color: isActiveProcessStatus(activeRuntime.status) ? COLORS.danger : COLORS.textDim,
                          cursor: isActiveProcessStatus(activeRuntime.status) ? "pointer" : "default",
                          opacity: isActiveProcessStatus(activeRuntime.status) ? 1 : 0.45,
                        }}
                        title="Kill process"
                      >
                        <X size={12} weight="bold" />
                      </button>
                    </div>

                    {logError ? (
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
                    Select a process to inspect its output.
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
