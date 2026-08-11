import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../../../shared/types";
import type {
  SyncMobileProjectSummary,
  SyncPluginSnapshotPayload,
  SyncRemoteCommandDescriptor,
} from "../../../../shared/types/sync";
import type { AdeSyncClient, PluginPanelHandlers } from "../../sync";
import {
  pluginMarketplaceCapabilities,
  setPluginEnabled,
  installPlugin,
  listInstalledPlugins,
  readPluginPanel,
  pluginsAvailable,
} from "../../../lib/pluginRuntimeBridge";
import { createAdeWebAdapter } from "../index";

const project: ProjectInfo = { rootPath: "/repo", displayName: "Repo", baseRef: "main" };

const ALL_PLUGIN_ACTIONS = [
  "plugins.list",
  "plugins.install",
  "plugins.uninstall",
  "plugins.enable",
  "plugins.disable",
];

function descriptors(actions: string[]): SyncRemoteCommandDescriptor[] {
  return actions.map((action) => ({
    action,
    scope: "runtime" as const,
    policy: { viewerAllowed: true },
  }));
}

type CommandCall = { action: string; args: Record<string, unknown> };

class FakePluginSyncClient {
  descriptors: SyncRemoteCommandDescriptor[] = descriptors(ALL_PLUGIN_ACTIONS);
  commandResults = new Map<string, unknown>();
  commandErrors = new Map<string, Error>();
  commandCalls: CommandCall[] = [];
  panelSnapshots = new Map<string, SyncPluginSnapshotPayload>();
  pluginSubscribeCalls: Array<{ pluginId: string; panelId: string }> = [];
  pluginUnsubscribeCalls: Array<{ pluginId: string; panelId: string }> = [];
  projects: SyncMobileProjectSummary[] = [];
  activeProjectId: string | null = "project-1";

  asClient(): AdeSyncClient {
    return this as never as AdeSyncClient;
  }

  getStatus() {
    return {
      state: "connected" as const,
      endpoint: "ws://localhost:8787",
      envId: "env-1",
      hostDeviceId: "host-1",
      hostName: "Host",
      connectedAt: "2026-08-11T00:00:00.000Z",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
      error: null,
      activeProjectId: this.activeProjectId,
      selectedEnvId: "env-1",
    };
  }

  subscribe(): () => void {
    return () => {};
  }

  onTablesChanged(): () => void {
    return () => {};
  }

  onProjectCatalog(): () => void {
    return () => {};
  }

  onActiveProjectChanged(): () => void {
    return () => {};
  }

  onChatEvent(): () => void {
    return () => {};
  }

  onBrainStatus(): () => void {
    return () => {};
  }

  getCommandDescriptors(): SyncRemoteCommandDescriptor[] {
    return this.descriptors;
  }

  async getProjectCatalog(): Promise<{ projects: SyncMobileProjectSummary[] }> {
    return { projects: this.projects };
  }

  async sendCommand(action: string, args: Record<string, unknown>): Promise<unknown> {
    this.commandCalls.push({ action, args });
    const error = this.commandErrors.get(action);
    if (error) throw error;
    return this.commandResults.has(action) ? this.commandResults.get(action) : null;
  }

  subscribePluginPanel(pluginId: string, panelId: string, handlers: PluginPanelHandlers): () => void {
    this.pluginSubscribeCalls.push({ pluginId, panelId });
    const snapshot = this.panelSnapshots.get(`${pluginId}/${panelId}`);
    if (snapshot) queueMicrotask(() => handlers.snapshot?.(snapshot));
    return () => {
      this.pluginUnsubscribeCalls.push({ pluginId, panelId });
    };
  }
}

function mountAdapter(fake: FakePluginSyncClient): { dispose: () => void } {
  const adapter = createAdeWebAdapter(fake.asClient());
  adapter.bindProject(project, "project-1");
  // The bridge reads `window.ade`, so the adapter has to be installed there for
  // these tests to exercise the same path the Marketplace does.
  (globalThis as unknown as { window?: unknown }).window = { ade: adapter.ade };
  return { dispose: () => adapter.dispose() };
}

