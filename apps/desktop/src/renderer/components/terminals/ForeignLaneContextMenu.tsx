import React, { useEffect } from "react";
import type { LaneSummary } from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import { buildWebClientUrl } from "../../../shared/webClientUrl";
import { openExternalUrl } from "../../lib/openExternal";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import {
  HoverButton,
  menuItemStyle,
} from "../lanes/LaneContextMenu";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type ForeignLaneContextMenuProps = {
  lane: LaneSummary;
  machineName: string;
  /** Live, not captured: every action below runs on the owning machine. */
  online: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onStartChat: () => void;
  onManage: () => void;
  onOpenInLanes: () => void;
};

function branchNameFromRef(ref: string | null | undefined): string {
  return ref?.replace(/^refs\/heads\//, "") ?? "";
}

export function ForeignLaneContextMenu({
  lane,
  machineName,
  online,
  x,
  y,
  onClose,
  onStartChat,
  onManage,
  onOpenInLanes,
}: ForeignLaneContextMenuProps) {
  const { ref, position } = useClampedFixedPosition(
    { x, y },
    `${machineName}:${lane.id}`,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    ref.current?.focus();
  }, [ref]);

  const copyText = (value: string) => {
    onClose();
    void window.ade.app.writeClipboardText(value).catch(() => {});
  };
  const separator = (
    <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
  );
  const branch = branchNameFromRef(lane.branchRef);

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="ade-liquid-glass-menu"
      style={{
        position: "fixed",
        zIndex: 50,
        minWidth: 220,
        maxHeight: "calc(100vh - 20px)",
        overflowY: "auto",
        border: `1px solid ${COLORS.outlineBorder}`,
        padding: "4px 0",
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div style={{ padding: "6px 14px 7px", fontFamily: MONO_FONT }}>
        <div
          style={{
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 700,
            color: COLORS.textPrimary,
          }}
        >
          {lane.name}
        </div>
        <div style={{ marginTop: 2, fontSize: 9.5, color: COLORS.textDim }}>
          {machineName}{online ? "" : " · offline"}
        </div>
      </div>
      {separator}
      <HoverButton style={menuItemStyle} disabled={!online} onClick={onStartChat}>
        Start chat in lane
      </HoverButton>
      <HoverButton style={menuItemStyle} disabled={!online} onClick={onManage}>
        Manage lane
      </HoverButton>
      <HoverButton style={menuItemStyle} disabled={!online} onClick={onOpenInLanes}>
        Open in Lanes
      </HoverButton>
      {lane.worktreePath ? (
        <>
          {separator}
          <HoverButton
            style={menuItemStyle}
            onClick={() => copyText(lane.worktreePath ?? "")}
          >
            Copy path
          </HoverButton>
        </>
      ) : null}
      {separator}
      <HoverButton
        style={menuItemStyle}
        onClick={() => copyText(buildDeeplink(
          { kind: "lane", laneId: lane.id },
          { form: "ade" },
        ))}
      >
        Copy ADE Lane Link
      </HoverButton>
      <HoverButton
        style={menuItemStyle}
        onClick={() => {
          onClose();
          openExternalUrl(buildWebClientUrl({ kind: "lane", laneId: lane.id }));
        }}
      >
        Open in web
      </HoverButton>
      {branch ? (
        <HoverButton
          style={menuItemStyle}
          onClick={() => copyText(branch)}
        >
          Copy branch name
        </HoverButton>
      ) : null}
      {lane.linearIssue?.url ? (
        <HoverButton
          style={menuItemStyle}
          onClick={() => copyText(lane.linearIssue?.url ?? "")}
        >
          Copy Linear Issue Link
        </HoverButton>
      ) : null}
    </div>
  );
}
