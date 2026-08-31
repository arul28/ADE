/**
 * Compact one-line record of a tool call, expandable to its arguments and
 * result. This is the only place raw tool identifiers can surface, and the
 * activity label config exists to make sure they usually do not.
 */

import { useEffect, useState } from "react";

import type { ActivityLabelConfig } from "../activity/labels";
import { describeToolActivity } from "../activity/labels";
import { eventHasPayload, formatStructuredValue, type ToolChipRow } from "./transcriptRows";

export type ToolChipProps = {
  chip: ToolChipRow;
  labels?: ActivityLabelConfig;
  /** When the call started, for the elapsed suffix. */
  startedAt?: number | undefined;
  /** Force the expanded state; omit for uncontrolled. */
  expanded?: boolean;
  onToggle?: (expanded: boolean) => void;
};

/** Re-render every second, but only while something is actually running. */
function useElapsedMs(startedAt: number | undefined, running: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (startedAt === undefined || !running) return undefined;
  return Math.max(0, now - startedAt);
}

export function ToolChip({ chip, labels, startedAt, expanded, onToggle }: ToolChipProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = expanded ?? internalExpanded;
  const elapsedMs = useElapsedMs(startedAt, chip.status === "running");
  const { label, elapsed, icon } = describeToolActivity({
    chip,
    ...(labels ? { config: labels } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  });

  const hasArgs = eventHasPayload(chip.args);
  const hasResult = eventHasPayload(chip.result);
  const expandable = hasArgs || hasResult;

  const toggle = () => {
    if (!expandable) return;
    const next = !isExpanded;
    setInternalExpanded(next);
    onToggle?.(next);
  };

  return (
    <div className="adechat-chip" data-status={chip.status}>
      <button
        type="button"
        className="adechat-chip-head"
        onClick={toggle}
        aria-expanded={expandable ? isExpanded : undefined}
        aria-disabled={expandable ? undefined : "true"}
      >
        <span className="adechat-chip-dot" data-status={chip.status} aria-hidden="true" />
        {icon ? <span className="adechat-chip-icon">{icon as never}</span> : null}
        <span className="adechat-chip-label">{label}</span>
        {elapsed ? <span className="adechat-chip-elapsed">{elapsed}</span> : null}
      </button>
      {isExpanded && expandable ? (
        <div className="adechat-chip-body">
          {hasArgs ? (
            <div>
              <div className="adechat-chip-section-label">Arguments</div>
              <pre className="adechat-chip-pre">{formatStructuredValue(chip.args)}</pre>
            </div>
          ) : null}
          {hasResult ? (
            <div>
              <div className="adechat-chip-section-label">Result</div>
              <pre className="adechat-chip-pre">{formatStructuredValue(chip.result)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
