import React, { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { GitHubIssuePatch } from "../../../shared/laneGitHubIssue";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { PickerMenu, githubLabelOptions, githubPersonOptions, type PickerOption } from "./IssuePickerMenu";
import { GitHubIssueStateIcon, githubIssueStateLabel } from "../lanes/githubBrand";
import { cn } from "../ui/cn";
import { EditableIssueBody, EditableIssueTitle, IssueCommentComposer } from "./issueEditing";
import { IssueMarkdown } from "./issueMarkdown";
import { formatIssueDate } from "./LinearIssueView";
import {
  loadGitHubIssueComments,
  type GitHubIssueComment,
  type GitHubIssueDetail,
  type GitHubRepoCatalog,
} from "./githubIssueStore";
import "./issueViewer.css";

/**
 * One GitHub issue in the issue viewer's layout: the conversation on the left,
 * the properties in a box that floats right and lets the text wrap under it.
 * The same body the Linear view uses, so the two trackers read alike.
 *
 * Editable when `editing.readOnlyReason` is null: status, assignees, labels and
 * milestone are pickers, the title and description edit in place, and the
 * activity has a comment box. Otherwise every control says why it is
 * read-only instead of disappearing.
 */

export type GitHubIssueEditing = {
  /** Null when edits are possible; otherwise why not, shown as a tooltip. */
  readOnlyReason: string | null;
  catalog: GitHubRepoCatalog | null;
  /** Asked for the first time a picker opens, so a read-only look costs nothing. */
  onNeedCatalog: () => void;
  onPatch: (patch: GitHubIssuePatch, optimistic: Partial<GitHubIssueDetail>) => void;
  onSaveTitle: (title: string) => Promise<void>;
  onSaveBody: (body: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
};

type PickerId = "state" | "assignees" | "labels" | "milestone";

function SideRow({
  label,
  children,
  editable,
  readOnlyReason,
  anchorRef,
  onOpen,
}: {
  label: string;
  children: React.ReactNode;
  editable?: boolean;
  readOnlyReason?: string | null;
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
            title={editable ? `Change ${label.toLowerCase()}` : readOnlyReason ?? undefined}
            onClick={onOpen}
            className={cn(
              "-ml-1.5 flex w-[calc(100%+6px)] min-w-0 items-start rounded-md px-1.5 py-1 text-left",
              editable ? "hover:bg-[color:var(--kit-hover)]" : "cursor-default",
            )}
          >
            {children}
          </button>
        ) : (
          <div className="py-1">{children}</div>
        )}
      </dd>
    </div>
  );
}

function People({ people, empty }: { people: GitHubIssueDetail["assignees"]; empty: string }) {
  if (people.length === 0) return <span className="text-[color:var(--kit-text-3)]">{empty}</span>;
  return (
    <span className="flex flex-col gap-1">
      {people.map((entry) => (
        <span key={entry.login} className="flex min-w-0 items-center gap-1.5">
          <LinearAssigneeAvatar name={entry.login} avatarUrl={entry.avatarUrl} size={16} />
          <span className="truncate">{entry.login}</span>
        </span>
      ))}
    </span>
  );
}

function Labels({ labels }: { labels: GitHubIssueDetail["labels"] }) {
  if (labels.length === 0) return <span className="text-[color:var(--kit-text-3)]">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label.name}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-[color:var(--kit-rule)] px-1.5 py-px text-[11px]"
        >
          <span className="block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
    </span>
  );
}

