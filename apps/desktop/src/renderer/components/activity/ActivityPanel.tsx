import React, { useMemo, useState } from "react";
import { ArrowRight, CaretDown } from "@phosphor-icons/react";

import type { AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { cn } from "../ui/cn";
import { ActivityAllClear } from "./ActivityAllClear";
import { ActivityCard } from "./ActivityCard";
import { ActivityCardSkeleton } from "./ActivityCardSkeleton";
import { ActivityColumnMark } from "./ActivityColumnMark";
import { ActivityInboxList } from "./ActivityInboxList";
import { ActivitySectionHeader } from "./ActivitySectionHeader";
import {
  ACTIVITY_COLUMN_PRESENTATION,
  ACTIVITY_COLUMNS,
  type ActivityColumn,
} from "./activityPresentation";
import {
  ACTIVITY_SECTION_TONE,
  activityNotificationItems,
  activitySectionCounts,
  activitySections,
  type ActivitySection,
} from "./activityPriority";
import { useAllClearBeat } from "./useAllClearBeat";
import { useProgressiveRows } from "./useProgressiveRows";

/**
 * Rows a column shows in the compact panel before handing off to the expanded
 * view. The expanded view pages through everything instead.
 */
const COMPACT_ROWS_PER_COLUMN = 6;

export type ActivityBucket = "sessions" | "inbox";

export type ActivityPanelSize = "compact" | "expanded";

type MachineGroup = {
  machineKey: string;
  name: string;
  lastSeenAt: string | null;
  items: AttentionItem[];
};

/**
 * Split a column into the work being observed and the work being remembered.
 * An offline machine's rows are last-known state, so they sit below a labelled
 * divider instead of mixing into a list that otherwise means "right now".
 */
function partitionByPresence(items: readonly AttentionItem[]): {
  online: AttentionItem[];
  offline: MachineGroup[];
} {
  const online: AttentionItem[] = [];
  const offline = new Map<string, MachineGroup>();
  for (const item of items) {
    if (item.machine.online) {
      online.push(item);
      continue;
    }
    const existing = offline.get(item.machine.machineKey);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    offline.set(item.machine.machineKey, {
      machineKey: item.machine.machineKey,
      name: item.machine.name,
      lastSeenAt: item.machine.lastSeenAt,
      items: [item],
    });
  }
  return {
    online,
    offline: [...offline.values()].sort((left, right) =>
      left.name.localeCompare(right.name)),
  };
}

type RowHandlers = {
  hideDetails: boolean;
  selectedItemId: string | null;
  checkedIds?: ReadonlySet<string>;
  onToggleChecked?: (item: AttentionItem) => void;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
};

function ColumnRows({ items, handlers }: { items: readonly AttentionItem[]; handlers: RowHandlers }) {
  const { online, offline } = useMemo(() => partitionByPresence(items), [items]);
  const card = (item: AttentionItem) => (
    <ActivityCard
      key={item.id}
      item={item}
      hideDetails={handlers.hideDetails}
      selected={handlers.selectedItemId === item.id}
      onOpen={handlers.onOpenItem}
      onDismiss={handlers.onDismissItem}
      selection={handlers.checkedIds && handlers.onToggleChecked
        ? { checked: handlers.checkedIds.has(item.id), onToggle: handlers.onToggleChecked }
        : undefined}
    />
  );
  return (
    <>
      {online.map(card)}
      {offline.map((group) => (
        <div key={group.machineKey} className="activity-offline-group">
          <div
            className="activity-offline-divider"
            data-activity-offline-machine={group.machineKey}
          >
            <span className="truncate">{group.name}</span>
            <span aria-hidden>·</span>
            <span>
              {group.lastSeenAt
                ? `last seen ${relativeWhen(group.lastSeenAt)}`
                : "offline"}
            </span>
          </div>
          {group.items.map(card)}
        </div>
      ))}
    </>
  );
}

/**
 * All · Needs you · Working · Waiting · Done, each with its count. It is the
 * summary and the filter at once, single-select, with All as the way back.
 * The counts never narrow with the chip itself, so the other columns stay
 * reachable from the control that hid them.
 */
function ActivityColumnChips({
  counts,
  total,
  selected,
  onSelect,
}: {
  counts: Record<ActivityColumn, number>;
  total: number;
  selected: ActivityColumn | null;
  onSelect: (next: ActivityColumn | null) => void;
}) {
  return (
    <div
      className="kit-seg activity-chips"
      data-case="sentence"
      role="radiogroup"
      aria-label="Show sessions"
      data-testid="activity-column-chips"
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected === null}
        data-activity-chip="all"
        onClick={() => onSelect(null)}
      >
        <span>All</span>
        <span className="kit-num activity-chip-count">{total}</span>
      </button>
      {ACTIVITY_COLUMNS.map((column) => (
        <button
          key={column}
          type="button"
          role="radio"
          aria-checked={selected === column}
          data-activity-chip={column}
          className={`activity-tone-${ACTIVITY_SECTION_TONE[column]}`}
          onClick={() => onSelect(selected === column ? null : column)}
        >
          <span className="activity-chip-glyph" aria-hidden>
            <ActivityColumnMark column={column} size={11} />
          </span>
          <span>{ACTIVITY_COLUMN_PRESENTATION[column].label}</span>
          <span className="kit-num activity-chip-count">{counts[column]}</span>
        </button>
      ))}
    </div>
  );
}

