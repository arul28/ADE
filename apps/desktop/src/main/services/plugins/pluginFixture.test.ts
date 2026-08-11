import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { parsePluginPanel } from "../../../shared/plugins/vocabulary";
import { createPluginInstallService, listPluginAgentSkillRoots } from "./pluginInstallService";

/**
 * End-to-end acceptance for the install half of the platform, driven by the
 * `hello-plugin` fixture: a real directory with a real manifest, a real panel
 * schema and a real skills root. The child-process half is covered by
 * `pluginChildSupervisor.test.ts`, which needs the bundled bootstrap.
 */

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/hello-plugin",
);

const scratchDirs: string[] = [];

function scratchPluginsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugins-"));
  scratchDirs.push(dir);
  return path.join(dir, "plugins");
}

function testLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

afterEach(() => {
  while (scratchDirs.length) {
    fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("hello-plugin fixture", () => {
  it("ships a manifest and a panel schema both halves of the contract accept", () => {
    const manifestText = fs.readFileSync(path.join(fixtureRoot, "plugin.json"), "utf8");
    const parsed = JSON.parse(manifestText) as Record<string, unknown>;
    expect(parsed.name).toBe("hello-plugin");

    const panel = parsePluginPanel(
      JSON.parse(fs.readFileSync(path.join(fixtureRoot, "panels", "main.json"), "utf8")),
    );
    expect(panel.ok).toBe(true);
  });

  it("installs from a local directory and registers its manifest surface", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });

    const installed = await install.install({ source: fixtureRoot });

    expect(installed.errors).toEqual([]);
    expect(installed.record.pluginId).toBe("hello-plugin");
    expect(installed.record.enabled).toBe(true);
    expect(installed.manifest?.cli).toEqual(["greet"]);
    expect(installed.manifest?.surfaces[0]).toMatchObject({ kind: "tab", panelId: "main" });
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin", "index.js"))).toBe(true);

    const listed = install.list();
    expect(listed.map((entry) => entry.record.pluginId)).toEqual(["hello-plugin"]);
  });

  // Registry-vs-cache discipline: a directory nobody installed is not a plugin,
  // no matter how complete it looks on disk.
  it("ignores a plugin directory that is not in the registry", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    await install.install({ source: fixtureRoot });

    fs.cpSync(fixtureRoot, path.join(pluginsRoot, "stowaway"), { recursive: true });

    expect(install.list().map((entry) => entry.record.pluginId)).toEqual(["hello-plugin"]);
    expect(install.get("stowaway")).toBeNull();
  });

  it("contributes its skills directory only while it is enabled", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    await install.install({ source: fixtureRoot });

    const expectedRoot = path.join(pluginsRoot, "hello-plugin", "skills", "using-hello");
    expect(install.skillRoots()).toContain(expectedRoot);
    expect(listPluginAgentSkillRoots({ pluginsRoot })).toContain(expectedRoot);

    install.setEnabled("hello-plugin", false);
    expect(install.skillRoots()).not.toContain(expectedRoot);
    expect(listPluginAgentSkillRoots({ pluginsRoot })).not.toContain(expectedRoot);
  });

  it("removes the directory and the registry entry on uninstall", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    await install.install({ source: fixtureRoot });

    expect(install.uninstall("hello-plugin")).toEqual({ removed: true });
    expect(install.list()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin"))).toBe(false);
  });

  it("refuses a source whose manifest fails validation", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bad-plugin-"));
    scratchDirs.push(broken);
    fs.writeFileSync(path.join(broken, "plugin.json"), JSON.stringify({ name: "Bad Name", version: "1" }));

    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    await expect(install.install({ source: broken })).rejects.toThrow();
    expect(install.list()).toEqual([]);
  });

  it("installs a community plugin unverified and tells the directory it happened", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const reportInstall = vi.fn();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      // No published digest: community plugins live here permanently, and
      // failing them would make the directory a gate on installing anything.
      resolveRegistryEntry: async () => ({ official: false, checksums: {} }),
      reportInstall,
    });

    const installed = await install.install({ source: fixtureRoot });
    expect(installed.record.pluginId).toBe("hello-plugin");

    // Fired after the install is committed, and never awaited by it.
    await vi.waitFor(() => expect(reportInstall).toHaveBeenCalledWith({
      pluginId: "hello-plugin",
      version: "0.1.0",
    }));
  });

  it("refuses an official release it cannot verify against the published digest", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      resolveRegistryEntry: async () => ({
        official: true,
        // The digest recipe is `git archive` of the tag — see registry/README.
        // A local-directory install has no archive to reproduce it from, so the
        // one thing it must not do is shrug and install anyway.
        checksums: { "0.1.0": "a".repeat(64) },
      }),
    });

    await expect(install.install({ source: fixtureRoot })).rejects.toThrow(/checksum/i);
    // Refused while still in staging: nothing was moved into place, so nothing
    // of the unverified tree can run.
    expect(install.list()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin"))).toBe(false);
  });

  it("installs when the directory is unreachable rather than blocking on it", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      resolveRegistryEntry: async () => {
        throw new Error("offline");
      },
    });

    const installed = await install.install({ source: fixtureRoot });
    expect(installed.record.pluginId).toBe("hello-plugin");
  });
});

