import { useState, useRef, useEffect } from "react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { isChatToolType } from "../../lib/sessions";

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
  onResume: (session: TerminalSessionSummary) => void;
  onCopyResumeCommand: (command: string) => void;
  onGoToLane: (session: TerminalSessionSummary) => void;
  onCopySessionId: (id: string) => void;
  onRename: (sessionId: string, newTitle: string) => void;
};

export function SessionContextMenu({
  menu,
  onClose,
  onCloseSession,
  onEndChat,
  onResume,
  onCopyResumeCommand,
  onGoToLane,
  onCopySessionId,
  onRename,
}: SessionContextMenuProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset rename state when menu changes
  useEffect(() => {
    setRenaming(false);
    setDraft("");
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
  const isRunning = session.status === "running";
  const isChat = isChatToolType(session.toolType);
  const canResume = !isRunning && Boolean(session.resumeCommand);

  const cancelledRef = useRef(false);

  const commitRename = () => {
    if (cancelledRef.current) return;
    const trimmed = draft.trim();
    if (trimmed.length > 0) {
      onRename(session.id, trimmed);
    }
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />

      {/* Menu */}
      <div
        className="fixed z-50 min-w-[180px] rounded-lg bg-[--color-surface-overlay] border border-border/30 py-1 shadow-2xl backdrop-blur-md"
        style={{ left: x, top: y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Rename (chat sessions only) */}
        {isChat && renaming && (
          <div className="px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); cancelledRef.current = true; onClose(); }
              }}
              onBlur={commitRename}
              className="w-full rounded border border-border/30 bg-transparent px-2 py-1 text-xs text-[--color-fg] outline-none focus:border-[--color-accent]"
              placeholder="Enter title..."
              maxLength={48}
            />
          </div>
        )}
        {isChat && !renaming && (
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

        {canResume ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onResume(session); onClose(); }}
          >
            Resume
          </button>
        ) : null}

        {session.resumeCommand ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onCopyResumeCommand(session.resumeCommand!); onClose(); }}
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
