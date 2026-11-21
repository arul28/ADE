import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowsClockwise, Desktop, type Icon } from "@phosphor-icons/react";
import { ADE_CLOUD_NAME } from "../../../shared/adeCloudMachine";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { MENU_ITEM_CLASS, MenuRowIcon, MenuSeparator, MenuSubmenuStatus } from "../ui/MenuSubmenu";
import { cn } from "../ui/cn";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { ADE_CLOUD_MOVE_UNAVAILABLE_SENTENCE } from "../chat/crossMachineMoveTargets";
import { wakeAdeCloudLane } from "../../state/adeCloudLaneWake";
import { LaneMoveDialog } from "./LaneMoveDialog";
import { useLaneMoveRunForLane } from "./laneMoveRuns";
import {
  useLaneMoveTargets,
  type LaneMoveSource,
  type LaneMoveTarget,
  type LaneMoveTargetsState,
} from "./useLaneMoveTargets";

/** A row the host adds under the machines (the cloud chip's "Change size…"). */
export type LaneMoveExtraRow = { key: string; label: string; icon: Icon; onSelect: () => void };

export type LaneMoveTrigger = {
  ref: RefObject<HTMLButtonElement>;
  open: boolean;
  onClick: () => void;
};

/**
 * "Move this lane to": the lane's machine label opens a menu of the person's
 * computers (this computer first, then the ones that can take it now), with
 * ADE Cloud as a muted row. A pick opens the dialog that says what moves; the
 * move starts only from there. The menu reads its machines when it opens and
 * never polls. A move already under way for the lane shows first and opens
 * its progress. A lane whose ADE Cloud computer is asleep lists the same
 * machines: its move comes from the saved copy, with no wake, and the dialog
 * offers "Wake and move" when that copy isn't complete.
 */
export function LaneMoveControl({
  source,
  extras = [],
  children,
}: {
  source: LaneMoveSource;
  extras?: LaneMoveExtraRow[];
  /** The trigger: the machine chip, drawn by the host. */
  children: (trigger: LaneMoveTrigger) => ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ target: LaneMoveTarget; state: LaneMoveTargetsState } | null>(null);
  const [progressOf, setProgressOf] = useState<string | null>(null);
  const targets = useLaneMoveTargets(source, open);
  const run = useLaneMoveRunForLane(source.laneId);
  const runOpen = run && (run.phase === "moving" || run.phase === "deleting" || run.phase === "deleteFailed" || run.phase === "failed") ? run : null;

  const close = () => setOpen(false);
  const pick = (target: LaneMoveTarget) => {
    close();
    setPicked({ target, state: targets });
  };
  // The asleep computer's saved copy can't be used: the person's own pick wakes it, and the menu opens again once it is on.
  const wake = () => wakeAdeCloudLane(source.pin, () => setOpen(true));

  return (
    <>
      {children({ ref: anchorRef, open, onClick: () => setOpen((value) => !value) })}
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={close}
        placement="top-start"
        role="menu"
        aria-label="Move this lane to"
        remeasureKey={targets.status === "ready" ? targets.targets.length : targets.status}
        data-testid="lane-move-menu"
      >
        <LaneMoveMenuBody
          targets={targets}
          runLabel={runOpen ? runLabel(runOpen.phase, runOpen.targetName) : null}
          extras={extras}
          onPick={pick}
          onOpenRun={() => {
            close();
            setProgressOf(runOpen?.id ?? null);
          }}
          onClose={close}
        />
      </AnchoredMenu>
      {picked ? (
        <LaneMoveDialog
          source={source}
          target={picked.target}
          changes={picked.state.status === "ready" ? picked.state.changes : null}
          onWake={wake}
          onClose={() => setPicked(null)}
        />
      ) : null}
      {progressOf && run && run.id === progressOf ? (
        <LaneMoveDialog
          source={source}
          target={{ key: run.id, name: run.targetName, thisComputer: false, ready: true, reason: null, hasRepository: true, pin: run.pin }}
          changes={null}
          initialRunId={run.id}
          onWake={wake}
          onClose={() => setProgressOf(null)}
        />
      ) : null}
    </>
  );
}

function runLabel(phase: string, targetName: string): string {
  switch (phase) {
    case "deleting": return `Moved to ${targetName}. Deleting the ${ADE_CLOUD_NAME} computer…`;
    case "deleteFailed": return `Moved to ${targetName}. The ${ADE_CLOUD_NAME} computer is still there.`;
    case "failed": return `The move to ${targetName} did not finish.`;
    default: return `Moving to ${targetName}…`;
  }
}

