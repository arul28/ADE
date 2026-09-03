import React from "react";

import { useRootAppStore } from "../../../state/appStore";
import { pluginWebviewRelayBridge } from "../../../lib/pluginRuntimeBridge";
import type { PluginWebviewThemeSnapshot } from "../../../../shared/plugins/webviewBridge";
import { installPluginWebviewRelay } from "./pluginWebviewRelay";
import { applyPluginWebviewReload } from "./pluginWebviewReloadStore";
import { pluginWebviewThemeEqual, readPluginWebviewTheme } from "./pluginWebviewTheme";

/**
 * The window's end of the plugin-page relay, mounted once in `AppShell`.
 *
 * It draws nothing. Three long-lived subscriptions live here because all three
 * belong to the WINDOW rather than to any one guest, and a guest is the wrong
 * place for every one of them:
 *
 * 1. **The UI relay.** Main asks this window to move a piece of ADE's own UI on
 *    a page's behalf. One listener for every guest, because the request carries
 *    the `guestKey` and the registry turns that into the surface that owns it.
 * 2. **The theme.** Published on mount and on every change, once for the window.
 *    A guest cannot read the host's stylesheet, and per-guest publishing would
 *    send the same palette N times for one toggle of one switch.
 * 3. **Hot reload.** Main tells every window a plugin's bytes moved; the store
 *    turns that into a new key and every guest of that plugin recreates itself,
 *    wherever it is drawn.
 *
 * A host with no relay members — a packaged app from before the page tier —
 * mounts this and does nothing, which is the honest degradation: plugin pages
 * still draw, and the verbs that move ADE's UI are refused by a main process
 * that never sends a request in the first place.
 */
export function PluginWebviewRelayHost() {
  const theme = useRootAppStore((state) => state.theme);
  const pluginTheme = useRootAppStore((state) => state.pluginThemeId);

  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    if (!relay) return;
    return installPluginWebviewRelay(relay);
  }, []);

  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    if (!relay) return;
    return relay.onReload((payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const record = payload as Record<string, unknown>;
      if (typeof record.pluginId !== "string" || !record.pluginId) return;
      applyPluginWebviewReload({
        pluginId: record.pluginId,
        version: typeof record.version === "string" ? record.version : "",
        revision: typeof record.revision === "number" ? record.revision : 0,
      });
    });
  }, []);

  // The last snapshot actually sent, so a re-render that changed nothing does
  // not push the palette at every open guest again.
  const published = React.useRef<PluginWebviewThemeSnapshot | null>(null);
  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    if (!relay) return;
    // A frame late on purpose. `App` writes `data-theme` in its own effect, and
    // a computed style read in the same commit would return the palette that is
    // on its way out — which a page would then hold until the next change.
    const timer = requestAnimationFrame(() => {
      const snapshot = readPluginWebviewTheme(theme);
      if (pluginWebviewThemeEqual(published.current, snapshot)) return;
      published.current = snapshot;
      relay.publishTheme(snapshot);
    });
    return () => cancelAnimationFrame(timer);
    // `pluginTheme` is in the list because a `theme` plugin rewrites the very
    // custom properties this reads without touching `theme`: applying one would
    // otherwise leave every plugin page on the palette ADE shipped.
  }, [theme, pluginTheme]);

  return null;
}

export default PluginWebviewRelayHost;
