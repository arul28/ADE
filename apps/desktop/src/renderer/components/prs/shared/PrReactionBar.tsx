import { memo, useEffect, useRef, useState } from "react";

import type { PrReactionContent, PrReviewThreadReaction } from "../../../../shared/types";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

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
  heart: "❤️",
  hooray: "🎉",
  confused: "😕",
  rocket: "🚀",
  eyes: "👀",
};

const EMPTY_REACTIONS: PrReviewThreadReaction[] = [];

function aggregateReactions(reactions: PrReviewThreadReaction[]) {
  const counts = new Map<PrReactionContent, number>();
  for (const reaction of reactions) {
    counts.set(reaction.content, (counts.get(reaction.content) ?? 0) + (reaction.count ?? 1));
  }
  return Array.from(counts.entries()).map(([content, count]) => ({ content, count }));
}

export const PrReactionBar = memo(function PrReactionBar({
  prId,
  subjectId,
  reactions = EMPTY_REACTIONS,
  viewerLogin,
  onError,
}: {
  prId: string;
  /** Global GitHub node id for the PR or comment being reacted to. */
  subjectId?: string | null;
  reactions?: PrReviewThreadReaction[];
  viewerLogin: string | null;
  onError?: (error: unknown) => void;
}) {
  const canReact = Boolean(subjectId && viewerLogin && window.ade?.prs?.reactToComment);
  const subjectKey = `${prId}:${subjectId ?? ""}`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localReactions, setLocalReactions] = useState<PrReviewThreadReaction[]>(reactions);
  const subjectKeyRef = useRef(subjectKey);
  const pendingRef = useRef(0);

  useEffect(() => {
    if (subjectKeyRef.current !== subjectKey) {
      subjectKeyRef.current = subjectKey;
      pendingRef.current = 0;
      setLocalReactions(reactions);
      setPickerOpen(false);
      return;
    }
    if (pendingRef.current === 0) setLocalReactions(reactions);
  }, [reactions, subjectKey]);

  const react = async (content: PrReactionContent) => {
    if (!canReact || !subjectId || !viewerLogin) return;
    const viewer = viewerLogin.toLowerCase();
    if (localReactions.some((reaction) => reaction.content === content && reaction.user.toLowerCase() === viewer)) {
      return;
    }

    const optimisticId = `optimistic:${subjectId}:${content}:${pendingRef.current + 1}`;
    pendingRef.current += 1;
    setLocalReactions((current) => [
      ...current,
      { id: optimisticId, content, user: viewerLogin },
    ]);
    try {
      await window.ade.prs.reactToComment({ prId, commentId: subjectId, content });
    } catch (error) {
      setLocalReactions((current) => current.filter((reaction) => reaction.id !== optimisticId));
      onError?.(error);
    } finally {
      pendingRef.current = Math.max(0, pendingRef.current - 1);
    }
  };

  const grouped = aggregateReactions(localReactions);
  if (!canReact && grouped.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5" data-pr-reaction-bar>
      {grouped.map((reaction) => {
        const mine = Boolean(viewerLogin && localReactions.some(
          (entry) => entry.content === reaction.content && entry.user.toLowerCase() === viewerLogin.toLowerCase(),
        ));
        const label = `React ${reaction.content}`;
        return canReact ? (
          <button
            key={reaction.content}
            type="button"
            onClick={() => void react(reaction.content)}
            aria-label={label}
            title={mine ? "You reacted" : label}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-white/[0.04]"
            style={{
              borderColor: mine ? COLORS.accentBorder : COLORS.border,
              background: mine ? COLORS.accentSubtle : COLORS.recessedBg,
              color: COLORS.textSecondary,
              fontFamily: SANS_FONT,
            }}
          >
            <span>{REACTION_LABELS[reaction.content]}</span>
            <span>{reaction.count}</span>
          </button>
        ) : (
          <span
            key={reaction.content}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
            style={{
              borderColor: COLORS.border,
              background: COLORS.recessedBg,
              color: COLORS.textSecondary,
              fontFamily: SANS_FONT,
            }}
          >
            <span>{REACTION_LABELS[reaction.content]}</span>
            <span>{reaction.count}</span>
          </span>
        );
      })}
      {canReact ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
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
              {REACTION_OPTIONS.map((option) => (
                <button
                  key={option.content}
                  type="button"
                  onClick={() => {
                    void react(option.content);
                    setPickerOpen(false);
                  }}
                  aria-label={`React ${option.content}`}
                  className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-[13px] transition-colors hover:bg-white/[0.08]"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
