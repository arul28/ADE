import React from "react";
import { Check } from "@phosphor-icons/react";

/**
 * The all-clear beat. It marks the moment the last raised hand went down —
 * the one transition in Activity that is unambiguously good news and had, until
 * now, no representation at all: the section simply stopped existing.
 *
 * Deliberately a strip and not a celebration. Confetti belongs to a merge; this
 * is the quieter fact that nothing is waiting on you, and it should read as
 * relief rather than as an event. `role="status"` so it is announced once, and
 * the entrance is behind `prefers-reduced-motion` in the stylesheet.
 */
export function ActivityAllClear({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="activity-all-clear"
      data-activity-all-clear="true"
      data-compact={compact ? "true" : undefined}
      role="status"
    >
      <span className="activity-all-clear-mark" aria-hidden>
        <Check size={compact ? 10 : 11} weight="bold" />
      </span>
      <span>All clear</span>
    </div>
  );
}
