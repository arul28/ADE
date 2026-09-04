import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../components/lanes/laneDesignTokens";
import { applyPluginActionOpenSettings } from "../../components/plugins/pluginActionOpenSettings";
import { applyPluginComposerEdit } from "../../components/plugins/sockets/composerTarget";
import { closePluginWebviewOverlay } from "../../components/plugins/sockets/pluginWebviewOverlayStore";
import { closePluginWebviewPopover } from "../../components/plugins/sockets/pluginWebviewPopoverStore";
import { submitPluginWebviewDialogAnswer } from "../../components/plugins/sockets/pluginWebviewDialogStore";
import {
  createPluginWebviewChatTurnDedupe,
  pluginWebviewChatTurnFromEvent,
} from "../../components/plugins/sockets/PluginWebviewRelayHost";
import {
  getPluginPrompt,
  openPluginPrompt,
  subscribePluginPrompt,
} from "../../components/plugins/sockets/pluginPromptStore";
import { pickPluginWebviewUi } from "../../components/plugins/sockets/pluginWebviewPickerStore";
import {
  clearPluginWebviewPageError,
  recordPluginWebviewPageError,
  usePluginWebviewPageError,
} from "../../components/plugins/sockets/pluginWebviewPageErrorStore";
import { PluginWebviewPageErrorCard } from "../../components/plugins/sockets/PluginWebviewPageErrorCard";
import { dismissToast, showToast } from "../../components/app/toast/toastStore";
import { ConfirmDialog, useConfirmDialog } from "../../components/shared/InlineDialogs";
import { openAdeDeeplink, openExternalUrl } from "../../lib/openExternal";
import {
  invokePluginAction,
  openPluginLogs,
  readPluginCollection,
  readPluginConfig,
  readPluginPanel,
  writePluginConfig,
} from "../../lib/pluginRuntimeBridge";
import { rootAppStoreApi, useRootAppStore } from "../../state/appStore";
import {
  buildPluginActionPromptAnswer,
  type PluginActionPrompt,
  type PluginActionPromptAnswer,
} from "../../../shared/plugins/sdk";
import {
  PLUGIN_WEBVIEW_LIST_MAX_ROWS,
  PLUGIN_WEBVIEW_MAX_HEIGHT_PX,
  pluginWebviewKeepsGuestWhileHidden,
  PLUGIN_WEBVIEW_SURFACE_REVEALED_EVENT,
  type PluginWebviewChatTurn,
  type PluginWebviewContext,
  type PluginWebviewHostEvent,
  type PluginWebviewHostKind,
  type PluginWebviewPlacement,
} from "../../../shared/plugins/webviewBridge";
import { loadPluginPageBundle, guestFileUrl, type PluginPageAssetSource } from "./pageAssets";
import { buildPluginPageDocumentResponse } from "./pageDocument";
import {
  PLUGIN_PAGE_BOOT_TIMEOUT_MS,
  PLUGIN_PAGE_CSP_NONCE_PARAM,
  PLUGIN_PAGE_NONCE_PARAM,
  mintPluginPageNonce,
} from "./pageProtocol";
import { createPluginPageHost, type PluginPageHost } from "./pageBridgeHost";
import { readPluginPageTheme } from "./pageTheme";
import { ensurePluginPageServiceWorker } from "./pageServiceWorkerClient";

export { supportsWebPluginPages } from "./pageServiceWorkerClient";

/**
 * The hosted web client's host for a `webview` surface.
 *
 * Same props as the desktop's `PluginWebviewHost`, deliberately: the two are
 * swapped by one predicate at the call site, and a shape that differed would
 * make every caller learn which client it is running in. Everything that
 * differs is inside.
 *
 * What is different, and why each is not a shortcut:
 *
 * - **The guest is an `<iframe>` at a same-origin path a service worker
 *   answers**, not a `<webview>` at a custom protocol. The response the worker
 *   synthesizes carries `Content-Security-Policy: sandbox allow-scripts`, which
 *   is what gives the document an opaque origin — the browser's equivalent of
 *   the desktop's per-plugin partition. `pageDocument.ts` sets out why the
 *   sandbox is a header rather than the element's own attribute, and why no
 *   arrangement without a worker reaches both properties at once.
 * - **The bridge is `postMessage`,** validated by the guest's window identity
 *   and a per-guest nonce. There is no preload to hide a function reference in.
 * - **The guest is destroyed when hidden,** where the desktop keeps a hidden
 *   guest alive and stops painting it. An iframe is a document in this same
 *   process, not a separate renderer, so a background page's timers and its
 *   whole heap are the reader's — and the page tier's own rule is that state
 *   lives in the plugin's collections, never in the guest.
 */
