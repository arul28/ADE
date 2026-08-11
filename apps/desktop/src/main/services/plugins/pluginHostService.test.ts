import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { PluginSdkError } from "../../../shared/plugins/sdk";
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

async function hostWithFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-host-"));
  scratchDirs.push(dir);
  const pluginsRoot = path.join(dir, "plugins");
  const host = getSharedPluginHostService({ logger: testLogger(), pluginsRoot });
  const plugins = host.domainService(null);
  await plugins.install({ source: fixtureRoot });
  return { plugins, pluginsRoot };
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
});
