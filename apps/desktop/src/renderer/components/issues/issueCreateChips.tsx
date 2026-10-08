import React, { useRef, useState } from "react";
import type {
  CtoGetLinearIssuePickerDataResult,
  GitHubIssueTypeOption,
  LinearIssueCreateOptions,
  LinearProjectMilestone,
} from "../../../shared/types";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { PRIORITY_CHOICES } from "../app/linearIssueBrowserModel";
import { LinearPriorityIcon, LinearStateIcon } from "../lanes/linearBrand";
import { cn } from "../ui/cn";
import { PickerMenu, type PickerOption, githubLabelOptions, githubPersonOptions } from "./IssuePickerMenu";
import type { GitHubRepoCatalog } from "./githubIssueStore";
import type { GitHubFields, LinearFields } from "./issueCreateDraft";

/**
 * The create composer's property chips: a chip shows the value and opens the
 * same filterable picker the issue viewer uses. One set per tracker, plus the
 * fields most issues skip, shown under `⋯`.
 */

/* ── Small pieces ──────────────────────────────────────────────────────── */

function Chip({
  label,
  children,
  anchorRef,
  onClick,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  anchorRef?: React.RefObject<HTMLButtonElement>;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      ref={anchorRef}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.02] px-2 text-[11.5px] transition-colors hover:border-fg/[0.16] hover:bg-fg/[0.05]",
        muted ? "text-[color:var(--kit-text-3)]" : "text-fg/85",
      )}
    >
      {children}
    </button>
  );
}

/** A chip that opens a filterable picker. */
export function ChipPicker({
  label,
  display,
  options,
  selected,
  multi,
  placeholder,
  onOpen,
  onPick,
  muted,
}: {
  label: string;
  display: React.ReactNode;
  options: PickerOption[];
  selected: string[];
  multi?: boolean;
  placeholder: string;
  onOpen?: () => void;
  onPick: (id: string) => void;
  muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Chip label={label} anchorRef={ref} muted={muted} onClick={() => { onOpen?.(); setOpen(true); }}>{display}</Chip>
      <PickerMenu
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        options={options}
        selectedIds={new Set(selected)}
        multi={multi}
        placeholder={placeholder}
        onPick={(id) => {
          if (!multi) setOpen(false);
          onPick(id);
        }}
      />
    </>
  );
}

export function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

