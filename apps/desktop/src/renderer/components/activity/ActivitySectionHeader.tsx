import React from "react";
import { CaretRight } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import { ActivityStateGlyphMark } from "./ActivityStateGlyphMark";
import type { ActivityStateGroup } from "./activityPresentation";
import { ACTIVITY_SECTION_TONE } from "./activityPriority";

/**
 * One section heading, for both Activity surfaces.
 *
 * It is a button, not a heading with a button in it: the whole strip is the
 * target, which is the difference between a control you can hit and a caret you
 * have to aim at. The `<h3>`/`<h4>` wrapper stays so the document still has an
 * outline a screen reader can jump through, and `aria-expanded`/`aria-controls`
 * point at the rows the press actually hides.
 *
 * The glyph replaces the bare tone dot the sections used to carry. A dot only
 * repeats the colour; the glyph says which state the colour means, which is the
 * whole point of the state glyph language and the reason a 14px notch strip can
 * carry the same vocabulary.
 */
/**
 * Written out rather than built from a `${prefix}-` template: the templated
 * form meant `activity-section-heading` appeared nowhere in the source, so
 * grepping the class from the stylesheet or the devtools found nothing.
 */
const SECTION_CLASSES = {
  popover: { heading: "activity-hdr-section-heading", count: "activity-hdr-section-count" },
  pane: { heading: "activity-section-heading", count: "activity-section-count" },
} as const satisfies Record<"popover" | "pane", { heading: string; count: string }>;

export function ActivitySectionHeader({
  variant,
  sectionId,
  regionId,
  label,
  count,
  group,
  collapsed,
  onToggle,
}: {
  variant: "popover" | "pane";
  sectionId: string;
  /** The element this header shows and hides. */
  regionId: string;
  label: string;
  count: number;
  /** Omitted for groupings that are not a state — the notification clusters. */
  group?: ActivityStateGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const classes = SECTION_CLASSES[variant];
  // The hue follows from the group, so it is read off the one table rather than
  // passed in beside it: callers used to spell the same value twice, which is
  // the shape a heading painted in a colour its own glyph disagreed with.
  const tone = group ? ACTIVITY_SECTION_TONE[group] : "neutral";
  const Heading = variant === "popover" ? "h3" : "h4";
  return (
    <Heading
      data-activity-section={sectionId}
      className={cn(classes.heading, `activity-tone-${tone}`)}
    >
      <button
        type="button"
        className="activity-section-toggle"
        aria-expanded={!collapsed}
        aria-controls={regionId}
        data-activity-section-toggle={sectionId}
        onClick={onToggle}
      >
        <CaretRight
          size={9}
          weight="bold"
          aria-hidden
          className={cn("activity-section-caret", !collapsed && "is-open")}
        />
        {group ? (
          <span className="activity-section-glyph" aria-hidden>
            <ActivityStateGlyphMark group={group} size={11} />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={classes.count}>{count}</span>
      </button>
    </Heading>
  );
}
