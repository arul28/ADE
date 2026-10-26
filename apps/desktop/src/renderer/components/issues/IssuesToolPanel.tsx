import React, { useCallback, useEffect } from "react";
import { X } from "@phosphor-icons/react";
import type { AgentChatContextAttachment, OpenProjectBinding } from "../../../shared/types";
import { makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { issueRefKey, issueRefLabel, type IssueRef } from "../../../shared/issueRefs";
import {
  clearPendingIssueToolRequest,
  requestJiraIssuesPaneOpen,
  subscribeIssueToolRequests,
  takePendingIssueToolRequest,
} from "../../lib/issueNavigation";
import { writeIssueContextDrag } from "../../lib/issueDrag";
import { requestLinearPaneOpen } from "../../lib/linearIssueQuickViewNavigation";
import { linearBrowserIssueToLaneIssue } from "../app/linearIssueBrowserModel";
import { LinearMark, LinearStateIcon } from "../lanes/linearBrand";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { JiraMark, JiraStatusIcon } from "../lanes/jiraBrand";
import { GithubLogo } from "@phosphor-icons/react";
import { githubIssueToContextAttachment, useGitHubIssuePeek } from "./githubIssueStore";
import { cn } from "../ui/cn";
import { WorkToolEmptyLine } from "../terminals/workToolChrome";
import { IssueViewer } from "./IssueViewer";
import {
  activateIssueTab,
  closeIssueTab,
  issueTabsScopeKey,
  openIssueTab,
  useIssueTabs,
} from "./issueTabsStore";
import { useActiveProjectRoot } from "../../state/appStore";
import { useLinearIssuePeek } from "./linearIssueStore";
import { jiraIssueToContextAttachment, useJiraIssuePeek } from "./jiraIssueStore";

/**
 * The Issues tool in the Work tools pane: the issues you opened from this
 * lane's chats, one chip each, and the viewer for the one in front.
 *
 * An issue link clicked in a chat lands here (see `issueNavigation`): the Work
 * page reveals this tool, and this panel takes the request — immediately when
 * it is mounted, or on mount when the reveal is what mounted it.
 */
/** Ghost buttons: secondary to nothing, but plainly buttons, not captions. */
const BROWSE_BUTTON_CLASS = [
  "inline-flex h-8 shrink-0 items-center rounded-[8px] border border-fg/[0.12] bg-fg/[0.03] px-3",
  "font-sans text-[12px] font-medium text-fg/80 transition-colors duration-[120ms] ease-out",
  "hover:border-fg/[0.20] hover:bg-fg/[0.07] hover:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
].join(" ");

export function IssuesToolPanel({
  laneId,
  onAttachToChat,
}: {
  laneId: string | null;
  onAttachToChat?: (attachment: AgentChatContextAttachment) => void;
}) {
  const projectRoot = useActiveProjectRoot();
  const scope = issueTabsScopeKey(projectRoot, laneId);
  const tabs = useIssueTabs(scope);
  const { refs, activeKey } = tabs;

  useEffect(() => {
    const pending = takePendingIssueToolRequest();
    if (pending) openIssueTab(scope, pending.ref, pending.pin);
    return subscribeIssueToolRequests((request) => {
      clearPendingIssueToolRequest();
      openIssueTab(scope, request.ref, request.pin);
    });
  }, [scope]);

  const active = refs.find((ref) => issueRefKey(ref) === activeKey) ?? refs[refs.length - 1] ?? null;
  const activePin = active ? tabs.pins?.[issueRefKey(active)] ?? null : null;
  const openRelated = useCallback((ref: IssueRef) => openIssueTab(scope, ref, ref.provider === "jira" ? activePin : null), [activePin, scope]);

  if (!active) {
    return (
      <WorkToolEmptyLine
        title="Issue links you click in chat open here"
        action={(
          <div className="flex items-center gap-2">
            <button type="button" className={BROWSE_BUTTON_CLASS} onClick={() => requestLinearPaneOpen()}>
              Browse Linear
            </button>
            <button type="button" className={BROWSE_BUTTON_CLASS} onClick={() => requestJiraIssuesPaneOpen()}>
              Browse Jira
            </button>
          </div>
        )}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-work-tool="issues">
      <div
        className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-[color:var(--kit-rule)] px-2 py-1.5 [scrollbar-width:none]"
        role="tablist"
        aria-label="Open issues"
      >
        {refs.map((ref) => (
          <IssueTabChip
            key={issueRefKey(ref)}
            issueRef={ref}
            pin={tabs.pins?.[issueRefKey(ref)] ?? null}
            active={issueRefKey(ref) === issueRefKey(active)}
            onSelect={() => activateIssueTab(scope, issueRefKey(ref))}
            onClose={() => closeIssueTab(scope, issueRefKey(ref))}
          />
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <IssueViewer
          key={issueRefKey(active)}
          issueRef={active}
          pin={activePin}
          variant="tool"
          onAttachToChat={onAttachToChat}
          onOpenRelated={openRelated}
        />
      </div>
    </div>
  );
}

function IssueTabChip({
  issueRef,
  pin,
  active,
  onSelect,
  onClose,
}: {
  issueRef: IssueRef;
  pin: OpenProjectBinding | null;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const linearIssue = useLinearIssuePeek(issueRef.provider === "linear" ? issueRef.identifier : null);
  const githubIssue = useGitHubIssuePeek(issueRef.provider === "github" ? { owner: issueRef.owner, repo: issueRef.repo, number: issueRef.number } : null);
  const jiraIssue = useJiraIssuePeek(issueRef.provider === "jira" ? issueRef : null, pin);
  const label = issueRefLabel(issueRef);
  const title = linearIssue?.title ?? githubIssue?.title ?? jiraIssue?.title ?? null;
  const dragAttachment = linearIssue
    ? makeLinearIssueContextAttachment(linearBrowserIssueToLaneIssue(linearIssue))
    : githubIssue && !githubIssue.isPullRequest ? githubIssueToContextAttachment(githubIssue)
      : jiraIssue ? jiraIssueToContextAttachment(jiraIssue, issueRef.provider === "jira" ? issueRef.siteUrl : "") : null;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      draggable={Boolean(dragAttachment)}
      title={title ? `${label} ${title}\nDrag onto the composer to attach it` : label}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onAuxClick={(event) => {
        // Middle-click closes, as in every tabbed surface.
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      onDragStart={(event) => {
        if (!dragAttachment) return;
        writeIssueContextDrag(event.dataTransfer, dragAttachment, `${label} ${title ?? ""}`.trim());
      }}
      className={cn(
        "group flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1 text-[11.5px] transition-colors",
        active
          ? "bg-[color:var(--kit-active)] text-fg"
          : "text-[color:var(--kit-text-2)] hover:bg-[color:var(--kit-hover)] hover:text-fg",
      )}
    >
      {issueRef.provider === "linear" ? <LinearMark size={11} /> : issueRef.provider === "github" ? <GithubLogo size={11} weight="fill" /> : <JiraMark size={11} />}
      {linearIssue ? <LinearStateIcon stateType={linearIssue.stateType} size={10} /> : null}
      {githubIssue ? <GitHubIssueStateIcon state={githubIssue.state} stateReason={githubIssue.stateReason} size={10} /> : null}
      {jiraIssue ? <JiraStatusIcon category={jiraIssue.status.category} size={10} /> : null}
      <span className="kit-num">{label}</span>
      <button
        type="button"
        aria-label={`Close ${label}`}
        className={cn(
          "grid h-4 w-4 place-items-center rounded text-[color:var(--kit-text-3)] hover:bg-[color:var(--kit-active)] hover:text-fg",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <X size={9} weight="bold" />
      </button>
    </div>
  );
}
