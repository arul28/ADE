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
  readPluginCollection,
  readPluginPanel,
  readPluginPresence,
  pluginsAvailable,
  subscribeToPluginChanges,
} from "../../../lib/pluginRuntimeBridge";
import { pluginTabsAvailable } from "../../../lib/webClientMode";
import { createAdeWebAdapter } from "../index";

const project: ProjectInfo = { rootPath: "/repo", displayName: "Repo", baseRef: "main" };

const ALL_PLUGIN_ACTIONS = [
  "plugins.list",
  "plugins.install",
  "plugins.uninstall",
  "plugins.enable",
  "plugins.disable",
  "plugins.presenceMatrix",
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
      // Both true only because `plugins.presenceMatrix` exists AND the host
      // forwards a `machineKey`. Reporting `remoteInstall` without the
      // forwarding would offer a button that always acted on the wrong machine.
      machines: true,
      remoteInstall: true,
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

  it("forwards a machine-scoped toggle instead of acting on this machine", async () => {
    mounted = mountAdapter(fake);

    await setPluginEnabled("graph", true, "machine-b");

    // The host routes it and refuses loudly if it cannot; what must never
    // happen is this machine's plugin toggling because the reader clicked
    // another machine's row.
    expect(fake.commandCalls[0]).toEqual({
      action: "plugins.enable",
      args: { pluginId: "graph", machineKey: "machine-b" },
    });
  });

  it("reports the account-wide coverage matrix, offline machines included", async () => {
    fake.commandResults.set("plugins.presenceMatrix", {
      machines: [
        {
          machineKey: "machine-a",
          machineName: "Studio",
          pluginId: "graph",
          version: "1.2.0",
          enabled: true,
          online: true,
          isThisMachine: true,
        },
        {
          machineKey: "machine-b",
          machineName: "Laptop",
          pluginId: "graph",
          version: null,
          enabled: false,
          online: false,
          isThisMachine: false,
        },
      ],
    });
    mounted = mountAdapter(fake);

    const rows = await readPluginPresence();
    expect(rows).toHaveLength(2);
    // A sleeping machine still reports its installs — dropping it would read as
    // "the plugin is not installed there" when it is.
    expect(rows[1]).toMatchObject({ machineKey: "machine-b", online: false, isThisMachine: false });
    expect(rows[0].isThisMachine).toBe(true);
  });

  it("hides the machines view when the host serves no matrix", () => {
    fake.descriptors = descriptors(["plugins.list", "plugins.install"]);
    mounted = mountAdapter(fake);

    const capabilities = pluginMarketplaceCapabilities();
    expect(capabilities.machines).toBe(false);
    // Remote install rides presence; without the matrix there is no machine to
    // name, so offering it would be offering a dead control.
    expect(capabilities.remoteInstall).toBe(false);
  });

  it("carries the machine key on a remote install", async () => {
    fake.commandResults.set("plugins.install", {
      pluginId: "graph",
      version: "1.2.0",
      enabled: true,
      displayName: "Graph",
      icon: "",
      accent: "",
      source: "git",
      installedAt: "2026-08-11T00:00:00.000Z",
    });
    mounted = mountAdapter(fake);

    await installPlugin({ source: "https://example.test/graph.git", machineKey: "machine-b" });

    expect(fake.commandCalls[0].args).toEqual({
      kind: "git",
      url: "https://example.test/graph.git",
      machineKey: "machine-b",
    });
  });

  it("installs a bundled plugin by id, not as a repository URL", async () => {
    fake.commandResults.set("plugins.install", {
      pluginId: "ade-theme-ink",
      version: "1.0.0",
      enabled: true,
      displayName: "Ink",
      icon: "",
      accent: "",
      source: "builtin",
      installedAt: "2026-08-11T00:00:00.000Z",
    });
    mounted = mountAdapter(fake);

    await installPlugin({ source: "ade-theme-ink", version: "1.0.0" });

    // The plugins ADE bundles have no repository to clone from — the honest
    // source is the copy on the machine performing the install, and only that
    // machine can resolve an id to it. Sent as a git URL this would fail with
    // "unsupported git URL" where it should say "that computer does not have
    // this plugin". `version` rides the registry field, not `ref`: the host
    // resolves a version against the directory before it has a ref at all.
    expect(fake.commandCalls[0]).toEqual({
      action: "plugins.install",
      args: { kind: "registry", pluginId: "ade-theme-ink", version: "1.0.0" },
    });
  });

  it("renders manifest detail when the host sends it, and stays honest when it does not", async () => {
    fake.commandResults.set("plugins.list", {
      plugins: [
        {
          pluginId: "graph",
          version: "1.2.0",
          enabled: true,
          displayName: "Graph",
          icon: "graph",
          accent: "#7C6FF0",
          source: "git",
          installedAt: "2026-08-11T00:00:00.000Z",
          status: "running",
          tabs: [{ id: "graph", title: "Graph", panelId: "main" }],
        },
        {
          pluginId: "quiet",
          version: "0.1.0",
          enabled: true,
          displayName: "Quiet",
          icon: "",
          accent: "",
          source: "git",
          installedAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    });
    mounted = mountAdapter(fake);

    const installed = await listInstalledPlugins();
    expect(installed[0]).toMatchObject({ status: "running" });
    expect(installed[0].tabs).toEqual([{ id: "graph", title: "Graph", panelId: "main" }]);
    // The fields are optional by contract: a host that omits them means
    // "unknown", and the reader must not invent a runtime state for it.
    expect(installed[1].status).toBe("none");
    expect(installed[1].tabs).toEqual([]);
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

  it("serves a collection read from the panel snapshot the reader just took", async () => {
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
        schemaJson: '{"kind":"table","data":{"collection":"issues"}}',
        vocabVersion: 1,
        updatedAt: "",
      },
      rows: [
        { collection: "issues", key: "ade/1", valueJson: '{"title":"First"}', updatedAt: "" },
        { collection: "issues", key: "ade/2", valueJson: '{"title":"Second"}', updatedAt: "" },
        { collection: "notes", key: "n1", valueJson: '"other"', updatedAt: "" },
      ],
    });
    mounted = mountAdapter(fake);

    await readPluginPanel("graph", "main");
    const rows = await readPluginCollection("graph", "issues");

    // The defect this pins: the collection name was passed as the panel id, so
    // the subscription matched no panel, waited out the 8s read timeout and
    // answered empty on a plugin whose rows were in the snapshot already.
    expect(rows).toEqual([
      { key: "ade/1", value: { title: "First" } },
      { key: "ade/2", value: { title: "Second" } },
    ]);
    expect(fake.pluginSubscribeCalls).toEqual([{ pluginId: "graph", panelId: "main" }]);
  });

  it("narrows a collection read by key prefix and limit without asking the host again", async () => {
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
        schemaJson: '{"kind":"table","data":{"collection":"issues"}}',
        vocabVersion: 1,
        updatedAt: "",
      },
      rows: [
        { collection: "issues", key: "ade/1", valueJson: "1", updatedAt: "" },
        { collection: "issues", key: "ade/2", valueJson: "2", updatedAt: "" },
        { collection: "issues", key: "other/1", valueJson: "3", updatedAt: "" },
      ],
    });
    mounted = mountAdapter(fake);

    await readPluginPanel("graph", "main");
    expect(await readPluginCollection("graph", "issues", { keyPrefix: "ade/", limit: 1 }))
      .toEqual([{ key: "ade/1", value: 1 }]);
    expect(fake.pluginSubscribeCalls).toHaveLength(1);
  });

  it("answers a collection read with no panel behind it empty rather than stalling", async () => {
    mounted = mountAdapter(fake);

    expect(await readPluginCollection("graph", "issues")).toEqual([]);
    // The panel stream is the only source of rows and it is keyed by panel, so
    // there is nothing to subscribe to here — subscribing to a panel named
    // after the collection is exactly the bug this replaced.
    expect(fake.pluginSubscribeCalls).toEqual([]);
  });

  it("offers plugin tabs only while the host serves the plugin reads behind them", async () => {
    mounted = mountAdapter(fake);
    (globalThis as unknown as { window: { __adeWebClient?: boolean } }).window.__adeWebClient = true;

    // On web every member "exists" under the fallback proxy, so the desktop's
    // `typeof getPanel === "function"` probe proves nothing; only this marker,
    // set deliberately by the adapter, may turn the tabs on.
    expect(pluginTabsAvailable()).toBe(true);

    fake.descriptors = [];
    expect(pluginTabsAvailable()).toBe(false);
  });

  it("refuses a read on a host with no plugin support instead of reporting none installed", async () => {
    fake.descriptors = [];
    mounted = mountAdapter(fake);
    const plugins = (globalThis as unknown as {
      window: { ade: { plugins: { list?: () => Promise<unknown>; presence?: () => Promise<unknown> } } };
    }).window.ade.plugins;

    // The members are hidden entirely on a host that serves neither, which is
    // what the capability probe reads. The typed refusal below is the second
    // line: between a host handoff and the next descriptor refresh the call can
    // still be made, and "[]" would render as "you have no plugins installed"
    // on a computer that cannot have any.
    expect(plugins.list).toBeUndefined();
    expect(plugins.presence).toBeUndefined();

    fake.descriptors = descriptors(ALL_PLUGIN_ACTIONS);
    const list = plugins.list;
    fake.commandErrors.set("plugins.list", Object.assign(new Error("Plugins are not available on this computer."), {
      code: "plugins_unavailable",
    }));
    await expect(list?.()).rejects.toThrow(/not available on this computer/);
  });

  it("tells its own subscribers about an install it just made", async () => {
    fake.commandResults.set("plugins.install", {
      pluginId: "graph",
      version: "1.2.0",
      enabled: true,
      displayName: "Graph",
      icon: "",
      accent: "",
      source: "git",
      installedAt: "2026-08-11T00:00:00.000Z",
    });
    mounted = mountAdapter(fake);
    const seen: string[] = [];
    const stop = subscribeToPluginChanges((event) => seen.push(event.kind));

    await installPlugin({ source: "https://example.test/graph.git" });

    // The host's own invalidation arrives when the plugin tables replicate —
    // after this resolves, and never at all when the install landed on another
    // machine. Without this the coverage rail sits on its cached read.
    expect(seen).toEqual(["installs"]);
    stop();
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
