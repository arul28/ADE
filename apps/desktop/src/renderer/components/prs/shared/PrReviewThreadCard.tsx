import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowSquareOut,
  CheckCircle,
  ChatCircleDots,
  Sparkle,
  X,
} from "@phosphor-icons/react";

import type {
  PrReactionContent,
  PrReviewThread,
  PrReviewThreadComment,
} from "../../../../shared/types";
import {
  COLORS,
  SANS_FONT,
  cardStyle,
  inlineBadge,
  outlineButton,
} from "../../lanes/laneDesignTokens";
import { formatTimeAgo } from "./prFormatters";
import { PrMarkdown } from "./PrMarkdown";

export type PrReviewThreadCardHandle = {
  focus: () => void;
};

type PrReviewThreadCardProps = {
  thread: PrReviewThread;
  prId: string;
  laneId: string | null;
  repoOwner: string;
  repoName: string;
  viewerLogin: string | null;
  modelId?: string | null;
  focused?: boolean;
  onNext?: () => void;
  onPrev?: () => void;
  onFocus?: () => void;
};

type ReactionCommentLite = PrReviewThreadComment & {
  reactions?: ReactionLite[];
};

type ReactionLite = {
  id?: string;
  content: PrReactionContent;
  user?: string;
};

const REACTION_OPTIONS: Array<{ content: PrReactionContent; label: string }> = [
  { content: "+1", label: "👍" },
  { content: "-1", label: "👎" },
  { content: "laugh", label: "😄" },
  { content: "heart", label: "❤️" },
  { content: "hooray", label: "🎉" },
];

const REACTION_LABELS: Record<PrReactionContent, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  confused: "😕",
  heart: "❤️",
  hooray: "🎉",
  rocket: "🚀",
  eyes: "👀",
};

function statusChip(thread: PrReviewThread) {
  if (thread.isResolved) {
    return { label: "Resolved", color: COLORS.success };
  }
  if (thread.isOutdated) {
    return { label: "Outdated", color: COLORS.textMuted };
  }
  return { label: "Open", color: COLORS.warning };
}

function getCommentReactions(comment: ReactionCommentLite): ReactionLite[] {
  return Array.isArray(comment.reactions) ? comment.reactions : [];
}

