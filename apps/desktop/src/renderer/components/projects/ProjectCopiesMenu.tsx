import React, { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  Desktop,
  Trash,
  UploadSimple,
  XCircle,
} from "@phosphor-icons/react";
import { useClampedFixedPosition, type FixedAnchor } from "../../hooks/useClampedFixedPosition";
import { ContextMenuSurface } from "../ui/ContextMenu";
import { MENU_ITEM_CLASS, MenuSectionLabel, MenuSeparator } from "../ui/MenuSubmenu";
import type { CopyComputers } from "../../../shared/repositoryTab";
import type { RemoteOpenProjectBinding } from "../../../shared/types";
import { splitUnconnectedMachines, unconnectedMachinesLabel, type CopyMachine } from "./projectCopies";
import { retryCopyJob, useCopyJobs, watchCopyJobs, type CopyJob } from "./projectCopyJobs";

/** One machine in a project's "Computers with a copy" list. */
export type CopiesMenuRow = {
  machine: CopyMachine;
  /** The copy this machine has, as the tab knows it; null when it has none. */
  copy: {
    rootPath: string;
    bindingKey: string;
    /** The copy's address when the tab has no saved binding for it yet (a shared copy). */
    binding?: RemoteOpenProjectBinding | null;
  } | null;
  /**
   * The copy the tab uses for calls that name no machine. Internal: the list
   * never shows it as a choice (the remove dialog starts from it).
   */
  inUse: boolean;
};

const ROW_CLASS = `${MENU_ITEM_CLASS} min-w-0`;

/**
 * "Computers with a copy": every computer that has a copy of the project, with
 * its state and folder, and the computers without one ("Add a copy"). It is a
 * list, not a switch: the project's tab shows the work of all of them at once,
 * and new work picks its computer in "Start on". A project with no git origin
 * cannot be joined across machines, so its list says it lives on one machine
 * only and offers Publish as the way to share it.
 *
 * The list reads nothing on its own: the rows come from state the tab bar
 * already holds, and the clone jobs from the window's job store.
 */
export function ProjectCopiesMenu({
  menu,
  projectName,
  repoKey,
  rows,
  onlyOneMachine,
  canAddCopies,
  onAddCopy,
  onPublish,
  onRemove,
  onClose,
  computers = null,
}: {
  menu: FixedAnchor | null;
  projectName: string;
  /** Null for a project with no git origin. */
  repoKey: string | null;
  rows: readonly CopiesMenuRow[];
  /** Set for a project with no git origin: the line that says where it lives. */
  onlyOneMachine: string | null;
  /** False in the hosted web client, which cannot clone onto a machine. */
  canAddCopies: boolean;
  onAddCopy: (machine: CopyMachine) => void;
  /** Offered with the "only on one machine" line when Publish can run. */
  onPublish: (() => void) | null;
  /** Opens the remove dialog; null where removing cannot run (the hosted web client). */
  onRemove: (() => void) | null;
  onClose: () => void;
  /** The shared count (`copyComputers`), the same number as Home and Settings › Location. */
  computers?: CopyComputers | null;
}) {
  const open = menu != null;
  const jobs = useCopyJobs(repoKey);
  const [unconnectedExpanded, setUnconnectedExpanded] = useState(false);
  const { ref, position } = useClampedFixedPosition(menu, `${rows.length}:${jobs.length}:${unconnectedExpanded}`);
  const focusedOnOpenRef = useRef(false);

  useEffect(() => (open && repoKey ? watchCopyJobs(repoKey) : undefined), [open, repoKey]);

  useEffect(() => {
    if (!open) {
      focusedOnOpenRef.current = false;
      setUnconnectedExpanded(false);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not([disabled])") ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : items[(index - 1 + items.length) % items.length];
      next?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, ref]);

  // Keyboard users land on the first choice once the menu is placed. Never on
  // "Remove project…": an Enter right after opening must not start a remove.
  // With no other choice nothing takes focus, and the arrows still reach it.
  useEffect(() => {
    if (!open || !position || focusedOnOpenRef.current) return;
    focusedOnOpenRef.current = true;
    ref.current?.querySelector<HTMLButtonElement>("button[role=menuitem]:not([disabled]):not([data-destructive])")?.focus();
  }, [open, position, ref]);

  if (!menu) return null;
  const jobByMachine = new Map(jobs.map((job) => [job.machine.machineId, job]));
  // A long list of machines not connected here collapses into one row. One
  // with a copy (or a clone job) stays in view: the person needs to see where
  // the copies are.
  const { visible, unconnected } = splitUnconnectedMachines(
    rows,
    (row) => row.machine,
    (row) => row.copy != null || jobByMachine.has(row.machine.machineId),
  );
  const renderRow = (row: CopiesMenuRow) => (
    <CopyRow
      key={row.machine.machineId}
      row={row}
      job={row.copy ? null : jobByMachine.get(row.machine.machineId) ?? null}
      canAddCopies={canAddCopies && repoKey != null}
      onAddCopy={() => onAddCopy(row.machine)}
    />
  );

  return (
    <ContextMenuSurface
      menuRef={ref}
      left={position?.left ?? menu.x}
      top={position?.top ?? menu.y}
      positioned={Boolean(position)}
      onClose={onClose}
      label={`Computers with a copy of ${projectName}`}
      role="menu"
      className="w-[340px] max-w-[calc(100vw-16px)]"
    >
      <MenuSectionLabel>
        Computers with a copy of {projectName}{computers && computers.count > 0 ? ` (${computers.count})` : ""}
      </MenuSectionLabel>
      {visible.map(renderRow)}
      {unconnected.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          aria-expanded={unconnectedExpanded}
          className={`${ROW_CLASS} text-muted-fg/70`}
          onClick={() => setUnconnectedExpanded((current) => !current)}
        >
          {unconnectedExpanded
            ? <CaretUp size={12} weight="bold" aria-hidden className="shrink-0 opacity-60" />
            : <CaretDown size={12} weight="bold" aria-hidden className="shrink-0 opacity-60" />}
          {unconnectedMachinesLabel(unconnected.length)}
        </button>
      ) : null}
      {unconnectedExpanded ? unconnected.map(renderRow) : null}
      {onlyOneMachine ? (
        <>
          <MenuSeparator />
          <div className="px-3 py-1.5 text-[11px] text-muted-fg/70">{onlyOneMachine}</div>
          {onPublish ? (
            <button
              type="button"
              role="menuitem"
              className={ROW_CLASS}
              onClick={() => {
                onClose();
                onPublish();
              }}
            >
              <UploadSimple size={13} weight="duotone" aria-hidden className="shrink-0 text-fg/45" />
              Publish to GitHub
            </button>
          ) : null}
        </>
      ) : null}
      {onRemove ? (
        <>
          <MenuSeparator />
          <button
            type="button"
            role="menuitem"
            data-destructive="true"
            className={ROW_CLASS}
            onClick={() => {
              onClose();
              onRemove();
            }}
          >
            <Trash size={13} weight="duotone" aria-hidden className="shrink-0 text-fg/45" />
            Remove project…
          </button>
        </>
      ) : null}
    </ContextMenuSurface>
  );
}

