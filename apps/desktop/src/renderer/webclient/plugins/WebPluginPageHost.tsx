import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../../components/lanes/laneDesignTokens";
import { PluginFallbackCard } from "../../components/plugins/VocabularyRenderer";
import { applyPluginActionOpenSettings } from "../../components/plugins/pluginActionOpenSettings";
import { applyPluginComposerEdit } from "../../components/plugins/sockets/composerTarget";
import { closePluginPanelPopover } from "../../components/plugins/sockets/pluginPanelPopoverStore";
import { closePluginWebviewOverlay } from "../../components/plugins/sockets/pluginWebviewOverlayStore";
import { openPluginPrompt } from "../../components/plugins/sockets/pluginPromptStore";
import { dismissToast, showToast } from "../../components/app/toast/toastStore";
import { ConfirmDialog, useConfirmDialog } from "../../components/shared/InlineDialogs";
import { openAdeDeeplink, openExternalUrl } from "../../lib/openExternal";
import {
  invokePluginAction,
  readPluginCollection,
  readPluginConfig,
  readPluginPanel,
  writePluginConfig,
} from "../../lib/pluginRuntimeBridge";
import { rootAppStoreApi } from "../../state/appStore";
import {
  buildPluginActionPromptAnswer,
  type PluginActionPrompt,
  type PluginActionPromptAnswer,
} from "../../../shared/plugins/sdk";
import {
  PLUGIN_WEBVIEW_LIST_MAX_ROWS,
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
}: {
  pluginId: string;
  /** Plugin-relative path from the manifest surface, already validated there. */
  entryHtml: string;
  /** False while the surface is mounted but not visible. */
  active: boolean;
  /** The subject to inject. Null for a full tab or pane. See the desktop host. */
  context?: PluginWebviewContext | null;
}) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = React.useRef<PluginPageHost | null>(null);
  const [state, setState] = React.useState<{ status: "loading" | "ready" } | { status: "failed"; message: string }>({
    status: "loading",
  });
  const [reloadToken, setReloadToken] = React.useState(0);
  const [sectionHeight, setSectionHeight] = React.useState<number | null>(null);
  const confirm = useConfirmDialog();
  // Held in a ref, and deliberately NOT an effect dependency. Rebuilding the
  // guest is expensive and destructive — it drops the page's unsubmitted work —
  // so it must happen when the SURFACE changes, never because a callback the
  // host merely forwards to was handed back with a new identity.
  const confirmRef = React.useRef(confirm.confirmAsync);
  confirmRef.current = confirm.confirmAsync;

  const placement: PluginWebviewPlacement = context?.placement ?? "tab";
  // Folded into one string so a parent handing a fresh-but-equal object each
  // render does not tear the guest down, exactly as the desktop host does it.
  const contextKey = React.useMemo(() => (context ? JSON.stringify(context) : ""), [context]);

  React.useEffect(() => {
    // Destroy when hidden. The effect keys on `active`, so leaving the surface
    // runs the teardown below and returning builds a fresh guest.
    if (!active) return;
    let cancelled = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;
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
          configGet: () => readPluginConfig(pluginId),
          configSet: async (values) => {
            for (const [key, value] of Object.entries(values)) await writePluginConfig(pluginId, key, value);
            return readPluginConfig(pluginId);
          },
        },
        subscribeHostEntities: subscribeHostEntities,
      });
      bridgeRef.current = host;
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
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      // `about:blank` before the element goes: a frame removed with a live
      // document keeps that document alive until the collector runs, and a
      // plugin page with a socket open would go on holding it.
      frameRef.current?.setAttribute("src", "about:blank");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contextKey folds `context`; the rest are primitives.
  }, [pluginId, entryHtml, active, contextKey, reloadToken, placement]);

  // The theme is republished rather than polled: the app paints `data-theme` on
  // the document element, so one observer on that attribute is the whole feed.
  React.useEffect(() => {
    if (!active) return;
    const observer = new MutationObserver(() => {
      bridgeRef.current?.publish("theme", readPluginPageTheme(document, window));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [active]);

  if (!active) return null;

  return (
    <div
      data-tour={`plugin:${pluginId}.webview`}
      style={{
        position: "relative",
        display: "flex",
        flex: placement === "settings-section" ? "0 0 auto" : 1,
        minHeight: 0,
        minWidth: 0,
        ...(placement === "settings-section" && sectionHeight
          ? { height: Math.min(sectionHeight, 1_200) }
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
      <ConfirmDialog state={confirm.state} onClose={confirm.close} />
    </div>
  );
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
 * Ask ADE's own one-field question and answer with the SDK's shape.
 *
 * The prompt store is a single-question store shared with the socket path, so a
 * page's question replaces whatever was open, exactly as a second socket press
 * does. A dismissal resolves null rather than rejecting: the page asked and the
 * reader declined, which is an answer.
 */
function askPrompt(pluginId: string, prompt: PluginActionPrompt): Promise<PluginActionPromptAnswer | null> {
  return new Promise((resolve) => {
    openPluginPrompt({
      pluginId,
      actionId: prompt.id,
      prompt,
      fallbackTitle: null,
      anchor: null,
      onSubmit: (text) => resolve(buildPluginActionPromptAnswer(prompt, text)),
    });
    // The store closes without calling `onSubmit` when the reader dismisses, so
    // nothing resolves that promise from here. `PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS`
    // is the desktop's answer to the same shape; here the guest is torn down
    // with the surface, which settles it.
  });
}

function closeSurfaceFor(placement: PluginWebviewPlacement): void {
  // A tab and a pane ARE the view: there is nothing above them to close, and
  // the desktop bridge documents the same no-op.
  if (placement === "tab" || placement === "pane") return;
  if (placement === "popover" || placement === "composer-picker") closePluginPanelPopover();
  else closePluginWebviewOverlay();
}

/**
 * Lane, session and PR movement, as identity-only frames.
 *
 * The three subscriptions are the ones `window.ade` publishes on both clients,
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
