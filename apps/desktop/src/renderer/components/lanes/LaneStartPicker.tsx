import React from "react";
import { CaretUpDown, GitBranch } from "@phosphor-icons/react";
import {
  LANE_START_FROM_LABEL,
  LANE_START_ON_LABEL,
  type LaneStart,
} from "../../../shared/laneStart";
import type { BranchPullRequest, LaneSummary, NewLaneDefaultsSnapshot } from "../../../shared/types";
import { LaneBranchList } from "./LaneBranchList";
import type { LaneBranchOption } from "./laneUtils";
import { startBranchItems, startFromPickerRef, startPickerRef, startSourceBranch } from "./laneStartOptions";
import { ComposerPopover } from "./createLaneComposerChips";
import "./createLaneComposer.css";

/**
 * Where a new lane starts: the branch menu (Default branch, Primary lane's
 * branch, then every branch with its PR) and the Remote / Local switch.
 * One component for the New lane dialog and Settings → Lanes → New lanes, so
 * the two never show different menus for the same choice.
 */
export function LaneStartBranchField({
  start,
  onChange,
  snapshot,
  branches,
  lanes,
  pullRequests,
  currentUserName,
  loading,
  disabled,
  open,
  onOpenChange,
}: {
  start: LaneStart;
  onChange: (start: LaneStart) => void;
  snapshot: NewLaneDefaultsSnapshot | null;
  branches: LaneBranchOption[];
  lanes: LaneSummary[];
  pullRequests?: BranchPullRequest[];
  currentUserName?: string;
  loading?: boolean;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const items = React.useMemo(() => startBranchItems({ branches, lanes, snapshot }), [branches, lanes, snapshot]);
  const source = startSourceBranch(start, snapshot);
  const primaryMissing = start.from === "primary" && snapshot !== null && !snapshot.primaryBranch;
  const title = start.from === "branch" ? source || "Pick a branch…" : LANE_START_FROM_LABEL[start.from];
  return (
    <ComposerPopover
      open={open}
      mode="new"
      onOpenChange={(next) => onOpenChange(next && !disabled)}
      trigger={(
        <button
          type="button"
          className="cl-field"
          data-mode="new"
          disabled={disabled}
          data-empty={source ? undefined : "true"}
          aria-label="Start from"
          data-tour="lanes.createDialog.branchBase"
        >
          <span className="cl-tile" data-tone="mode"><GitBranch size={13} weight="bold" /></span>
          <span className="cl-field-text">{title}</span>
          {start.from !== "branch" && source ? <span className="cl-tag" data-tone="mode">{source}</span> : null}
          {primaryMissing ? <span className="cl-field-meta">no branch checked out</span> : null}
          <CaretUpDown size={12} className="cl-field-caret" />
        </button>
      )}
    >
      <LaneBranchList
        items={items}
        pullRequests={pullRequests}
        currentUserName={currentUserName}
        selectedRef={startPickerRef(start)}
        loading={loading}
        emptyLabel="No branches found in this repo."
        ariaLabel="Start from"
        onSelect={(ref) => {
          onChange(startFromPickerRef(ref, start.on));
          onOpenChange(false);
        }}
      />
    </ComposerPopover>
  );
}

/** Remote or Local: which copy of the start branch. A local start that copies uncommitted work reads as Local. */
export function LaneStartOnSwitch({
  start,
  onChange,
  disabled,
}: {
  start: LaneStart;
  onChange: (start: LaneStart) => void;
  disabled?: boolean;
}) {
  return (
    <div className="kit-seg cl-on" data-case="sentence" role="radiogroup" aria-label="On">
      {(["remote", "local"] as const).map((on) => {
        const active = start.on === on || (on === "local" && start.on === "uncommitted");
        return (
          <button
            key={on}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange({ ...start, on });
            }}
          >
            {LANE_START_ON_LABEL[on]}
          </button>
        );
      })}
    </div>
  );
}
