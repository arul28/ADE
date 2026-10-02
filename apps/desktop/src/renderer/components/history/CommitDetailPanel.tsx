import React, { useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChatCircleText,
  Cloud,
  CloudSlash,
  Copy,
  DotsThree,
  FileText,
  GitCommit,
  GitPullRequest,
  X,
} from "@phosphor-icons/react";
import type { GitCommitSummary, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import type { TimelineEvent } from "./timelineTypes";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import { LaneChip } from "../terminals/LaneChip";
import { ProviderLogo } from "../shared/ProviderLogos";
import { getFileIcon } from "../files/filePresentation";
import { lanePrTagRoutePath } from "../lanes/lanePageModel";
import { boundMachineLanePrs, useLanePrsByLaneId } from "../terminals/useLanePrs";
import { laneHistorySessionsFrom, useLaneSessions } from "../lanes/overview/useLaneOverviewData";
import { formatDate, relativeWhen } from "../../lib/format";
import {
  buildCommitContextActions,
  groupCommitContextActions,
  runHistoryGitAction,
  type HistoryGitActionId,
} from "./historyGitActions";
import {
  commitAgentProvider,
  findCommitSession,
  githubAvatarForEmail,
  githubRepoFromRemote,
  reflowCommitBody,
  splitPrSuffix,
} from "./commitRowModel";
import { PR_STATE_COLOR } from "./CommitRefBadges";

function copyText(text: string) {
  void window.ade.app.writeClipboardText(text).catch(() => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  });
}

function stripIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
}

const FILE_ROWS = 200;

type CommitDetailPanelProps = {
  laneId: string | null;
  /** The lane's machine when it is not this tab's (null: the tab's machine). */
  pin?: OpenProjectBinding | null;
  remoteMachineName?: string | null;
  /** The lane's machine id when it is not this tab's, so "go to lane" opens it there. */
  laneMachineId?: string | null;
  laneHasWorktree?: boolean;
  commit: GitCommitSummary | null;
  /** When false, commit was resolved outside this lane's history — block lane git mutations. */
  commitOnLaneHistory?: boolean;
  /** The lane whose work this commit is, when known; else the focused lane. */
  ownerLane?: LaneSummary | null;
  ownerLaneColor?: string | null;
  relatedEvents: TimelineEvent[];
  onClose: () => void;
  onNavigateToLane?: (laneId: string, machineId?: string | null) => void;
  onOpenChanges?: (commit: GitCommitSummary, path?: string | null) => void;
  onSelectSha?: (sha: string) => void;
  /** Activity, with this event selected. */
  onOpenEvent?: (eventId: string) => void;
  navigate?: (path: string) => void;
};

const ROW = "flex min-w-0 items-center gap-2 text-[12.5px]";
const LINK = "inline-flex min-w-0 items-center gap-1 rounded-[5px] px-1 -mx-1 text-fg/85 transition-colors duration-100 hover:bg-white/[0.06] hover:text-fg";
const BUTTON = cn(
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-medium",
  "bg-white/[0.05] text-fg/85 transition-colors duration-100 hover:bg-white/[0.09] hover:text-fg",
  "disabled:pointer-events-none disabled:opacity-40",
);
const MENU_ITEM = cn(
  "flex cursor-pointer select-none items-center rounded-[6px] px-2 py-1.5 text-[12px] outline-none",
  "data-[highlighted]:bg-white/[0.07] data-[disabled]:cursor-default data-[disabled]:opacity-40",
);

