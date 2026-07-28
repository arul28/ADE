import { useState, useRef, useEffect } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { isChatToolType } from "../../lib/sessions";
import { sessionCanonicalUiState } from "../../lib/terminalAttention";
import {
  isSessionSnoozed,
  snoozeWakeLabel,
  SNOOZE_DURATION_OPTIONS,
  type SnoozeDurationKey,
} from "../../lib/sessionSnooze";
import {
  setSessionSettleOverride,
  snoozeSessionForDuration,
  unsettleSession,
  wakeSessionNow,
} from "./sessionLifecycleActions";

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40";

export type SessionContextMenuState = {
  session: TerminalSessionSummary;
  binding?: OpenProjectBinding | null;
  machineName?: string | null;
  x: number;
  y: number;
} | null;

type SessionContextMenuProps = {
  menu: SessionContextMenuState;
  onClose: () => void;
  onStopRuntime: (
    args: { ptyId: string; sessionId: string },
    binding?: OpenProjectBinding | null,
  ) => void;
  onStopAndDelete: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  onDeleteChat: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  onDeleteSession: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  deletingSessionId: string | null;
  onGoToLane: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  onCopySessionId: (id: string) => void;
  onRename: (
    session: TerminalSessionSummary,
    newTitle: string,
    binding?: OpenProjectBinding | null,
  ) => void;
  onSetChatTag?: (
    session: TerminalSessionSummary,
    tag: string | null,
    binding?: OpenProjectBinding | null,
  ) => void;
  onCopySessionDeepLink?: (session: TerminalSessionSummary) => void;
  onOpenSessionInWeb?: (session: TerminalSessionSummary) => void;
  onTogglePinned?: (session: TerminalSessionSummary) => void;
  onSettle?: (
    session: TerminalSessionSummary,
    binding?: OpenProjectBinding | null,
  ) => void;
  pinnedSessionIds?: string[];
  /** Session ids currently in any work grid (drives the "Remove from grid" item). */
  gridSessionIds?: string[];
  onRemoveFromGrid?: (session: TerminalSessionSummary) => void;
};

