import React from "react";
import { DotsThreeVertical, Play, Plus, Terminal, X } from "@phosphor-icons/react";
import type { LaneSummary, ProcessDefinition, ProcessGroupDefinition, ProcessRuntime } from "../../../shared/types";
import { COLORS, MONO_FONT, inlineBadge, outlineButton, processStatusColor } from "../lanes/laneDesignTokens";
import { useClickOutside } from "../../hooks/useClickOutside";
import { commandArrayToLine } from "../../lib/shell";
import { formatDurationMs } from "../../lib/format";
import { formatEndedAt, formatProcessStatus, isActiveProcessStatus } from "./processUtils";

type CommandCardProps = {
  definition: ProcessDefinition;
  lanes: LaneSummary[];
  groups: ProcessGroupDefinition[];
  selectedLaneId: string | null;
  runtimes: ProcessRuntime[];
  onSelectLane: (processId: string, laneId: string) => void;
  onRun: (processId: string) => void;
  onEdit: (processId: string) => void;
  onDelete: (processId: string) => void;
  onAddToGroup?: (processId: string, groupId: string) => void;
  onKillRuntime?: (runtime: ProcessRuntime) => void;
  onOpenRuntime?: (runtime: ProcessRuntime) => void;
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
  onEdit,
  onDelete,
  onAddToGroup,
  onKillRuntime,
  onOpenRuntime,
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
  const groupLabels = groups.filter((group) => (definition.groupIds ?? []).includes(group.id));
  const availableGroups = React.useMemo(
    () => groups.filter((group) => !(definition.groupIds ?? []).includes(group.id)),
    [groups, definition.groupIds],
  );
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [groupPickerOpen, setGroupPickerOpen] = React.useState(false);
  const groupPickerRef = React.useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);
  useClickOutside(groupPickerRef, () => setGroupPickerOpen(false), groupPickerOpen);

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
                background: COLORS.cardBgSolid,
                border: `1px solid ${COLORS.border}`,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
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

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center" }}>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.textDim,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          Lane
        </span>
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
          fontWeight: 700,
          color: COLORS.textMuted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={commandPreview}
      >
        {commandPreview}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
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
        {onAddToGroup && groups.length > 0 ? (
          <div ref={groupPickerRef} style={{ position: "relative" }}>
            <button
              type="button"
              title={availableGroups.length === 0 ? "Already in every group" : "Add to another group"}
              disabled={availableGroups.length === 0}
              onClick={() => availableGroups.length > 0 && setGroupPickerOpen((open) => !open)}
              style={{
                ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }),
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                opacity: availableGroups.length === 0 ? 0.45 : 1,
                cursor: availableGroups.length === 0 ? "default" : "pointer",
              }}
            >
              <Plus size={11} weight="bold" />
              Add to group
            </button>
            {groupPickerOpen && availableGroups.length > 0 ? (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 4,
                  zIndex: 50,
                  minWidth: 160,
                  padding: "4px 0",
                  background: COLORS.cardBgSolid,
                  border: `1px solid ${COLORS.border}`,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                }}
              >
                {availableGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => {
                      onAddToGroup(definition.id, group.id);
                      setGroupPickerOpen(false);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      padding: "7px 12px",
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      fontWeight: 600,
                      color: COLORS.textSecondary,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = COLORS.hoverBg;
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = "transparent";
                    }}
                  >
                    {group.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

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
      </div>

      <div
        data-tour="run.commandRuntime"
        style={{
          paddingTop: 10,
          marginTop: 2,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, rowGap: 6 }}>
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              fontWeight: 700,
              color: COLORS.textDim,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Runtime
          </span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textSecondary }}>
            {lane?.name ?? "—"}
          </span>
        </div>

        {latestRuntime ? (
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, rowGap: 6 }}>
            <span style={inlineBadge(processStatusColor(latestRuntime.status), { fontSize: 9, padding: "1px 6px" })}>
              {formatProcessStatus(latestRuntime)}
            </span>
            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
              Uptime{" "}
              {isActiveProcessStatus(latestRuntime.status) && latestRuntime.uptimeMs != null && latestRuntime.uptimeMs > 0
                ? formatDurationMs(latestRuntime.uptimeMs)
                : "—"}
            </span>
            <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
              Ended{" "}
              {isActiveProcessStatus(latestRuntime.status)
                ? "—"
                : formatEndedAt(latestRuntime.lastEndedAt ?? latestRuntime.endedAt)}
            </span>
            {onKillRuntime && activeRuntimes.length > 0 ? (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                {activeRuntimes.map((runtime) => (
                  <button
                    key={runtime.runId}
                    type="button"
                    onClick={() => onKillRuntime(runtime)}
                    title="Force stop this run"
                    aria-label={`Force stop run ${runtime.runId}`}
                    style={{
                      width: 28,
                      height: 28,
                      background: "color-mix(in srgb, var(--color-error) 14%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
                      color: COLORS.danger,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <X size={14} weight="bold" />
                  </button>
                ))}
              </div>
            ) : null}
            {onOpenRuntime && latestRuntime.sessionId && latestRuntime.ptyId ? (
              <button
                type="button"
                onClick={() => onOpenRuntime(latestRuntime)}
                title="Open terminal"
                aria-label={`Open terminal for run ${latestRuntime.runId}`}
                style={{
                  ...outlineButton({ height: 24, padding: "0 8px", fontSize: 9 }),
                  marginLeft: activeRuntimes.length > 0 ? 0 : "auto",
                }}
              >
                <Terminal size={12} weight="bold" />
                Terminal
              </button>
            ) : null}
          </div>
        ) : (
          <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>No runs on this lane yet.</div>
        )}
      </div>
    </div>
  );
}
