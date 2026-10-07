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
import {
  useActivitySectionCollapse,
  type ActivityCollapseSurface,
} from "./activitySectionCollapse";
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
 * The Inbox: the things that would have pushed a notification — failing
 * checks, review requests, and merged work nobody has looked at yet — grouped
 * by the project they landed in, because a run of six rows from one repo is one
 * fact, not six.
 *
 * Dismiss is per row because the whole point of the list is that it should
 * empty. Clear all, its bulk twin, lives in the panel toolbar beside the
 * Sessions / Inbox switch.
 */
export function ActivityInboxList({
  items,
  surface,
  selectedItemId,
  filtered,
  onOpenItem,
  onDismissItem,
}: {
  /** Notification rows, already filtered and sorted (`activityNotificationItems`). */
  items: readonly AttentionItem[];
  /** Which surface's collapse memory the project groups use. */
  surface: ActivityCollapseSurface;
  selectedItemId: string | null;
  filtered: boolean;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
}) {
  const collapse = useActivitySectionCollapse(surface);
  const {
    visibleRows: shown,
    hiddenCount,
    nextCount,
    showMore,
  } = useProgressiveRows(items);

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

  if (items.length === 0) {
    return (
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
    );
  }

  return (
    <>
      {groups.map((group) => {
        const sectionId = `notifications:${group.name}`;
        const collapsed = collapse.isCollapsed(sectionId);
        const regionId = `activity-${surface}-notifications-${encodeURIComponent(group.name)}`;
        return (
          <React.Fragment key={group.name}>
            <ActivitySectionHeader
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
  );
}
