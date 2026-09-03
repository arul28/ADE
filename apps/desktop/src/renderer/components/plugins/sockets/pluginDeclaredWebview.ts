import type { PluginActionWebviewPlacement } from "../../../../shared/plugins/sdk";
import type { PluginSocketKind } from "../../../../shared/plugins/sockets";
import type { PluginWebviewPlacement } from "../../../../shared/plugins/webviewBridge";

/**
 * `webviewSurfaceId`, resolved — the one place a socket's declared page is
 * turned into bytes a host can draw.
 *
 * The field is a DECLARATION and never a promise. A manifest may name a surface
 * that was renamed, a plugin may be disabled, a client may have no page host at
 * all, and every one of those is an ordinary state rather than an error: the
 * socket keeps its `panelId`, which is the contract every client already draws.
 * So resolution answers null and the caller falls back, silently — see the note
 * on `PluginActionButtonPayload.webviewSurfaceId`.
 *
 * Written once here rather than in each of the eight hosts because the checks
 * are exactly the ones `PluginSettingsSections` already made — installed,
 * enabled, a `webview` surface of THAT plugin, with an entry page — and eight
 * copies of a four-clause predicate is eight chances for one host to forget the
 * `enabled` half and draw a disabled plugin's page.
 */

/** One surface row off the installed-plugin summary. */
export type PluginWebviewSurfaceRow = {
  id: string;
  kind?: string;
  entryHtml?: string | null;
  panelId?: string;
};

/** The shape this module needs off `state.installedPlugins`. */
export type PluginWebviewInstalledRow = {
  pluginId: string;
  enabled: boolean;
  tabs: readonly PluginWebviewSurfaceRow[];
};

/** A resolved page: which surface, and the plugin-relative file to load. */
export type PluginDeclaredWebview = {
  surfaceId: string;
  entryHtml: string;
};

/**
 * The page a contribution's `webviewSurfaceId` names, or null.
 *
 * Null for every ordinary reason: no declaration, an uninstalled or disabled
 * plugin, an id that names nothing, a surface that is not a `webview`, or one
 * with no entry file. The caller draws its panel, which is what it would have
 * drawn anyway.
 *
 * `supported` is passed in rather than read here so a component asks
 * `supportsPluginWebviews()` once per render instead of once per contribution,
 * and so a test can drive both answers without a module mock.
 */
export function resolvePluginDeclaredWebview(options: {
  pluginId: string;
  surfaceId: string | null | undefined;
  installed: readonly PluginWebviewInstalledRow[];
  supported: boolean;
}): PluginDeclaredWebview | null {
  const { pluginId, surfaceId, installed, supported } = options;
  if (!supported || !surfaceId) return null;
  const plugin = installed.find((entry) => entry.pluginId === pluginId);
  if (!plugin?.enabled) return null;
  const surface = plugin.tabs.find((tab) => tab.id === surfaceId);
  if (!surface || surface.kind !== "webview") return null;
  const entryHtml = surface.entryHtml ?? null;
  return entryHtml ? { surfaceId, entryHtml } : null;
}

/**
 * Read a `webviewSurfaceId` off a payload that may not have the field yet.
 *
 * Five socket payloads carry it today (`sockets.ts`); the panel-host payload
 * shared by `work-rail-pane` and `drawer-tab` does not, even though the
 * MANIFEST socket does. Reading it structurally rather than by type means the
 * panel rail honours a declaration the moment the payload carries one, and
 * falls back to its `panelId` match until then — which is the behaviour that
 * socket already had.
 */
export function readDeclaredWebviewSurfaceId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { webviewSurfaceId?: unknown }).webviewSurfaceId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The page a PANEL-HOST slot draws — a `work-rail-pane` or a `drawer-tab`.
 *
 * Two resolutions in priority order, and the order is the whole point:
 *
 * 1. The socket's own `webviewSurfaceId`, when it carries one.
 * 2. Otherwise a `webview` surface naming the slot's `panelId` — which is what
 *    every slot resolved by before the field existed, and what a plugin
 *    declaring no surface id still resolves by.
 *
 * The panel match alone is AMBIGUOUS, and ade-linear is the proof: it declares
 * `issues`, `quickview` and `picker` all naming `panelId: "issues"`, so the
 * rail pane resolves by declaration ORDER. It lands on the right one today and
 * would move to the popover's page the day someone reordered the manifest.
 *
 * A declared id that resolves to nothing does NOT fall through to the panel
 * match: the socket named a surface, and drawing a different one because that
 * name was wrong would be the host guessing. It draws the panel instead, which
 * is where every unresolvable declaration lands.
 */