export function WebPluginPageHost({
  pluginId,
  entryHtml,
  active,
  context = null,
  onGuestKey,
}: {
  pluginId: string;
  /** Plugin-relative path from the manifest surface, already validated there. */
  entryHtml: string;
  /** False while the surface is mounted but not visible. */
  active: boolean;
  /** The subject to inject. Null for a full tab or pane. See the desktop host. */
  context?: PluginWebviewContext | null;
  /**
   * Told this guest's key as it goes live, and null as it goes away — the same
   * prop, in the same order, as the desktop host's.
   *
   * It is what lets a dialog register itself as the destination for this page's
   * `dialog.submit`: `pluginWebviewDialogStore` is keyed per GUEST, so an
   * answer reaches the form the reader is actually sitting in and not whichever
   * dialog happened to open last. The key here is the guest's own nonce —
   * minted per guest, unforgeable, and namespaced away from a desktop key
   * (which is a decimal `webContents` id) so the two cannot collide in one
   * store.
   */
  onGuestKey?: ((guestKey: string | null) => void) | undefined;
}) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = React.useRef<PluginPageHost | null>(null);
  const [state, setState] = React.useState<{ status: "loading" | "ready" } | { status: "failed"; message: string }>({
    status: "loading",
  });
  const [reloadToken, setReloadToken] = React.useState(0);
  const [sectionHeight, setSectionHeight] = React.useState<number | null>(null);
  const [guestNonce, setGuestNonce] = React.useState<string | null>(null);
  const pageError = usePluginWebviewPageError(guestNonce);
  const pluginName = useRootAppStore((state) =>
    state.installedPlugins.find((entry) => entry.pluginId === pluginId)?.displayName ?? pluginId,
  );
  const confirm = useConfirmDialog();
  // Held in a ref, and deliberately NOT an effect dependency. Rebuilding the
  // guest is expensive and destructive — it drops the page's unsubmitted work —
  // so it must happen when the SURFACE changes, never because a callback the
  // host merely forwards to was handed back with a new identity.
  const confirmRef = React.useRef(confirm.confirmAsync);
  confirmRef.current = confirm.confirmAsync;
  // Held in a ref for the reason the desktop host holds its own: a caller
  // passing a fresh closure each render must not tear the guest down.
  const guestKeyRef = React.useRef(onGuestKey);
  guestKeyRef.current = onGuestKey;

  const placement: PluginWebviewPlacement = context?.placement ?? "tab";
  const keepWhileHidden = pluginWebviewKeepsGuestWhileHidden(placement);
  const shouldBoot = active || keepWhileHidden;
  // The two placements that sit INSIDE a taller ADE surface and therefore have
  // no height of their own to fill, exactly as `ui.resize` is documented. Every
  // other placement fills a frame this client already sized.
  const sizesToContent = placement === "settings-section" || placement === "dialog-picker";
  // Folded into one string so a parent handing a fresh-but-equal object each
  // render does not tear the guest down, exactly as the desktop host does it.
  const contextKey = React.useMemo(() => (context ? JSON.stringify(context) : ""), [context]);

  const wasActiveRef = React.useRef(active);
  React.useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!becameActive) return;
    try {
      frameRef.current?.contentWindow?.dispatchEvent(new Event(PLUGIN_WEBVIEW_SURFACE_REVEALED_EVENT));
    } catch {
      // An opaque-origin guest cannot be reached from here; visibility still fires.
    }
  }, [active]);

  React.useEffect(() => {
    // Tabs, panes, and settings sections stay alive while this host is mounted.
    // Anchored placements still die when they hide — the effect keys on `shouldBoot`.
    if (!shouldBoot) return;
    let cancelled = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;
    let liveNonce: string | null = null;
    const frame = frameRef.current;
    if (!frame) return;

    setState({ status: "loading" });

    const start = async (): Promise<void> => {
      const { base } = await ensurePluginPageServiceWorker();
      const bridge = pageAssetSource();
      if (!bridge) throw new Error("This computer can’t serve plugin pages.");
      const { bundle } = await loadPluginPageBundle({
        pluginId,
        entryHtml,
        source: bridge,
        caches: window.caches,
        base,
      });
      if (cancelled) return;

      const nonce = mintPluginPageNonce(window.crypto);
      const scriptNonce = mintPluginPageNonce(window.crypto);
      const documentUrl = new URL(guestFileUrl(base, pluginId, bundle.versionKey, bundle.entry));
      documentUrl.searchParams.set(PLUGIN_PAGE_NONCE_PARAM, nonce);
      documentUrl.searchParams.set(PLUGIN_PAGE_CSP_NONCE_PARAM, scriptNonce);

      // The bootstrap document is parked in the same cache the page's files
      // live in, under the exact URL the frame will request. The worker is then
      // a pass-through and holds no opinion about the policy this response
      // carries — see `pageDocument.ts`.
      const cache = await window.caches.open(pluginPageCacheFor(bundle));
      await cache.put(
        documentUrl.toString(),
        buildPluginPageDocumentResponse({
          config: { nonce, parentOrigin: window.location.origin, pluginId, placement },
          scriptNonce,
        }),
      );
      if (cancelled) return;

      // Listening BEFORE the frame is navigated. The guest's bootstrap asks for
      // its bytes as its first statement, which is before `load` fires, so a
      // host that waited for `load` to learn the window would miss the request
      // and the page would sit blank until the boot timeout.
      const host = createPluginPageHost({
        guestWindow: () => frameRef.current?.contentWindow ?? null,
        hostWindow: window,
        nonce,
        pluginId,
        context: { subject: context?.subject ?? null, ...(context ?? {}), placement },
        bundle,
        theme: () => readPluginPageTheme(document, window),
        clipboard: navigator.clipboard,
        ui: {
          toast: (toast) => ({
            id: showToast({
              title: pluginId,
              message: toast.message,
              tone: toast.level === "error" ? "error" : toast.level === "success" ? "success" : "info",
              ...(toast.actionLabel && toast.actionId
                ? {
                    action: {
                      label: toast.actionLabel,
                      onClick: () => {
                        void invokePluginAction(pluginId, toast.actionId as string, {}).catch(() => undefined);
                      },
                    },
                  }
                : {}),
            }),
          }),
          dismissToast: (id) => dismissToast(id),
          prompt: (prompt) => askPrompt(pluginId, prompt),
          confirm: (request) =>
            confirmRef.current({
              title: request.title,
              message: request.body ?? "",
              ...(request.confirmLabel ? { confirmLabel: request.confirmLabel } : {}),
              ...(request.destructive ? { danger: true } : {}),
            }),
          closeSurface: () => closeSurfaceFor(placement),
          composerInsert: (text) =>
            applyPluginComposerEdit({ mode: "insert", text }, {
              context: context?.subject ?? null,
              pluginId,
              actionId: "composer.insert",
            }),
          openSettings: (target) => applyPluginActionOpenSettings({ openSettings: target }, { pluginId, actionId: "openSettings" }),
          openDeeplink: (url) => {
            if (url.startsWith("ade:")) openAdeDeeplink(url);
            else openExternalUrl(url);
          },
          resize: (height) => setSectionHeight(height),
          dialogSubmit: (answer) => submitPluginWebviewDialogAnswer(nonce, answer),
          pick: (method, params) => pickPluginWebviewUi(method, params, { pluginId, guestKey: nonce }),
          reportPageError: (error) => {
            recordPluginWebviewPageError(nonce, error);
          },
        },
        data: {
          invoke: (action, args) => invokePluginAction(pluginId, action, args),
          collectionsGet: async (collection, key) => {
            const rows = await readCollection(pluginId, entryHtml, collection, { keyPrefix: key, limit: 1 });
            return rows.find((row) => row.key === key)?.value ?? null;
          },
          collectionsList: async (collection, options) => {
            const rows = await readCollection(pluginId, entryHtml, collection, {
              ...(options.keyPrefix ? { keyPrefix: options.keyPrefix } : {}),
              limit: options.limit ?? PLUGIN_WEBVIEW_LIST_MAX_ROWS,
            });
            const after = options.after;
            return (after ? rows.filter((row) => row.key > after) : rows).map((row) => ({
              key: row.key,
              value: row.value,
            }));
          },
          collectionsPut: collectionWriter(pluginId),
          configGet: () => readPluginConfig(pluginId),
          configSet: async (values) => {
            for (const [key, value] of Object.entries(values)) await writePluginConfig(pluginId, key, value);
            return readPluginConfig(pluginId);
          },
        },
        subscribeHostEntities: subscribeHostEntities,
      });
      bridgeRef.current = host;
      // Announced BEFORE the frame is navigated, for the same reason the host
      // is built first: a fast page can submit as its first statement, and a
      // dialog told about the guest a commit later would refuse that answer.
      guestKeyRef.current?.(nonce);
      liveNonce = nonce;
      setGuestNonce(nonce);
      frame.setAttribute("src", documentUrl.toString());

      bootTimer = setTimeout(() => {
        if (host.booted) return;
        // The frame loaded something that never spoke this protocol. The one
        // way that happens is a response this client did not write — a worker
        // that stopped controlling the path, and the origin's single-page
        // fallback answering instead. Torn down rather than left on screen.
        setState({ status: "failed", message: "The page didn’t load." });
        frame.removeAttribute("src");
      }, PLUGIN_PAGE_BOOT_TIMEOUT_MS);

      setState({ status: "ready" });
    };

    void start().catch((error: unknown) => {
      if (cancelled) return;
      console.warn("[web plugin page] load failed", pluginId, error);
      setState({ status: "failed", message: "The page didn’t load." });
    });

    return () => {
      cancelled = true;
      if (bootTimer) clearTimeout(bootTimer);
      // Null before the guest goes, so a registration cannot outlive the guest
      // it was made for.
      guestKeyRef.current?.(null);
      setGuestNonce(null);
      clearPluginWebviewPageError(liveNonce);
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      // `about:blank` before the element goes: a frame removed with a live
      // document keeps that document alive until the collector runs, and a
      // plugin page with a socket open would go on holding it.
      frameRef.current?.setAttribute("src", "about:blank");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contextKey folds `context`; the rest are primitives.
  }, [pluginId, entryHtml, shouldBoot, contextKey, reloadToken, placement]);

  // The theme is republished rather than polled: the app paints `data-theme` on
  // the document element, so one observer on that attribute is the whole feed.
  React.useEffect(() => {
    if (!shouldBoot) return;
    const observer = new MutationObserver(() => {
      bridgeRef.current?.publish("theme", readPluginPageTheme(document, window));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [shouldBoot]);

  if (!shouldBoot) return null;

  const errorMessage = state.status === "failed"
    ? state.message
    : pageError?.message ?? null;

  return (
    <div
      data-tour={`plugin:${pluginId}.webview`}
      {...(guestNonce ? { "data-plugin-webview-guest": guestNonce } : {})}
      style={{
        position: "relative",
        display: "flex",
        flex: sizesToContent ? "0 0 auto" : 1,
        minHeight: 0,
        minWidth: 0,
        // The shared ceiling, not a local one: the same page must not be a
        // different height on desktop and on web. The host has already clamped
        // what the guest reported; this is the style that applies it.
        ...(sizesToContent && sectionHeight
          ? { height: Math.min(sectionHeight, PLUGIN_WEBVIEW_MAX_HEIGHT_PX) }
          : {}),
      }}
    >
      <iframe
        ref={frameRef}
        title={`${pluginId} page`}
        // No `sandbox` attribute, and that is not an omission: the response the
        // service worker serves carries `Content-Security-Policy: sandbox
        // allow-scripts`, which applies the same flags AND leaves the frame's
        // navigation controllable by that worker. A sandboxed ELEMENT is never
        // controlled by a service worker (an opaque origin has no storage key
        // to match a registration by), so the attribute would mean the frame
        // could not be served its document at all.
        allow=""
        referrerPolicy="no-referrer"
        style={{ border: "0", display: "flex", flex: 1, width: "100%", height: "100%", background: "transparent" }}
      />
      {errorMessage ? (
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
          <PluginWebviewPageErrorCard
            pluginName={pluginName}
            message={errorMessage}
            onReload={() => {
              clearPluginWebviewPageError(guestNonce);
              setReloadToken((token) => token + 1);
            }}
            onOpenLogs={() => {
              void openPluginLogs(pluginId).catch(() => undefined);
            }}
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
      <ConfirmDialog state={confirm.state} onClose={confirm.close} />
    </div>
  );
}

/**
 * The plugin-collection writer this host serves, or undefined.
 *
 * Undefined is a real answer and the bridge turns it into the honest refusal:
 * a host from before `plugins.putCollection` cannot store a page's row, and a
 * save that resolves quietly there is worse than one that says so. Resolved per
 * guest rather than once, because a project handoff changes the connected host
 * while the page is open.
 */
function collectionWriter(pluginId: string): ((collection: string, key: string, value: unknown) => Promise<void>) | undefined {
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  const bridge = (ade?.plugin ?? ade?.plugins) as
    | { putCollection?: (input: { pluginId: string; collection: string; key: string; value: unknown }) => Promise<void> }
    | undefined;
  const put = bridge?.putCollection;
  if (typeof put !== "function") return undefined;
  return (collection, key, value) => put({ pluginId, collection, key, value });
}

/** The cache one bundle's files and bootstrap document live in. */
function pluginPageCacheFor(bundle: { pluginId: string; versionKey: string }): string {
  return `ade-plugin-pages/${bundle.pluginId}/${bundle.versionKey}`;
}

function pageAssetSource(): PluginPageAssetSource | null {
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  const bridge = (ade?.plugin ?? ade?.plugins) as
    | Partial<{ pageAssetsManifest: PluginPageAssetSource["manifest"]; pageAssetsRead: PluginPageAssetSource["read"] }>
    | undefined;
  const manifest = bridge?.pageAssetsManifest;
  const read = bridge?.pageAssetsRead;
  if (typeof manifest !== "function" || typeof read !== "function") return null;
  return { manifest, read };
}

/**
 * The panel a `webview` surface declares beside its page.
 *
 * Every webview surface carries one — it is what iOS, the TUI and this client's
 * own fallback draw in the page's place — and on web it is also the ONLY way to
 * read the plugin's collections: a browser peer has no local replica, and the
 * rows it can see are the ones a panel subscription already delivered. So a
 * collection read primes the panel first and then reads what that snapshot
 * carried, which is exactly what `PluginPanelHost` does on this transport.
 */
function panelIdFor(pluginId: string, entryHtml: string): string | null {
  const plugin = rootAppStoreApi.getState().installedPlugins.find((entry) => entry.pluginId === pluginId);
  const surface = plugin?.tabs.find((tab) => tab.entryHtml === entryHtml);
  return surface?.panelId ?? null;
}

const primedPanels = new Set<string>();

async function readCollection(
  pluginId: string,
  entryHtml: string,
  collection: string,
  options: { keyPrefix?: string; limit?: number },
): Promise<{ key: string; value: unknown }[]> {
  const panelId = panelIdFor(pluginId, entryHtml);
  if (!panelId) return [];
  const key = `${pluginId}\u0000${panelId}`;
  if (!primedPanels.has(key)) {
    primedPanels.add(key);
    await readPluginPanel(pluginId, panelId).catch(() => null);
  }
  return readPluginCollection(pluginId, panelId, collection, options);
}

/**
 * Ask ADE's own one-field question and answer the page exactly once.
 *
 * The dismissal path is the whole reason this is not three lines. `onSubmit`
 * fires on an answer and never on a walk-away, so the store is watched too: the
 * moment the standing question stops being this one, the page is told `null`.
 * Waiting for the guest's teardown instead — which is what the first cut did —
 * leaves a page's promise pending for as long as the reader stays on the
 * surface, so a dismissed question reads as a button that never came back.
 *
 * `settle` is idempotent and the store watcher answers a microtask late, both
 * for the same reason: `submitPluginPrompt` CLEARS the request before it calls
 * `onSubmit`, so a watcher that answered the instant the store emptied would
 * answer `null` for every question the reader actually answered.
 *
 * Deliberately the same shape as `askPluginWebviewPrompt` in the desktop relay.
 * Two readings of "the reader walked away" would drift, and the drift would be
 * invisible: one client answering null and the other hanging.
 */
export function askPrompt(pluginId: string, prompt: PluginActionPrompt): Promise<PluginActionPromptAnswer | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (value: PluginActionPromptAnswer | null): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(value);
    };
    const token = openPluginPrompt({
      pluginId,
      // No action asked this: the page did. Named so the prompt store's own
      // console warning still points at something findable.
      actionId: "page:ui.prompt",
      prompt,
      fallbackTitle: null,
      anchor: null,
      onSubmit: (text) => settle(buildPluginActionPromptAnswer(prompt, text)),
    });
    const settleIfGone = (): void => {
      if (getPluginPrompt()?.token === token) return;
      queueMicrotask(() => settle(null));
    };
    unsubscribe = subscribePluginPrompt(settleIfGone);
    // The store may already have moved on — a second question opened between
    // these two calls — in which case the subscription would never fire.
    settleIfGone();
  });
}

/**
 * What `surface.close` closes, by placement.
 *
 * Two lists, and both halves matter. A tab, a pane and a drawer tab ARE the
 * view, and a settings section is part of a scrolling page: there is nothing
 * above any of them to dismiss, so `surface.close` is the documented no-op
 * rather than a call that closes something else the reader had open.
 *
 * The popover store here is the PAGE one, not `pluginPanelPopoverStore` — that
 * is the vocabulary panel's quick view, a different card. Closing it would
 * dismiss a card nobody opened and leave the page's own standing, which is what
 * the first cut of this function did.
 */
export function closeSurfaceFor(placement: PluginWebviewPlacement): void {
  if (placement === "tab" || placement === "pane" || placement === "drawer") return;
  // A settings section and a dialog picker are both PART of a surface the
  // reader opened, not something drawn over it. There is nothing above either
  // to dismiss, so `surface.close` is the documented no-op — falling through
  // would close an unrelated overlay the reader still has open.
  if (placement === "settings-section" || placement === "dialog-picker") return;
  if (placement === "popover" || placement === "composer-picker") closePluginWebviewPopover();
  else closePluginWebviewOverlay();
}

/**
 * Lane, session, PR and chat-turn movement, as host frames.
 *
 * The entity subscriptions are the ones `window.ade` publishes on both clients,
 * so this is the same feed the app's own surfaces redraw from. Ids are read out
 * of each payload where the payload has one, and an event with no id it
 * recognises is reported as an overflow — "something in this family moved,
 * refetch it" — which is the honest reading and the one the page contract
 * already defines.
 */
function subscribeHostEntities(
  kinds: PluginWebviewHostKind[],
  deliver: (event: PluginWebviewHostEvent) => void,
): () => void {
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  const stops: Array<() => void> = [];
  const report = (kind: PluginWebviewHostKind) => (payload: unknown) => {
    const ids = readEntityIds(payload);
    deliver({ kind, ids, overflow: ids.length === 0 });
  };
  if (kinds.includes("lane")) {
    const lanes = ade?.lanes as { onLifecycleEvent?: (listener: (event: unknown) => void) => () => void } | undefined;
    const stop = lanes?.onLifecycleEvent?.(report("lane"));
    if (stop) stops.push(stop);
  }
  if (kinds.includes("session")) {
    const sessions = ade?.sessions as { onChanged?: (listener: (event: unknown) => void) => () => void } | undefined;
    const stop = sessions?.onChanged?.(report("session"));
    if (stop) stops.push(stop);
  }
  if (kinds.includes("pr")) {
    const prs = ade?.prs as { onEvent?: (listener: (event: unknown) => void) => () => void } | undefined;
    const stop = prs?.onEvent?.(report("pr"));
    if (stop) stops.push(stop);
  }
  // The three families with no producer of their own on the entity bus. Each
  // one is a live IPC event the app's own surfaces already redraw from — the
  // conflict assessment, the review run stream, and the lane rebases that write
  // operation rows — so a page subscribing here is reading exactly what a
  // compiled History, Graph or Review surface would.
  //
  // An event whose ids this reader does not recognise is delivered as an
  // overflow rather than dropped: "this family moved, refetch it" is the
  // honest reading, and a page that heard nothing would draw a stale list.
  if (kinds.includes("conflict")) {
    const conflicts = ade?.conflicts as { onEvent?: (listener: (event: unknown) => void) => () => void } | undefined;
    const stop = conflicts?.onEvent?.(report("conflict"));
    if (stop) stops.push(stop);
  }
  if (kinds.includes("review")) {
    const review = ade?.review as { onEvent?: (listener: (event: unknown) => void) => () => void } | undefined;
    const stop = review?.onEvent?.(report("review"));
    if (stop) stops.push(stop);
  }
  if (kinds.includes("operation")) {
    // Operations have no event channel of their own: the History surface reads
    // them on demand. What DOES announce one is a rebase, which is the write
    // that creates the rows a History page draws. So the frame is honest and
    // deliberately id-free — "the operation log moved" — and the page refetches
    // rather than patching ids this event cannot name.
    const lanes = ade?.lanes as
      | { rebaseSubscribe?: (listener: (event: unknown) => void) => () => void }
      | undefined;
    const stop = lanes?.rebaseSubscribe?.(() => {
      deliver({ kind: "operation", ids: [], overflow: true });
    });
    if (stop) stops.push(stop);
  }
  if (kinds.includes("chat")) {
    // The one kind that is not an entity family, and the one that carries more
    // than identity: `turns` says where a session's turn ENDED up, because a
    // page that launched an agent cannot re-derive "that turn failed" from the
    // session's existence. Same reading as the desktop relay's producer, from
    // the same exported mapper, so the two clients cannot disagree about what a
    // failed turn is. No poll and no timer: this is the chat stream ADE's own
    // chat surfaces redraw from.
    const chat = ade?.agentChat as
      | { onEvent?: (listener: (envelope: unknown) => void) => () => void }
      | undefined;
    const isNewTurn = createPluginWebviewChatTurnDedupe();
    const stop = chat?.onEvent?.((envelope) => {
      const turn: PluginWebviewChatTurn | null = pluginWebviewChatTurnFromEvent(envelope);
      // A provider re-emitting a status must not reach the page twice; a page
      // counting running turns gets that wrong. The coalescer downstream keeps
      // the LAST state of a turn within one window, which is a different job.
      if (!turn || !isNewTurn(turn)) return;
      deliver({ kind: "chat", ids: [turn.sessionId], overflow: false, turns: [turn] });
    });
    if (stop) stops.push(stop);
  }
  return () => {
    for (const stop of stops) {
      try {
        stop();
      } catch {
        // One failed unsubscribe must not strand the others.
      }
    }
  };
}

/** Identity, and nothing else — the rule the entity bus itself keeps. */
export function readEntityIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ["laneId", "sessionId", "prId", "id", "number"]) {
    const value = record[key];
    if (typeof value === "string" && value) ids.push(value);
    else if (typeof value === "number") ids.push(String(value));
  }
  return [...new Set(ids)];
}

export default WebPluginPageHost;
