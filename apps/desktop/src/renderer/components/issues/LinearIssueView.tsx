import React, { useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight, CircleNotch } from "@phosphor-icons/react";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  LinearIssueRef,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { BranchIcon } from "../ui/vcsIcons";
import { LinearStateIcon } from "../lanes/linearBrand";
import { issueProjectLabel, issueUpdatedLabel } from "../lanes/linearIssueDisplay";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { LinearIssuePropertyBar } from "../app/LinearIssuePropertyPickers";
import { isNormalizedIssue, type BrowserIssue, type LinearIssueEdit } from "../app/linearIssueBrowserModel";
import { loadLinearIssueComments } from "./linearIssueStore";
import { IssueMarkdown } from "./issueMarkdown";
import { EditableIssueBody, EditableIssueTitle, IssueCommentComposer } from "./issueEditing";
import "./issueViewer.css";

/**
 * One Linear issue, laid out the way every issue surface shows it: the
 * conversation on the left (title, description, relations, activity) and the
 * properties on the right. The Issues tab in the Work tools pane, the issue
 * sheet, and the Linear pane's detail side all render this, so an issue looks
 * the same wherever you open it.
 *
 * The two columns are a container query, not a viewport one: the tools pane can
 * be narrow on a wide window, and there the sidebar folds under the title.
 *
 * Presentational: the host fetches the issue, owns edits, and supplies the
 * header and the action dock.
 */

export { IssueMarkdown } from "./issueMarkdown";

export function formatIssueDate(value: string | null | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function SideRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2 py-[5px]">
      <dt className="text-[11px] text-[color:var(--kit-text-3)]">{label}</dt>
      <dd className="min-w-0 text-[12px]">
        {children ?? <span className="block truncate text-fg/85" title={value}>{value}</span>}
      </dd>
    </div>
  );
}

function IssueFacts({ issue, branchName }: { issue: BrowserIssue; branchName: string | null }) {
  const normalized = isNormalizedIssue(issue) ? issue : null;
  return (
    <dl>
      <SideRow label="Project" value={issueProjectLabel(issue)} />
      <SideRow label="Team" value={issue.teamName ?? issue.teamKey} />
      {normalized?.cycleName ? <SideRow label="Cycle" value={normalized.cycleName} /> : null}
      {issue.estimate != null ? <SideRow label="Estimate" value={String(issue.estimate)} /> : null}
      {issue.dueDate ? <SideRow label="Due" value={formatIssueDate(issue.dueDate)} /> : null}
      <SideRow label="Creator" value={issue.creatorName ?? "Unknown"} />
      <SideRow label="Created" value={formatIssueDate(issue.createdAt)} />
      <SideRow label="Updated" value={issueUpdatedLabel(issue)} />
      {normalized?.startedAt ? <SideRow label="Started" value={formatIssueDate(normalized.startedAt)} /> : null}
      {normalized?.completedAt ? <SideRow label="Completed" value={formatIssueDate(normalized.completedAt)} /> : null}
      {normalized?.canceledAt ? <SideRow label="Canceled" value={formatIssueDate(normalized.canceledAt)} /> : null}
      {branchName ? (
        <SideRow label="Branch">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg/80">
            <BranchIcon size={11} className="shrink-0" />
            <span className="truncate" title={branchName}>{branchName}</span>
          </span>
        </SideRow>
      ) : null}
    </dl>
  );
}

function RelationGroup({
  title,
  refs,
  tone,
  onOpenIssue,
  loadingIssueId,
}: {
  title: string;
  refs: LinearIssueRef[];
  tone?: "warning";
  onOpenIssue?: (ref: LinearIssueRef) => void;
  loadingIssueId: string | null;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-2 first:mt-0">
      <div className={cn("mb-0.5 text-[11px]", tone === "warning" ? "text-[color:var(--kit-warn)]" : "text-[color:var(--kit-text-3)]")}>
        {title}
        <span className="kit-num ml-1 text-[color:var(--kit-text-3)]">{refs.length}</span>
      </div>
      {refs.map((ref) => (
        <button
          key={ref.id}
          type="button"
          disabled={!onOpenIssue}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[color:var(--kit-hover)] disabled:hover:bg-transparent"
          onClick={() => onOpenIssue?.(ref)}
          title={`${ref.identifier} ${ref.title}${ref.stateName ? ` · ${ref.stateName}` : ""}`}
        >
          {loadingIssueId === ref.id
            ? <CircleNotch size={11} className="shrink-0 animate-spin text-muted-fg/55" />
            : <LinearStateIcon stateType={ref.stateType} size={11} />}
          <span className="shrink-0 font-mono text-[10.5px] text-fg/60">{ref.identifier}</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg/80">{ref.title}</span>
        </button>
      ))}
    </div>
  );
}

function IssueRelations({
  issue,
  onOpenIssue,
  loadingIssueId,
}: {
  issue: BrowserIssue;
  onOpenIssue?: (ref: LinearIssueRef) => void;
  loadingIssueId: string | null;
}) {
  if (!isNormalizedIssue(issue)) return null;
  const parent = issue.parentIssue ? [issue.parentIssue] : [];
  const blockedBy = issue.blockedByIssues ?? [];
  const blocking = issue.blockingIssues ?? [];
  const related = issue.relatedIssues ?? [];
  const children = issue.childIssues ?? [];
  if (parent.length + blockedBy.length + blocking.length + related.length + children.length === 0) return null;
  return (
    <section className="ade-issue-section" data-linear-relations="true">
      <RelationGroup title="Parent" refs={parent} onOpenIssue={onOpenIssue} loadingIssueId={loadingIssueId} />
      <RelationGroup
        title="Blocked by"
        refs={blockedBy}
        tone={issue.hasOpenBlockers ? "warning" : undefined}
        onOpenIssue={onOpenIssue}
        loadingIssueId={loadingIssueId}
      />
      <RelationGroup title="Blocks" refs={blocking} onOpenIssue={onOpenIssue} loadingIssueId={loadingIssueId} />
      <RelationGroup title="Related" refs={related} onOpenIssue={onOpenIssue} loadingIssueId={loadingIssueId} />
      <RelationGroup title="Sub-issues" refs={children} onOpenIssue={onOpenIssue} loadingIssueId={loadingIssueId} />
    </section>
  );
}

