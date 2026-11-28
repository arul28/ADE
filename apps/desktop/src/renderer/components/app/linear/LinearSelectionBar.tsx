import React from "react";
import { Check, Minus, RocketLaunch } from "@phosphor-icons/react";
import type { IssueConflict } from "../../../lib/linearBatchLaunch";
import { cn } from "../../ui/cn";
import { confirmDialog } from "../../ui/dialog/confirm";
import type { BrowserIssue } from "../linearIssueBrowserModel";

/**
 * Re-attaching an issue that already has a lane or an agent is allowed (the
 * same issue can sit on several lanes); this asks once before it happens.
 * Resolves true when there is no conflict or the person proceeds.
 */
export async function confirmIssueRelaunch(
  issues: BrowserIssue[],
  conflicts: Map<string, IssueConflict> | undefined,
): Promise<boolean> {
  const conflicting = conflicts
    ? issues.map((issue) => conflicts.get(issue.id)).filter((c): c is IssueConflict => Boolean(c))
    : [];
  if (conflicting.length === 0 || typeof window === "undefined") return true;
  const laneNames = [...new Set(conflicting.map((c) => c.laneName).filter((n): n is string => Boolean(n)))];
  const target = laneNames.length === 1
    ? `“${laneNames[0]}”`
    : laneNames.length > 1
      ? `${laneNames.length} lanes`
      : "another lane";
  const subject = conflicting.length === 1
    ? "This issue is already attached to"
    : `${conflicting.length} of these issues are already attached to`;
  return confirmDialog({
    title: `${subject} ${target}.`,
    message: `You can attach ${conflicting.length === 1 ? "it" : "them"} again — proceed?`,
    confirmLabel: "Proceed",
    tone: "warning",
  });
}

/**
 * The bar above the list while issues are checked (count, Clear) or, in the
 * Ready view, the "Launch all ready" action.
 */
export function LinearSelectionBar({
  checkedCount,
  allVisibleChecked,
  onSelectAll,
  onClear,
  countLabel,
  readyCount,
  onLaunchReady,
}: {
  checkedCount: number;
  allVisibleChecked: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  /** "12 issues" (or "40 loaded") when nothing is checked. */
  countLabel: string;
  readyCount: number;
  onLaunchReady: () => void;
}) {
  const allChecked = checkedCount > 0 && allVisibleChecked;
  return (
    <div className="flex h-9 shrink-0 items-center gap-2.5 border-b border-fg/[0.06] bg-fg/[0.015] pl-[13px] pr-3">
      <span
        role="checkbox"
        tabIndex={0}
        aria-checked={checkedCount === 0 ? false : allChecked ? true : "mixed"}
        aria-label="Select all issues"
        onClick={onSelectAll}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onSelectAll(); } }}
        className={cn(
          "flex h-[14px] w-[14px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] border transition-colors",
          allChecked
            ? "border-accent bg-accent"
            : checkedCount > 0
              ? "border-accent bg-accent/50"
              : "border-fg/25 bg-transparent hover:border-fg/45",
        )}
      >
        {allChecked ? (
          <Check size={10} weight="bold" className="text-accent-fg" />
        ) : checkedCount > 0 ? (
          <Minus size={10} weight="bold" className="text-accent-fg" />
        ) : null}
      </span>
      <span className="text-[12.5px] tabular-nums text-fg/80">
        {checkedCount > 0 ? `${checkedCount} selected` : countLabel}
      </span>
      {checkedCount > 0 ? (
        <>
          <span className="hidden text-[11.5px] text-muted-fg/60 lg:inline" aria-hidden>
            Enter launches · Esc clears
          </span>
          <button
            type="button"
            className="ml-auto text-[12px] text-muted-fg transition-colors hover:text-fg"
            onClick={onClear}
          >
            Clear
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md bg-accent/15 px-2.5 text-[12px] font-medium text-accent-text transition-colors hover:bg-accent/25"
          title="Launch a lane and an agent for every ready issue that has no lane yet"
          onClick={onLaunchReady}
        >
          <RocketLaunch size={12} weight="fill" />
          Launch all ready ({readyCount})
        </button>
      )}
    </div>
  );
}
