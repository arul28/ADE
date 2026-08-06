import React, { useMemo } from "react";

import type { AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { ActivityAllClear } from "./ActivityAllClear";
import { ActivityCard } from "./ActivityCard";
import { ActivityCardSkeleton } from "./ActivityCardSkeleton";
import { ActivitySectionHeader } from "./ActivitySectionHeader";
import {
  activitySectionCounts,
  activitySections,
  type ActivitySection,
} from "./activityPriority";
import { useActivitySectionCollapse } from "./activitySectionCollapse";
import { useAllClearBeat } from "./useAllClearBeat";
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
  onDismissItem,
}: {
  section: ActivitySection;
  hideDetails: boolean;
  selectedItemId: string | null;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
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
      onDismiss={onDismissItem}
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
 * The left column: every tracked AGENT session, priority-flat across needs-you
 * → failed → planning → working → done, with collapsible section headings that
 * stay put while the list scrolls.
 *
 * Pull requests used to render here too, which is why a lane with an open PR
 * appeared twice — once as the agent working on it and once as the PR. They
 * belong to the Notifications column now; this column is agents, and only
 * agents, so its count is the count of your sessions.
 */
export function ActivitySessionsColumn({
  items,
  hideDetails,
  selectedItemId,
  filtered,
  loading,
  onOpenItem,
  onDismissItem,
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
  onDismissItem: (item: AttentionItem) => void;
}) {
  const sections = useMemo(() => activitySections(items), [items]);
  // The unbudgeted truth for every section, built once: the headings report how
  // many rows a section HAS, not how many the row budget let through.
  const counts = useMemo(() => activitySectionCounts(sections), [sections]);
  const total = sections.reduce((count, section) => count + section.items.length, 0);
  const collapse = useActivitySectionCollapse("pane");
  const allClear = useAllClearBeat(counts["needs-you"]);
  // Flatten in section priority order before spending the shared row budget,
  // then rebuild headings for the visible slice. Needs-you rows stay first.
  // Collapsed sections spend no budget at all — the rows they hide would push
  // the rows you can see past the cap.
  const isCollapsed = collapse.isCollapsed;
  const orderedRows = useMemo(
    () => sections.flatMap((section) =>
      (isCollapsed(section.id) ? [] : section.items)),
    [isCollapsed, sections],
  );
  const {
    visibleRows,
    hiddenCount,
    nextCount,
    showMore,
  } = useProgressiveRows(orderedRows);
  const budgeted = useMemo(() => activitySections(visibleRows), [visibleRows]);
  const populated = budgeted.filter((section) => counts[section.id] > 0);

  return (
    <section className="activity-column" aria-label="Agents">
      <header className="activity-column-head">
        <h3>Agents</h3>
        <span className="activity-column-head-count">{total}</span>
      </header>
      <div className="activity-column-scroll" data-testid="activity-sessions-scroll">
        {allClear ? <ActivityAllClear /> : null}
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
            {populated.map((section) => {
              const collapsed = collapse.isCollapsed(section.id);
              const regionId = `activity-pane-section-${section.id}`;
              return (
                <React.Fragment key={section.id}>
                  <ActivitySectionHeader
                    variant="pane"
                    sectionId={section.id}
                    regionId={regionId}
                    label={section.label}
                    count={counts[section.id]}
                    group={section.id}
                    collapsed={collapsed}
                    onToggle={() => collapse.toggle(section.id)}
                  />
                  <div
                    id={regionId}
                    className="activity-section-rows"
                    hidden={collapsed}
                  >
                    {collapsed ? null : (
                      <SectionRows
                        section={section}
                        hideDetails={hideDetails}
                        selectedItemId={selectedItemId}
                        onOpenItem={onOpenItem}
                        onDismissItem={onDismissItem}
                      />
                    )}
                  </div>
                </React.Fragment>
              );
            })}
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
