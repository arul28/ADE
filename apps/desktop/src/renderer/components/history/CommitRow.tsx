import React, { useEffect, useState } from "react";
import { GitPullRequest } from "@phosphor-icons/react";
import type { GitCommitSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { ProviderLogo } from "../shared/ProviderLogos";
import { HistoryGitContextMenu } from "./HistoryGitContextMenu";
import { CommitRefBadges, type RefBadgeActions } from "./CommitRefBadges";
import { COMMIT_ROW_HEIGHT } from "./commitGraphLayout";
import {
  commitAgentProvider,
  githubAvatarForEmail,
  shortWhen,
  splitPrSuffix,
  type CommitRefBadge,
} from "./commitRowModel";
import { copyText } from "./historyClipboard";
import type { CommitColumns } from "./commitViewPrefs";

function AuthorAvatar({ name, email }: { name: string; email?: string }) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : githubAvatarForEmail(email);
  if (url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-4 w-4 shrink-0 rounded-full"
        style={{ boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-fg) 12%, transparent)" }}
      />
    );
  }
  const letter = name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-fg/[0.08] text-[9px] font-semibold text-fg/70"
    >
      {letter}
    </span>
  );
}

function ShaCell({ commit }: { commit: GitCommitSummary }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy ${commit.sha}`}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(commit.sha).then(() => setCopied(true)).catch(() => {});
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "w-[64px] shrink-0 rounded-[5px] px-1 text-left font-mono text-[11px] tabular-nums transition-colors duration-100",
        copied ? "text-[var(--color-success)]" : "text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg",
      )}
    >
      {copied ? "copied" : commit.shortSha}
    </button>
  );
}

export type RowMenuContext = {
  remoteMachineName: string | null;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  navigate: (path: string) => void;
};

export type RowProps = {
  commit: GitCommitSummary;
  index: number;
  start: number;
  graphWidth: number;
  owner: string;
  selected: boolean;
  /** Base history under a lane's own commits: drawn quieter. */
  muted: boolean;
  /** "hidden": no author column; "blank": same author as the row above. */
  author: "shown" | "blank" | "hidden";
  isHead: boolean;
  /** The lane the row's git actions act on: the lane whose work it is, else the focused lane. */
  actionLaneId: string;
  /** The row is that lane's HEAD. */
  actionIsHead: boolean;
  actionHasWorktree: boolean;
  /** False when the row is on no lane's history the actions could reach. */
  commitOnLaneHistory: boolean;
  badges: CommitRefBadge[] | undefined;
  columns: CommitColumns;
  compact: boolean;
  medium: boolean;
  wide: boolean;
  focusLaneId: string | null;
  menu: RowMenuContext;
  badgeActions: RefBadgeActions;
  colorOfLane: (laneId: string) => string | null;
  ownerOfLane: (laneId: string) => string | null;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onOpenPrNumber: ((pr: number) => void) | null;
};

export const CommitRow = React.memo(function CommitRow({
  commit,
  index,
  start,
  graphWidth,
  owner,
  selected,
  muted,
  author,
  isHead,
  actionLaneId,
  actionIsHead,
  actionHasWorktree,
  commitOnLaneHistory,
  badges,
  columns,
  compact,
  medium,
  wide,
  focusLaneId,
  menu,
  badgeActions,
  colorOfLane,
  ownerOfLane,
  onSelect,
  onOpen,
  onOpenPrNumber,
}: RowProps) {
  const agent = commitAgentProvider(commit);
  const { text, pr } = splitPrSuffix(commit.subject);
  return (
    <HistoryGitContextMenu
      laneId={actionLaneId}
      commit={commit}
      isHead={actionIsHead}
      hasWorktree={actionHasWorktree}
      commitOnLaneHistory={commitOnLaneHistory}
      remoteMachineName={menu.remoteMachineName}
      onNotice={menu.onNotice}
      onError={menu.onError}
      navigate={menu.navigate}
    >
    <div
      role="row"
      aria-selected={selected}
      data-owner={owner}
      data-sha={commit.sha}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onOpen(index)}
      className={cn(
        "chv-row absolute left-0 right-0 flex cursor-default items-center gap-2 pr-2",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
          : "hover:bg-fg/[0.035]",
      )}
      style={{ height: COMMIT_ROW_HEIGHT, transform: `translateY(${start}px)` }}
    >
      {selected ? <span aria-hidden className="absolute bottom-1 left-0 top-1 w-[2px] rounded-r bg-[var(--color-accent)]" /> : null}
      <span className="shrink-0" style={{ width: graphWidth }} />
      <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", muted && !selected ? "opacity-[0.62]" : null)}>
        {badges && badges.length > 0 ? (
          <CommitRefBadges
            badges={badges}
            max={wide ? 2 : 1}
            colorOfLane={colorOfLane}
            ownerOfLane={ownerOfLane}
            focusLaneId={focusLaneId}
            actions={badgeActions}
          />
        ) : null}
        {agent ? (
          <span className="inline-flex shrink-0" title={`Co-authored by ${agent.name}`}>
            <ProviderLogo family={agent.provider} size={13} />
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate text-[12.5px]",
            isHead ? "font-medium text-fg" : "text-fg/90",
          )}
        >
          {text}
        </span>
        {pr != null ? (
          onOpenPrNumber ? (
            <button
              type="button"
              title={`Open PR #${pr}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenPrNumber(pr);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-[5px] px-1 text-[11px] tabular-nums text-muted-fg/80 transition-colors duration-100 hover:bg-fg/[0.06] hover:text-fg"
            >
              <GitPullRequest size={11} aria-hidden />
              {pr}
            </button>
          ) : (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/70">#{pr}</span>
          )
        ) : null}
      </span>
      {columns.author && !compact && author !== "hidden" ? (
        <span
          className={cn("flex shrink-0 items-center gap-1.5 overflow-hidden", medium ? "w-4" : "w-[132px]", muted && !selected ? "opacity-[0.62]" : null)}
          title={commit.authorEmail ? `${commit.authorName} <${commit.authorEmail}>` : commit.authorName}
        >
          {author === "shown" ? (
            <>
              <AuthorAvatar name={commit.authorName} email={commit.authorEmail} />
              {medium ? null : <span className="min-w-0 truncate text-[12px] text-muted-fg">{commit.authorName}</span>}
            </>
          ) : null}
        </span>
      ) : null}
      {columns.date ? (
        <span
          className={cn("w-[52px] shrink-0 text-right text-[11.5px] tabular-nums text-muted-fg/70", muted && !selected ? "opacity-[0.62]" : null)}
          title={new Date(commit.authoredAt).toLocaleString()}
        >
          {shortWhen(commit.authoredAt)}
        </span>
      ) : null}
      {columns.sha && !compact ? <ShaCell commit={commit} /> : null}
    </div>
    </HistoryGitContextMenu>
  );
});
