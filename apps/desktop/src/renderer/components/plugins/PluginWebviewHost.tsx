import React from "react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import { isWebClientMode } from "../../lib/webClientMode";
import { supportsWebPluginPages } from "../../webclient/plugins/pageServiceWorkerClient";
import { HostEngineOverlay } from "./hostEngine/HostEngineOverlay";
import { releaseHostEngine, setHostEngineBounds } from "./hostEngine/hostEngineStore";
import {
  clearPluginWebviewPageError,
  usePluginWebviewPageError,
} from "./sockets/pluginWebviewPageErrorStore";
import { PluginWebviewPageErrorCard } from "./sockets/PluginWebviewPageErrorCard";
import { registerPluginWebviewGuest } from "./sockets/pluginWebviewGuestRegistry";
import { usePluginWebviewReloadKey } from "./sockets/pluginWebviewReloadStore";
import { openPluginLogs, pluginWebviewRelayBridge } from "../../lib/pluginRuntimeBridge";
import { useRootAppStore } from "../../state/appStore";
import {
  PLUGIN_WEBVIEW_PROTOCOL,
  PLUGIN_WEBVIEW_RESIZE_CHANNEL,
  clampPluginWebviewHeight,
  pluginWebviewGuestKey,
  pluginWebviewPartition,
  pluginWebviewKeepsGuestWhileHidden,
  pluginWebviewUrl,
  PLUGIN_WEBVIEW_SURFACE_REVEALED_EVENT,
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
 * ## Destroyed when hidden — except tabs and panes
 *
 * Anchored placements (popover, picker, overlay, dialog) still die when they
 * hide: they are not a surface the reader returns to, and leaving a Chromium
 * process behind a closed card is the cost the page tier refused. Tabs and
 * Work-rail panes are the opposite. Destroying those on every rail click made
 * every official plugin flash a reload. Those guests stay mounted while the
 * host is mounted, and only unmount when the host itself does.
 */

/**
 * The web client's page host, loaded only when a web client actually draws one.
 *
 * `React.lazy` rather than a plain import because this module is the desktop's
 * page host and it is on the entry graph of BOTH clients. A static import would
 * pull the whole browser page stack — the asset loader, the document builder,
 * the postMessage bridge host, the service-worker registration — into the
 * desktop bundle, which can never execute a line of it, and into the web
 * client's own entry chunk, whose budget is already over.
 *
 * The predicate beside it is deliberately NOT lazy. `supportsPluginWebviews()`
 * is a synchronous render-path question — a caller is deciding between a page
 * and the surface's fallback panel — and an answer that arrived a tick later
 * would draw the panel and then replace it.
 */
const WebPluginPageHost = React.lazy(async () => ({
  default: (await import("../../webclient/plugins/WebPluginPageHost")).WebPluginPageHost,
}));

type PluginWebviewElement = HTMLElement & {
  reload?: () => void;
  getWebContentsId?: () => number;
  executeJavaScript?: (code: string) => Promise<unknown>;
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
  onGuestKey,
  hideGraceMs = 0,
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
   * This guest's `guestKey` while it is live, and `null` the moment it is not.
   *
   * The relay is addressed by `guestKey` and nothing else — main derives it from
   * the `webContents` that called, so a page cannot forge it — and a host that
   * has to ANSWER a relayed request needs the same number to register itself
   * against. The dialog picker is the case: a page calls `dialog.submit`, and
   * the only thing that can say which form the answer belongs in is the
   * component that put that particular guest on screen.
   *
   * Called with the key once the guest is attached and with `null` on the way
   * out, in that order, so a caller's registration cannot outlive the guest it
   * was made for. Held in a ref rather than in the effect's dependencies: a
   * caller passing a fresh closure each render must not recreate the guest.
   */
  onGuestKey?: ((guestKey: string | null) => void) | undefined;
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
  // Which host draws the page. Read once per render rather than per effect: it
  // cannot change without a reload, and two readings that disagreed would build
  // a guest this component then refuses to paint.
  const webClient = isWebClientMode();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const guestRef = React.useRef<PluginWebviewElement | null>(null);
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  // This guest's key, as state rather than a ref: the engine overlay and the
  // error card are both keyed on it and both have to re-render when it lands.
  const [liveGuestKey, setLiveGuestKey] = React.useState<string | null>(null);
  // What this page last said about its own failure, or null. See
  // `pluginWebviewPageErrorStore.ts` for why it arrives here through a store.
  const pageError = usePluginWebviewPageError(liveGuestKey);
  const pluginName = useRootAppStore((state) =>
    state.installedPlugins.find((entry) => entry.pluginId === pluginId)?.displayName ?? pluginId,
  );
  // Bumped by the Reload button. A fresh guest rather than `reload()`: a page
  // that failed to load has no document to reload, and re-creating it is also
  // what recovers a guest whose process died.
  const [reloadToken, setReloadToken] = React.useState(0);
  // The plugin's bytes, as `version:revision`. A change tears the element down
  // and puts a new one up, which is what a hot reload has to be — see
  // `pluginWebviewReloadStore.ts`.
  const reloadKey = usePluginWebviewReloadKey(pluginId);

  // Tabs and panes stay mounted while this host does. Everything else follows
  // `active` immediately on the way up and after `hideGraceMs` on the way down.
  const keepWhileHidden = pluginWebviewKeepsGuestWhileHidden(placement);
  const [mounted, setMounted] = React.useState(active || keepWhileHidden);
  React.useEffect(() => {
    if (active || keepWhileHidden) {
      setMounted(true);
      return;
    }
    if (hideGraceMs <= 0) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), hideGraceMs);
    return () => clearTimeout(timer);
  }, [active, hideGraceMs, keepWhileHidden]);

  // The context rides in the URL, so the source string is the whole dependency:
  // a change of subject changes the string and recreates the guest, and a parent
  // that hands a fresh-but-equal context object each render does not, because
  // the string is what the effect keys on.
  //
  // `surfaceId` and `placement` are folded in HERE rather than by the caller so
  // every placement carries them without each host remembering to. Main reads
  // them back off the URL at attach and stamps them onto its own guest record,
  // which is what makes a relayed request able to say where it came from.
  const envelope = React.useMemo<PluginWebviewContext>(
    () => ({
      subject: context?.subject ?? null,
      ...(context?.pointer ? { pointer: context.pointer } : {}),
      ...(surfaceId ? { surfaceId } : {}),
      placement,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- context is folded into the string below.
    [placement, surfaceId, context ? JSON.stringify(context) : ""],
  );
  const src = React.useMemo(
    () => pluginWebviewUrl(pluginId, entryHtml, envelope),
    [pluginId, entryHtml, envelope],
  );

  // Read inside the effect rather than closed over: a close handler that
  // changed identity every render would otherwise recreate the guest.
  const closeRef = React.useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const heightRef = React.useRef(onContentHeight);
  heightRef.current = onContentHeight;
  const guestKeyRef = React.useRef(onGuestKey);
  guestKeyRef.current = onGuestKey;

  React.useEffect(() => {
    const host = hostRef.current;
    // A `<webview>` is an Electron construct. In the web client the branch
    // below draws `WebPluginPageHost` instead, and this effect must not run at
    // all — `document.createElement("webview")` there produces an unknown
    // element that loads nothing and reports no `webContents` id.
    if (webClient || !mounted || !host) return;

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
      // After the registry, so a host told the key can rely on the guest being
      // resolvable by it — a `surface.close` racing a `dialog.submit` finds
      // both halves or neither.
      guestKeyRef.current?.(guestKey);
      setLiveGuestKey(guestKey);
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
      // The engine, the error card and the measured frame all belong to THIS
      // guest. A recreated guest gets a new `webContents` id and therefore a
      // new key, so leaving these behind would strand a painted engine over a
      // page that no longer exists.
      if (guestKey) {
        releaseHostEngine(guestKey);
        setHostEngineBounds(guestKey, null);
        clearPluginWebviewPageError(guestKey);
      }
      setLiveGuestKey(null);
      // Told BEFORE the registry drops the guest and before the element goes,
      // so a host unregisters its own handler while the key it registered under
      // is still the live one. Unconditional: a guest that never reached
      // `dom-ready` never announced a key, and `null` is then a no-op the
      // caller can apply without checking.
      guestKeyRef.current?.(null);
      unregister?.();
      guest.removeEventListener("dom-ready", onReady);
      guest.removeEventListener("did-fail-load", onFail);
      guest.removeEventListener("render-process-gone", onGone);
      guest.removeEventListener("crashed", onGone);
      guest.removeEventListener("ipc-message", onIpc);
      guest.remove();
      guestRef.current = null;
    };
  }, [webClient, pluginId, src, reloadToken, reloadKey, mounted, placement, surfaceId]);

  const wasActiveRef = React.useRef(active);
  React.useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!becameActive) return;
    const guest = guestRef.current;
    const run = guest?.executeJavaScript;
    if (typeof run !== "function") return;
    void run(
      `window.dispatchEvent(new Event(${JSON.stringify(PLUGIN_WEBVIEW_SURFACE_REVEALED_EVENT)}))`,
    ).catch(() => undefined);
  }, [active]);

  // The frame the host actually drew, for the engine clamp. Measured with a
  // `ResizeObserver` rather than read once, because a pane resize changes the
  // frame without the page saying anything and a stale clamp would let an
  // engine hang over ADE's own chrome after the window narrowed.
  React.useEffect(() => {
    const frame = frameRef.current;
    if (!liveGuestKey || !frame) return;
    const report = (): void => {
      const box = frame.getBoundingClientRect();
      setHostEngineBounds(liveGuestKey, { width: box.width, height: box.height });
    };
    report();
    if (typeof ResizeObserver === "undefined") {
      return () => setHostEngineBounds(liveGuestKey, null);
    }
    const observer = new ResizeObserver(report);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      setHostEngineBounds(liveGuestKey, null);
    };
  }, [liveGuestKey]);

  // The hosted web client draws the same page in a sandboxed same-origin frame
  // behind a service worker. Delegated rather than reimplemented: every caller
  // in the app already asks this component for "the plugin's page here", and
  // teaching each of them which client it is running on would put the same
  // branch in six places. The envelope is handed over whole, so `surfaceId` and
  // `placement` reach that host the way they reach a guest's `__adeCtx`.
  if (webClient) {
    return (
      <React.Suspense fallback={<PluginWebviewLoadingChip />}>
        <WebPluginPageHost
          pluginId={pluginId}
          entryHtml={entryHtml}
          active={active}
          context={envelope}
          // Forwarded, not dropped: a `dialog-picker` page on the web client
          // registers itself as the destination for its own `dialog.submit`
          // through this key, and a host that swallowed it would answer every
          // submit "no dialog is listening" while the dialog was on screen.
          onGuestKey={onGuestKey}
        />
      </React.Suspense>
    );
  }

  // A load failure the host saw, or a failure the page reported about itself.
  // The host's own wins: `did-fail-load` means there is no document at all,
  // and a page that both failed to load and reported an error is describing
  // the same event twice.
  const errorMessage = state.status === "failed"
    ? state.message
    : pageError?.message ?? null;

  return (
    <div
      ref={frameRef}
      data-tour={`plugin:${pluginId}.webview`}
      data-plugin-webview={pluginId}
      data-plugin-webview-placement={placement}
      {...(liveGuestKey ? { "data-plugin-webview-guest": liveGuestKey } : {})}
      style={{ position: "relative", display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}
    >
      <div ref={hostRef} style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }} />
      {/* Above the guest, below the failure card: an engine painted over a
          broken page would sit on top of the sentence explaining it. */}
      <HostEngineOverlay guestKey={liveGuestKey} />
      {errorMessage ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 3,
            display: "flex",
            alignItems: "flex-start",
            padding: 20,
            background: COLORS.pageBg,
          }}
        >
          <PluginWebviewPageErrorCard
            pluginName={pluginName}
            message={errorMessage}
            onReload={() => {
              // The report goes with the guest it described. Without this
              // the card would come straight back over a page that has
              // reloaded cleanly, and Reload would look broken.
              clearPluginWebviewPageError(liveGuestKey);
              setReloadToken((token) => token + 1);
            }}
            onOpenLogs={() => {
              void openPluginLogs(pluginId).catch(() => undefined);
            }}
          />
        </div>
      ) : null}
      {state.status === "loading" ? <PluginWebviewLoadingChip absolute /> : null}
    </div>
  );
}

