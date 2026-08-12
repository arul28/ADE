import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { parsePluginPanel } from "../../../shared/plugins/vocabulary";
import {
  createPluginInstallService,
  listPluginAgentSkillRoots,
  resolveBuiltinPluginsRoot,
} from "./pluginInstallService";
import { createPluginInstallServiceAdapter } from "./pluginInstallServiceAdapter";

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

/**
 * Where the bundled packages are found.
 *
 * Seeding INSTALLS and ENABLES whatever it finds, so the answer to "is this
 * directory ADE's own `plugins/`" has to be proof, not proximity — otherwise
 * launching ADE from a directory that happens to have a `plugins/` folder next
 * to it runs third-party code nobody chose.
 */
/**
 * The web/phone install path, end to end.
 *
 * A browser and a phone never hold a directory path — they send an id, which
 * reaches this machine as `{kind: "registry"}` and lands in the adapter. The
 * package they ask for may be one ADE ships and deliberately does not seed (the
 * starter themes), so this drives the REAL bundled theme through the REAL
 * install service to prove the whole chain, not a stub of it.
 */
describe("installing a bundled package the way the web client does", () => {
  const repoPluginsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../../plugins",
  );

  it("installs a bundled-only id sent as a registry source, with no directory to clone from", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: repoPluginsRoot,
      // What the real directory says about a starter theme today: official, and
      // no checksum published for the version until release tagging. For a
      // DOWNLOADED tree that is a refusal; for one that shipped inside the app
      // there is nothing to compare against, so it must not be consulted.
      resolveRegistryEntry: async () => ({
        status: "entry",
        entry: { official: true, checksums: {} },
      }),
    });
    const adapter = createPluginInstallServiceAdapter({ install });

    const record = await adapter.install({ kind: "registry", pluginId: "ade-theme-ink" });

    expect(record.pluginId).toBe("ade-theme-ink");
    expect(record.theme?.tokens).toBeTruthy();
    expect(fs.existsSync(path.join(pluginsRoot, "ade-theme-ink", "plugin.json"))).toBe(true);
    // Recorded as builtin, so a later app update ships a newer copy over it.
    expect(install.get("ade-theme-ink")?.record.source).toEqual({ kind: "builtin" });
  });

  it("installs a bundled package while the plugin directory is unreachable", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: repoPluginsRoot,
      resolveRegistryEntry: async () => ({ status: "unreachable" }),
    });
    const adapter = createPluginInstallServiceAdapter({ install });

    // The theme's own manifest says `official: true`, which for a downloaded
    // tree means "refuse while offline". These bytes came from ADE's app
    // bundle, so an offline machine installs them.
    expect((await adapter.install({ kind: "registry", pluginId: "ade-theme-paper" })).pluginId)
      .toBe("ade-theme-paper");
  });
});

/**
 * Skills that ship inside the plugin that owns them.
 *
 * `ade-linear`, `ade-ios-simulator` and `ade-app-control` describe surfaces an
 * official plugin gates, so they live in `plugins/<id>/skills/` and not in the
 * shared bundled root. That placement IS the gate: the existing enable/install
 * filter answers for them, and no runtime is asked to exclude anything. The
 * skills nobody gates have to stay put just as firmly — a move that quietly
 * took `ade-browser` with it would be a capability regression on every machine.
 */
