import { useMemo, useState } from "react";
import {
  Alarm,
  ArrowCounterClockwise,
  Archive,
  ArrowSquareOut,
  CheckCircle,
  ClockCountdown,
  Copy,
  Gear,
  GitBranch,
  PushPin,
  PushPinSlash,
  SquaresFour,
  Stop,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { LaneSummary, OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { canBulkStopSession } from "../../lib/sessions";
import {
  canonicalInputFromSummary,
  sessionCanonicalUiState,
  sessionIsMidFlight,
  sessionNeedsYou,
} from "../../lib/terminalAttention";
import { isSessionSnoozed, resolveSnoozePresets } from "../../lib/sessionSnooze";
import { MAX_WORK_GRID_TILES } from "../../lib/workGrid";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../ui/ContextMenu";
import {
  settleSessions,
  snoozeSessionsForDuration,
  unsettleSessions,
  wakeSessions,
} from "./sessionLifecycleActions";

/** What the Lanes tab should do with the lanes behind a multi-selection. */
export type BulkLaneIntent = "open" | "manage" | "archive" | "delete";

type SessionBulkContextMenuProps = {
  menu: ContextMenuState;
  /** The live selection, in the order the sidebar shows it. */
  sessions: TerminalSessionSummary[];
  /** The tab's own lanes. Lanes on other machines are not in here. */
  lanes: LaneSummary[];
  /**
   * Sessions in the tab's own roster — the rows the sidebar draws as local.
   * Their lanes are the ones the Lanes tab can manage. The runtime pin is not
   * used for this: it can name a machine for a row the sidebar shows as local.
   */
  localSessionIds: ReadonlySet<string>;
  resolvePin: (session: TerminalSessionSummary) => OpenProjectBinding | null;
  onClose: () => void;
  pinnedSessionIds: string[];
  onSetPinned: (sessionIds: string[], pinned: boolean) => void;
  gridSessionIds: string[];
  /** Sessions a grid can host: the tab's own, loaded sessions. */
  gridableSessionIds: ReadonlySet<string>;
  onOpenInGrid: (sessionIds: string[]) => void;
  onRemoveFromGrid: (sessionIds: string[]) => void;
  onStopRuntimes: () => void;
  onDelete: () => void;
  onStopAndDelete: () => void;
  onCopySessionIds: (sessionIds: string[]) => void;
  onLanes: (laneIds: string[], intent: BulkLaneIntent) => void;
  onClearSelection: () => void;
};

/**
 * The right-click menu for a multi-selection in the Work sidebar. It only offers
 * actions that mean the same thing for every selected row, so it is a much
 * shorter list than the single-row menu: identity edits (rename, tag, handoff)
 * are per-chat and stay there. A row that applies to only part of the selection
 * says how many it will touch.
 */
export function SessionBulkContextMenu({
  menu,
  sessions,
  lanes,
  localSessionIds,
  resolvePin,
  onClose,
  pinnedSessionIds,
  onSetPinned,
  gridSessionIds,
  gridableSessionIds,
  onOpenInGrid,
  onRemoveFromGrid,
  onStopRuntimes,
  onDelete,
  onStopAndDelete,
  onCopySessionIds,
  onLanes,
  onClearSelection,
}: SessionBulkContextMenuProps) {
  // Resolved when the submenu opens, not from the static vocabulary, so "This
  // evening" is never offered at 11pm (see the single-row menu).
  const [snoozePresets, setSnoozePresets] = useState(() => resolveSnoozePresets());

  const entries = useMemo((): ContextMenuEntry[] => {
    const total = sessions.length;
    if (total < 2) return [];
    const hint = (count: number) => (count < total ? `${count} of ${total}` : undefined);

    const pinned = new Set(pinnedSessionIds);
    const inGrid = new Set(gridSessionIds);
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const targets = sessions.map((session) => ({ session, pin: resolvePin(session) }));

    const gridable = sessions.filter((session) => gridableSessionIds.has(session.id)).map((session) => session.id);
    const gridIds = gridable.slice(0, MAX_WORK_GRID_TILES);
    const inGridIds = sessions.filter((session) => inGrid.has(session.id)).map((session) => session.id);
    const unpinnedIds = sessions.filter((session) => !pinned.has(session.id)).map((session) => session.id);
    const snoozable = targets.filter(({ session }) => !isSessionSnoozed(session));
    const snoozed = targets.filter(({ session }) => isSessionSnoozed(session));
    const settledTargets = targets.filter(({ session }) => sessionCanonicalUiState(session).phase === "settled");
    // Same rule as the header's bulk settle: at-rest rows only, and never a row
    // waiting on the user — bulk settle does not dismiss pending input.
    const settleable = targets.filter(({ session }) =>
      sessionCanonicalUiState(session).phase !== "settled"
      && !sessionIsMidFlight(session)
      && !sessionNeedsYou(canonicalInputFromSummary(session)));
    const stoppableCount = sessions.filter(canBulkStopSession).length;

    const laneIds: string[] = [];
    const otherMachineLanes = new Set<string>();
    for (const { session, pin } of targets) {
      if (!localSessionIds.has(session.id) || !lanesById.has(session.laneId)) {
        otherMachineLanes.add(`${pin?.key ?? ""}:${session.laneId}`);
      } else if (!laneIds.includes(session.laneId)) {
        laneIds.push(session.laneId);
      }
    }
    const manageableLaneIds = laneIds.filter((id) => lanesById.get(id)?.laneType !== "primary");
    const manageHint = manageableLaneIds.length < laneIds.length
      ? `${manageableLaneIds.length} of ${laneIds.length}`
      : undefined;
    const singleLane = laneIds.length === 1 ? lanesById.get(laneIds[0]!) : undefined;

    const laneEntries: ContextMenuEntry[] = [];
    if (laneIds.length) {
      laneEntries.push({
        kind: "item",
        key: "lanes-open",
        label: "Open in Lanes",
        icon: ArrowSquareOut,
        onSelect: () => onLanes(laneIds, "open"),
      });
    }
    if (manageableLaneIds.length) {
      laneEntries.push(
        {
          kind: "item",
          key: "lanes-manage",
          label: "Manage…",
          icon: Gear,
          hint: manageHint,
          title: manageHint ? "The primary lane can't be managed here" : undefined,
          onSelect: () => onLanes(manageableLaneIds, "manage"),
        },
        {
          kind: "item",
          key: "lanes-archive",
          label: "Archive…",
          icon: Archive,
          hint: manageHint,
          onSelect: () => onLanes(manageableLaneIds, "archive"),
        },
        {
          kind: "item",
          key: "lanes-delete",
          label: "Delete…",
          icon: Trash,
          danger: true,
          hint: manageHint,
          onSelect: () => onLanes(manageableLaneIds, "delete"),
        },
      );
    }
    if (otherMachineLanes.size) {
      laneEntries.push(
        { kind: "separator", key: "lanes-foreign-sep" },
        {
          kind: "label",
          key: "lanes-foreign",
          label: otherMachineLanes.size === 1
            ? "1 lane not available in this tab"
            : `${otherMachineLanes.size} lanes not available in this tab`,
        },
      );
    }

    let lanesLabel = "Lanes";
    if (singleLane) lanesLabel = `Lane · ${singleLane.name}`;
    // Only name the batch when every selected lane is actionable; a mixed
    // selection keeps the neutral label and lets the rows' "x of y" hints say
    // which are left out (primary lanes never manage).
    else if (laneIds.length > 1 && manageableLaneIds.length === laneIds.length) {
      lanesLabel = `Manage ${laneIds.length} lanes`;
    }

    return [
      { kind: "label", key: "count", label: `${total} selected` },
      ...(gridIds.length >= 2
        ? [{
            kind: "item" as const,
            key: "grid",
            label: `Open ${gridIds.length} in grid`,
            icon: SquaresFour,
            hint: hint(gridIds.length),
            title: gridable.length > MAX_WORK_GRID_TILES
              ? `A grid holds up to ${MAX_WORK_GRID_TILES} sessions; the first ${MAX_WORK_GRID_TILES} open`
              : undefined,
            onSelect: () => onOpenInGrid(gridIds),
          }]
        : []),
      ...(inGridIds.length
        ? [{
            kind: "item" as const,
            key: "ungrid",
            label: "Remove from grid",
            icon: SquaresFour,
            hint: hint(inGridIds.length),
            onSelect: () => onRemoveFromGrid(inGridIds),
          }]
        : []),
      unpinnedIds.length
        ? {
            kind: "item",
            key: "pin",
            label: "Pin to front",
            icon: PushPin,
            hint: hint(unpinnedIds.length),
            onSelect: () => onSetPinned(unpinnedIds, true),
          }
        : {
            kind: "item",
            key: "unpin",
            label: "Unpin from front",
            icon: PushPinSlash,
            onSelect: () => onSetPinned(sessions.map((session) => session.id), false),
          },

      { kind: "separator", key: "lifecycle-sep" },
      { kind: "label", key: "lifecycle", label: "Lifecycle" },
      ...(stoppableCount
        ? [{
            kind: "item" as const,
            key: "stop",
            label: stoppableCount === 1 ? "Stop runtime…" : "Stop runtimes…",
            icon: Stop,
            hint: hint(stoppableCount),
            onSelect: onStopRuntimes,
          }]
        : []),
      ...(snoozable.length
        ? [{
            kind: "submenu" as const,
            key: "snooze",
            label: "Snooze…",
            icon: ClockCountdown,
            testId: "session-bulk-menu-snooze",
            onOpen: () => setSnoozePresets(resolveSnoozePresets()),
            entries: snoozePresets.map((preset): ContextMenuEntry => ({
              kind: "item",
              key: preset.key,
              label: preset.label,
              icon: ClockCountdown,
              hint: preset.whenLabel,
              onSelect: () => { void snoozeSessionsForDuration(snoozable, preset.key); },
            })),
          }]
        : []),
      ...(snoozed.length
        ? [{
            kind: "item" as const,
            key: "wake",
            label: "Wake now",
            icon: Alarm,
            hint: hint(snoozed.length),
            onSelect: () => { void wakeSessions(snoozed); },
          }]
        : []),
      ...(settleable.length
        ? [{
            kind: "item" as const,
            key: "settle",
            label: "Settle",
            icon: CheckCircle,
            hint: hint(settleable.length),
            onSelect: () => { void settleSessions(settleable); },
          }]
        : []),
      ...(settledTargets.length
        ? [{
            kind: "item" as const,
            key: "unsettle",
            label: "Unsettle",
            icon: ArrowCounterClockwise,
            hint: hint(settledTargets.length),
            onSelect: () => { void unsettleSessions(settledTargets); },
          }]
        : []),

      { kind: "separator", key: "lanes-sep" },
      ...(laneEntries.length
        ? [{
            kind: "submenu" as const,
            key: "lanes",
            label: lanesLabel,
            icon: GitBranch,
            testId: "session-bulk-menu-lanes",
            entries: laneEntries,
          }]
        : []),
      {
        kind: "item",
        key: "copy",
        label: "Copy session IDs",
        icon: Copy,
        onSelect: () => onCopySessionIds(sessions.map((session) => session.id)),
      },
      { kind: "item", key: "clear", label: "Clear selection", icon: X, onSelect: onClearSelection },

      { kind: "separator", key: "destructive-sep" },
      // Stop & delete covers a selection with running CLIs in it; plain delete
      // would refuse those rows.
      stoppableCount
        ? {
            kind: "item",
            key: "stop-delete",
            label: `Stop & delete ${total}…`,
            icon: Trash,
            danger: true,
            onSelect: onStopAndDelete,
          }
        : {
            kind: "item",
            key: "delete",
            label: `Delete ${total}…`,
            icon: Trash,
            danger: true,
            onSelect: onDelete,
          },
    ];
  }, [
    gridSessionIds,
    gridableSessionIds,
    lanes,
    localSessionIds,
    onClearSelection,
    onCopySessionIds,
    onDelete,
    onLanes,
    onOpenInGrid,
    onRemoveFromGrid,
    onSetPinned,
    onStopAndDelete,
    onStopRuntimes,
    pinnedSessionIds,
    resolvePin,
    sessions,
    snoozePresets,
  ]);

  return (
    <ContextMenu
      menu={entries.length ? menu : null}
      entries={entries}
      onClose={onClose}
      label={`${sessions.length} selected sessions`}
      testId="session-bulk-menu"
    />
  );
}
