import { describe, expect, it, vi } from "vitest";

import type { PluginManifest } from "../../../shared/plugins/manifest";
import { createPluginInstallServiceAdapter, toPluginPresenceRow } from "./pluginInstallServiceAdapter";
import type { PluginInstalledPlugin, PluginInstallService } from "./pluginInstallService";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "graph",
    version: "1.2.0",
    displayName: "Graph",
    description: "",
    icon: "network",
    accent: "#5b8def",
    vocabVersion: 1,
    surfaces: [],
    panels: [],
    sockets: [],
    collections: {},
    settings: [],
    cli: [],
    skills: [],
    tools: [],
    automationTriggers: [],
    automationSteps: [],
    searchProviders: [],
    keybindings: [],
    official: false,
    ...overrides,
  };
}

function installed(overrides: Partial<PluginInstalledPlugin> = {}): PluginInstalledPlugin {
  return {
    record: {
      pluginId: "graph",
      version: "1.2.0",
      enabled: true,
      source: { kind: "git", url: "https://example.com/graph.git", ref: "main" },
      installedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    manifest: manifest(),
    root: "/plugins/graph",
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function stubInstallService(overrides: Partial<PluginInstallService> = {}): {
  service: PluginInstallService;
  calls: { source: string; ref?: string }[];
} {
  const calls: { source: string; ref?: string }[] = [];
  const service: PluginInstallService = {
    root: "/plugins",
    list: () => [installed()],
    get: () => installed(),
    install: async (args) => {
      calls.push({ source: args.source, ...(args.ref ? { ref: args.ref } : {}) });
      return installed();
    },
    uninstall: () => ({ removed: true }),
    setEnabled: (_pluginId, enabled) => installed({
      record: { ...installed().record, enabled },
    }),
    setContributionEnabled: (_pluginId, socketId, enabled) => installed({
      record: { ...installed().record, disabledContributions: enabled ? [] : [socketId] },
    }),
    reload: () => installed(),
    skillRoots: () => [],
    // Ships nothing by default: the machine most installs land on carries no
    // bundled copy of the plugin being asked for.
    bundledPackageVersion: () => null,
    ...overrides,
  };
  return { service, calls };
}

describe("pluginInstallServiceAdapter", () => {
  it("maps a path source to this machine's single-string install argument", async () => {
    const { service, calls } = stubInstallService();
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const record = await adapter.install({ kind: "path", path: "/tmp/graph" });

    expect(calls).toEqual([{ source: "/tmp/graph" }]);
    expect(record).toMatchObject({ pluginId: "graph", version: "1.2.0", displayName: "Graph", icon: "network" });
  });

  it("carries a git ref through and renders the source for a peer", async () => {
    const { service, calls } = stubInstallService();
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const record = await adapter.install({ kind: "git", url: "https://example.com/graph.git", ref: "v2" });

    expect(calls).toEqual([{ source: "https://example.com/graph.git", ref: "v2" }]);
    // The record's source is the INSTALLED one, not the request: a peer renders
    // what this machine actually has.
    expect(record.source).toBe("https://example.com/graph.git#main");
  });

  it("refuses a registry install it cannot resolve rather than guessing a source", async () => {
    const { service, calls } = stubInstallService();
    // No resolver at all, and a resolver that does not know the id, are the
    // same answer: a guessed URL is an arbitrary repository running as this
    // plugin, and a record for an install that never ran is indistinguishable
    // from success on the machine that asked.
    const withoutResolver = createPluginInstallServiceAdapter({ install: service });
    await expect(withoutResolver.install({ kind: "registry", pluginId: "graph" }))
      .rejects.toThrow(/plugin directory/i);

    const withEmptyResolver = createPluginInstallServiceAdapter({
      install: service,
      resolveRegistrySource: async () => null,
    });
    await expect(withEmptyResolver.install({ kind: "registry", pluginId: "graph" }))
      .rejects.toThrow(/plugin directory/i);
    expect(calls).toHaveLength(0);
  });

  it("installs a bundled package from this disk instead of asking the directory", async () => {
    const { service, calls } = stubInstallService({ bundledPackageVersion: () => "1.0.0" });
    const resolveRegistrySource = vi.fn(async () => ({ source: "https://example.com/x.git" }));
    const adapter = createPluginInstallServiceAdapter({ install: service, resolveRegistrySource });

    // The starter themes ship inside ADE and are deliberately not seeded, so an
    // id is all a phone or the web client can send — and the directory does not
    // list them, which used to make them uninstallable from anywhere but the
    // machine's own desktop.
    const record = await adapter.install({ kind: "registry", pluginId: "ade-theme-ink" });

    expect(calls).toEqual([{ source: "ade-theme-ink" }]);
    expect(resolveRegistrySource).not.toHaveBeenCalled();
    expect(record).toMatchObject({ pluginId: "graph" });
  });

  it("asks the directory when a version other than the bundled one is wanted", async () => {
    const { service, calls } = stubInstallService({ bundledPackageVersion: () => "1.0.0" });
    const withoutResolver = createPluginInstallServiceAdapter({ install: service });

    // The bundled copy is not the version asked for, so the bundle cannot
    // answer — and the refusal says which version this computer does ship
    // rather than claiming the plugin is unknown.
    await expect(withoutResolver.install({ kind: "registry", pluginId: "graph", version: "2.0.0" }))
      .rejects.toThrow(/ships "graph" 1\.0\.0/);
    expect(calls).toHaveLength(0);
  });

  it("installs a registry id from the source the directory resolved for it", async () => {
    const { service, calls } = stubInstallService();
    const adapter = createPluginInstallServiceAdapter({
      install: service,
      resolveRegistrySource: async (pluginId, version) => ({
        source: `https://example.com/${pluginId}.git`,
        ref: version,
      }),
    });

    const record = await adapter.install({ kind: "registry", pluginId: "graph", version: "v2" });

    expect(calls).toEqual([{ source: "https://example.com/graph.git", ref: "v2" }]);
    expect(record).toMatchObject({ pluginId: "graph" });
  });

  it("fires onChanged for every install-state change but not for a read", async () => {
    const { service } = stubInstallService();
    let changes = 0;
    const adapter = createPluginInstallServiceAdapter({ install: service, onChanged: () => { changes += 1; } });

    await adapter.install({ kind: "path", path: "/tmp/graph" });
    await adapter.uninstall("graph");
    await adapter.setEnabled("graph", false);
    expect(changes).toBe(3);

    await adapter.list();
    expect(changes).toBe(3);
  });

  it("runs afterChange with the pluginId and kind for every verb, before onChanged (R2)", async () => {
    // A remote install/enable/disable/uninstall used to touch only the
    // install registry — nothing stopped the old child, no codeless plugin's
    // panels were seeded, and an uninstall left the child running with its
    // data and secrets intact. `afterChange` is what the host wires to run
    // the same lifecycle a local action goes through.
    const { service } = stubInstallService();
    const calls: Array<{ pluginId: string; kind: string }> = [];
    const order: string[] = [];
    const adapter = createPluginInstallServiceAdapter({
      install: service,
      afterChange: (pluginId, kind) => {
        calls.push({ pluginId, kind });
        order.push("afterChange");
      },
      onChanged: () => {
        order.push("onChanged");
      },
    });

    await adapter.install({ kind: "path", path: "/tmp/graph" });
    await adapter.uninstall("graph");
    await adapter.setEnabled("graph", false);
    await adapter.setEnabled("graph", true);

    expect(calls).toEqual([
      { pluginId: "graph", kind: "install" },
      { pluginId: "graph", kind: "uninstall" },
      { pluginId: "graph", kind: "disable" },
      { pluginId: "graph", kind: "enable" },
    ]);
    // afterChange completes (stop/reconcile/cleanup) before presence — which
    // reports the state that just changed — is republished.
    expect(order).toEqual(["afterChange", "onChanged", "afterChange", "onChanged", "afterChange", "onChanged", "afterChange", "onChanged"]);
  });

  it("waits for afterChange before resolving, so a caller cannot observe the change before its lifecycle ran", async () => {
    const { service } = stubInstallService();
    let resolveAfterChange: (() => void) | null = null;
    let settled = false;
    const adapter = createPluginInstallServiceAdapter({
      install: service,
      afterChange: () => new Promise<void>((resolve) => {
        resolveAfterChange = resolve;
      }),
    });

    const installPromise = adapter.install({ kind: "path", path: "/tmp/graph" }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAfterChange!();
    await installPromise;
    expect(settled).toBe(true);
  });

  it("falls back to the registry record when the manifest cannot be read", () => {
    const row = toPluginPresenceRow(installed({ manifest: null }));

    expect(row).toEqual({
      pluginId: "graph",
      version: "1.2.0",
      enabled: true,
      displayName: "graph",
      icon: "",
      accent: "",
    });
  });
});

describe("record detail for peers", () => {
  it("carries manifest tabs and theme so a peer can render what it cannot read", async () => {
    const { service } = stubInstallService({
      list: () => [installed({
        manifest: manifest({
          surfaces: [
            { kind: "tab", id: "graph", title: "Graph", panelId: "main", icon: "network" },
            { kind: "pane", id: "side", title: "Side", panelId: "side" },
          ],
          theme: { tokens: { dark: { "--color-accent": "#5b8def" } } },
        }),
      })],
    });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    // Panes are not tabs; only tab surfaces become navigable entries.
    expect(record.tabs).toEqual([
      { id: "graph", title: "Graph", panelId: "main", icon: "network" },
    ]);
    expect(record.theme).toEqual({
      displayName: "Graph",
      tokens: { dark: { "--color-accent": "#5b8def" } },
    });
  });

  it("carries manifest sockets whole, so a peer can render what a plugin adds to core surfaces", async () => {
    const { service } = stubInstallService({
      list: () => [installed({
        manifest: manifest({
          sockets: [
            { socket: "row-badge", surface: "lanes", id: "risk", label: "Risk", icon: "warning" },
            { socket: "file-viewer", surface: "files", id: "proto", panelId: "proto", extensions: [".proto"] },
          ],
        }),
      })],
    });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    // Whole, not projected to the fields one kind reads: which fields matter is
    // per kind, so a projection is a list that has to grow with every new kind
    // and fails by dropping a label rather than by erroring.
    expect(record.sockets).toEqual([
      { socket: "row-badge", surface: "lanes", id: "risk", label: "Risk", icon: "warning" },
      { socket: "file-viewer", surface: "files", id: "proto", panelId: "proto", extensions: [".proto"] },
    ]);
    // Absent keys rather than explicit undefined: identical in memory, and not
    // identical over JSON, where the second spends bytes on every row saying
    // nothing.
    expect(Object.keys(record.sockets?.[0] ?? {})).toEqual(["socket", "surface", "id", "label", "icon"]);
  });

  it("forwards a socket field it has never heard of, so a new kind reaches peers without an edit here", async () => {
    const { service } = stubInstallService({
      list: () => [installed({
        manifest: manifest({
          sockets: [{
            socket: "slash-command",
            surface: "work",
            id: "fix",
            command: "fix",
            // Fields the parser emits that this adapter never named, plus one
            // that does not exist yet. An enumerated copy dropped all of them
            // silently — the socket arrived on the phone missing its subtitle
            // and nothing anywhere errored.
            description: "Fix the thing",
            argumentHint: "<file>",
            section: "Tools",
            futureField: "reaches peers anyway",
          } as never],
        }),
      })],
    });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    expect(record.sockets?.[0]).toMatchObject({
      description: "Fix the thing",
      argumentHint: "<file>",
      section: "Tools",
      futureField: "reaches peers anyway",
    });
  });

  it("copies the one array field rather than sharing the manifest's own", async () => {
    const extensions = [".proto"];
    const { service } = stubInstallService({
      list: () => [installed({
        manifest: manifest({
          sockets: [{ socket: "file-viewer", surface: "files", id: "proto", panelId: "proto", extensions }],
        }),
      })],
    });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();
    (record.sockets?.[0]?.extensions as string[]).push(".thrift");

    // The source belongs to the install service's cached manifest, so a caller
    // mutating what it was handed would corrupt it for every later reader.
    expect(extensions).toEqual([".proto"]);
  });

  it("sends the per-contribution toggles only when some are off", async () => {
    const withToggle = installed();
    withToggle.record.disabledContributions = ["risk"];
    const { service } = stubInstallService({ list: () => [withToggle] });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    // The socket layer filters STATIC contributions on this client-side, so a
    // peer without it would draw sockets the user already switched off.
    expect(record.disabledContributions).toEqual(["risk"]);

    // Absent already means "none are disabled" — an empty array would be bytes
    // spent restating the default on every plugin on every list.
    const { service: clean } = stubInstallService({ list: () => [installed()] });
    const [plain] = await createPluginInstallServiceAdapter({ install: clean }).list();
    expect(plain).not.toHaveProperty("disabledContributions");
  });

  it("omits sockets entirely when the manifest could not be parsed", async () => {
    const { service } = stubInstallService({ list: () => [installed({ manifest: null })] });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    // Same rule as tabs: an empty array would claim the plugin declares no
    // sockets, when the truth is this host could not read whether it does.
    expect(record).not.toHaveProperty("sockets");
  });

  it("says a plugin is definitively not a theme when the manifest declares none", async () => {
    const { service } = stubInstallService({ list: () => [installed()] });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    expect(record.tabs).toEqual([]);
    expect(record.theme).toBeNull();
  });

  // Absent and empty mean different things here: an unreadable manifest means
  // this host cannot see the answer, and claiming "no tabs, not a theme" would
  // be a statement we have no basis for.
  it("omits tabs and theme entirely when the manifest could not be parsed", async () => {
    const { service } = stubInstallService({ list: () => [installed({ manifest: null })] });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    expect(record).not.toHaveProperty("tabs");
    expect(record).not.toHaveProperty("theme");
  });

  it("reports the supervisor's real status, collapsing only what a reader cannot draw", async () => {
    const { service } = stubInstallService({ list: () => [installed()] });
    const cases = [
      ["running", "running"],
      ["starting", "starting"],
      ["restarting", "starting"],
      ["crashed", "crashed"],
      ["idle", "stopped"],
      ["stopped", "stopped"],
      ["no-entry", "none"],
    ] as const;

    for (const [hostStatus, expected] of cases) {
      const adapter = createPluginInstallServiceAdapter({
        install: service,
        runtimeStatus: () => hostStatus,
      });
      const [record] = await adapter.list();
      expect(record.status).toBe(expected);
    }
  });

  // The guess this exists to prevent: `enabled` is registry state, so an
  // enabled-but-crashed plugin would report "running" and show a green dot.
  it("omits status rather than inferring it from enabled", async () => {
    const { service } = stubInstallService({ list: () => [installed()] });
    const adapter = createPluginInstallServiceAdapter({ install: service });

    const [record] = await adapter.list();

    expect(record.enabled).toBe(true);
    expect(record).not.toHaveProperty("status");
  });
});
