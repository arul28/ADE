import { useState, useRef, useEffect, useLayoutEffect } from "react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { isChatToolType } from "../../lib/sessions";
import { resolveTrackedCliResumeCommand } from "./cliLaunch";

export type SessionContextMenuState = {
  session: TerminalSessionSummary;
  x: number;
  y: number;
} | null;

type SessionContextMenuProps = {
  menu: SessionContextMenuState;
  onClose: () => void;
  onCloseSession: (args: { ptyId: string; sessionId: string }) => void;
  onEndChat: (sessionId: string) => void;
  onDeleteChat: (session: TerminalSessionSummary) => void;
  onDeleteSession: (session: TerminalSessionSummary) => void;
  deletingSessionId: string | null;
  onResume: (session: TerminalSessionSummary) => void;
  onCopyResumeCommand: (command: string) => void;
  onGoToLane: (session: TerminalSessionSummary) => void;
  onCopySessionId: (id: string) => void;
  onRename: (session: TerminalSessionSummary, newTitle: string) => void;
};

export function SessionContextMenu({
  menu,
  onClose,
  onCloseSession,
  onEndChat,
  onDeleteChat,
  onDeleteSession,
  deletingSessionId,
  onResume,
  onCopyResumeCommand,
  onGoToLane,
  onCopySessionId,
  onRename,
}: SessionContextMenuProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const finalizedRef = useRef(false);
  const [clampedPosition, setClampedPosition] = useState<{
    sourceX: number;
    sourceY: number;
    left: number;
    top: number;
  } | null>(null);

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

  useLayoutEffect(() => {
    if (!menu) return;
    if (!menuRef.current) return;
    const { x, y } = menu;
    const padding = 8;
    const rect = menuRef.current.getBoundingClientRect();
    const maxLeft = Math.max(padding, window.innerWidth - rect.width - padding);
    const maxTop = Math.max(padding, window.innerHeight - rect.height - padding);
    const left = Math.min(Math.max(padding, x), maxLeft);
    const top = Math.min(Math.max(padding, y), maxTop);
    setClampedPosition((prev) => {
      if (
        prev?.sourceX === x &&
        prev.sourceY === y &&
        Math.abs(prev.left - left) < 0.5 &&
        Math.abs(prev.top - top) < 0.5
      ) {
        return prev;
      }
      return { sourceX: x, sourceY: y, left, top };
    });
  }, [menu, renaming]);

  if (!menu) return null;

  const { session, x, y } = menu;
  const menuPosition =
    clampedPosition?.sourceX === x && clampedPosition.sourceY === y
      ? { left: clampedPosition.left, top: clampedPosition.top }
      : { left: x, top: y };
  const isRunning = session.status === "running";
  const isChat = isChatToolType(session.toolType);
  const resumeCommand = resolveTrackedCliResumeCommand(session);
  const canResume = !isRunning && Boolean(resumeCommand);

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
        style={menuPosition}
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
            onClick={() => { onCloseSession({ ptyId: session.ptyId!, sessionId: session.id }); onClose(); }}
          >
            Close terminal
          </button>
        ) : null}

        {isRunning && isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onEndChat(session.id); onClose(); }}
          >
            End chat
          </button>
        ) : null}

        {!isRunning && isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteChat(session); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting..." : "Delete chat"}
          </button>
        ) : null}

        {!isRunning && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors"
            disabled={deletingSessionId === session.id}
            onClick={() => { onDeleteSession(session); onClose(); }}
          >
            {deletingSessionId === session.id ? "Deleting..." : "Delete session"}
          </button>
        ) : null}

        {canResume ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onResume(session); onClose(); }}
          >
            Resume
          </button>
        ) : null}

        {resumeCommand ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onCopyResumeCommand(resumeCommand); onClose(); }}
          >
            Copy resume command
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
      </div>
    </>
  );
}
