import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { PluginFallbackCard } from "./VocabularyRenderer";
import { isWebClientMode } from "../../lib/webClientMode";
import {
  PLUGIN_WEBVIEW_PROTOCOL,
  pluginWebviewPartition,
  pluginWebviewUrl,
  type PluginWebviewContext,
} from "../../../shared/plugins/webviewBridge";

/**
 * The desktop host for a `webview` surface — a plugin's own HTML page.
 *
 * Everything that makes this safe is decided in the main process: the attach
 * handler is what sets the preload, the partition and the sandbox flags, and
 * the `ade-plugin://` protocol is what decides which bytes exist at all. This
 * component deliberately holds none of that policy. It sets a `src` and draws
 * the states a page can be in, and a compromised renderer that set different
 * attributes would get the same guest anyway.
 *
 * The guest is created imperatively rather than as JSX. `<webview>` is a custom
 * element whose attributes must be present at the moment it is inserted — React
 * sets some of them a tick later, which produces a guest attached with the
 * wrong partition and no way to fix it after the fact. `ChatBuiltInBrowserPanel`
 * builds its guests the same way for the same reason.
 *
 * The two perf laws from `PluginPanelHost` apply here too, and matter more: a
 * webview is a whole extra renderer process. Nothing is created until the
 * surface is first revealed, and a hidden surface keeps its guest but stops
 * painting it.
 */

type PluginWebviewElement = HTMLElement & {
  reload?: () => void;
  getWebContentsId?: () => number;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; message: string };

export function PluginWebviewHost({
  pluginId,
  entryHtml,
  active,
  context = null,
}: {
  pluginId: string;
  /** Plugin-relative path from the manifest surface, already validated there. */
  entryHtml: string;
  /** False while the surface is mounted but not visible. */
  active: boolean;
  /**
   * The subject to inject, for a page mounted onto a chat, lane or PR — a drawer
   * tab or a button-opened overlay. Null for a full tab or pane webview, which
   * belongs to no subject. Encoded into the guest's source URL and captured
   * host-side at attach, so the page reads it as `adePlugin.context` and cannot
   * forge it. A change recreates the guest, the same as a change of page.
   */
  context?: PluginWebviewContext | null;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const guestRef = React.useRef<PluginWebviewElement | null>(null);
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  // Bumped by the Reload button. A fresh guest rather than `reload()`: a page
  // that failed to load has no document to reload, and re-creating it is also
  // what recovers a guest whose process died.
  const [reloadToken, setReloadToken] = React.useState(0);

  // Deferred until the first reveal, then kept: a plugin page can hold
  // unsubmitted work, so tearing the guest down when the user glances at
  // another tab would lose it.
  const [revealed, setRevealed] = React.useState(active);
  React.useEffect(() => {
    if (active) setRevealed(true);
  }, [active]);

  // The context rides in the URL, so the source string is the whole dependency:
  // a change of subject changes the string and recreates the guest, and a parent
  // that hands a fresh-but-equal context object each render does not, because
  // the string is what the effect keys on.
  const src = React.useMemo(
    () => pluginWebviewUrl(pluginId, entryHtml, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- context is folded into the string below.
    [pluginId, entryHtml, context ? JSON.stringify(context) : ""],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    if (!revealed || !host) return;

    setState({ status: "loading" });
    const guest = document.createElement("webview") as PluginWebviewElement;
    guest.style.border = "0";
    guest.style.display = "flex";
    guest.style.height = "100%";
    guest.style.width = "100%";
    guest.style.background = "transparent";
    // Mirrors what the attach handler enforces. Set here as well so the guest is
    // created in its final partition rather than moved into one.
    guest.setAttribute("partition", pluginWebviewPartition(pluginId));
    guest.setAttribute("src", src);

    const onReady = () => setState({ status: "ready" });
    const onFail = (event: Event) => {
      const detail = event as Event & { errorDescription?: string; isMainFrame?: boolean };
      // Subframe failures are the page's own problem to report; only a failed
      // main frame means there is nothing on screen to look at.
      if (detail.isMainFrame === false) return;
      // `errorDescription` is a Chromium code (`ERR_FILE_NOT_FOUND`), which is
      // not a sentence anyone reading this card can use. It goes to the console
      // for whoever is building the plugin; the card says the plain thing.
      if (detail.errorDescription) {
        console.warn("[plugin webview] load failed", pluginId, detail.errorDescription);
      }
      setState({ status: "failed", message: "The page didn’t load." });
    };
    const onGone = () => {
      setState({ status: "failed", message: "The page stopped responding." });
    };

    guest.addEventListener("dom-ready", onReady);
    guest.addEventListener("did-fail-load", onFail);
    guest.addEventListener("render-process-gone", onGone);
    guest.addEventListener("crashed", onGone);
    host.appendChild(guest);
    guestRef.current = guest;

    return () => {
      guest.removeEventListener("dom-ready", onReady);
      guest.removeEventListener("did-fail-load", onFail);
      guest.removeEventListener("render-process-gone", onGone);
      guest.removeEventListener("crashed", onGone);
      guest.remove();
      guestRef.current = null;
    };
  }, [pluginId, src, reloadToken, revealed]);

  React.useEffect(() => {
    const guest = guestRef.current;
    if (!guest) return;
    guest.style.visibility = active ? "visible" : "hidden";
    guest.style.pointerEvents = active ? "auto" : "none";
    guest.setAttribute("aria-hidden", active ? "false" : "true");
  }, [active, state.status]);

  return (
    <div
      data-tour={`plugin:${pluginId}.webview`}
      style={{ position: "relative", display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
    >
      <div ref={hostRef} style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }} />
      {state.status === "failed" ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "flex-start",
            padding: 20,
            background: COLORS.pageBg,
          }}
        >
          <PluginFallbackCard
            fallback={{ title: "This page didn’t open", text: state.message }}
            action={
              <button
                type="button"
                onClick={() => setReloadToken((token) => token + 1)}
                style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
              >
                Try again
              </button>
            }
          />
        </div>
      ) : null}
      {state.status === "loading" ? (
        <span
          role="status"
          style={{
            position: "absolute",
            left: 20,
            top: 20,
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textDim,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: RADII.sm,
            padding: "3px 8px",
          }}
        >
          Loading…
        </span>
      ) : null}
    </div>
  );
}

/**
 * Whether this renderer can host a plugin page.
 *
 * A guest is an Electron construct: the hosted web client has no `<webview>`,
 * no custom protocol and no preload to put the bridge behind, so it renders the
 * surface's fallback panel instead. Asked as a product question rather than by
 * probing for the element, because a probe that answered "yes" in a browser
 * would put an empty box where the page should be.
 */
export function supportsPluginWebviews(): boolean {
  return !isWebClientMode();
}

export { PLUGIN_WEBVIEW_PROTOCOL };

export default PluginWebviewHost;