function aggregateReactions(reactions: ReactionLite[]) {
  const counts = new Map<PrReactionContent, number>();
  for (const r of reactions) {
    counts.set(r.content, (counts.get(r.content) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([content, count]) => ({ content, count }));
}

function AvatarStack({ comments }: { comments: PrReviewThreadComment[] }) {
  const authors: Array<{ login: string; url: string | null }> = [];
  const seen = new Set<string>();
  for (const comment of comments) {
    if (seen.has(comment.author)) continue;
    seen.add(comment.author);
    authors.push({ login: comment.author, url: comment.authorAvatarUrl });
    if (authors.length >= 3) break;
  }
  const overflow = Math.max(0, new Set(comments.map((c) => c.author)).size - authors.length);

  return (
    <div className="flex items-center" style={{ marginLeft: 0 }}>
      {authors.map((a, idx) => (
        <span
          key={a.login}
          title={a.login}
          className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[9px] font-semibold"
          style={{
            marginLeft: idx === 0 ? 0 : -5,
            background: a.url ? "transparent" : COLORS.accentSubtle,
            borderColor: COLORS.border,
            color: COLORS.accent,
            zIndex: 10 - idx,
            overflow: "hidden",
          }}
        >
          {a.url ? (
            <img
              src={a.url}
              alt={`${a.login} avatar`}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            a.login.charAt(0).toUpperCase()
          )}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          className="ml-[-5px] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border px-1 text-[9px] font-semibold"
          style={{
            background: COLORS.recessedBg,
            borderColor: COLORS.border,
            color: COLORS.textMuted,
          }}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

function CommentRow({
  comment,
  prId,
  repoOwner,
  repoName,
  onReact,
}: {
  comment: PrReviewThreadComment;
  prId: string;
  repoOwner: string;
  repoName: string;
  onReact: (commentId: string, content: PrReactionContent) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const reactions = getCommentReactions(comment as ReactionCommentLite);
  const grouped = aggregateReactions(reactions);

  return (
    <div className="flex flex-col gap-1.5 py-2" data-pr-thread-comment>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: COLORS.textMuted }}>
        <span className="font-medium" style={{ color: COLORS.textSecondary }}>
          {comment.author}
        </span>
        <span>·</span>
        <span>{formatTimeAgo(comment.createdAt)}</span>
      </div>
      {comment.body ? (
        <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
          {comment.body}
        </PrMarkdown>
      ) : null}
      <div className="flex items-center gap-1.5">
        {grouped.map((r) => (
          <button
            key={r.content}
            type="button"
            onClick={() => onReact(comment.id, r.content)}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-white/[0.04]"
            style={{
              borderColor: COLORS.border,
              background: COLORS.recessedBg,
              color: COLORS.textSecondary,
              fontFamily: SANS_FONT,
            }}
          >
            <span>{REACTION_LABELS[r.content]}</span>
            <span>{r.count}</span>
          </button>
        ))}
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="Add reaction"
            aria-haspopup="true"
            aria-expanded={pickerOpen}
            className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border text-[11px] transition-colors hover:bg-white/[0.04]"
            style={{ borderColor: COLORS.border, color: COLORS.textMuted }}
          >
            +
          </button>
          {pickerOpen ? (
            <div
              role="menu"
              className="ade-liquid-glass-menu absolute left-0 top-[26px] z-20 flex items-center gap-0.5 px-1 py-1"
              data-pr-reaction-picker
              data-pr-id={prId}
            >
              {REACTION_OPTIONS.map((opt) => (
                <button
                  key={opt.content}
                  type="button"
                  onClick={() => {
                    onReact(comment.id, opt.content);
                    setPickerOpen(false);
                  }}
                  aria-label={`React ${opt.content}`}
                  className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-[13px] transition-colors hover:bg-white/[0.08]"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const PrReviewThreadCard = memo(
  forwardRef<PrReviewThreadCardHandle, PrReviewThreadCardProps>(function PrReviewThreadCard(
    {
      thread,
      prId,
      laneId,
      repoOwner,
      repoName,
      viewerLogin,
      modelId,
      focused,
      onNext,
      onPrev,
      onFocus,
    },
    ref,
  ) {
    const collapsedByDefault = thread.isResolved || thread.isOutdated;
    const [expanded, setExpanded] = useState(!collapsedByDefault);
    const [replyOpen, setReplyOpen] = useState(false);
    const [replyValue, setReplyValue] = useState("");
    const [busy, setBusy] = useState<"reply" | "resolve" | "fix" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [localResolved, setLocalResolved] = useState(thread.isResolved);

    const cardRef = useRef<HTMLDivElement | null>(null);
    const navigate = useNavigate();
    const resolveInFlightRef = useRef(false);
    const replyInFlightRef = useRef(false);

    useEffect(() => {
      setLocalResolved(thread.isResolved);
    }, [thread.isResolved]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        cardRef.current?.focus();
      },
    }));

    useEffect(() => {
      if (focused) {
        cardRef.current?.focus({ preventScroll: true });
      }
    }, [focused]);

    const chip = useMemo(() => {
      return statusChip({ ...thread, isResolved: localResolved });
    }, [thread, localResolved]);

    const fileLabel = useMemo(() => {
      if (!thread.path) return null;
      const line = thread.startLine ?? thread.line ?? thread.originalLine;
      return line ? `${thread.path}:${line}` : thread.path;
    }, [thread]);

    const handleViewDiff = useCallback(() => {
      if (!thread.path) return;
      navigate("/files", {
        state: {
          openFilePath: thread.path,
          laneId,
          mode: "diff",
          startLine: thread.startLine ?? thread.line ?? thread.originalLine ?? null,
        },
      });
    }, [navigate, thread, laneId]);

    const handleReply = useCallback(async () => {
      if (replyInFlightRef.current) return;
      const bridge = window.ade?.prs?.postReviewComment;
      if (!bridge) return;
      const body = replyValue.trim();
      if (!body) return;
      replyInFlightRef.current = true;
      setBusy("reply");
      setError(null);
      try {
        await bridge({ prId, threadId: thread.id, body });
        setReplyValue("");
        setReplyOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        replyInFlightRef.current = false;
        setBusy(null);
      }
    }, [replyValue, prId, thread.id]);

    const handleResolveToggle = useCallback(async () => {
      if (resolveInFlightRef.current) return;
      const bridge = window.ade?.prs?.setReviewThreadResolved;
      if (!bridge) return;
      const next = !localResolved;
      resolveInFlightRef.current = true;
      setBusy("resolve");
      setError(null);
      try {
        const result = await bridge({ prId, threadId: thread.id, resolved: next });
        setLocalResolved(result?.isResolved ?? next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        resolveInFlightRef.current = false;
        setBusy(null);
      }
    }, [localResolved, prId, thread.id]);

    const handleAskAiFix = useCallback(async () => {
      const bridge = window.ade?.prs?.launchIssueResolutionFromThread;
      if (!bridge) return;
      setBusy("fix");
      setError(null);
      try {
        const result = await bridge({
          prId,
          threadId: thread.id,
          commentId: thread.comments[0]?.id ?? null,
          modelId: modelId ?? null,
          fileContext: thread.path
            ? {
                path: thread.path,
                line: thread.line,
                startLine: thread.startLine,
              }
            : null,
        });
        if (result?.href) {
          navigate(result.href);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    }, [prId, thread, modelId, navigate]);

    const handleReact = useCallback(
      async (commentId: string, content: PrReactionContent) => {
        const bridge = window.ade?.prs?.reactToComment;
        if (!bridge) return;
        try {
          await bridge({ prId, commentId, content });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
      [prId],
    );

    const onKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement;
        if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
        if (event.key === "r") {
          event.preventDefault();
          setExpanded(true);
          setReplyOpen(true);
        } else if (event.key === "x") {
          event.preventDefault();
          void handleResolveToggle();
        } else if (event.key === "]" || event.key === "n") {
          event.preventDefault();
          onNext?.();
        } else if (event.key === "[" || event.key === "p") {
          event.preventDefault();
          onPrev?.();
        }
      },
      [handleResolveToggle, onNext, onPrev],
    );

    const containerStyle: CSSProperties = cardStyle({
      padding: 0,
      borderRadius: 12,
      outline: focused ? `2px solid ${COLORS.accent}` : "none",
      outlineOffset: focused ? 1 : 0,
    });

    if (!expanded) {
      return (
        <div
          ref={cardRef}
          data-pr-review-thread-card
          data-expanded="false"
          data-resolved={localResolved ? "true" : "false"}
          tabIndex={0}
          role="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (e.key === "Enter" || e.key === " ") setExpanded(true);
          }}
          className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
          style={containerStyle}
        >
          <CheckCircle
            size={14}
            weight={localResolved ? "fill" : "regular"}
            style={{ color: localResolved ? COLORS.success : COLORS.textMuted }}
          />
          <span
            className="flex-1 truncate text-[12px]"
            style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
          >
            <span style={{ color: COLORS.textPrimary, fontWeight: 500 }}>{chip.label}</span>
            <span> · {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}</span>
            {fileLabel ? <span> · {fileLabel}</span> : null}
          </span>
        </div>
      );
    }

    return (
      <div
        ref={cardRef}
        data-pr-review-thread-card
        data-expanded="true"
        data-resolved={localResolved ? "true" : "false"}
        tabIndex={0}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className="flex flex-col"
        style={containerStyle}
      >
        <div
          className="flex items-center gap-3 border-b px-4 py-2.5"
          style={{ borderColor: COLORS.border }}
        >
          <AvatarStack comments={thread.comments} />
          <div className="flex min-w-0 flex-1 flex-col">
            {fileLabel ? (
              <span
                className="truncate text-[11px] font-medium"
                style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
              >
                {fileLabel}
              </span>
            ) : null}
            <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
              {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}
            </span>
          </div>
          <span style={inlineBadge(chip.color, { padding: "2px 8px" })}>{chip.label}</span>
          <button
            type="button"
            aria-label="Collapse thread"
            onClick={() => setExpanded(false)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] transition-colors hover:bg-white/[0.06]"
            style={{ color: COLORS.textMuted }}
          >
            <X size={12} weight="bold" />
          </button>
        </div>

        <div className="flex flex-col px-4">
          {thread.comments.map((c, idx) => (
            <div
              key={c.id}
              style={idx > 0 ? { borderTop: `1px solid ${COLORS.borderMuted}` } : undefined}
            >
              <CommentRow
                comment={c}
                prId={prId}
                repoOwner={repoOwner}
                repoName={repoName}
                onReact={handleReact}
              />
            </div>
          ))}
        </div>

        {error ? (
          <div
            className="mx-4 mb-2 rounded-[6px] border px-3 py-2 text-[11px]"
            style={{
              borderColor: `${COLORS.danger}40`,
              background: `${COLORS.danger}10`,
              color: COLORS.danger,
              fontFamily: SANS_FONT,
            }}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {replyOpen ? (
          <div className="flex flex-col gap-2 border-t px-4 py-3" style={{ borderColor: COLORS.border }}>
            <textarea
              value={replyValue}
              onChange={(e) => setReplyValue(e.target.value)}
              placeholder={viewerLogin ? `Reply as @${viewerLogin}…` : "Reply…"}
              rows={3}
              className="w-full resize-y rounded-[8px] border px-3 py-2 text-[12px] outline-none"
              style={{
                borderColor: COLORS.border,
                background: COLORS.recessedBg,
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReplyOpen(false);
                  setReplyValue("");
                }}
                style={outlineButton({ height: 28, fontSize: 11 })}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReply}
                disabled={!replyValue.trim() || busy === "reply"}
                style={outlineButton({
                  height: 28,
                  fontSize: 11,
                  background: COLORS.accentSubtle,
                  borderColor: COLORS.accentBorder,
                  color: COLORS.accent,
                  opacity: !replyValue.trim() || busy === "reply" ? 0.5 : 1,
                })}
              >
                {busy === "reply" ? "Posting…" : "Post reply"}
              </button>
            </div>
          </div>
        ) : null}

        <div
          className="flex flex-wrap items-center gap-2 border-t px-4 py-2"
          style={{ borderColor: COLORS.border, background: "rgba(255,255,255,0.01)" }}
        >
          {thread.path ? (
            <button
              type="button"
              onClick={handleViewDiff}
              style={outlineButton({ height: 26, fontSize: 11, padding: "0 10px" })}
            >
              <ArrowSquareOut size={11} weight="regular" />
              View file diff
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setReplyOpen((v) => !v)}
            style={outlineButton({ height: 26, fontSize: 11, padding: "0 10px" })}
          >
            <ChatCircleDots size={11} weight="regular" />
            Reply
          </button>
          <button
            type="button"
            onClick={handleResolveToggle}
            disabled={busy === "resolve"}
            style={outlineButton({
              height: 26,
              fontSize: 11,
              padding: "0 10px",
              color: localResolved ? COLORS.textSecondary : COLORS.success,
              opacity: busy === "resolve" ? 0.6 : 1,
            })}
          >
            <CheckCircle size={11} weight={localResolved ? "fill" : "regular"} />
            {localResolved ? "Unresolve" : "Resolve"}
          </button>
          <button
            type="button"
            onClick={handleAskAiFix}
            disabled={busy === "fix"}
            style={outlineButton({
              height: 26,
              fontSize: 11,
              padding: "0 10px",
              color: COLORS.accent,
              borderColor: COLORS.accentBorder,
              background: COLORS.accentSubtle,
              opacity: busy === "fix" ? 0.6 : 1,
            })}
          >
            <Sparkle size={11} weight="regular" />
            {busy === "fix" ? "Launching…" : "Ask AI to fix"}
          </button>
        </div>
      </div>
    );
  }),
);

export default PrReviewThreadCard;
