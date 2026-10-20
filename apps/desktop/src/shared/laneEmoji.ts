import type { LaneIcon } from "./types/lanes";

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const LEGACY_LANE_ICON_EMOJI: Record<Exclude<LaneIcon, null>, string> = {
  star: "⭐",
  flag: "🚩",
  bolt: "⚡",
  shield: "🛡️",
  tag: "🏷️",
};
const LEGACY_EMOJI_LANE_ICON = Object.fromEntries(
  Object.entries(LEGACY_LANE_ICON_EMOJI).map(([icon, emoji]) => [emoji, icon]),
) as Record<string, Exclude<LaneIcon, null>>;

/** Trim and NFC-normalize one emoji grapheme, or return null for an empty value. */
export function normalizeLaneEmoji(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("Lane emoji must be one emoji or empty.");

  const normalized = value.normalize("NFC").trim();
  if (!normalized) return null;

  const graphemes = segmenter
    ? Array.from(segmenter.segment(normalized), (part) => part.segment)
    : Array.from(normalized);
  const isEmoji = /\p{Extended_Pictographic}/u.test(normalized)
    || /^\p{Regional_Indicator}{2}$/u.test(normalized)
    || normalized.includes("\u20e3");
  if (graphemes.length !== 1 || !isEmoji) {
    throw new Error("Lane emoji must be one emoji or empty.");
  }
  return normalized;
}

/** Preserve the meaning of lane icons written by older ADE peers. */
export function legacyLaneIconEmoji(icon: LaneIcon | string | null | undefined): string | null {
  if (!icon) return null;
  return LEGACY_LANE_ICON_EMOJI[icon as Exclude<LaneIcon, null>] ?? null;
}

/** Preserve a matching old glyph for peers that have not learned lane emoji. */
export function legacyLaneEmojiIcon(emoji: string | null | undefined): LaneIcon | null {
  return emoji ? LEGACY_EMOJI_LANE_ICON[emoji] ?? null : null;
}

export function laneEmojiForDisplay(emoji?: string | null, legacyIcon?: LaneIcon | null): string | null {
  return emoji ?? legacyLaneIconEmoji(legacyIcon);
}
