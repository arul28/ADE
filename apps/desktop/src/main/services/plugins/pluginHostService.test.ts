import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import {
  PluginSdkError,
  type PluginHostFrame,
  type PluginRuntimeStatus,
} from "../../../shared/plugins/sdk";
import { openKvDb, type AdeDb } from "../state/kvDb";
import type { createPluginChildSupervisor, PluginChildSupervisor } from "./pluginChildSupervisor";
import { createPluginDataStore, type PluginDataStore } from "./pluginDataStore";
import { disposeSharedPluginHostService, getSharedPluginHostService } from "./pluginHostService";

/**
 * `plugin.setConfig` — the settings writer.
 *
 * Driven through the real `hello-plugin` fixture rather than a stub manifest,
 * because the whole contract is "does this key exist in the manifest, and what
 * does the plugin read back afterwards".
 */

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/hello-plugin",
);

const scratchDirs: string[] = [];

function testLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

/**
 * A supervisor that records instead of spawning.
 *
 * The host starts every enabled plugin now, so a test that installs a fixture
 * would otherwise fork a real node child per case. Recording the calls is also
 * what lets the start/stop tests below assert on what the host ASKED for.
 */
type RecordedSupervisor = PluginChildSupervisor & {
  starts: number;
  disposals: number;
  sent: PluginHostFrame[];
};

function recordingSupervisors() {
  const built: RecordedSupervisor[] = [];
  const create = ((supervisorArgs: Parameters<typeof createPluginChildSupervisor>[0]) => {
    let status: PluginRuntimeStatus = "idle";
    const supervisor: RecordedSupervisor = {
      pluginId: supervisorArgs.pluginId,
      starts: 0,
      disposals: 0,
      sent: [],
      status: () => status,
      restartCount: () => 0,
      lastCrashAt: () => null,
      pid: () => 4_242,
      start: async () => {
        supervisor.starts += 1;
        status = "running";
      },
      invoke: async () => null,
      send: (frame) => {
        supervisor.sent.push(frame);
        return true;
      },
      logs: () => [],
      dispose: async () => {
        supervisor.disposals += 1;
        status = "stopped";
      },
    };
    built.push(supervisor);
    return supervisor;
  }) as typeof createPluginChildSupervisor;
  return {
    built,
    create,
    /** The live supervisor for a plugin: `built` keeps the replaced ones too. */
    latest: (pluginId: string) => [...built].reverse().find((entry) => entry.pluginId === pluginId) ?? null,
  };
}

async function hostWithFixture(options: { source?: string; attachProject?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-host-"));
  scratchDirs.push(dir);
  const pluginsRoot = path.join(dir, "plugins");
  const supervisors = recordingSupervisors();
  const host = getSharedPluginHostService({
    logger: testLogger(),
    pluginsRoot,
    createSupervisor: supervisors.create,
  });
  const plugins = host.domainService(null);
  let store: PluginDataStore | null = null;
  if (options.attachProject !== false) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-project-"));
    scratchDirs.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    host.attachProject({ projectId: "project-1", projectRoot, db, invokeAdeAction: async () => null });
    store = createPluginDataStore({ db });
  }
  await plugins.install({ source: options.source ?? fixtureRoot });
  return { plugins, pluginsRoot, host, supervisors, store };
}

/** Databases every describe block below closes in its own `afterEach`. */
const openDatabases: AdeDb[] = [];

async function closeScratch(): Promise<void> {
  await disposeSharedPluginHostService();
  while (openDatabases.length) openDatabases.pop()?.close();
  while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
}

function storedConfig(pluginsRoot: string): Record<string, unknown> {
  const decoded = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "config.json"), "utf8")) as {
    config?: Record<string, unknown>;
  };
  return decoded.config ?? {};
}