function ActivitySection({
  issueId,
  defaultOpen,
  onComment,
  commentReadOnlyReason,
}: {
  issueId: string;
  defaultOpen: boolean;
  onComment?: (body: string) => Promise<void>;
  commentReadOnlyReason?: string | null;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [comments, setComments] = useState<CtoLinearIssueComment[] | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const prevIssueIdRef = useRef(issueId);

  if (prevIssueIdRef.current !== issueId) {
    prevIssueIdRef.current = issueId;
    setComments(null);
    setCommentError(null);
    setExpanded(defaultOpen);
  }

  useEffect(() => {
    if (!expanded || comments || commentError) return;
    let cancelled = false;
    setLoading(true);
    void loadLinearIssueComments(issueId)
      .then((result) => { if (!cancelled) setComments(result); })
      .catch(() => { if (!cancelled) setCommentError("Couldn't load comments."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, issueId, comments, commentError]);

  return (
    <section className="ade-issue-section">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--kit-text-3)] transition-colors hover:text-fg/85"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Activity
        {comments && comments.length > 0 ? <span className="kit-num">{comments.length}</span> : null}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-3">
          {loading ? (
            <div className="text-[11px] text-[color:var(--kit-text-3)]">Loading comments…</div>
          ) : commentError ? (
            <div className="text-[11px] text-[color:var(--kit-crit)]">{commentError}</div>
          ) : comments && comments.length > 0 ? (
            comments.map((comment) => {
              const author = comment.userDisplayName || comment.userName || "Someone";
              return (
                <article key={comment.id} className="flex gap-2.5">
                  <LinearAssigneeAvatar name={author} avatarUrl={comment.userAvatarUrl ?? null} size={20} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[11.5px] font-medium text-fg/85">{author}</span>
                      <span className="shrink-0 text-[10.5px] text-[color:var(--kit-text-3)]">{formatIssueDate(comment.createdAt)}</span>
                    </div>
                    <div className="mt-0.5">
                      <IssueMarkdown size="comment">{comment.body}</IssueMarkdown>
                    </div>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="text-[11px] text-[color:var(--kit-text-3)]">No comments yet.</div>
          )}
          <IssueCommentComposer
            readOnlyReason={commentReadOnlyReason}
            onSubmit={onComment
              ? async (body) => {
                await onComment(body);
                // Re-read the thread so the new comment shows with its author.
                setComments(null);
              }
              : undefined}
          />
        </div>
      ) : null}
    </section>
  );
}

export function LinearIssueView({
  issue,
  catalog,
  onEdit,
  editPending,
  onOpenIssue,
  loadingIssueId = null,
  branchName,
  activityDefaultOpen = false,
  aboveTitle,
  sideExtra,
  onSaveTitle,
  onSaveDescription,
  onComment,
  readOnlyReason,
}: {
  issue: BrowserIssue;
  catalog: CtoGetLinearIssuePickerDataResult;
  onEdit?: (edit: LinearIssueEdit) => void;
  editPending?: boolean;
  onOpenIssue?: (ref: LinearIssueRef) => void;
  loadingIssueId?: string | null;
  branchName: string | null;
  /** Comments cost a request, so the browser loads them on demand; a single-issue view loads them up front. */
  activityDefaultOpen?: boolean;
  /** Small line above the title (the browser's identifier + conflict badge). */
  aboveTitle?: React.ReactNode;
  /** Appended to the property sidebar (Linked in ADE). */
  sideExtra?: React.ReactNode;
  onSaveTitle?: (title: string) => Promise<void>;
  onSaveDescription?: (description: string) => Promise<void>;
  onComment?: (body: string) => Promise<void>;
  /** Why title, description and comments are read-only, when they are. */
  readOnlyReason?: string | null;
}) {
  const description = issue.description ?? "";
  return (
    <div className="ade-issue-view" data-linear-pane="issue-details">
      <div className="ade-issue-view-grid">
        <aside className="ade-issue-view-side" aria-label="Issue properties">
          <LinearIssuePropertyBar
            issue={issue}
            catalog={catalog}
            pending={editPending}
            layout="rows"
            onEdit={onEdit}
          />
          <div className="kit-rule my-2" />
          <IssueFacts issue={issue} branchName={branchName} />
          {sideExtra}
        </aside>
        <div className="ade-issue-view-head">
          {aboveTitle ? <div className="mb-1.5 flex items-center gap-2">{aboveTitle}</div> : null}
          <EditableIssueTitle value={issue.title} onSave={onSaveTitle} readOnlyReason={readOnlyReason} />
        </div>
        <div className="ade-issue-view-body">
          <EditableIssueBody value={description} onSave={onSaveDescription} />
          <IssueRelations issue={issue} onOpenIssue={onOpenIssue} loadingIssueId={loadingIssueId} />
          <ActivitySection
            issueId={issue.id}
            defaultOpen={activityDefaultOpen}
            onComment={onComment}
            commentReadOnlyReason={readOnlyReason}
          />
        </div>
      </div>
    </div>
  );
}
