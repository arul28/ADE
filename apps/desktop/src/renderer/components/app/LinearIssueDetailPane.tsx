import React from "react";
import {
  ArrowSquareOut,
  CircleNotch,
  Plus,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import type {
  CtoGetLinearIssuePickerDataResult,
  LinearIssueRef,
} from "../../../shared/types";
import { resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { LinearStateIcon } from "../lanes/linearBrand";
import { LinearConflictBadge } from "./LinearIssueBrowserRows";
import { LinearIssueView } from "../issues/LinearIssueView";
import type { BrowserIssue, LinearIssueEdit } from "./linearIssueBrowserModel";

function openIssueUrl(url: string | null | undefined): void {
  if (url) void window.ade?.app?.openExternal?.(url);
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
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-fg/[0.07] text-muted-fg/70 transition-colors hover:border-fg/[0.14] hover:bg-fg/[0.04] hover:text-fg"
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

const DOCK_CLASS = "shrink-0 border-t border-fg/10 bg-[color:color-mix(in_srgb,var(--ade-shell-surface,#121019)_92%,black_8%)] px-4 py-2.5";

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
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden bg-black/[0.08]">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <LinearIssueView
          issue={issue}
          catalog={catalog}
          editPending={editPending}
          onEdit={onEdit ? (edit) => onEdit(issue, edit) : undefined}
          onOpenIssue={onOpenIssue}
          loadingIssueId={loadingIssueId}
          branchName={branchName}
          onSaveTitle={onEdit ? async (title) => onEdit(issue, { title }) : undefined}
          onSaveDescription={onEdit ? async (description) => onEdit(issue, { description }) : undefined}
          onComment={typeof window.ade?.cto?.createLinearIssueComment === "function"
            ? async (body) => {
              await window.ade.cto?.createLinearIssueComment({ issueId: issue.id, body });
            }
            : undefined}
          aboveTitle={(
            <>
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
            </>
          )}
        />
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
              <div key={issue.id} className="flex items-center gap-2 rounded-md bg-fg/[0.03] px-2 py-1">
                <LinearStateIcon stateType={issue.stateType} size={11} />
                <span className="rounded bg-fg/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">{issue.identifier}</span>
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
