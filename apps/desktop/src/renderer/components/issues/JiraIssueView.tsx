import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarBlank, CaretDown, CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { JiraComment, JiraCreateMeta, JiraIssueDetail, JiraTransition, JiraUser } from "../../../shared/types/jira";
import type { IssueRef } from "../../../shared/issueRefs";
import { parseJiraError, jiraErrorMessage } from "../../../shared/jiraErrors";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { PickerMenu, type PickerOption } from "./IssuePickerMenu";
import { JiraStatusIcon } from "../lanes/jiraBrand";
import { cn } from "../ui/cn";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { Banner } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";
import { EditableIssueBody, EditableIssueTitle, IssueCommentComposer } from "./issueEditing";
import { IssueMarkdown } from "./issueMarkdown";
import { formatIssueDate } from "./LinearIssueView";
import { loadJiraIssueComments } from "./jiraIssueStore";
import "./issueViewer.css";

export type JiraIssueEditing = {
  readOnlyReason: string | null;
  canTransition: boolean;
  canAssign: boolean;
  canComment: boolean;
  transitions: JiraTransition[];
  assignees: JiraUser[];
  labels: string[];
  createMeta: JiraCreateMeta | null;
  onNeedTransitions: () => void;
  onNeedAssignees: () => void;
  onNeedLabels: () => void;
  onNeedCreateMeta: () => void;
  onSaveTitle: (title: string) => Promise<void>;
  onSaveDescription: (description: string) => Promise<void>;
  onSetAssignee: (accountId: string | null) => void;
  onSetPriority: (priorityId: string) => void;
  onSetLabels: (labels: string[]) => void;
  onSetDueDate: (dueDate: string | null) => void;
  onTransition: (transition: JiraTransition) => void;
  onComment: (body: string) => Promise<JiraComment>;
};

type PickerId = "status" | "assignee" | "priority" | "labels";
const JIRA_DUE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function commentErrorModel(id: string, error: string, retry: () => void) {
  const parsed = parseJiraError(error);
  const retryAt = parsed?.retryAt ? new Date(parsed.retryAt) : null;
  const retryTime = retryAt && Number.isFinite(retryAt.getTime()) ? retryAt.toLocaleTimeString() : null;
  let detail = parsed?.message ?? error;
  const actions: Array<{ label: string; onClick: () => void }> = [];
  if (parsed?.reason === "not-connected") {
    detail = "Connect this Jira site in Settings to load comments.";
    actions.push({ label: "Connect Jira", onClick: () => { window.location.hash = `#${settingsRouteFor("integrations.jira")}`; } });
  } else if (parsed?.reason === "unauthenticated") {
    detail = "Update the saved Jira API token in Settings.";
    actions.push({ label: "Jira settings", onClick: () => { window.location.hash = `#${settingsRouteFor("integrations.jira")}`; } });
  } else if (parsed?.reason === "forbidden") {
    detail = "Ask a Jira administrator for permission to read comments on this issue.";
  } else if (parsed?.reason === "rate-limited") {
    detail = retryTime ? `Try again after ${retryTime}. ${detail}` : detail;
  }
  actions.push({ label: "Retry", onClick: retry });
  return { id, tone: parsed?.reason === "failed" ? "error" as const : "warning" as const, title: "Couldn't load Jira comments", detail, actions };
}

function SideRow({
  label,
  children,
  editable,
  title,
  anchorRef,
  onOpen,
}: {
  label: string;
  children: React.ReactNode;
  editable?: boolean;
  title?: string;
  anchorRef?: React.RefObject<HTMLButtonElement>;
  onOpen?: () => void;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-2 py-[3px]">
      <dt className="pt-[5px] text-[11px] text-[color:var(--kit-text-3)]">{label}</dt>
      <dd className="min-w-0 text-[12px] text-fg/85">
        {onOpen ? (
          <button
            ref={anchorRef}
            type="button"
            disabled={!editable}
            title={editable ? `Change ${label.toLowerCase()}` : title}
            onClick={onOpen}
            className={cn(
              "-ml-1.5 flex w-[calc(100%+6px)] min-w-0 items-start rounded-md px-1.5 py-1 text-left",
              editable ? "hover:bg-[color:var(--kit-hover)]" : "cursor-default",
            )}
          >
            {children}
          </button>
        ) : <div className="py-1">{children}</div>}
      </dd>
    </div>
  );
}

