import React from "react";
import { Play, Stop, DotsThreeVertical } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, inlineBadge } from "../lanes/laneDesignTokens";
import type { ProcessDefinition, ProcessRuntime, ProcessRuntimeStatus } from "../../../shared/types";
import { useClickOutside } from "../../hooks/useClickOutside";

export type CommandCardProps = {
  definition: ProcessDefinition;
  runtime: ProcessRuntime | null;
  onRun: (processId: string) => void;
  onStop: (processId: string) => void;
  onEdit: (processId: string) => void;
  onDelete: (processId: string) => void;
  onMoveToStack: (processId: string) => void;
};

function statusDotColor(status: ProcessRuntimeStatus | undefined): string {
  switch (status) {
    case "running":
      return COLORS.success;
    case "starting":
      return COLORS.warning;
    case "degraded":
    case "crashed":
    case "exited":
      return COLORS.danger;
    case "stopping":
      return COLORS.warning;
    default:
      return COLORS.textDim;
  }
}

function isActive(status: ProcessRuntimeStatus | undefined): boolean {
  return status === "running" || status === "starting" || status === "stopping";
}

export function CommandCard({
  definition,
  runtime,
  onRun,
  onStop,
  onEdit,
  onDelete,
  onMoveToStack,
}: CommandCardProps) {
  const status = runtime?.status;
  const running = isActive(status);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  const commandPreview = definition.command.join(" ");

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderLeft: running ? `3px solid ${COLORS.success}` : `1px solid ${COLORS.border}`,
        borderRadius: 0,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = COLORS.hoverBg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = COLORS.cardBg;
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Status dot */}
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: statusDotColor(status),
            flexShrink: 0,
          }}
        />
        {/* Name */}
        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: 12,
            fontWeight: 700,
            color: COLORS.textPrimary,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {definition.name}
        </div>

        {/* Status badge (when running) */}
        {running && status && (
          <span style={inlineBadge(COLORS.success, { fontSize: 9, padding: "1px 6px" })}>
            {status}
          </span>
        )}

        {/* Overflow menu */}
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            style={{
              background: "transparent",
              border: "none",
              color: COLORS.textMuted,
              cursor: "pointer",
              padding: 2,
              display: "flex",
              alignItems: "center",
            }}
          >
            <DotsThreeVertical size={16} weight="bold" />
          </button>
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                zIndex: 50,
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 0,
                minWidth: 140,
                padding: "4px 0",
              }}
            >
              {[
                { label: "Edit", action: () => onEdit(definition.id) },
                { label: "Move to stack", action: () => onMoveToStack(definition.id) },
                { label: "Delete", action: () => onDelete(definition.id), danger: true },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    item.action();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "6px 12px",
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    fontWeight: 600,
                    color: (item as any).danger ? COLORS.danger : COLORS.textSecondary,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = COLORS.hoverBg;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Command preview */}
      <div
        style={{
          fontFamily: MONO_FONT,
          fontSize: 11,
          color: COLORS.textMuted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={commandPreview}
      >
        {commandPreview}
      </div>

      {/* Action row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {running ? (
          <button
            type="button"
            onClick={() => onStop(definition.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              height: 28,
              padding: "0 10px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: COLORS.danger,
              background: `${COLORS.danger}18`,
              border: `1px solid ${COLORS.danger}30`,
              borderRadius: 0,
              cursor: "pointer",
            }}
          >
            <Stop size={12} weight="fill" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRun(definition.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              height: 28,
              padding: "0 10px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: COLORS.pageBg,
              background: COLORS.accent,
              border: `1px solid ${COLORS.accent}`,
              borderRadius: 0,
              cursor: "pointer",
            }}
          >
            <Play size={12} weight="fill" />
            Run
          </button>
        )}

        {/* Uptime if running */}
        {running && runtime && (runtime.uptimeMs ?? 0) > 0 && (
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: COLORS.textDim,
              marginLeft: "auto",
            }}
          >
            {formatUptime(runtime.uptimeMs ?? 0)}
          </span>
        )}
      </div>
    </div>
  );
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
