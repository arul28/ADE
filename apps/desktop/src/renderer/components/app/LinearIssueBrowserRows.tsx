import React from "react";
import {
  CalendarBlank,
  CaretRight,
  Check,
  LockSimple,
  Plus,
  Robot,
  Stack,
  Triangle,
} from "@phosphor-icons/react";
import type {
  CtoLinearProject,
  CtoLinearQuickViewProject,
  LinearIssueDisplayFields,
} from "../../../shared/types";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import { cn } from "../ui/cn";
import {
  LinearCycleIcon,
  LinearMilestoneIcon,
  LinearPriorityIcon,
  LinearProgressRing,
  LinearStateIcon,
} from "../lanes/linearBrand";
import { LinearProjectIcon } from "../lanes/linearProjectIcon";
import { initialsFor, isNormalizedIssue, type BrowserIssue } from "./linearIssueBrowserModel";
import {
  subIssueProgress,
  type LinearGroupIcon,
  type LinearListContextRow,
  type LinearListGroupRow,
  type LinearListIssueRow,
} from "./linear/linearListModel";
import { LinearIssueAdeStatusCell, type LinearIssueAdeStatus } from "./linear/adeStatus";
import { LinearPrChips } from "./linear/LinearPrChips";

export const ISSUE_ROW_HEIGHT = 40;
export const CONTEXT_ROW_HEIGHT = 40;
export const GROUP_HEADER_HEIGHT = 38;
export const SUBGROUP_HEADER_HEIGHT = 32;

/** Indent per nesting level, and where the tree line sits inside it. */
const TREE_INDENT = 22;
const STATE_ICON = 14;

const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

/** Linear's list date: "Nov 26" this year, "Nov 2024" before. */
export function formatLinearListDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.getFullYear() === new Date().getFullYear() ? MONTH_DAY.format(date) : MONTH_YEAR.format(date);
}

function dueTone(value: string): "overdue" | "soon" | null {
  const due = Date.parse(value);
  if (!Number.isFinite(due)) return null;
  const days = (due - Date.now()) / 86_400_000;
  if (days < -1) return "overdue";
  if (days < 2) return "soon";
  return null;
}

export function LinearAssigneeAvatar({
  name,
  avatarUrl,
  size = 16,
  className,
}: {
  name: string | null | undefined;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const dimension = { width: size, height: size };
  if (!name) {
    return (
      <span
        className={cn("block shrink-0 rounded-full border border-dashed border-fg/30", className)}
        style={dimension}
        title="Unassigned"
        aria-label="Unassigned"
      />
    );
  }
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        title={name}
        onError={() => setFailed(true)}
        className={cn("block shrink-0 rounded-full object-cover", className)}
        style={dimension}
      />
    );
  }
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full bg-fg/[0.12] font-medium text-fg/75", className)}
      style={{ ...dimension, fontSize: Math.max(7, Math.round(size * 0.42)) }}
      title={name}
      aria-label={name}
    >
      {initialsFor(name)}
    </span>
  );
}

/**
 * Low-key chip for an issue that already has a lane or an agent in ADE.
 * Accent-tinted rather than red: launching again is allowed, this is a
 * heads-up. The lane name rides in the tooltip so the row stays compact.
 */
export function LinearConflictBadge({ conflict }: { conflict: IssueConflict }) {
  const isLane = conflict.reason === "lane";
  const label = isLane ? "Lane" : "Agent";
  const tooltip = conflict.laneName
    ? `Already attached to “${conflict.laneName}”`
    : isLane ? "Already has a lane" : "Already has an agent";
  return (
    <span
      className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 text-[11px] font-medium leading-none text-accent-text"
      title={tooltip}
    >
      {isLane ? <Stack size={11} weight="bold" /> : <Robot size={11} weight="bold" />}
      {label}
    </span>
  );
}

