import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { PluginSdkError } from "../../../shared/plugins/sdk";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createPluginDataStore } from "./pluginDataStore";
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

async function hostWithFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-host-"));
  scratchDirs.push(dir);
  const pluginsRoot = path.join(dir, "plugins");
  const host = getSharedPluginHostService({ logger: testLogger(), pluginsRoot });
  const plugins = host.domainService(null);
  await plugins.install({ source: fixtureRoot });
  return { plugins, pluginsRoot, host };
}

function storedConfig(pluginsRoot: string): Record<string, unknown> {
  const decoded = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "config.json"), "utf8")) as {
    config?: Record<string, unknown>;
  };
  return decoded.config ?? {};
}

describe("plugin.setConfig", () => {
  afterEach(async () => {
    await disposeSharedPluginHostService();
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

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
  afterEach(async () => {
    await disposeSharedPluginHostService();
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

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
 * `listContributions` — the dynamic half of the socket taxonomy.
 *
 * The fixture declares one socket: a `row-badge` on `lanes`, id `greeting`.
 * Everything here turns on the manifest join, because the table stores a socket
 * KIND and only the manifest says which surface it belongs to.
 */
describe("plugin.listContributions", () => {
  const openDatabases: AdeDb[] = [];

  afterEach(async () => {
    await disposeSharedPluginHostService();
    while (openDatabases.length) openDatabases.pop()?.close();
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  async function hostWithProject() {
    const { plugins, pluginsRoot, host } = await hostWithFixture();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-project-"));
    scratchDirs.push(projectRoot);
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    host.attachProject({
      projectId: "project-1",
      projectRoot,
      db,
      invokeAdeAction: async () => null,
    });
    const store = createPluginDataStore({ db });
    return { plugins, pluginsRoot, store };
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