describe("plugin-owned agent skills", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
  const repoPluginsRoot = path.join(repoRoot, "plugins");
  const bundledSkillsRoot = path.join(repoRoot, "apps/desktop/resources/agent-skills");

  const gated = [
    { pluginId: "ade-linear", skillName: "ade-linear" },
    // The id and the skill name are deliberately different words here.
    { pluginId: "ade-ios-sim", skillName: "ade-ios-simulator" },
    { pluginId: "ade-app-control", skillName: "ade-app-control" },
  ] as const;

  it.each(gated)("$skillName ships inside $pluginId and nowhere else", ({ pluginId, skillName }) => {
    expect(fs.existsSync(path.join(repoPluginsRoot, pluginId, "skills", skillName, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(bundledSkillsRoot, skillName))).toBe(false);
  });

  it.each(gated)("$pluginId declares its skills root as a catalogue directory", ({ pluginId, skillName }) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoPluginsRoot, pluginId, "plugin.json"), "utf8"),
    ) as { skills?: unknown };
    // The declared path must be the directory that CONTAINS skill directories:
    // every consumer (Codex extraRoots, ADE_AGENT_SKILLS_DIRS, `ade skill list`)
    // reads `<root>/<skill>/SKILL.md`, so naming the skill directory itself
    // would publish a root with no skills in it.
    expect(manifest.skills).toEqual(["skills"]);
    expect(fs.existsSync(path.join(repoPluginsRoot, pluginId, "skills", skillName, "SKILL.md"))).toBe(true);
  });

  it.each(gated)("$skillName is absent until $pluginId is installed, and gone again after", async ({
    pluginId,
    skillName,
  }) => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: repoPluginsRoot,
    });
    const skillsRoot = path.join(pluginsRoot, pluginId, "skills");

    expect(listPluginAgentSkillRoots({ pluginsRoot })).toEqual([]);

    await install.install({ source: path.join(repoPluginsRoot, pluginId) });

    expect(listPluginAgentSkillRoots({ pluginsRoot })).toContain(skillsRoot);
    expect(install.skillRoots()).toContain(skillsRoot);
    expect(fs.existsSync(path.join(skillsRoot, skillName, "SKILL.md"))).toBe(true);
    // Claude reads plugin roots, not ADE_AGENT_SKILLS_DIRS, so the marker has
    // to travel with the package or the skill loads everywhere but there.
    expect(fs.existsSync(path.join(skillsRoot, ".claude-plugin", "plugin.json"))).toBe(true);

    install.setEnabled(pluginId, false);
    expect(listPluginAgentSkillRoots({ pluginsRoot })).not.toContain(skillsRoot);

    install.setEnabled(pluginId, true);
    expect(install.uninstall(pluginId)).toEqual({ removed: true });
    expect(listPluginAgentSkillRoots({ pluginsRoot })).toEqual([]);
    expect(fs.existsSync(skillsRoot)).toBe(false);
  });

  it.each(["ade-cli-control-plane", "ade-browser"])(
    "%s stays in the shared bundled root whatever is installed",
    async (skillName) => {
      const pluginsRoot = scratchPluginsRoot();
      const install = createPluginInstallService({
        logger: testLogger(),
        pluginsRoot,
        builtinPluginsRoot: repoPluginsRoot,
      });
      const bundledSkill = path.join(bundledSkillsRoot, skillName, "SKILL.md");

      expect(fs.existsSync(bundledSkill)).toBe(true);
      await install.install({ source: path.join(repoPluginsRoot, "ade-linear") });
      expect(fs.existsSync(bundledSkill)).toBe(true);
      // Nothing about an install or an uninstall can reach the shared root.
      expect(listPluginAgentSkillRoots({ pluginsRoot }).some((root) => root.startsWith(bundledSkillsRoot)))
        .toBe(false);
      install.uninstall("ade-linear");
      expect(fs.existsSync(bundledSkill)).toBe(true);
    },
  );
});