export function SessionContextMenu({
  menu,
  onClose,
  onStopRuntime,
  onStopAndDelete,
  onDeleteChat,
  onDeleteSession,
  deletingSessionId,
  onGoToLane,
  onCopySessionId,
  onRename,
  onSetChatTag,
  onCopySessionDeepLink,
  onOpenSessionInWeb,
  onTogglePinned,
  onSettle,
  pinnedSessionIds,
  gridSessionIds,
  onRemoveFromGrid,
}: SessionContextMenuProps) {
  const [renaming, setRenaming] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const finalizedRef = useRef(false);
  const { ref: menuRef, position: clampedPosition } = useClampedFixedPosition(
    menu ? { x: menu.x, y: menu.y } : null,
    renaming || tagging,
  );

  // Reset inline edit state when the target menu changes.
  useEffect(() => {
    setRenaming(false);
    setTagging(false);
    setSnoozing(false);
    setDraft("");
    finalizedRef.current = false;
  }, [menu]);

  // Focus whichever inline editor was opened.
  useEffect(() => {
    if ((renaming || tagging) && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming, tagging]);

  if (!menu) return null;

  const { session, binding = null, x, y } = menu;
  const menuPosition = clampedPosition ?? { left: x, top: y };
  const isRunning = session.status === "running";
  const isChat = isChatToolType(session.toolType);
  const canonicalPhase = sessionCanonicalUiState(session).phase;
  const isActivelyRunning = canonicalPhase === "starting"
    || canonicalPhase === "running"
    || canonicalPhase === "stale";
  const canDismissNeedsYou =
    canonicalPhase !== "needs_you"
    || isChat
    || Boolean(session.attentionRequestedAt);
  // Snooze is a visibility overlay, so it is read from the shared snooze
  // derivation and never inferred from the canonical phase.
  const isSnoozed = isSessionSnoozed(session);
  const snoozeWake = isSnoozed ? snoozeWakeLabel(session.snoozedUntil) : null;
  const isSettled = canonicalPhase === "settled";
  /**
   * A DERIVED settle — a clean exit-0 (or a `settleOverride: "settled"`) with no
   * `settledAt` — used to fall out of every branch here and end up with no
   * lifecycle action at all. The keep-active override is the unsettle for those
   * rows: it outranks the derived rule so the row leaves the quiet tier.
   */
  const isDeclaredSettled = Boolean(session.settledAt);
  const chooseSnooze = (key: SnoozeDurationKey) => {
    void snoozeSessionForDuration(session, key, Date.now(), binding);
    onClose();
  };

  const commitRename = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const trimmed = draft.trim();
    if (trimmed.length > 0) {
      onRename(session, trimmed, binding);
    }
    onClose();
  };
  const commitTag = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const trimmed = draft.trim();
    onSetChatTag?.(session, trimmed.length ? trimmed : null, binding);
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />

      {/* Menu */}
      <div
        ref={menuRef}
        className="ade-liquid-glass-menu fixed z-50 min-w-[180px] py-1"
        style={{
          ...menuPosition,
          visibility: clampedPosition ? "visible" : "hidden",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {renaming && (
          <div className="px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              aria-label="Rename session"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); finalizedRef.current = true; onClose(); }
              }}
              onBlur={commitRename}
              className="w-full rounded border border-border/30 bg-transparent px-2 py-1 text-xs text-[--color-fg] outline-none focus:border-[--color-accent]"
              placeholder="Enter title..."
              maxLength={48}
            />
          </div>
        )}
        {tagging && (
          <div className="px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              aria-label="Set Claude session tag"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitTag(); }
                if (e.key === "Escape") { e.preventDefault(); finalizedRef.current = true; onClose(); }
              }}
              onBlur={commitTag}
              className="w-full rounded border border-border/30 bg-transparent px-2 py-1 text-xs text-[--color-fg] outline-none focus:border-[--color-accent]"
              placeholder="Tag (empty clears)..."
              maxLength={48}
            />
          </div>
        )}
        {!renaming && !tagging && (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { setDraft(session.title); setRenaming(true); }}
          >
            Rename
          </button>
        )}
        {/* Tag writes need a live Claude SDK runtime (updateSession throws for
            ended sessions), so only offer the item while the session runs. */}
        {!renaming && !tagging && session.toolType === "claude-chat" && isRunning && onSetChatTag ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => {
              finalizedRef.current = false;
              setDraft(session.claudeTag ?? "");
              setTagging(true);
            }}
          >
            Set tag…
          </button>
        ) : null}

        {isRunning && session.ptyId && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => {
              onStopRuntime({ ptyId: session.ptyId!, sessionId: session.id }, binding);
              onClose();
            }}
          >
            Stop runtime
          </button>
        ) : null}

        {isRunning && session.ptyId && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onStopAndDelete(session, binding); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting…" : "Stop & delete"}
          </button>
        ) : null}

        {/* Lifecycle block — every action that changes where the sidebar files
            this row lives here: snooze/wake (visibility) and settle/keep-active
            (state). Keep it exhaustive: a row that reaches the end of this block
            with nothing rendered is a row the user cannot un-hide. */}
        {isSnoozed ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { void wakeSessionNow(session, binding); onClose(); }}
          >
            Wake now
            {snoozeWake ? (
              <span className="ml-auto shrink-0 text-[10px] text-muted-fg/50">{snoozeWake}</span>
            ) : null}
          </button>
        ) : snoozing ? (
          SNOOZE_DURATION_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`${MENU_ITEM_CLASS} pl-6`}
              onClick={() => chooseSnooze(option.key)}
            >
              {option.label}
            </button>
          ))
        ) : (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            aria-expanded={false}
            onClick={() => setSnoozing(true)}
          >
            Snooze…
          </button>
        )}

        {isSettled ? (
          <>
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              onClick={() => {
                // Declared settles clear the column; derived settles have no
                // column to clear, so the keep-active pin is the only unsettle.
                // Both branches live in the shared lifecycle action.
                void unsettleSession(session, binding);
                onClose();
              }}
            >
              Unsettle
            </button>
            {isDeclaredSettled ? (
              <button
                type="button"
                className={MENU_ITEM_CLASS}
                title="Pin this session active so a clean exit cannot re-settle it"
                onClick={() => { void setSessionSettleOverride(session, "active", binding); onClose(); }}
              >
                Keep active
              </button>
            ) : null}
          </>
        ) : !isActivelyRunning && onSettle && canDismissNeedsYou ? (
          <button
            type="button"
            className={MENU_ITEM_CLASS}
            onClick={() => { onSettle(session, binding); onClose(); }}
          >
            {canonicalPhase === "needs_you" ? "Dismiss & settle" : "Settle"}
          </button>
        ) : canonicalPhase === "needs_you" && !canDismissNeedsYou ? (
          <button
            type="button"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-muted-fg/45"
            disabled
            title="Resolve the terminal prompt before settling this session"
          >
            Resolve input to settle
          </button>
        ) : null}

        {isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteChat(session, binding); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting…" : "Delete chat"}
          </button>
        ) : null}

        {!isRunning && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteSession(session, binding); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting…" : "Delete session"}
          </button>
        ) : null}

        <div className="my-0.5 h-px bg-border/10" />

        <button
          className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
          onClick={() => { onGoToLane(session, binding); onClose(); }}
        >
          Go to lane
        </button>

        <button
          className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
          onClick={() => { onCopySessionId(session.id); onClose(); }}
        >
          Copy session ID
        </button>

        {onCopySessionDeepLink ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onCopySessionDeepLink(session); onClose(); }}
          >
            Copy session deep link
          </button>
        ) : null}

        {onOpenSessionInWeb ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onOpenSessionInWeb(session); onClose(); }}
          >
            Open in web
          </button>
        ) : null}

        {onTogglePinned ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onTogglePinned(session); onClose(); }}
          >
            {(pinnedSessionIds ?? []).includes(session.id) ? "Unpin from front" : "Pin to front"}
          </button>
        ) : null}

        {onRemoveFromGrid && (gridSessionIds ?? []).includes(session.id) ? (
          <>
            <div className="my-0.5 h-px bg-border/10" />
            <button
              className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
              onClick={() => { onRemoveFromGrid(session); onClose(); }}
            >
              Remove from grid
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}
