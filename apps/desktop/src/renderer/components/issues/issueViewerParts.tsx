import React, { useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CircleNotch, DotsThree, X } from "@phosphor-icons/react";
import type { AgentChatContextAttachment, LaneSummary } from "../../../shared/types";
import type { IssueRef } from "../../../shared/issueRefs";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { navigateToAppTarget, openExternalUrl } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../ui/ContextMenu";
import { BranchIcon } from "../ui/vcsIcons";

/**
 * Chrome every issue provider's viewer shares: the props a host passes, the
 * 40px header, copy-with-toast, and the "Linked in ADE" lane list.
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

