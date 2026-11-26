import React from "react";
import { Archive as ArchiveIcon, ArrowCounterClockwise, Broom, Check, Trash, X } from "@phosphor-icons/react";
import type {
  ArchiveActionResult,
  ArchiveItemKind,
  ArchiveItemRef,
  ArchivedItem,
} from "../../../shared/types/archive";
import { DEFAULT_ARCHIVE_STALE_DAYS } from "../../../shared/types/archive";
import { archiveKindCountParts, archiveKindPlural, emptyArchiveCounts, isArchiveStale } from "../../../shared/archive";
import type { TerminalToolType } from "../../../shared/types/sessions";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { useStorageBytes } from "./storage/useStorageBytes";
import { confirmDialog } from "../ui/dialog";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { LaneChip } from "../terminals/LaneChip";
import { ToolLogo } from "../terminals/ToolLogos";
import { useLaneReclaim } from "./lanes/useLaneReclaim";
import { SettingsColumn } from "./primitives";
import "./primitives/settingsModern.css";
import "./machineSettings.css";
import { groupByMachine } from "../../state/repositoryScope";
import type { OpenProjectBinding } from "../../../shared/types";
import { useEveryCopyRead } from "../../state/everyCopyRead";
import { CopyReadErrors, CopyReadsPending, KindFilterSearchBar, LaneColorMark, machineHint } from "./EveryCopyList";
import { MetaLine } from "./MetaLine";
import { NoProjectCopyNotice } from "./ProjectCopyScope";

/**
 * Settings → Deleted & Archived → Archive: every lane, chat and shell you
 * archived, on every computer, in one place.
 *
 * Archive only hides a thing; it stays on disk until you free up its space or
 * delete it here, or a rule under Disk space → Rules does. The weekly reminder
 * banner points back to this page. Each row splits at the line its machine's
 * reminder uses (that machine's "Free up space after" setting, two weeks by
 * default), so "Older" is exactly what the banner was asking about, with one
 * button to clear it.
 *
 * A lane's Free up space is Archive & reclaim's own confirm and flow: the
 * folder goes, the branch and chats stay, and Restore recreates the folder
 * from the branch.
 */

export const ARCHIVE_SETTINGS_ANCHOR = "archive";
const ARCHIVE_TOAST_ID = "settings-archive";

type KindFilter = "all" | ArchiveItemKind;

const FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "lane", label: "Lanes" },
  { value: "chat", label: "Chats" },
  { value: "shell", label: "Shells & CLIs" },
];

function refKey(ref: ArchiveItemRef): string {
  return `${ref.kind}:${ref.id}`;
}

function toRef(item: ArchivedItem): ArchiveItemRef {
  return { kind: item.kind, id: item.id };
}

function describeRefs(refs: ArchiveItemRef[]): string {
  const counts = emptyArchiveCounts();
  for (const ref of refs) counts[ref.kind] += 1;
  return archiveKindCountParts(counts).join(", ");
}

function totalBytes(items: ArchivedItem[]): number {
  return items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
}

/** The square mark at the start of a row: the lane's own colour, or the agent's logo. */
function ItemMark({ item }: { item: ArchivedItem }) {
  if (item.kind === "lane") return <LaneColorMark color={item.laneColor} />;
  return (
    <span className="ade-ar-mark">
      <ToolLogo toolType={(item.toolType ?? "shell") as TerminalToolType} size={15} />
    </span>
  );
}

/**
 * The row's leading slot: the item's mark, which turns into a checkbox on hover
 * and stays one while anything is selected — so selecting costs no column.
 */
