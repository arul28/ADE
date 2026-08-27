import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../main/services/logging/logger";
import { createPluginInstallService } from "../../main/services/plugins/pluginInstallService";
import { MARKETPLACE_LOCAL_INDEX } from "../../renderer/components/plugins/marketplaceLocalIndex";
import { sanitizePluginThemeTokens } from "../../renderer/lib/pluginTheme";
import { parsePluginManifestJson, type PluginManifest } from "./manifest";
import { parsePluginRegistryIndexJson } from "./registryIndex";
import { parsePluginPanel } from "./vocabulary";

/**
 * The plugins ADE publishes itself, checked as the real files they are.
 *
 * Three different things can drift here and each has its own failure: a manifest
 * can stop parsing (the plugin will not install), a panel can stop parsing (it
 * renders a fallback card instead of itself), and the two seeded copies of the
 * catalogue — the bundled index and the directory — can disagree with the
 * package (a Marketplace row that describes something else). The last one is
 * silent in every other test, which is why it is checked against the manifests
 * on disk rather than against a fixture.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const pluginsRoot = path.join(repoRoot, "plugins");

const PACKAGE_DIRS = [
  "ade-graph",
  "ade-review",
  "ade-history",
  "ade-linear",
  "ade-ios-sim",
  "ade-app-control",
  "ade-log-viewer",
  "ade-voice",
  "ade-cursor-cloud",
  "themes/ade-theme-paper",
  "themes/ade-theme-ink",
  "themes/ade-theme-contrast",
];

function readManifest(dir: string): PluginManifest {
  const file = path.join(pluginsRoot, dir, "plugin.json");
  const parsed = parsePluginManifestJson(fs.readFileSync(file, "utf8"));
  expect(parsed.errors, `${dir} manifest errors`).toEqual([]);
  expect(parsed.manifest, `${dir} manifest`).not.toBeNull();
  return parsed.manifest!;
}

const manifests = new Map(PACKAGE_DIRS.map((dir) => [dir, readManifest(dir)]));

describe("official plugin packages", () => {
  it.each(PACKAGE_DIRS)("%s parses with no errors or warnings", (dir) => {
    const parsed = parsePluginManifestJson(
      fs.readFileSync(path.join(pluginsRoot, dir, "plugin.json"), "utf8"),
    );
    expect(parsed.errors).toEqual([]);
    // A warning here means a field was dropped — an official package must not
    // ship one, because the dropped thing is exactly what the README promises.
    expect(parsed.warnings).toEqual([]);
  });

  it.each(PACKAGE_DIRS)("%s ships a README the Marketplace can show", (dir) => {
    const readme = fs.readFileSync(path.join(pluginsRoot, dir, "README.md"), "utf8");
    expect(readme.trim().length).toBeGreaterThan(80);
  });

  it("every declared panel schema exists and parses", () => {
    for (const [dir, manifest] of manifests) {
      for (const panel of manifest.panels) {
        if (!panel.schemaFile) continue;
        const file = path.join(pluginsRoot, dir, panel.schemaFile);
        const parsed = parsePluginPanel(JSON.parse(fs.readFileSync(file, "utf8")));
        expect(parsed.ok, `${dir}/${panel.schemaFile}`).toBe(true);
      }
    }
  });

  it("every declared entry file exists", () => {
    for (const [dir, manifest] of manifests) {
      if (!manifest.entry) continue;
      expect(fs.existsSync(path.join(pluginsRoot, dir, manifest.entry)), `${dir}/${manifest.entry}`).toBe(true);
    }
  });

  it("ships no dependencies", () => {
    // The house rule from `plugins/README.md`. A `node_modules` in a published
    // package is a supply chain nobody reviewed.
    for (const dir of PACKAGE_DIRS) {
      expect(fs.existsSync(path.join(pluginsRoot, dir, "node_modules")), dir).toBe(false);
      expect(fs.existsSync(path.join(pluginsRoot, dir, "package.json")), dir).toBe(false);
    }
  });
});

describe("ade-graph", () => {
  const manifest = manifests.get("ade-graph")!;

  it("gates the built-in Graph tab", () => {
    expect(manifest.official).toBe(true);
    expect(manifest.surfaces[0]).toMatchObject({ kind: "tab", id: "graph", builtin: "graph" });
  });

  it("publishes a panel for clients that cannot draw the canvas", () => {
    const parsed = parsePluginPanel(
      JSON.parse(fs.readFileSync(path.join(pluginsRoot, "ade-graph/panels/main.json"), "utf8")),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.panel.fallback.deeplink).toBe("ade://graph");
  });
});

describe("ade-log-viewer", () => {
  const manifest = manifests.get("ade-log-viewer")!;
  const require_ = createRequire(import.meta.url);
  // Loaded through `require` on purpose: this is CommonJS plugin code, exactly
  // as the child bootstrap loads it, so a syntax error or a missing export fails
  // here rather than at install time.
  const logParse = require_(path.join(pluginsRoot, "ade-log-viewer/logParse.js")) as {
    parseLogLine: (raw: string) => { level: string; message: string; time: string | null } | null;
    parseLogLines: (content: string, partial: boolean) => { level: string; message: string }[];
    splitLines: (content: string, partial: boolean) => string[];
    selectTail: (entries: unknown[], options: { level?: string; limit?: number }) => unknown[];
    summarize: (entries: { level: string }[]) => Record<string, number>;
    buildViewerSchema: (view: Record<string, unknown>) => unknown;
    buildPromptSchema: (message?: string) => unknown;
    clampInt: (value: unknown, min: number, max: number, fallback: number) => number;
  };

  it("claims only extensions the built-in viewers decline", () => {
    // The viewer rule from `PluginViewer`: plugins are asked after every
    // built-in viewer has declined, so claiming `.png` or `.mp4` would be a
    // socket that never fires.
    expect(manifest.sockets[0]).toMatchObject({
      socket: "file-viewer",
      surface: "files",
      extensions: [".log", ".ndjson"],
    });
  });

  it("reads NDJSON levels, messages and timestamps", () => {
    const entry = logParse.parseLogLine(
      '{"level":"error","msg":"connect failed","time":"2026-08-11T09:12:00Z"}',
    );
    expect(entry).toMatchObject({ level: "error", message: "connect failed", time: "2026-08-11T09:12:00Z" });
  });

  it("reads pino and bunyan numeric levels", () => {
    expect(logParse.parseLogLine('{"level":50,"msg":"boom"}')?.level).toBe("error");
    expect(logParse.parseLogLine('{"level":40,"msg":"careful"}')?.level).toBe("warn");
    expect(logParse.parseLogLine('{"level":30,"msg":"fine"}')?.level).toBe("info");
    expect(logParse.parseLogLine('{"level":20,"msg":"detail"}')?.level).toBe("debug");
  });

  it("reads a level and a timestamp out of plain text", () => {
    const entry = logParse.parseLogLine("[2026-08-11 09:12:00] WARN disk is nearly full");
    expect(entry).toMatchObject({ level: "warn", time: "2026-08-11 09:12:00" });
    expect(entry?.message).toBe("disk is nearly full");
  });

  it("falls back to info rather than guessing", () => {
    expect(logParse.parseLogLine("just a line of output")?.level).toBe("info");
  });

  it("keeps a structured line with no message field readable", () => {
    const entry = logParse.parseLogLine('{"level":"info","event":"started","pid":9}');
    expect(entry?.message).toBe("started");
  });

  it("drops the first line of a mid-file read", () => {
    // The read starts at an arbitrary byte, so line one is the tail of a line
    // whose beginning was never read. Showing it would be a wrong message, not
    // a truncated one.
    expect(logParse.splitLines("ailed to connect\nsecond\nthird", true)).toEqual(["second", "third"]);
    expect(logParse.splitLines("first\nsecond", false)).toEqual(["first", "second"]);
  });

  it("counts levels and keeps the newest lines", () => {
    const entries = logParse.parseLogLines(
      ["INFO a", "ERROR b", "WARN c", "INFO d"].join("\n"),
      false,
    );
    expect(logParse.summarize(entries)).toMatchObject({ error: 1, warn: 1, info: 2 });
    expect(logParse.selectTail(entries, { level: "error" })).toHaveLength(1);
    expect(logParse.selectTail(entries, { limit: 10 })).toHaveLength(4);
  });

  it("clamps the configured line count into the vocabulary's list limit", () => {
    expect(logParse.clampInt(5_000, 10, 100, 100)).toBe(100);
    expect(logParse.clampInt(1, 10, 100, 100)).toBe(10);
    expect(logParse.clampInt("not a number", 10, 100, 100)).toBe(100);
  });

  it("builds a panel that the vocabulary accepts", () => {
    const entries = logParse.parseLogLines(
      Array.from({ length: 400 }, (_, index) => `${index % 7 === 0 ? "ERROR" : "INFO"} line ${index}`).join("\n"),
      true,
    );
    const schema = logParse.buildViewerSchema({
      fileName: "daemon.log",
      filePath: "logs/daemon.log",
      totalSize: 4_000_000,
      readBytes: 131_072,
      truncated: true,
      entries,
      counts: logParse.summarize(entries),
      level: "all",
      limit: 100,
    });
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toEqual([]);
    expect(parsed.panel.title).toBe("daemon.log");
  });

  it("stays inside the panel schema budget on very long lines", () => {
    const long = "x".repeat(4_000);
    const entries = logParse.parseLogLines(
      Array.from({ length: 200 }, () => `ERROR ${long}`).join("\n"),
      false,
    );
    const schema = logParse.buildViewerSchema({
      fileName: "wide.log",
      filePath: "wide.log",
      totalSize: 10_000_000,
      readBytes: 131_072,
      truncated: true,
      entries,
      counts: logParse.summarize(entries),
      level: "all",
      limit: 100,
    });
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(parsePluginPanel(schema).ok).toBe(true);
  });

  it("has a prompt panel to fall back to", () => {
    expect(parsePluginPanel(logParse.buildPromptSchema()).ok).toBe(true);
    expect(parsePluginPanel(logParse.buildPromptSchema("This file could not be read.")).ok).toBe(true);
  });
});

describe("starter themes", () => {
  const themeDirs = PACKAGE_DIRS.filter((dir) => dir.startsWith("themes/"));

  it.each(themeDirs)("%s ships both palettes", (dir) => {
    const theme = manifests.get(dir)!.theme;
    expect(theme?.tokens.dark && Object.keys(theme.tokens.dark).length).toBeTruthy();
    expect(theme?.tokens.light && Object.keys(theme.tokens.light).length).toBeTruthy();
  });

  it.each(themeDirs)("%s survives the theme engine's sanitizer intact", (dir) => {
    const theme = manifests.get(dir)!.theme!;
    const sanitized = sanitizePluginThemeTokens(theme.tokens);
    // Anything rejected here is a token the user would never see applied, and
    // the reason would be invisible in the product.
    expect(sanitized.rejected).toEqual([]);
    expect(Object.keys(sanitized.tokens.dark ?? {})).toEqual(Object.keys(theme.tokens.dark ?? {}));
    expect(Object.keys(sanitized.tokens.light ?? {})).toEqual(Object.keys(theme.tokens.light ?? {}));
  });

  it.each(themeDirs)("%s runs no code", (dir) => {
    expect(manifests.get(dir)!.entry).toBeUndefined();
  });
});

describe("installing a package the way `ade plugin install <path>` does", () => {
  const scratch: string[] = [];

  afterEach(() => {
    while (scratch.length) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
  });

  function pluginsRootScratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pilot-plugins-"));
    scratch.push(dir);
    return path.join(dir, "plugins");
  }

  const logger = (): Logger =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger);

  it.each(PACKAGE_DIRS)("installs %s from its directory", async (dir) => {
    const root = pluginsRootScratch();
    const install = createPluginInstallService({ logger: logger(), pluginsRoot: root });

    const installed = await install.install({ source: path.join(pluginsRoot, dir) });

    const manifest = manifests.get(dir)!;
    expect(installed.errors).toEqual([]);
    expect(installed.warnings).toEqual([]);
    expect(installed.record.pluginId).toBe(manifest.name);
    expect(installed.record.enabled).toBe(true);
    // The install directory is named by the plugin id, not by the source folder:
    // `themes/ade-theme-ink` lands at `<root>/ade-theme-ink`.
    expect(fs.existsSync(path.join(root, manifest.name, "plugin.json"))).toBe(true);
    expect(install.list().map((entry) => entry.record.pluginId)).toEqual([manifest.name]);
  });

  it("keeps ade-graph's builtin surface through an install", async () => {
    const root = pluginsRootScratch();
    const install = createPluginInstallService({ logger: logger(), pluginsRoot: root });
    const installed = await install.install({ source: path.join(pluginsRoot, "ade-graph") });
    expect(installed.manifest?.surfaces[0]?.builtin).toBe("graph");
  });

  /**
   * Nothing installs itself, pointed at the REAL bundle rather than a synthetic
   * one.
   *
   * ADE used to seed two of these packages onto every machine on first read.
   * That is gone: a fresh machine starts with zero plugins, and the bundled
   * packages are a catalogue you can install from offline, not a set of
   * defaults. The bundle is still walked to find them by id, and the risk that
   * walk carries is why this is checked against the real directory — a package
   * whose folder name stops matching its manifest id, or one that starts
   * arriving installed again, passes every other test in the suite.
   */
  describe("the real bundle installs nothing on its own", () => {
    it("starts a fresh machine with no plugins at all", () => {
      const root = pluginsRootScratch();
      const install = createPluginInstallService({
        logger: logger(),
        pluginsRoot: root,
        builtinPluginsRoot: pluginsRoot,
      });

      expect(install.list()).toEqual([]);
      // Not even a state file. Reading the registry must stay a pure read: the
      // seeding path wrote one on first read, and a write there is what turned
      // "ADE ships these packages" into "your machine has these installed".
      expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
    });

    it.each(PACKAGE_DIRS)("still installs %s by bare id when asked", async (dir) => {
      const root = pluginsRootScratch();
      const install = createPluginInstallService({
        logger: logger(),
        pluginsRoot: root,
        builtinPluginsRoot: pluginsRoot,
      });
      const pluginId = manifests.get(dir)!.name;

      // The themes sit one level down, under `plugins/themes/`. An explicit
      // install is the opt-in, so it looks inside a category directory — which
      // is the whole reason the bundle is still walked now that nothing seeds.
      const installed = await install.install({ source: pluginId });
      expect(installed.errors, pluginId).toEqual([]);
      expect(installed.record.pluginId, pluginId).toBe(pluginId);
      expect(installed.record.source.kind, pluginId).toBe("builtin");
      expect(install.list().map((entry) => entry.record.pluginId)).toEqual([pluginId]);
    });

    it("leaves an uninstalled package uninstalled, with no tombstone to remember it by", () => {
      const root = pluginsRootScratch();
      const first = createPluginInstallService({
        logger: logger(),
        pluginsRoot: root,
        builtinPluginsRoot: pluginsRoot,
      });
      return first.install({ source: "ade-graph" }).then(() => {
        first.uninstall("ade-graph");

        // The tombstone list existed only to stop seeding reviving a removal.
        // With no seeding there is nothing to defend against, and a fresh
        // service simply reads an empty registry.
        const second = createPluginInstallService({
          logger: logger(),
          pluginsRoot: root,
          builtinPluginsRoot: pluginsRoot,
        });
        expect(second.list()).toEqual([]);
      });
    });
  });
});

