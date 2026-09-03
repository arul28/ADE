import React from "react";

import { splitPluginRowBadges, type PluginSurfaceId } from "../../../../shared/plugins/sockets";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import { useRootAppStore } from "../../../state/appStore";
import { supportsPluginWebviews } from "../PluginWebviewHost";
import { contributionKey } from "./contributionModel";
import {
  PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT,
  resolvePluginDeclaredWebview,
} from "./pluginDeclaredWebview";
import { openPluginActionWebview } from "./pluginActionDispatch";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { useSurfaceContributions } from "./useSurfaceContributions";
import { SocketBoundary } from "./SocketBoundary";
import { SocketBadge, SocketOverflow } from "./socketUi";

/**
 * Plugin badges for one row.
 *
 * Placement is the host's, always after the row's own metadata, and capped at
 * two visible with the rest behind "+N". The cap is not cosmetic: a Lanes or PRs
 * row has a fixed width it already spends on the branch, the state and the
 * timestamp, and an uncapped socket would let one plugin push the product's own
 * information off the row.
 *
 * Renders nothing at all — not an empty flex container — when no plugin
 * contributes here, so an install-free machine pays no layout cost.
 */
export function PluginRowBadges({
  surface,
  context,
  active = true,
  className,
  style,
}: {
  surface: PluginSurfaceId;
  context: PluginSurfaceContext;
  /** False while the hosting surface is mounted but not visible. */
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const contributions = useSurfaceContributions(surface, "row-badge", { active, context });
  const brandIconsFor = usePluginBrandIcons();
  // The registry, for a badge that names a page of its own. Read once for the
  // row rather than per badge: these render inside virtualized lists.
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const webviewSupported = supportsPluginWebviews();

  /**
   * A badge that names a `webview` surface is a CONTROL, not a label.
   *
   * The `badge-card` case: a lane row's issue badge opens the issue's card
   * under itself, anchored on the badge, so the reader gets the issue where the
   * lane is listed instead of navigating away from the list to read one line.
   * The rect is sampled from the pressed element — the popover host has no
   * other way to know where a virtualized row was — and the store's own rule
   * does the rest: one card at a time, and a second press of the same badge
   * closes it.
   *
   * A badge with no resolvable surface stays exactly what it was: a span with a
   * tooltip, no focus ring, and nothing to press.
   */
  const openBadgePage = (
    event: React.MouseEvent<HTMLElement>,
    pluginId: string,
    page: { surfaceId: string },
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    openPluginActionWebview({
      pluginId,
      surfaceId: page.surfaceId,
      ...(PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT["row-badge"]
        ? { placement: PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT["row-badge"] }
        : {}),
      // The row the badge sits on, host-known and injected unforgeably — which
      // is what lets the page look the issue up without the badge carrying it.
      subject: context,
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  };

  if (contributions.length === 0) return null;

  const { visible, overflowCount } = splitPluginRowBadges(contributions);
  const hidden = contributions.slice(visible.length);
  const dataTour = `plugin:${surface}.row-badge`;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, ...style }}
    >
      {visible.map((contribution) => {
        const page = resolvePluginDeclaredWebview({
          pluginId: contribution.pluginId,
          surfaceId: contribution.payload.webviewSurfaceId,
          installed: installedPlugins,
          supported: webviewSupported,
        });
        const badge = (
          <SocketBadge
            dataTour={dataTour}
            text={contribution.payload.text}
            tone={contribution.payload.tone}
            {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
            {...brandIconsProp(brandIconsFor(contribution.pluginId))}
            {...(contribution.payload.tooltip ? { tooltip: contribution.payload.tooltip } : {})}
          />
        );
        return (
          // Real identity, never the array index: these render inside
          // virtualized lists whose rows are re-keyed as you scroll.
          <SocketBoundary key={contributionKey(contribution)}>
            {page ? (
              <button
                type="button"
                data-plugin-badge-webview={page.surfaceId}
                aria-label={contribution.payload.tooltip ?? contribution.payload.text}
                // A bare wrapper: the badge keeps its own chrome, and a button
                // that redrew it would make a pressable badge look unlike the
                // one beside it that is only a label.
                style={{
                  display: "inline-flex",
                  padding: 0,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                }}
                onClick={(event) => openBadgePage(event, contribution.pluginId, page)}
              >
                {badge}
              </button>
            ) : badge}
          </SocketBoundary>
        );
      })}
      {overflowCount > 0 ? (
        <SocketOverflow
          count={overflowCount}
          label={`${overflowCount} more from plugins`}
          dataTour={`plugin:${surface}.row-badge-overflow`}
        >
          {hidden.map((contribution) => (
            <SocketBoundary key={contributionKey(contribution)}>
              <SocketBadge
                text={contribution.payload.text}
                tone={contribution.payload.tone}
                {...(contribution.payload.icon ? { icon: contribution.payload.icon } : {})}
                {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                {...(contribution.payload.tooltip ? { tooltip: contribution.payload.tooltip } : {})}
              />
            </SocketBoundary>
          ))}
        </SocketOverflow>
      ) : null}
    </span>
  );
}
