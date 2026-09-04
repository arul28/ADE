import React from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { COLORS, outlineButton } from "../lanes/laneDesignTokens";
import { useRootAppStore } from "../../state/appStore";
import { openPluginLogs, restartPlugin, type InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import {
  PluginPanelHost,
  PluginSurfaceViewedLifecycle,
  type PluginPanelSnapshot,
} from "./PluginPanelHost";
import { eventMatchesBinding } from "../../lib/keybindings";
import { PluginWebviewHost, supportsPluginWebviews } from "./PluginWebviewHost";
import { PluginFallbackCard } from "./VocabularyRenderer";
import { builtinRouteForPluginRoute } from "./builtinTabs";
import { parseDeeplinkPluginContext } from "../../../shared/deeplinks";
import { pluginRailTabSurface } from "../../../shared/plugins/manifest";

/**
 * The route page for a plugin tab (`/plugin/:pluginId`).
 *
 * It owns the states a *page* can be in, which is a different list from the
 * states a *panel* can be in: the plugin may not be installed on this machine,
 * may be disabled, or may have crashed. `PluginPanelHost` handles everything
 * inside the panel and never has to know about any of that.
 *
 * The crash state is the one that matters. A plugin runs in a supervised child
 * process, so "crashed" is a normal condition a user will meet, and it has to
 * come with the two things they can actually do about it — restart, and read
 * the logs — rather than a spinner that never resolves.
 */

/**
 * One panel the reader has walked away from, and everything they left on it.
 *
 * The desktop shape of iOS's `PluginPanelStackEntry` (`PluginPaneStore.swift`).
 * It splits where the two clients differ and nowhere else: the phone holds the
 * panel id and the context in the store, desktop holds them in the URL, so an
 * entry here carries the ADDRESS it is returning to and the host's snapshot of
 * everything client-local that lives below it.
 */
type PluginPanelBackEntry = {
  panelId: string;
  /** The query string this entry was showing — panel plus context, verbatim. */
  search: string;
  /** The panel's declared title, for the Back control's label. */
  title: string | null;
  snapshot: PluginPanelSnapshot;
};

/**
 * How deep the stack goes.
 *
 * Eight, the number iOS uses, and for the same reason: a bound on a plugin's
 * ability to grow it by navigating in a loop, not a design target. The oldest
 * entry is dropped rather than the newest refused, so the reader always keeps
 * the screens they can plausibly remember walking through.
 */
const PLUGIN_PANEL_BACK_STACK_MAX = 8;

/**
 * Layers that own Escape while they are up.
 *
 * A plugin's own prompt card and a `navigate:popover` panel both close on
 * Escape, as does a row's overflow menu, and all three sit ABOVE the panel.
 * Popping the panel out from under one of them would answer a key the reader
 * meant for the thing in front of them. Checked against the document rather
 * than by listener order, because both handlers live on `window` and which one
 * React mounted first is not a contract.
 */
const PLUGIN_PANEL_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"], dialog[open]';

/** The accelerator that pops, resolved to Cmd on macOS and Ctrl everywhere else. */
const PLUGIN_PANEL_BACK_BINDING = "Mod+[";

export function PluginTabPage({ active = true }: { active?: boolean }) {
  const params = useParams<{ pluginId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const pluginId = params.pluginId ?? "";

  // The registry lives on the root store; a project-scoped copy would go stale
  // the moment a plugin is installed. See the slice comment in `appStore.ts`.
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const pluginsLoaded = useRootAppStore((state) => state.pluginsLoaded);
  const lastPanelByPlugin = useRootAppStore((state) => state.pluginViewState.lastPanelByPlugin);
  const setLastPluginPanel = useRootAppStore((state) => state.setLastPluginPanel);

  const plugin = React.useMemo(
    () => plugins.find((entry) => entry.pluginId === pluginId) ?? null,
    [pluginId, plugins],
  );

  // A plugin that gates a compiled-in tab has no panel to render — it owns the
  // app's own page. Sending the route there keeps `/plugin/<id>` a working
  // address (a marketplace link, an old bookmark) instead of a dead end.
  const builtinRoute = React.useMemo(
    () => builtinRouteForPluginRoute(pluginId, plugins),
    [pluginId, plugins],
  );

  const requestedPanelId = searchParams.get("panel");
  /**
   * The remembered panel, kept only while this plugin still declares it.
   *
   * The store remembers a panel id per plugin so a rail click returns where the
   * reader left off. Unvalidated, that memory OUTLIVED the manifest that earned
   * it: a plugin that declares only `dashboard` was opened at the remembered
   * `main`, `tabs.find` matched nothing, and the page hosted a panel the plugin
   * never published — a rail tab that looks like it does nothing, with no error
   * anywhere. The same happens on the very first click, where the default `main`
   * is remembered from no plugin at all.
   *
   * A panel reached through `{navigate:{panelId}}` is not forgotten by this: the
   * navigation writes `?panel=`, which is the address Back, reload and a
   * deeplink all carry, and `?panel=` still wins here.
   */
  const rememberedPanelId = lastPanelByPlugin[pluginId] ?? null;
  const declaresRemembered = Boolean(
    rememberedPanelId && plugin?.tabs.some((tab) => tab.panelId === rememberedPanelId),
  );
  const panelId = requestedPanelId
    ?? (declaresRemembered ? rememberedPanelId : null)
    // The plugin's OWN rail surface is the fallback rather than `"main"`, and
    // it is chosen by the one rule every client shares — the same surface the
    // rail draws and the same one a tab badge is addressed against. `"main"`
    // survives only for a plugin that declares no rail surface at all, where
    // there is no declared id to prefer.
    ?? pluginRailTabSurface(plugin?.tabs)?.panelId
    ?? "main";

  // The context an `ade://plugin/…?ctx=` link arrived with. Read off the query
  // string rather than held in router state so it survives a reload and a
  // restored route — the panel is addressable WITH its context or the link only
  // half works.
  const rawContext = searchParams.get("ctx");
  const renderContext = React.useMemo(() => parseDeeplinkPluginContext(rawContext) ?? null, [rawContext]);

  // Which surface this panel id belongs to, so a webview tab draws its page and
  // an ordinary tab draws its panel. Matched on `panelId` because that is the
  // only thing the route carries.
  const surface = React.useMemo(
    () => plugin?.tabs.find((tab) => tab.panelId === panelId) ?? null,
    [panelId, plugin],
  );
  const entryHtml = surface?.kind === "webview" ? surface.entryHtml ?? null : null;
  // The manifest surface behind this route, for `__adeCtx`. Null on an ordinary
  // panel tab, which has no webview surface to name.
  const surfaceId = surface?.kind === "webview" ? surface.id : null;
  // A page fills the frame; a panel sits in the page's padding. Decided here
  // rather than inside the guest so the header keeps its own spacing either way.
  const hostsWebview = Boolean(entryHtml) && supportsPluginWebviews();

  React.useEffect(() => {
    if (!plugin || !panelId) return;
    setLastPluginPanel(plugin.pluginId, panelId);
  }, [panelId, plugin, setLastPluginPanel]);

  /**
   * The panels the reader has walked away from, oldest first.
   *
   * A `navigate` used to REPLACE the panel with nothing behind it: a plugin that
   * sent a reader from a list into a detail screen gave them no way back, and
   * the browser Back the URL implies is not available inside the desktop app at
   * all. iOS grew a stack for exactly this (M1 in the parity map); this is the
   * same stack with the same semantics.
   */
  const [backStack, setBackStack] = React.useState<readonly PluginPanelBackEntry[]>([]);
  // The snapshot a pop is handing back to the panel host. Held rather than
  // passed through the URL because it is the READER's state — ticks, filters,
  // folds — and none of that belongs in a shareable address.
  const [restoreState, setRestoreState] = React.useState<PluginPanelSnapshot | null>(null);
  // Read by the pop, which must stay referentially stable so the key listener is
  // not torn down and rebuilt on every push.
  const backStackRef = React.useRef(backStack);
  backStackRef.current = backStack;

  /**
   * Honour an action's `{navigate:{panelId, context}}`.
   *
   * Written to the URL rather than to component state, so the destination is
   * the same address a `plugin` deeplink would have produced: the same panel
   * with the same context, shareable, restorable, and reachable by Back.
   */
  const navigateToPanel = React.useCallback(
    (
      navigation: { panelId: string; context?: Record<string, unknown> },
      snapshot: PluginPanelSnapshot,
    ) => {
      const next = new URLSearchParams();
      next.set("panel", navigation.panelId);
      if (navigation.context) {
        try {
          next.set("ctx", JSON.stringify(navigation.context));
        } catch {
          // A context that will not serialize is dropped; the reader still lands
          // on the panel the plugin sent them to.
        }
      }
      // What is being left, with what the reader had on it. Built explicitly
      // rather than copied off the live query string, because the panel showing
      // now may have been resolved from the remembered id or the manifest's own
      // rail surface and carry no `?panel=` at all.
      const leaving = new URLSearchParams();
      leaving.set("panel", panelId);
      if (rawContext) leaving.set("ctx", rawContext);
      setBackStack((stack) => {
        const grown = [
          ...stack,
          {
            panelId,
            search: leaving.toString(),
            title: plugin?.tabs.find((tab) => tab.panelId === panelId)?.title ?? null,
            snapshot,
          },
        ];
        return grown.length > PLUGIN_PANEL_BACK_STACK_MAX
          ? grown.slice(grown.length - PLUGIN_PANEL_BACK_STACK_MAX)
          : grown;
      });
      // A push is not a restore. Cleared so a snapshot from an earlier pop
      // cannot be adopted by the panel the reader is walking INTO.
      setRestoreState(null);
      setSearchParams(next, { replace: false });
    },
    [panelId, plugin, rawContext, setSearchParams],
  );

  /**
   * Return to the panel beneath this one, with what the reader left on it.
   *
   * Everything client-local comes back together — the filters, the ticks, the
   * folded sections and how far down each list they had read — because
   * restoring half of them is what makes a back gesture feel like a reload
   * rather than a return. The address goes back verbatim, context included.
   */
  const goBack = React.useCallback(() => {
    const stack = backStackRef.current;
    const entry = stack[stack.length - 1];
    if (!entry) return;
    setBackStack(stack.slice(0, -1));
    setRestoreState(entry.snapshot);
    setSearchParams(new URLSearchParams(entry.search), { replace: false });
  }, [setSearchParams]);

  const canGoBack = backStack.length > 0;

  /**
   * Escape and the platform accelerator pop.
   *
   * Bound only while there is something to pop, so a plugin tab at depth zero
   * claims neither key from anything else in the app. Escape defers to whatever
   * is drawn above the panel; the accelerator resolves through the renderer's
   * own binding parser, which is what makes `Ctrl+[` on Windows and Linux the
   * same gesture as `Cmd+[` on macOS rather than a second implementation of the
   * platform test.
   */
  React.useEffect(() => {
    if (!active || !canGoBack) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const escape = event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!escape && !eventMatchesBinding(event, PLUGIN_PANEL_BACK_BINDING)) return;
      if (document.querySelector(PLUGIN_PANEL_OVERLAY_SELECTOR)) return;
      event.preventDefault();
      goBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, canGoBack, goBack]);

  // A route the reader steered themselves — a rail click, a deeplink, the
  // remembered panel on reopen — is not a step in the plugin's own walk. The
  // stack belongs to one plugin's navigation and is dropped when the plugin
  // changes underneath it.
  React.useEffect(() => {
    setBackStack([]);
    setRestoreState(null);
  }, [pluginId]);

  if (builtinRoute) return <Navigate to={builtinRoute} replace />;

  if (!pluginsLoaded && !plugin) {
    return <PluginPageShell plugin={null} title="Loading" pluginId={pluginId} active={active} />;
  }

  if (!plugin) {
    return (
      <PluginPageShell plugin={null} title={pluginId} pluginId={pluginId} active={active}>
        <PluginFallbackCard
          fallback={{
            title: "Not installed here",
            text: "This plugin isn’t installed on this machine. Install it from the Marketplace, or switch to the machine that has it.",
          }}
        />
      </PluginPageShell>
    );
  }

  return (
    <PluginPageShell
      plugin={plugin}
      title={plugin.displayName}
      pluginId={pluginId}
      active={active}
      fill={hostsWebview}
    >
      <PluginBody
        plugin={plugin}
        panelId={panelId}
        active={active}
        entryHtml={entryHtml}
        surfaceId={surfaceId}
        renderContext={renderContext}
        onNavigate={navigateToPanel}
        onBack={canGoBack ? goBack : null}
        backLabel={backStack[backStack.length - 1]?.title ?? null}
        restoreState={restoreState}
      />
    </PluginPageShell>
  );
}

function PluginBody({
  plugin,
  panelId,
  active,
  entryHtml,
  surfaceId,
  renderContext,
  onNavigate,
  onBack,
  backLabel,
  restoreState,
}: {
  plugin: InstalledPlugin;
  panelId: string;
  active: boolean;
  /** Set when this surface is a webview and this client can host one. */
  entryHtml: string | null;
  /** The manifest surface id behind that page, for the guest's `__adeCtx`. */
  surfaceId: string | null;
  renderContext: Record<string, unknown> | null;
  onNavigate: (
    navigation: { panelId: string; context?: Record<string, unknown> },
    snapshot: PluginPanelSnapshot,
  ) => void;
  onBack: (() => void) | null;
  backLabel: string | null;
  restoreState: PluginPanelSnapshot | null;
}) {
  if (!plugin.enabled) {
    return (
      <PluginFallbackCard
        fallback={{
          title: "Turned off",
          text: "This plugin is installed but switched off. Turn it back on from the Marketplace to see its panels.",
        }}
      />
    );
  }

  if (plugin.status === "crashed") {
    return <PluginCrashCard plugin={plugin} />;
  }

  // A webview surface names its page AND a panel. The page wins where a guest
  // can run; everywhere else the panel is what the manifest promised would be
  // shown instead, so falling through to it is the contract, not a degradation.
  //
  // The viewed lifecycle rides alongside. It normally lives in the panel host,
  // which this branch returns before reaching — so a plugin whose only rail
  // surface is a webview published a tab badge and was never told the reader
  // had opened it, and the pill stayed up until the plugin unpublished it.
  if (entryHtml && supportsPluginWebviews()) {
    return (
      <>
        <PluginSurfaceViewedLifecycle
          pluginId={plugin.pluginId}
          panelId={panelId}
          active={active}
        />
        <PluginWebviewHost
          pluginId={plugin.pluginId}
          entryHtml={entryHtml}
          active={active}
          placement="tab"
          surfaceId={surfaceId}
        />
      </>
    );
  }

  const panel = (
    <PluginPanelHost
      pluginId={plugin.pluginId}
      panelId={panelId}
      active={active}
      renderContext={renderContext}
      onNavigate={onNavigate}
      onBack={onBack}
      backLabel={backLabel}
      restoreState={restoreState}
      recoveryAction={plugin.status === "none" ? undefined : <RestartButton pluginId={plugin.pluginId} />}
    />
  );

  // A webview surface on a client that cannot host one draws the PANEL, and
  // says nothing about it.
  //
  // This used to add a card telling the reader the real page lives in the
  // desktop app. The page tier retires that: `panelId` is the surface's own
  // declared cross-client rendering, so the panel is the contract being kept
  // rather than a consolation for one that was broken — and a card advertising
  // another application, on a client where the plugin is working correctly, is
  // an apology for nothing. The hosted web client grows its own page host in
  // wave 2 (see the TODO in `PluginWebviewHost.tsx`), at which point this
  // branch stops being reached there at all.
  return panel;
}

/**
 * The dead state.
 *
 * Deliberately not the generic fallback card: a crash is the one failure where
 * the reader has real options, so both of them are first-class buttons rather
 * than something to hunt for.
 */
function PluginCrashCard({ plugin }: { plugin: InstalledPlugin }) {
  const [error, setError] = React.useState<string | null>(null);
  return (
    <PluginFallbackCard
      fallback={{
        title: `${plugin.displayName} stopped`,
        text: error
          ?? "The plugin’s process exited unexpectedly. Restarting usually clears it; the logs say why it happened.",
      }}
      action={
        <>
          <RestartButton pluginId={plugin.pluginId} onError={setError} />
          <button
            type="button"
            onClick={() => {
              void openPluginLogs(plugin.pluginId).catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not open the logs.");
              });
            }}
            style={{
              ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
              background: "transparent",
              border: "1px solid transparent",
              color: COLORS.textMuted,
            }}
          >
            View logs
          </button>
        </>
      }
    />
  );
}

