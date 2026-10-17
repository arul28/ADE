import React from "react";
import { Check, LockSimple, Robot, Stack } from "@phosphor-icons/react";
import type { CtoLinearProject, CtoLinearQuickViewProject } from "../../../shared/types";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import { cn } from "../ui/cn";
import { LinearPriorityIcon, LinearStateIcon } from "../lanes/linearBrand";
import { LinearProjectIcon } from "../lanes/linearProjectIcon";
import { initialsFor, isNormalizedIssue, type BrowserIssue } from "./linearIssueBrowserModel";

export const ISSUE_ROW_HEIGHT = 34;
export const GROUP_HEADER_HEIGHT = 32;

function formatLinearListDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function LinearAssigneeAvatar({
  name,
  avatarUrl,
  size = 16,
}: {
  name: string | null | undefined;
  avatarUrl?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = React.useState(false);
  const dimension = { width: size, height: size };
  if (!name) {
    return (
      <span
        className="block shrink-0 rounded-full border border-dashed border-white/25"
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
        className="block shrink-0 rounded-full object-cover"
        style={dimension}
      />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-fg/[0.10] font-medium text-fg/75"
      style={{ ...dimension, fontSize: Math.max(7, Math.round(size * 0.45)) }}
      title={name}
      aria-label={name}
    >
      {initialsFor(name)}
    </span>
  );
}

function LabelDots({ issue }: { issue: BrowserIssue }) {
  const labels = isNormalizedIssue(issue) && issue.labelColors
    ? issue.labelColors
    : issue.labels.map((name) => ({ name, color: null as string | null }));
  if (labels.length === 0) return null;
  const shown = labels.slice(0, 2);
  const title = labels.map((label) => label.name).join(", ");
  return (
    <span className="flex shrink-0 items-center gap-1" title={title}>
      {shown.map((label) => (
        <span
          key={label.name}
          className="block h-[7px] w-[7px] rounded-full"
          style={{ backgroundColor: label.color ?? "rgba(255,255,255,0.35)" }}
        />
      ))}
      {labels.length > shown.length ? (
        <span className="text-[10px] tabular-nums text-muted-fg/45">+{labels.length - shown.length}</span>
      ) : null}
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
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-[3px] text-[9.5px] font-medium leading-none"
      style={{
        borderColor: "rgba(167, 139, 250, 0.28)",
        backgroundColor: "rgba(167, 139, 250, 0.10)",
        color: "rgba(196, 181, 253, 0.95)",
      }}
      title={tooltip}
    >
      {isLane ? <Stack size={9} weight="bold" /> : <Robot size={9} weight="bold" />}
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
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        active ? "bg-fg/[0.06] text-fg" : "text-muted-fg/80 hover:bg-fg/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={title}
    >
      <span className="grid w-[15px] shrink-0 place-items-center text-muted-fg/70">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px]">{title}</span>
      {count ? <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/45">{count}</span> : null}
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
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        active ? "bg-fg/[0.06] text-fg" : "text-muted-fg/80 hover:bg-fg/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={project.name}
    >
      <LinearProjectIcon
        icon={project.icon ?? quick?.icon}
        color={project.color ?? quick?.color}
        name={project.name}
        size={15}
      />
      <span className="min-w-0 flex-1 truncate text-[12px]">{project.name}</span>
      {count ? <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/45">{count}</span> : null}
    </button>
  );
}

export function LinearBrowserIssueRow({
  issue,
  active,
  eyebrow,
  busy,
  checked,
  anyChecked: anyRowChecked,
  showCheckbox,
  conflict,
  onToggleCheck,
  onClick,
}: {
  issue: BrowserIssue;
  active: boolean;
  eyebrow?: string;
  busy?: boolean;
  checked: boolean;
  anyChecked: boolean;
  showCheckbox: boolean;
  conflict?: IssueConflict | null;
  onToggleCheck: (event: React.MouseEvent) => void;
  onClick: () => void;
}) {
  const listDate = formatLinearListDate(issue.createdAt) || formatLinearListDate(issue.updatedAt);
  const avatarUrl = isNormalizedIssue(issue) ? issue.assigneeAvatarUrl ?? null : null;

  // The row is a `div role="button"` rather than a real <button> so the
  // checkbox can be a sibling interactive control. A <button> nested inside a
  // <button> is invalid HTML and made checkbox clicks finnicky/missed.
  return (
    <div
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy || undefined}
      aria-pressed={active}
      data-linear-issue-row={issue.id}
      className={cn(
        "group/row flex w-full items-center gap-2 border-b border-fg/[0.04] px-3 text-left transition-colors outline-none focus-visible:bg-fg/[0.06]",
        busy && "pointer-events-none opacity-50",
        active ? "bg-fg/[0.06]" : "hover:bg-fg/[0.03]",
      )}
      style={{ height: ISSUE_ROW_HEIGHT }}
      onClick={() => { if (!busy) onClick(); }}
      onKeyDown={(e) => {
        if (busy) return;
        // Space selects. Enter selects a row that is not selected yet; on the
        // selected row it falls through to the browser's primary action.
        if (e.key === " " || (e.key === "Enter" && !active)) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/*
        The checkbox is a ≥24px hit target (the inner box stays 14px) so the
        click registers across the whole left gutter. Unselected boxes stay
        visible (dimmed) so toggling does not shift the row. stopPropagation
        keeps the toggle from also selecting the row.
      */}
      {showCheckbox ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? `Deselect ${issue.identifier}` : `Select ${issue.identifier}`}
          onClick={(e) => { e.stopPropagation(); onToggleCheck(e); }}
          className="-ml-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md outline-none focus-visible:bg-fg/[0.06]"
        >
          <span
            className={cn(
              "flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border transition-colors",
              checked
                ? "border-[color:var(--color-accent,#A78BFA)] bg-[color:var(--color-accent,#A78BFA)]"
                : anyRowChecked
                  ? "border-fg/[0.18] bg-transparent group-hover/row:border-white/35"
                  : "border-fg/[0.12] bg-transparent group-hover/row:border-white/35",
            )}
          >
            {checked ? <Check size={10} weight="bold" className="text-accent-fg" /> : null}
          </span>
        </button>
      ) : null}
      <span className="grid w-[14px] shrink-0 place-items-center" title={`Priority: ${issue.priorityLabel}`}>
        <LinearPriorityIcon priority={issue.priority} size={13} />
      </span>
      <span className="w-[58px] shrink-0 truncate font-mono text-[11px] text-muted-fg/50">
        {issue.identifier}
      </span>
      <span className="shrink-0" title={issue.stateName}>
        <LinearStateIcon stateType={issue.stateType} size={12} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg/90">
        {eyebrow ? (
          <span className="mr-1.5 text-[10px] uppercase tracking-wide text-muted-fg/45">{eyebrow}</span>
        ) : null}
        {issue.title}
      </span>
      <LabelDots issue={issue} />
      {isNormalizedIssue(issue) && issue.hasOpenBlockers ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--color-warning)]/30 bg-[color:var(--color-warning)]/10 px-1.5 py-[3px] text-[9.5px] font-medium leading-none text-[color:var(--color-warning)]"
          title={`Blocked by ${(issue.blockedByIssues ?? []).filter((blocker) => blocker.stateType !== "completed" && blocker.stateType !== "canceled").map((blocker) => blocker.identifier).join(", ") || "an open issue"}`}
        >
          <LockSimple size={9} weight="fill" />
          Blocked
        </span>
      ) : null}
      {conflict ? <LinearConflictBadge conflict={conflict} /> : null}
      {listDate ? (
        <span className="w-[42px] shrink-0 text-right text-[11px] tabular-nums text-muted-fg/45">
          {listDate}
        </span>
      ) : null}
      <LinearAssigneeAvatar name={issue.assigneeName} avatarUrl={avatarUrl} />
    </div>
  );
}
