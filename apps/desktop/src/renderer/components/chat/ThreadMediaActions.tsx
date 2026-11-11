import React, { useEffect, useRef, useState } from "react";
import { ChatTeardropText, Check, Paperclip } from "@phosphor-icons/react";
import type { AgentChatFileRef } from "../../../shared/types";
import { cssZoomOf } from "../../lib/webZoom";
import { cn } from "../ui/cn";
import { ViewportOverlayPortal } from "../ui/ViewportOverlayHost";
import { REPLY_TOOLBAR_BUTTON_CLASS, REPLY_TOOLBAR_CLASS } from "./AssistantOutputSelectionToolbar";
import {
  THREAD_COMMENT_MESSAGE_SELECTOR,
  THREAD_MEDIA_SELECTOR,
  readThreadMedia,
  threadMediaBox,
  type ThreadMediaInfo,
} from "./threadCommentAnchors";

const ACTIONS_SELECTOR = "[data-thread-media-actions]";

function isOnActions(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(ACTIONS_SELECTOR));
}

/** The attachment that puts one image or video from the thread into the next message. */
function threadMediaAttachment(media: ThreadMediaInfo): AgentChatFileRef | null {
  const path = media.attachPath?.trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return media.kind === "image" ? { path, type: "image-url", url: path } : null;
  // The model sees an image's pixels. A video goes as a path the agent opens
  // with its own tools; `hydrate: false` keeps a large recording from being
  // read or copied just to send it.
  return media.kind === "image" ? { path, type: "image" } : { path, type: "file", hydrate: false };
}

type Hovered = { element: HTMLElement; box: HTMLElement; rect: DOMRect };

/**
 * Buttons on the image or video under the pointer in a transcript: "Comment"
 * (when the layer offers comments) and "Add to chat", which attaches the file
 * to the next message. They float in the viewport overlay, like the table-row
 * comment button, and never change the reply's DOM.
 */
