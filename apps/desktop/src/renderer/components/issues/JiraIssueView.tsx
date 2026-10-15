import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { JiraComment, JiraCreateMeta, JiraIssueDetail, JiraTransition, JiraUser } from "../../../shared/types/jira";
import type { IssueRef } from "../../../shared/issueRefs";
import { parseJiraError } from "../../../shared/jiraErrors";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { PickerMenu, type PickerOption } from "./IssuePickerMenu";
import { JiraStatusIcon } from "../lanes/jiraBrand";
import { cn } from "../ui/cn";
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
      setCommentError(error instanceof Error ? error.message : "Couldn't load older comments.");
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
      setInitialError(error instanceof Error ? error.message : "Couldn't load comments.");
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
              {editable ? (
                <input
                  type="date"
                  aria-label="Due date"
                  className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[11.5px] text-fg/85 outline-none hover:border-[color:var(--kit-rule)] focus:border-[color:var(--color-accent)] [color-scheme:dark]"
                  value={issue.dueDate ?? ""}
                  onChange={(event) => editing?.onSetDueDate(event.target.value || null)}
                />
              ) : <span>{issue.dueDate ?? <span className="text-[color:var(--kit-text-3)]">None</span>}</span>}
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
