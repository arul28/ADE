import React, { useState } from "react";
import { ArrowClockwise, ArrowSquareOut, ChatCircleText, CircleNotch, DotsThree, Plus, Sparkle, X } from "@phosphor-icons/react";
import type { AgentChatContextAttachment, LaneSummary } from "../../../shared/types";
import type { IssueRef } from "../../../shared/issueRefs";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { navigateToAppTarget, openExternalUrl } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { Button } from "../ui/Button";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../ui/ContextMenu";
import { Banner } from "../ui/notice";
import { BranchIcon } from "../ui/vcsIcons";

/**
 * Chrome every issue provider's viewer shares: the props a host passes, the
 * frame (header, scrolling body, action dock), the 40px header, the
 * "last copy" banner, copy-with-toast, and the "Linked in ADE" lane list.
 */
export type IssueViewerProps = {
  issueRef: IssueRef;
  /**
   * `tool` lives in the Work tools pane, `sheet` floats over another page, and
   * `pane` is the detail side of a top-bar issues pane.
   */
  variant: "tool" | "sheet" | "pane";
  /**
   * Attach the issue to the chat the tools pane serves. Absent when there is
   * no chat to attach to (the sheet, or a pane with no chat in focus).
   */
  onAttachToChat?: (attachment: AgentChatContextAttachment) => void;
  /** Open a related issue (parent, sub-issue, blocker) the way this host opens issues. */
  onOpenRelated: (ref: IssueRef) => void;
  /** The sheet's way out to the full list of issues. */
  onViewAll?: () => void;
  onClose?: () => void;
};

/** The viewer's 40px header, shared by every provider. */
export function IssueViewerHeader({
  mark,
  label,
  state,
  loading,
  onRefresh,
  url,
  openLabel,
  copyEntries,
  copyTitle,
  onViewAll,
  onClose,
}: {
  mark: React.ReactNode;
  label: string;
  state: React.ReactNode;
  loading: boolean;
  onRefresh: () => void;
  url: string | null;
  openLabel: string;
  copyEntries: ContextMenuEntry[];
  copyTitle: string;
  onViewAll?: () => void;
  onClose?: () => void;
}) {
  const [menu, setMenu] = useState<ContextMenuState>(null);
  return (
    <header className="kit-card-head border-b border-[color:var(--kit-rule)]">
      {mark}
      <span className="kit-num text-[12px] text-fg/85">{label}</span>
      {state ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-[color:var(--kit-text-2)]">{state}</span>
      ) : null}
      <span className="ml-auto flex items-center gap-1">
        {onViewAll ? (
          <button type="button" className="kit-card-head-action !m-0 mr-1" onClick={onViewAll}>
            All issues
          </button>
        ) : null}
        <button type="button" className="kit-icon-btn" aria-label="Refresh" title="Refresh" disabled={loading} onClick={onRefresh}>
          {loading ? <CircleNotch size={13} className="animate-spin" /> : <ArrowClockwise size={13} />}
        </button>
        {url ? (
          <button type="button" className="kit-icon-btn" aria-label={openLabel} title={openLabel} onClick={() => openExternalUrl(url)}>
            <ArrowSquareOut size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="kit-icon-btn"
          aria-label="More"
          title={copyTitle}
          disabled={copyEntries.length === 0}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right - 4, y: rect.bottom + 4 });
          }}
        >
          <DotsThree size={14} weight="bold" />
        </button>
        {onClose ? (
          <button type="button" className="kit-icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X size={13} />
          </button>
        ) : null}
      </span>
      {menu ? (
        <ContextMenu menu={menu} entries={copyEntries} onClose={() => setMenu(null)} label="Issue actions" portal />
      ) : null}
    </header>
  );
}

/** Copy one piece of an issue and say so. */
export function copyIssueText(text: string, what: string): void {
  void copyTextToClipboard(text).then((ok) => {
    showToast(ok
      ? { tone: "success", title: `Copied ${what}` }
      : { tone: "error", title: `Couldn't copy ${what}` });
  });
}

