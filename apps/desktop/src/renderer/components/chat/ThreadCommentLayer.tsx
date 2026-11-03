import { useOnSurfaceHidden } from "../../lib/parkedSurface";
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { createPortal } from "react-dom";
import { ChatTeardropText } from "@phosphor-icons/react";
import type { AgentChatFileRef, OpenProjectBinding } from "../../../shared/types";
import type { ChatThreadComment, ChatThreadCommentAnchor } from "../../../shared/threadComments";
import { cssZoomOf } from "../../lib/webZoom";
import { cn } from "../ui/cn";
import { ViewportOverlayPortal } from "../ui/ViewportOverlayHost";
import { AssistantOutputSelectionToolbar } from "./AssistantOutputSelectionToolbar";
import type { AssistantOutputSelection } from "./assistantOutputSelection";
import { createHighlightGroup } from "../../lib/highlightRegistry";
import {
  THREAD_COMMENT_MESSAGE_SELECTOR,
  captureMediaAnchor,
  captureTableRowAnchor,
  captureTextAnchor,
  messageExcerptOf,
  rangeAroundNode,
  resolveThreadCommentRange,
  resolveThreadMediaElement,
  threadMediaBox,
} from "./threadCommentAnchors";
import { ThreadMediaActions } from "./ThreadMediaActions";
import {
  ThreadCommentEditor,
  ThreadCommentListItem,
  threadCommentErrorText,
  useThreadCommentActions,
} from "./ThreadCommentControls";
import {
  addLocalThreadComment,
  THREAD_COMMENT_FOCUS_EVENT,
  threadCommentsApi,
  discardUnsavedDraftBody,
  keepUnsavedDraftBody,
  readUnsavedDraftBody,
  unsavedDraftKey,
} from "./threadCommentsStore";

const HIGHLIGHT_PENDING = "ade-thread-comment";
const HIGHLIGHT_HELD = "ade-thread-comment-held";
const HIGHLIGHT_ACTIVE = "ade-thread-comment-active";
/** Below this much free space right of the column, cards hide and the composer list takes over. */
const MIN_MARGIN_PX = 196;
const CARD_GAP_PX = 8;
const POPOVER_WIDTH_PX = 300;

type Draft = {
  /** The chat the box was opened in. */
  sessionId: string;
  messageKey: string;
  messageExcerpt: string;
  anchor: ChatThreadCommentAnchor;
  /** Viewport rect of the anchor, for the popover. */
  rect: DOMRect;
  /** The text being commented on; it stays highlighted while the box is open. */
  range: Range;
  /** What the box holds when it reopens after a failed save. */
  body?: string;
  /** The picture or player, for a comment on an image or video. */
  mediaBox?: HTMLElement;
};

type Resolved = {
  comment: ChatThreadComment;
  range: Range;
  /** For a media comment: the marked image or video element, and its visible box. */
  media?: { element: HTMLElement; box: HTMLElement };
};

/** The attribute that rings an image or video carrying a comment (see index.css). */
const MEDIA_STATE_ATTRIBUTE = "data-thread-comment-media-state";

/**
 * A grid can show several chats at once; each layer publishes its ranges under
 * its own id (`lib/highlightRegistry`).
 */
type LayerHighlights = Record<typeof HIGHLIGHT_PENDING | typeof HIGHLIGHT_HELD | typeof HIGHLIGHT_ACTIVE, Range[]>;
const commentHighlights = createHighlightGroup([HIGHLIGHT_PENDING, HIGHLIGHT_HELD, HIGHLIGHT_ACTIVE] as const);

function publishLayerHighlights(layerId: string, next: LayerHighlights | null): void {
  commentHighlights.publish(layerId, next);
}

function messageElement(root: HTMLElement, messageKey: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(THREAD_COMMENT_MESSAGE_SELECTOR)) {
    if (el.dataset.threadCommentKey === messageKey) return el;
  }
  return null;
}

