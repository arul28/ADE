import React from "react";
import type { TerminalSessionSummary } from "../../../shared/types";

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

export type SessionContextMenuState = {
  session: TerminalSessionSummary;
  x: number;
  y: number;
} | null;

export function SessionContextMenu({
  menu,
  onClose,
  onCloseSession,
  onEndChat,
  onResume,
  onCopyResumeCommand,
  onGoToLane,
  onCopySessionId,
}: {
  menu: SessionContextMenuState;
  onClose: () => void;
  onCloseSession: (ptyId: string) => void;
  onEndChat: (sessionId: string) => void;
  onResume: (session: TerminalSessionSummary) => void;
  onCopyResumeCommand: (command: string) => void;
  onGoToLane: (session: TerminalSessionSummary) => void;
  onCopySessionId: (id: string) => void;
}) {
  if (!menu) return null;

  const { session, x, y } = menu;
  const isRunning = session.status === "running";
  const isChat = isChatToolType(session.toolType);
  const canResume = !isRunning && Boolean(session.resumeCommand);

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
        {isRunning && session.ptyId && !isChat ? (
          <button
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
            onClick={() => { onCloseSession(session.ptyId!); onClose(); }}
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
