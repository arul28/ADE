import React from "react";
import { CaretRight } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import { ActivityColumnMark } from "./ActivityColumnMark";
import type { ActivityColumn } from "./activityPresentation";
import { ACTIVITY_SECTION_TONE } from "./activityPriority";

/**
 * One section heading, for both Activity sizes: the column's glyph, its label
 * and its count.
 *
 * A heading with `onToggle` is a button — the whole strip is the target — with
 * `aria-expanded`/`aria-controls` pointing at the rows it hides. The column
 * headings in the Sessions list have no toggle (Done folds through its own
 * "N done" line instead); the project groups in the Inbox do.
 */
export function ActivitySectionHeader({
  sectionId,
  regionId,
  label,
  count,
  column,
  collapsed = false,
  onToggle,
}: {
  sectionId: string;
  /** The element this header shows and hides. */
  regionId?: string;
  label: string;
  count: number;
  /** Omitted for groupings that are not a column — the notification clusters. */
  column?: ActivityColumn;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const tone = column ? ACTIVITY_SECTION_TONE[column] : "neutral";
  const body = (
    <>
      {onToggle ? (
        <CaretRight
          size={9}
          weight="bold"
          aria-hidden
          className={cn("activity-section-caret", !collapsed && "is-open")}
        />
      ) : null}
      {column ? (
        <span className="activity-section-glyph" aria-hidden>
          <ActivityColumnMark column={column} size={11} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="activity-section-count kit-num">{count}</span>
    </>
  );
  return (
    <h3
      data-activity-section={sectionId}
      className={cn("activity-section-heading", `activity-tone-${tone}`)}
    >
      {onToggle ? (
        <button
          type="button"
          className="activity-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={regionId}
          data-activity-section-toggle={sectionId}
          onClick={onToggle}
        >
          {body}
        </button>
      ) : (
        <span className="activity-section-toggle">{body}</span>
      )}
    </h3>
  );
}