describe("web plugin namespace", () => {
  let fake: FakePluginSyncClient;
  let mounted: { dispose: () => void } | null = null;

  beforeEach(() => {
    fake = new FakePluginSyncClient();
  });

  afterEach(() => {
    mounted?.dispose();
    mounted = null;
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("reports only the capabilities this transport can actually serve", () => {
    mounted = mountAdapter(fake);

    // The fallback proxy manufactures a truthy callable for any unimplemented
    // member, so before the honest-surface marker every one of these read true
    // — the Marketplace offered browse, config, usage and remote install on a
    // transport that serves none of them.
    expect(pluginMarketplaceCapabilities()).toEqual({
      browse: false,
      install: true,
      uninstall: true,
      enable: true,
      machines: false,
      remoteInstall: false,
      config: false,
      contributions: false,
      usage: false,
      inspect: false,
    });
    expect(pluginsAvailable()).toBe(true);
  });

  it("drops a capability when the connected host stops serving its action", () => {
    mounted = mountAdapter(fake);
    expect(pluginMarketplaceCapabilities().install).toBe(true);

    // Re-probed per access, not captured at construction: a project handoff can
    // land on a host with a different action set while the page stays open.
    fake.descriptors = descriptors(["plugins.list"]);
    const capabilities = pluginMarketplaceCapabilities();
    expect(capabilities.install).toBe(false);
    expect(capabilities.uninstall).toBe(false);
    expect(capabilities.enable).toBe(false);
  });

  it("requires BOTH halves of the enable pair before offering the toggle", () => {
    fake.descriptors = descriptors(["plugins.enable"]);
    mounted = mountAdapter(fake);

    // A host serving only `enable` would give a working "turn on" and a
    // silently failing "turn off".
    expect(pluginMarketplaceCapabilities().enable).toBe(false);
  });

  it("routes setEnabled by the enabled flag, not by argument position", () => {
    mounted = mountAdapter(fake);

    return (async () => {
      await setPluginEnabled("graph", true);
      await setPluginEnabled("graph", false);

      // The defect this pins: a positional `(pluginId, enabled)` signature bound
      // the bridge's single `{pluginId, enabled}` object to the first parameter,
      // so `enabled` was always undefined and every toggle disabled the plugin.
      expect(fake.commandCalls.map((call) => call.action)).toEqual([
        "plugins.enable",
        "plugins.disable",
      ]);
      expect(fake.commandCalls[0].args).toEqual({ pluginId: "graph" });
    })();
  });

  it("refuses to toggle a plugin on another machine rather than acting on this one", async () => {
    mounted = mountAdapter(fake);

    await expect(setPluginEnabled("graph", true, "machine-b")).rejects.toThrow(/another computer/);
    expect(fake.commandCalls).toHaveLength(0);
  });

  it("throws the typed unsupported error for a write the host does not serve", async () => {
    fake.descriptors = [];
    mounted = mountAdapter(fake);

    // Not a resolved null: no request was sent, so reporting success would
    // report an install that never happened.
    await expect(installPlugin({ source: "https://example.test/graph.git" }))
      .rejects.toThrow(/can’t install plugins/);
    expect(fake.commandCalls).toHaveLength(0);
  });

  it("maps a wire install record onto the shape the marketplace renders", async () => {
    fake.commandResults.set("plugins.install", {
      pluginId: "graph",
      version: "1.2.0",
      enabled: true,
      displayName: "Graph",
      icon: "graph",
      accent: "#7C6FF0",
      source: "https://example.test/graph.git",
      installedAt: "2026-08-11T00:00:00.000Z",
    });
    mounted = mountAdapter(fake);

    await expect(installPlugin({ source: "https://example.test/graph.git" })).resolves.toEqual({
      pluginId: "graph",
      version: "1.2.0",
      displayName: "Graph",
    });
    expect(fake.commandCalls[0]).toEqual({
      action: "plugins.install",
      args: { kind: "git", url: "https://example.test/graph.git" },
    });
  });

  it("reports installed plugins without inventing runtime state it cannot see", async () => {
    fake.commandResults.set("plugins.list", {
      plugins: [{
        pluginId: "graph",
        version: "1.2.0",
        enabled: true,
        displayName: "Graph",
        icon: "graph",
        accent: "#7C6FF0",
        source: "git",
        installedAt: "2026-08-11T00:00:00.000Z",
      }],
    });
    mounted = mountAdapter(fake);

    const installed = await listInstalledPlugins();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ pluginId: "graph", displayName: "Graph", enabled: true });
    // A browser peer sees the install registry, never the child process or the
    // manifest on disk. Claiming "running" from `enabled` would put a green dot
    // next to a crashed plugin.
    expect(installed[0].status).toBe("none");
    expect(installed[0].tabs).toEqual([]);
  });

  it("serves a panel read from one snapshot and drops the subscription after it", async () => {
    fake.panelSnapshots.set("graph/main", {
      seq: 1,
      pluginId: "graph",
      panelId: "main",
      panel: {
        pluginId: "graph",
        panelId: "main",
        title: "Issues",
        icon: "graph",
        surface: "work",
        schemaJson: '{"kind":"stack"}',
        vocabVersion: 1,
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
      rows: [],
    });
    mounted = mountAdapter(fake);

    const panel = await readPluginPanel("graph", "main");
    expect(panel).toMatchObject({ pluginId: "graph", panelId: "main", title: "Issues", vocabVersion: 1 });
    // Parsed, not the raw wire string: the vocabulary validator reads an object.
    expect(panel?.schema).toEqual({ kind: "stack" });
    // A one-shot read must not leave a stream open behind it.
    await Promise.resolve();
    expect(fake.pluginUnsubscribeCalls).toEqual([{ pluginId: "graph", panelId: "main" }]);
  });

  it("degrades a malformed panel schema to null instead of blanking the read", async () => {
    fake.panelSnapshots.set("graph/main", {
      seq: 1,
      pluginId: "graph",
      panelId: "main",
      panel: {
        pluginId: "graph",
        panelId: "main",
        title: "Issues",
        icon: "",
        surface: "work",
        schemaJson: "{not json",
        vocabVersion: 1,
        updatedAt: "",
      },
      rows: [],
    });
    mounted = mountAdapter(fake);

    const panel = await readPluginPanel("graph", "main");
    expect(panel?.schema).toBeNull();
    expect(panel?.updatedAt).toBeNull();
  });
});