function JiraLabels({ labels }: { labels: string[] }) {
  if (!labels.length) return <span className="text-[color:var(--kit-text-3)]">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span key={label} className="max-w-full truncate rounded-full border border-[color:var(--kit-rule)] px-1.5 py-px text-[11px]">{label}</span>
      ))}
    </span>
  );
}

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromIso(value: string | null): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function JiraDueDatePicker({ value, disabled, onPick }: { value: string | null; disabled: boolean; onPick: (value: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const selected = dateFromIso(value) ?? new Date();
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const selected = dateFromIso(value);
  const weekdayOffset = (month.getDay() + 6) % 7;
  const dayCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((weekdayOffset + dayCount) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - weekdayOffset + 1;
    return day > 0 && day <= dayCount ? new Date(month.getFullYear(), month.getMonth(), day) : null;
  });
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label="Due date"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          const date = dateFromIso(value) ?? new Date();
          setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
          setOpen(true);
        }}
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.02] px-2 text-[11.5px] text-fg/85 transition-colors hover:border-fg/[0.16] hover:bg-fg/[0.05] disabled:cursor-default disabled:opacity-70"
      >
        <CalendarBlank size={12} className="shrink-0 text-[color:var(--kit-text-3)]" />
        <span className="truncate">{selected ? JIRA_DUE_DATE_FORMAT.format(selected) : "None"}</span>
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        zIndex={Z_LAYERS.dialogPopover}
        className={`${MENU_SURFACE_CLASS} w-[248px] p-2`}
      >
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            className="kit-icon-btn h-6 w-6"
            onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
          >
            <CaretLeft size={12} />
          </button>
          <span className="text-[11.5px] font-medium text-fg/85">{monthLabel}</span>
          <button
            type="button"
            aria-label="Next month"
            className="kit-icon-btn h-6 w-6"
            onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
          >
            <CaretRight size={12} />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[9.5px] text-muted-fg/55" aria-hidden="true">
          {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`} className="py-1">{day}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5" role="grid" aria-label={monthLabel}>
          {cells.map((date, index) => {
            if (!date) return <span key={`empty-${index}`} aria-hidden="true" />;
            const dayValue = isoDate(date);
            const isSelected = value === dayValue;
            const isToday = dayValue === isoDate(new Date());
            return (
              <button
                key={dayValue}
                type="button"
                role="gridcell"
                aria-label={date.toLocaleDateString()}
                aria-selected={isSelected}
                onClick={() => { onPick(dayValue); setOpen(false); }}
                className={cn(
                  "grid h-7 place-items-center rounded-md text-[11px] transition-colors hover:bg-fg/[0.08]",
                  isSelected && "bg-[color:var(--color-accent)] text-accent-fg hover:bg-[color:var(--color-accent)]",
                  isToday && !isSelected && "border border-fg/[0.18]",
                )}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-fg/[0.06] pt-2">
          <button type="button" className="kit-btn kit-btn-ghost h-6 px-2 text-[10.5px]" onClick={() => { onPick(isoDate(new Date())); setOpen(false); }}>
            Today
          </button>
          <button type="button" className="kit-btn kit-btn-ghost h-6 px-2 text-[10.5px]" disabled={!value} onClick={() => { onPick(null); setOpen(false); }}>
            Clear
          </button>
        </div>
      </AnchoredMenu>
    </>
  );
}

function Activity({
  issue,
  siteUrl,
  projectRoot,
  editing,
}: {
  issue: JiraIssueDetail;
  siteUrl: string;
  projectRoot: string | null;
  editing?: JiraIssueEditing;
}) {
  const [expanded, setExpanded] = useState(true);
  const [comments, setComments] = useState(issue.comments);
  const [nextCursor, setNextCursor] = useState(issue.commentsCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const identity = `${siteUrl}:${issue.key}`;
  const previousIdentity = useRef(identity);
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    setComments(issue.comments);
    setNextCursor(issue.commentsCursor);
    setCommentError(null);
    setInitialError(null);
    setExpanded(true);
  }

  useEffect(() => {
    setComments(issue.comments);
    setNextCursor(issue.commentsCursor);
  }, [issue.comments, issue.commentsCursor]);

  const loadOlder = async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setCommentError(null);
    try {
      const page = await loadJiraIssueComments(projectRoot, siteUrl, issue.key, nextCursor);
      setComments((current) => {
        const existing = new Set(current.map((comment) => comment.id));
        return [...page.comments.filter((comment) => !existing.has(comment.id)), ...current];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      setCommentError(jiraErrorMessage(error, "Couldn't load older comments."));
    } finally {
      setLoadingOlder(false);
    }
  };

  const loadInitial = useCallback(async () => {
    setInitialLoading(true);
    setInitialError(null);
    try {
      const page = await loadJiraIssueComments(projectRoot, siteUrl, issue.key, null);
      setComments(page.comments);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setInitialError(jiraErrorMessage(error, "Couldn't load comments."));
    } finally {
      setInitialLoading(false);
    }
  }, [issue.key, projectRoot, siteUrl]);

  useEffect(() => {
    if (!expanded || issue.totalComments === 0 || comments.length > 0 || initialLoading || initialError) return;
    void loadInitial();
  }, [comments.length, expanded, initialError, initialLoading, issue.totalComments, issue.updatedAt, loadInitial]);

  return (
    <section className="ade-issue-section">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--kit-text-3)] transition-colors hover:text-fg/85"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Activity
        {issue.totalComments > 0 ? <span className="kit-num">{issue.totalComments}</span> : null}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-3">
          {issue.totalComments === 0 && comments.length === 0 ? (
            <div className="text-[11px] text-[color:var(--kit-text-3)]">No comments yet.</div>
          ) : initialLoading ? (
            <div className="text-[11px] text-[color:var(--kit-text-3)]">Loading comments…</div>
          ) : initialError ? (
            <Banner layout="inline" model={commentErrorModel("jira-comments-initial-error", initialError, () => { void loadInitial(); })} />
          ) : (
            comments.map((comment) => {
              const author = comment.author?.displayName ?? "Someone";
              return (
                <article key={comment.id} className="flex gap-2.5">
                  <LinearAssigneeAvatar name={author} avatarUrl={comment.author?.avatarUrl ?? null} size={20} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[11.5px] font-medium text-fg/85">{author}</span>
                      <span className="shrink-0 text-[10.5px] text-[color:var(--kit-text-3)]">{formatIssueDate(comment.createdAt)}</span>
                    </div>
                    <div className="mt-0.5"><IssueMarkdown size="comment">{comment.body}</IssueMarkdown></div>
                  </div>
                </article>
              );
            })
          )}
          {nextCursor ? (
            <div className="flex items-center gap-2">
              <button type="button" className="kit-card-head-action !m-0" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? "Loading older comments…" : "Load older comments"}
              </button>
              {commentError ? <Banner layout="inline" model={commentErrorModel("jira-comments-older-error", commentError, () => { void loadOlder(); })} /> : null}
            </div>
          ) : null}
          <IssueCommentComposer
            readOnlyReason={editing?.canComment ? null : "This Jira account cannot add comments to this issue."}
            onSubmit={editing?.canComment ? async (body) => {
              await editing.onComment(body);
            } : undefined}
          />
        </div>
      ) : null}
    </section>
  );
}

export function JiraIssueView({
  issue,
  siteUrl,
  projectRoot,
  onOpenRelated,
  editing,
}: {
  issue: JiraIssueDetail;
  siteUrl: string;
  projectRoot: string | null;
  onOpenRelated: (ref: IssueRef) => void;
  editing?: JiraIssueEditing;
}) {
  const editable = Boolean(editing && editing.readOnlyReason == null && issue.permissions.edit);
  const [openPicker, setOpenPicker] = useState<PickerId | null>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const assigneeRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const labelsRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpenPicker(null);
  const open = (picker: PickerId) => {
    setOpenPicker(picker);
    if (picker === "status") editing?.onNeedTransitions();
    if (picker === "assignee") editing?.onNeedAssignees();
    if (picker === "priority") editing?.onNeedCreateMeta();
    if (picker === "labels") editing?.onNeedLabels();
  };

  const statusOptions = useMemo<PickerOption[]>(
    () => (editing?.transitions ?? []).map((transition) => ({
      id: transition.id,
      label: transition.to.name,
      icon: <JiraStatusIcon category={transition.to.category} size={12} />,
    })),
    [editing?.transitions],
  );
  const assignees = useMemo(() => {
    const byId = new Map((editing?.assignees ?? []).map((user) => [user.accountId, user]));
    if (issue.assignee && !byId.has(issue.assignee.accountId)) byId.set(issue.assignee.accountId, issue.assignee);
    return [...byId.values()];
  }, [editing?.assignees, issue.assignee]);
  const priorityOptions = editing?.createMeta?.priorities ?? [];
  const currentPriority = issue.priority;
  const parentRef = issue.parentKey ? { provider: "jira" as const, siteUrl, key: issue.parentKey } : null;

  return (
    <div className="ade-issue-view" data-jira-issue-view="true">
      <div className="ade-issue-view-grid">
        <aside className="ade-issue-view-side" aria-label="Issue properties">
          <dl>
            <SideRow
              label="Status"
              editable={Boolean(editable && issue.permissions.transition)}
              title="This Jira account cannot transition the issue."
              anchorRef={statusRef}
              onOpen={() => open("status")}
            >
              <span className="flex items-center gap-1.5">
                <JiraStatusIcon category={issue.status.category} />
                <span className="truncate">{issue.status.name}</span>
              </span>
            </SideRow>
            <SideRow
              label="Assignee"
              editable={Boolean(editable && issue.permissions.assign)}
              title="This Jira account cannot assign the issue."
              anchorRef={assigneeRef}
              onOpen={() => open("assignee")}
            >
              {issue.assignee ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <LinearAssigneeAvatar name={issue.assignee.displayName} avatarUrl={issue.assignee.avatarUrl} size={16} />
                  <span className="truncate">{issue.assignee.displayName}</span>
                </span>
              ) : <span className="text-[color:var(--kit-text-3)]">Unassigned</span>}
            </SideRow>
            <SideRow
              label="Priority"
              editable={editable}
              title={editing?.readOnlyReason ?? undefined}
              anchorRef={priorityRef}
              onOpen={() => open("priority")}
            >
              {issue.priority?.name ?? <span className="text-[color:var(--kit-text-3)]">None</span>}
            </SideRow>
            <SideRow
              label="Labels"
              editable={editable}
              title={editing?.readOnlyReason ?? undefined}
              anchorRef={labelsRef}
              onOpen={() => open("labels")}
            >
              <JiraLabels labels={issue.labels} />
            </SideRow>
            <SideRow label="Type">
              <span className="flex min-w-0 items-center gap-1.5">
                {issue.issueType.iconUrl ? <img src={issue.issueType.iconUrl} alt="" className="h-3.5 w-3.5" /> : null}
                {issue.issueType.name}
              </span>
            </SideRow>
            <SideRow label="Parent">
              {parentRef ? (
                <button
                  type="button"
                  className="kit-card-head-action !m-0 !px-0"
                  onClick={() => onOpenRelated(parentRef)}
                >
                  {issue.parentKey}
                </button>
              ) : <span className="text-[color:var(--kit-text-3)]">None</span>}
            </SideRow>
            <SideRow label="Due date">
              <JiraDueDatePicker value={issue.dueDate} disabled={!editable} onPick={(dueDate) => editing?.onSetDueDate(dueDate)} />
            </SideRow>
          </dl>
          <div className="kit-rule my-2" />
          <dl>
            <SideRow label="Project"><span className="kit-num">{issue.projectKey}</span></SideRow>
            <SideRow label="Reporter">
              {issue.reporter ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <LinearAssigneeAvatar name={issue.reporter.displayName} avatarUrl={issue.reporter.avatarUrl} size={16} />
                  <span className="truncate">{issue.reporter.displayName}</span>
                </span>
              ) : <span className="text-[color:var(--kit-text-3)]">Unknown</span>}
            </SideRow>
            <SideRow label="Created">{formatIssueDate(issue.createdAt)}</SideRow>
            <SideRow label="Updated">{formatIssueDate(issue.updatedAt)}</SideRow>
          </dl>
        </aside>
        <div className="ade-issue-view-head">
          <EditableIssueTitle
            value={issue.title}
            suffix={<span className="ml-1.5 font-normal text-[color:var(--kit-text-3)]">{issue.key}</span>}
            onSave={editable ? editing?.onSaveTitle : undefined}
            readOnlyReason={editing?.readOnlyReason}
          />
        </div>
        <div className="ade-issue-view-body">
          <EditableIssueBody value={issue.description} onSave={editable ? editing?.onSaveDescription : undefined} />
          <Activity issue={issue} siteUrl={siteUrl} projectRoot={projectRoot} editing={editing} />
        </div>
      </div>

      {editing ? (
        <>
          <PickerMenu
            open={openPicker === "status"}
            anchorRef={statusRef}
            onClose={close}
            options={statusOptions}
            selectedIds={new Set(editing.transitions.filter((transition) => transition.to.id === issue.status.id).map((transition) => transition.id))}
            placeholder="Change status…"
            onPick={(id) => {
              close();
              const transition = editing.transitions.find((candidate) => candidate.id === id);
              if (transition && transition.id !== issue.status.id) editing.onTransition(transition);
            }}
          />
          <PickerMenu
            open={openPicker === "assignee"}
            anchorRef={assigneeRef}
            onClose={close}
            options={[
              { id: "", label: "Unassigned" },
              ...assignees.map((user) => ({ id: user.accountId, label: user.displayName, keywords: user.emailAddress ?? "", icon: <LinearAssigneeAvatar name={user.displayName} avatarUrl={user.avatarUrl} size={14} /> })),
            ]}
            selectedIds={new Set([issue.assignee?.accountId ?? ""])}
            placeholder="Assign to…"
            onPick={(id) => { close(); editing.onSetAssignee(id || null); }}
          />
          <PickerMenu
            open={openPicker === "priority"}
            anchorRef={priorityRef}
            onClose={close}
            options={priorityOptions.map((priority) => ({
              id: priority.id,
              label: priority.name,
              ...(priority.iconUrl ? { icon: <img src={priority.iconUrl} alt="" className="h-3.5 w-3.5" /> } : {}),
            }))}
            selectedIds={new Set(currentPriority ? [currentPriority.id] : [])}
            placeholder="Set priority…"
            onPick={(id) => { close(); if (id) editing.onSetPriority(id); }}
          />
          <PickerMenu
            open={openPicker === "labels"}
            anchorRef={labelsRef}
            onClose={close}
            options={editing.labels.map((label) => ({ id: label, label }))}
            selectedIds={new Set(issue.labels)}
            multi
            placeholder="Add or remove labels…"
            onPick={(label) => editing.onSetLabels(issue.labels.includes(label)
              ? issue.labels.filter((entry) => entry !== label)
              : [...issue.labels, label])}
          />
        </>
      ) : null}
    </div>
  );
}