function estimateScale(options: LinearIssueCreateOptions | null): Array<{ value: number; label: string }> {
  if (!options || options.estimationType === "notUsed") return [];
  const extended = options.estimationExtended;
  let scale: Array<{ value: number; label: string }>;
  switch (options.estimationType) {
    case "exponential":
      scale = [1, 2, 4, 8, 16, ...(extended ? [32, 64] : [])].map((value) => ({ value, label: String(value) }));
      break;
    case "fibonacci":
      scale = [1, 2, 3, 5, 8, ...(extended ? [13, 21] : [])].map((value) => ({ value, label: String(value) }));
      break;
    case "tShirt":
      scale = [["XS", 1], ["S", 2], ["M", 3], ["L", 5], ["XL", 8], ...(extended ? [["XXL", 13], ["XXXL", 21]] : [])]
        .map(([label, value]) => ({ value: value as number, label: label as string }));
      break;
    default:
      scale = [1, 2, 3, 4, 5, ...(extended ? [6, 7] : [])].map((value) => ({ value, label: String(value) }));
  }
  return options.estimationAllowZero ? [{ value: 0, label: "0" }, ...scale] : scale;
}

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export function LinearCreateChips({
  linear,
  setLinear,
  catalog,
  teamKey,
}: {
  linear: LinearFields;
  setLinear: Setter<LinearFields>;
  catalog: CtoGetLinearIssuePickerDataResult | null;
  teamKey: string | null;
}) {
  const linearStates = (catalog?.states ?? []).filter((state) => state.teamKey === teamKey);
  const state = linearStates.find((entry) => entry.id === linear.stateId) ?? null;
  const assignee = catalog?.users.find((user) => user.id === linear.assigneeId) ?? null;
  const teamLabels = (catalog?.labels ?? []).filter((label) => !label.teamKey || label.teamKey === teamKey);
  const pickedLabels = teamLabels.filter((label) => linear.labelIds.includes(label.id));
  const projects = linearTeamProjects(catalog, teamKey);
  const project = projects.find((entry) => entry.id === linear.projectId) ?? null;
  return (
    <>
      <ChipPicker
        label="Status"
        display={state ? <><LinearStateIcon stateType={state.type} size={12} />{state.name}</> : "Default status"}
        muted={!state}
        options={linearStates.map((entry) => ({ id: entry.id, label: entry.name, icon: <LinearStateIcon stateType={entry.type} size={12} /> }))}
        selected={linear.stateId ? [linear.stateId] : []}
        placeholder="Status…"
        onPick={(id) => setLinear((current) => ({ ...current, stateId: id }))}
      />
      <ChipPicker
        label="Priority"
        display={<><LinearPriorityIcon priority={linear.priority ?? 0} size={12} />{PRIORITY_CHOICES.find((choice) => choice.value === (linear.priority ?? 0))?.label ?? "No priority"}</>}
        muted={!linear.priority}
        options={PRIORITY_CHOICES.map((choice) => ({ id: String(choice.value), label: choice.label, icon: <LinearPriorityIcon priority={choice.value} size={12} /> }))}
        selected={[String(linear.priority ?? 0)]}
        placeholder="Priority…"
        onPick={(id) => setLinear((current) => ({ ...current, priority: Number(id) }))}
      />
      <ChipPicker
        label="Assignee"
        display={<><LinearAssigneeAvatar name={assignee ? assignee.displayName ?? assignee.name : null} avatarUrl={assignee?.avatarUrl ?? null} size={14} />{assignee ? assignee.displayName ?? assignee.name : "Assignee"}</>}
        muted={!assignee}
        options={[
          { id: "", label: "Unassigned" },
          ...(catalog?.users ?? []).filter((user) => user.active).map((user) => ({
            id: user.id,
            label: user.displayName ?? user.name,
            keywords: `${user.name} ${user.email ?? ""}`,
            icon: <LinearAssigneeAvatar name={user.displayName ?? user.name} avatarUrl={user.avatarUrl ?? null} size={14} />,
          })),
        ]}
        selected={[linear.assigneeId ?? ""]}
        placeholder="Assign to…"
        onPick={(id) => setLinear((current) => ({ ...current, assigneeId: id || null }))}
      />
      <ChipPicker
        label="Labels"
        display={pickedLabels.length
          ? <><span className="flex gap-0.5">{pickedLabels.slice(0, 3).map((label) => <span key={label.id} className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} />)}</span>{pickedLabels.length === 1 ? pickedLabels[0]!.name : `${pickedLabels.length} labels`}</>
          : "Labels"}
        muted={!pickedLabels.length}
        multi
        options={teamLabels.map((label) => ({ id: label.id, label: label.name, icon: <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} /> }))}
        selected={linear.labelIds}
        placeholder="Labels…"
        onPick={(id) => setLinear((current) => ({ ...current, labelIds: toggle(current.labelIds, id) }))}
      />
      <ChipPicker
        label="Project"
        display={project ? project.name : "Project"}
        muted={!project}
        options={[{ id: "", label: "No project" }, ...projects.map((entry) => ({ id: entry.id, label: entry.name }))]}
        selected={[linear.projectId ?? ""]}
        placeholder="Project…"
        onPick={(id) => setLinear((current) => ({ ...current, projectId: id || null, milestoneId: null }))}
      />
    </>
  );
}

/** Projects the team can file into (a project with no team belongs to all). */
export function linearTeamProjects(catalog: CtoGetLinearIssuePickerDataResult | null, teamKey: string | null) {
  return (catalog?.projects ?? []).filter((project) => !project.teamKey || project.teamKey === teamKey);
}

export function LinearMoreFields({
  linear,
  setLinear,
  hasProject,
  milestones,
  createOptions,
  parentLocked,
}: {
  linear: LinearFields;
  setLinear: Setter<LinearFields>;
  hasProject: boolean;
  milestones: LinearProjectMilestone[];
  createOptions: LinearIssueCreateOptions | null;
  parentLocked: boolean;
}) {
  const cycle = createOptions?.cycles.find((entry) => entry.id === linear.cycleId) ?? null;
  const scale = estimateScale(createOptions);
  return (
    <>
      {hasProject ? (
        <ChipPicker
          label="Milestone"
          display={milestones.find((entry) => entry.id === linear.milestoneId)?.name ?? "Milestone"}
          muted={!linear.milestoneId}
          options={[{ id: "", label: "No milestone" }, ...milestones.map((entry) => ({ id: entry.id, label: entry.name }))]}
          selected={[linear.milestoneId ?? ""]}
          placeholder="Milestone…"
          onPick={(id) => setLinear((current) => ({ ...current, milestoneId: id || null }))}
        />
      ) : null}
      {createOptions?.cyclesEnabled ? (
        <ChipPicker
          label="Cycle"
          display={cycle ? `Cycle ${cycle.number}${cycle.active ? " (current)" : ""}` : "Cycle"}
          muted={!cycle}
          options={[{ id: "", label: "No cycle" }, ...createOptions.cycles.map((entry) => ({
            id: entry.id,
            label: `${entry.name || `Cycle ${entry.number}`}${entry.active ? " (current)" : ""}`,
          }))]}
          selected={[linear.cycleId ?? ""]}
          placeholder="Cycle…"
          onPick={(id) => setLinear((current) => ({ ...current, cycleId: id || null }))}
        />
      ) : null}
      {scale.length ? (
        <ChipPicker
          label="Estimate"
          display={linear.estimate != null ? `Estimate ${scale.find((entry) => entry.value === linear.estimate)?.label ?? linear.estimate}` : "Estimate"}
          muted={linear.estimate == null}
          options={[{ id: "", label: "No estimate" }, ...scale.map((entry) => ({ id: String(entry.value), label: entry.label }))]}
          selected={[linear.estimate == null ? "" : String(linear.estimate)]}
          placeholder="Estimate…"
          onPick={(id) => setLinear((current) => ({ ...current, estimate: id === "" ? null : Number(id) }))}
        />
      ) : null}
      <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.08] px-2 text-[11.5px] text-[color:var(--kit-text-3)]">
        Due
        <input
          type="date"
          aria-label="Due date"
          className="bg-transparent text-fg/85 outline-none [color-scheme:dark]"
          value={linear.dueDate}
          onChange={(event) => setLinear((current) => ({ ...current, dueDate: event.target.value }))}
        />
      </label>
      <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.08] px-2 text-[11.5px] text-[color:var(--kit-text-3)]">
        Parent
        <input
          aria-label="Parent issue"
          placeholder="ADE-123"
          className="w-[84px] bg-transparent font-mono text-fg/85 outline-none placeholder:text-[color:var(--kit-text-3)]"
          value={linear.parent}
          disabled={parentLocked}
          onChange={(event) => setLinear((current) => ({ ...current, parent: event.target.value.toUpperCase() }))}
        />
      </label>
    </>
  );
}

