import React from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useRootAppStore } from "../../state/appStore";
import { openPluginLogs, restartPlugin, type InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import { PluginPanelHost } from "./PluginPanelHost";
import { PluginFallbackCard } from "./VocabularyRenderer";
import { pluginIcon } from "./pluginIcons";

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
  const [searchParams] = useSearchParams();
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

  const requestedPanelId = searchParams.get("panel");
  const panelId = requestedPanelId
    ?? lastPanelByPlugin[pluginId]
    ?? plugin?.tabs[0]?.panelId
    ?? "main";

  React.useEffect(() => {
    if (!plugin || !panelId) return;
    setLastPluginPanel(plugin.pluginId, panelId);
  }, [panelId, plugin, setLastPluginPanel]);

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
    <PluginPageShell plugin={plugin} title={plugin.displayName} pluginId={pluginId} active={active}>
      <PluginBody plugin={plugin} panelId={panelId} active={active} />
    </PluginPageShell>
  );
}

function PluginBody({
  plugin,
  panelId,
  active,
}: {
  plugin: InstalledPlugin;
  panelId: string;
  active: boolean;
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

  return (
    <PluginPanelHost
      pluginId={plugin.pluginId}
      panelId={panelId}
      active={active}
      recoveryAction={plugin.status === "none" ? undefined : <RestartButton pluginId={plugin.pluginId} />}
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
  children,
}: {
  plugin: InstalledPlugin | null;
  pluginId: string;
  title: string;
  active: boolean;
  children?: React.ReactNode;
}) {
  const Icon = pluginIcon(plugin?.icon);
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
        overflow: "auto",
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
      <div style={{ padding: 20, minWidth: 0 }}>{children}</div>
    </div>
  );
}

export default PluginTabPage;
