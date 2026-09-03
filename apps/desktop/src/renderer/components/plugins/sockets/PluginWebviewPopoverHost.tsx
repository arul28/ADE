import React from "react";

import { COLORS, FONT_SIZES, SANS_FONT, SPACING } from "../../lanes/laneDesignTokens";
import { useRootAppStore } from "../../../state/appStore";
import { pluginIcon } from "../pluginIcons";
import { PluginPanelHost } from "../PluginPanelHost";
import { PluginWebviewHost, supportsPluginWebviews } from "../PluginWebviewHost";
import {
  closePluginWebviewPopover,
  usePluginWebviewPopover,
  type PluginWebviewPopoverAnchor,
} from "./pluginWebviewPopoverStore";

/**
 * The one anchored plugin page the app can have on screen — a socket popover or
 * a composer picker.
 *
 * Mounted once in `AppShell`, it draws whatever `pluginWebviewPopoverStore`
 * holds: a plugin's own page in a card under the control that opened it.
 * Escape, a click outside, and the page's own `surface.close` all close it.
 *
 * ## Why the page, and not the panel, in a card this small
 *
 * The panel quick view beside this one (`PluginPanelPopoverHost`) answers a
 * different question. That card draws a vocabulary panel because the thing
 * being shown IS a panel — a list of rows ADE knows how to render. This card
 * exists because the acceptance walk found that the vocabulary cannot reach the
 * quality of a compiled page (spec §1), and the surfaces that hurt most were
 * the small anchored ones: an issue quick view, a picker. Those are exactly the
 * places where a plugin's own HTML earns its cost.
 *
 * ## The fallback is the panel, never a card that says "not here"
 *
 * A client that cannot host a guest draws the surface's `panelId` — the panel
 * the manifest already promised as the cross-client rendering. That is the
 * whole contract of a `webview` surface, and telling the reader to go and open
 * a different application instead is not a rendering of it.
 */

/** What a page gets when the manifest surface asks for no particular size. */
export const PLUGIN_WEBVIEW_POPOVER_DEFAULT_WIDTH = 520;
export const PLUGIN_WEBVIEW_POPOVER_DEFAULT_HEIGHT = 640;
/** The margin the card keeps from every edge of the window. */
const EDGE_MARGIN = 12;
/** Gap between the pressed control and the card that answers it. */
const ANCHOR_GAP = 8;

/**
 * Where the card sits, and how big it is allowed to be.
 *
 * Two rules, and the order matters. The size is clamped to the WINDOW first —
 * a plugin asking for 900×1200 on a laptop gets what fits, never a card with a
 * corner off screen — and only then is a position found for it. Below the
 * control when there is room, above when there is not, clamped on both axes,
 * centred when the press came from no locatable control (a keybinding, a menu
 * that already closed).
 *
 * Exported as a pure function so the placement rule can be tested without a
 * guest, a store or a window.
 */
export function pluginWebviewPopoverPosition(
  anchor: PluginWebviewPopoverAnchor | null,
  viewport: { width: number; height: number },
  size?: { width: number; height: number } | null,
): { left: number; top: number; width: number; height: number } {
  const width = Math.max(
    240,
    Math.min(
      size?.width ?? PLUGIN_WEBVIEW_POPOVER_DEFAULT_WIDTH,
      Math.max(240, viewport.width - EDGE_MARGIN * 2),
    ),
  );
  const wanted = Math.max(
    200,
    Math.min(
      size?.height ?? PLUGIN_WEBVIEW_POPOVER_DEFAULT_HEIGHT,
      Math.max(200, viewport.height - EDGE_MARGIN * 2),
    ),
  );
  if (!anchor) {
    return {
      left: Math.max(EDGE_MARGIN, (viewport.width - width) / 2),
      top: Math.max(EDGE_MARGIN, (viewport.height - wanted) / 2),
      width,
      height: wanted,
    };
  }
  const below = anchor.y + anchor.height + ANCHOR_GAP;
  const roomBelow = viewport.height - below - EDGE_MARGIN;
  const roomAbove = anchor.y - ANCHOR_GAP - EDGE_MARGIN;
  // Below unless above is genuinely roomier. A card that flips upward for the
  // sake of twenty pixels reads as a glitch, so the flip needs the space to be
  // worth it. A composer picker takes this branch every time, which is right:
  // the composer sits at the bottom of the window and its picker belongs above.
  const flip = roomBelow < Math.min(wanted, 240) && roomAbove > roomBelow;
  const height = Math.min(wanted, Math.max(200, flip ? roomAbove : roomBelow));
  const top = flip
    ? Math.max(EDGE_MARGIN, anchor.y - ANCHOR_GAP - height)
    : Math.min(below, Math.max(EDGE_MARGIN, viewport.height - height - EDGE_MARGIN));
  const preferredLeft = anchor.x + anchor.width / 2 - width / 2;
  const left = Math.min(
    Math.max(EDGE_MARGIN, preferredLeft),
    Math.max(EDGE_MARGIN, viewport.width - width - EDGE_MARGIN),
  );
  return { left, top, width, height };
}