function RestartButton({
  pluginId,
  onError,
}: {
  pluginId: string;
  onError?: (message: string) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const refreshInstalledPlugins = useRootAppStore((state) => state.refreshInstalledPlugins);
  return (
    <button
      type="button"
      disabled={pending}
      data-tour={`plugin:${pluginId}.restart`}
      onClick={() => {
        setPending(true);
        void restartPlugin(pluginId)
          .then(() => refreshInstalledPlugins())
          .catch((cause: unknown) => {
            onError?.(cause instanceof Error ? cause.message : "Could not restart the plugin.");
          })
          .finally(() => setPending(false));
      }}
      style={{
        ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
        opacity: pending ? 0.55 : 1,
        cursor: pending ? "default" : "pointer",
      }}
    >
      {pending ? "Restarting…" : "Restart"}
    </button>
  );
}

/**
 * Page chrome shared by every state. The plugin's accent is set as a CSS
 * variable on the page root rather than written into styles directly, so the
 * accent participates in the cascade — and so a plugin cannot paint anything it
 * was not given a slot for.
 *
 * There is no name/version header. The rail already names the tab, and a
 * second "Review 2.0.0" row on every plugin page was chrome the compiled
 * surfaces never had.
 */
function PluginPageShell({
  plugin,
  pluginId,
  title,
  active,
  fill = false,
  children,
}: {
  plugin: InstalledPlugin | null;
  pluginId: string;
  title: string;
  active: boolean;
  /** The body owns the whole frame — a webview page rather than a panel. */
  fill?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      aria-label={title}
      data-tour={`plugin:${pluginId}.page`}
      data-ade-animation-state={active ? "running" : "paused"}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        ...(plugin?.accent ? ({ "--plugin-accent": plugin.accent } as React.CSSProperties) : {}),
      }}
    >
      <div
        style={fill
          ? { display: "flex", flex: 1, minHeight: 0, minWidth: 0 }
          : { padding: 20, minWidth: 0, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {children}
      </div>
    </div>
  );
}

export default PluginTabPage;