export function resolvePluginSlotWebview(options: {
  pluginId: string;
  panelId: string;
  /** The contribution payload, read structurally — see the note above. */
  payload: unknown;
  installed: readonly PluginWebviewInstalledRow[];
  supported: boolean;
}): PluginDeclaredWebview | null {
  const { pluginId, panelId, payload, installed, supported } = options;
  const declared = readDeclaredWebviewSurfaceId(payload);
  if (declared) {
    return resolvePluginDeclaredWebview({ pluginId, surfaceId: declared, installed, supported });
  }
  if (!supported) return null;
  const plugin = installed.find((entry) => entry.pluginId === pluginId);
  if (!plugin?.enabled) return null;
  const surface = plugin.tabs.find((tab) => (
    tab.kind === "webview" && tab.panelId === panelId && Boolean(tab.entryHtml)
  ));
  return surface?.entryHtml ? { surfaceId: surface.id, entryHtml: surface.entryHtml } : null;
}

/**
 * Where each socket kind draws a declared page — the placement half of G15.
 *
 * A closed table rather than a per-host literal because the placement is a
 * property of the SOCKET, not of the component that happens to draw it: a
 * composer button's page is a picker over the composer wherever the composer
 * is, and a top-bar button's page is a popover under the button. Written down
 * once, it is also assertable — `adeLinearWebviewSockets.test.ts` walks the
 * real manifest and pins the placement every declaring socket reaches.
 *
 * The kinds absent from the table are the ones that cannot host a page: they
 * carry no `webviewSurfaceId` in their payload and have no frame to put a guest
 * in (a filter chip, a slash command, a menu item).
 */
export const PLUGIN_SOCKET_WEBVIEW_PLACEMENT: Partial<Record<PluginSocketKind, PluginWebviewPlacement>> = {
  // Anchored under the control that was pressed. One at a time; a second press
  // of the same control closes it (`pluginWebviewPopoverStore`).
  "toolbar-action": "popover",
  "chat-header-action": "popover",
  // A badge is a control on a ROW, so its card hangs off the badge itself —
  // the `badge-card` case: a lane's issue, read where the lane is listed.
  "row-badge": "popover",
  // Over the composer it is about to write into, not over the button inside it.
  "composer-action": "composer-picker",
  // The palette belongs to no place on screen, so its page cannot be anchored
  // to one. A focused overlay is the honest rendering of a press from ⌘K.
  "command-palette-action": "overlay",
  "settings-section": "settings-section",
  "dialog-section": "dialog-picker",
  // A card body is a frame the transcript already sized, exactly like a rail
  // pane: the page fills it, `ui.resize` is read and dropped, and
  // `surface.close` is the documented no-op a row with no dismissal gets.
  "chat-card": "pane",
  "work-rail-pane": "pane",
  "drawer-tab": "drawer",
};

/**
 * The same table in the vocabulary an `openWebview` answer speaks.
 *
 * `openPluginActionWebview` is the router every action press goes through, and
 * it takes the PLUGIN's word for a placement (`overlay` | `popover` | `picker`)
 * rather than the host's own (`composer-picker`). Kept as a second table rather
 * than a mapping function so the four action kinds are enumerated in one place
 * and a fifth cannot be added without choosing where its page opens.
 */
export const PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT: Partial<Record<PluginSocketKind, PluginActionWebviewPlacement>> = {
  "toolbar-action": "popover",
  "chat-header-action": "popover",
  "row-badge": "popover",
  "composer-action": "picker",
  "command-palette-action": "overlay",
};
