import React from "react";

import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { buildPluginMenuEntries, type PluginMenuEntry } from "./contributionModel";
import { usePluginSurfaceContributions, usePluginSocketInvoke } from "./useSurfaceContributions";

/**
 * Contributed context-menu rows for one entity.
 *
 * Returns the same entry shape `buildLaneMenuGroups` produces, so the Lanes
 * menu appends them with no adapter and the other three menus (Work sessions,
 * PR rows, the Files tree) render them from the same array instead of each
 * hand-rolling a plugin branch in JSX.
 *
 * Placement is the caller's, with one rule: plugin entries go after the
 * surface's own actions and before anything destructive. Nobody should reach
 * for Delete and hit a plugin's row because it moved.
 */
export function usePluginMenuEntries(
  surface: PluginSurfaceId,
  context: PluginSurfaceContext | null,
  options: { active?: boolean; onClose?: () => void } = {},
): PluginMenuEntry[] {
  const active = options.active ?? true;
  const set = usePluginSurfaceContributions(surface, active);
  const invoke = usePluginSocketInvoke();
  const onClose = options.onClose;

  return React.useMemo(() => {
    if (!context) return [];
    return buildPluginMenuEntries({
      set,
      surface,
      context,
      invoke,
      ...(onClose ? { onClose } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- context is rebuilt each render; its identity is not meaningful
  }, [set, surface, invoke, onClose, contextIdentity(context)]);
}

function contextIdentity(context: PluginSurfaceContext | null): string {
  if (!context) return "";
  switch (context.kind) {
    case "pr":
      return `pr:${context.number}`;
    case "lane":
      return `lane:${context.id}`;
    case "session":
      return `session:${context.id}`;
    case "file":
      return `file:${context.path}`;
    case "surface":
      return `surface:${context.surface}`;
  }
}

export type { PluginMenuEntry } from "./contributionModel";