describe("seeded catalogues agree with the packages", () => {
  const byId = new Map([...manifests.values()].map((manifest) => [manifest.name, manifest]));

  it("the bundled index lists exactly these plugins", () => {
    expect([...MARKETPLACE_LOCAL_INDEX].map((entry) => entry.pluginId).sort())
      .toEqual([...byId.keys()].sort());
  });

  it("the bundled index describes each one as its manifest does", () => {
    for (const listing of MARKETPLACE_LOCAL_INDEX) {
      const manifest = byId.get(listing.pluginId)!;
      expect(listing.version, listing.pluginId).toBe(manifest.version);
      expect(listing.displayName, listing.pluginId).toBe(manifest.displayName);
      expect(listing.description, listing.pluginId).toBe(manifest.description);
      expect(listing.accent, listing.pluginId).toBe(manifest.accent ?? null);
      expect(listing.isTheme, listing.pluginId).toBe(manifest.theme !== undefined);
      expect(listing.manifest?.surfaces, listing.pluginId).toEqual(manifest.surfaces);
      expect(listing.manifest?.sockets, listing.pluginId).toEqual(manifest.sockets);
      expect(listing.themeTokens ?? null, listing.pluginId).toEqual(manifest.theme?.tokens ?? null);
    }
  });

  // The directory is extracted to its own repository once the platform ships;
  // until then it is seeded here and has to agree. See `registry/README.md`.
  const registryIndexPath = path.join(repoRoot, "registry/index.json");
  const registryPresent = fs.existsSync(registryIndexPath);

  it.runIf(registryPresent)("the seeded directory index parses and matches", () => {
    const parsed = parsePluginRegistryIndexJson(fs.readFileSync(registryIndexPath, "utf8"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const entries = parsed.index?.entries ?? [];
    expect(entries.map((entry) => entry.pluginId).sort()).toEqual([...byId.keys()].sort());
    for (const entry of entries) {
      const manifest = byId.get(entry.pluginId)!;
      expect(entry.version, entry.pluginId).toBe(manifest.version);
      expect(entry.displayName, entry.pluginId).toBe(manifest.displayName);
      expect(entry.description, entry.pluginId).toBe(manifest.description);
      expect(entry.isTheme, entry.pluginId).toBe(manifest.theme !== undefined);
      expect(entry.official, entry.pluginId).toBe(true);
    }
  });

  it.runIf(registryPresent)("the curated files name plugins that exist", () => {
    const featured = JSON.parse(fs.readFileSync(path.join(repoRoot, "registry/featured.json"), "utf8")) as {
      featured: string[];
    };
    const official = JSON.parse(fs.readFileSync(path.join(repoRoot, "registry/official.json"), "utf8")) as {
      plugins: Record<string, unknown>;
    };
    for (const pluginId of featured.featured) expect(byId.has(pluginId), pluginId).toBe(true);
    expect(Object.keys(official.plugins).sort()).toEqual([...byId.keys()].sort());
  });
});
