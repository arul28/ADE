import React from "react";
import { CaretUpDown, Stack } from "@phosphor-icons/react";
import type { FilesWorkspace } from "../../../../shared/types";
import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";

function branchShort(ws: FilesWorkspace): string {
  return (ws.branchRef ?? "").replace(/^refs\/heads\//, "") || ws.kind;
}

function labelFor(ws: FilesWorkspace): string {
  return `${ws.name} · ${branchShort(ws)}`;
}

/** Compact workspace/lane picker pinned above the file tree (purple-accented). */
export function WorkspacePicker({
  workspaces,
  workspaceId,
  onChange,
}: {
  workspaces: FilesWorkspace[];
  workspaceId: string;
  onChange: (workspaceId: string) => void;
}) {
  const active = workspaces.find((w) => w.id === workspaceId);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 px-2 py-1.5"
      style={{ borderBottom: `1px solid ${COLORS.border}` }}
    >
      <Stack size={13} color={COLORS.accent} weight="fill" />
      <div className="relative flex min-w-0 flex-1 items-center">
        <select
          value={workspaceId}
          title={active ? labelFor(active) : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none truncate rounded-md py-1 pl-2 pr-6 text-xs outline-none"
          style={{
            fontFamily: MONO_FONT,
            fontWeight: 600,
            color: "var(--color-accent-bright)",
            background: COLORS.accentSubtle,
            border: `1px solid ${COLORS.accentBorder}`,
            cursor: "pointer",
          }}
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id} title={labelFor(ws)} style={{ color: COLORS.textPrimary, background: COLORS.cardBgSolid }}>
              {labelFor(ws)}
            </option>
          ))}
        </select>
        <CaretUpDown size={12} color={COLORS.accent} style={{ position: "absolute", right: 6, pointerEvents: "none" }} />
      </div>
    </div>
  );
}