function CopyRow({
  row,
  job,
  canAddCopies,
  onAddCopy,
}: {
  row: CopiesMenuRow;
  job: CopyJob | null;
  canAddCopies: boolean;
  onAddCopy: () => void;
}) {
  const { machine, copy } = row;
  const name = (
    // The machine is what the person reads first: its name keeps up to 45%
    // of the row, and the path gives way first.
    <span className="inline-flex min-w-[104px] max-w-[45%] shrink-0 items-center gap-1.5" title={machine.name}>
      <Desktop size={12} weight="regular" aria-hidden className="shrink-0 opacity-70" />
      <span className="truncate">{machine.name}</span>
    </span>
  );
  const path = (text: string) => (
    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-fg/70" title={text}>
      {text}
    </span>
  );
  const quiet = (text: string) => <span className="min-w-0 flex-1 truncate text-muted-fg/70">{text}</span>;
  const trailing = (text: string) => (
    <span className="ml-auto shrink-0 rounded border border-border/40 px-1.5 py-px text-[10px] text-fg/80">{text}</span>
  );
  // A row that only says where a copy is and in what state: nothing to pick.
  // Not natively disabled, so the arrow keys and screen readers still reach
  // it; it does nothing when pressed.
  const disabledRow = (glyph: React.ReactNode, body: React.ReactNode, extra?: React.ReactNode, title?: string) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled="true"
      className={`${ROW_CLASS} cursor-default hover:bg-transparent`}
      title={title}
      onClick={(event) => event.stopPropagation()}
    >
      {glyph}
      {name}
      {body}
      {extra}
    </button>
  );

  if (job?.status === "cloning") {
    return disabledRow(<CircleNotch size={12} weight="bold" aria-hidden className="shrink-0 animate-spin" />, quiet("cloning…"));
  }
  if (job?.status === "ready") {
    return disabledRow(<CheckCircle size={12} weight="fill" aria-hidden className="shrink-0 text-emerald-400" />, quiet("ready"));
  }
  if (job?.status === "failed" && machine.online) {
    return (
      <button
        type="button"
        role="menuitem"
        className={ROW_CLASS}
        aria-label={`Retry adding a copy on ${machine.name}: ${job.failure?.reason ?? "it failed"}`}
        title={job.failure?.detail}
        onClick={() => retryCopyJob(job.key)}
      >
        <XCircle size={12} weight="fill" aria-hidden className="shrink-0 text-[color:var(--kit-crit)]" />
        {name}
        <span className="min-w-0 flex-1 truncate text-[color:var(--kit-crit)]">{job.failure?.reason ?? "Couldn't add the copy"}</span>
        {trailing("Retry")}
      </button>
    );
  }
  if (!machine.online) {
    // An offline machine's copy shows where it is. A computer known only from
    // the account list has no connection here, and the account may still show
    // it online: say "not connected", not "offline".
    const state = machine.targetId == null && !machine.isLocal ? "not connected" : "offline";
    return copy
      ? disabledRow(
        <CircleDashed size={12} aria-hidden className="shrink-0 opacity-60" />,
        path(copy.rootPath),
        <span className="ml-auto shrink-0 text-[10px] text-muted-fg/70">{state}</span>,
      )
      : disabledRow(<CircleDashed size={12} aria-hidden className="shrink-0 opacity-60" />, quiet(state));
  }
  if (copy) {
    // Its work is already in the tab, next to every other computer's.
    return disabledRow(
      <span className="kit-dot shrink-0" data-state="ok" aria-hidden />,
      path(copy.rootPath),
      <span className="ml-auto shrink-0 text-[10px] text-muted-fg/70">{machine.isLocal ? "this computer" : "connected"}</span>,
    );
  }
  if (!canAddCopies) {
    return disabledRow(<CircleDashed size={12} aria-hidden className="shrink-0 opacity-0" />, quiet("not here"));
  }
  return (
    <button
      type="button"
      role="menuitem"
      className={ROW_CLASS}
      aria-label={`Add a copy on ${machine.name}`}
      onClick={onAddCopy}
    >
      <CircleDashed size={12} weight="regular" aria-hidden className="shrink-0 opacity-0" />
      {name}
      {quiet("not here")}
      {trailing("Add a copy")}
    </button>
  );
}