export function ThreadMediaActions({
  rootRef,
  scrollRef,
  onComment,
  onAttach,
  commentCount,
  onOpenComments,
  disabled = false,
}: {
  rootRef: { current: HTMLElement | null };
  scrollRef: { current: HTMLElement | null };
  /** Opens a new comment on the media. Absent where comments are not offered. */
  onComment?: (element: HTMLElement) => void;
  onAttach?: (attachment: AgentChatFileRef) => void;
  /** How many comments already hang off this media. */
  commentCount?: (element: HTMLElement) => number;
  onOpenComments?: (element: HTMLElement) => void;
  /** Hides the buttons, e.g. while a comment box is open. */
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [attachedElement, setAttachedElement] = useState<HTMLElement | null>(null);
  const attachedTimerRef = useRef<number | null>(null);
  const enabled = Boolean(onComment || onAttach);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return undefined;
    const onMove = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (isOnActions(target)) return;
      const element = target?.closest?.(THREAD_MEDIA_SELECTOR) as HTMLElement | null;
      const box = element ? threadMediaBox(element) : null;
      // Only the picture or player itself, not the caption under it.
      if (!element || !box || !box.contains(target)) {
        setHovered((current) => (current ? null : current));
        return;
      }
      // Measure again when the picture swaps in for its placeholder or resizes.
      const rect = box.getBoundingClientRect();
      setHovered((current) => (
        current?.element === element && current.box === box
          && current.rect.top === rect.top && current.rect.right === rect.right
          ? current
          : { element, box, rect }
      ));
    };
    // The buttons are portaled to <body>, so moving onto them leaves the root.
    const onLeave = (event: PointerEvent) => {
      if (isOnActions(event.relatedTarget)) return;
      setHovered(null);
    };
    const onScroll = () => setHovered(null);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      scroll?.removeEventListener("scroll", onScroll);
    };
  }, [enabled, rootRef, scrollRef]);

  useEffect(() => () => {
    if (attachedTimerRef.current != null) window.clearTimeout(attachedTimerRef.current);
  }, []);

  if (!hovered || disabled || !hovered.element.isConnected) return null;
  const media = readThreadMedia(hovered.element);
  if (!media) return null;
  const attachment = onAttach ? threadMediaAttachment(media) : null;
  // Comments hang off finished replies only; a streaming one is still changing.
  const canComment = Boolean(
    (hovered.element.closest(THREAD_COMMENT_MESSAGE_SELECTOR) as HTMLElement | null)?.dataset.threadCommentKey,
  );
  const existing = commentCount?.(hovered.element) ?? 0;
  if (!onComment && !attachment) return null;

  const zoom = cssZoomOf();
  // A notice or a placeholder in place of the picture (offline, failed,
  // loading) has its own buttons at its right end: the bar sits just above it,
  // flush so the pointer can reach the bar, never over the notice's Retry.
  const showsMedia = hovered.box.matches("img, video") || hovered.box.querySelector("img, video") != null;
  const right = Math.min(hovered.rect.right / zoom, window.innerWidth / zoom);
  const style: React.CSSProperties = showsMedia
    ? {
      // Inside the media's top-right corner, so it never covers a video's controls.
      left: right - 8,
      top: Math.max(8, hovered.rect.top / zoom + 8),
      transform: "translateX(-100%)",
    }
    : hovered.rect.top / zoom > 40
      ? { left: right, top: hovered.rect.top / zoom + 1, transform: "translate(-100%, -100%)" }
      : { left: right, top: hovered.rect.bottom / zoom - 1, transform: "translateX(-100%)" };
  const attached = attachedElement === hovered.element;
  const noun = media.kind === "video" ? "video" : "image";

  return (
    <ViewportOverlayPortal layer="popover">
      <div
        data-thread-media-actions=""
        data-thread-comment-ignore=""
        data-testid="thread-media-actions"
        className={REPLY_TOOLBAR_CLASS}
        style={style}
        onPointerLeave={(event) => {
          const next = event.relatedTarget as Element | null;
          const element = next?.closest?.(THREAD_MEDIA_SELECTOR);
          if (element !== hovered.element) setHovered(null);
        }}
        onMouseDown={(event) => event.preventDefault()}
      >
        {onComment && existing > 0 && onOpenComments ? (
          <button
            type="button"
            data-testid="thread-media-open-comments"
            className={cn(REPLY_TOOLBAR_BUTTON_CLASS, "tabular-nums hover:bg-fg/[0.07]")}
            title={`Show the ${existing === 1 ? "comment" : "comments"} on this ${noun}`}
            onClick={() => onOpenComments(hovered.element)}
          >
            <ChatTeardropText size={13} weight="fill" className="text-[var(--chat-accent)]" aria-hidden />
            {existing}
          </button>
        ) : null}
        {onComment ? (
          <button
            type="button"
            data-testid="thread-media-comment"
            disabled={!canComment}
            className={cn(
              REPLY_TOOLBAR_BUTTON_CLASS,
              existing > 0 && onOpenComments && "border-l border-fg/[0.08]",
              canComment ? "hover:bg-fg/[0.07]" : "cursor-not-allowed text-fg/35",
            )}
            title={canComment ? `Comment on this ${noun}. It goes with your next message.` : `Wait for the turn to end to comment on this ${noun}.`}
            onClick={() => {
              if (!canComment) return;
              const element = hovered.element;
              setHovered(null);
              onComment(element);
            }}
          >
            <ChatTeardropText size={13} weight={existing > 0 ? "regular" : "fill"} className={canComment ? "text-[var(--chat-accent)]" : undefined} aria-hidden />
            {canComment ? "Comment" : "Wait for turn"}
          </button>
        ) : null}
        {attachment && onAttach ? (
          <button
            type="button"
            data-testid="thread-media-add-to-chat"
            className={cn(REPLY_TOOLBAR_BUTTON_CLASS, onComment && "border-l border-fg/[0.08]", "hover:bg-fg/[0.07]")}
            title={`Attach this ${noun} to your next message`}
            onClick={() => {
              onAttach(attachment);
              setAttachedElement(hovered.element);
              if (attachedTimerRef.current != null) window.clearTimeout(attachedTimerRef.current);
              attachedTimerRef.current = window.setTimeout(() => setAttachedElement(null), 1_500);
            }}
          >
            {attached
              ? <Check size={13} weight="bold" className="text-[var(--chat-accent)]" aria-hidden />
              : <Paperclip size={13} weight="bold" className="text-[var(--chat-accent)]" aria-hidden />}
            {attached ? "Added" : "Add to chat"}
          </button>
        ) : null}
      </div>
    </ViewportOverlayPortal>
  );
}