function Activity({
  issue,
  defaultOpen,
  onComment,
  readOnlyReason,
}: {
  issue: GitHubIssueDetail;
  defaultOpen: boolean;
  onComment?: (body: string) => Promise<void>;
  readOnlyReason?: string | null;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [comments, setComments] = useState<GitHubIssueComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const identity = `${issue.owner}/${issue.repo}#${issue.number}`;
  const previous = useRef(identity);
  if (previous.current !== identity) {
    previous.current = identity;
    setComments(null);
    setError(null);
    setExpanded(defaultOpen);
  }

  // The comment count is already on the issue, so an issue nobody commented on
  // costs no read at all.
  const nothingToRead = issue.commentCount === 0;
  // The thread is read again when the issue changes (a Refresh, a comment
  // webhook, a comment posted here): its update time and comment count move.
  // The comments on screen stay until the new read lands.
  const version = `${issue.updatedAt}:${issue.commentCount}`;
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!expanded || error || nothingToRead) return;
    if (comments && loadedVersion === version) return;
    let cancelled = false;
    setLoading(true);
    void loadGitHubIssueComments(issue.owner, issue.repo, issue.number)
      .then((rows) => {
        if (cancelled) return;
        setComments(rows);
        setLoadedVersion(version);
      })
      .catch(() => { if (!cancelled) setError("Couldn't load comments."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [comments, error, expanded, issue.number, issue.owner, issue.repo, loadedVersion, nothingToRead, version]);

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
        {issue.commentCount > 0 ? <span className="kit-num">{issue.commentCount}</span> : null}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-3">
          {nothingToRead && !comments?.length ? (
            <div className="text-[11px] text-[color:var(--kit-text-3)]">No comments yet.</div>
          ) : loading ? (
            <div className="text-[11px] text-[color:var(--kit-text-3)]">Loading comments…</div>
          ) : error ? (
            <div className="text-[11px] text-[color:var(--kit-crit)]">{error}</div>
          ) : (
            (comments ?? []).map((comment) => (
              <article key={comment.id} className="flex gap-2.5">
                <LinearAssigneeAvatar name={comment.author?.login ?? "ghost"} avatarUrl={comment.author?.avatarUrl ?? null} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[11.5px] font-medium text-fg/85">{comment.author?.login ?? "ghost"}</span>
                    <span className="shrink-0 text-[10.5px] text-[color:var(--kit-text-3)]">{formatIssueDate(comment.createdAt)}</span>
                  </div>
                  <div className="mt-0.5">
                    <IssueMarkdown size="comment">{comment.body}</IssueMarkdown>
                  </div>
                </div>
              </article>
            ))
          )}
          <IssueCommentComposer
            readOnlyReason={readOnlyReason}
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

export function GitHubIssueView({
  issue,
  activityDefaultOpen = false,
  sideExtra,
  editing,
}: {
  issue: GitHubIssueDetail;
  activityDefaultOpen?: boolean;
  sideExtra?: React.ReactNode;
  editing?: GitHubIssueEditing;
}) {
  const editable = Boolean(editing && editing.readOnlyReason == null);
  const readOnlyReason = editing?.readOnlyReason ?? null;
  const [openPicker, setOpenPicker] = useState<PickerId | null>(null);
  const stateRef = useRef<HTMLButtonElement>(null);
  const assigneesRef = useRef<HTMLButtonElement>(null);
  const labelsRef = useRef<HTMLButtonElement>(null);
  const milestoneRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpenPicker(null);
  const open = (picker: PickerId) => {
    editing?.onNeedCatalog();
    setOpenPicker(picker);
  };
  const catalog = editing?.catalog ?? null;

  const stateOptions = useMemo<PickerOption[]>(() => [
    { id: "open", label: "Open", icon: <GitHubIssueStateIcon state="open" /> },
    { id: "completed", label: "Close as completed", icon: <GitHubIssueStateIcon state="closed" stateReason="completed" /> },
    { id: "not_planned", label: "Close as not planned", icon: <GitHubIssueStateIcon state="closed" stateReason="not_planned" /> },
  ], []);
  const currentStateId = issue.state === "open" ? "open" : issue.stateReason === "not_planned" ? "not_planned" : "completed";

  // A picked person or label the catalog does not list yet still shows.
  const people = useMemo(() => {
    const byLogin = new Map((catalog?.people ?? []).map((entry) => [entry.login, entry]));
    for (const entry of issue.assignees) if (!byLogin.has(entry.login)) byLogin.set(entry.login, entry);
    return [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));
  }, [catalog?.people, issue.assignees]);
  const labels = useMemo(() => {
    const byName = new Map((catalog?.labels ?? []).map((entry) => [entry.name, entry]));
    for (const entry of issue.labels) if (!byName.has(entry.name)) byName.set(entry.name, entry);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog?.labels, issue.labels]);

  const assigned = new Set(issue.assignees.map((entry) => entry.login));
  const labelled = new Set(issue.labels.map((entry) => entry.name));
  // From the issue itself: the catalog lists open milestones only, and an
  // issue on a closed one must still be able to clear it.
  const currentMilestone = issue.milestoneNumber
    ?? catalog?.milestones.find((entry) => entry.title === issue.milestone)?.number
    ?? null;

  return (
    <div className="ade-issue-view" data-github-issue-view="true">
      <div className="ade-issue-view-grid">
        <aside className="ade-issue-view-side" aria-label="Issue properties">
          <dl>
            <SideRow label="Status" editable={editable} readOnlyReason={readOnlyReason} anchorRef={stateRef} onOpen={() => open("state")}>
              <span className="flex items-center gap-1.5">
                <GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} />
                {githubIssueStateLabel(issue.state, issue.stateReason)}
              </span>
            </SideRow>
            <SideRow label="Assignees" editable={editable} readOnlyReason={readOnlyReason} anchorRef={assigneesRef} onOpen={() => open("assignees")}>
              <People people={issue.assignees} empty="No one" />
            </SideRow>
            <SideRow label="Labels" editable={editable} readOnlyReason={readOnlyReason} anchorRef={labelsRef} onOpen={() => open("labels")}>
              <Labels labels={issue.labels} />
            </SideRow>
            <SideRow label="Milestone" editable={editable} readOnlyReason={readOnlyReason} anchorRef={milestoneRef} onOpen={() => open("milestone")}>
              {issue.milestone ?? <span className="text-[color:var(--kit-text-3)]">None</span>}
            </SideRow>
          </dl>
          <div className="kit-rule my-2" />
          <dl>
            <SideRow label="Repository"><span className="block truncate">{issue.owner}/{issue.repo}</span></SideRow>
            <SideRow label="Author"><People people={issue.author ? [issue.author] : []} empty="Unknown" /></SideRow>
            <SideRow label="Created">{formatIssueDate(issue.createdAt)}</SideRow>
            <SideRow label="Updated">{formatIssueDate(issue.updatedAt)}</SideRow>
            {issue.closedAt ? <SideRow label="Closed">{formatIssueDate(issue.closedAt)}</SideRow> : null}
          </dl>
          {sideExtra}
        </aside>
        <div className="ade-issue-view-head">
          <EditableIssueTitle
            value={issue.title}
            suffix={<span className="ml-1.5 font-normal text-[color:var(--kit-text-3)]">#{issue.number}</span>}
            onSave={editable ? editing?.onSaveTitle : undefined}
            readOnlyReason={readOnlyReason}
          />
        </div>
        <div className="ade-issue-view-body">
          <EditableIssueBody value={issue.body} onSave={editable ? editing?.onSaveBody : undefined} />
          <Activity
            issue={issue}
            defaultOpen={activityDefaultOpen}
            onComment={editable ? editing?.onComment : undefined}
            readOnlyReason={readOnlyReason}
          />
        </div>
      </div>

      {editing ? (
        <>
          <PickerMenu
            open={openPicker === "state"}
            anchorRef={stateRef}
            onClose={close}
            options={stateOptions}
            selectedIds={new Set([currentStateId])}
            placeholder="Change status…"
            onPick={(id) => {
              close();
              if (id === currentStateId) return;
              if (id === "open") {
                editing.onPatch({ state: "open", state_reason: "reopened" }, { state: "open", stateReason: "reopened", closedAt: null });
              } else {
                const reason = id === "not_planned" ? "not_planned" : "completed";
                editing.onPatch({ state: "closed", state_reason: reason }, { state: "closed", stateReason: reason });
              }
            }}
          />
          <PickerMenu
            open={openPicker === "assignees"}
            anchorRef={assigneesRef}
            onClose={close}
            options={githubPersonOptions(people)}
            selectedIds={assigned}
            multi
            placeholder={catalog ? "Assign people…" : "Loading people…"}
            onPick={(login) => {
              const next = assigned.has(login)
                ? issue.assignees.filter((entry) => entry.login !== login)
                : [...issue.assignees, people.find((entry) => entry.login === login) ?? { login, avatarUrl: null }];
              editing.onPatch({ assignees: next.map((entry) => entry.login) }, { assignees: next });
            }}
          />
          <PickerMenu
            open={openPicker === "labels"}
            anchorRef={labelsRef}
            onClose={close}
            options={githubLabelOptions(labels)}
            selectedIds={labelled}
            multi
            placeholder={catalog ? "Add or remove labels…" : "Loading labels…"}
            onPick={(name) => {
              const next = labelled.has(name)
                ? issue.labels.filter((entry) => entry.name !== name)
                : [...issue.labels, labels.find((entry) => entry.name === name) ?? { name, color: null }];
              editing.onPatch({ labels: next.map((entry) => entry.name) }, { labels: next });
            }}
          />
          <PickerMenu
            open={openPicker === "milestone"}
            anchorRef={milestoneRef}
            onClose={close}
            options={[
              { id: "", label: "No milestone" },
              ...(catalog?.milestones ?? []).map((entry) => ({ id: String(entry.number), label: entry.title })),
            ]}
            selectedIds={new Set([currentMilestone == null ? "" : String(currentMilestone)])}
            placeholder={catalog ? "Set milestone…" : "Loading milestones…"}
            onPick={(id) => {
              close();
              const milestone = id ? Number(id) : null;
              if (milestone === currentMilestone) return;
              const title = catalog?.milestones.find((entry) => entry.number === milestone)?.title ?? null;
              editing.onPatch({ milestone }, { milestone: title, milestoneNumber: milestone });
            }}
          />
        </>
      ) : null}
    </div>
  );
}
