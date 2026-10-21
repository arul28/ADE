import type { ReactNode } from "react";
import { laneEmojiForDisplay } from "../../../shared/laneEmoji";
import type { LaneIcon } from "../../../shared/types";

/**
 * A lane's emoji (its own, or the one a legacy icon stands for). Renders
 * `fallback` (default nothing) when the lane has none. Without a `className`
 * the bare emoji text is rendered with no wrapper.
 */
export function LaneEmojiGlyph({
  emoji,
  icon,
  className,
  fallback = null,
}: {
  emoji?: string | null;
  icon?: LaneIcon | null;
  className?: string;
  fallback?: ReactNode;
}) {
  const display = laneEmojiForDisplay(emoji, icon);
  if (!display) return <>{fallback}</>;
  return className ? <span className={className}>{display}</span> : <>{display}</>;
}
