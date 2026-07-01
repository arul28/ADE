import { useState, useRef, useEffect } from "react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { isChatToolType } from "../../lib/sessions";

export type SessionContextMenuState = {
  session: TerminalSessionSummary;
  x: number;
  y: number;
} | null;

type SessionContextMenuProps = {
  menu: SessionContextMenuState;
  onClose: () => void;
  onStopRuntime: (args: { ptyId: string; sessionId: string }) => void;
  onStopAndDelete: (session: TerminalSessionSummary) => void;
  onDeleteChat: (session: TerminalSessionSummary) => void;
  onDeleteSession: (session: TerminalSessionSummary) => void;
  deletingSessionId: string | null;
  onGoToLane: (session: TerminalSessionSummary) => void;
  onCopySessionId: (id: string) => void;
  onRename: (session: TerminalSessionSummary, newTitle: string) => void;
  onCopySessionDeepLink?: (session: TerminalSessionSummary) => void;
  onTogglePinned?: (session: TerminalSessionSummary) => void;
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
  onCopySessionDeepLink,
  onTogglePinned,
  pinnedSessionIds,
  gridSessionIds,
  onRemoveFromGrid,
}: SessionContextMenuProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const finalizedRef = useRef(false);
  const { ref: menuRef, position: clampedPosition } = useClampedFixedPosition(
    menu ? { x: menu.x, y: menu.y } : null,
    [menu?.x, menu?.y, renaming],
  );

  // Reset rename state when menu changes
  useEffect(() => {
    setRenaming(false);
    setDraft("");
    finalizedRef.current = false;
  }, [menu]);

  // Focus input when entering rename mode
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  if (!menu) return null;

  const { session, x, y } = menu;
  const menuPosition = clampedPosition ?? { left: x, top: y };
  const isRunning = session.status === "running";
  const isChat = isChatToolType(session.toolType);

  const commitRename = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const trimmed = draft.trim();
    if (trimmed.length > 0) {
      onRename(session, trimmed);
    }
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
        {!renaming && (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { setDraft(session.title); setRenaming(true); }}
          >
            Rename
          </button>
        )}

        {isRunning && session.ptyId && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onStopRuntime({ ptyId: session.ptyId!, sessionId: session.id }); onClose(); }}
          >
            Stop runtime
          </button>
        ) : null}

        {isRunning && session.ptyId && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onStopAndDelete(session); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting…" : "Stop & delete"}
          </button>
        ) : null}

        {isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteChat(session); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting…" : "Delete chat"}
          </button>
        ) : null}

        {!isRunning && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteSession(session); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting…" : "Delete session"}
          </button>
        ) : null}

        <div className="my-0.5 h-px bg-border/10" />

        <button
          className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
          onClick={() => { onGoToLane(session); onClose(); }}
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
