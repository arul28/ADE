import React, { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  Desktop,
  RadioButton,
  Trash,
  UploadSimple,
  XCircle,
} from "@phosphor-icons/react";
import { useClampedFixedPosition, type FixedAnchor } from "../../hooks/useClampedFixedPosition";
import { ContextMenuSurface } from "../ui/ContextMenu";
import { MENU_ITEM_CLASS, MenuSectionLabel, MenuSeparator } from "../ui/MenuSubmenu";
import { offlineMachinesLabel, splitOfflineMachines, type CopyMachine } from "./projectCopies";
import { retryCopyJob, useCopyJobs, watchCopyJobs, type CopyJob } from "./projectCopyJobs";

/** One machine in a tab's copies menu. */
export type CopiesMenuRow = {
  machine: CopyMachine;
  /** The copy this machine has, as the tab knows it; null when it has none. */
  copy: { rootPath: string; bindingKey: string } | null;
  /** The copy the tab is on now. */
  inUse: boolean;
};

const ROW_CLASS = `${MENU_ITEM_CLASS} min-w-0`;

/**
 * The copies of the project a tab holds, one row per machine: the copy in use,
 * the other copies (picking one moves the tab there), machines without a copy
 * ("Add a copy"), and machines that are not connected. A project with no git
 * origin cannot be joined across machines, so its menu says it lives on one
 * machine only and offers Publish as the way to share it.
 *
 * The menu reads nothing on its own: the rows come from state the tab bar
 * already holds, and the clone jobs from the window's job store.
 */
export function ProjectCopiesMenu({
  menu,
  projectName,
  repoKey,
  rows,
  onlyOneMachine,
  canAddCopies,
  onSwitch,
  onAddCopy,
  onPublish,
  onRemove,
  onClose,
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
  onSwitch: (row: CopiesMenuRow) => void;
  onAddCopy: (machine: CopyMachine) => void;
  /** Offered with the "only on one machine" line when Publish can run. */
  onPublish: (() => void) | null;
  /** Opens the remove dialog; null where removing cannot run (the hosted web client). */
  onRemove: (() => void) | null;
  onClose: () => void;
}) {
  const open = menu != null;
  const jobs = useCopyJobs(repoKey);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const { ref, position } = useClampedFixedPosition(menu, `${rows.length}:${jobs.length}:${offlineExpanded}`);
  const focusedOnOpenRef = useRef(false);

  useEffect(() => (open && repoKey ? watchCopyJobs(repoKey) : undefined), [open, repoKey]);

  useEffect(() => {
    if (!open) {
      focusedOnOpenRef.current = false;
      setOfflineExpanded(false);
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
  // A long list of offline machines collapses into one row. An offline
  // machine with a copy (or a clone job) stays in view: the person needs to
  // see where the copies are.
  const { visible, offline } = splitOfflineMachines(
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
      onSwitch={() => {
        onClose();
        onSwitch(row);
      }}
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
      label={`Copies of ${projectName}`}
      role="menu"
      className="w-[340px] max-w-[calc(100vw-16px)]"
    >
      <MenuSectionLabel>Copies of {projectName}</MenuSectionLabel>
      {visible.map(renderRow)}
      {offline.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          aria-expanded={offlineExpanded}
          className={`${ROW_CLASS} text-muted-fg/70`}
          onClick={() => setOfflineExpanded((current) => !current)}
        >
          {offlineExpanded
            ? <CaretUp size={12} weight="bold" aria-hidden className="shrink-0 opacity-60" />
            : <CaretDown size={12} weight="bold" aria-hidden className="shrink-0 opacity-60" />}
          {offlineMachinesLabel(offline.length)}
        </button>
      ) : null}
      {offlineExpanded ? offline.map(renderRow) : null}
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
  onSwitch,
  onAddCopy,
}: {
  row: CopiesMenuRow;
  job: CopyJob | null;
  canAddCopies: boolean;
  onSwitch: () => void;
  onAddCopy: () => void;
}) {
  const { machine, copy, inUse } = row;
  const name = (
    // The machine is what the person picks: its name keeps up to 45% of the
    // row, and the path gives way first.
    <span className="inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5" title={machine.name}>
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
  const disabledRow = (glyph: React.ReactNode, body: React.ReactNode, extra?: React.ReactNode, title?: string) => (
    <button type="button" role="menuitem" disabled aria-disabled className={`${ROW_CLASS} cursor-default`} title={title}>
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
  if (copy && inUse) {
    return (
      <button type="button" role="menuitem" disabled aria-disabled aria-current="true" className={`${ROW_CLASS} cursor-default`}>
        <RadioButton size={12} weight="fill" aria-hidden className="shrink-0 text-fg/80" />
        {name}
        {path(copy.rootPath)}
        <span className="ml-auto shrink-0 text-[10px] text-muted-fg/70">{machine.online ? "in use" : "in use · offline"}</span>
      </button>
    );
  }
  if (!machine.online) {
    // An offline machine's copy shows where it is; it cannot be opened now.
    return copy
      ? disabledRow(
        <CircleDashed size={12} aria-hidden className="shrink-0 opacity-60" />,
        path(copy.rootPath),
        <span className="ml-auto shrink-0 text-[10px] text-muted-fg/70">offline</span>,
      )
      : disabledRow(<CircleDashed size={12} aria-hidden className="shrink-0 opacity-60" />, quiet("offline"));
  }
  if (copy) {
    return (
      <button
        type="button"
        role="menuitem"
        className={ROW_CLASS}
        aria-label={`Switch to the copy on ${machine.name}, ${copy.rootPath}`}
        onClick={onSwitch}
      >
        <CircleDashed size={12} weight="regular" aria-hidden className="shrink-0 opacity-0" />
        {name}
        {path(copy.rootPath)}
      </button>
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
