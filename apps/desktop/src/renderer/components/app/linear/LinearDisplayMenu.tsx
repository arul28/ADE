import { BRAND } from "../../../../shared/brand";
import React from "react";
import { ArrowDown, ArrowUp, Rows, SortAscending } from "@phosphor-icons/react";
import type {
  LinearDisplayPreferences,
  LinearIssueDisplayFields,
  LinearIssueGrouping,
  LinearIssueOrdering,
} from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { LinearMenuSelect, LinearSwitch, type LinearMenuOption } from "./LinearPopover";
import { LINEAR_ORDERING_NATURAL_DIRECTION, type LinearDisplayPatch } from "../../../../shared/linearDisplayPreferences";

const GROUPING_OPTIONS: ReadonlyArray<LinearMenuOption<LinearIssueGrouping>> = [
  { value: "workflowState", label: "Status" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
  { value: "projectMilestone", label: "Milestone" },
  { value: "priority", label: "Priority" },
  { value: "cycle", label: "Cycle" },
  { value: "label", label: "Label" },
  { value: "team", label: "Team" },
  { value: "none", label: "No grouping" },
];

const ORDERING_OPTIONS: ReadonlyArray<LinearMenuOption<LinearIssueOrdering>> = [
  { value: "manual", label: "Manual" },
  { value: "priority", label: "Priority" },
  { value: "updatedAt", label: "Last updated" },
  { value: "createdAt", label: "Created" },
  { value: "dueDate", label: "Due date" },
  { value: "estimate", label: "Estimate" },
  { value: "title", label: "Title" },
];

const FIELD_OPTIONS: ReadonlyArray<{ key: keyof LinearIssueDisplayFields; label: string }> = [
  { key: "id", label: "ID" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "labels", label: "Labels" },
  { key: "project", label: "Project" },
  { key: "milestone", label: "Milestone" },
  { key: "cycle", label: "Cycle" },
  { key: "estimate", label: "Estimate" },
  { key: "dueDate", label: "Due date" },
  { key: "pullRequests", label: "Pull requests" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" },
  { key: "adeStatus", label: `${BRAND.NAME} status` },
];


function directionLabel(ordering: LinearIssueOrdering, direction: "asc" | "desc"): string {
  switch (ordering) {
    case "priority":
      return direction === "desc" ? "Urgent first" : "Low first";
    case "title":
      return direction === "asc" ? "A to Z" : "Z to A";
    case "dueDate":
      return direction === "asc" ? "Soonest first" : "Latest first";
    case "estimate":
      return direction === "desc" ? "Largest first" : "Smallest first";
    default:
      return direction === "desc" ? "Newest first" : "Oldest first";
  }
}

export function LinearDisplayMenu({
  prefs,
  onChange,
  savedToLinear,
  reason,
}: {
  prefs: LinearDisplayPreferences;
  onChange: (patch: LinearDisplayPatch) => void;
  savedToLinear: boolean | null;
  reason: string | null;
}) {
  const subOptions = GROUPING_OPTIONS.filter((option) => option.value !== prefs.grouping);
  const manual = prefs.ordering === "manual";
  const nested = prefs.nesting !== "none";

  return (
    <div className="py-1.5">
      <div className="space-y-1.5 px-3 py-1.5">
        <Row icon={<Rows size={13} />} label="Grouping">
          <LinearMenuSelect
            label="Grouping"
            value={prefs.grouping}
            options={GROUPING_OPTIONS}
            className="w-[148px]"
            onChange={(grouping) => onChange(grouping === prefs.subGrouping ? { grouping, subGrouping: "none" } : { grouping })}
          />
        </Row>
        {prefs.grouping !== "none" ? (
          <Row icon={<Rows size={13} className="opacity-60" />} label="Sub-grouping">
            <LinearMenuSelect
              label="Sub-grouping"
              value={subOptions.some((option) => option.value === prefs.subGrouping) ? prefs.subGrouping : "none"}
              options={subOptions}
              className="w-[148px]"
              onChange={(subGrouping) => onChange({ subGrouping })}
            />
          </Row>
        ) : null}
        <Row icon={<SortAscending size={13} />} label="Ordering">
          <div className="flex w-[148px] items-center gap-1">
            <LinearMenuSelect
              label="Ordering"
              value={prefs.ordering}
              options={ORDERING_OPTIONS}
              className="min-w-0 flex-1"
              onChange={(ordering) => onChange({ ordering, orderingDirection: LINEAR_ORDERING_NATURAL_DIRECTION[ordering] })}
            />
            <button
              type="button"
              disabled={manual}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-fg/[0.09] bg-fg/[0.03] text-fg/80 outline-none transition-colors hover:bg-fg/[0.06] focus-visible:border-fg/25 disabled:opacity-35"
              title={manual ? "Manual order follows Linear" : directionLabel(prefs.ordering, prefs.orderingDirection)}
              aria-label={manual ? "Order direction (not used for manual order)" : `Order: ${directionLabel(prefs.ordering, prefs.orderingDirection)}`}
              onClick={() => onChange({ orderingDirection: prefs.orderingDirection === "asc" ? "desc" : "asc" })}
            >
              {prefs.orderingDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            </button>
          </div>
        </Row>
      </div>

      <div className="mx-3 my-1.5 h-px bg-fg/[0.07]" />

      <div className="px-1.5">
        <LinearSwitch
          label="Show sub-issues"
          checked={nested}
          onChange={(next) => onChange({ nesting: next ? "showAll" : "none" })}
        />
        <LinearSwitch
          label="Show empty groups"
          checked={prefs.showEmptyGroups}
          onChange={(showEmptyGroups) => onChange({ showEmptyGroups })}
        />
        <LinearSwitch
          label="Show completed issues"
          checked={prefs.showCompletedIssues}
          onChange={(showCompletedIssues) => onChange({ showCompletedIssues })}
        />
        {prefs.hiddenGroups.length > 0 ? (
          <div className="flex h-8 items-center justify-between gap-3 px-2 text-[12.5px] text-fg/85">
            <span>{prefs.hiddenGroups.length === 1 ? "1 hidden group" : `${prefs.hiddenGroups.length} hidden groups`}</span>
            <button
              type="button"
              className="rounded-md px-1.5 py-0.5 text-[12px] text-muted-fg outline-none transition-colors hover:bg-fg/[0.05] hover:text-fg focus-visible:bg-fg/[0.06]"
              onClick={() => onChange({ hiddenGroups: [] })}
            >
              Show all
            </button>
          </div>
        ) : null}
      </div>

      <div className="mx-3 my-1.5 h-px bg-fg/[0.07]" />

      <div className="px-3 pb-1.5 pt-1">
        <div className="mb-2 text-[12px] text-muted-fg">Display properties</div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Display properties">
          {FIELD_OPTIONS.map((field) => {
            const on = prefs.fields[field.key];
            return (
              <button
                key={field.key}
                type="button"
                aria-pressed={on}
                className={cn(
                  "h-[24px] rounded-md border px-2 text-[12px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/30",
                  on
                    ? "border-fg/[0.14] bg-fg/[0.09] text-fg"
                    : "border-fg/[0.07] text-muted-fg/80 hover:bg-fg/[0.04] hover:text-fg/85",
                )}
                onClick={() => onChange({ fields: { [field.key]: !on } })}
              >
                {field.label}
              </button>
            );
          })}
        </div>
      </div>

      {savedToLinear === false ? (
        <>
          <div className="mx-3 my-1.5 h-px bg-fg/[0.07]" />
          <div className="px-3 pb-1 pt-0.5 text-[11.5px] leading-snug" role="status" title={reason ?? undefined}>
            <div className="text-fg/75">Saved in {BRAND.NAME} only</div>
            <div className="line-clamp-2 text-muted-fg/70">{reason || `Linear didn't take the change, so ${BRAND.NAME} saved it for this project.`}</div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-[12.5px] text-fg/80">
        <span className="text-muted-fg">{icon}</span>
        {label}
      </span>
      {children}
    </div>
  );
}
