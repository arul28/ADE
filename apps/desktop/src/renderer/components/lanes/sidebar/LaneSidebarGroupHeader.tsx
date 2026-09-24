import React from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowsClockwise,
  CaretDown,
  DotsThree,
  Trash,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { useClampedFixedPosition } from "../../../hooks/useClampedFixedPosition";
import { LaneMenuGroups } from "../LaneContextMenu";
import type { LaneMenuEntry } from "../laneContextMenuItems";
import { COLORS } from "../laneDesignTokens";
import {
  laneGroupBulkActions,
  type LaneGroupBulkAction,
  type LaneStateGroupId,
} from "./laneSidebarModel";

type LaneStateGroupMeta = {
  label: string;
  /** Plain-English tooltip for the header. */
  description: string;
};

export const LANE_STATE_GROUP_META: Record<LaneStateGroupId, LaneStateGroupMeta> = {
  "needs-you": {
    label: "Needs you",
    description: "An agent is waiting, a PR is failing or has conflicts, or a rebase broke.",
  },
  active: {
    label: "Active",
    description: "An agent is working here, or the lane changed in the last two hours.",
  },
  behind: {
    label: "Behind main",
    description: "The lane's base has moved on. Rebase to catch up.",
  },
  done: {
    label: "Done",
    description: "The lane's pull request merged.",
  },
  stale: {
    label: "Stale",
    description: "Nothing happened here for two weeks, and it has no open PR.",
  },
  quiet: {
    label: "Quiet",
    description: "Everything else.",
  },
};

const BULK_ACTION_META: Record<LaneGroupBulkAction, { icon: Icon; label: (count: number) => string }> = {
  archive: { icon: Archive, label: (count) => `Archive all ${count}` },
  rebase: { icon: ArrowsClockwise, label: (count) => `Rebase all ${count}` },
  delete: { icon: Trash, label: (count) => `Delete all ${count}…` },
};

/**
 * Header above one State group: name, muted count, a hairline, then a hover
 * "…" for bulk actions and the collapse chevron. Same shape as the Work
 * list's group headers so both sidebars read as one app. "Needs you" alone
 * gets a small amber dot, because it is a status, not a category.
 */
export function LaneSidebarGroupHeader({
  groupId,
  count,
  collapsed,
  onToggleCollapsed,
  onOpenMenu,
}: {
  groupId: LaneStateGroupId;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Opens the bulk-action menu at a point. Absent when the group has none. */
  onOpenMenu: ((point: { x: number; y: number }) => void) | null;
}) {
  const meta = LANE_STATE_GROUP_META[groupId];
  return (
    <div
      role="heading"
      aria-level={3}
      data-testid="lane-sidebar-group-header"
      data-group-id={groupId}
      className="group/header relative flex h-7 select-none items-center gap-1 rounded-md pl-2 pr-1 transition-colors hover:bg-fg/[0.03]"
      title={meta.description}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden text-left"
        aria-expanded={!collapsed}
        aria-label={`${meta.label} (${count})`}
        onClick={onToggleCollapsed}
      >
        {groupId === "needs-you" ? (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: COLORS.warning }} />
        ) : null}
        <span className="shrink-0 truncate text-[11px] font-medium leading-none text-fg/75">
          {meta.label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums leading-none text-muted-fg/50">
          {count}
        </span>
        <span aria-hidden className="ml-1 h-px min-w-2 flex-1 bg-fg/[0.06]" />
      </button>
      {/* The slot is always there so every header's hairline ends at the
          same x, with or without a menu. */}
      {onOpenMenu ? (
        <button
          type="button"
          data-testid="lane-sidebar-group-menu-button"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-fg/[0.08] focus-visible:opacity-100 group-hover/header:opacity-100"
          style={{ color: COLORS.textMuted }}
          aria-label={`${meta.label} actions`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <DotsThree size={14} weight="bold" />
        </button>
      ) : (
        <span aria-hidden className="h-5 w-5 shrink-0" />
      )}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-fg/[0.08]"
        onClick={onToggleCollapsed}
      >
        <CaretDown
          size={11}
          className={cn("shrink-0 text-muted-fg/35 transition-transform", !collapsed && "rotate-180")}
        />
      </button>
    </div>
  );
}

/** Whether a group's header gets a "…" menu at all. */
export function laneGroupHasActions(groupId: LaneStateGroupId): boolean {
  return laneGroupBulkActions(groupId).length > 0;
}

/**
 * The bulk-action menu for one State group. Every entry opens a confirm step
 * that lists the lanes it affects; nothing runs from the menu itself.
 */
export function LaneSidebarGroupMenu({
  menu,
  onClose,
  onAction,
}: {
  menu: { groupId: LaneStateGroupId; laneIds: string[]; x: number; y: number };
  onClose: () => void;
  onAction: (action: LaneGroupBulkAction, laneIds: string[]) => void;
}) {
  const { ref: menuRef, position } = useClampedFixedPosition({ x: menu.x, y: menu.y }, `${menu.groupId}:${menu.x}:${menu.y}`);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const onPointerDown = () => onClose();
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  React.useEffect(() => {
    menuRef.current?.focus();
  }, [menuRef]);

  const count = menu.laneIds.length;
  const entries: LaneMenuEntry[] = laneGroupBulkActions(menu.groupId).map((action) => ({
    kind: "action",
    key: action,
    label: BULK_ACTION_META[action].label(count),
    icon: BULK_ACTION_META[action].icon,
    onSelect: () => {
      onClose();
      onAction(action, menu.laneIds);
    },
  }));

  // Portaled to the body: the sidebar host can be a containing block for
  // fixed elements, which would offset the menu from the pointer.
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      data-testid="lane-sidebar-group-menu"
      className="ade-liquid-glass-menu"
      style={{
        position: "fixed",
        zIndex: 40,
        minWidth: 180,
        border: `1px solid ${COLORS.outlineBorder}`,
        padding: "4px 0",
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <LaneMenuGroups
        groups={[{ key: "bulk", label: LANE_STATE_GROUP_META[menu.groupId].label, entries }]}
        onClose={onClose}
      />
    </div>,
    document.body,
  );
}
