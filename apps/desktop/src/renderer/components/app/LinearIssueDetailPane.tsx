import React, { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CircleNotch,
  Plus,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  LinearIssueRef,
} from "../../../shared/types";
import { resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import { openLinkFromUi } from "../../lib/openExternal";
import { buildChatMarkdownComponents } from "../chat/chatMarkdown";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { BranchIcon } from "../ui/vcsIcons";
import { LinearStateIcon } from "../lanes/linearBrand";
import { issueProjectLabel, issueUpdatedLabel } from "../lanes/linearIssueDisplay";
import { LinearConflictBadge } from "./LinearIssueBrowserRows";
import { LinearIssuePropertyBar } from "./LinearIssuePropertyPickers";
import {
  isNormalizedIssue,
  type BrowserIssue,
  type LinearIssueEdit,
} from "./linearIssueBrowserModel";

function formatDate(value: string | null | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function openIssueUrl(url: string | null | undefined): void {
  if (url) void window.ade?.app?.openExternal?.(url);
}

// Reuse the app's chat markdown stack (Shiki code, scrollable tables, wrapped
// text) for issue descriptions, but with clean document-style headings instead
// of the chat surface's mono/uppercase ones, and Linear-accent links that open
// in the ADE browser.
const LINEAR_MARKDOWN_COMPONENTS: Components = buildChatMarkdownComponents("neutral", {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-[15px] font-semibold leading-snug text-fg/95 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-[13.5px] font-semibold leading-snug text-fg/90 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-[12.5px] font-semibold leading-snug text-fg/85 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-fg/80 first:mt-0">{children}</h4>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (typeof href === "string" && href.trim() !== "") {
          openLinkFromUi(href, event);
        }
      }}
      className="font-medium text-[color:var(--color-accent,#A78BFA)] underline underline-offset-2 transition-opacity hover:opacity-80"
    >
      {children}
    </a>
  ),
  img: (props) => {
    const { src, alt, title } = props as { src?: string; alt?: string; title?: string };
    if (!src) return null;
    return (
      <img
        src={src}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        className="my-2 max-w-full rounded-md border border-white/10"
      />
    );
  },
});

function LinearMarkdown({ children }: { children: string }) {
  return (
    <div className="text-[12.5px] leading-relaxed text-fg/85 [--chat-font-size:13px] [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={LINEAR_MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function PropRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3 py-[5px]">
      <dt className="text-[11px] text-muted-fg/45">{label}</dt>
      <dd className="min-w-0 text-[12px]">
        {children ?? <span className="block truncate text-fg/85" title={value}>{value}</span>}
      </dd>
    </div>
  );
}