/** Height of a fresh comment box or an open comment, for placing it before it renders. */
const BOX_HEIGHT_PX = 120;

/**
 * Places a box of `POPOVER_WIDTH_PX` next to an anchor rect, in layout pixels
 * (see `cssZoomOf`). `above` puts it on the text, starting where the text
 * starts, so the highlight stays in view under it; either side flips when the
 * viewport has no room.
 */
function placeNear(rect: DOMRect, prefer: "above" | "below"): { left: number; top: number } {
  const zoom = cssZoomOf();
  const viewportWidth = window.innerWidth / zoom;
  const viewportHeight = window.innerHeight / zoom;
  const left = Math.min(Math.max(8, rect.left / zoom - 6), Math.max(8, viewportWidth - POPOVER_WIDTH_PX - 8));
  const above = rect.top / zoom - BOX_HEIGHT_PX - 6;
  const below = rect.bottom / zoom + 6;
  const fitsAbove = above >= 8;
  const fitsBelow = below + BOX_HEIGHT_PX <= viewportHeight - 8;
  const useAbove = prefer === "above" ? fitsAbove || !fitsBelow : fitsAbove && !fitsBelow;
  const top = useAbove ? Math.max(8, above) : Math.min(below, viewportHeight - BOX_HEIGHT_PX - 8);
  return { left, top };
}

/**
 * Thread comments on the transcript: highlights on the text they hang off,
 * margin cards when the window leaves room for them, a row button on agent
 * tables, the selection toolbar, and the popovers that write or edit a comment.
 *
 * The highlights and cards never change the reply's structure. Highlights use
 * the CSS Custom Highlight API, so markdown re-renders and the virtualized list
 * are untouched, and cards live in the column's own scroll content, so they
 * scroll with the message they belong to. An image or video with a comment
 * gets one data attribute, which rings it. Only the transient popovers, the
 * row button and the media buttons float, in a viewport overlay layer.
 */
