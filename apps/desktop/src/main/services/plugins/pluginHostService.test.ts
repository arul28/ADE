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