/**
 * How long a dismissed guest survives before its process is torn down.
 *
 * The one exception to destroy-when-hidden, and it is narrow: a popover is a
 * toggle, so the double press that closes and reopens it is an ordinary thing
 * for a reader to do, and paying a full renderer-process spawn between the two
 * shows as a flash of empty card. A quarter of a second covers that gesture and
 * nothing else — a reader who closed a popover and moved on has its process
 * back before they finish reading the next thing.
 */
export const PLUGIN_WEBVIEW_POPOVER_HIDE_GRACE_MS = 250;

export function PluginWebviewPopoverHost() {
  const request = usePluginWebviewPopover();
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const token = request?.token ?? null;

  const resolved = React.useMemo(() => {
    if (!request) return null;
    const plugin = installedPlugins.find((entry) => entry.pluginId === request.pluginId);
    if (!plugin || !plugin.enabled) return null;
    const surface = plugin.tabs.find((tab) => tab.id === request.surfaceId) ?? null;
    if (!surface) return null;
    return {
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
      icon: plugin.icon,
      brandIcons: plugin.brandIcons,
      title: surface.title,
      panelId: surface.panelId,
      size: surface.popover ?? null,
      entryHtml: surface.kind === "webview" && surface.entryHtml && supportsPluginWebviews()
        ? surface.entryHtml
        : null,
    };
  }, [installedPlugins, request]);

  // A request that no longer resolves — the plugin was disabled or uninstalled,
  // or names a surface that is gone — closes rather than showing an empty card.
  React.useEffect(() => {
    if (token !== null && !resolved) closePluginWebviewPopover(token);
  }, [resolved, token]);

  React.useEffect(() => {
    if (token === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePluginWebviewPopover(token);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token]);

  const close = React.useCallback(() => {
    closePluginWebviewPopover(token ?? undefined);
  }, [token]);

  if (!request || !resolved) return null;

  const position = pluginWebviewPopoverPosition(
    request.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    resolved.size,
  );
  const Icon = pluginIcon(resolved.icon ?? undefined, resolved.brandIcons);

  return (
    <div
      // A full-window catcher rather than a modal backdrop: it dims nothing, so
      // whatever the reader was looking at stays exactly as visible as it was.
      // A picker over the composer especially needs that — the draft it is
      // about to write into is the thing behind it.
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "transparent" }}
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-label={`${resolved.title} · ${resolved.displayName}`}
        data-plugin-webview-popover={resolved.pluginId}
        data-plugin-webview-popover-kind={request.kind}
        style={{
          position: "absolute",
          left: position.left,
          top: position.top,
          width: position.width,
          height: position.height,
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
          <span style={{ fontWeight: 600, color: COLORS.textSecondary }}>{resolved.title}</span>
          <span style={{ opacity: 0.7 }}>· {resolved.displayName}</span>
        </header>
        {resolved.entryHtml ? (
          <PluginWebviewHost
            key={`${resolved.pluginId}:${request.surfaceId}`}
            pluginId={resolved.pluginId}
            entryHtml={resolved.entryHtml}
            active
            placement={request.kind}
            surfaceId={request.surfaceId}
            onRequestClose={close}
            hideGraceMs={PLUGIN_WEBVIEW_POPOVER_HIDE_GRACE_MS}
            context={{
              subject: request.subject,
              ...(request.pointer ? { pointer: request.pointer } : {}),
            }}
          />
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACING.md }}>
            <PluginPanelHost
              pluginId={resolved.pluginId}
              panelId={resolved.panelId}
              active
              {...(request.subject ? { surfaceContext: request.subject } : {})}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default PluginWebviewPopoverHost;