describe("builtin plugins root", () => {
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-builtin-root-"));
    scratchDirs.push(root);
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, "utf8");
    }
    return root;
  }

  it("accepts the repo checkout, identified by its own package.json", () => {
    const repo = tree({
      "package.json": JSON.stringify({ name: "ade" }),
      "plugins/ade-graph/plugin.json": "{}",
    });

    expect(resolveBuiltinPluginsRoot({}, { cwd: path.join(repo, "apps", "desktop"), dirname: null }))
      .toBe(path.join(repo, "plugins"));
  });

  it("refuses an unrelated ancestor that merely has a plugins directory", () => {
    const workspace = tree({
      "package.json": JSON.stringify({ name: "someone-elses-monorepo" }),
      "plugins/evil/plugin.json": "{}",
      "checkout/package.json": JSON.stringify({ name: "not-ade" }),
    });

    expect(resolveBuiltinPluginsRoot({}, { cwd: path.join(workspace, "checkout"), dirname: null }))
      .toBeNull();
  });

  it("prefers the packaged resources directory", () => {
    const resources = tree({ "plugins/ade-graph/plugin.json": "{}" });
    const repo = tree({
      "package.json": JSON.stringify({ name: "ade" }),
      "plugins/ade-graph/plugin.json": "{}",
    });

    expect(resolveBuiltinPluginsRoot({}, { cwd: repo, dirname: null, resourcesPath: resources }))
      .toBe(path.join(resources, "plugins"));
  });
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
      resolveRegistryEntry: async () => ({ status: "entry", entry: { official: false, checksums: {} } }),
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
        status: "entry",
        entry: {
          official: true,
          // The digest recipe is `git archive` of the tag — see registry/README.
          // A local-directory install has no archive to reproduce it from, so
          // the one thing it must not do is shrug and install anyway.
          checksums: { "0.1.0": "a".repeat(64) },
        },
      }),
    });

    await expect(install.install({ source: fixtureRoot })).rejects.toThrow(/checksum/i);
    // Refused while still in staging: nothing was moved into place, so nothing
    // of the unverified tree can run.
    expect(install.list()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin"))).toBe(false);
  });

  it("installs a community plugin when the directory is unreachable rather than blocking on it", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      resolveRegistryEntry: async () => {
        throw new Error("offline");
      },
    });

    // hello-plugin does not present itself as official, so an offline machine
    // keeps installing community plugins.
    const installed = await install.install({ source: fixtureRoot });
    expect(installed.record.pluginId).toBe("hello-plugin");
  });

  it("refuses an official plugin while the directory cannot be reached", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const officialSource = fs.mkdtempSync(path.join(os.tmpdir(), "ade-official-plugin-"));
    scratchDirs.push(officialSource);
    fs.cpSync(fixtureRoot, officialSource, { recursive: true });
    const manifestPath = path.join(officialSource, "plugin.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, "utf8")), official: true }),
      "utf8",
    );
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      resolveRegistryEntry: async () => ({ status: "unreachable" }),
    });

    // "Nobody answered" is not "no checksum published": installing here is how
    // an official plugin gets onto a machine with nothing checked at all.
    await expect(install.install({ source: officialSource })).rejects.toThrow(/could not reach/i);
    expect(install.list()).toEqual([]);
  });

  it("refuses an official version the directory publishes no checksum for", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      // The directory vouches for this plugin, but not for the version being
      // installed — the version-bump evasion, and a free pass if it installed.
      resolveRegistryEntry: async () => ({
        status: "entry",
        entry: { official: true, checksums: { "9.9.9": "a".repeat(64) } },
      }),
    });

    await expect(install.install({ source: fixtureRoot })).rejects.toThrow(/no checksum for version/i);
    expect(install.list()).toEqual([]);
  });

  it("installs a plugin the directory does not list at all", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      resolveRegistryEntry: async () => ({ status: "absent" }),
    });

    // The directory answered and does not know this plugin: unverified is the
    // permanent, correct outcome for everything outside the official set.
    expect((await install.install({ source: fixtureRoot })).record.pluginId).toBe("hello-plugin");
  });
});

/**
 * The bundled packages, which ADE ships and never installs.
 *
 * This block used to prove a seeder: bundled packages arrived installed and
 * enabled on first read, an uninstall had to leave a tombstone so the next read
 * would not revive it, and an app update quietly replaced the copy on disk.
 * All three are gone. The bundle is now a catalogue — it exists so an install
 * by bare id works with no network — and every assertion here is the reverse of
 * what it once was, deliberately.
 */