function IssueMetadata({ issue, branchName }: { issue: BrowserIssue; branchName: string | null }) {
  const normalized = isNormalizedIssue(issue) ? issue : null;
  return (
    <dl className="mt-5 border-t border-white/[0.06] pt-3">
      <PropRow label="Project" value={issueProjectLabel(issue)} />
      <PropRow label="Team" value={issue.teamName ?? issue.teamKey} />
      {normalized?.cycleName ? <PropRow label="Cycle" value={normalized.cycleName} /> : null}
      <PropRow label="Creator" value={issue.creatorName ?? "Unknown"} />
      {issue.estimate != null ? <PropRow label="Estimate" value={String(issue.estimate)} /> : null}
      {issue.dueDate ? <PropRow label="Due" value={formatDate(issue.dueDate)} /> : null}
      <PropRow label="Created" value={formatDate(issue.createdAt)} />
      <PropRow label="Updated" value={issueUpdatedLabel(issue)} />
      {normalized?.startedAt ? <PropRow label="Started" value={formatDate(normalized.startedAt)} /> : null}
      {normalized?.completedAt ? <PropRow label="Completed" value={formatDate(normalized.completedAt)} /> : null}
      {normalized?.canceledAt ? <PropRow label="Canceled" value={formatDate(normalized.canceledAt)} /> : null}
      {branchName ? (
        <PropRow label="Branch">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg/80">
            <BranchIcon size={11} className="shrink-0" />
            <span className="truncate" title={branchName}>{branchName}</span>
          </span>
        </PropRow>
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
      <div className={cn("mb-0.5 text-[11px]", tone === "warning" ? "text-amber-300/80" : "text-muted-fg/50")}>
        {title}
        <span className="ml-1 tabular-nums text-muted-fg/40">{refs.length}</span>
      </div>
      {refs.map((ref) => (
        <button
          key={ref.id}
          type="button"
          disabled={!onOpenIssue}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04] disabled:hover:bg-transparent"
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
    <section className="mt-5 border-t border-white/[0.06] pt-3" data-linear-relations="true">
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

function ActivitySection({ issueId }: { issueId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<CtoLinearIssueComment[] | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const prevIssueIdRef = useRef(issueId);

  if (prevIssueIdRef.current !== issueId) {
    prevIssueIdRef.current = issueId;
    setComments(null);
    setCommentError(null);
    setExpanded(false);
  }

  useEffect(() => {
    if (!expanded || comments || commentError) return;
    let cancelled = false;
    setLoading(true);
    const fn = window.ade?.cto?.getLinearIssueComments;
    if (!fn) { setLoading(false); setComments([]); return; }
    void fn({ issueId })
      .then((result) => { if (!cancelled) setComments(result ?? []); })
      .catch(() => { if (!cancelled) setCommentError("Failed to load comments"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, issueId, comments, commentError]);

  return (
    <div className="mt-4">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-fg/65 transition-colors hover:text-fg/80"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Activity
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-1">
          {loading ? (
            <div className="text-[10px] text-muted-fg/40">Loading...</div>
          ) : commentError ? (
            <div className="text-[10px] text-red-400/70">{commentError}</div>
          ) : comments && comments.length > 0 ? (
            comments.map((comment) => (
              <div key={comment.id} className="rounded-md border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-fg/80">{comment.userDisplayName || comment.userName}</span>
                  <span className="text-[10px] text-muted-fg/40">{formatDate(comment.createdAt)}</span>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-fg/70">
                  {comment.body}
                </div>
              </div>
            ))
          ) : (
            <div className="text-[10px] text-muted-fg/40">No comments</div>
          )}
        </div>
      )}
    </div>
  );
}

function ConflictNote({ conflict }: { conflict: IssueConflict }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[10.5px] leading-snug text-[color:rgba(196,181,253,0.95)]">
      <Warning size={12} className="shrink-0" />
      <span className="min-w-0 truncate">
        {conflict.reason === "lane" ? "Already has a lane" : "Already has an agent"}
        {conflict.laneName ? ` (“${conflict.laneName}”)` : ""}. You can attach it again.
      </span>
    </div>
  );
}

function OpenInLinearButton({ url }: { url: string | null | undefined }) {
  if (!url) return null;
  return (
    <button
      type="button"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-white/[0.07] text-muted-fg/70 transition-colors hover:border-white/[0.14] hover:bg-white/[0.04] hover:text-fg"
      aria-label="Open in Linear"
      title="Open in Linear"
      onClick={() => openIssueUrl(url)}
    >
      <ArrowSquareOut size={14} />
    </button>
  );
}

function DockButton({
  primary = false,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <Button
      type="button"
      variant={primary ? "primary" : "outline"}
      casing="sentence"
      className={cn("shrink-0 gap-1.5 px-3", className)}
      {...rest}
    />
  );
}

const DOCK_CLASS = "shrink-0 border-t border-white/10 bg-[color:color-mix(in_srgb,var(--ade-shell-surface,#121019)_92%,black_8%)] px-4 py-2.5";

export function LinearIssueDetails({
  issue,
  catalog,
  actionLabel,
  actionBusyLabel,
  actionIcon,
  actionBusy,
  actionDisabled,
  showBranchPreview,
  onIssueAction,
  conflict,
  onLaunch,
  onEdit,
  editPending,
  onOpenIssue,
  loadingIssueId,
}: {
  issue: BrowserIssue | null;
  catalog: CtoGetLinearIssuePickerDataResult;
  actionLabel: string;
  actionBusyLabel?: string;
  actionIcon?: React.ReactNode;
  actionBusy: boolean;
  actionDisabled: boolean;
  showBranchPreview: boolean;
  onIssueAction: (issue: BrowserIssue) => void | Promise<void>;
  conflict?: IssueConflict | null;
  onLaunch?: (issues: BrowserIssue[], options: { laneOnly?: boolean }) => void;
  onEdit?: (issue: BrowserIssue, edit: LinearIssueEdit) => void;
  editPending?: boolean;
  onOpenIssue?: (ref: LinearIssueRef) => void;
  loadingIssueId: string | null;
}) {
  if (!issue) {
    return (
      <aside className="grid min-h-0 place-items-center overflow-hidden px-4 py-8 text-center text-[12px] text-muted-fg/55">
        Select an issue to preview it.
      </aside>
    );
  }

  const branchName = showBranchPreview ? resolveLinearIssueBranchName(issue) : null;
  const description = issue.description?.trim() ?? "";
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden bg-black/[0.08]">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5" data-linear-pane="issue-details">
        <div className="flex items-center gap-2">
          {issue.url ? (
            <a
              href={issue.url}
              onClick={(e) => { e.preventDefault(); openIssueUrl(issue.url); }}
              className="cursor-pointer font-mono text-[11px] text-muted-fg/55 transition-colors hover:text-fg/85"
              title="Open in Linear"
            >
              {issue.identifier}
            </a>
          ) : (
            <span className="font-mono text-[11px] text-muted-fg/55">{issue.identifier}</span>
          )}
          {conflict ? <LinearConflictBadge conflict={conflict} /> : null}
        </div>
        <div className="mt-1.5 text-[19px] font-semibold leading-tight tracking-[-0.01em] text-fg/95">{issue.title}</div>

        <div className="mt-3">
          <LinearIssuePropertyBar
            issue={issue}
            catalog={catalog}
            pending={editPending}
            onEdit={onEdit ? (edit) => onEdit(issue, edit) : undefined}
          />
        </div>

        {description ? (
          <div className="mt-4">
            <LinearMarkdown>{description}</LinearMarkdown>
          </div>
        ) : (
          <p className="mt-4 text-[12.5px] italic text-muted-fg/40">No description.</p>
        )}

        <IssueRelations issue={issue} onOpenIssue={onOpenIssue} loadingIssueId={loadingIssueId} />

        <IssueMetadata issue={issue} branchName={branchName} />

        <ActivitySection issueId={issue.id} />
      </div>

      <div className={DOCK_CLASS} data-linear-action-dock="true">
        {conflict && onLaunch ? <ConflictNote conflict={conflict} /> : null}
        <div className="flex items-center gap-1.5">
          {onLaunch ? (
            <>
              <DockButton primary onClick={() => onLaunch([issue], { laneOnly: false })} title="New lane with this issue, plus an agent kicked off on it (Enter)">
                <Sparkle size={13} weight="fill" />
                Launch agent
              </DockButton>
              <DockButton
                aria-label="Create lane only"
                title="New lane with this issue linked. Start an agent later."
                onClick={() => onLaunch([issue], { laneOnly: true })}
              >
                <Plus size={13} weight="bold" />
                Lane only
              </DockButton>
            </>
          ) : (
            <DockButton
              primary
              disabled={actionBusy || actionDisabled}
              onClick={() => void onIssueAction(issue)}
            >
              {actionBusy ? <CircleNotch size={13} className="animate-spin" /> : actionIcon ?? <Plus size={13} />}
              {actionBusy ? actionBusyLabel ?? actionLabel : actionLabel}
            </DockButton>
          )}
          <span className="flex-1" />
          <OpenInLinearButton url={issue.url} />
        </div>
      </div>
    </aside>
  );
}

export function LinearBatchActionView({
  selectedIssues,
  onClearSelection,
  conflicts,
  onLaunch,
}: {
  selectedIssues: BrowserIssue[];
  onClearSelection: () => void;
  conflicts?: Map<string, IssueConflict>;
  onLaunch: (issues: BrowserIssue[], options: { laneOnly?: boolean }) => void;
}) {
  const conflictCount = conflicts
    ? selectedIssues.reduce((count, issue) => (conflicts.has(issue.id) ? count + 1 : count), 0)
    : 0;
  const noun = selectedIssues.length === 1 ? "issue" : "issues";

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-linear-pane="issue-details">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-fg/90">{selectedIssues.length} {noun} selected</span>
          <button type="button" className="text-[10px] text-muted-fg/50 transition-colors hover:text-fg/80" onClick={onClearSelection}>
            Clear
          </button>
        </div>
        {conflictCount > 0 ? (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-[color:rgba(167,139,250,0.22)] bg-[color:rgba(167,139,250,0.08)] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[color:rgba(196,181,253,0.95)]">
            <Warning size={12} className="mt-px shrink-0" />
            <span>
              {conflictCount === 1 ? "1 issue is" : `${conflictCount} issues are`} already attached to a lane. You can attach again — we&apos;ll confirm first.
            </span>
          </div>
        ) : null}
        <div className="mt-2 space-y-1">
          {selectedIssues.map((issue) => {
            const issueConflict = conflicts?.get(issue.id) ?? null;
            return (
              <div key={issue.id} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1">
                <LinearStateIcon stateType={issue.stateType} size={11} />
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">{issue.identifier}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg/70">{issue.title}</span>
                {issueConflict ? <LinearConflictBadge conflict={issueConflict} /> : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className={DOCK_CLASS} data-linear-action-dock="true">
        <div className="flex items-center gap-1.5">
          <DockButton primary onClick={() => onLaunch(selectedIssues, { laneOnly: false })} title="A lane and an agent per issue (Enter)">
            <Sparkle size={13} weight="fill" />
            {`Launch ${selectedIssues.length} ${selectedIssues.length === 1 ? "agent" : "agents"}`}
          </DockButton>
          <DockButton
            aria-label={`Create lanes only for ${selectedIssues.length} ${noun}`}
            title="A lane per issue; start agents later."
            onClick={() => onLaunch(selectedIssues, { laneOnly: true })}
          >
            <Plus size={13} weight="bold" />
            Lanes only
          </DockButton>
        </div>
      </div>
    </aside>
  );
}