export function GitHubCreateChips({
  github,
  setGitHub,
  repoCatalog,
  types,
}: {
  github: GitHubFields;
  setGitHub: Setter<GitHubFields>;
  repoCatalog: GitHubRepoCatalog | null;
  types: GitHubIssueTypeOption[];
}) {
  const ghMilestones = repoCatalog?.milestones ?? [];
  return (
    <>
      <ChipPicker
        label="Labels"
        display={github.labels.length ? (github.labels.length === 1 ? github.labels[0]! : `${github.labels.length} labels`) : "Labels"}
        muted={!github.labels.length}
        multi
        options={githubLabelOptions(repoCatalog?.labels ?? [])}
        selected={github.labels}
        placeholder={repoCatalog ? "Labels…" : "Loading labels…"}
        onPick={(id) => setGitHub((current) => ({ ...current, labels: toggle(current.labels, id) }))}
      />
      <ChipPicker
        label="Assignees"
        display={github.assignees.length ? (github.assignees.length === 1 ? github.assignees[0]! : `${github.assignees.length} people`) : "Assignees"}
        muted={!github.assignees.length}
        multi
        options={githubPersonOptions(repoCatalog?.people ?? [])}
        selected={github.assignees}
        placeholder={repoCatalog ? "Assign people…" : "Loading people…"}
        onPick={(id) => setGitHub((current) => ({ ...current, assignees: toggle(current.assignees, id) }))}
      />
      {ghMilestones.length ? (
        <ChipPicker
          label="Milestone"
          display={ghMilestones.find((entry) => entry.number === github.milestone)?.title ?? "Milestone"}
          muted={github.milestone == null}
          options={[{ id: "", label: "No milestone" }, ...ghMilestones.map((entry) => ({ id: String(entry.number), label: entry.title }))]}
          selected={[github.milestone == null ? "" : String(github.milestone)]}
          placeholder="Milestone…"
          onPick={(id) => setGitHub((current) => ({ ...current, milestone: id ? Number(id) : null }))}
        />
      ) : null}
      {types.length ? (
        <ChipPicker
          label="Type"
          display={github.type ?? "Type"}
          muted={!github.type}
          options={[{ id: "", label: "No type" }, ...types.map((entry) => ({ id: entry.name, label: entry.name }))]}
          selected={[github.type ?? ""]}
          placeholder="Issue type…"
          onPick={(id) => setGitHub((current) => ({ ...current, type: id || null }))}
        />
      ) : null}
    </>
  );
}

export function GitHubMoreFields({
  github,
  setGitHub,
  parentLocked,
}: {
  github: GitHubFields;
  setGitHub: Setter<GitHubFields>;
  parentLocked: boolean;
}) {
  return (
    <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.08] px-2 text-[11.5px] text-[color:var(--kit-text-3)]">
      Parent
      <input
        aria-label="Parent issue number"
        placeholder="#123"
        className="w-[64px] bg-transparent font-mono text-fg/85 outline-none placeholder:text-[color:var(--kit-text-3)]"
        value={github.parent}
        disabled={parentLocked}
        onChange={(event) => setGitHub((current) => ({ ...current, parent: event.target.value }))}
      />
    </label>
  );
}