export function ScopeNavButton({
  active,
  icon,
  title,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  count: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/25",
        active ? "bg-fg/[0.07] text-fg" : "text-fg/70 hover:bg-fg/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={title}
      aria-current={active ? "page" : undefined}
    >
      <span className="grid w-4 shrink-0 place-items-center text-muted-fg">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      {count ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted-fg/70">{count}</span> : null}
    </button>
  );
}

export function ProjectFilterButton({
  project,
  active,
  count,
  onClick,
}: {
  project: CtoLinearProject & { quick: CtoLinearQuickViewProject | null };
  active: boolean;
  count: string | null;
  onClick: () => void;
}) {
  const quick = project.quick;
  return (
    <button
      type="button"
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/25",
        active ? "bg-fg/[0.07] text-fg" : "text-fg/70 hover:bg-fg/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={project.name}
      aria-current={active ? "page" : undefined}
    >
      <LinearProjectIcon
        icon={project.icon ?? quick?.icon}
        color={project.color ?? quick?.color}
        name={project.name}
        size={16}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
      {count ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted-fg/70">{count}</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Group headers                                                       */
/* ------------------------------------------------------------------ */

export function LinearGroupIconView({ icon, size = 14 }: { icon: LinearGroupIcon; size?: number }) {
  switch (icon.kind) {
    case "state":
      return <LinearStateIcon stateType={icon.stateType} size={size} />;
    case "priority":
      return <span className="text-fg/75"><LinearPriorityIcon priority={icon.priority} size={size} /></span>;
    case "user":
      return <LinearAssigneeAvatar name={icon.name} avatarUrl={icon.avatarUrl} size={size + 2} />;
    case "no-user":
      return <LinearAssigneeAvatar name={null} size={size + 2} />;
    case "project":
      return <LinearProjectIcon icon={icon.icon} color={icon.color} name={icon.name} size={size + 2} />;
    case "label":
      return (
        <span className="grid place-items-center" style={{ width: size, height: size }}>
          <span className="block h-[9px] w-[9px] rounded-full" style={{ background: icon.color ?? "var(--color-muted-fg)" }} />
        </span>
      );
    case "cycle":
      return <span className="text-muted-fg"><LinearCycleIcon size={size} /></span>;
    case "milestone":
      return <span className="text-muted-fg"><LinearMilestoneIcon size={size} /></span>;
    case "team":
      return (
        <span
          className="grid place-items-center rounded-[4px] text-[8.5px] font-semibold text-white"
          style={{ width: size + 2, height: size + 2, background: icon.color ?? "#5E6AD2" }}
        >
          {icon.key.charAt(0)}
        </span>
      );
    default:
      return <span className="block rounded-full border border-dashed border-fg/30" style={{ width: size, height: size }} />;
  }
}

export function LinearGroupHeader({
  row,
  countLabel,
  onToggle,
  onCreate,
}: {
  row: LinearListGroupRow;
  countLabel: string | null;
  onToggle: () => void;
  onCreate?: () => void;
}) {
  const sub = row.depth === 1;
  return (
    <div
      className={cn(
        "group/header flex h-full w-full items-center",
        sub
          ? "border-b border-fg/[0.04] bg-[color:var(--ade-shell-surface,#121019)] pl-[34px] pr-3"
          : "border-b border-fg/[0.05] bg-[color:color-mix(in_srgb,var(--ade-shell-surface,#121019)_95%,var(--color-fg)_5%)] pl-3 pr-2",
      )}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
        aria-expanded={!row.collapsed}
        data-linear-group-header={row.path}
        onClick={onToggle}
      >
        <CaretRight
          size={10}
          weight="fill"
          className={cn(
            "shrink-0 text-muted-fg/60 transition-transform duration-150",
            !row.collapsed && "rotate-90",
            !row.collapsed && "opacity-0 group-hover/header:opacity-100",
          )}
        />
        <span className="-ml-0.5 grid shrink-0 place-items-center">
          <LinearGroupIconView icon={row.group.icon} size={sub ? 13 : 14} />
        </span>
        <span className={cn("min-w-0 truncate", sub ? "text-[12.5px] text-fg/80" : "text-[13px] font-medium text-fg/90")}>
          {row.group.label}
        </span>
        <span className="shrink-0 text-[12.5px] tabular-nums text-muted-fg/70">{countLabel ?? "…"}</span>
      </button>
      {onCreate ? (
        <button
          type="button"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-fg/60 opacity-0 outline-none transition-[opacity,background-color,color] hover:bg-fg/[0.06] hover:text-fg focus-visible:opacity-100 group-hover/header:opacity-100"
          title={`New issue in ${row.group.label}`}
          aria-label={`New issue in ${row.group.label}`}
          onClick={onCreate}
        >
          <Plus size={13} />
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Issue rows                                                          */
/* ------------------------------------------------------------------ */

/** What the row shows, after the Display toggles and the width allowance. */
export type LinearRowLayout = {
  fields: LinearIssueDisplayFields;
  identifierChars: number;
  showCheckbox: boolean;
  /** Several labels fold into one "N labels" chip. */
  compactLabels: boolean;
  /** Project icon and color by id, for the project chip. */
  projectLook: (projectId: string) => { icon: string | null; color: string | null } | null;
};

function TreeLines({ depth, guides, last, hasOpenChildren }: { depth: number; guides: boolean[]; last: boolean; hasOpenChildren: boolean }) {
  if (depth === 0 && !hasOpenChildren) return null;
  const width = depth * TREE_INDENT + STATE_ICON;
  const mid = ISSUE_ROW_HEIGHT / 2;
  const lineX = (level: number) => (level - 1) * TREE_INDENT + STATE_ICON / 2 + 0.5;
  const parts: string[] = [];
  for (let level = 1; level < depth; level += 1) {
    if (guides[level - 1]) parts.push(`M ${lineX(level)} 0 V ${ISSUE_ROW_HEIGHT}`);
  }
  if (depth > 0) {
    const x = lineX(depth);
    const end = depth * TREE_INDENT - 3;
    parts.push(`M ${x} 0 V ${mid - 5} Q ${x} ${mid} ${x + 5} ${mid} H ${end}`);
    if (!last) parts.push(`M ${x} ${mid - 5} V ${ISSUE_ROW_HEIGHT}`);
  }
  if (hasOpenChildren) {
    const x = depth * TREE_INDENT + STATE_ICON / 2 + 0.5;
    parts.push(`M ${x} ${mid + STATE_ICON / 2 + 3} V ${ISSUE_ROW_HEIGHT}`);
  }
  return (
    <svg
      className="pointer-events-none absolute top-0 text-fg/[0.16]"
      style={{ left: 0 }}
      width={width}
      height={ISSUE_ROW_HEIGHT}
      aria-hidden="true"
    >
      <path d={parts.join(" ")} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}

function LabelChips({ issue, compact, max = 2 }: { issue: BrowserIssue; compact: boolean; max?: number }) {
  const labels = isNormalizedIssue(issue) && issue.labelColors
    ? issue.labelColors
    : issue.labels.map((name) => ({ name, color: null as string | null }));
  if (labels.length === 0) return null;
  if (compact && labels.length > 1) {
    // Tight rows: one chip with the label colors stacked, like Linear's "3 labels".
    return (
      <span
        className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-fg/[0.09] px-2 text-[11.5px] text-fg/70"
        title={labels.map((label) => label.name).join(", ")}
      >
        <span className="flex items-center">
          {labels.slice(0, 3).map((label, index) => (
            <span
              key={label.name}
              className={cn("block h-2 w-2 rounded-full ring-[1.5px] ring-[color:var(--ade-shell-surface,#121019)]", index > 0 && "-ml-[3px]")}
              style={{ background: label.color ?? "var(--color-muted-fg)" }}
            />
          ))}
        </span>
        {labels.length} labels
      </span>
    );
  }
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span data-shrink className="flex min-w-0 items-center gap-1 overflow-hidden" title={labels.map((label) => label.name).join(", ")}>
      {shown.map((label) => (
        <span
          key={label.name}
          className="inline-flex h-[22px] min-w-0 max-w-[132px] shrink items-center gap-1.5 rounded-full border border-fg/[0.09] px-2 text-[11.5px] text-fg/70"
        >
          <span className="block h-2 w-2 shrink-0 rounded-full" style={{ background: label.color ?? "var(--color-muted-fg)" }} />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {rest > 0 ? (
        <span className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-fg/[0.09] px-1.5 text-[11.5px] tabular-nums text-muted-fg">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

function PropertyChip({ icon, children, title, className }: { icon?: React.ReactNode; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[22px] min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-fg/[0.09] px-2 text-[11.5px] text-fg/70", className)}
      title={title}
    >
      {icon ? <span className="grid shrink-0 place-items-center">{icon}</span> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

function hasAdeActivity(status: LinearIssueAdeStatus | null): boolean {
  return Boolean(status && (status.lanes.length > 0 || status.runningChats > 0 || status.needsInput || status.prs.length > 0));
}

export const LinearBrowserIssueRow = React.memo(function LinearBrowserIssueRow({
  row,
  layout,
  active,
  eyebrow,
  busy,
  checked,
  anyChecked: anyRowChecked,
  conflict,
  adeStatus,
  onToggleCheck,
  onToggleChildren,
  onSelect,
}: {
  row: LinearListIssueRow;
  layout: LinearRowLayout;
  active: boolean;
  eyebrow?: string;
  busy?: boolean;
  checked: boolean;
  anyChecked: boolean;
  conflict?: IssueConflict | null;
  adeStatus: LinearIssueAdeStatus | null;
  onToggleCheck: (issueId: string, event: React.MouseEvent) => void;
  onToggleChildren: (issueId: string) => void;
  onSelect: (issueId: string, rowKey: string) => void;
}) {
  const { issue, depth } = row;
  const { fields } = layout;
  const normalized = isNormalizedIssue(issue) ? issue : null;
  const progress = subIssueProgress(issue);
  const hasOpenChildren = row.childCount > 0 && !row.childrenCollapsed;
  const treeWidth = depth > 0 || hasOpenChildren ? depth * TREE_INDENT : 0;
  const createdLabel = fields.createdAt ? formatLinearListDate(issue.createdAt) : "";
  const updatedLabel = fields.updatedAt ? formatLinearListDate(issue.updatedAt) : "";
  const due = fields.dueDate && issue.dueDate ? issue.dueDate : null;
  const tone = due ? dueTone(due) : null;
  const delegateName = normalized?.delegateName ?? null;
  const showAde = fields.adeStatus && hasAdeActivity(adeStatus);
  const openBlockers = normalized?.hasOpenBlockers
    ? (normalized.blockedByIssues ?? []).filter((blocker) => blocker.stateType !== "completed" && blocker.stateType !== "canceled")
    : [];

  // The row is a `div role="button"` rather than a real <button> so the
  // checkbox can be a sibling interactive control (no nested buttons).
  return (
    <div
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy || undefined}
      aria-pressed={active}
      aria-level={depth + 1}
      data-linear-issue-row={issue.id}
      data-linear-row-key={row.key}
      className={cn(
        "group/row relative flex h-full w-full items-center pl-1 pr-3 text-left outline-none",
        "focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]",
        busy && "pointer-events-none opacity-50",
        checked ? "bg-accent/[0.08]" : active ? "bg-fg/[0.055]" : "hover:bg-fg/[0.03]",
      )}
      onClick={() => { if (!busy) onSelect(issue.id, row.key); }}
      onKeyDown={(event) => {
        if (busy) return;
        // Space selects. Enter selects a row that is not selected yet; on the
        // selected row it falls through to the browser's primary action.
        if (event.key === " " || (event.key === "Enter" && !active)) {
          event.preventDefault();
          onSelect(issue.id, row.key);
        }
      }}
    >
      {/* A 28px gutter: the checkbox shows on hover, focus, or once anything is checked. */}
      {layout.showCheckbox ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? `Deselect ${issue.identifier}` : `Select ${issue.identifier}`}
          onClick={(event) => { event.stopPropagation(); onToggleCheck(issue.id, event); }}
          className={cn(
            "grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md outline-none transition-opacity focus-visible:opacity-100",
            checked || anyRowChecked ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100",
          )}
        >
          <span
            className={cn(
              "flex h-[14px] w-[14px] items-center justify-center rounded-[4px] border transition-colors",
              checked
                ? "border-accent bg-accent"
                : "border-fg/25 bg-transparent hover:border-fg/45",
            )}
          >
            {checked ? <Check size={10} weight="bold" className="text-accent-fg" /> : null}
          </span>
        </button>
      ) : (
        <span className="w-2 shrink-0" />
      )}

      {fields.priority ? (
        <span className="mr-2.5 grid w-4 shrink-0 place-items-center text-fg/70" title={`Priority: ${issue.priorityLabel === "none" ? "No priority" : issue.priorityLabel}`}>
          <LinearPriorityIcon priority={issue.priority} size={14} />
        </span>
      ) : null}

      {fields.id ? (
        <span
          className="mr-2.5 shrink-0 truncate text-[12.5px] tabular-nums text-muted-fg/80"
          style={{ width: `${Math.max(5, layout.identifierChars) * 0.62 + 0.2}em` }}
        >
          {issue.identifier}
        </span>
      ) : null}

      <span className="relative flex min-w-[180px] flex-1 items-center self-stretch">
        <span className="relative shrink-0 self-stretch" style={{ width: treeWidth }} aria-hidden="true">
          <TreeLines depth={depth} guides={row.guides} last={row.last} hasOpenChildren={hasOpenChildren} />
        </span>
        {fields.status ? (
          <span className="mr-2.5 grid shrink-0 place-items-center" title={issue.stateName} style={{ width: STATE_ICON }}>
            <LinearStateIcon stateType={issue.stateType} size={STATE_ICON} />
          </span>
        ) : null}
        {eyebrow ? (
          <span className="mr-2 inline-flex h-[20px] shrink-0 items-center rounded-full bg-accent/12 px-2 text-[11px] font-medium text-accent-text">
            {eyebrow}
          </span>
        ) : null}
        {row.parentHint ? (
          <span className="mr-1.5 flex min-w-0 max-w-[38%] shrink items-center gap-1 text-[13px] text-muted-fg/75" title={`Sub-issue of ${row.parentHint.identifier}`}>
            <span className="truncate">{row.parentHint.title}</span>
            <CaretRight size={10} className="shrink-0 opacity-70" />
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[13px] text-fg/[0.92]" dir="auto">
          {issue.title}
        </span>
        {progress ? (
          <button
            type="button"
            tabIndex={-1}
            className={cn(
              "ml-2 inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[11.5px] tabular-nums text-muted-fg transition-colors",
              row.childCount > 0 ? "hover:bg-fg/[0.06] hover:text-fg" : "cursor-default",
            )}
            title={`${progress.done} of ${progress.total}${progress.capped ? "+" : ""} sub-issues done${row.childCount > 0 ? (row.childrenCollapsed ? " · show sub-issues" : " · hide sub-issues") : ""}`}
            aria-label={row.childCount > 0 ? (row.childrenCollapsed ? "Show sub-issues" : "Hide sub-issues") : undefined}
            aria-expanded={row.childCount > 0 ? !row.childrenCollapsed : undefined}
            onClick={(event) => {
              if (row.childCount === 0) return;
              event.stopPropagation();
              onToggleChildren(issue.id);
            }}
          >
            <LinearProgressRing done={progress.done} total={progress.total} size={13} />
            {progress.done}/{progress.total}{progress.capped ? "+" : ""}
          </button>
        ) : null}
        {openBlockers.length > 0 ? (
          <span
            className="ml-2 inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full bg-warning/12 px-1.5 text-[11px] font-medium text-warning"
            title={`Blocked by ${openBlockers.map((blocker) => blocker.identifier).join(", ") || "an open issue"}`}
          >
            <LockSimple size={10} weight="fill" />
            Blocked
          </span>
        ) : null}
      </span>

      <span className="ml-3 flex min-w-0 shrink items-center justify-end gap-1.5 [&>*]:shrink-0 [&>[data-shrink]]:shrink">
        {fields.labels ? <LabelChips issue={issue} compact={layout.compactLabels} /> : null}
        {fields.adeStatus ? (
          showAde ? <LinearIssueAdeStatusCell status={adeStatus} /> : conflict ? <LinearConflictBadge conflict={conflict} /> : null
        ) : null}
        {fields.pullRequests && normalized ? <LinearPrChips issue={normalized} status={adeStatus} /> : null}
        {fields.project && issue.projectId && (issue.projectName || issue.projectSlug) ? (
          <PropertyChip
            className="max-w-[150px]"
            icon={<LinearProjectIcon icon={layout.projectLook(issue.projectId)?.icon} color={layout.projectLook(issue.projectId)?.color} name={issue.projectName ?? issue.projectSlug} size={12} />}
            title={`Project: ${issue.projectName ?? issue.projectSlug}`}
          >
            {issue.projectName ?? issue.projectSlug}
          </PropertyChip>
        ) : null}
        {fields.milestone && normalized?.projectMilestoneName ? (
          <PropertyChip className="max-w-[140px]" icon={<span className="text-muted-fg"><LinearMilestoneIcon size={11} /></span>} title={`Milestone: ${normalized.projectMilestoneName}`}>
            {normalized.projectMilestoneName}
          </PropertyChip>
        ) : null}
        {fields.cycle && normalized?.cycleId ? (
          <PropertyChip className="max-w-[120px]" icon={<span className="text-muted-fg"><LinearCycleIcon size={11} /></span>} title="Cycle">
            {normalized.cycleName || "Cycle"}
          </PropertyChip>
        ) : null}
        {fields.estimate && typeof issue.estimate === "number" ? (
          <PropertyChip icon={<Triangle size={10} className="text-muted-fg" />} title={`Estimate: ${issue.estimate}`}>
            {issue.estimate}
          </PropertyChip>
        ) : null}
        {due ? (
          <PropertyChip
            icon={<CalendarBlank size={11} />}
            title={`Due ${formatLinearListDate(due)}`}
            className={cn(tone === "overdue" && "border-error/30 text-error", tone === "soon" && "border-warning/30 text-warning")}
          >
            {formatLinearListDate(due)}
          </PropertyChip>
        ) : null}
        {fields.assignee ? (
          <span
            className="relative ml-1 flex shrink-0 items-center"
            title={delegateName ? `${issue.assigneeName ?? "Unassigned"}, delegated to ${delegateName}` : issue.assigneeName ?? "Unassigned"}
          >
            <LinearAssigneeAvatar name={issue.assigneeName} avatarUrl={normalized?.assigneeAvatarUrl ?? null} size={18} />
            {delegateName ? (
              // The agent working the issue rides on the assignee's avatar.
              <span className="absolute -bottom-[3px] -right-[4px] grid h-[12px] w-[12px] place-items-center rounded-full bg-[color:var(--ade-shell-surface,#121019)]">
                <LinearAssigneeAvatar name={delegateName} avatarUrl={normalized?.delegateAvatarUrl ?? null} size={10} />
              </span>
            ) : null}
          </span>
        ) : null}
        {updatedLabel ? (
          <span className="w-[52px] shrink-0 text-right text-[12px] tabular-nums text-muted-fg/75" title={`Updated ${issue.updatedAt}`}>
            {updatedLabel}
          </span>
        ) : null}
        {createdLabel ? (
          <span className="w-[52px] shrink-0 text-right text-[12px] tabular-nums text-muted-fg/75" title={`Created ${issue.createdAt}`}>
            {createdLabel}
          </span>
        ) : null}
      </span>
    </div>
  );
});

/**
 * A parent that is not in this group (another page, another group, or
 * filtered out): muted, not selectable by keyboard, opens the parent on click.
 */
export function LinearContextRow({
  row,
  layout,
  onOpen,
  onToggleChildren,
}: {
  row: LinearListContextRow;
  layout: LinearRowLayout;
  onOpen: (ref: LinearListContextRow["ref"]) => void;
  onToggleChildren: (issueId: string) => void;
}) {
  const open = !row.childrenCollapsed;
  return (
    <div
      className="group/ctx relative flex h-full w-full cursor-pointer items-center pl-1 pr-3 text-left hover:bg-fg/[0.02]"
      onClick={() => onOpen(row.ref)}
      title={`${row.ref.identifier} is the parent of ${row.childCount === 1 ? "this sub-issue" : `these ${row.childCount} sub-issues`}`}
    >
      {layout.showCheckbox ? <span className="w-7 shrink-0" /> : <span className="w-2 shrink-0" />}
      {layout.fields.priority ? <span className="mr-2.5 w-4 shrink-0" /> : null}
      {layout.fields.id ? (
        <span
          className="mr-2.5 shrink-0 truncate text-[12.5px] tabular-nums text-muted-fg/50"
          style={{ width: `${Math.max(5, layout.identifierChars) * 0.62 + 0.2}em` }}
        >
          {row.ref.identifier}
        </span>
      ) : null}
      <span className="relative flex min-w-0 flex-1 items-center self-stretch opacity-60">
        <span className="relative shrink-0 self-stretch" style={{ width: 0 }} aria-hidden="true">
          {open ? <TreeLines depth={0} guides={[]} last hasOpenChildren /> : null}
        </span>
        <span className="mr-2.5 grid shrink-0 place-items-center" style={{ width: STATE_ICON }}>
          <LinearStateIcon stateType={row.ref.stateType} size={STATE_ICON} />
        </span>
        <span className="min-w-0 truncate text-[13px] text-fg/80" dir="auto">{row.ref.title}</span>
      </span>
      <button
        type="button"
        className="ml-2 inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full px-1.5 text-[11.5px] text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg"
        aria-expanded={open}
        aria-label={open ? "Hide sub-issues" : "Show sub-issues"}
        onClick={(event) => { event.stopPropagation(); onToggleChildren(row.ref.id); }}
      >
        <CaretRight size={10} weight="bold" className={cn("transition-transform", open && "rotate-90")} />
        Parent
      </button>
    </div>
  );
}
