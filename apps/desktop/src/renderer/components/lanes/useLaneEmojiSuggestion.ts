import { useCallback, useEffect, useRef, useState } from "react";
import type { JevChoiceQuestion, JevDecideRequest, OpenProjectBinding } from "../../../shared/types";
import { LANE_EMOJI_OPTIONS, normalizeLaneEmoji } from "../../../shared/laneEmoji";

/** The lane name has to sit still this long before Jev is asked for its emoji: about one call per name. */
const LANE_EMOJI_SETTLE_MS = 1_200;
const LANE_EMOJI_MIN_CONFIDENCE = 0.5;

async function requestLaneEmojiSuggestion(
  name: string,
  pin: OpenProjectBinding | null,
): Promise<string | null> {
  const criteria = Object.fromEntries(LANE_EMOJI_OPTIONS.map(({ emoji, meaning }) => [emoji, meaning]));
  const request: JevDecideRequest<{ emoji: JevChoiceQuestion }> = {
    feature: "lane_emoji",
    state: name,
    questions: {
      emoji: {
        type: "choice",
        instructions: "Choose the emoji for the lane's main outcome. When the name describes fixing a crash, bug, error, regression, race, or broken behavior, choose 🐛 even if it also names a system such as sync, cache, or retry. Use ♻️ for refactors and 🔄 for normal sync or retry work that is not a bug fix.",
        criteria,
      },
    },
    priority: "interactive",
  };
  try {
    const answer = (await window.ade.ai.jevDecide(request, pin))?.emoji;
    if (!answer || answer.type !== "choice" || answer.confidence < LANE_EMOJI_MIN_CONFIDENCE) {
      return null;
    }
    const emoji = normalizeLaneEmoji(answer.choice);
    return emoji && LANE_EMOJI_OPTIONS.some((option) => option.emoji === emoji) ? emoji : null;
  } catch {
    // Jev is optional. A missing helper, rate limit, transport error, or bad
    // response leaves manual lane creation on its ordinary path.
    return null;
  }
}

/**
 * Owns the lane emoji the create dialog shows: the one the user picked and the
 * one Jev suggests once the name has settled.
 *
 * `enabled` is every other condition under which a suggestion may be asked for
 * (dialog open, not configuring for a chat, not busy, lane not created).
 */
export function useLaneEmojiSuggestion({
  name,
  enabled,
  pin,
  pinKey,
}: {
  name: string;
  enabled: boolean;
  pin: OpenProjectBinding | null;
  pinKey: string | null;
}) {
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null);
  const [suggestedEmoji, setSuggestedEmoji] = useState<string | null>(null);
  const userPickedRef = useRef(false);
  const sequenceRef = useRef(0);
  const cacheRef = useRef(new Map<string, string | null>());

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    const trimmed = name.trim();
    setSuggestedEmoji(null);
    if (
      !enabled
      || Array.from(trimmed).length < 3
      || selectedEmoji
      || userPickedRef.current
    ) return;

    if (cacheRef.current.has(trimmed)) {
      setSuggestedEmoji(cacheRef.current.get(trimmed) ?? null);
      return;
    }

    const timer = window.setTimeout(() => {
      void requestLaneEmojiSuggestion(trimmed, pin).then((emoji) => {
        cacheRef.current.set(trimmed, emoji);
        if (
          sequence !== sequenceRef.current
          || userPickedRef.current
          || selectedEmoji
        ) return;
        if (emoji) {
          setSuggestedEmoji(emoji);
        }
      });
    }, LANE_EMOJI_SETTLE_MS);

    return () => window.clearTimeout(timer);
    // Pin identity is carried by pinKey so rebuilt pin objects don't restart a
    // pending stateless suggestion for the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, name, selectedEmoji, pinKey]);

  /** Back to a fresh dialog: nothing picked, nothing suggested. */
  const reset = useCallback(() => {
    setSelectedEmoji(null);
    setSuggestedEmoji(null);
    userPickedRef.current = false;
    sequenceRef.current += 1;
  }, []);

  /** The name changed on its own: drop the suggestion, and a chosen emoji unless the user picked it. */
  const nameChanged = useCallback(() => {
    setSuggestedEmoji(null);
    if (!userPickedRef.current) setSelectedEmoji(null);
  }, []);

  const pick = useCallback((emoji: string | null) => {
    userPickedRef.current = true;
    setSelectedEmoji(emoji);
    setSuggestedEmoji(null);
  }, []);

  const accept = useCallback(() => {
    if (!suggestedEmoji) return;
    setSelectedEmoji(suggestedEmoji);
    setSuggestedEmoji(null);
  }, [suggestedEmoji]);

  return { selectedEmoji, suggestedEmoji, pick, accept, reset, nameChanged };
}
