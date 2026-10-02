import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { ArrowSquareOut, ChatTeardropText, PencilSimple, Trash } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { threadCommentQuoteText, type ChatThreadComment } from "../../../shared/threadComments";
import { fixedMenuAboveAnchorStyle } from "../../lib/fixedMenuPlacement";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import { SmartTooltip } from "../ui/SmartTooltip";
import { countCommentsForNextSend, setThreadComments, threadCommentsApi } from "./threadCommentsStore";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);
}

/**
 * Comment writes for one chat. Each call returns the host's answer; the list
 * itself refreshes from the host's change event, so nothing is patched here
 * except a delete, which also removes the row at once.
 */
export function useThreadCommentActions(sessionId: string | null | undefined, pin: OpenProjectBinding | null | undefined) {
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(action: () => Promise<T> | undefined): Promise<T | null> => {
    setError(null);
    try {
      const result = await action();
      return result ?? null;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  };
  return {
    error,
    clearError: () => setError(null),
    update: (commentId: string, patch: { body?: string; includeInNextSend?: boolean }) =>
      run(() => (sessionId ? threadCommentsApi()?.update({ sessionId, commentId, ...patch }, pin ?? null) : undefined)),
    remove: (commentId: string, comments: readonly ChatThreadComment[]) =>
      run(async () => {
        if (!sessionId) return undefined;
        setThreadComments(sessionId, comments.filter((comment) => comment.id !== commentId));
        return await threadCommentsApi()?.delete({ sessionId, commentId }, pin ?? null);
      }),
  };
}

/** A small comment box. Cmd/Ctrl+Enter saves, Escape cancels. */
export function ThreadCommentEditor({
  initialBody = "",
  placeholder = "Add a comment",
  saveLabel = "Comment",
  busy = false,
  error = null,
  onSave,
  onCancel,
}: {
  initialBody?: string;
  placeholder?: string;
  saveLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 180)}px`;
  }, [body]);
  const canSave = body.trim().length > 0 && !busy;
  return (
    <div className="flex flex-col gap-1.5" data-thread-comment-ignore="">
      <textarea
        ref={ref}
        value={body}
        placeholder={placeholder}
        rows={2}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (canSave) onSave(body.trim());
          }
        }}
        className="w-full resize-none rounded-md border border-white/[0.08] bg-black/25 px-2 py-1.5 font-sans text-[12px] leading-[1.5] text-fg/90 outline-none placeholder:text-fg/35 focus:border-[color:color-mix(in_srgb,var(--chat-accent)_45%,transparent)]"
      />
      {error ? <div className="font-sans text-[11px] text-red-300/85">{error}</div> : null}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-0.5 font-sans text-[11px] text-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg/85"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => onSave(body.trim())}
          className={cn(
            "rounded-md px-2 py-0.5 font-sans text-[11px] font-medium transition-colors",
            canSave
              ? "bg-[var(--chat-accent)] text-white hover:brightness-110"
              : "cursor-not-allowed bg-white/[0.06] text-fg/30",
          )}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

/** One comment in a list: the quote it hangs off, the note, and its controls. */
export function ThreadCommentListItem({
  comment,
  editing,
  error,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggleSend,
  onDelete,
  onJump,
}: {
  comment: ChatThreadComment;
  editing: boolean;
  error?: string | null;
  onStartEdit: () => void;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  onToggleSend?: (next: boolean) => void;
  onDelete: () => void;
  onJump?: () => void;
}) {
  const quote = threadCommentQuoteText(comment.anchor);
  return (
    <div
      className={cn(
        "group/comment flex flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/[0.035]",
        !comment.includeInNextSend && "opacity-60",
      )}
      data-testid="thread-comment-item"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-[3px] h-3 w-[3px] shrink-0 rounded-full bg-[var(--chat-accent)] opacity-80" />
        <div className="line-clamp-2 min-w-0 flex-1 font-sans text-[11px] italic leading-[1.45] text-fg/50" title={quote}>
          {quote}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
          {onJump ? (
            <button type="button" aria-label="Show in thread" title="Show in thread" onClick={onJump} className="rounded p-1 text-fg/45 hover:bg-white/[0.06] hover:text-fg/85">
              <ArrowSquareOut size={12} />
            </button>
          ) : null}
          <button type="button" aria-label="Edit comment" title="Edit" onClick={onStartEdit} className="rounded p-1 text-fg/45 hover:bg-white/[0.06] hover:text-fg/85">
            <PencilSimple size={12} />
          </button>
          <button type="button" aria-label="Delete comment" title="Delete" onClick={onDelete} className="rounded p-1 text-fg/45 hover:bg-red-500/15 hover:text-red-200">
            <Trash size={12} />
          </button>
        </div>
      </div>
      {editing ? (
        <ThreadCommentEditor initialBody={comment.body} saveLabel="Save" error={error} onSave={onSaveEdit} onCancel={onCancelEdit} />
      ) : (
        <button
          type="button"
          onClick={onStartEdit}
          className="whitespace-pre-wrap break-words pl-[11px] text-left font-sans text-[12px] leading-[1.5] text-fg/88"
        >
          {comment.body}
        </button>
      )}
      {onToggleSend ? (
        <label className="flex cursor-pointer items-center gap-1.5 pl-[11px] font-sans text-[10.5px] text-fg/50 select-none">
          <input
            type="checkbox"
            checked={comment.includeInNextSend}
            onChange={(event) => onToggleSend(event.target.checked)}
            className="h-3 w-3 cursor-pointer accent-[var(--chat-accent)]"
          />
          Send with next message
        </label>
      ) : null}
    </div>
  );
}

/**
 * Places the list above its button. The hosted web client zooms <body>, so
 * the rect is converted to layout pixels first; it is 1 in Electron.
 */
function menuStyleAbove(rect: DOMRect) {
  const body = document.body;
  const zoom = body.offsetWidth ? body.getBoundingClientRect().width / body.offsetWidth || 1 : 1;
  return fixedMenuAboveAnchorStyle(
    { left: rect.left / zoom, top: rect.top / zoom, right: rect.right / zoom },
    { width: 340, align: "end", viewportWidth: window.innerWidth / zoom },
  );
}

/**
 * The comments button that sits left of Send. Hidden when the chat has no
 * comments; the badge counts the ones the next send carries. Its list is the
 * only way to reach comments when the thread is too narrow for margin cards.
 */
export function ComposerThreadCommentsButton({
  sessionId,
  pin,
  comments,
  onJumpToComment,
  children,
}: {
  sessionId: string | null;
  pin: OpenProjectBinding | null | undefined;
  comments: readonly ChatThreadComment[];
  onJumpToComment?: (comment: ChatThreadComment) => void;
  /** The Send control. While comments ride the next send, the two merge into one pill. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const actions = useThreadCommentActions(sessionId, pin);
  const sendCount = countCommentsForNextSend(comments);

  useEffect(() => {
    if (!comments.length) setOpen(false);
  }, [comments.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editingId) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [editingId, open]);

  if (!sessionId || comments.length === 0) return <>{children}</>;
  const carrying = sendCount > 0;

  const label = sendCount === comments.length
    ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
    : `${sendCount} of ${comments.length} comments`;
  const rect = open ? buttonRef.current?.getBoundingClientRect() : null;

  const commentsHalf = (
    <SmartTooltip
      forceEnabled
      content={{
        label,
        description: carrying
          ? `Your next message carries ${sendCount === 1 ? "this comment" : `these ${sendCount} comments`} to the agent. Click to review them.`
          : "Every comment is held back. Open the list to choose which ones to send.",
      }}
    >
      <motion.button
        ref={buttonRef}
        type="button"
        data-testid="composer-thread-comments-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}. Open the comment list.`}
        onClick={() => setOpen((value) => !value)}
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: "auto", opacity: 1 }}
        transition={{ type: "spring", stiffness: 520, damping: 34 }}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap font-sans text-[11px] font-semibold tabular-nums transition-colors",
          carrying
            ? "rounded-l-full border-r border-black/15 bg-[var(--chat-accent)] pl-2.5 pr-2 text-white hover:brightness-110"
            : "rounded-full bg-white/[0.05] px-2 text-fg/50 hover:bg-white/[0.08]",
        )}
      >
        <ChatTeardropText size={14} weight={carrying ? "fill" : "regular"} aria-hidden />
        {carrying ? sendCount : comments.length}
      </motion.button>
    </SmartTooltip>
  );

  return (
    <>
      {carrying ? (
        // One pill: the comments half, then Send. `data-carrying-comments`
        // recolors the Send half and squares its left edge (index.css).
        <div
          className="ade-send-cluster inline-flex shrink-0 items-center overflow-hidden rounded-full shadow-[0_0_0_1px_color-mix(in_srgb,var(--chat-accent)_45%,transparent),0_4px_16px_color-mix(in_srgb,var(--chat-accent)_28%,transparent)]"
          data-carrying-comments="true"
        >
          {commentsHalf}
          {children}
        </div>
      ) : (
        <>
          {commentsHalf}
          {children}
        </>
      )}
      {open && rect
        ? createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Thread comments"
            data-testid="composer-thread-comments-menu"
            className="fixed flex max-h-[min(60vh,520px)] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
            style={{ ...menuStyleAbove(rect), zIndex: Z_LAYERS.popover }}
          >
            <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
              <span className="font-sans text-[12px] font-semibold text-fg/85">Comments</span>
              <span className="font-sans text-[10.5px] text-fg/45">
                {sendCount > 0 ? `${sendCount} go with your next message` : "None go with your next message"}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {comments.map((comment) => (
                <ThreadCommentListItem
                  key={comment.id}
                  comment={comment}
                  editing={editingId === comment.id}
                  error={editingId === comment.id ? actions.error : null}
                  onStartEdit={() => {
                    actions.clearError();
                    setEditingId(comment.id);
                  }}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={(body) => {
                    void actions.update(comment.id, { body }).then((saved) => {
                      if (saved) setEditingId(null);
                    });
                  }}
                  onToggleSend={(next) => void actions.update(comment.id, { includeInNextSend: next })}
                  onDelete={() => void actions.remove(comment.id, comments)}
                  onJump={onJumpToComment ? () => {
                    setOpen(false);
                    onJumpToComment(comment);
                  } : undefined}
                />
              ))}
            </div>
            {actions.error && !editingId ? (
              <div className="border-t border-white/[0.06] px-3 py-1.5 font-sans text-[11px] text-red-300/85">{actions.error}</div>
            ) : null}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
