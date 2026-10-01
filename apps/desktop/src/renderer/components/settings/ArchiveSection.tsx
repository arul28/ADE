import React from "react";
import { ArrowCounterClockwise, Check, Trash, X } from "@phosphor-icons/react";
import type {
  ArchiveActionResult,
  ArchiveItemKind,
  ArchiveItemRef,
  ArchivedItem,
} from "../../../shared/types/archive";
import { DEFAULT_ARCHIVE_STALE_DAYS } from "../../../shared/types/archive";
import { archiveKindCountParts, archiveKindPlural, emptyArchiveCounts, isArchiveStale } from "../../../shared/archive";
import type { TerminalToolType } from "../../../shared/types/sessions";
import { formatBytes, relativeWhen } from "../../lib/format";
import { cn } from "../ui/cn";
import { confirmDialog } from "../ui/dialog";
import { showToast } from "../app/toast/toastStore";
import { LaneChip, LaneLogoMark, laneDisplayColor } from "../terminals/LaneChip";
import { ToolLogo } from "../terminals/ToolLogos";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { SettingsManagerEmpty } from "./primitives";

/**
 * Settings → Archive: every lane, chat and shell you archived, in one place.
 *
 * Archive only hides a thing; it stays on disk until you delete it here. ADE
 * never deletes on its own — the weekly reminder banner points back to this
 * page. The list splits at the same two-week line the reminder uses, so
 * "Older" is exactly what the banner was asking about, with one button to
 * clear it.
 */

export const ARCHIVE_SETTINGS_ANCHOR = "archive";
const ARCHIVE_TOAST_ID = "settings-archive";

type KindFilter = "all" | ArchiveItemKind;

const FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "lane", label: "Lanes" },
  { value: "chat", label: "Chats" },
  { value: "shell", label: "Shells" },
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
  if (item.kind === "lane") {
    const color = laneDisplayColor(item.laneColor);
    return (
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-lg"
        style={{
          background: `color-mix(in srgb, ${color} 16%, transparent)`,
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 28%, transparent)`,
        }}
      >
        <LaneLogoMark color={color} size={15} />
      </span>
    );
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
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
      className="relative size-8 shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/60"
    >
      <span className={cn("absolute inset-0 transition-opacity", showBox ? "opacity-0" : "group-hover:opacity-0")}>
        <ItemMark item={item} />
      </span>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity",
          showBox ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-[5px] border",
            checked
              ? "border-violet-400 bg-violet-400 text-[#0F0D14]"
              : "border-white/25 text-transparent hover:border-white/50",
          )}
        >
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
        className={cn(
          "flex size-7 items-center justify-center rounded-md text-muted-fg/70 transition-colors disabled:pointer-events-none disabled:opacity-40",
          danger ? "hover:bg-red-500/10 hover:text-red-300" : "hover:bg-white/[0.06] hover:text-fg",
        )}
      >
        {children}
      </button>
  );
}

function ArchiveRow({
  item,
  selected,
  selecting,
  busy,
  onToggle,
  onRestore,
  onDelete,
}: {
  item: ArchivedItem;
  selected: boolean;
  selecting: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const meta: string[] = [relativeWhen(item.archivedAt)];
  if (item.sizeBytes != null && item.sizeBytes > 0) meta.push(formatBytes(item.sizeBytes));
  if (item.kind === "lane" && item.worktreePresent === false) meta.push("folder already removed");
  const where = item.kind === "lane"
    ? (item.branchRef ? <span className="truncate font-mono text-[10.5px]">{item.branchRef}</span> : null)
    : (item.laneName ? <LaneChip laneName={item.laneName} laneColor={item.laneColor} maxWidth={160} /> : null);
  return (
    <div
      role="row"
      data-testid="archive-row"
      className={cn(
        "group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors",
        selected ? "bg-violet-400/[0.07]" : "hover:bg-white/[0.03]",
      )}
    >
      <MarkOrSelect item={item} checked={selected} selecting={selecting} onToggle={onToggle} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-fg">{item.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-fg/60">
          {where}
          {where ? <span className="text-muted-fg/30">·</span> : null}
          <span className="shrink-0 tabular-nums">{meta.join(" · ")}</span>
        </div>
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 transition-opacity",
          selecting
            ? "pointer-events-none opacity-0"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <IconAction label="Restore" onClick={onRestore} disabled={busy}>
          <ArrowCounterClockwise size={14} />
        </IconAction>
        <IconAction label="Delete" onClick={onDelete} disabled={busy} danger>
          <Trash size={14} />
        </IconAction>
      </div>
    </div>
  );
}

function GroupHeader({ title, items, action }: { title: string; items: ArchivedItem[]; action?: React.ReactNode }) {
  const bytes = totalBytes(items);
  return (
    <div className="flex h-9 items-end gap-2 px-2.5 pb-1.5">
      <span className="text-[11px] font-medium text-muted-fg/70">{title}</span>
      <span className="text-[11px] tabular-nums text-muted-fg/40">
        {items.length}
        {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
      </span>
      <span className="flex-1" />
      {action}
    </div>
  );
}

export function ArchiveSection() {
  const { pin } = useSettingsMachineScope();
  const [items, setItems] = React.useState<ArchivedItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<KindFilter>("all");
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const result = await window.ade.archive.list({}, pin);
      setItems(result.items);
      setError(null);
      const live = new Set(result.items.map(refKey));
      setSelected((prev) => new Set([...prev].filter((key) => live.has(key))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the archive.");
    }
  }, [pin]);

  React.useEffect(() => {
    // A new machine starts empty: its list replaces the old one or the error
    // shows, and the old machine's refs can never be sent to the new pin.
    setItems(null);
    setSelected(new Set());
    void load();
  }, [load]);

  const counts = React.useMemo(() => {
    const byKind = emptyArchiveCounts();
    for (const item of items ?? []) byKind[item.kind] += 1;
    return byKind;
  }, [items]);

  const visible = React.useMemo(
    () => (items ?? []).filter((item) => filter === "all" || item.kind === filter),
    [filter, items],
  );

  const { recent, older } = React.useMemo(() => {
    const nowMs = Date.now();
    const groups = { recent: [] as ArchivedItem[], older: [] as ArchivedItem[] };
    for (const item of visible) {
      (isArchiveStale(item.archivedAt, DEFAULT_ARCHIVE_STALE_DAYS, nowMs) ? groups.older : groups.recent).push(item);
    }
    return groups;
  }, [visible]);

  const report = React.useCallback((verb: "Restored" | "Deleted", result: ArchiveActionResult) => {
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
              durationMs: 18_000,
            }
          : { tone: "success" as const }),
      });
    } else if (firstFailure) {
      showToast({ id: ARCHIVE_TOAST_ID, title: firstFailure.error, tone: "error" });
    }
  }, []);

  const restore = React.useCallback(async (refs: ArchiveItemRef[]) => {
    if (refs.length === 0) return;
    setBusy(true);
    try {
      report("Restored", await window.ade.archive.restore({ items: refs }, pin));
    } catch (err) {
      showToast({ id: ARCHIVE_TOAST_ID, title: err instanceof Error ? err.message : "Couldn't restore.", tone: "error" });
    } finally {
      setBusy(false);
      void load();
    }
  }, [load, pin, report]);

  const remove = React.useCallback(async (refs: ArchiveItemRef[]) => {
    if (refs.length === 0) return;
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
      let result = await window.ade.archive.delete({ items: refs }, pin);
      // A lane with uncommitted files is refused unless forced. Ask once, by
      // name, instead of silently discarding someone's unfinished work.
      // Match the refusal itself, not "could not verify whether…", which
      // `force` would not get past either.
      const dirtyLanes = result.failed.filter(
        (item) => item.kind === "lane" && /has uncommitted changes/i.test(item.error),
      );
      if (dirtyLanes.length > 0) {
        const names = dirtyLanes
          .map((ref) => items?.find((item) => item.kind === "lane" && item.id === ref.id)?.title ?? ref.id)
          .join(", ");
        const force = await confirmDialog({
          title: `${names} has uncommitted changes`,
          message: "Deleting loses them. Committed work stays on the branch.",
          confirmLabel: "Delete anyway",
          destructive: true,
        });
        if (force) {
          const retry = await window.ade.archive.delete(
            { items: dirtyLanes.map(({ kind, id }) => ({ kind, id })), force: true },
            pin,
          );
          const retried = new Set(dirtyLanes.map(refKey));
          result = {
            done: [...result.done, ...retry.done],
            failed: [...result.failed.filter((item) => !retried.has(refKey(item))), ...retry.failed],
          };
        }
      }
      report("Deleted", result);
    } catch (err) {
      showToast({ id: ARCHIVE_TOAST_ID, title: err instanceof Error ? err.message : "Couldn't delete.", tone: "error" });
    } finally {
      setBusy(false);
      void load();
    }
  }, [items, load, pin, report]);

  const selectedRefs = React.useMemo(
    () => visible.filter((item) => selected.has(refKey(item))).map(toRef),
    [selected, visible],
  );
  const selecting = selectedRefs.length > 0;

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const renderRows = (list: ArchivedItem[]) =>
    list.map((item) => (
      <ArchiveRow
        key={refKey(item)}
        item={item}
        selected={selected.has(refKey(item))}
        selecting={selecting}
        busy={busy}
        onToggle={() => toggle(refKey(item))}
        onRestore={() => void restore([toRef(item)])}
        onDelete={() => void remove([toRef(item)])}
      />
    ));

  return (
    <section id={ARCHIVE_SETTINGS_ANCHOR} data-settings-anchor={ARCHIVE_SETTINGS_ANCHOR} className="flex flex-col">
      {/* One bar: the filter, or — while something is selected — what to do with it. */}
      <div className="flex h-9 items-center gap-2">
        {selecting ? (
          <div data-testid="archive-selection-bar" className="flex w-full items-center gap-2">
            <button
              type="button"
              aria-label="Clear selection"
              onClick={() => setSelected(new Set())}
              className="flex size-7 items-center justify-center rounded-md text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg"
            >
              <X size={13} />
            </button>
            <span className="text-[12px] font-medium tabular-nums text-fg">{selectedRefs.length} selected</span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore(selectedRefs)}
              className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-white/[0.06] disabled:opacity-40"
            >
              <ArrowCounterClockwise size={13} /> Restore
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove(selectedRefs)}
              className="flex h-7 items-center gap-1.5 rounded-md bg-red-500/10 px-2.5 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/[0.16] disabled:opacity-40"
            >
              <Trash size={13} /> Delete
            </button>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Show" className="flex items-center gap-1">
            {FILTERS.map((option) => {
              const count = option.value === "all" ? items?.length ?? 0 : counts[option.value];
              const active = filter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors",
                    active ? "bg-white/[0.08] text-fg" : "text-muted-fg/70 hover:bg-white/[0.04] hover:text-fg",
                  )}
                >
                  {option.label}
                  <span className={cn("tabular-nums", active ? "text-muted-fg/80" : "text-muted-fg/40")}>{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && !items ? (
        <SettingsManagerEmpty
          title="Couldn't open the archive"
          description={error}
          action={
            <button
              type="button"
              onClick={() => void load()}
              className="h-7 rounded-md px-3 text-[12px] font-medium text-fg hover:bg-white/[0.06]"
            >
              Try again
            </button>
          }
        />
      ) : items && visible.length === 0 ? (
        <SettingsManagerEmpty
          title={filter === "all" ? "Nothing archived" : `No archived ${archiveKindPlural(filter)}`}
          description="Archived lanes, chats, and shells show up here."
        />
      ) : items ? (
        <div role="table" aria-label="Archived items" className="flex flex-col">
          {recent.length > 0 ? (
            <>
              <GroupHeader title={`Last ${DEFAULT_ARCHIVE_STALE_DAYS} days`} items={recent} />
              {renderRows(recent)}
            </>
          ) : null}
          {older.length > 0 ? (
            <>
              <GroupHeader
                title={`Older than ${DEFAULT_ARCHIVE_STALE_DAYS} days`}
                items={older}
                action={
                  <button
                    type="button"
                    disabled={busy || selecting}
                    onClick={() => void remove(older.map(toRef))}
                    className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-red-300/80 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                  >
                    <Trash size={12} /> Delete all
                  </button>
                }
              />
              {renderRows(older)}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
