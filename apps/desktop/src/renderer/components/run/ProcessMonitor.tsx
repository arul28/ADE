import React from "react";
import { CaretUp, CaretDown, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge } from "../lanes/laneDesignTokens";
import type { ProcessRuntime, ProcessRuntimeStatus } from "../../../shared/types";

export type ProcessMonitorProps = {
  runtimes: ProcessRuntime[];
  processNames: Record<string, string>; // processId -> display name
  onKill: (processId: string) => void;
};

function statusColor(status: ProcessRuntimeStatus): string {
  switch (status) {
    case "running":
      return COLORS.success;
    case "starting":
    case "stopping":
      return COLORS.warning;
    case "degraded":
    case "crashed":
    case "exited":
      return COLORS.danger;
    default:
      return COLORS.textDim;
  }
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function ProcessMonitor({ runtimes, processNames, onKill }: ProcessMonitorProps) {
  const [expanded, setExpanded] = React.useState(false);
  const activeRuntimes = runtimes.filter((r) => r.status !== "stopped");
  const activeCount = activeRuntimes.length;

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
                  background: `${statusColor(rt.status)}18`,
                  border: `1px solid ${statusColor(rt.status)}30`,
                  padding: "1px 6px",
                  whiteSpace: "nowrap",
                  borderRadius: 0,
                }}
              >
                {processNames[rt.processId] ?? rt.processId}
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
          </div>
        )}
      </button>

      {/* Expanded table */}
      {expanded && (
        <div
          style={{
            maxHeight: 200,
            overflowY: "auto",
            padding: "0 16px 12px",
          }}
        >
          {/* Table header */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px 70px 80px 50px",
              gap: 8,
              padding: "6px 0",
              borderBottom: `1px solid ${COLORS.border}`,
              ...LABEL_STYLE,
              fontSize: 9,
            }}
          >
            <span>Name</span>
            <span>Status</span>
            <span>PID</span>
            <span>Uptime</span>
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
                  gridTemplateColumns: "1fr 80px 70px 80px 50px",
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
                <span style={inlineBadge(statusColor(rt.status), { fontSize: 9, padding: "1px 6px" })}>
                  {rt.status}
                </span>
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textMuted,
                  }}
                >
                  {rt.pid ?? "—"}
                </span>
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textMuted,
                  }}
                >
                  {(rt.uptimeMs ?? 0) > 0 ? formatUptime(rt.uptimeMs ?? 0) : "—"}
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
        </div>
      )}
    </div>
  );
}