describe("builtin plugin seeding", () => {
  /** A bundled-resources directory holding one copy of the fixture package. */
  function builtinRootWith(pluginId: string, version = "1.0.0"): string {
    const builtinRoot = path.join(scratchPluginsRoot(), "builtin");
    const target = path.join(builtinRoot, pluginId);
    fs.cpSync(fixtureRoot, target, { recursive: true });
    const manifestPath = path.join(target, "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: pluginId, version }, null, 2));
    return builtinRoot;
  }

  function service(pluginsRoot: string, builtinPluginsRoot: string | null) {
    return createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot });
  }

  it("seeds a bundled plugin into a fresh machine, installed and enabled", () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = service(pluginsRoot, builtinRootWith("hello-plugin"));

    const listed = install.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]!.record).toMatchObject({
      pluginId: "hello-plugin",
      enabled: true,
      source: { kind: "builtin" },
    });
    // Copied into the install root, so every other path assumption still holds.
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin", "index.js"))).toBe(true);
    expect(install.skillRoots()).toHaveLength(1);
  });

  // The failure this prevents: the user deletes a bundled plugin, and ADE
  // silently puts it back on the next read.
  it("never re-seeds a builtin the user uninstalled", () => {
    const pluginsRoot = scratchPluginsRoot();
    const builtinRoot = builtinRootWith("hello-plugin");
    service(pluginsRoot, builtinRoot).list();

    const remover = service(pluginsRoot, builtinRoot);
    expect(remover.uninstall("hello-plugin")).toEqual({ removed: true });

    expect(service(pluginsRoot, builtinRoot).list()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin"))).toBe(false);
  });

  it("leaves a user's own install of the same id alone", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const userInstalled = service(pluginsRoot, null);
    await userInstalled.install({ source: fixtureRoot });

    const seeded = service(pluginsRoot, builtinRootWith("hello-plugin", "9.9.9")).list();

    expect(seeded).toHaveLength(1);
    // Still the record the user created — not replaced by the bundled copy.
    expect(seeded[0]!.record.source.kind).toBe("local");
    expect(seeded[0]!.record.version).toBe("0.1.0");
  });

  it("ships a newer bundled version on update while keeping the user's enablement", () => {
    const pluginsRoot = scratchPluginsRoot();
    service(pluginsRoot, builtinRootWith("hello-plugin", "1.0.0")).list();
    service(pluginsRoot, null).setEnabled("hello-plugin", false);

    const updated = service(pluginsRoot, builtinRootWith("hello-plugin", "2.0.0")).list();

    expect(updated[0]!.record.version).toBe("2.0.0");
    expect(updated[0]!.record.enabled).toBe(false);
  });

  it("does nothing when there are no bundled packages", () => {
    const pluginsRoot = scratchPluginsRoot();
    expect(service(pluginsRoot, null).list()).toEqual([]);
  });
});