/** Arrow keys, Home and End move between the menu's enabled rows. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not([disabled])"));
  if (rows.length === 0) return;
  event.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? rows.length - 1
      : event.key === "ArrowDown" ? (at + 1) % rows.length
        : at <= 0 ? rows.length - 1 : at - 1;
  rows[next]?.focus();
}

function LaneMoveMenuBody({
  targets,
  runLabel: underWay,
  extras,
  onPick,
  onOpenRun,
  onClose,
}: {
  targets: LaneMoveTargetsState;
  runLabel: string | null;
  extras: LaneMoveExtraRow[];
  onPick: (target: LaneMoveTarget) => void;
  onOpenRun: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const ready = targets.status === "ready" ? targets : null;
  const hardBlocker = ready?.blockers.find((blocker) => !blocker.clearedByIncludeChanges && blocker.id !== "move_in_progress") ?? null;
  // The first enabled row takes focus when the rows arrive, so Enter picks
  // this computer (listed first) and the keys reach the list.
  const firstKey = ready?.targets.find((target) => target.ready)?.key ?? null;
  useLayoutEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not([disabled])")?.focus({ preventScroll: true });
  }, [firstKey, underWay]);

  return (
    <div
      ref={panelRef}
      className={cn(POPOVER_SURFACE_CLASS, "w-[264px] p-1 font-sans text-[12px] text-fg/85")}
      onKeyDown={moveFocus}
    >
      <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-fg/70">Move this lane to</div>
      {underWay ? (
        <>
          <button type="button" role="menuitem" className={MENU_ITEM_CLASS} onClick={onOpenRun} data-testid="lane-move-menu-run">
            <MenuRowIcon icon={ArrowsClockwise} />
            <span className="min-w-0 flex-1 truncate" title={underWay}>{underWay}</span>
          </button>
          <MenuSeparator />
        </>
      ) : null}
      {targets.status === "loading" ? (
        <MenuSubmenuStatus>Finding your computers…</MenuSubmenuStatus>
      ) : targets.status === "error" ? (
        <MenuSubmenuStatus>{targets.message}</MenuSubmenuStatus>
      ) : (
        <>
          {hardBlocker ? <MenuSubmenuStatus>{hardBlocker.title}. {hardBlocker.detail}</MenuSubmenuStatus> : null}
          {targets.targets.length === 0 ? (
            <MenuSubmenuStatus>No other computer on this account can take it.</MenuSubmenuStatus>
          ) : targets.targets.map((target) => (
            <TargetRow
              key={target.key}
              target={target}
              disabled={!target.ready || Boolean(hardBlocker)}
              onPick={() => onPick(target)}
            />
          ))}
        </>
      )}
      <div
        role="menuitem"
        aria-disabled="true"
        title={ADE_CLOUD_MOVE_UNAVAILABLE_SENTENCE}
        className={cn(MENU_ITEM_CLASS, "cursor-default opacity-45 hover:bg-transparent")}
        data-testid="lane-move-menu-ade-cloud"
      >
        <span aria-hidden className="inline-flex shrink-0"><CloudMark size={13} brand /></span>
        <span className="min-w-0 flex-1 truncate">{ADE_CLOUD_NAME}</span>
        <span className="shrink-0 text-[10.5px] text-muted-fg/70">Not yet</span>
      </div>
      {extras.length > 0 ? (
        <>
          <MenuSeparator />
          {extras.map((extra) => (
            <button
              key={extra.key}
              type="button"
              role="menuitem"
              className={MENU_ITEM_CLASS}
              onClick={() => {
                onClose();
                extra.onSelect();
              }}
            >
              <MenuRowIcon icon={extra.icon} />
              {extra.label}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

function TargetRow({ target, disabled, onPick }: { target: LaneMoveTarget; disabled: boolean; onPick: () => void }) {
  const note = !target.ready
    ? target.reason ? compactReason(target.reason) : "Not on"
    : target.hasRepository === false
      ? "Clones the project"
      : target.thisComputer && target.name !== THIS_MACHINE_NAME ? THIS_MACHINE_NAME : null;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={target.reason ?? undefined}
      aria-label={note ? `${target.name}, ${note}` : target.name}
      className={cn(MENU_ITEM_CLASS, "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent")}
      onClick={onPick}
      data-testid="lane-move-menu-machine"
    >
      <MenuRowIcon icon={Desktop} tone={target.thisComputer ? "amber" : undefined} />
      <span className="min-w-0 flex-1 truncate">{target.name}</span>
      {note ? <span className="max-w-[110px] shrink-0 truncate text-[10.5px] text-muted-fg/65">{note}</span> : null}
    </button>
  );
}

/** "Offline since yesterday 6:12 PM" reads as "Offline" in the row; the full reason is the tooltip. */
function compactReason(reason: string): string {
  const first = reason.split(/[.:(]/)[0]?.trim() ?? reason;
  return first.length > 22 ? "Not available" : first;
}
