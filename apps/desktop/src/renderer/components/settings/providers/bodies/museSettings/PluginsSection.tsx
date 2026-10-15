/** Muse's plugins and marketplaces: install, update, remove, and add a marketplace. */
import React, { useCallback, useState } from "react";
import { COLORS, MONO_FONT, SECTION_LABEL_STYLE } from "../../../../lanes/laneDesignTokens";
import { showToast } from "../../../../app/toast/toastStore";
import { confirmDialog } from "../../../../ui/dialog";
import { useSettingsAction } from "../../../useSettingsAction";
import type { MusePluginInstallScope, MuseSettingsPlugin, MuseSettingsSnapshot } from "../../../../../../shared/museSettings";
import type { MuseRun } from "./museSettingsShared";
import { ErrorNotice, FIELD, ROW, SMALL_BUTTON, SectionError, SectionHeader, TEXT_MUTED, isOneOf } from "./museSettingsShared";

const isPluginInstallScope = isOneOf<MusePluginInstallScope>(["default", "user", "project"]);

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function pluginSourceLabel(source: string): string {
  switch (source) {
    case "curated": return "curated";
    case "marketplaceUserAdded": return "from a marketplace";
    case "foreignImport": return "imported";
    case "nativeLocal": return "local folder";
    default: return source;
  }
}

function installResult(plugin: MuseSettingsPlugin, warning: string | null): string {
  return `Installed ${plugin.id} ${plugin.version}.${warning ? ` ${warning}` : ""}`;
}