function MarkOrSelect({
  item,
  checked,
  selecting,
  onToggle,
}: {
  item: ArchivedItem;
  checked: boolean;
  selecting: boolean;
  onToggle: () => void;
}) {
  const showBox = selecting || checked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${item.title}`}
      onClick={onToggle}
      className="ade-ar-select"
      data-show-box={showBox || undefined}
    >
      <span className="ade-ar-select-mark"><ItemMark item={item} /></span>
      <span className="ade-ar-select-box-wrap">
        <span className="ade-ar-select-box" data-checked={checked || undefined}>
          <Check size={10} weight="bold" />
        </span>
      </span>
    </button>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="ade-ar-icon-btn"
      data-danger={danger || undefined}
    >
      {children}
    </button>
  );
}

function ArchiveRow({
  item,
  machineHint,
  selected,
  selecting,
  busy,
  onToggle,
  onRestore,
  onFreeUp,
  onDelete,
}: {
  item: ArchivedItem;
  /** "On <machine>" on hover, when the list holds more than one machine. */
  machineHint?: string;
  selected: boolean;
  selecting: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onFreeUp: () => void;
  onDelete: () => void;
}) {
  const { bytes: storageBytes } = useStorageBytes();
  const meta: string[] = [relativeWhen(item.archivedAt)];
  // An agent CLI says which CLI it was (Claude Code, Codex, …), unless its title already does.
  if (item.toolLabel && item.toolLabel !== item.title) meta.unshift(item.toolLabel);
  if (item.sizeBytes != null && item.sizeBytes > 0) meta.push(storageBytes(item.sizeBytes));
  const freed = item.kind === "lane" && item.worktreePresent === false;
  if (freed) meta.push("space freed, Restore recreates its folder");
  else if (item.kind === "lane" && item.freeUpError) meta.push(`couldn't free up space: ${item.freeUpError}`);
  else if (item.kind === "lane" && item.freeUpDue) meta.push("due to free up space");
  const where = item.kind === "lane"
    ? (item.branchRef ? <span className="ade-ar-branch">{item.branchRef}</span> : null)
    : (item.laneName ? <LaneChip laneName={item.laneName} laneColor={item.laneColor} maxWidth={160} /> : null);
  return (
    <div
      role="row"
      data-testid="archive-row"
      className="ade-ar-row"
      data-selected={selected || undefined}
      title={machineHint}
    >
      <MarkOrSelect item={item} checked={selected} selecting={selecting} onToggle={onToggle} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ade-ar-title">{item.title}</div>
        <MetaLine items={[where, ...meta.map((part) => <span className="kit-num">{part}</span>)]} />
      </div>
      {/* While selecting, the selection bar is the only place to act: the
          row's own actions leave the tab order too, not just the screen. */}
      {selecting ? null : (
        <div className="ade-ar-actions">
          <IconAction label="Restore" onClick={onRestore} disabled={busy}>
            <ArrowCounterClockwise size={14} />
          </IconAction>
          {item.kind === "lane" && !freed ? (
            <IconAction label="Free up space" onClick={onFreeUp} disabled={busy}>
              <Broom size={14} />
            </IconAction>
          ) : null}
          <IconAction label="Delete" onClick={onDelete} disabled={busy} danger>
            <Trash size={14} />
          </IconAction>
        </div>
      )}
    </div>
  );
}

function GroupHeader({ title, items, action }: { title: string; items: ArchivedItem[]; action?: React.ReactNode }) {
  const { bytes: storageBytes } = useStorageBytes();
  const bytes = totalBytes(items);
  return (
    <div className="ade-ar-group">
      <span className="kit-eyebrow">{title}</span>
      <span className="ade-ar-group-count kit-num">
        {items.length}
        {bytes > 0 ? ` · ${storageBytes(bytes)}` : ""}
      </span>
      <span style={{ flex: 1 }} />
      {action}
    </div>
  );
}


/**
 * A lane delete can take a couple of minutes (worktree removal, services
 * teardown) and one request has a 15-minute budget, so lanes go at most
 * `LANES_PER_DELETE` to a request. Chats and shells are quick and go together.
 */
const LANES_PER_DELETE = 5;

async function deleteInBatches(
  refs: ArchiveItemRef[],
  pin: OpenProjectBinding,
  force = false,
): Promise<ArchiveActionResult> {
  const lanes = refs.filter((ref) => ref.kind === "lane");
  const batches = [refs.filter((ref) => ref.kind !== "lane")];
  for (let i = 0; i < lanes.length; i += LANES_PER_DELETE) batches.push(lanes.slice(i, i + LANES_PER_DELETE));
  const total: ArchiveActionResult = { done: [], failed: [] };
  for (const items of batches) {
    if (items.length === 0) continue;
    const result = await window.ade.archive.delete({ items, ...(force ? { force: true } : {}) }, pin);
    total.done.push(...result.done);
    total.failed.push(...result.failed);
  }
  return total;
}

/** One archived thing, and the machine it is archived on. */
type Row = {
  key: string;
  pin: OpenProjectBinding;
  machineName: string;
  item: ArchivedItem;
};

