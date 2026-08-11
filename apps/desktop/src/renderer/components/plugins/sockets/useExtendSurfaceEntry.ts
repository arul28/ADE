import React from "react";
import { useNavigate } from "react-router-dom";

import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginMenuEntry } from "./contributionModel";

/** Where "Extend this tab…" goes. The Marketplace reads `extends` and pre-filters. */
export function extendSurfaceRoute(surface: PluginSurfaceId): string {
  return `/marketplace?extends=${encodeURIComponent(surface)}`;
}

/**
 * The "Extend this tab…" row for a surface's overflow menu.
 *
 * It is the discovery path for the whole socket taxonomy: someone who wonders
 * whether the PRs tab can show their own CI signal finds the answer in the PRs
 * tab, not by guessing that a Marketplace exists. Shaped as a menu entry so the
 * surfaces that already render contributed entries render this one the same way.
 */
export function useExtendSurfaceEntry(
  surface: PluginSurfaceId,
  options: { onClose?: () => void } = {},
): PluginMenuEntry {
  const navigate = useOptionalNavigate();
  const onClose = options.onClose;
  return React.useMemo(
    () => ({
      kind: "action",
      key: "plugin-extend-surface",
      label: "Extend this tab…",
      dataTour: `plugin:${surface}.extend`,
      onSelect: () => {
        onClose?.();
        navigate?.(extendSurfaceRoute(surface));
      },
    }),
    [navigate, onClose, surface],
  );
}

/**
 * `useNavigate`, or null when there is no Router above this component.
 *
 * Several of the surfaces that mount this entry — the Files workbench, a row
 * menu — are also rendered standalone in tests and previews, where `useNavigate`
 * throws rather than degrading. A menu row that cannot navigate is a small
 * problem; a socket that crashes the component hosting it is not, and this
 * taxonomy's whole premise is that a plugin surface never takes the product
 * down with it.
 *
 * The call is guarded rather than made conditional on `useInRouterContext`
 * because router presence is fixed for a mounted component's lifetime: the hook
 * sequence is stable either way, and the guard keeps this readable as one call.
 */
function useOptionalNavigate(): ((to: string) => void) | null {
  try {
    return useNavigate();
  } catch {
    return null;
  }
}