describe("bundled plugin packages", () => {
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

  /** The starter themes ship at `plugins/themes/<id>`, one level down. */
  function builtinRootWithNested(category: string, pluginId: string): string {
    const builtinRoot = path.join(scratchPluginsRoot(), "builtin");
    const target = path.join(builtinRoot, category, pluginId);
    fs.cpSync(fixtureRoot, target, { recursive: true });
    const manifestPath = path.join(target, "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: pluginId, version: "1.0.0" }, null, 2));
    return builtinRoot;
  }

  it("installs a package that ships inside a category directory without seeding it", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = service(pluginsRoot, builtinRootWithNested("themes", "ade-theme-ink"));

    // The nesting is the opt-in: a palette nobody chose must not arrive
    // installed. But it has to be REACHABLE, and before this nothing could
    // install it — the Marketplace's bundled listing points at a repository
    // that does not exist, so the themes were unreachable by every path.
    expect(install.list()).toEqual([]);

    const installed = await install.install({ source: "ade-theme-ink" });

    expect(installed.record.pluginId).toBe("ade-theme-ink");
    // Flattened into the install root, where `<root>/<id>` is assumed by
    // describe, skillRoots and uninstall alike.
    expect(fs.existsSync(path.join(pluginsRoot, "ade-theme-ink", "plugin.json"))).toBe(true);
  });

  it("lists nothing on a fresh machine, however many packages are bundled", () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = service(pluginsRoot, builtinRootWith("hello-plugin"));

    // The bundle is present and readable; that is not an install. A machine
    // that has installed nothing has nothing, and shows none of the surfaces
    // these packages gate.
    expect(install.list()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin"))).toBe(false);
    expect(install.skillRoots()).toEqual([]);
  });

  it("installs a bundled package by bare id, recorded as builtin", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const install = service(pluginsRoot, builtinRootWith("hello-plugin"));

    const installed = await install.install({ source: "hello-plugin" });

    expect(installed.record).toMatchObject({
      pluginId: "hello-plugin",
      enabled: true,
      source: { kind: "builtin" },
    });
    // Copied into the install root, so every other path assumption still holds:
    // describe, skillRoots and uninstall all read `<root>/<id>`.
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin", "index.js"))).toBe(true);
    expect(install.skillRoots()).toHaveLength(1);
  });

  it("keeps an uninstalled package uninstalled without needing a tombstone", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const builtinRoot = builtinRootWith("hello-plugin");
    const install = service(pluginsRoot, builtinRoot);
    await install.install({ source: "hello-plugin" });

    expect(install.uninstall("hello-plugin")).toEqual({ removed: true });

    // The tombstone list existed only because seeding ran on every read and
    // would otherwise put the package straight back. Nothing reads the bundle
    // unasked now, so a fresh service simply finds an empty registry.
    const state = JSON.parse(fs.readFileSync(path.join(pluginsRoot, "state.json"), "utf8")) as Record<string, unknown>;
    expect(state).not.toHaveProperty("removedBuiltins");
    expect(service(pluginsRoot, builtinRoot).list()).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "hello-plugin"))).toBe(false);
  });

  it("leaves a user's own install of the same id alone", async () => {
    const pluginsRoot = scratchPluginsRoot();
    const userInstalled = service(pluginsRoot, null);
    await userInstalled.install({ source: fixtureRoot });

    const listed = service(pluginsRoot, builtinRootWith("hello-plugin", "9.9.9")).list();

    expect(listed).toHaveLength(1);
    // Still the record the user created. They chose that copy, and a bundled
    // package of the same name must not quietly take its place.
    expect(listed[0]!.record.source.kind).toBe("local");
    expect(listed[0]!.record.version).toBe("0.1.0");
  });

  it("does not change an installed record when the app ships a newer bundle", async () => {
    const pluginsRoot = scratchPluginsRoot();
    await service(pluginsRoot, builtinRootWith("hello-plugin", "1.0.0")).install({ source: "hello-plugin" });
    service(pluginsRoot, null).setEnabled("hello-plugin", false);

    const afterUpdate = service(pluginsRoot, builtinRootWith("hello-plugin", "2.0.0")).list();

    // Updating ADE is not a plugin update. The version on disk is the one the
    // user installed until they ask for another — the alternative is an app
    // update silently replacing code they chose.
    expect(afterUpdate[0]!.record.version).toBe("1.0.0");
    expect(afterUpdate[0]!.record.enabled).toBe(false);
  });

  it("keeps the user's enablement when they install the newer bundled copy themselves", async () => {
    const pluginsRoot = scratchPluginsRoot();
    await service(pluginsRoot, builtinRootWith("hello-plugin", "1.0.0")).install({ source: "hello-plugin" });
    service(pluginsRoot, null).setEnabled("hello-plugin", false);

    const install = service(pluginsRoot, builtinRootWith("hello-plugin", "2.0.0"));
    const updated = await install.install({ source: "hello-plugin" });

    expect(updated.record.version).toBe("2.0.0");
    // Disabled is a setting, not a property of the version: an update that
    // switched a plugin back on would be indistinguishable from ADE ignoring it.
    expect(updated.record.enabled).toBe(false);
  });

  it("does nothing when there are no bundled packages", () => {
    const pluginsRoot = scratchPluginsRoot();
    expect(service(pluginsRoot, null).list()).toEqual([]);
  });
});
