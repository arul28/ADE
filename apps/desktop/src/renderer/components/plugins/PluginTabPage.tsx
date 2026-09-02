import React from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useRootAppStore } from "../../state/appStore";
import { openPluginLogs, restartPlugin, type InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import { PluginPanelHost, PluginSurfaceViewedLifecycle } from "./PluginPanelHost";
import { PluginWebviewHost, supportsPluginWebviews } from "./PluginWebviewHost";
import { PluginFallbackCard } from "./VocabularyRenderer";
import { pluginIcon } from "./pluginIcons";
import { builtinRouteForPluginRoute } from "./builtinTabs";
import { buildDeeplink, parseDeeplinkPluginContext } from "../../../shared/deeplinks";
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
  // A page fills the frame; a panel sits in the page's padding. Decided here
  // rather than inside the guest so the header keeps its own spacing either way.
  const hostsWebview = Boolean(entryHtml) && supportsPluginWebviews();

  React.useEffect(() => {
    if (!plugin || !panelId) return;
    setLastPluginPanel(plugin.pluginId, panelId);
  }, [panelId, plugin, setLastPluginPanel]);

  /**
   * Honour an action's `{navigate:{panelId, context}}`.
   *
   * Written to the URL rather than to component state, so the destination is
   * the same address a `plugin` deeplink would have produced: the same panel
   * with the same context, shareable, restorable, and reachable by Back.
   */
  const navigateToPanel = React.useCallback(
    (navigation: { panelId: string; context?: Record<string, unknown> }) => {
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
      setSearchParams(next, { replace: false });
    },
    [setSearchParams],
  );

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
        renderContext={renderContext}
        onNavigate={navigateToPanel}
      />
    </PluginPageShell>
  );
}

function PluginBody({
  plugin,
  panelId,
  active,
  entryHtml,
  renderContext,
  onNavigate,
}: {
  plugin: InstalledPlugin;
  panelId: string;
  active: boolean;
  /** Set when this surface is a webview and this client can host one. */
  entryHtml: string | null;
  renderContext: Record<string, unknown> | null;
  onNavigate: (navigation: { panelId: string; context?: Record<string, unknown> }) => void;
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
        <PluginWebviewHost pluginId={plugin.pluginId} entryHtml={entryHtml} active={active} />
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
      recoveryAction={plugin.status === "none" ? undefined : <RestartButton pluginId={plugin.pluginId} />}
    />
  );

  // A webview surface on a client that cannot host one. The panel below is
  // still the contract and still renders; what this adds is the missing half
  // of the story — that there IS a richer page, and where to see it — because
  // silently showing the fallback makes a plugin look like it has less to offer
  // than it does.
  if (entryHtml) {
    return (
      <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
        <PluginWebviewElsewhereCard
          plugin={plugin}
          panelId={panelId}
          renderContext={renderContext}
        />
        {panel}
      </div>
    );
  }

  return panel;
}

/**
 * The "this page lives on the desktop app" card.
 *
 * A `webview` surface is a plugin's own HTML served over the `ade-plugin://`
 * protocol, which is registered by the Electron main process — there is no
 * browser equivalent and there will not be one, so this is a permanent property
 * of the client rather than a feature that has not shipped yet. The card says
 * that in those terms and hands over the one thing that resolves it: the
 * `ade://` address of this exact panel, which the OS gives to the desktop app.
 *
 * A plain anchor, not a click handler. An unknown scheme is a navigation the
 * browser hands to the OS handler on its own, and an anchor is also the form a
 * reader can copy, middle-click or open however they prefer.
 */
function PluginWebviewElsewhereCard({
  plugin,
  panelId,
  renderContext,
}: {
  plugin: InstalledPlugin;
  panelId: string;
  renderContext: Record<string, unknown> | null;
}) {
  // The context rides along, so the link reopens the panel the reader is
  // looking at rather than the plugin's front page.
  const href = React.useMemo(
    () => buildDeeplink(
      {
        kind: "plugin",
        pluginId: plugin.pluginId,
        panelId,
        ...(renderContext ? { context: renderContext } : {}),
      },
      { form: "ade" },
    ),
    [panelId, plugin.pluginId, renderContext],
  );
  return (
    <PluginFallbackCard
      fallback={{
        title: `${plugin.displayName} has a page that only the desktop app can show`,
        text: "Its page runs inside ADE on your computer. What you see below is what the plugin publishes for every other client.",
      }}
      action={
        <a
          href={href}
          style={{
            ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
            display: "inline-flex",
            alignItems: "center",
            textDecoration: "none",
          }}
        >
          Open on desktop
        </a>
      }
    />
  );
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
  const Icon = pluginIcon(plugin?.icon, plugin?.brandIcons);
  return (
    <div
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
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 20px 12px",
          borderBottom: `1px solid ${COLORS.borderMuted}`,
        }}
      >
        <Icon
          size={17}
          weight="regular"
          color={plugin?.accent ? "var(--plugin-accent)" : COLORS.textMuted}
          aria-hidden
        />
        <h1
          style={{
            margin: 0,
            fontFamily: SANS_FONT,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: COLORS.textPrimary,
          }}
        >
          {title}
        </h1>
        {plugin ? (
          <span
            style={{
              padding: "2px 6px",
              fontFamily: SANS_FONT,
              fontSize: 10.5,
              color: COLORS.textDim,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: RADII.sm,
            }}
          >
            {plugin.version}
          </span>
        ) : null}
      </header>
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
