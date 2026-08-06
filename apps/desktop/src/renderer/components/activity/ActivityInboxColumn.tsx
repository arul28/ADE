import React, { useMemo } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  CircleDashed,
  GitBranch,
  GitMerge,
  GitPullRequest,
  PencilSimpleLine,
  Prohibit,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import { ACTIVITY_EVENT_BY_KIND, type ActivityIconKey } from "../../../shared/activityCatalog";
import type { AttentionItem } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { cn } from "../ui/cn";
import { ActivitySectionHeader } from "./ActivitySectionHeader";
import { activityItemPresentation } from "./activityPresentation";
import { activityNotificationItems } from "./activityPriority";
import { useActivitySectionCollapse } from "./activitySectionCollapse";
import { useProgressiveRows } from "./useProgressiveRows";

/** The catalog names an icon per event; this is the renderer's half of that. */
const CATALOG_ICON: Record<ActivityIconKey, React.ElementType> = {
  working: CircleDashed,
  "needs-you": WarningCircle,
  failed: WarningCircle,
  done: CheckCircle,
  checks: ArrowsClockwise,
  review: PencilSimpleLine,
  changes: PencilSimpleLine,
  "merge-ready": GitMerge,
  "pull-request": GitPullRequest,
  closed: Prohibit,
};

/**
 * The notification side of Activity: pull requests, checks and review outcomes.
 *
 * Agent rows are deliberately absent even when they would have pushed. They are
 * sessions, they live in the Agents column, and rendering them here as well was
 * how one raised hand became two rows on screen with the same id.
 */
export function activityInboxItems(
  items: readonly AttentionItem[],
): AttentionItem[] {
  return activityNotificationItems(items);
}

/** Repo first, project second: a notification's subject is where it landed. */
function notificationGroupName(item: AttentionItem): string {
  return item.project.name?.trim() || "Elsewhere";
}

function InboxRow({
  item,
  selected,
  onOpen,
  onDismiss,
}: {
  item: AttentionItem;
  selected: boolean;
  onOpen: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
}) {
  const descriptor = ACTIVITY_EVENT_BY_KIND[item.eventKind];
  const Icon = CATALOG_ICON[descriptor?.iconKey ?? "pull-request"] ?? GitBranch;
  const tone = activityItemPresentation(item)?.tone ?? "neutral";
  return (
    <div
      className={cn("activity-inbox-row", `activity-tone-${tone}`)}
      data-activity-inbox-row={item.id}
      data-selected={selected ? "true" : undefined}
    >
      <button
        type="button"
        className="activity-inbox-open"
        onClick={() => onOpen(item)}
        title={`${item.title} — ${item.project.name} · ${item.machine.name}`}
      >
        <span className="activity-inbox-icon" aria-hidden>
          <Icon size={13} weight="duotone" />
        </span>
        <span className="activity-inbox-copy">
          <strong>{item.title}</strong>
          <span>
            {descriptor?.label ?? item.eventKind}
            {" · "}
            {item.machine.name}
            {" · "}
            {relativeWhen(item.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="activity-inbox-dismiss"
        aria-label={`Dismiss ${item.title}`}
        title="Dismiss"
        onClick={() => onDismiss(item)}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}

/**
 * The right column: the things that would have pushed a notification — failing
 * checks, review requests, and merged work nobody has looked at yet — grouped
 * by the project they landed in, because a run of six rows from one repo is one
 * fact, not six.
 *
 * Dismiss is per row because the whole point of the column is that it should
 * empty, and a list you can only clear wholesale never does. Clear all is the
 * bulk twin of the same gesture, and it is a SINGLE call: N racing calls was
 * the reason the button looked inert.
 */
export function ActivityInboxColumn({
  items,
  selectedItemId,
  filtered,
  onOpenItem,
  onDismissItem,
  onClearAll,
}: {
  /** Already filtered; notification eligibility is decided here. */
  items: readonly AttentionItem[];
  selectedItemId: string | null;
  filtered: boolean;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
  onClearAll: (items: readonly AttentionItem[]) => void;
}) {
  const inbox = useMemo(() => activityInboxItems(items), [items]);
  const collapse = useActivitySectionCollapse("pane");
  const {
    visibleRows: shown,
    hiddenCount,
    nextCount,
    showMore,
  } = useProgressiveRows(inbox);

  // Grouping preserves the priority order the sort already established: a group
  // appears where its most urgent row would have.
  const groups = useMemo(() => {
    const byName = new Map<string, AttentionItem[]>();
    for (const item of shown) {
      const name = notificationGroupName(item);
      const existing = byName.get(name);
      if (existing) existing.push(item);
      else byName.set(name, [item]);
    }
    return [...byName.entries()].map(([name, rows]) => ({ name, rows }));
  }, [shown]);

  return (
    <section className="activity-column" aria-label="Notifications">
      <header className="activity-column-head">
        <h3>Notifications</h3>
        <span className="activity-column-head-count">{inbox.length}</span>
        {inbox.length > 0 ? (
          <button
            type="button"
            className="activity-column-action"
            onClick={() => onClearAll(inbox)}
          >
            Clear all
          </button>
        ) : null}
      </header>
      <div className="activity-column-scroll" data-testid="activity-inbox-scroll">
        {inbox.length === 0 ? (
          <div className="activity-empty" data-activity-empty="inbox">
            {filtered ? (
              <>
                <strong>Nothing here matches</strong>
                <p>Clear a filter to see the rest of your notifications.</p>
              </>
            ) : (
              <>
                <CheckCircle size={20} weight="duotone" aria-hidden />
                <strong>Inbox zero</strong>
                <p>
                  Failing checks, review requests, and merged work you haven’t
                  seen collect here.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {groups.map((group) => {
              const sectionId = `notifications:${group.name}`;
              const collapsed = collapse.isCollapsed(sectionId);
              const regionId = `activity-notifications-${encodeURIComponent(group.name)}`;
              return (
                <React.Fragment key={group.name}>
                  <ActivitySectionHeader
                    variant="pane"
                    sectionId={sectionId}
                    regionId={regionId}
                    label={group.name}
                    count={group.rows.length}
                    collapsed={collapsed}
                    onToggle={() => collapse.toggle(sectionId)}
                  />
                  <div id={regionId} className="activity-section-rows" hidden={collapsed}>
                    {collapsed ? null : group.rows.map((item) => (
                      <InboxRow
                        key={item.id}
                        item={item}
                        selected={selectedItemId === item.id}
                        onOpen={onOpenItem}
                        onDismiss={onDismissItem}
                      />
                    ))}
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