export function PluginsSection({ snapshot, run, reload }: { snapshot: MuseSettingsSnapshot; run: MuseRun; reload: () => Promise<void> }) {
  const action = useSettingsAction();
  const busy = action.busy;
  const [folder, setFolder] = useState("");
  const [folderScope, setFolderScope] = useState<MusePluginInstallScope>("default");
  const [marketName, setMarketName] = useState("");
  const [marketSource, setMarketSource] = useState("");

  /** Runs one change, reloads the page, and reports what Muse said as a toast. */
  const act = useCallback(async (key: string, work: () => Promise<string>) => {
    const message = await action.run(key, async () => {
      const text = await work();
      await reload();
      return text;
    });
    if (message) showToast({ tone: "success", title: message });
  }, [action.run, reload]);

  const removeMarketplace = async (name: string) => {
    const confirmed = await confirmDialog({
      title: `Remove ${name}?`,
      message: "Plugins already installed from it stay installed.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    await act(`remove:${name}`, async () => {
      await run({ kind: "marketplaceRemove", name });
      return `Removed ${name}. Plugins already installed from it stay installed.`;
    });
  };

  const installed = snapshot.plugins.ok ? snapshot.plugins.rows : [];
  const installedIds = new Set(installed.map((plugin) => plugin.id));
  const available = snapshot.availablePlugins.ok ? snapshot.availablePlugins.rows : [];
  const marketplaces = snapshot.marketplaces.ok ? snapshot.marketplaces.rows : [];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Plugins" />
      <div style={TEXT_MUTED}>Muse's installed plugins on this machine, and the marketplaces it installs from.</div>
      <SectionError id="muse-plugins-error" section={snapshot.plugins} />
      {snapshot.plugins.ok && installed.length === 0 ? <div style={TEXT_MUTED}>No plugins installed.</div> : null}
      {installed.length ? (
        <div>
          {installed.map((plugin) => (
            <div key={plugin.id} style={ROW}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {plugin.id} <span style={{ color: COLORS.textDim }}>{plugin.version}</span>
              </span>
              <span style={{ color: COLORS.textMuted, flexShrink: 0 }}>
                {plugin.enabled ? "on" : "off"} · {pluginSourceLabel(plugin.source)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ ...SECTION_LABEL_STYLE, marginTop: 6 }}>Available from marketplaces</div>
      <SectionError id="muse-available-plugins-error" section={snapshot.availablePlugins} />
      {snapshot.availablePlugins.ok && available.length === 0 ? (
        <div style={TEXT_MUTED}>Add a marketplace below to see the plugins it offers.</div>
      ) : null}
      {available.map((plugin) => {
        const key = `install:${plugin.marketplace}:${plugin.name}`;
        const isInstalled = installedIds.has(plugin.name);
        return (
          <div key={key} style={ROW}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {plugin.name}
              {plugin.version ? <span style={{ color: COLORS.textDim }}> {plugin.version}</span> : null}
              <span style={{ color: COLORS.textMuted }}> · {plugin.marketplace}</span>
            </span>
            <button
              type="button"
              style={SMALL_BUTTON}
              disabled={busy != null}
              onClick={() => void act(key, async () => {
                const result = await run({
                  kind: "pluginInstall",
                  target: { marketplace: plugin.marketplace, name: plugin.name },
                });
                return installResult(result.plugin, result.warning);
              })}
            >
              {busy === key ? "Installing…" : isInstalled ? "Reinstall" : "Install"}
            </button>
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
        <input
          aria-label="Plugin folder"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="Install from a folder on that machine: /path/to/plugin"
          style={{ ...FIELD, flex: "1 1 240px" }}
        />
        <select
          aria-label="Install scope"
          value={folderScope}
          onChange={(event) => {
            const next = event.target.value;
            if (isPluginInstallScope(next)) setFolderScope(next);
          }}
          style={FIELD}
        >
          <option value="default">Default scope</option>
          <option value="user">User</option>
          <option value="project">This project</option>
        </select>
        <button
          type="button"
          style={SMALL_BUTTON}
          disabled={busy != null || !folder.trim()}
          onClick={() => void act("install:folder", async () => {
            const result = await run({ kind: "pluginInstall", target: { path: folder.trim(), scope: folderScope } });
            setFolder("");
            return installResult(result.plugin, result.warning);
          })}
        >
          {busy === "install:folder" ? "Installing…" : "Install"}
        </button>
      </div>

      <div style={{ ...SECTION_LABEL_STYLE, marginTop: 6 }}>Marketplaces</div>
      <SectionError id="muse-marketplaces-error" section={snapshot.marketplaces} />
      {snapshot.marketplaces.ok && marketplaces.length === 0 ? <div style={TEXT_MUTED}>No marketplaces configured.</div> : null}
      {marketplaces.map((market) => (
        <div key={market.name} style={ROW}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {market.name}
            <span style={{ color: COLORS.textMuted }}>
              {" "}· {plural(market.pluginCount, "plugin")}
              {market.skippedCount ? ` (${market.skippedCount} skipped)` : ""}
            </span>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, overflowWrap: "anywhere" }}>{market.sourcePath}</div>
          </span>
          <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              style={SMALL_BUTTON}
              disabled={busy != null}
              onClick={() => void act(`update:${market.name}`, async () => {
                const result = await run({ kind: "marketplaceUpdate", name: market.name });
                return `Updated ${result.marketplace.name}: ${plural(result.marketplace.pluginCount, "plugin")}.`;
              })}
            >
              {busy === `update:${market.name}` ? "Updating…" : "Update"}
            </button>
            <button
              type="button"
              style={SMALL_BUTTON}
              disabled={busy != null}
              onClick={() => void removeMarketplace(market.name)}
            >
              {busy === `remove:${market.name}` ? "Removing…" : "Remove"}
            </button>
          </span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input aria-label="Marketplace name" value={marketName} onChange={(event) => setMarketName(event.target.value)} placeholder="Name" style={{ ...FIELD, flex: "0 1 140px" }} />
        <input
          aria-label="Marketplace source"
          value={marketSource}
          onChange={(event) => setMarketSource(event.target.value)}
          placeholder="owner/repo, a git URL, or a folder on that machine"
          style={{ ...FIELD, flex: "1 1 220px" }}
        />
        <button
          type="button"
          style={SMALL_BUTTON}
          disabled={busy != null || !marketName.trim() || !marketSource.trim()}
          onClick={() => void act("market:add", async () => {
            const result = await run({ kind: "marketplaceAdd", name: marketName.trim(), source: marketSource.trim() });
            setMarketName("");
            setMarketSource("");
            return `Added ${result.marketplace.name}: ${plural(result.marketplace.pluginCount, "plugin")}.`;
          })}
        >
          {busy === "market:add" ? "Adding…" : "Add marketplace"}
        </button>
      </div>
      <ErrorNotice id="muse-plugins-action-error" message={action.error} />
    </section>
  );
}