type MachineArchive = { items: ArchivedItem[]; staleAfterDays: number | null };

const ARCHIVE_READ_TIMEOUT_MS = 15_000;

async function readArchive(pin: OpenProjectBinding, timed: <R>(call: Promise<R>) => Promise<R>): Promise<MachineArchive> {
  const result = await timed(window.ade.archive.list({}, pin));
  return { items: result.items, staleAfterDays: result.staleAfterDays ?? null };
}

function rowKey(pin: OpenProjectBinding, ref: ArchiveItemRef): string {
  return `${pin.key}\n${refKey(ref)}`;
}

/** An archive action's answer from several machines: each item keeps the machine (`pinKey`) it is on. */
type MachinesResult = {
  done: Array<ArchiveItemRef & { pinKey: string }>;
  failed: Array<ArchiveActionResult["failed"][number] & { pinKey: string }>;
};

/** The key of an item on its machine: two machines can hold the same id. */
function pinnedKey(item: ArchiveItemRef & { pinKey: string }): string {
  return `${item.pinKey}\n${refKey(item)}`;
}

/** Runs one archive action on each machine its rows are on, and adds the answers up. */
async function onEachMachine(
  rows: readonly Row[],
  run: (pin: OpenProjectBinding, refs: ArchiveItemRef[]) => Promise<ArchiveActionResult>,
): Promise<MachinesResult> {
  const total: MachinesResult = { done: [], failed: [] };
  const { groups } = groupByMachine(rows, (row) => row.pin);
  const answers = await Promise.all(groups.map(async (group) => {
    const refs = group.items.map((row) => toRef(row.item));
    let answer: ArchiveActionResult;
    try {
      answer = await run(group.pin, refs);
    } catch (error) {
      const message = ipcErrorMessage(error) || "Something went wrong.";
      answer = { done: [], failed: refs.map((ref) => ({ ...ref, error: message })) };
    }
    const pinKey = group.pin.key;
    return {
      done: answer.done.map((item) => ({ ...item, pinKey })),
      failed: answer.failed.map((item) => ({ ...item, pinKey })),
    };
  }));
  for (const answer of answers) {
    total.done.push(...answer.done);
    total.failed.push(...answer.failed);
  }
  return total;
}

/**
 * Settings → Deleted & Archived → Archive, from every computer with a copy of
 * the project at once. Each row keeps the machine it is on; Restore, Free up
 * space and Delete go there, and a selection that spans machines is split.
 */
