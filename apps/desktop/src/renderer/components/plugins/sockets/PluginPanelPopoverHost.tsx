import React from "react";

import { COLORS, FONT_SIZES, SANS_FONT, SPACING } from "../../lanes/laneDesignTokens";
import { useRootAppStore } from "../../../state/appStore";
import { pluginIcon } from "../pluginIcons";
import { PluginPanelHost } from "../PluginPanelHost";
import {
  closePluginPanelPopover,
  navigatePluginPanelPopover,
  usePluginPanelPopover,
  type PluginPanelPopoverAnchor,
} from "./pluginPanelPopoverStore";

/**
 * The one plugin panel quick view the app can have anchored on screen.
 *
 * Mounted once in `AppShell`, it draws whatever `pluginPanelPopoverStore`
 * holds: a full {@link PluginPanelHost} — refresh, actions and all — in a card
 * under the control that was pressed. Escape and a click outside close it.
 *
 * ## Why a toolbar button needed a third answer
 *
 * A `toolbar-action` on surface `app` sits in the window's top bar, and its
 * `{navigate}` had two places to land. The tab takes the whole window away from
 * whatever the reader was doing, which is far too much for "how many builds are
 * red". The Work tools rail is not reachable at all: the top bar belongs to no
 * chat, so there is no rail on screen to open into. What the button wanted was
 * the shape every other top-bar control already has — a quick view under the
 * mark, read and dismissed without leaving the page.
 *
 * ## It is the panel, not a summary of it
 *
 * The card mounts the same host a tab does, with the same `onNavigate`, so a
 * row inside it that opens a detail panel keeps the reader in the card rather
 * than throwing them out to a route. That is the whole difference between a
 * quick view and a tooltip: the reader can act on what they are looking at.
 */

/** Width of the card, and the margin it keeps from every edge of the window. */
const CARD_WIDTH = 380;
const EDGE_MARGIN = 12;
/** Gap between the pressed control and the card that answers it. */
const ANCHOR_GAP = 8;
/**
 * How tall the card may grow before its content scrolls.
 *
 * A ceiling rather than a fit: a plugin that publishes two hundred rows into a
 * panel must not produce a card taller than the window, and a panel too big for
 * this is one whose author should have asked for the tab.
 */
const CARD_MAX_HEIGHT = 460;

/**
 * Where the card sits, given the control it belongs to.
 *
 * The same rule as the prompt card: below the control when there is room, above
 * it when there is not, clamped into the window on both axes, and centred when
 * the press had no locatable control. Shared by shape rather than by code —
 * this one clamps its own height as well, and the two cards are close enough
 * that a common helper would need a parameter for every difference.
 */
export function pluginPopoverPosition(
  anchor: PluginPanelPopoverAnchor | null,
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const available = Math.max(160, viewport.height - EDGE_MARGIN * 2);
  const maxHeight = Math.min(CARD_MAX_HEIGHT, available);
  if (!anchor) {
    return {
      left: Math.max(EDGE_MARGIN, (viewport.width - CARD_WIDTH) / 2),
      top: Math.max(EDGE_MARGIN, (viewport.height - maxHeight) / 2),
      maxHeight,
    };
  }
  const below = anchor.y + anchor.height + ANCHOR_GAP;
  const roomBelow = viewport.height - below - EDGE_MARGIN;
  const roomAbove = anchor.y - ANCHOR_GAP - EDGE_MARGIN;
  // Below unless above is genuinely roomier. A card that flips upward for the
  // sake of twenty pixels reads as a glitch, so the flip needs the space to be
  // worth it.
  const flip = roomBelow < Math.min(maxHeight, 200) && roomAbove > roomBelow;
  const height = Math.min(maxHeight, Math.max(160, flip ? roomAbove : roomBelow));
  const top = flip
    ? Math.max(EDGE_MARGIN, anchor.y - ANCHOR_GAP - height)
    : below;
  const preferredLeft = anchor.x + anchor.width / 2 - CARD_WIDTH / 2;
  const left = Math.min(
    Math.max(EDGE_MARGIN, preferredLeft),
    Math.max(EDGE_MARGIN, viewport.width - CARD_WIDTH - EDGE_MARGIN),
  );
  return { left, top, maxHeight: height };
}

export function PluginPanelPopoverHost() {
  const request = usePluginPanelPopover();
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const token = request?.token ?? null;

  React.useEffect(() => {
    if (token === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePluginPanelPopover(token);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token]);

  const onNavigate = React.useCallback(
    (navigation: { panelId: string; context?: Record<string, unknown> }) => {
      navigatePluginPanelPopover({
        // Read off the store rather than closed over, so a navigation that
        // arrives after a replace moves the popover that is actually up.
        pluginId: request?.pluginId ?? "",
        panelId: navigation.panelId,
        context: navigation.context ?? null,
      });
    },
    [request?.pluginId],
  );

  // A plugin switched off while its quick view is up has nothing left to draw.
  // Closing is the honest answer and costs the reader nothing: they can still
  // press the button, which will now say why. An uninstall is left alone — the
  // registry is empty before its first read, and closing on that would take the
  // card down during startup for a plugin that is plainly there.
  const disabled = request !== null
    && installedPlugins.some(
      (entry) => entry.pluginId === request.pluginId && !entry.enabled,
    );
  React.useEffect(() => {
    if (token !== null && disabled) closePluginPanelPopover(token);
  }, [disabled, token]);

  if (!request || disabled) return null;

  const plugin = installedPlugins.find((entry) => entry.pluginId === request.pluginId) ?? null;
  const title = plugin?.displayName ?? request.pluginId;
  const Icon = pluginIcon(plugin?.icon, plugin?.brandIcons);
  const position = pluginPopoverPosition(request.anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return (
    <div
      // A full-window catcher rather than a modal backdrop: it dims nothing, so
      // whatever the reader was looking at stays exactly as visible as it was.
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "transparent" }}
      onMouseDown={() => closePluginPanelPopover(request.token)}
    >
      <div
        role="dialog"
        aria-label={title}
        data-tour="plugin:popover"
        data-plugin-popover={request.pluginId}
        style={{
          position: "absolute",
          left: position.left,
          top: position.top,
          width: CARD_WIDTH,
          maxHeight: position.maxHeight,
          borderRadius: 8,
          border: `1px solid ${COLORS.outlineBorder}`,
          background: COLORS.cardBgSolid,
          boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
          fontFamily: SANS_FONT,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: `${SPACING.sm}px ${SPACING.md}px`,
            borderBottom: `1px solid ${COLORS.borderMuted}`,
            fontSize: FONT_SIZES.sm,
            color: COLORS.textMuted,
          }}
        >
          <Icon size={12} weight="regular" color={COLORS.textMuted} />
          <span style={{ fontWeight: 600, color: COLORS.textSecondary }}>{title}</span>
        </header>
        <div style={{ overflowY: "auto", padding: SPACING.md }}>
          <PluginPanelHost
            pluginId={request.pluginId}
            panelId={request.panelId}
            active
            renderContext={request.context}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </div>
  );
}

export default PluginPanelPopoverHost;