/** The lanes an issue lives on, drawn the same way for every provider. */
export function LinkedInAdeLanes({ linked }: { linked: Array<{ lane: LaneSummary; chatCount: number }> }) {
  return (
    <section className="mt-3 border-t border-[color:var(--kit-rule)] pt-3" aria-label="Linked in ADE">
      <div className="kit-eyebrow mb-1.5">Linked in ADE</div>
      {linked.length === 0 ? (
        <p className="text-[11.5px] text-[color:var(--kit-text-3)]">Not on a lane yet.</p>
      ) : (
        <div className="flex flex-col">
          {linked.map(({ lane, chatCount }) => (
            <button
              key={lane.id}
              type="button"
              className="kit-row -mx-2 !min-h-[28px] !text-[12px]"
              title={`Open lane ${lane.name}`}
              onClick={() => navigateToAppTarget({ kind: "lane", laneId: lane.id })}
            >
              <BranchIcon size={12} className="shrink-0 text-[color:var(--kit-text-3)]" />
              <span className="min-w-0 flex-1 truncate">{lane.name}</span>
              {chatCount > 0 ? (
                <span className="shrink-0 text-[11px] text-[color:var(--kit-text-3)]">
                  {chatCount === 1 ? "1 chat" : `${chatCount} chats`}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}


/** The viewer's frame: header, scrolling body, and the action dock under it. */
export function IssueViewerFrame({
  variant,
  ariaLabel,
  header,
  dock,
  children,
}: {
  variant: IssueViewerProps["variant"];
  ariaLabel: string;
  header: React.ReactNode;
  dock?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ade-issue-frame" data-issue-viewer={variant} aria-label={ariaLabel}>
      {header}
      <div className="ade-issue-frame-scroll">{children}</div>
      {dock}
    </section>
  );
}

/** A re-read failed; the issue on screen is the last copy ADE read. */
export function IssueStaleBanner({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null;
  return (
    <div className="px-4 pt-3">
      <Banner
        layout="inline"
        model={{
          id: "issue-refresh-failed",
          tone: "warning",
          title: "Showing the last copy ADE read",
          detail: error,
          actions: [{ label: "Retry", onClick: onRetry }],
        }}
      />
    </div>
  );
}

/**
 * Launch agent, Lane only, and Attach to chat (when a chat is there to take
 * it). `attachment` builds the chat context only when clicked.
 */
export function IssueActionDock({
  label,
  onLaunch,
  attachment,
  onAttachToChat,
}: {
  /** How the issue reads in a message: `ADE-123`, `#123`. */
  label: string;
  onLaunch: (laneOnly: boolean) => void;
  attachment: () => AgentChatContextAttachment;
  onAttachToChat?: (attachment: AgentChatContextAttachment) => void;
}) {
  return (
    <div className="ade-issue-frame-dock" data-issue-action-dock="true">
      <Button
        type="button"
        variant="primary"
        casing="sentence"
        className="shrink-0 gap-1.5 px-3"
        title="New lane for this issue, plus an agent started on it"
        onClick={() => onLaunch(false)}
      >
        <Sparkle size={13} weight="fill" />
        Launch agent
      </Button>
      <Button
        type="button"
        variant="outline"
        casing="sentence"
        className="shrink-0 gap-1.5 px-3"
        title="New lane for this issue. Start an agent later."
        onClick={() => onLaunch(true)}
      >
        <Plus size={13} weight="bold" />
        Lane only
      </Button>
      {onAttachToChat ? (
        <Button
          type="button"
          variant="outline"
          casing="sentence"
          className="shrink-0 gap-1.5 px-3"
          title="Add this issue to the chat's next message as context"
          onClick={() => {
            try {
              onAttachToChat(attachment());
            } catch (error) {
              showToast({
                tone: "warning",
                title: `Couldn't attach ${label}`,
                message: error instanceof Error ? error.message : "There is no chat to attach it to.",
              });
            }
          }}
        >
          <ChatCircleText size={13} />
          Attach to chat
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The lanes carrying an issue, and how many chats in each were handed it:
 * `links` gives a lane's links to this issue, `primary` whether the lane was
 * made for it (a link of its own).
 */
export function lanesCarryingIssue(
  lanes: LaneSummary[],
  links: (lane: LaneSummary) => Array<{ evidence?: { chatSessionId?: string | null } | null }>,
  primary: (lane: LaneSummary) => boolean = () => false,
): Array<{ lane: LaneSummary; chatCount: number }> {
  const out: Array<{ lane: LaneSummary; chatCount: number }> = [];
  for (const lane of lanes) {
    const matching = links(lane);
    if (!primary(lane) && matching.length === 0) continue;
    const chats = new Set(matching.map((link) => link.evidence?.chatSessionId).filter((id): id is string => Boolean(id)));
    out.push({ lane, chatCount: chats.size });
  }
  return out;
}
