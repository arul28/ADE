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
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { canBulkDeleteSession, canBulkStopSession, isChatToolType } from "../../lib/sessions";
import { sessionCanonicalUiState, sessionIsMidFlight } from "../../lib/terminalAttention";
import { isSessionSnoozed, resolveSnoozePresets, type SnoozeDurationKey } from "../../lib/sessionSnooze";
import { MAX_WORK_GRID_TILES } from "../../lib/workGrid";
import {
  DESTRUCTIVE_ITEM_CLASS,
  MENU_ITEM_CLASS,
  MenuRowIcon,
  MenuSectionLabel,
  MenuSeparator,
  MenuSubmenu,
} from "../ui/MenuSubmenu";
import {
  settleSession,
  snoozeSessionsForDuration,
  unsettleSession,
  wakeSessionNow,
} from "./sessionLifecycleActions";

export type SessionBulkContextMenuState = { x: number; y: number } | null;

/** What the Lanes tab should do with the lanes behind a multi-selection. */
export type BulkLaneIntent = "open" | "manage" | "archive" | "delete";

type SessionBulkContextMenuProps = {
  menu: SessionBulkContextMenuState;
  /** The live selection, in the order the sidebar shows it. */
  sessions: TerminalSessionSummary[];
  /** The tab's own lanes. Lanes on other machines are not in here. */
  lanes: LaneSummary[];
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
  deleting: boolean;
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The right-click menu for a multi-selection in the Work sidebar. It only offers
 * actions that mean the same thing for every selected row, so it is a much
 * shorter list than the single-row menu: identity edits (rename, tag, handoff)
 * are per-chat and stay there. Each row states how many of the selection it
 * will touch, because a mixed selection rarely qualifies as a whole.
 */
export function SessionBulkContextMenu(props: SessionBulkContextMenuProps) {
  if (!props.menu || props.sessions.length < 2) return null;
  return <SessionBulkContextMenuPanel {...props} menu={props.menu} />;
}

function SessionBulkContextMenuPanel({
  menu,
  sessions,
  lanes,
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
  deleting,
}: SessionBulkContextMenuProps & { menu: NonNullable<SessionBulkContextMenuState> }) {
  const { ref: menuRef, position } = useClampedFixedPosition({ x: menu.x, y: menu.y }, false);
  const [snoozePresets, setSnoozePresets] = useState(() => resolveSnoozePresets());

  const model = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    const inGrid = new Set(gridSessionIds);
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const withPins = sessions.map((session) => ({ session, pin: resolvePin(session) }));
    const gridable = sessions.filter((session) => gridableSessionIds.has(session.id)).map((session) => session.id);

    const laneIds: string[] = [];
    let foreignLaneCount = 0;
    const seenForeign = new Set<string>();
    for (const { session, pin } of withPins) {
      if (pin || !lanesById.has(session.laneId)) {
        const key = `${pin?.key ?? "?"}:${session.laneId}`;
        if (!seenForeign.has(key)) { seenForeign.add(key); foreignLaneCount += 1; }
        continue;
      }
      if (!laneIds.includes(session.laneId)) laneIds.push(session.laneId);
    }
    const manageableLaneIds = laneIds.filter((id) => lanesById.get(id)?.laneType !== "primary");

    return {
      withPins,
      allPinned: sessions.every((session) => pinned.has(session.id)),
      unpinnedIds: sessions.filter((session) => !pinned.has(session.id)).map((session) => session.id),
      gridCandidates: gridable.slice(0, MAX_WORK_GRID_TILES),
      gridableCount: gridable.length,
      inGridIds: sessions.filter((session) => inGrid.has(session.id)).map((session) => session.id),
      snoozable: withPins.filter(({ session }) => !isSessionSnoozed(session)),
      snoozed: withPins.filter(({ session }) => isSessionSnoozed(session)),
      settleable: withPins.filter(({ session }) => {
        const phase = sessionCanonicalUiState(session).phase;
        if (phase === "settled" || sessionIsMidFlight(session)) return false;
        // A CLI blocked on a terminal prompt has to be answered first; the
        // single-row menu disables settle for the same rows.
        return phase !== "needs_you" || isChatToolType(session.toolType) || Boolean(session.attentionRequestedAt);
      }),
      settled: withPins.filter(({ session }) => sessionCanonicalUiState(session).phase === "settled"),
      stoppableCount: sessions.filter(canBulkStopSession).length,
      deletableCount: sessions.filter(canBulkDeleteSession).length,
      laneIds,
      manageableLaneIds,
      foreignLaneCount,
      singleLane: laneIds.length === 1 ? lanesById.get(laneIds[0]!) ?? null : null,
    };
  }, [gridSessionIds, gridableSessionIds, lanes, pinnedSessionIds, resolvePin, sessions]);

  const total = sessions.length;
  const run = (action: () => void) => () => { action(); onClose(); };
  const chooseSnooze = (key: SnoozeDurationKey) => {
    void snoozeSessionsForDuration(model.snoozable, key);
    onClose();
  };
  const countHint = (count: number) => (count < total
    ? <span className="ml-auto shrink-0 pl-4 text-[10px] text-muted-fg/50">{count} of {total}</span>
    : null);

  const laneCount = model.laneIds.length;
  const manageCount = model.manageableLaneIds.length;
  const laneNoun = model.singleLane ? `“${model.singleLane.name}”` : plural(laneCount, "lane");

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        role="menu"
        aria-label={`${total} selected sessions`}
        data-testid="session-bulk-menu"
        className="ade-liquid-glass-menu fixed z-50 min-w-[200px] py-1"
        style={{ ...(position ?? { left: menu.x, top: menu.y }), visibility: position ? "visible" : "hidden" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <MenuSectionLabel>{total} selected</MenuSectionLabel>

        {/* ── View: arrange the selection on screen. ── */}
        {model.gridCandidates.length >= 2 ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            title={model.gridableCount > MAX_WORK_GRID_TILES
              ? `A grid holds up to ${MAX_WORK_GRID_TILES} sessions; the first ${MAX_WORK_GRID_TILES} open`
              : undefined}
            onClick={run(() => onOpenInGrid(model.gridCandidates))}
          >
            <MenuRowIcon icon={SquaresFour} />
            Open {model.gridCandidates.length} in grid
            {model.gridCandidates.length < total ? countHint(model.gridCandidates.length) : null}
          </button>
        ) : null}
        {model.inGridIds.length ? (
          <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onRemoveFromGrid(model.inGridIds))}>
            <MenuRowIcon icon={SquaresFour} />
            Remove from grid
            {countHint(model.inGridIds.length)}
          </button>
        ) : null}
        <button
          type="button"
          className={MENU_ITEM_CLASS}
          onClick={run(() => (model.allPinned
            ? onSetPinned(sessions.map((session) => session.id), false)
            : onSetPinned(model.unpinnedIds, true)))}
        >
          <MenuRowIcon icon={model.allPinned ? PushPinSlash : PushPin} />
          {model.allPinned ? "Unpin all from front" : "Pin all to front"}
          {model.allPinned ? null : countHint(model.unpinnedIds.length)}
        </button>

        {/* ── Lifecycle ── */}
        <MenuSeparator />
        <MenuSectionLabel>Lifecycle</MenuSectionLabel>
        {model.snoozable.length ? (
          <MenuSubmenu
            label="Snooze…"
            icon={<MenuRowIcon icon={ClockCountdown} />}
            className={MENU_ITEM_CLASS}
            data-testid="session-bulk-menu-snooze"
            onOpen={() => setSnoozePresets(resolveSnoozePresets())}
          >
            {snoozePresets.map((preset) => (
              <button key={preset.key} type="button" className={MENU_ITEM_CLASS} onClick={() => chooseSnooze(preset.key)}>
                <MenuRowIcon icon={ClockCountdown} />
                {preset.label}
                <span className="ml-auto shrink-0 pl-4 text-[10px] text-muted-fg/50">{preset.whenLabel}</span>
              </button>
            ))}
          </MenuSubmenu>
        ) : null}
        {model.snoozed.length ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={run(() => { for (const { session, pin } of model.snoozed) void wakeSessionNow(session, pin); })}
          >
            <MenuRowIcon icon={Alarm} />
            Wake now
            {countHint(model.snoozed.length)}
          </button>
        ) : null}
        {model.settleable.length ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={run(() => { for (const { session, pin } of model.settleable) void settleSession(session, pin); })}
          >
            <MenuRowIcon icon={CheckCircle} />
            Settle
            {countHint(model.settleable.length)}
          </button>
        ) : null}
        {model.settled.length ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={run(() => { for (const { session, pin } of model.settled) void unsettleSession(session, pin); })}
          >
            <MenuRowIcon icon={ArrowCounterClockwise} />
            Unsettle
            {countHint(model.settled.length)}
          </button>
        ) : null}
        {model.stoppableCount ? (
          <button type="button" className={MENU_ITEM_CLASS} onClick={run(onStopRuntimes)}>
            <MenuRowIcon icon={Stop} />
            Stop {model.stoppableCount === 1 ? "runtime" : "runtimes"}…
            {countHint(model.stoppableCount)}
          </button>
        ) : null}

        {/* ── Lanes: the same multi-lane actions the Lanes tab offers for a
            Cmd-click selection, aimed at the lanes these sessions live in. ── */}
        {laneCount || model.foreignLaneCount ? (
          <>
            <MenuSeparator />
            <MenuSubmenu
              label={laneCount === 1 ? "Lane" : `Lanes (${laneCount})`}
              icon={<MenuRowIcon icon={GitBranch} />}
              className={MENU_ITEM_CLASS}
              data-testid="session-bulk-menu-lanes"
            >
              {laneCount ? (
                <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onLanes(model.laneIds, "open"))}>
                  <MenuRowIcon icon={ArrowSquareOut} />
                  Open {laneNoun} in Lanes
                </button>
              ) : null}
              {manageCount ? (
                <>
                  <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onLanes(model.manageableLaneIds, "manage"))}>
                    <MenuRowIcon icon={Gear} />
                    {manageCount === 1 ? "Manage lane…" : `Manage ${manageCount} lanes…`}
                  </button>
                  <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onLanes(model.manageableLaneIds, "archive"))}>
                    <MenuRowIcon icon={Archive} />
                    {manageCount === 1 ? "Archive lane…" : `Archive ${manageCount} lanes…`}
                  </button>
                  <button type="button" className={DESTRUCTIVE_ITEM_CLASS} onClick={run(() => onLanes(model.manageableLaneIds, "delete"))}>
                    <MenuRowIcon icon={Trash} danger />
                    {manageCount === 1 ? "Delete lane…" : `Delete ${manageCount} lanes…`}
                  </button>
                </>
              ) : null}
              {laneCount > manageCount ? (
                <div className="px-3 py-1 text-[10px] text-muted-fg/50">The primary lane can't be archived or deleted</div>
              ) : null}
              {model.foreignLaneCount ? (
                <div className="px-3 py-1 text-[10px] text-muted-fg/50">
                  {plural(model.foreignLaneCount, "lane")} on other machines not included
                </div>
              ) : null}
            </MenuSubmenu>
          </>
        ) : null}

        <MenuSeparator />
        <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onCopySessionIds(sessions.map((session) => session.id)))}>
          <MenuRowIcon icon={Copy} />
          Copy session IDs
        </button>
        <button type="button" className={MENU_ITEM_CLASS} onClick={run(onClearSelection)}>
          <MenuRowIcon icon={X} />
          Clear selection
        </button>

        {/* ── Destructive, last and fenced off. ── */}
        <MenuSeparator />
        {model.stoppableCount ? (
          <button type="button" className={DESTRUCTIVE_ITEM_CLASS} disabled={deleting} onClick={run(onStopAndDelete)}>
            <MenuRowIcon icon={Trash} danger />
            {deleting ? "Deleting…" : `Stop & delete ${total}…`}
          </button>
        ) : (
          <button type="button" className={DESTRUCTIVE_ITEM_CLASS} disabled={deleting || !model.deletableCount} onClick={run(onDelete)}>
            <MenuRowIcon icon={Trash} danger />
            {deleting ? "Deleting…" : `Delete ${total}…`}
          </button>
        )}
      </div>
    </>
  );
}