describe("plugin.setConfig", () => {
  afterEach(closeScratch);

  it("stores a declared setting and reads it back over the manifest default", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    const before = await plugins.get({ pluginId: "hello-plugin" });
    expect(before?.config.greeting).toBe("Hello");

    const detail = await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: "Hei" } });

    expect(detail.config.greeting).toBe("Hei");
    expect(storedConfig(pluginsRoot)).toEqual({ "hello-plugin": { greeting: "Hei" } });
    expect((await plugins.get({ pluginId: "hello-plugin" }))?.config.greeting).toBe("Hei");
  });

  it("refuses a key the manifest never declared instead of storing it", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    // A typo that persisted would read back as a setting the plugin never sees,
    // which from inside the plugin is indistinguishable from a broken host.
    const rejected = await plugins
      .setConfig({ pluginId: "hello-plugin", values: { greetign: "Hei" } })
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(PluginSdkError);
    expect((rejected as PluginSdkError).code).toBe("invalid_args");
    expect(fs.existsSync(path.join(pluginsRoot, "config.json"))).toBe(false);
  });

  it("treats null as a reset, restoring the manifest default rather than storing null", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: "Hei" } });
    const detail = await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: null } });

    // Stored null would shadow the default with nothing, so the override is
    // removed instead — the plugin reads its declared default again.
    expect(detail.config.greeting).toBe("Hello");
    expect(storedConfig(pluginsRoot)).toEqual({ "hello-plugin": {} });
  });

  it("leaves settings this call did not name alone", async () => {
    const { plugins } = await hostWithFixture();

    await plugins.setConfig({ pluginId: "hello-plugin", values: { greeting: "Hei" } });
    const detail = await plugins.setConfig({ pluginId: "hello-plugin", values: {} });

    expect(detail.config.greeting).toBe("Hei");
  });

  it("refuses to configure a plugin that is not installed", async () => {
    const { plugins } = await hostWithFixture();

    const rejected = await plugins
      .setConfig({ pluginId: "not-installed", values: {} })
      .catch((error: unknown) => error);

    expect((rejected as PluginSdkError).code).toBe("plugin_not_found");
  });
});

describe("plugin contributions, readme and source inspection", () => {
  afterEach(closeScratch);

  it("persists a disabled contribution as an OFF list that survives a reload", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    const before = await plugins.list({});
    // On by default: an empty list has to mean "everything this plugin
    // declares is live", or a plugin installed before the field existed would
    // read as fully switched off.
    expect(before[0]?.disabledContributions).toEqual([]);

    const summary = await plugins.setContributionEnabled({
      pluginId: "hello-plugin",
      socketId: "greeting",
      enabled: false,
    });
    expect(summary.disabledContributions).toEqual(["greeting"]);

    // Persisted in the machine install registry, not held in memory.
    const state = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "state.json"), "utf8")) as {
      plugins: Record<string, { disabledContributions?: string[] }>;
    };
    expect(state.plugins["hello-plugin"]?.disabledContributions).toEqual(["greeting"]);
    expect((await plugins.list({}))[0]?.disabledContributions).toEqual(["greeting"]);

    const reenabled = await plugins.setContributionEnabled({
      pluginId: "hello-plugin",
      socketId: "greeting",
      enabled: true,
    });
    expect(reenabled.disabledContributions).toEqual([]);
  });

  it("keeps a switched-off contribution switched off across a reinstall", async () => {
    const { plugins } = await hostWithFixture();

    await plugins.setContributionEnabled({
      pluginId: "hello-plugin",
      socketId: "greeting",
      enabled: false,
    });

    // An upgrade replaces the code, not the user's settings: a badge they
    // turned off coming back on would be indistinguishable from ADE ignoring
    // the switch.
    const reinstalled = await plugins.install({ source: fixtureRoot });
    expect(reinstalled.disabledContributions).toEqual(["greeting"]);
    expect((await plugins.list({}))[0]?.disabledContributions).toEqual(["greeting"]);
  });

  it("reads an installed plugin's readme and answers null when it ships none", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    expect(await plugins.getReadme({ pluginId: "hello-plugin" })).toBeNull();

    fs.writeFileSync(path.join(pluginsRoot, "hello-plugin", "README.md"), "# Hello\n", "utf8");
    expect(await plugins.getReadme({ pluginId: "hello-plugin" })).toBe("# Hello\n");
    expect(await plugins.getReadme({ pluginId: "not-installed" })).toBeNull();
  });

  it("inspects a local source without installing it, and never fetches a remote one", async () => {
    const { plugins, pluginsRoot } = await hostWithFixture();

    const local = await plugins.inspectSource({ source: fixtureRoot });
    expect(local?.manifest?.name).toBe("hello-plugin");

    // A URL is reported as itself with no manifest: reading a source must never
    // be the step that puts code on the machine.
    const remote = await plugins.inspectSource({ source: "https://example.test/graph.git" });
    expect(remote).toEqual({ source: "https://example.test/graph.git", manifest: null });
    expect(fs.readdirSync(pluginsRoot).sort()).toEqual(["hello-plugin", "state.json"]);
  });

  it("reports no presence rows when no project database is attached", async () => {
    const { plugins } = await hostWithFixture();

    // Empty reads as "this machine only" rather than as an error — the rows
    // live in a project database this host has not been given.
    expect(await plugins.presence()).toEqual([]);
  });

  it("reads a plugin's manifest and its log ring, without inventing either", async () => {
    const { plugins } = await hostWithFixture();

    expect((await plugins.getManifest({ pluginId: "hello-plugin" }))?.name).toBe("hello-plugin");
    expect(await plugins.getManifest({ pluginId: "not-installed" })).toBeNull();
    // A plugin that has never started has no lines rather than an error.
    expect(await plugins.openLogs({ pluginId: "hello-plugin" })).toEqual([]);
  });

  it("refuses logs for a plugin that is not installed", async () => {
    const { plugins } = await hostWithFixture();

    const rejected = await plugins.openLogs({ pluginId: "not-installed" }).catch((error: unknown) => error);
    expect((rejected as PluginSdkError).code).toBe("plugin_not_found");
  });
});

