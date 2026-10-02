import React, { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChatTeardropText, Quotes } from "@phosphor-icons/react";
import { formatChatOutputContextBlock } from "../../../shared/chatOutputContext";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import { readAssistantOutputSelection, type AssistantOutputSelection } from "./assistantOutputSelection";

type ToolbarState = {
  selection: AssistantOutputSelection;
  left: number;
  top: number;
  /** Comments hang off finished replies only; a streaming one is still changing. */
  canComment: boolean;
};

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 px-2 py-1 font-sans text-[11px] font-medium transition-colors";

export function AssistantOutputSelectionToolbar({
  rootRef,
  onAddToChat,
  onComment,
}: {
  rootRef: { current: HTMLElement | null };
  onAddToChat?: (text: string) => void;
  /** Opens a comment on the selection. Absent where comments are not offered. */
  onComment?: (selection: AssistantOutputSelection) => void;
}) {
  const [state, setState] = useState<ToolbarState | null>(null);
  const enabled = Boolean(onAddToChat || onComment);

  const sync = () => {
    if (!enabled) {
      setState(null);
      return;
    }
    try {
      const next = readAssistantOutputSelection(rootRef.current);
      if (!next) {
        setState(null);
        return;
      }
      const width = onComment ? 196 : 118;
      // The hosted web client zooms <body>: rects are zoomed, style px are
      // zoomed again, so convert back to layout px first. 1 in Electron.
      const body = document.body;
      const zoom = body.offsetWidth ? body.getBoundingClientRect().width / body.offsetWidth || 1 : 1;
      setState({
        selection: next,
        left: Math.min(Math.max(8, next.rect.right / zoom + 8), Math.max(8, window.innerWidth / zoom - width - 8)),
        top: Math.max(8, next.rect.top / zoom - 36),
        canComment: Boolean(next.output.dataset.threadCommentKey),
      });
    } catch {
      setState(null);
    }
  };

  useLayoutEffect(() => {
    if (!enabled) return;
    const handleSelection = () => sync();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState(null);
    };
    document.addEventListener("selectionchange", handleSelection);
    document.addEventListener("mouseup", handleSelection);
    window.addEventListener("resize", handleSelection);
    window.addEventListener("scroll", handleSelection, true);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("selectionchange", handleSelection);
      document.removeEventListener("mouseup", handleSelection);
      window.removeEventListener("resize", handleSelection);
      window.removeEventListener("scroll", handleSelection, true);
      window.removeEventListener("keydown", handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sync` reads the latest props each call
  }, [enabled, onAddToChat, onComment, rootRef]);

  if (!state || !enabled) return null;

  const keepSelection = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      data-testid="assistant-output-selection-toolbar"
      className="ade-assistant-add-to-chat fixed inline-flex items-stretch overflow-hidden rounded-md border border-white/[0.1] bg-[color:color-mix(in_srgb,var(--chat-panel-bg-strong,#1a1524)_94%,black_6%)] text-fg/85 shadow-[0_12px_32px_rgba(0,0,0,0.42)] backdrop-blur-xl"
      style={{ left: state.left, top: state.top, zIndex: Z_LAYERS.popover }}
      onMouseDown={keepSelection}
    >
      {onAddToChat ? (
        <button
          type="button"
          data-testid="assistant-output-add-to-chat"
          className={cn(BUTTON_CLASS, "hover:bg-white/[0.07]")}
          title="Quote this in your message"
          onMouseDown={keepSelection}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const block = formatChatOutputContextBlock(state.selection.text);
            if (block) onAddToChat(block);
            window.getSelection()?.removeAllRanges();
            setState(null);
          }}
        >
          <Quotes size={13} weight="fill" className="text-[var(--chat-accent)]" aria-hidden />
          Add to chat
        </button>
      ) : null}
      {onComment ? (
        <button
          type="button"
          data-testid="assistant-output-comment"
          disabled={!state.canComment}
          className={cn(
            BUTTON_CLASS,
            onAddToChat && "border-l border-white/[0.08]",
            state.canComment ? "hover:bg-white/[0.07]" : "cursor-not-allowed text-fg/35",
          )}
          title={state.canComment ? "Leave a comment here. It goes with your next message." : "Wait for the turn to end to comment on this reply."}
          onMouseDown={keepSelection}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!state.canComment) return;
            onComment(state.selection);
            window.getSelection()?.removeAllRanges();
            setState(null);
          }}
        >
          <ChatTeardropText size={13} weight="fill" className={state.canComment ? "text-[var(--chat-accent)]" : undefined} aria-hidden />
          {state.canComment ? "Comment" : "Wait for turn"}
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
