import React from "react";

import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import {
  buildPluginMenuEntries,
  pluginContextMemoKey,
  type PluginMenuEntry,
} from "./contributionModel";
import { useExtendSurfaceEntry } from "./useExtendSurfaceEntry";
import { usePluginSurfaceContributions, usePluginSocketInvoke } from "./useSurfaceContributions";

/**
 * Contributed context-menu rows for one entity.
 *
 * Returns the same entry shape `buildLaneMenuGroups` produces, so the Lanes
 * menu appends them with no adapter and the other three menus (Work sessions,
 * PR rows, the Files tree) render them from the same array instead of each
 * hand-rolling a plugin branch in JSX.
 *
 * `includeExtend` appends "Extend this tab…" as the last row. It belongs to the
 * same section — it is what someone does about an empty one — so it is offered
 * here rather than left to each menu to remember, which is how one lane menu
 * ended up with it and the other without.
 *
 * Placement is the caller's, with one rule: plugin entries go after the
 * surface's own actions and before anything destructive. Nobody should reach
 * for Delete and hit a plugin's row because it moved.
 */
export function usePluginMenuEntries(
  surface: PluginSurfaceId,
  context: PluginSurfaceContext | null,
  options: { active?: boolean; onClose?: () => void; includeExtend?: boolean } = {},
): PluginMenuEntry[] {
  const active = options.active ?? true;
  const set = usePluginSurfaceContributions(surface, active);
  const invoke = usePluginSocketInvoke();
  const onClose = options.onClose;
  const includeExtend = options.includeExtend ?? false;
  const extendEntry = useExtendSurfaceEntry(surface, onClose ? { onClose } : {});
  const contextKey = pluginContextMemoKey(context);

  return React.useMemo(() => {
    const entries = context
      ? buildPluginMenuEntries({
        set,
        surface,
        context,
        invoke,
        ...(onClose ? { onClose } : {}),
      })
      : [];
    return includeExtend ? [...entries, extendEntry] : entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contextKey stands in for `context`
  }, [set, surface, invoke, onClose, contextKey, includeExtend, extendEntry]);
}

export type { PluginMenuEntry } from "./contributionModel";
