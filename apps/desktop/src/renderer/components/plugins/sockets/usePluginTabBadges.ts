import React from "react";

import { PLUGIN_TAB_BADGE_SURFACE } from "../../../../shared/plugins/context";
import type { PluginBadgeTone } from "../../../../shared/plugins/sockets";
import { selectPluginTabBadge } from "./contributionModel";
import { usePluginSurfaceContributions } from "./useSurfaceContributions";

export type PluginTabBadgeView = {
  text: string;
  tone: PluginBadgeTone;
  tooltip: string | null;
};

/**
 * Longest a rail pill may read, in code points.
 *
 * A `row-badge` payload allows 32 characters, which is right for a lane row and
 * far too much for a 13px circle on a 20px icon: the pill grew until it covered
 * the glyph it belongs to, and the text was unreadable long before that. Six is
 * what iOS clamps to, so a plugin that publishes "12 open" reads the same on
 * both clients.
 *
 * No ellipsis. A character spent on "…" is a character not spent on the count,
 * and at this size the ellipsis is a smudge rather than a signal. The full text
 * stays in the tooltip and in the tab's accessible name, which is where a
 * reader who needs the rest of it looks.
 */
export const PLUGIN_TAB_BADGE_TEXT_MAX = 6;

/** Clamp by CODE POINT, so one emoji is one character rather than two. */
function clampBadgeText(text: string): string {
  const glyphs = Array.from(text);
  return glyphs.length <= PLUGIN_TAB_BADGE_TEXT_MAX
    ? text
    : glyphs.slice(0, PLUGIN_TAB_BADGE_TEXT_MAX).join("");
}

/**
 * Badges for plugin rail tabs, keyed by plugin id.
 *
 * Loads the `app` contribution set only while at least one plugin tab is on
 * the rail. The palette already reads `app` when it is open; this is the
 * other window-chrome consumer, and it must not keep that set hot on a
 * machine with no plugin tabs (activity-entry volume).
 *
 * The surface is named through {@link PLUGIN_TAB_BADGE_SURFACE} rather than
 * spelled here, because the constant IS the declaration a plugin publishes
 * against and a second spelling is a second answer.
 */
export function usePluginTabBadges(
  tabs: readonly { pluginId: string; surfaceId: string }[],
): ReadonlyMap<string, PluginTabBadgeView> {
  const active = tabs.length > 0;
  const set = usePluginSurfaceContributions(PLUGIN_TAB_BADGE_SURFACE, active);
  return React.useMemo(() => {
    const map = new Map<string, PluginTabBadgeView>();
    if (!active) return map;
    for (const tab of tabs) {
      const badge = selectPluginTabBadge(set, tab.pluginId, tab.surfaceId);
      if (!badge) continue;
      const text = clampBadgeText(badge.payload.text);
      map.set(tab.pluginId, {
        text,
        tone: badge.payload.tone,
        // The clamped pill loses characters, so the tooltip carries the whole
        // value when the plugin published no words of its own for it.
        tooltip: badge.payload.tooltip ?? (text === badge.payload.text ? null : badge.payload.text),
      });
    }
    return map;
  }, [active, set, tabs]);
}
