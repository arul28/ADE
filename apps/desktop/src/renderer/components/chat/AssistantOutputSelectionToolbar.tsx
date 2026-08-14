import React, { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChatCircleText } from "@phosphor-icons/react";
import { formatChatOutputContextBlock } from "../../../shared/chatOutputContext";
import { readAssistantOutputSelection } from "./assistantOutputSelection";

type ToolbarState = {
  text: string;
  left: number;
  top: number;
};

export function AssistantOutputSelectionToolbar({
  rootRef,
  onAddToChat,
}: {
  rootRef: { current: HTMLElement | null };
  onAddToChat?: (text: string) => void;
}) {
  const [state, setState] = useState<ToolbarState | null>(null);

  const sync = () => {
    if (!onAddToChat) {
      setState(null);
      return;
    }
    try {
      const next = readAssistantOutputSelection(rootRef.current);
      if (!next) {
        setState(null);
        return;
      }
      const width = 118;
      setState({
        text: next.text,
        left: Math.min(Math.max(8, next.rect.right + 8), Math.max(8, window.innerWidth - width - 8)),
        top: Math.max(8, next.rect.top - 36),
      });
    } catch {
      setState(null);
    }
  };

  useLayoutEffect(() => {
    if (!onAddToChat) return;
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
  }, [onAddToChat, rootRef]);

  if (!state || !onAddToChat) return null;

  return createPortal(
    <button
      type="button"
      data-testid="assistant-output-add-to-chat"
      className="ade-assistant-add-to-chat fixed z-[1000] inline-flex items-center gap-1.5 rounded-md border border-violet-300/30 bg-[color:color-mix(in_srgb,var(--chat-panel-bg-strong,#1a1524)_94%,black_6%)] px-2 py-1 font-sans text-[11px] font-medium text-violet-100/90 shadow-[0_12px_32px_rgba(0,0,0,0.42)] backdrop-blur-xl transition-colors hover:bg-violet-500/18"
      style={{ left: state.left, top: state.top }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const block = formatChatOutputContextBlock(state.text);
        if (block) onAddToChat(block);
        window.getSelection()?.removeAllRanges();
        setState(null);
      }}
    >
      <ChatCircleText size={13} weight="bold" aria-hidden />
      Add to chat
    </button>,
    document.body,
  );
}
