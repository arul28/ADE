import React, { useMemo, useState } from "react";
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
import {
  attentionItemNeedsInbox,
  sortAttentionItems,
  type AttentionItem,
} from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { cn } from "../ui/cn";
import { activityItemPresentation } from "./attentionPresentation";

const INITIAL_ROW_BUDGET = 60;
const ROW_BUDGET_STEP = 60;

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

export function activityInboxItems(
  items: readonly AttentionItem[],
): AttentionItem[] {
  return sortAttentionItems(items.filter(attentionItemNeedsInbox));
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
 * The right column: the things that would have pushed a notification — raised
 * hands, failures, review requests, and finished work nobody has looked at yet.
 * Dismiss is per row here because the whole point of the column is that it
 * should empty, and a list you can only clear wholesale never does.
 */
export function ActivityInboxColumn({
  items,
  selectedItemId,
  filtered,
  onOpenItem,
  onDismissItem,
  onClearAll,
}: {
  /** Already filtered; inbox eligibility is decided here. */
  items: readonly AttentionItem[];
  selectedItemId: string | null;
  filtered: boolean;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
  onClearAll: (items: readonly AttentionItem[]) => void;
}) {
  const [budget, setBudget] = useState(INITIAL_ROW_BUDGET);
  const inbox = useMemo(() => activityInboxItems(items), [items]);
  const shown = inbox.slice(0, budget);
  const hidden = inbox.length - shown.length;

  return (
    <section className="activity-column" aria-label="Inbox">
      <header className="activity-column-head">
        <h3>Inbox</h3>
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
                <p>Clear a filter to see the rest of your inbox.</p>
              </>
            ) : (
              <>
                <CheckCircle size={20} weight="duotone" aria-hidden />
                <strong>Inbox zero</strong>
                <p>
                  Failures, review requests, and finished work you haven’t seen
                  collect here.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {shown.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                selected={selectedItemId === item.id}
                onOpen={onOpenItem}
                onDismiss={onDismissItem}
              />
            ))}
            {hidden > 0 ? (
              <button
                type="button"
                className="activity-more"
                onClick={() => setBudget((value) => value + ROW_BUDGET_STEP)}
              >
                Show {Math.min(hidden, ROW_BUDGET_STEP)} more
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

export default ActivityInboxColumn;