function SessionsList({
  size,
  sections,
  column,
  loading,
  filtered,
  allClear,
  handlers,
  onOpenPane,
}: {
  size: ActivityPanelSize;
  sections: ActivitySection[];
  column: ActivityColumn | null;
  loading: boolean;
  filtered: boolean;
  allClear: boolean;
  handlers: RowHandlers;
  onOpenPane?: () => void;
}) {
  // Done is the most common state and the least urgent one, so it folds into
  // one "N done" line until asked for. Choosing the Done chip opens it.
  const [doneOpen, setDoneOpen] = useState(false);
  const shownSections = column
    ? sections.filter((section) => section.id === column)
    : sections.filter((section) => section.items.length > 0);
  const doneSection = shownSections.find((section) => section.id === "done");
  const doneFolded = column === null && !doneOpen && Boolean(doneSection);
  const listed = doneFolded
    ? shownSections.filter((section) => section.id !== "done")
    : shownSections;

  // The expanded view pages through every row; the budget is spent in column
  // order so Needs you rows are never the ones pushed past it.
  const orderedRows = useMemo(
    () => (size === "expanded" ? listed.flatMap((section) => section.items) : []),
    [listed, size],
  );
  const { visibleRows, hiddenCount, nextCount, showMore } = useProgressiveRows(orderedRows);
  const visibleIds = useMemo(() => new Set(visibleRows.map((item) => item.id)), [visibleRows]);
  const total = sections.reduce((count, section) => count + section.items.length, 0);

  if (total === 0 && loading) {
    // Placeholders, not an all-clear: claiming nothing is running before the
    // first snapshot lands is a lie the user would act on.
    return <>{Array.from({ length: 4 }, (_, index) => <ActivityCardSkeleton key={index} />)}</>;
  }
  const columnEmpty = column !== null && (shownSections[0]?.items.length ?? 0) === 0;
  if (total === 0 || columnEmpty) {
    return (
      <>
        {allClear ? <ActivityAllClear compact={size === "compact"} /> : null}
        <div className="activity-empty" data-activity-empty="sessions">
          {filtered || columnEmpty ? (
            <>
              <strong>
                {column
                  ? `Nothing in ${ACTIVITY_COLUMN_PRESENTATION[column].label}`
                  : "No sessions match"}
              </strong>
              <p>{column ? "Choose All to see every session." : "Clear a filter to see the rest of your account."}</p>
            </>
          ) : (
            <>
              <span className="activity-calm-dot" aria-hidden />
              <strong>Nothing running</strong>
              <p>Work from every signed-in machine shows here when it starts.</p>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {allClear ? <ActivityAllClear compact={size === "compact"} /> : null}
      {listed.map((section) => {
        const rows = size === "compact"
          ? section.items.slice(0, COMPACT_ROWS_PER_COLUMN)
          : section.items.filter((item) => visibleIds.has(item.id));
        const overflow = size === "compact" ? section.items.length - rows.length : 0;
        if (rows.length === 0 && size === "expanded") return null;
        return (
          <section
            key={section.id}
            className="activity-column-section"
            data-activity-column={section.id}
          >
            {/* With one chip lit the heading would repeat it word for word. */}
            {column ? null : (
              <ActivitySectionHeader
                sectionId={section.id}
                regionId={`activity-${size}-column-${section.id}`}
                label={section.label}
                count={section.items.length}
                column={section.id}
                // An opened Done folds back from its own heading.
                onToggle={section.id === "done" ? () => setDoneOpen(false) : undefined}
              />
            )}
            <div id={`activity-${size}-column-${section.id}`} className="activity-section-rows">
              <ColumnRows items={rows} handlers={handlers} />
              {overflow > 0 && onOpenPane ? (
                <button type="button" className="activity-more" onClick={onOpenPane}>
                  {overflow} more
                  <ArrowRight size={11} weight="bold" />
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
      {doneFolded && doneSection ? (
        <button
          type="button"
          className="activity-done-fold activity-tone-emerald"
          aria-expanded={false}
          data-activity-done-fold={doneSection.items.length}
          onClick={() => setDoneOpen(true)}
        >
          <ActivityColumnMark column="done" size={11} />
          <span>{doneSection.items.length} done</span>
          <CaretDown size={10} weight="bold" aria-hidden />
        </button>
      ) : null}
      {hiddenCount > 0 ? (
        <button type="button" className="activity-more" onClick={showMore}>
          Show {nextCount} more
        </button>
      ) : null}
    </>
  );
}

/**
 * The Activity panel, in both of its sizes: the top-bar popover (compact) and
 * the "Open all" view (expanded). Same controls, same grouping, same rows; the
 * expanded size adds what only fits there — filters, multi-select and the
 * detail sheet — around it, in `ActivityPane`.
 *
 * Sessions are every agent on the account grouped by the Work board's four
 * columns. The Inbox is pull requests, checks and review outcomes: they push
 * and badge, but they are not sessions, so they are never counted in a column.
 */
export function ActivityPanel({
  size,
  items,
  now,
  hideDetails,
  loading = false,
  filtered = false,
  selectedItemId = null,
  checkedIds,
  onToggleChecked,
  onOpenItem,
  onDismissItem,
  onClearInbox,
  onOpenPane,
  toolbarEnd,
}: {
  size: ActivityPanelSize;
  /** Every item the panel may show, after any filters the container applies. */
  items: readonly AttentionItem[];
  now: number;
  hideDetails: boolean;
  /** No snapshot has landed yet — which is not the same as nothing running. */
  loading?: boolean;
  /** The container narrowed `items`; changes the empty-state copy. */
  filtered?: boolean;
  selectedItemId?: string | null;
  checkedIds?: ReadonlySet<string>;
  onToggleChecked?: (item: AttentionItem) => void;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
  onClearInbox: (items: readonly AttentionItem[]) => void;
  /** Compact only: where "N more" hands off to. */
  onOpenPane?: () => void;
  /** Extra controls at the end of the toolbar row (the expanded selection bar). */
  toolbarEnd?: React.ReactNode;
}) {
  const [bucket, setBucket] = useState<ActivityBucket>("sessions");
  const [column, setColumn] = useState<ActivityColumn | null>(null);

  const sections = useMemo(() => activitySections(items, now), [items, now]);
  const counts = useMemo(() => activitySectionCounts(sections), [sections]);
  const sessionCount = ACTIVITY_COLUMNS.reduce((total, id) => total + counts[id], 0);
  const inbox = useMemo(() => activityNotificationItems(items, now), [items, now]);
  const allClear = useAllClearBeat(counts.needs_you);

  const handlers: RowHandlers = {
    hideDetails,
    selectedItemId,
    checkedIds,
    onToggleChecked,
    onOpenItem,
    onDismissItem,
  };

  return (
    <div
      className="activity-panel"
      data-activity-panel={size}
      data-selecting={checkedIds && checkedIds.size > 0 ? "true" : undefined}
    >
      <div className="activity-panel-toolbar">
        <div className="kit-seg" data-case="sentence" role="tablist" aria-label="Activity">
          <button
            type="button"
            role="tab"
            aria-selected={bucket === "sessions"}
            data-activity-bucket="sessions"
            onClick={() => setBucket("sessions")}
          >
            Sessions <span className="kit-num activity-chip-count">{sessionCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={bucket === "inbox"}
            data-activity-bucket="inbox"
            onClick={() => setBucket("inbox")}
          >
            Inbox <span className="kit-num activity-chip-count">{inbox.length}</span>
          </button>
        </div>
        <span className="flex-1" />
        {bucket === "inbox" && inbox.length > 0 ? (
          <button
            type="button"
            className="kit-btn kit-btn-ghost activity-panel-action"
            onClick={() => onClearInbox(inbox)}
          >
            Clear all
          </button>
        ) : null}
        {bucket === "sessions" ? toolbarEnd : null}
      </div>
      {bucket === "sessions" ? (
        <div className="activity-panel-chips">
          <ActivityColumnChips
            counts={counts}
            total={sessionCount}
            selected={column}
            onSelect={setColumn}
          />
        </div>
      ) : null}
      <div
        className={cn("activity-panel-scroll", size === "compact" && "is-compact")}
        data-testid={bucket === "sessions" ? "activity-sessions-scroll" : "activity-inbox-scroll"}
      >
        {bucket === "sessions" ? (
          <SessionsList
            size={size}
            sections={sections}
            column={column}
            loading={loading}
            filtered={filtered}
            allClear={allClear}
            handlers={handlers}
            onOpenPane={onOpenPane}
          />
        ) : (
          <ActivityInboxList
            items={inbox}
            surface={size === "compact" ? "popover" : "pane"}
            selectedItemId={selectedItemId}
            filtered={filtered}
            onOpenItem={onOpenItem}
            onDismissItem={onDismissItem}
          />
        )}
      </div>
    </div>
  );
}