/**
 * Starting and materializing — what makes an installed plugin visible at all.
 *
 * Nothing but an explicit `invoke` used to start a plugin or write a panel row,
 * so a freshly installed plugin sat idle behind empty surfaces until someone
 * happened to call one of its actions. These pin both halves: enabled plugins
 * start, and a panel a manifest DECLARES exists without the plugin running —
 * which is the only way a plugin that ships no code can render.
 */
describe("plugin start and panel materialization", () => {
  afterEach(closeScratch);

  /** A plugin with a declared panel and no `entry` — a theme, or a static tab. */
  function codelessPluginDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-codeless-"));
    scratchDirs.push(dir);
    const root = path.join(dir, "quiet-plugin");
    fs.mkdirSync(path.join(root, "panels"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "plugin.json"),
      JSON.stringify({
        name: "quiet-plugin",
        version: "1.0.0",
        displayName: "Quiet",
        description: "Ships a panel and no code at all.",
        vocabVersion: 1,
        surfaces: [{ kind: "tab", id: "quiet", title: "Quiet", panelId: "main" }],
        panels: [{ id: "main", schemaFile: "panels/main.json", title: "Quiet" }],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "panels", "main.json"),
      JSON.stringify({
        v: 1,
        title: "Quiet",
        fallback: { title: "Quiet", text: "Open ADE to see this." },
        body: [{ component: "text", text: "Declared, never published." }],
      }),
      "utf8",
    );
    return root;
  }

  it("starts an enabled plugin as soon as it is installed", async () => {
    const { supervisors } = await hostWithFixture();

    // No invoke anywhere in this test: installing is enough.
    expect(supervisors.latest("hello-plugin")?.starts).toBe(1);
    expect(supervisors.latest("hello-plugin")?.status()).toBe("running");
  });

  it("starts enabled plugins when a project binds, and stops one that is disabled", async () => {
    const { plugins, host, supervisors } = await hostWithFixture();

    await plugins.disable({ pluginId: "hello-plugin" });
    expect(supervisors.latest("hello-plugin")?.disposals).toBe(1);

    await plugins.enable({ pluginId: "hello-plugin" });
    const running = supervisors.latest("hello-plugin");
    expect(running?.starts).toBe(1);

    // A second project binding re-runs the pass without restarting anything.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-project-2-"));
    scratchDirs.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    host.attachProject({ projectId: "project-2", projectRoot, db, invokeAdeAction: async () => null });
    expect(supervisors.latest("hello-plugin")).toBe(running);
    expect(running?.starts).toBe(2);
  });

  it("materializes a declared panel from the manifest, with nothing invoked", async () => {
    const { store } = await hostWithFixture();

    const panel = store!.readPanel("hello-plugin", "main");
    expect(panel?.title).toBe("Hello");
    expect(panel?.schema).toMatchObject({ v: 1, title: "Hello" });
  });

  it("renders a plugin that ships no code, and never builds a supervisor for it", async () => {
    const { plugins, store, supervisors } = await hostWithFixture({ source: codelessPluginDir() });

    const summary = (await plugins.list({})).find((entry) => entry.pluginId === "quiet-plugin");
    expect(summary?.hasEntry).toBe(false);
    expect(summary?.status).toBe("no-entry");
    // The panel is the whole plugin, and it is there.
    expect(store!.readPanel("quiet-plugin", "main")?.schema).toMatchObject({ title: "Quiet" });
    expect(supervisors.built.some((entry) => entry.pluginId === "quiet-plugin")).toBe(false);
  });

  it("leaves a panel the plugin published alone until the code changes", async () => {
    const { plugins, store, pluginsRoot } = await hostWithFixture();

    // What a running plugin publishes outranks its shipped default.
    store!.updatePanel("hello-plugin", "main", { schema: { v: 1, title: "Live" }, vocabVersion: 1 });
    await plugins.enable({ pluginId: "hello-plugin" });
    expect(store!.readPanel("hello-plugin", "main")?.schema).toMatchObject({ title: "Live" });

    // A reload is the `ade plugin dev` loop: the file on disk is now newer than
    // anything the last run published, so it replaces it.
    fs.writeFileSync(
      path.join(pluginsRoot, "hello-plugin", "panels", "main.json"),
      JSON.stringify({ v: 1, title: "Edited", fallback: { title: "Edited", text: "x" }, body: [] }),
      "utf8",
    );
    await plugins.reload({ pluginId: "hello-plugin" });
    expect(store!.readPanel("hello-plugin", "main")?.schema).toMatchObject({ title: "Edited" });
  });

  it("stops the running child before an install replaces its directory", async () => {
    const { plugins, supervisors } = await hostWithFixture();
    const first = supervisors.latest("hello-plugin")!;
    expect(first.disposals).toBe(0);

    await plugins.install({ source: fixtureRoot });

    // The old child is gone rather than left running against a directory that
    // was renamed out from under it, and a fresh one took its place.
    expect(first.disposals).toBe(1);
    const second = supervisors.latest("hello-plugin")!;
    expect(second).not.toBe(first);
    expect(second.starts).toBe(1);
  });

  it("tells running plugins that the install set moved", async () => {
    vi.useFakeTimers();
    try {
      const { plugins, supervisors } = await hostWithFixture();
      const running = supervisors.latest("hello-plugin")!;
      running.sent.length = 0;

      await plugins.disable({ pluginId: "hello-plugin" });
      await plugins.enable({ pluginId: "hello-plugin" });
      vi.runOnlyPendingTimers();

      // `sdk.events.on("install.changed")` is documented, and this is the frame
      // that makes it fire: before it, no host ever sent an event frame.
      const live = supervisors.latest("hello-plugin")!;
      expect(live.sent).toContainEqual({
        type: "event",
        payload: { event: "install.changed", ids: ["hello-plugin"], projectId: "project-1" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `listContributions` — the dynamic half of the socket taxonomy.
 *
 * The fixture declares one socket: a `row-badge` on `lanes`, id `greeting`.
 * Everything here turns on the manifest join, because the table stores a socket
 * KIND and only the manifest says which surface it belongs to.
 */
describe("plugin.listContributions", () => {
  afterEach(closeScratch);

  async function hostWithProject() {
    const { plugins, pluginsRoot, store } = await hostWithFixture();
    return { plugins, pluginsRoot, store: store! };
  }

  it("returns only the sockets the manifest declares for the surface asked for", async () => {
    const { plugins, store } = await hostWithProject();

    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "3 refs", tone: "accent" });

    const lanes = await plugins.listContributions({ surface: "lanes" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({
      pluginId: "hello-plugin",
      entityKind: "lane",
      entityId: "lane-1",
      socket: "row-badge",
      surface: "lanes",
      // The manifest socket id, which the row itself does not carry — it is
      // what per-socket toggles and ordering key on.
      socketId: "greeting",
      payload: { text: "3 refs", tone: "accent" },
    });

    // The same row is not a PRs contribution: this plugin declares no PR socket.
    expect(await plugins.listContributions({ surface: "prs" })).toEqual([]);
  });

  it("drops rows whose socket the user switched off, and restores them when re-enabled", async () => {
    const { plugins, store } = await hostWithProject();
    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "ok", tone: "success" });

    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "greeting", enabled: false });
    expect(await plugins.listContributions({ surface: "lanes" })).toEqual([]);

    await plugins.setContributionEnabled({ pluginId: "hello-plugin", socketId: "greeting", enabled: true });
    expect(await plugins.listContributions({ surface: "lanes" })).toHaveLength(1);
  });

  it("drops rows from a disabled plugin and narrows by entity kind", async () => {
    const { plugins, store } = await hostWithProject();
    store.publishContribution("hello-plugin", "lane", "lane-1", "row-badge", { text: "ok", tone: "success" });

    expect(await plugins.listContributions({ surface: "lanes", entityKind: "pr" })).toEqual([]);
    expect(await plugins.listContributions({ surface: "lanes", entityKind: "lane" })).toHaveLength(1);

    await plugins.disable({ pluginId: "hello-plugin" });
    // A disabled plugin contributes nothing, without anything having to delete
    // its rows — they come back untouched when it is enabled again.
    expect(await plugins.listContributions({ surface: "lanes" })).toEqual([]);
  });
});
