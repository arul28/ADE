import React from "react";
import { Archive as ArchiveIcon, ArrowCounterClockwise, Check, Trash, X } from "@phosphor-icons/react";
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
import { confirmDialog } from "../ui/dialog";
import { showToast } from "../app/toast/toastStore";
import { LaneChip, LaneLogoMark, laneDisplayColor } from "../terminals/LaneChip";
import { ToolLogo } from "../terminals/ToolLogos";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { SettingsColumn } from "./primitives";
import "./primitives/settingsModern.css";
import "./machineSettings.css";

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
        className="ade-ar-mark"
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
    ? (item.branchRef ? <span className="ade-ar-branch">{item.branchRef}</span> : null)
    : (item.laneName ? <LaneChip laneName={item.laneName} laneColor={item.laneColor} maxWidth={160} /> : null);
  return (
    <div
      role="row"
      data-testid="archive-row"
      className="ade-ar-row"
      data-selected={selected || undefined}
    >
      <MarkOrSelect item={item} checked={selected} selecting={selecting} onToggle={onToggle} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ade-ar-title">{item.title}</div>
        <div className="ade-ar-meta">
          {where}
          {where ? <span aria-hidden style={{ opacity: 0.5 }}>·</span> : null}
          <span style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>{meta.join(" · ")}</span>
        </div>
      </div>
      {/* While selecting, the selection bar is the only place to act: the
          row's own actions leave the tab order too, not just the screen. */}
      {selecting ? null : (
        <div className="ade-ar-actions">
          <IconAction label="Restore" onClick={onRestore} disabled={busy}>
            <ArrowCounterClockwise size={14} />
          </IconAction>
          <IconAction label="Delete" onClick={onDelete} disabled={busy} danger>
            <Trash size={14} />
          </IconAction>
        </div>
      )}
    </div>
  );
}

function GroupHeader({ title, items, action }: { title: string; items: ArchivedItem[]; action?: React.ReactNode }) {
  const bytes = totalBytes(items);
  return (
    <div className="ade-ar-group">
      <span className="kit-eyebrow">{title}</span>
      <span className="ade-ar-group-count kit-num">
        {items.length}
        {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
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
  pin: Parameters<typeof window.ade.archive.delete>[1],
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
      let result = await deleteInBatches(refs, pin);
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
          const retry = await deleteInBatches(dirtyLanes.map(({ kind, id }) => ({ kind, id })), pin, true);
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

  const all = items ?? [];
  const allBytes = totalBytes(all);
  const staleAll = React.useMemo(() => {
    const nowMs = Date.now();
    return all.filter((item) => isArchiveStale(item.archivedAt, DEFAULT_ARCHIVE_STALE_DAYS, nowMs));
  }, [all]);
  const staleBytes = totalBytes(staleAll);

  const filterBar = (
    <div role="radiogroup" aria-label="Show" className="kit-seg" data-case="sentence">
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
          >
            {option.label}
            <span className="kit-num" style={{ marginLeft: 6, opacity: 0.6, fontSize: 10.5 }}>{count}</span>
          </button>
        );
      })}
    </div>
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
      <span className="ade-ar-title" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>{selectedRefs.length} selected</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        disabled={busy}
        onClick={() => void restore(selectedRefs)}
        className="ade-modern-btn"
        data-size="sm"
      >
        <ArrowCounterClockwise size={12} /> Restore
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void remove(selectedRefs)}
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
      <section id={ARCHIVE_SETTINGS_ANCHOR} data-settings-anchor={ARCHIVE_SETTINGS_ANCHOR} className="ade-modern-page">
        <div className="ade-ap-section">
          <header className="ade-ap-head">
            <div style={{ minWidth: 0 }}>
              <h2>On this machine</h2>
              <p>Archive only hides a thing. It stays on disk until you delete it here — ADE never deletes on its own.</p>
            </div>
          </header>
          <div className="ade-modern-stats">
            {(["lane", "chat", "shell"] as const).map((kind) => (
              <div key={kind} className="ade-modern-stat">
                <span className="kit-eyebrow">{archiveKindPlural(kind)}</span>
                <span className="ade-modern-stat-value">
                  <span className="kit-stat kit-num">{items ? counts[kind] : "–"}</span>
                </span>
                <span className="ade-modern-stat-sub">
                  {items ? (() => {
                    const bytes = totalBytes(all.filter((item) => item.kind === kind));
                    return bytes > 0 ? `${formatBytes(bytes)} on disk` : "Archived";
                  })() : "Loading…"}
                </span>
              </div>
            ))}
            <div className="ade-modern-stat">
              <span className="kit-eyebrow">On disk</span>
              <span className="ade-modern-stat-value">
                <span className="kit-stat kit-num">{items ? formatBytes(allBytes) : "–"}</span>
              </span>
              <div className="kit-meter" data-level={staleBytes > 0 ? "warn" : undefined} aria-hidden>
                <span style={{ width: `${allBytes > 0 ? Math.max(2, (staleBytes / allBytes) * 100) : 0}%` }} />
              </div>
              <span className="ade-modern-stat-sub">
                {staleAll.length > 0
                  ? `${formatBytes(staleBytes)} older than ${DEFAULT_ARCHIVE_STALE_DAYS} days`
                  : `Nothing older than ${DEFAULT_ARCHIVE_STALE_DAYS} days`}
              </span>
            </div>
          </div>
        </div>

        <div className="ade-ap-section">
          <header className="ade-ap-head" style={{ alignItems: "center", minHeight: 30 }}>
            {selecting ? selectionBar : (
              <>
                <div style={{ minWidth: 0 }}>
                  <h2>Archived</h2>
                </div>
                {filterBar}
              </>
            )}
          </header>

          {error && !items ? (
            <div className="ade-ar-empty">
              <div className="ade-ap-rowtitle">Couldn&apos;t open the archive</div>
              <p className="ade-modern-muted">{error}</p>
              <button type="button" onClick={() => void load()} className="ade-modern-btn" data-size="sm">
                Try again
              </button>
            </div>
          ) : items && visible.length === 0 ? (
            <div className="ade-ar-empty">
              <ArchiveIcon size={22} weight="light" />
              <div className="ade-ap-rowtitle">{filter === "all" ? "Nothing archived" : `No archived ${archiveKindPlural(filter)}`}</div>
              <p className="ade-modern-muted">Archived lanes, chats, and shells show up here.</p>
            </div>
          ) : items ? (
            <div role="table" aria-label="Archived items" className="ade-ar-table">
              {recent.length > 0 ? (
                <div className="ade-ar-block">
                  <GroupHeader title={`Last ${DEFAULT_ARCHIVE_STALE_DAYS} days`} items={recent} />
                  <div className="ade-modern-rows ade-ar-list">{renderRows(recent)}</div>
                </div>
              ) : null}
              {older.length > 0 ? (
                <div className="ade-ar-block">
                  <GroupHeader
                    title={`Older than ${DEFAULT_ARCHIVE_STALE_DAYS} days`}
                    items={older}
                    action={
                      <button
                        type="button"
                        disabled={busy || selecting}
                        onClick={() => void remove(older.map(toRef))}
                        className="ade-modern-btn"
                        data-size="sm"
                        data-tone="danger"
                      >
                        <Trash size={12} /> Delete all
                      </button>
                    }
                  />
                  <div className="ade-modern-rows ade-ar-list">{renderRows(older)}</div>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="ade-modern-muted">Loading the archive…</p>
          )}
        </div>
      </section>
    </SettingsColumn>
  );
}