export function CommitDetailPanel({
  laneId,
  pin = null,
  remoteMachineName = null,
  laneMachineId = null,
  laneHasWorktree = false,
  commit,
  commitOnLaneHistory = true,
  ownerLane = null,
  ownerLaneColor = null,
  relatedEvents,
  onClose,
  onNavigateToLane,
  onOpenChanges,
  onSelectSha,
  onOpenEvent,
  navigate,
}: CommitDetailPanelProps) {
  const [fullMessage, setFullMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [repo, setRepo] = useState<{ owner: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [resolvedCommit, setResolvedCommit] = useState<GitCommitSummary | null>(commit);

  useEffect(() => {
    setResolvedCommit(commit);
  }, [commit]);

  // A commit deep link may arrive with only a sha; fill in the rest.
  useEffect(() => {
    if (!laneId || !commit?.sha || (commit.subject && commit.authorName)) return;
    let cancelled = false;
    void window.ade.git.getCommit({ laneId, commitSha: commit.sha }, pin)
      .then((found) => {
        if (!cancelled && found) setResolvedCommit(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [laneId, commit, pin]);

  useEffect(() => {
    if (!laneId) {
      setHeadSha(null);
      return;
    }
    let cancelled = false;
    void window.ade.git.listRecentCommits({ laneId, limit: 1 }, pin)
      .then((rows) => {
        if (!cancelled) setHeadSha(rows[0]?.sha ?? null);
      })
      .catch(() => {
        if (!cancelled) setHeadSha(null);
      });
    void window.ade.git.getOriginRemote({ laneId }, pin)
      .then((remote) => {
        if (!cancelled) setRepo(githubRepoFromRemote(remote.remoteUrl));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [laneId, pin]);

  const sha = resolvedCommit?.sha ?? null;
  useEffect(() => {
    if (!laneId || !sha) {
      setFullMessage(null);
      setFiles(null);
      return;
    }
    let cancelled = false;
    setFullMessage(null);
    setFiles(null);
    void window.ade.git.getCommitMessage({ laneId, commitSha: sha }, pin)
      .then((msg) => {
        if (!cancelled) setFullMessage(msg.trim());
      })
      .catch(() => {});
    void window.ade.git.listCommitFiles({ laneId, commitSha: sha }, pin)
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, sha, pin]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 5000 : 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const agent = resolvedCommit ? commitAgentProvider(resolvedCommit) : null;
  // The chat that made it: only looked up for a commit an agent co-authored.
  const sessionLaneId = agent ? ownerLane?.id ?? laneId : null;
  const sessions = useLaneSessions(sessionLaneId, "", pin);
  const chat = useMemo(() => {
    if (!agent || !resolvedCommit || !sessionLaneId) return null;
    const candidates = laneHistorySessionsFrom(sessionLaneId, sessions.chats, sessions.terminals);
    return findCommitSession(candidates, resolvedCommit, agent.provider);
  }, [agent, resolvedCommit, sessionLaneId, sessions.chats, sessions.terminals]);

  const lanePrMap = useLanePrsByLaneId();
  const subjectPr = resolvedCommit ? splitPrSuffix(resolvedCommit.subject) : { text: "", pr: null };
  const lanePr = ownerLane && !pin && ownerLane.laneType !== "primary"
    ? boundMachineLanePrs(lanePrMap, ownerLane.id)[0] ?? null
    : null;
  const pr = lanePr
    ? { number: lanePr.githubPrNumber, title: lanePr.title, state: lanePr.state, linkedPrId: lanePr.unmapped ? null : lanePr.id, owner: lanePr.repoOwner, name: lanePr.repoName }
    : subjectPr.pr != null && repo
      ? { number: subjectPr.pr, title: null, state: "merged" as const, linkedPrId: null, owner: repo.owner, name: repo.name }
      : null;

  const actions = useMemo(
    () =>
      resolvedCommit
        ? buildCommitContextActions({
            commit: resolvedCommit,
            isHead: headSha === resolvedCommit.sha,
            hasWorktree: Boolean(laneId) && laneHasWorktree,
            commitOnLaneHistory,
            remoteMachineName,
          })
        : [],
    [headSha, laneHasWorktree, resolvedCommit, laneId, commitOnLaneHistory, remoteMachineName],
  );
  const groups = useMemo(() => groupCommitContextActions(actions), [actions]);
  const createLane = actions.find((action) => action.id === "create_lane") ?? null;

  const runAction = (actionId: HistoryGitActionId) => {
    if (!laneId || !resolvedCommit) return;
    setNotice(null);
    void runHistoryGitAction({
      actionId,
      laneId,
      commit: resolvedCommit,
      navigate,
      onNotice: (message) => setNotice({ text: message, error: false }),
      onError: (message) => setNotice({ text: stripIpcError(message), error: true }),
    });
  };

  const openChat = () => {
    if (!chat || !sessionLaneId) return;
    window.dispatchEvent(new CustomEvent("ade:work:select-session", {
      detail: { sessionId: chat.sessionId, laneId: sessionLaneId, ...(pin ? { binding: pin } : {}) },
    }));
    navigate?.(`/work?${new URLSearchParams({ sessionId: chat.sessionId, laneId: sessionLaneId }).toString()}`);
  };

  const openPr = () => {
    if (!pr) return;
    const path = lanePrTagRoutePath({
      linkedPrId: pr.linkedPrId,
      githubPrNumber: pr.number,
      repoOwner: pr.owner,
      repoName: pr.name,
    });
    if (path) navigate?.(path);
  };

  if (!resolvedCommit || !laneId) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-fg/50" data-testid="commit-detail-empty">
        No commit selected
      </div>
    );
  }

  const message = fullMessage ?? resolvedCommit.subject;
  const newline = message.indexOf("\n");
  const title = splitPrSuffix(newline >= 0 ? message.slice(0, newline) : message).text;
  const body = newline >= 0
    ? reflowCommitBody(message.slice(newline + 1).replace(/^\s*co-authored-by:.*$/gim, "").trim())
    : "";
  const avatar = githubAvatarForEmail(resolvedCommit.authorEmail);
  const owner = ownerLane;

  return (
    <div key={resolvedCommit.sha} className="flex h-full min-h-0 flex-col" data-testid="commit-detail">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.06] pl-3 pr-1.5">
        <GitCommit size={14} weight="bold" className="shrink-0 text-muted-fg" aria-hidden />
        <button
          type="button"
          title={`Copy ${resolvedCommit.sha}`}
          onClick={() => {
            copyText(resolvedCommit.sha);
            setNotice({ text: "SHA copied", error: false });
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1 font-mono text-[12px] text-fg/85 transition-colors duration-100 hover:bg-white/[0.06] hover:text-fg"
        >
          {resolvedCommit.shortSha}
          <Copy size={11} className="opacity-50" aria-hidden />
        </button>
        {owner ? (
          <LaneChip
            laneName={owner.name}
            laneColor={ownerLaneColor}
            maxWidth={200}
            className="ml-1"
            onClick={onNavigateToLane ? () => onNavigateToLane(owner.id, laneMachineId) : undefined}
            title={`Open ${owner.name} in Lanes`}
          />
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-fg transition-colors duration-100 hover:bg-white/[0.06] hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-4 pb-6 pt-4">
          <div className="flex flex-col gap-2">
            <h2 className="m-0 text-[14px] font-semibold leading-snug text-fg">{title}</h2>
            {body ? (
              <p className="m-0 max-h-60 overflow-y-auto whitespace-pre-line text-[12.5px] leading-relaxed text-fg/70">{body}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className={ROW} title={resolvedCommit.authorEmail ?? undefined}>
              {avatar ? (
                <img src={avatar} alt="" className="h-4 w-4 shrink-0 rounded-full" />
              ) : (
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[9px] font-semibold text-fg/70">
                  {resolvedCommit.authorName.charAt(0).toUpperCase() || "?"}
                </span>
              )}
              <span className="min-w-0 truncate text-fg/85">{resolvedCommit.authorName || "Unknown"}</span>
              <span className="shrink-0 text-muted-fg/70" title={formatDate(resolvedCommit.authoredAt)}>
                {relativeWhen(resolvedCommit.authoredAt)}
              </span>
            </div>
            {agent ? (
              <div className={ROW}>
                <span className="inline-flex w-4 shrink-0 justify-center"><ProviderLogo family={agent.provider} size={14} /></span>
                <span className="shrink-0 text-fg/85">{agent.name}</span>
                {chat ? (
                  <button type="button" onClick={openChat} className={cn(LINK, "text-muted-fg")} title="Open the chat that was running when this was committed">
                    <ChatCircleText size={13} className="shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{chat.title ?? "Chat"}</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {pr ? (
              <div className={ROW}>
                <span className="inline-flex w-4 shrink-0 justify-center">
                  <GitPullRequest size={14} weight="bold" style={{ color: PR_STATE_COLOR[pr.state] }} aria-hidden />
                </span>
                <button type="button" onClick={openPr} className={LINK} title={`Open PR #${pr.number}`}>
                  <span className="shrink-0 tabular-nums">#{pr.number}</span>
                  {pr.title ? <span className="min-w-0 truncate text-muted-fg">{pr.title}</span> : null}
                </button>
              </div>
            ) : null}
            <div className={cn(ROW, "text-muted-fg")}>
              <span className="inline-flex w-4 shrink-0 justify-center">
                {resolvedCommit.pushed ? <Cloud size={14} aria-hidden /> : <CloudSlash size={14} aria-hidden />}
              </span>
              <span className="shrink-0">{resolvedCommit.pushed ? "Pushed" : "Not pushed"}</span>
              {resolvedCommit.parents.length > 0 ? (
                <>
                  <span aria-hidden className="text-muted-fg/40">·</span>
                  <span className="shrink-0">{resolvedCommit.parents.length > 1 ? "Parents" : "Parent"}</span>
                  {resolvedCommit.parents.map((parent) => (
                    <button
                      key={parent}
                      type="button"
                      onClick={() => onSelectSha?.(parent)}
                      className={cn(LINK, "font-mono text-[11.5px]")}
                      title={parent}
                    >
                      {parent.slice(0, 7)}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {onOpenChanges ? (
              <button type="button" className={BUTTON} onClick={() => onOpenChanges(resolvedCommit)} title="Open the changes (Enter)">
                <FileText size={13} aria-hidden />
                Changes
              </button>
            ) : null}
            {createLane ? (
              <button
                type="button"
                className={BUTTON}
                disabled={createLane.disabled}
                title={createLane.disabledReason}
                onClick={() => runAction("create_lane")}
              >
                Create lane here
              </button>
            ) : null}
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <button type="button" className={cn(BUTTON, "w-7 justify-center px-0")} aria-label="More commit actions" title="More commit actions">
                  <DotsThree size={16} weight="bold" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  collisionPadding={8}
                  className="max-h-[min(70vh,560px)] min-w-[220px] overflow-y-auto rounded-[9px] border border-white/[0.08] bg-[var(--color-card)] p-1 shadow-xl"
                  style={{ zIndex: Z_LAYERS.popover }}
                >
                  {groups.map((group, index) => (
                    <React.Fragment key={group.id}>
                      {index > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-white/[0.06]" /> : null}
                      <DropdownMenu.Label className="px-2 pb-0.5 pt-1 text-[11px] text-muted-fg">{group.label}</DropdownMenu.Label>
                      {group.actions.map((action) => (
                        <DropdownMenu.Item
                          key={action.id}
                          disabled={action.disabled}
                          title={action.disabledReason}
                          className={cn(MENU_ITEM, action.destructive ? "text-[var(--color-error)]" : "text-fg")}
                          onSelect={() => runAction(action.id)}
                        >
                          {action.label}
                        </DropdownMenu.Item>
                      ))}
                    </React.Fragment>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {notice ? (
              <span
                className={cn("min-w-0 truncate text-[12px]", notice.error ? "text-[var(--color-error)]" : "text-muted-fg")}
                title={notice.text}
              >
                {notice.text}
              </span>
            ) : null}
          </div>

          <section className="flex min-w-0 flex-col">
            <header className="flex h-6 items-center gap-1.5">
              <h3 className="m-0 text-[12px] font-medium text-muted-fg">Files</h3>
              {files ? <span className="text-[12px] tabular-nums text-muted-fg/50">{files.length}</span> : null}
            </header>
            <div className="mt-1 flex min-w-0 flex-col">
              {files == null ? (
                <span className="py-1 text-[12px] text-muted-fg/60">Loading…</span>
              ) : files.length === 0 ? (
                <span className="py-1 text-[12px] text-muted-fg/60">No file changes</span>
              ) : (
                files.slice(0, FILE_ROWS).map((path) => {
                  const slash = path.lastIndexOf("/");
                  const name = slash >= 0 ? path.slice(slash + 1) : path;
                  const dir = slash >= 0 ? path.slice(0, slash) : "";
                  const { icon: FileIcon, color } = getFileIcon(name);
                  return (
                    <button
                      key={path}
                      type="button"
                      title={path}
                      onClick={() => onOpenChanges?.(resolvedCommit, path)}
                      className="-mx-2 flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px] text-fg/85 transition-colors duration-100 hover:bg-white/[0.05]"
                    >
                      <FileIcon size={13} className="shrink-0" style={{ color }} aria-hidden />
                      <span className="max-w-[calc(100%-21px)] shrink-0 truncate">{name}</span>
                      {dir ? <span className="min-w-0 truncate text-muted-fg/60">{dir}</span> : null}
                    </button>
                  );
                })
              )}
              {files && files.length > FILE_ROWS && onOpenChanges ? (
                <button type="button" className="mt-1 self-start text-[12px] text-muted-fg hover:text-fg" onClick={() => onOpenChanges(resolvedCommit)}>
                  {files.length - FILE_ROWS} more in Changes
                </button>
              ) : null}
            </div>
          </section>

          {relatedEvents.length > 0 ? (
            <section className="flex min-w-0 flex-col">
              <header className="flex h-6 items-center gap-1.5">
                <h3 className="m-0 text-[12px] font-medium text-muted-fg">ADE activity</h3>
                <span className="text-[12px] tabular-nums text-muted-fg/50">{relatedEvents.length}</span>
              </header>
              <div className="mt-1 flex flex-col">
                {relatedEvents.slice(0, 8).map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    disabled={!onOpenEvent}
                    onClick={() => onOpenEvent?.(event.id)}
                    title="Show in Activity"
                    className="-mx-2 flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors duration-100 enabled:hover:bg-white/[0.05]"
                  >
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: event.color }} />
                    <span className="min-w-0 flex-1 truncate text-fg/85">{event.label}</span>
                    <span className="shrink-0 text-muted-fg/60" title={formatDate(event.startedAt)}>{relativeWhen(event.startedAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

        </div>
      </div>
    </div>
  );
}
