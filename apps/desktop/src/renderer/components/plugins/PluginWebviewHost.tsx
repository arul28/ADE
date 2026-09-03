import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { PluginFallbackCard } from "./VocabularyRenderer";
import { isWebClientMode } from "../../lib/webClientMode";
import { registerPluginWebviewGuest } from "./sockets/pluginWebviewGuestRegistry";
import { usePluginWebviewReloadKey } from "./sockets/pluginWebviewReloadStore";
import { pluginWebviewRelayBridge } from "../../lib/pluginRuntimeBridge";
import {
  PLUGIN_WEBVIEW_PROTOCOL,
  PLUGIN_WEBVIEW_RESIZE_CHANNEL,
  clampPluginWebviewHeight,
  pluginWebviewGuestKey,
  pluginWebviewPartition,
  pluginWebviewUrl,
  type PluginWebviewContext,
  type PluginWebviewPlacement,
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
 * ## Destroyed when hidden
 *
 * This host used to keep a revealed guest alive and merely stop painting it,
 * on the reasoning that a page can hold unsubmitted work. The page tier
 * replaces that rule (spec §1, "Memory"): a guest is a whole renderer process,
 * a plugin may now have pages in six placements, and six idle Chromium
 * processes behind tabs nobody is looking at is not a cost the product can
 * carry. The plugin keeps its state in its collections instead — which is
 * durable across a window close, a reload and a second machine, and therefore
 * strictly better than the guest memory it replaces.
 *
 * So: nothing is created until the surface is first shown, and everything is
 * destroyed the moment it is hidden or unmounted. One live guest per placement
 * falls out of that, because a placement draws one host at a time.
 */

type PluginWebviewElement = HTMLElement & {
  reload?: () => void;
  getWebContentsId?: () => number;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; message: string };

/**
 * The `ipc-message` channel a page's `ui.resize` arrives on, and its ceiling.
 *
 * Both live in `shared/plugins/webviewBridge.ts` and are re-exported here so a
 * host that already imports this component does not need a second import for
 * the channel it listens on. The guest preload cannot import from
 * `renderer/components`, so shared is the only place the two halves can agree
 * on the string — and a literal written twice is a rename away from a resize
 * nobody receives.
 *
 * Resize is the one page → host message that never reaches main. Every other
 * verb is relayed because it moves a piece of ADE's UI that main has to
 * authorize; a page saying how tall it is moves nothing and concerns only the
 * one component drawing it, so routing it through main would be two process
 * hops for a number this element already has in hand.
 */
export { PLUGIN_WEBVIEW_RESIZE_CHANNEL };

export function PluginWebviewHost({
  pluginId,
  entryHtml,
  active,
  context = null,
  placement = "tab",
  surfaceId = null,
  onRequestClose,
  onContentHeight,
  hideGraceMs = 0,
}: {
  pluginId: string;
  /** Plugin-relative path from the manifest surface, already validated there. */
  entryHtml: string;
  /** False while the surface is mounted but not visible. Destroys the guest. */
  active: boolean;
  /**
   * The subject to inject, for a page mounted onto a chat, lane or PR — a drawer
   * tab or a button-opened overlay. Null for a full tab or pane webview, which
   * belongs to no subject. Encoded into the guest's source URL and captured
   * host-side at attach, so the page reads it as `adePlugin.context` and cannot
   * forge it. A change recreates the guest, the same as a change of page.
   */
  context?: PluginWebviewContext | null;
  /**
   * Where this guest is drawn. Rides in `__adeCtx` so the page can lay itself
   * out for the space it actually got, and is what the relay's `surface.close`
   * is answered against.
   */
  placement?: PluginWebviewPlacement;
  /** The manifest surface this guest draws. Rides in `__adeCtx` beside it. */
  surfaceId?: string | null;
  /**
   * Dismiss the surface holding this guest, for `surface.close`.
   *
   * Omitted by a placement that has no dismissal — a tab, a pane, a drawer tab —
   * which is what makes the verb a documented no-op there rather than a refusal.
   */
  onRequestClose?: (() => void) | undefined;
  /**
   * The page's own height, for a host that sizes to content.
   *
   * Only the settings section passes it. Every other placement fills a frame
   * the host already owns, and a page that could resize a tab would be a plugin
   * resizing ADE's window from a script.
   */
  onContentHeight?: ((height: number) => void) | undefined;
  /**
   * How long a hidden guest survives before it is destroyed.
   *
   * Zero everywhere except the popover, and it is there for one measured
   * reason: a popover that toggles shut and open again on a double press would
   * otherwise pay a full process spawn between the two, which reads as a flash
   * of empty card. Small enough that a guest never survives a placement change.
   */
  hideGraceMs?: number;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const guestRef = React.useRef<PluginWebviewElement | null>(null);
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  // Bumped by the Reload button. A fresh guest rather than `reload()`: a page
  // that failed to load has no document to reload, and re-creating it is also
  // what recovers a guest whose process died.
  const [reloadToken, setReloadToken] = React.useState(0);
  // The plugin's bytes, as `version:revision`. A change tears the element down
  // and puts a new one up, which is what a hot reload has to be — see
  // `pluginWebviewReloadStore.ts`.
  const reloadKey = usePluginWebviewReloadKey(pluginId);

  // The grace window, and nothing more: `mounted` follows `active` immediately
  // on the way up and after `hideGraceMs` on the way down. With the default
  // zero it is `active`, one render later at most.
  const [mounted, setMounted] = React.useState(active);
  React.useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    if (hideGraceMs <= 0) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), hideGraceMs);
    return () => clearTimeout(timer);
  }, [active, hideGraceMs]);

  // The context rides in the URL, so the source string is the whole dependency:
  // a change of subject changes the string and recreates the guest, and a parent
  // that hands a fresh-but-equal context object each render does not, because
  // the string is what the effect keys on.
  //
  // `surfaceId` and `placement` are folded in HERE rather than by the caller so
  // every placement carries them without each host remembering to. Main reads
  // them back off the URL at attach and stamps them onto its own guest record,
  // which is what makes a relayed request able to say where it came from.
  const src = React.useMemo(
    () => {
      const envelope: PluginWebviewContext = {
        subject: context?.subject ?? null,
        ...(context?.pointer ? { pointer: context.pointer } : {}),
        ...(surfaceId ? { surfaceId } : {}),
        placement,
      };
      return pluginWebviewUrl(pluginId, entryHtml, envelope);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- context is folded into the string below.
    [pluginId, entryHtml, placement, surfaceId, context ? JSON.stringify(context) : ""],
  );

  // Read inside the effect rather than closed over: a close handler that
  // changed identity every render would otherwise recreate the guest.
  const closeRef = React.useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const heightRef = React.useRef(onContentHeight);
  heightRef.current = onContentHeight;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!mounted || !host) return;

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

    const relay = pluginWebviewRelayBridge();
    let unregister: (() => void) | null = null;
    let guestKey: string | null = null;

    const onReady = () => {
      setState({ status: "ready" });
      // The id exists only once the guest is attached, which is what `dom-ready`
      // reports. It is the SAME number main keys its own guest record on, so
      // reading it here is what lets a relayed request find this component.
      const id = guest.getWebContentsId?.();
      if (typeof id !== "number") return;
      guestKey = pluginWebviewGuestKey(id);
      unregister = registerPluginWebviewGuest({
        guestKey,
        pluginId,
        surfaceId,
        placement,
        close: closeRef.current,
      });
      // Main refuses a detached guest's relayed requests. It cannot see an
      // element appear or vanish, so the window says so. With destroy-when-
      // hidden this is nearly always the pair around one guest's whole life.
      relay?.setSurfaceState({ guestKey, attached: true });
    };
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
    const onIpc = (event: Event) => {
      const detail = event as Event & { channel?: string; args?: unknown[] };
      if (detail.channel !== PLUGIN_WEBVIEW_RESIZE_CHANNEL) return;
      const report = heightRef.current;
      if (!report) return;
      const raw = detail.args?.[0];
      // The page sends `{height}`; a bare number is accepted as well, because a
      // page written against an older preload sent one and a host that dropped
      // it would collapse that section to its default forever.
      const height = clampPluginWebviewHeight(
        raw && typeof raw === "object" ? (raw as { height?: unknown }).height : raw,
      );
      // Null is NOT zero. `clampPluginWebviewHeight` answers null for anything
      // that is not a finite positive number, and that means "the page said
      // nothing usable" — a section that kept its last good height is a far
      // better reading of a broken ResizeObserver than one that collapses.
      if (height === null) return;
      report(height);
    };

    guest.addEventListener("dom-ready", onReady);
    guest.addEventListener("did-fail-load", onFail);
    guest.addEventListener("render-process-gone", onGone);
    guest.addEventListener("crashed", onGone);
    guest.addEventListener("ipc-message", onIpc);
    host.appendChild(guest);
    guestRef.current = guest;

    return () => {
      // Detached BEFORE the element goes, so a request already in flight from a
      // page that is on its way out is refused rather than acted on. A popover
      // dismissed while its page had a confirm pending must not be able to open
      // ADE's UI on the way down.
      if (guestKey) relay?.setSurfaceState({ guestKey, attached: false });
      unregister?.();
      guest.removeEventListener("dom-ready", onReady);
      guest.removeEventListener("did-fail-load", onFail);
      guest.removeEventListener("render-process-gone", onGone);
      guest.removeEventListener("crashed", onGone);
      guest.removeEventListener("ipc-message", onIpc);
      guest.remove();
      guestRef.current = null;
    };
  }, [pluginId, src, reloadToken, reloadKey, mounted, placement, surfaceId]);

  return (
    <div
      data-tour={`plugin:${pluginId}.webview`}
      data-plugin-webview={pluginId}
      data-plugin-webview-placement={placement}
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
 *
 * TODO(w2-web-host): the web client is growing its own page host — a sandboxed
 * iframe over the sync file channel — exposed as `WebPluginPageHost` and
 * `supportsWebPluginPages()` under `renderer/webclient/`. When both exist this
 * becomes the two-line switch below, and every caller keeps its shape because
 * the fallback rule does not change: a client that cannot draw a page draws the
 * surface's `panelId` vocabulary panel.
 *
 *   if (isWebClientMode()) return supportsWebPluginPages();
 *   return true;
 */
export function supportsPluginWebviews(): boolean {
  return !isWebClientMode();
}

export { PLUGIN_WEBVIEW_PROTOCOL };

export default PluginWebviewHost;
