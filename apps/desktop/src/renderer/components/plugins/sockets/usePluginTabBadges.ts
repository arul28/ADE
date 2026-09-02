import React from "react";

import type { PluginBadgeTone } from "../../../../shared/plugins/sockets";
import { selectPluginTabBadge } from "./contributionModel";
import { usePluginSurfaceContributions } from "./useSurfaceContributions";

export type PluginTabBadgeView = {
  text: string;
  tone: PluginBadgeTone;
  tooltip: string | null;
};

/**
 * Badges for plugin rail tabs, keyed by plugin id.
 *
 * Loads the `app` contribution set only while at least one plugin tab is on
 * the rail. The palette already reads `app` when it is open; this is the
 * other window-chrome consumer, and it must not keep that set hot on a
 * machine with no plugin tabs (activity-entry volume).
 */
export function usePluginTabBadges(
  tabs: readonly { pluginId: string; surfaceId: string }[],
): ReadonlyMap<string, PluginTabBadgeView> {
  const active = tabs.length > 0;
  const set = usePluginSurfaceContributions("app", active);
  return React.useMemo(() => {
    const map = new Map<string, PluginTabBadgeView>();
    if (!active) return map;
    for (const tab of tabs) {
      const badge = selectPluginTabBadge(set, tab.pluginId, tab.surfaceId);
      if (!badge) continue;
      map.set(tab.pluginId, {
        text: badge.payload.text,
        tone: badge.payload.tone,
        tooltip: badge.payload.tooltip ?? null,
      });
    }
    return map;
  }, [active, set, tabs]);
}
