import React, { useMemo, useRef, useState } from "react";
import { Plus, Tag } from "@phosphor-icons/react";
import type { CtoGetLinearIssuePickerDataResult } from "../../../shared/types";
import { cn } from "../ui/cn";
import { LinearPriorityIcon, LinearStateIcon } from "../lanes/linearBrand";
import { LinearAssigneeAvatar } from "./LinearIssueBrowserRows";
import { PickerMenu, type PickerOption } from "../issues/IssuePickerMenu";
import {
  PRIORITY_CHOICES,
  issueLabelEntries,
  labelsForIssueTeam,
  stateGroupRank,
  type BrowserIssue,
  type LinearIssueEdit,
} from "./linearIssueBrowserModel";

export type LinearIssuePropertyLayout = "bar" | "rows";

function PropertyChip({
  label,
  value,
  disabled,
  pending,
  onClick,
  anchorRef,
  layout,
  children,
}: {
  label: string;
  value: string;
  disabled: boolean;
  pending?: boolean;
  onClick: () => void;
  anchorRef: React.RefObject<HTMLButtonElement>;
  layout: LinearIssuePropertyLayout;
  children: React.ReactNode;
}) {
  const chip = (
    <button
      ref={anchorRef}
      type="button"
      aria-label={`${label}: ${value}`}
      title={disabled ? `${label}: ${value}` : `Change ${label.toLowerCase()}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-[11.5px] text-fg/85 transition-colors",
        layout === "bar"
          ? "border border-fg/[0.07] bg-fg/[0.02]"
          : "-ml-2 w-[calc(100%+8px)] justify-start border border-transparent",
        disabled
          ? "cursor-default"
          : layout === "bar"
            ? "hover:border-fg/[0.14] hover:bg-fg/[0.05]"
            : "hover:bg-[color:var(--kit-hover)]",
        pending && "opacity-70",
      )}
    >
      {children}
    </button>
  );
  if (layout === "bar") return chip;
  // A labeled row of the issue viewer's property sidebar: the label names the
  // field, the chip is the value and the picker trigger.
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] text-[color:var(--kit-text-3)]">{label}</span>
      <div className="min-w-0">{chip}</div>
    </div>
  );
}

/**
 * Status, priority, assignee, and labels as inline pickers. Each pick is one
 * edit handed to `onEdit`; the host applies it optimistically and rolls it
 * back if Linear rejects it. Without `onEdit` the chips are read-only.
 */
export function LinearIssuePropertyBar({
  issue,
  catalog,
  onEdit,
  pending,
  layout = "bar",
}: {
  issue: BrowserIssue;
  catalog: CtoGetLinearIssuePickerDataResult;
  onEdit?: (edit: LinearIssueEdit) => void;
  pending?: boolean;
  /** `bar` is a wrapping row of chips; `rows` is one labeled row per field. */
  layout?: LinearIssuePropertyLayout;
}) {
  const [openPicker, setOpenPicker] = useState<"status" | "priority" | "assignee" | "labels" | null>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const assigneeRef = useRef<HTMLButtonElement>(null);
  const labelsRef = useRef<HTMLButtonElement>(null);
  const editable = Boolean(onEdit);
  const close = () => setOpenPicker(null);

  const stateOptions = useMemo<PickerOption[]>(() =>
    catalog.states
      .filter((state) => state.teamId === issue.teamId || state.teamKey === issue.teamKey)
      .sort((left, right) => stateGroupRank(left.type) - stateGroupRank(right.type) || left.name.localeCompare(right.name))
      .map((state) => ({ id: state.id, label: state.name, icon: <LinearStateIcon stateType={state.type} size={12} /> })),
  [catalog.states, issue.teamId, issue.teamKey]);

  const priorityOptions = useMemo<PickerOption[]>(() =>
    PRIORITY_CHOICES.map((choice) => ({
      id: String(choice.value),
      label: choice.label,
      icon: <LinearPriorityIcon priority={choice.value} size={12} />,
    })),
  []);

  const assigneeOptions = useMemo<PickerOption[]>(() => [
    { id: "", label: "Unassigned", icon: <LinearAssigneeAvatar name={null} size={14} /> },
    ...catalog.users.map((user) => ({
      id: user.id,
      label: user.displayName ?? user.name,
      keywords: `${user.name} ${user.email ?? ""}`,
      icon: <LinearAssigneeAvatar name={user.displayName ?? user.name} avatarUrl={user.avatarUrl ?? null} size={14} />,
    })),
  ], [catalog.users]);

  const currentLabels = useMemo(() => issueLabelEntries(issue, catalog.labels), [catalog.labels, issue]);
  const labelOptions = useMemo<PickerOption[]>(() =>
    labelsForIssueTeam(catalog.labels, issue).map((label) => ({
      id: label.id,
      label: label.name,
      icon: <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "rgba(255,255,255,0.4)" }} />,
    })),
  [catalog.labels, issue]);
  const currentLabelIds = useMemo(
    () => new Set(currentLabels.map((label) => label.id).filter((id): id is string => Boolean(id))),
    [currentLabels],
  );

  const pick = (edit: LinearIssueEdit) => {
    onEdit?.(edit);
  };

  const priorityText = PRIORITY_CHOICES.find((choice) => choice.value === issue.priority)?.label ?? "No priority";
  const avatarUrl = "raw" in issue ? issue.assigneeAvatarUrl ?? null : null;

  return (
    <div
      className={layout === "bar" ? "flex flex-wrap items-center gap-1.5" : "flex flex-col gap-0.5"}
      data-linear-property-bar="true"
    >
      <PropertyChip layout={layout} label="Status" value={issue.stateName} disabled={!editable || stateOptions.length === 0} pending={pending} anchorRef={statusRef} onClick={() => setOpenPicker("status")}>
        <LinearStateIcon stateType={issue.stateType} size={12} />
        <span className="truncate">{issue.stateName}</span>
      </PropertyChip>
      <PropertyChip layout={layout} label="Priority" value={priorityText} disabled={!editable} pending={pending} anchorRef={priorityRef} onClick={() => setOpenPicker("priority")}>
        <LinearPriorityIcon priority={issue.priority} size={12} />
        <span className="truncate">{priorityText}</span>
      </PropertyChip>
      <PropertyChip layout={layout} label="Assignee" value={issue.assigneeName ?? "Unassigned"} disabled={!editable} pending={pending} anchorRef={assigneeRef} onClick={() => setOpenPicker("assignee")}>
        <LinearAssigneeAvatar name={issue.assigneeName} avatarUrl={avatarUrl} size={14} />
        <span className="truncate">{issue.assigneeName ?? "Unassigned"}</span>
      </PropertyChip>
      <PropertyChip layout={layout} label="Labels" value={currentLabels.map((label) => label.name).join(", ") || "None"} disabled={!editable || labelOptions.length === 0} pending={pending} anchorRef={labelsRef} onClick={() => setOpenPicker("labels")}>
        {currentLabels.length === 0 ? (
          <>
            {editable ? <Plus size={11} /> : <Tag size={11} />}
            <span className="text-muted-fg/60">Labels</span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-0.5">
              {currentLabels.slice(0, 3).map((label) => (
                <span key={label.name} className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "rgba(255,255,255,0.4)" }} />
              ))}
            </span>
            <span className="truncate">
              {currentLabels.length === 1 ? currentLabels[0]!.name : `${currentLabels.length} labels`}
            </span>
          </>
        )}
      </PropertyChip>

      <PickerMenu
        open={openPicker === "status"}
        anchorRef={statusRef}
        onClose={close}
        options={stateOptions}
        selectedIds={new Set([issue.stateId])}
        placeholder="Change status…"
        onPick={(id) => {
          close();
          if (id !== issue.stateId) pick({ stateId: id });
        }}
      />
      <PickerMenu
        open={openPicker === "priority"}
        anchorRef={priorityRef}
        onClose={close}
        options={priorityOptions}
        selectedIds={new Set([String(issue.priority)])}
        placeholder="Set priority…"
        onPick={(id) => {
          close();
          const priority = Number(id);
          if (priority !== issue.priority) pick({ priority });
        }}
      />
      <PickerMenu
        open={openPicker === "assignee"}
        anchorRef={assigneeRef}
        onClose={close}
        options={assigneeOptions}
        selectedIds={new Set([issue.assigneeId ?? ""])}
        placeholder="Assign to…"
        onPick={(id) => {
          close();
          const assigneeId = id || null;
          if (assigneeId !== (issue.assigneeId ?? null)) pick({ assigneeId });
        }}
      />
      <PickerMenu
        open={openPicker === "labels"}
        anchorRef={labelsRef}
        onClose={close}
        options={labelOptions}
        selectedIds={currentLabelIds}
        multi
        placeholder="Add or remove labels…"
        onPick={(id) => {
          // Stays open so several labels can be toggled in a row.
          pick(currentLabelIds.has(id) ? { removedLabelIds: [id] } : { addedLabelIds: [id] });
        }}
      />
    </div>
  );
}
