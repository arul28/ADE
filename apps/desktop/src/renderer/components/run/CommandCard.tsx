import React from "react";
import { ArrowClockwise, DotsThreeVertical, Play, Stop } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, inlineBadge, processStatusColor } from "../lanes/laneDesignTokens";
import { formatDurationMs } from "../../lib/format";
import type { ProcessDefinition, ProcessRuntime } from "../../../shared/types";
import { useClickOutside } from "../../hooks/useClickOutside";
import { commandArrayToLine } from "../../lib/shell";
import { formatProcessStatus, isActiveProcessStatus } from "./processUtils";

type CommandCardProps = {
  definition: ProcessDefinition;
  runtime: ProcessRuntime | null;
  onRun: (processId: string) => void;
  onStop: (processId: string) => void;
  onRestart: (processId: string) => void;
  onEdit: (processId: string) => void;
  onDelete: (processId: string) => void;
  onMoveToStack: (processId: string) => void;
  stacks?: { id: string }[];
};

export function CommandCard({
  definition,
  runtime,
  onRun,
  onStop,
  onRestart,
  onEdit,
  onDelete,
  onMoveToStack,
  stacks,
}: CommandCardProps) {
  const status = runtime?.status;
  const running = status ? isActiveProcessStatus(status) : false;
  const statusText = runtime && status && status !== "stopped" ? formatProcessStatus(runtime) : null;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  const commandPreview = commandArrayToLine(definition.command);

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderLeft:
          statusText && status
            ? `3px solid ${processStatusColor(status)}`
            : `1px solid ${COLORS.border}`,
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
            background: processStatusColor(status),
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
        {statusText && status && (
          <span style={inlineBadge(processStatusColor(status), { fontSize: 9, padding: "1px 6px" })}>
            {statusText}
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
              {([
                { label: "Edit", action: () => onEdit(definition.id) },
                ...((stacks?.length ?? 0) > 0
                  ? [{ label: "Move to stack", action: () => onMoveToStack(definition.id) }]
                  : []),
                { label: "Delete", action: () => onDelete(definition.id), danger: true },
              ] as Array<{ label: string; action: () => void; danger?: boolean }>).map((item) => (
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
                    color: item.danger ? COLORS.danger : COLORS.textSecondary,
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

      {/* Ports (when running) */}
      {running && runtime && runtime.ports.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {runtime.ports.map((port) => (
            <button
              key={port}
              type="button"
              onClick={() => {
                void window.ade.app.openExternal(`http://localhost:${port}`);
              }}
              aria-label={`Open localhost:${port} in browser`}
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                color: COLORS.accent,
                cursor: "pointer",
                background: "transparent",
                border: "none",
                borderBottom: `1px dashed ${COLORS.accent}40`,
                padding: 0,
              }}
            >
              :{port}
            </button>
          ))}
        </div>
      )}

      {/* Action row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {running ? (
          <>
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
            <button
              type="button"
              onClick={() => onRestart(definition.id)}
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
                color: COLORS.textSecondary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                borderRadius: 0,
                cursor: "pointer",
              }}
            >
              <ArrowClockwise size={12} weight="bold" />
              Restart
            </button>
          </>
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
            {formatDurationMs(runtime.uptimeMs ?? 0)}
          </span>
        )}
      </div>
    </div>
  );
}
