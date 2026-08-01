import React, { useMemo } from "react";

import type { AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { cn } from "../ui/cn";
import { ActivityCard } from "./ActivityCard";
import { ActivityCardSkeleton } from "./ActivityCardSkeleton";
import {
  ACTIVITY_SECTION_TONE,
  activitySections,
  type ActivitySection,
} from "./activityPriority";
import { useProgressiveRows } from "./useProgressiveRows";

type MachineGroup = {
  machineKey: string;
  name: string;
  lastSeenAt: string | null;
  items: AttentionItem[];
};

/**
 * Split a section into the work being observed and the work being remembered.
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

function SectionRows({
  section,
  hideDetails,
  selectedItemId,
  onOpenItem,
}: {
  section: ActivitySection;
  hideDetails: boolean;
  selectedItemId: string | null;
  onOpenItem: (item: AttentionItem) => void;
}) {
  const { online, offline } = useMemo(
    () => partitionByPresence(section.items),
    [section.items],
  );

  const card = (item: AttentionItem) => (
    <ActivityCard
      key={item.id}
      item={item}
      hideDetails={hideDetails}
      selected={selectedItemId === item.id}
      onOpen={onOpenItem}
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
 * The left column: every tracked session, priority-flat across needs-you →
 * working → done, with section headings that stay put while the list scrolls.
 */
export function ActivitySessionsColumn({
  items,
  hideDetails,
  selectedItemId,
  filtered,
  loading,
  onOpenItem,
}: {
  /** Already filtered. The column does not know the filter exists. */
  items: readonly AttentionItem[];
  hideDetails: boolean;
  selectedItemId: string | null;
  /** Changes the all-clear copy: nothing here is not the same as nothing at all. */
  filtered: boolean;
  /** No snapshot has landed yet — which is not the same as nothing running. */
  loading: boolean;
  onOpenItem: (item: AttentionItem) => void;
}) {
  const sections = useMemo(() => activitySections(items), [items]);
  const total = sections.reduce((count, section) => count + section.items.length, 0);
  // Flatten in section priority order before spending the shared row budget,
  // then rebuild headings for the visible slice. Needs-you rows stay first.
  const orderedRows = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections],
  );
  const {
    visibleRows,
    hiddenCount,
    nextCount,
    showMore,
  } = useProgressiveRows(orderedRows);
  const budgeted = useMemo(() => activitySections(visibleRows), [visibleRows]);

  return (
    <section className="activity-column" aria-label="Sessions">
      <header className="activity-column-head">
        <h3>Sessions</h3>
        <span className="activity-column-head-count">{total}</span>
      </header>
      <div className="activity-column-scroll" data-testid="activity-sessions-scroll">
        {total === 0 && loading ? (
          // Placeholders, not an all-clear: claiming every agent is idle before
          // the first snapshot lands is a lie the user would act on.
          Array.from({ length: 4 }, (_, index) => <ActivityCardSkeleton key={index} />)
        ) : total === 0 ? (
          <div className="activity-empty" data-activity-empty="sessions">
            {filtered ? (
              <>
                <strong>No sessions match</strong>
                <p>Clear a filter to see the rest of your account.</p>
              </>
            ) : (
              <>
                <span className="activity-calm-dot" aria-hidden />
                <strong>All agents idle</strong>
                <p>Work from every signed-in machine lands here the moment it starts.</p>
              </>
            )}
          </div>
        ) : (
          <>
            {budgeted.map((section) => (
              <React.Fragment key={section.id}>
                <h4
                  data-activity-section={section.id}
                  className={cn(
                    "activity-section-heading",
                    `activity-tone-${ACTIVITY_SECTION_TONE[section.id]}`,
                  )}
                >
                  <span className="activity-section-dot" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  <span className="activity-section-count">
                    {sections.find((entry) => entry.id === section.id)?.items.length ?? 0}
                  </span>
                </h4>
                <SectionRows
                  section={section}
                  hideDetails={hideDetails}
                  selectedItemId={selectedItemId}
                  onOpenItem={onOpenItem}
                />
              </React.Fragment>
            ))}
            {hiddenCount > 0 ? (
              <button
                type="button"
                className="activity-more"
                onClick={showMore}
              >
                Show {nextCount} more
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