/**
 * The one "this is coming" mark a page host shows.
 *
 * Shared by the Electron guest's own loading state and by the Suspense boundary
 * around the web host's chunk, because a reader cannot tell those two waits
 * apart and should not be shown two different things for them.
 */
function PluginWebviewLoadingChip({ absolute = false }: { absolute?: boolean }) {
  return (
    <span
      role="status"
      style={{
        ...(absolute ? { position: "absolute" as const, left: 20, top: 20 } : { margin: 20 }),
        alignSelf: "flex-start",
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
 * Two hosts now answer it. On the desktop the answer is always yes: a guest is
 * an Electron `<webview>` and the runtime is always there. In the hosted web
 * client it is `supportsWebPluginPages()`, which is a real question — a service
 * worker, Cache Storage, a secure origin and a host that serves the page bytes
 * are each a way for the answer to be no.
 *
 * Asked as a product question rather than by probing for an element, because a
 * probe that answered "yes" in a browser would put an empty box where the page
 * should be. A no is never an error and never a card advertising another
 * application: the caller draws the surface's `panelId` vocabulary panel, which
 * is the cross-client rendering the manifest already promised.
 */
export function supportsPluginWebviews(): boolean {
  return !isWebClientMode() || supportsWebPluginPages();
}

export { PLUGIN_WEBVIEW_PROTOCOL };

export default PluginWebviewHost;