export function ArchiveSection() {
  const { machines, noCopy, reload } = useEveryCopyRead(readArchive, ARCHIVE_READ_TIMEOUT_MS);
  const [filter, setFilter] = React.useState<KindFilter>("all");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);

  const rows = React.useMemo(() => {
    const out: Row[] = [];
    for (const machine of machines) {
      for (const item of machine.value?.items ?? []) {
        out.push({ key: rowKey(machine.pin, toRef(item)), pin: machine.pin, machineName: machine.machineName, item });
      }
    }
    return out.sort((a, b) => Date.parse(b.item.archivedAt) - Date.parse(a.item.archivedAt));
  }, [machines]);
  const loaded = machines.some((machine) => machine.done);
  const allDone = machines.every((machine) => machine.done);
  // The line between recent and old is each machine's own "Free up space
  // after" setting, the one its reminder uses.
  const staleDaysByPin = React.useMemo(() => new Map(machines.map((machine) => [
    machine.pin.key,
    machine.value?.staleAfterDays ?? DEFAULT_ARCHIVE_STALE_DAYS,
  ])), [machines]);

  // A selection keeps only rows still listed.
  React.useEffect(() => {
    const live = new Set(rows.map((row) => row.key));
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => live.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const reloadRows = React.useCallback((touched: readonly Row[]) => {
    for (const key of new Set(touched.map((row) => row.pin.key))) reload(key);
  }, [reload]);

  // Free up space on the row's machine, where the lane's folder is.
  const reclaim = useLaneReclaim(null, (pin) => {
    if (pin) reload(pin.key);
  }, { alreadyArchived: true });

  const counts = React.useMemo(() => {
    const byKind = emptyArchiveCounts();
    for (const row of rows) byKind[row.item.kind] += 1;
    return byKind;
  }, [rows]);

  const visible = React.useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((row) => {
      if (filter !== "all" && row.item.kind !== filter) return false;
      if (words.length === 0) return true;
      const text = [row.item.title, row.item.laneName, row.item.toolLabel].filter(Boolean).join(" ").toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [filter, query, rows]);

  const { recent, older, staleDays } = React.useMemo(() => {
    const nowMs = Date.now();
    const groups = { recent: [] as Row[], older: [] as Row[] };
    const lines = new Set<number>();
    for (const row of visible) {
      const days = staleDaysByPin.get(row.pin.key) ?? DEFAULT_ARCHIVE_STALE_DAYS;
      lines.add(days);
      (isArchiveStale(row.item.archivedAt, days, nowMs) ? groups.older : groups.recent).push(row);
    }
    // One line for every row shown names its days; machines that differ do not.
    return { ...groups, staleDays: lines.size === 1 ? [...lines][0]! : null };
  }, [staleDaysByPin, visible]);

  const report = React.useCallback((verb: "Restored" | "Deleted", result: MachinesResult) => {
    const [firstFailure] = result.failed;
    if (result.done.length > 0) {
      showToast({
        id: ARCHIVE_TOAST_ID,
        title: `${verb} ${describeRefs(result.done)}`,
        ...(firstFailure
          ? {
              message: `${result.failed.length} couldn't be ${verb.toLowerCase()} — ${firstFailure.error}`,
              tone: "warning" as const,
              // A partial result is worth reading (docs/design/notices.md).
              durationMs: READABLE_TOAST_DURATION_MS,
            }
          : { tone: "success" as const }),
      });
    } else if (firstFailure) {
      showToast({ id: ARCHIVE_TOAST_ID, title: firstFailure.error, tone: "error" });
    }
  }, []);

  const restore = React.useCallback(async (targets: Row[]) => {
    if (targets.length === 0) return;
    setBusy(true);
    try {
      report("Restored", await onEachMachine(targets, (pin, refs) => window.ade.archive.restore({ items: refs }, pin)));
    } finally {
      setBusy(false);
      reloadRows(targets);
    }
  }, [reloadRows, report]);

  const remove = React.useCallback(async (targets: Row[]) => {
    if (targets.length === 0) return;
    const refs = targets.map((row) => toRef(row.item));
    const hasLane = refs.some((ref) => ref.kind === "lane");
    const ok = await confirmDialog({
      title: `Delete ${describeRefs(refs)}?`,
      message: hasLane
        ? "Gone for good — transcripts and lane folders too. Branches stay."
        : "Gone for good — transcripts too.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      let result = await onEachMachine(targets, (pin, items) => deleteInBatches(items, pin));
      // A lane with unsaved work (uncommitted files, or submodule commits no
      // remote has) is refused unless forced. Ask once, by name, instead of
      // silently discarding someone's unfinished work. Match the refusal's
      // own advice, not "could not verify whether…", which `force` would not
      // get past either.
      const dirtyLanes = result.failed.filter(
        (item) => item.kind === "lane" && /enable force delete/i.test(item.error),
      );
      const dirtyKeys = new Set(dirtyLanes.map(pinnedKey));
      const dirtyRows = targets.filter((row) => dirtyKeys.has(pinnedKey({ ...toRef(row.item), pinKey: row.pin.key })));
      if (dirtyRows.length > 0) {
        const names = dirtyRows.map((row) => row.item.title).join(", ");
        const force = await confirmDialog({
          title: `${names} has unsaved work`,
          // A submodule commit lives in the lane's folder, not on the branch.
          message: dirtyLanes.every((item) => /^Lane has uncommitted changes\./i.test(item.error))
            ? "Deleting loses it. Commits on the lane's branch stay."
            : "Deleting also removes files and commits that exist only in this lane's folders.",
          confirmLabel: "Delete anyway",
          destructive: true,
        });
        if (force) {
          const retry = await onEachMachine(dirtyRows, (pin, items) => deleteInBatches(items, pin, true));
          result = {
            done: [...result.done, ...retry.done],
            failed: [...result.failed.filter((item) => !dirtyKeys.has(pinnedKey(item))), ...retry.failed],
          };
        }
      }
      report("Deleted", result);
    } finally {
      setBusy(false);
      reloadRows(targets);
    }
  }, [reloadRows, report]);

  const selectedRows = React.useMemo(
    () => visible.filter((row) => selected.has(row.key)),
    [selected, visible],
  );
  const selecting = selectedRows.length > 0;

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const renderRows = (list: Row[]) =>
    list.map((row) => (
      <ArchiveRow
        key={row.key}
        item={row.item}
        machineHint={machineHint(machines.length, row.machineName)}
        selected={selected.has(row.key)}
        selecting={selecting}
        busy={busy}
        onToggle={() => toggle(row.key)}
        onRestore={() => void restore([row])}
        onFreeUp={() => void reclaim.open(row.item.id, row.pin)}
        onDelete={() => void remove([row])}
      />
    ));

  const filterBar = (
    <KindFilterSearchBar
      options={FILTERS.map((option) => ({
        ...option,
        count: option.value === "all" ? rows.length : counts[option.value],
      }))}
      value={filter}
      onChange={setFilter}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search the archive"
      searchLabel="Search archived lanes, chats and shells"
    />
  );

  const selectionBar = (
    <div data-testid="archive-selection-bar" className="ade-ar-selection">
      <button
        type="button"
        aria-label="Clear selection"
        onClick={() => setSelected(new Set())}
        className="ade-ar-icon-btn"
      >
        <X size={13} />
      </button>
      <span className="ade-ar-title kit-num" style={{ fontSize: 12.5 }}>{selectedRows.length} selected</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        disabled={busy}
        onClick={() => void restore(selectedRows)}
        className="ade-modern-btn"
        data-size="sm"
      >
        <ArrowCounterClockwise size={12} /> Restore
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void remove(selectedRows)}
        className="ade-modern-btn"
        data-size="sm"
        data-tone="danger"
      >
        <Trash size={12} /> Delete
      </button>
    </div>
  );

  return (
    <SettingsColumn wide>
      <section id={ARCHIVE_SETTINGS_ANCHOR} data-settings-anchor={ARCHIVE_SETTINGS_ANCHOR} className="ade-modern-page" aria-label="Archive">
        <div className="ade-ap-section">
          {/* A selection takes the toolbar's place, so the list never jumps. */}
          {selecting ? (
            <div className="ade-ar-toolbar">{selectionBar}</div>
          ) : rows.length > 0 ? filterBar : null}

          <CopyReadErrors
            machines={machines}
            reload={reload}
            idPrefix="archive-load-error"
            surface="archive_load"
            title={(name) => `Couldn't open ${name}'s archive`}
          />

          {noCopy ? (
            <NoProjectCopyNotice />
          ) : !loaded ? (
            <p className="ade-modern-muted">Loading the archive…</p>
          ) : visible.length === 0 && query.trim() ? (
            <p className="ade-modern-muted">Nothing archived matches “{query.trim()}”.</p>
          ) : visible.length === 0 && allDone ? (
            <div className="ade-ar-empty">
              <ArchiveIcon size={22} weight="light" />
              <div className="ade-ap-rowtitle">{filter === "all" ? "Nothing archived" : `No archived ${archiveKindPlural(filter)}`}</div>
              <p className="ade-modern-muted">Archive hides a lane, chat or shell without deleting it. Archived ones show up here.</p>
            </div>
          ) : (
            <div role="table" aria-label="Archived items" className="ade-ar-table">
              {recent.length > 0 ? (
                <div className="ade-ar-block">
                  <GroupHeader title={staleDays != null ? `Last ${staleDays} days` : "Recent"} items={recent.map((row) => row.item)} />
                  <div className="ade-modern-rows ade-ar-list">{renderRows(recent)}</div>
                </div>
              ) : null}
              {older.length > 0 ? (
                <div className="ade-ar-block">
                  <GroupHeader
                    title={staleDays != null ? `Older than ${staleDays} days` : "Older"}
                    items={older.map((row) => row.item)}
                    action={
                      <button
                        type="button"
                        disabled={busy || selecting}
                        onClick={() => void remove(older)}
                        className="ade-modern-btn"
                        data-size="sm"
                        data-tone="danger"
                      >
                        {/* A search or filter narrows "all" to the rows shown. */}
                        <Trash size={12} /> {filter === "all" && !query.trim() ? "Delete all" : `Delete ${older.length}`}
                      </button>
                    }
                  />
                  <div className="ade-modern-rows ade-ar-list">{renderRows(older)}</div>
                </div>
              ) : null}
            </div>
          )}
          <CopyReadsPending machines={machines} />
        </div>
      </section>
      {reclaim.dialog}
    </SettingsColumn>
  );
}
