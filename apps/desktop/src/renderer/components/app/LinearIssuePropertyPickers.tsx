import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Tag } from "@phosphor-icons/react";
import type { CtoGetLinearIssuePickerDataResult } from "../../../shared/types";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { LinearPriorityIcon, LinearStateIcon } from "../lanes/linearBrand";
import { LinearAssigneeAvatar } from "./LinearIssueBrowserRows";
import {
  PRIORITY_CHOICES,
  issueLabelEntries,
  labelsForIssueTeam,
  stateGroupRank,
  type BrowserIssue,
  type LinearIssueEdit,
} from "./linearIssueBrowserModel";

type PickerOption = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  keywords?: string;
};

const MAX_VISIBLE_OPTIONS = 120;

/**
 * A filterable option list in an `AnchoredMenu`. Escape closes the menu only:
 * a window capture listener stops the key before the host dialog's own
 * Escape handler (Radix listens on the document in capture) can close the pane.
 */
function PickerMenu({
  open,
  anchorRef,
  onClose,
  options,
  selectedIds,
  multi = false,
  placeholder,
  onPick,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  options: PickerOption[];
  selectedIds: Set<string>;
  multi?: boolean;
  placeholder: string;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? options.filter((option) => `${option.label} ${option.keywords ?? ""}`.toLowerCase().includes(needle))
      : options;
    return matches.slice(0, MAX_VISIBLE_OPTIONS);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  return (
    <AnchoredMenu
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      zIndex={Z_LAYERS.dialogPopover}
      remeasureKey={filtered.length}
      className={cn(MENU_SURFACE_CLASS, "w-[240px]")}
    >
      <input
        ref={inputRef}
        value={query}
        placeholder={placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((current) => Math.min(filtered.length - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = filtered[highlight];
            if (option) onPick(option.id);
          }
        }}
        className="mb-1 h-7 w-full rounded-[var(--radius-sm)] border border-white/[0.07] bg-black/20 px-2 text-[11.5px] text-fg outline-none placeholder:text-muted-fg/40 focus:border-white/18"
      />
      <div className="max-h-[260px] overflow-y-auto overscroll-contain" role="listbox" aria-multiselectable={multi || undefined}>
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted-fg/50">No matches</div>
        ) : filtered.map((option, index) => {
          const selected = selectedIds.has(option.id);
          return (
            <button
              key={option.id || "__none__"}
              type="button"
              role="option"
              aria-selected={selected}
              data-highlighted={index === highlight ? "" : undefined}
              className={cn(MENU_ITEM_CLASS, "w-full text-left")}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => onPick(option.id)}
            >
              {option.icon ? <span className="grid w-4 shrink-0 place-items-center">{option.icon}</span> : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected ? <Check size={11} weight="bold" className="shrink-0 text-fg/70" /> : null}
            </button>
          );
        })}
      </div>
    </AnchoredMenu>
  );
}

function PropertyChip({
  label,
  value,
  disabled,
  pending,
  onClick,
  anchorRef,
  children,
}: {
  label: string;
  value: string;
  disabled: boolean;
  pending?: boolean;
  onClick: () => void;
  anchorRef: React.RefObject<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={anchorRef}
      type="button"
      aria-label={`${label}: ${value}`}
      title={disabled ? `${label}: ${value}` : `Change ${label.toLowerCase()}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.02] px-2 text-[11.5px] text-fg/85 transition-colors",
        disabled ? "cursor-default" : "hover:border-white/[0.14] hover:bg-white/[0.05]",
        pending && "opacity-70",
      )}
    >
      {children}
    </button>
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
}: {
  issue: BrowserIssue;
  catalog: CtoGetLinearIssuePickerDataResult;
  onEdit?: (edit: LinearIssueEdit) => void;
  pending?: boolean;
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
    <div className="flex flex-wrap items-center gap-1.5" data-linear-property-bar="true">
      <PropertyChip label="Status" value={issue.stateName} disabled={!editable || stateOptions.length === 0} pending={pending} anchorRef={statusRef} onClick={() => setOpenPicker("status")}>
        <LinearStateIcon stateType={issue.stateType} size={12} />
        <span className="truncate">{issue.stateName}</span>
      </PropertyChip>
      <PropertyChip label="Priority" value={priorityText} disabled={!editable} pending={pending} anchorRef={priorityRef} onClick={() => setOpenPicker("priority")}>
        <LinearPriorityIcon priority={issue.priority} size={12} />
        <span className="truncate">{priorityText}</span>
      </PropertyChip>
      <PropertyChip label="Assignee" value={issue.assigneeName ?? "Unassigned"} disabled={!editable} pending={pending} anchorRef={assigneeRef} onClick={() => setOpenPicker("assignee")}>
        <LinearAssigneeAvatar name={issue.assigneeName} avatarUrl={avatarUrl} size={14} />
        <span className="truncate">{issue.assigneeName ?? "Unassigned"}</span>
      </PropertyChip>
      <PropertyChip label="Labels" value={currentLabels.map((label) => label.name).join(", ") || "None"} disabled={!editable || labelOptions.length === 0} pending={pending} anchorRef={labelsRef} onClick={() => setOpenPicker("labels")}>
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