export function ThreadCommentLayer({
  rootRef,
  contentRef,
  scrollRef,
  sessionId,
  pin,
  comments,
  layoutVersion,
  onAddToChat,
  onAttachMedia,
  onCreateIssue,
}: {
  rootRef: { current: HTMLElement | null };
  contentRef: { current: HTMLElement | null };
  scrollRef: { current: HTMLElement | null };
  sessionId: string;
  pin: OpenProjectBinding | null | undefined;
  comments: readonly ChatThreadComment[];
  /** Changes whenever the rendered rows change, so anchors are found again. */
  layoutVersion: unknown;
  /** The selection toolbar's "Add to chat" action. */
  onAddToChat?: (text: string) => void;
  /** Attaches an image or video from the thread to the next message. */
  onAttachMedia?: (attachment: AgentChatFileRef) => void;
  onCreateIssue?: (text: string) => void;
}) {
  const actions = useThreadCommentActions(sessionId, pin);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [draft, setDraft] = useState<Draft | null>(null);
  // Read after an await, so a failed save can tell whether a newer box is open.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // What the open box holds right now, kept when the box closes because the user left.
  const draftBodyRef = useRef("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const { editingId, stopEditing } = actions;
  const [resolved, setResolved] = useState<Resolved[]>([]);
  const [geometryTick, setGeometryTick] = useState(0);
  const [marginWidth, setMarginWidth] = useState(0);
  const [rowButton, setRowButton] = useState<{ row: HTMLTableRowElement; rect: DOMRect } | null>(null);
  const cardHeightsRef = useRef(new Map<string, number>());
  const [cardHeightsVersion, setCardHeightsVersion] = useState(0);

  const marginMode = marginWidth >= MIN_MARGIN_PX;
  const marginModeRef = useRef(marginMode);
  marginModeRef.current = marginMode;
  const commentsRef = useRef(comments);
  commentsRef.current = comments;

  /** Closes the new-comment box, keeping what was typed for the same text. */
  const closeDraftKeepingText = useCallback(() => {
    const open = draftRef.current;
    if (open) keepUnsavedDraftBody(open, draftBodyRef.current);
    draftRef.current = null;
    setDraft(null);
    setDraftError(null);
  }, []);

  /** Closes the box for good (Cancel, Escape, saved): nothing comes back. */
  const discardDraft = useCallback(() => {
    const open = draftRef.current;
    if (open) discardUnsavedDraftBody(open);
    draftRef.current = null;
    setDraft(null);
    setDraftError(null);
  }, []);

  const openDraft = useCallback((next: Draft) => {
    closeDraftKeepingText();
    const body = next.body ?? readUnsavedDraftBody(next);
    draftBodyRef.current = body ?? "";
    setOpenCommentId(null);
    setDraft(body ? { ...next, body } : next);
  }, [closeDraftKeepingText]);

  // ── Start a comment from a text selection ──
  const startFromSelection = useCallback((selection: AssistantOutputSelection) => {
    const messageKey = selection.output.dataset.threadCommentKey;
    if (!messageKey) return;
    const anchor = captureTextAnchor(selection.output, selection.range);
    if (!anchor) return;
    openDraft({ sessionId, messageKey, messageExcerpt: messageExcerptOf(selection.output), anchor, rect: selection.rect, range: selection.range });
  }, [openDraft, sessionId]);

  // What is open belongs to the chat on screen. Another chat or machine, or
  // the pane going away, closes it; typed text is kept for later.
  const closeAll = useCallback(() => {
    closeDraftKeepingText();
    setOpenCommentId(null);
    setRowButton(null);
    stopEditing();
  }, [closeDraftKeepingText, stopEditing]);
  const pinKey = pin?.key ?? null;
  // Cleanup only: it runs when the chat or machine changes, and on unmount.
  useEffect(() => () => closeAll(), [closeAll, pinKey, sessionId]);
  // So does its surface parking (another app tab or project tab on screen).
  useOnSurfaceHidden(rootRef, Boolean(draft || openCommentId || editingId), closeAll);

  // ── Find every comment's text again ──
  const resolvedRef = useRef<Resolved[]>([]);
  const resolveAll = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = new Map(resolvedRef.current.map((entry) => [entry.comment.id, entry]));
    const next: Resolved[] = [];
    let changed = resolvedRef.current.length !== commentsRef.current.length;
    for (const comment of commentsRef.current) {
      const message = messageElement(root, comment.messageKey);
      if (!message) {
        if (previous.has(comment.id)) changed = true;
        continue;
      }
      if (comment.anchor.kind === "media") {
        // Media loads late and swaps its placeholder for the picture, so look
        // it up every time (a few elements); keep the old range while the box is the same.
        const element = resolveThreadMediaElement(message, comment.anchor);
        const box = element ? threadMediaBox(element) : null;
        const kept = previous.get(comment.id);
        if (!element || !box) {
          if (kept) changed = true;
          continue;
        }
        if (kept?.media?.box === box && kept.media.element === element) {
          next.push(kept.comment === comment ? kept : { ...kept, comment });
          continue;
        }
        changed = true;
        next.push({ comment, range: rangeAroundNode(box), media: { element, box } });
        continue;
      }
      // A finished reply does not change, so a range whose nodes are still
      // in it is still right. Only rows that remounted are searched again —
      // which keeps a streaming reply elsewhere from re-scanning every frame.
      const kept = previous.get(comment.id)?.range;
      const range = kept && kept.startContainer.isConnected && kept.endContainer.isConnected && message.contains(kept.startContainer)
        ? kept
        : resolveThreadCommentRange(message, comment.anchor);
      if (!range) {
        if (kept) changed = true;
        continue;
      }
      if (range !== kept) changed = true;
      next.push({ comment, range });
    }
    if (!changed && next.every((entry, index) => entry.comment === resolvedRef.current[index]?.comment)) return;
    resolvedRef.current = next;
    setResolved(next);
  }, [rootRef]);

  useLayoutEffect(() => {
    resolveAll();
  }, [comments, layoutVersion, resolveAll]);

  // Rows mount late (virtualization, history paging, markdown that renders a
  // frame after the row). Watch the column and look again, at most once a frame.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !comments.length) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resolveAll();
        // Only margin cards read geometry; without them a streaming reply
        // elsewhere must not force a layout read every frame.
        if (marginModeRef.current && resolvedRef.current.length) setGeometryTick((tick) => tick + 1);
      });
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(content);
    return () => {
      mutations.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [comments.length, contentRef, resolveAll]);

  // ── Margin width: the free space right of the column ──
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return undefined;
    const measure = () => {
      const scrollRect = scroll.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      // Leave room for the scrollbar and a little air on both sides.
      setMarginWidth(Math.max(0, Math.floor((scrollRect.right - contentRect.right) / cssZoomOf(content) - 28)));
    };
    measure();
    // jsdom has no ResizeObserver; the margin is measured once above.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, scrollRef]);

  // ── Paint highlights ──
  const layerId = useId();
  useEffect(() => {
    const active = openCommentId ?? editingId;
    // Highlights paint text only; images and videos get a ring below instead.
    const text = resolved.filter((entry) => !entry.media);
    publishLayerHighlights(layerId, {
      [HIGHLIGHT_PENDING]: text.filter((entry) => entry.comment.includeInNextSend && entry.comment.id !== active).map((entry) => entry.range),
      [HIGHLIGHT_HELD]: text.filter((entry) => !entry.comment.includeInNextSend && entry.comment.id !== active).map((entry) => entry.range),
      [HIGHLIGHT_ACTIVE]: [
        ...text.filter((entry) => entry.comment.id === active).map((entry) => entry.range),
        ...(draft && !draft.mediaBox ? [draft.range] : []),
      ],
    });
  }, [draft, editingId, layerId, openCommentId, resolved]);

  useEffect(() => () => publishLayerHighlights(layerId, null), [layerId]);

  // ── Ring the images and videos that carry a comment ──
  // The one attribute this layer writes into a reply: React does not own it,
  // and a remounted row is found and ringed again on the next resolve.
  const ringedRef = useRef(new Set<HTMLElement>());
  useEffect(() => {
    const active = openCommentId ?? editingId;
    const rank = { held: 0, pending: 1, active: 2 } as const;
    const states = new Map<HTMLElement, keyof typeof rank>();
    const mark = (box: HTMLElement, state: keyof typeof rank) => {
      const current = states.get(box);
      if (!current || rank[state] > rank[current]) states.set(box, state);
    };
    for (const entry of resolved) {
      if (!entry.media) continue;
      mark(entry.media.box, entry.comment.id === active ? "active" : entry.comment.includeInNextSend ? "pending" : "held");
    }
    if (draft?.mediaBox) mark(draft.mediaBox, "active");
    for (const box of ringedRef.current) {
      if (!states.has(box)) box.removeAttribute(MEDIA_STATE_ATTRIBUTE);
    }
    for (const [box, state] of states) box.setAttribute(MEDIA_STATE_ATTRIBUTE, state);
    ringedRef.current = new Set(states.keys());
  }, [draft, editingId, openCommentId, resolved]);

  useEffect(() => () => {
    for (const box of ringedRef.current) box.removeAttribute(MEDIA_STATE_ATTRIBUTE);
    ringedRef.current.clear();
  }, []);

  // ── Click on highlighted text opens its comment ──
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const onClick = (event: MouseEvent) => {
      if (!resolved.length || event.button !== 0) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
      const caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!caret) return;
      const hit = resolved.find((entry) => {
        // A click on a picture opens it; its comment opens from the hover buttons or the card.
        if (entry.media) return false;
        try {
          return entry.range.isPointInRange(caret.startContainer, caret.startOffset);
        } catch {
          return false;
        }
      });
      if (!hit) return;
      closeDraftKeepingText();
      setOpenCommentId(hit.comment.id);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [closeDraftKeepingText, resolved, rootRef]);

  // ── Table rows: a comment button at the row's right edge ──
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const onMove = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-thread-comment-row-button]")) return;
      const row = target?.closest("tbody tr") as HTMLTableRowElement | null;
      if (!row || !row.closest(THREAD_COMMENT_MESSAGE_SELECTOR)) {
        setRowButton((current) => (current ? null : current));
        return;
      }
      setRowButton((current) => (current?.row === row ? current : { row, rect: row.getBoundingClientRect() }));
    };
    // The button is portaled to <body>, so moving onto it leaves the root.
    const onLeave = (event: PointerEvent) => {
      const next = event.relatedTarget as Element | null;
      if (next?.closest?.("[data-thread-comment-row-button]")) return;
      setRowButton(null);
    };
    const onScroll = () => setRowButton(null);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      scroll?.removeEventListener("scroll", onScroll);
    };
  }, [rootRef, scrollRef]);

  const startFromRow = (row: HTMLTableRowElement) => {
    const message = row.closest(THREAD_COMMENT_MESSAGE_SELECTOR) as HTMLElement | null;
    const messageKey = message?.dataset.threadCommentKey;
    if (!message || !messageKey) return;
    const anchor = captureTableRowAnchor(message, row);
    if (!anchor) return;
    setRowButton(null);
    const range = document.createRange();
    range.selectNodeContents(row);
    openDraft({ sessionId, messageKey, messageExcerpt: messageExcerptOf(message), anchor, rect: row.getBoundingClientRect(), range });
  };

  const startFromMedia = (element: HTMLElement) => {
    const message = element.closest(THREAD_COMMENT_MESSAGE_SELECTOR) as HTMLElement | null;
    const messageKey = message?.dataset.threadCommentKey;
    if (!message || !messageKey) return;
    const anchor = captureMediaAnchor(message, element);
    if (!anchor) return;
    const box = threadMediaBox(element);
    openDraft({ sessionId, messageKey, messageExcerpt: messageExcerptOf(message), anchor, rect: box.getBoundingClientRect(), range: rangeAroundNode(box), mediaBox: box });
  };

  const mediaComments = (element: HTMLElement) => resolved.filter((entry) => entry.media?.element === element);

  // ── "Show in thread" from the composer list ──
  useEffect(() => {
    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; commentId: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      const comment = commentsRef.current.find((entry) => entry.id === detail.commentId);
      const root = rootRef.current;
      if (!comment || !root) return;
      const message = messageElement(root, comment.messageKey);
      const range = message ? resolveThreadCommentRange(message, comment.anchor) : null;
      const target = range?.startContainer.parentElement ?? message;
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      closeDraftKeepingText();
      setOpenCommentId(comment.id);
    };
    window.addEventListener(THREAD_COMMENT_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(THREAD_COMMENT_FOCUS_EVENT, onFocus);
  }, [closeDraftKeepingText, rootRef, sessionId]);

  // Escape closes whatever is open.
  useEffect(() => {
    if (!draft && !openCommentId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || editingId) return;
      discardDraft();
      setOpenCommentId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [discardDraft, draft, editingId, openCommentId]);

  // A comment that went with a send, or was deleted elsewhere, closes.
  useEffect(() => {
    if (openCommentId && !comments.some((comment) => comment.id === openCommentId)) setOpenCommentId(null);
    if (editingId && !comments.some((comment) => comment.id === editingId)) stopEditing();
  }, [comments, editingId, openCommentId, stopEditing]);

  const saveDraft = async (body: string) => {
    if (!draft) return;
    const api = threadCommentsApi();
    if (!api) {
      setDraftError("This version of ADE cannot save comments.");
      return;
    }
    // The comment shows (highlight, margin card, send badge) the moment it is
    // saved; the host's answer only confirms it. A refusal puts the box back.
    const saving = draft;
    const fields = {
      messageKey: saving.messageKey,
      messageExcerpt: saving.messageExcerpt,
      anchor: saving.anchor,
      body,
    };
    const settle = addLocalThreadComment(sessionId, fields);
    discardDraft();
    try {
      settle(await api.create({ sessionId, ...fields }, pin ?? null));
    } catch (error) {
      settle(null);
      // Reopen the box with the text and the reason, unless another comment
      // was started since (that box is the user's now) or the user left this
      // chat; then the text waits for the next box on the same words.
      if (draftRef.current || saving.sessionId !== sessionIdRef.current) {
        keepUnsavedDraftBody(saving, body);
        return;
      }
      draftBodyRef.current = body;
      setDraft({ ...saving, body });
      setDraftError(threadCommentErrorText(error));
    }
  };

  // ── Margin card layout: each card at its anchor's height, pushed down past the one above ──
  const cardLayout = useMemo(() => {
    const content = contentRef.current;
    if (!marginMode || !content) return [];
    const contentTop = content.getBoundingClientRect().top;
    const zoom = cssZoomOf(content);
    const placed: Array<{ comment: ChatThreadComment; top: number }> = [];
    const sorted = resolved
      .map((entry) => ({ comment: entry.comment, anchorTop: (entry.range.getBoundingClientRect().top - contentTop) / zoom }))
      .sort((a, b) => a.anchorTop - b.anchorTop);
    let floor = -Infinity;
    for (const entry of sorted) {
      const top = Math.max(entry.anchorTop - 4, floor);
      placed.push({ comment: entry.comment, top });
      floor = top + (cardHeightsRef.current.get(entry.comment.id) ?? 64) + CARD_GAP_PX;
    }
    return placed;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometry re-reads on these ticks
  }, [cardHeightsVersion, contentRef, geometryTick, marginMode, resolved]);

  const measureCard = useCallback((commentId: string, el: HTMLElement | null) => {
    if (!el) return;
    const height = el.offsetHeight;
    if (cardHeightsRef.current.get(commentId) !== height) {
      cardHeightsRef.current.set(commentId, height);
      setCardHeightsVersion((version) => version + 1);
    }
  }, []);

  const openComment = openCommentId ? comments.find((comment) => comment.id === openCommentId) ?? null : null;
  const openRange = openComment ? resolved.find((entry) => entry.comment.id === openComment.id)?.range ?? null : null;
  const content = contentRef.current;

  return (
    <>
      {/* Margin cards, in the column's own scroll content. */}
      {marginMode && content && cardLayout.length
        ? createPortal(
          <div aria-label="Comments" className="pointer-events-none absolute inset-y-0 left-full" style={{ width: Math.min(marginWidth, 280) }}>
            {cardLayout.map(({ comment, top }) => {
              const active = comment.id === openCommentId || comment.id === editingId;
              return (
                <div
                  key={comment.id}
                  ref={(el) => measureCard(comment.id, el)}
                  data-thread-comment-ignore=""
                  data-testid="thread-comment-card"
                  className={cn(
                    "pointer-events-auto absolute left-5 right-0 rounded-lg border bg-(color:--work-popover-bg) shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-[border-color,top] duration-150",
                    active
                      ? "border-[color:color-mix(in_srgb,var(--chat-accent)_55%,transparent)]"
                      : "border-fg/[0.07] hover:border-fg/[0.14]",
                  )}
                  style={{ top }}
                  onMouseEnter={() => {
                    if (!editingId) setOpenCommentId(comment.id);
                  }}
                  onMouseLeave={() => {
                    if (!editingId) setOpenCommentId((current) => (current === comment.id ? null : current));
                  }}
                >
                  <ThreadCommentListItem {...actions.itemProps(comment)} />
                </div>
              );
            })}
          </div>,
          content,
        )
        : null}

      {/* Narrow thread: a clicked highlight opens its comment here instead. */}
      {!marginMode && openComment && openRange
        ? (
          <ViewportOverlayPortal layer="popover">
            <div
              data-thread-comment-ignore=""
              data-testid="thread-comment-popover"
              className={cn("pointer-events-auto absolute", POPOVER_SURFACE_CLASS, "p-1")}
              style={{ ...placeNear(openRange.getBoundingClientRect(), "below"), width: POPOVER_WIDTH_PX }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <ThreadCommentListItem {...actions.itemProps(openComment)} />
              <div className="flex justify-end px-1 pb-1">
                <button
                  type="button"
                  onClick={() => {
                    stopEditing();
                    setOpenCommentId(null);
                  }}
                  className="rounded-md px-2 py-0.5 font-sans text-[11px] text-fg/55 hover:bg-fg/[0.06] hover:text-fg/85"
                >
                  Close
                </button>
              </div>
            </div>
          </ViewportOverlayPortal>
        )
        : null}

      {/* New comment. */}
      {draft
        ? (
          <ViewportOverlayPortal layer="popover">
            <div
              data-thread-comment-ignore=""
              data-testid="thread-comment-draft"
              className="pointer-events-auto absolute rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)] bg-(color:--work-popover-bg) p-2 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
              style={{ ...placeNear(draft.rect, "above"), width: POPOVER_WIDTH_PX }}
            >
              <ThreadCommentEditor
                // A box on other text starts from that text's own body.
                key={unsavedDraftKey(draft)}
                initialBody={draft.body}
                error={draftError}
                placeholder="Comment for the agent. It goes with your next message."
                onSave={(body) => void saveDraft(body)}
                onCancel={discardDraft}
                onBodyChange={(body) => {
                  draftBodyRef.current = body;
                }}
              />
            </div>
          </ViewportOverlayPortal>
        )
        : null}

      {/* Table row button. */}
      {rowButton && !draft
        ? (
          <ViewportOverlayPortal layer="popover">
            <button
              type="button"
              data-thread-comment-row-button=""
              data-testid="thread-comment-row-button"
              aria-label="Comment on this row"
              title="Comment on this row"
              className="pointer-events-auto absolute inline-flex h-6 w-6 items-center justify-center rounded-md border border-fg/[0.1] bg-(color:--work-popover-bg) text-[var(--chat-accent)] shadow-[0_6px_18px_rgba(0,0,0,0.4)] transition-colors hover:bg-(color:--color-surface-raised)"
              style={(() => {
                const zoom = cssZoomOf();
                return {
                  left: Math.min(rowButton.rect.right / zoom - 30, window.innerWidth / zoom - 30),
                  top: rowButton.rect.top / zoom + Math.max(0, Math.min(rowButton.rect.height / zoom / 2 - 12, 6)),
                };
              })()}
              onPointerLeave={(event) => {
                const next = event.relatedTarget as Element | null;
                if (!next?.closest("tbody tr")) setRowButton(null);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => startFromRow(rowButton.row)}
            >
              <ChatTeardropText size={13} weight="fill" aria-hidden />
            </button>
          </ViewportOverlayPortal>
        )
        : null}

      <ThreadMediaActions
        rootRef={rootRef}
        scrollRef={scrollRef}
        disabled={Boolean(draft)}
        onComment={startFromMedia}
        onAttach={onAttachMedia}
        commentCount={(element) => mediaComments(element).length}
        onOpenComments={(element) => {
          const first = mediaComments(element)[0];
          if (!first) return;
          closeDraftKeepingText();
          setOpenCommentId(first.comment.id);
        }}
      />

      <AssistantOutputSelectionToolbar rootRef={rootRef} onAddToChat={onAddToChat} onComment={startFromSelection} onCreateIssue={onCreateIssue} />
    </>
  );
}
