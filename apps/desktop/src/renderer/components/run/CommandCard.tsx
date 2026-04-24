import React from "react";
import { DotsThreeVertical, Play, Stop } from "@phosphor-icons/react";
import type { LaneSummary, ProcessDefinition, ProcessGroupDefinition, ProcessRuntime } from "../../../shared/types";
import { COLORS, MONO_FONT, inlineBadge, processStatusColor } from "../lanes/laneDesignTokens";
import { useClickOutside } from "../../hooks/useClickOutside";
import { commandArrayToLine } from "../../lib/shell";
import { formatDurationMs } from "../../lib/format";
import { formatProcessStatus, isActiveProcessStatus } from "./processUtils";

type CommandCardProps = {
  definition: ProcessDefinition;
  lanes: LaneSummary[];
  groups: ProcessGroupDefinition[];
  selectedLaneId: string | null;
  runtimes: ProcessRuntime[];
  onSelectLane: (processId: string, laneId: string) => void;
  onRun: (processId: string) => void;
  onStop: (processId: string) => void;
  onEdit: (processId: string) => void;
  onDelete: (processId: string) => void;
};

function sortRuntimes(runtimes: ProcessRuntime[]): ProcessRuntime[] {
  return [...runtimes].sort((left, right) => {
    const activeDelta = Number(isActiveProcessStatus(right.status)) - Number(isActiveProcessStatus(left.status));
    if (activeDelta !== 0) return activeDelta;
    const rightValue = Date.parse(right.updatedAt || right.startedAt || right.endedAt || "");
    const leftValue = Date.parse(left.updatedAt || left.startedAt || left.endedAt || "");
    return (Number.isFinite(rightValue) ? rightValue : 0) - (Number.isFinite(leftValue) ? leftValue : 0);
  });
}

export function CommandCard({
  definition,
  lanes,
  groups,
  selectedLaneId,
  runtimes,
  onSelectLane,
  onRun,
  onStop,
  onEdit,
  onDelete,
}: CommandCardProps) {
  const hasLanes = lanes.length > 0;
  const laneId = selectedLaneId && lanes.some((item) => item.id === selectedLaneId)
    ? selectedLaneId
    : lanes[0]?.id ?? "";
  const lane = hasLanes ? lanes.find((item) => item.id === laneId) ?? null : null;
  const orderedRuntimes = React.useMemo(() => sortRuntimes(runtimes), [runtimes]);
  const latestRuntime = orderedRuntimes[0] ?? null;
  const activeRuntimes = orderedRuntimes.filter((runtime) => isActiveProcessStatus(runtime.status));
  const activeCount = activeRuntimes.length;
  const status = latestRuntime?.status ?? "stopped";
  const statusText = latestRuntime ? formatProcessStatus(latestRuntime) : "stopped";
  const commandPreview = commandArrayToLine(definition.command);
  const portList = Array.from(new Set(activeRuntimes.flatMap((runtime) => runtime.ports ?? []))).sort((a, b) => a - b);
  const groupLabels = groups.filter((group) => (definition.groupIds ?? []).includes(group.id));
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderLeft: `3px solid ${processStatusColor(status)}`,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: processStatusColor(status),
            flexShrink: 0,
          }}
        />
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
        <span style={inlineBadge(processStatusColor(status), { fontSize: 9, padding: "1px 6px" })}>{statusText}</span>
        {activeCount > 1 ? (
          <span style={inlineBadge(COLORS.accent, { fontSize: 9, padding: "1px 6px" })}>{activeCount} runs</span>
        ) : null}
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
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
          {menuOpen ? (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                zIndex: 50,
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.border}`,
                minWidth: 140,
                padding: "4px 0",
              }}
            >
              {[
                { label: "Edit", action: () => onEdit(definition.id) },
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
                    color: item.danger ? COLORS.danger : COLORS.textSecondary,
                    cursor: "pointer",
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 8, alignItems: "center" }}>
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, textTransform: "uppercase" }}>Lane</span>
        <select
          value={hasLanes ? laneId : "__none__"}
          disabled={!hasLanes}
          onChange={(event) => onSelectLane(definition.id, event.target.value)}
          style={{
            height: 28,
            padding: "0 8px",
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 0,
            fontFamily: MONO_FONT,
            fontSize: 11,
            color: COLORS.textPrimary,
            outline: "none",
            appearance: "none",
            cursor: hasLanes ? "pointer" : "default",
            opacity: hasLanes ? 1 : 0.55,
          }}
        >
          {hasLanes ? (
            lanes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))
          ) : (
            <option value="__none__">No lanes available</option>
          )}
        </select>
      </div>

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

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.textSecondary,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.outlineBorder}`,
            padding: "2px 6px",
          }}
        >
          {lane?.name ?? "No lane"}
        </span>
        {groupLabels.map((group) => (
          <span
            key={group.id}
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: COLORS.textSecondary,
              background: COLORS.pageBg,
              border: `1px solid ${COLORS.border}`,
              padding: "2px 6px",
            }}
          >
            {group.name}
          </span>
        ))}
      </div>

      {portList.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {portList.map((port) => (
            <button
              key={port}
              type="button"
              onClick={() => {
                void window.ade.app.openExternal(`http://localhost:${port}`);
              }}
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
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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

        {activeCount > 0 ? (
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
            Stop all
          </button>
        ) : null}

        {latestRuntime?.uptimeMs && latestRuntime.uptimeMs > 0 ? (
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: COLORS.textDim,
              marginLeft: "auto",
            }}
          >
            {formatDurationMs(latestRuntime.uptimeMs)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
