/**
 * The bundled index is a COPY of what ships on disk, and this is the file that
 * makes that a fact rather than a promise.
 *
 * `marketplaceLocalIndex.ts` restates every official plugin's manifest as a TS
 * literal because it is bundled into the renderer by Vite, and `plugins/` sits
 * outside the Vite root — there is no import that could read the real file at
 * build time. A hand-written copy drifts, and the drift is invisible: the
 * install still works, but `describeManifestAdds` reads `tools`, `settings`,
 * `automationTriggers`, `automationSteps`, `searchProviders`, `keybindings`,
 * `collections`, `cli`, `skills`, `urlMatchers` and `authSessions` off that
 * manifest to build the install modal's "Adds" disclosure. A field missing from
 * the bundled copy is a capability the user is not told about on the one path
 * where the bundled copy is what they see — offline, or before the directory
 * has published the entry.
 *
 * So: every `plugin.json` in the repository is read here with `node:fs` (the
 * renderer suite runs in the `node` environment) and deep-equalled against the
 * bundled literal, both sides normalised through the SAME default-filling
 * helper the literals go through. Enumeration is from disk, never a hard-coded
 * list, so a new official plugin is covered the day its directory appears.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { PluginManifest } from "../../../shared/plugins/manifest";
import {
  BUNDLED_MANIFESTS_BY_ID,
  withBundledManifestDefaults,
} from "./marketplaceLocalIndex";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const pluginsRoot = path.join(repoRoot, "plugins");

/**
 * Every `plugin.json` that ships in this repository, keyed by its directory.
 *
 * Two levels deep on purpose and no deeper: official plugins live at
 * `plugins/<id>/`, and the three starter themes are grouped one level further
 * down at `plugins/themes/<id>/`. Walking the tree rather than listing ids is
 * the whole point — a plugin added tomorrow is compared tomorrow, and the
 * coverage test below turns "someone shipped a plugin and forgot the bundled
 * entry" into a red suite instead of a quiet omission in the install modal.
 */
function onDiskManifestPaths(): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (dir: string): void => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const manifestPath = path.join(dir, child.name, "plugin.json");
      if (fs.existsSync(manifestPath)) found.set(child.name, manifestPath);
    }
  };
  scan(pluginsRoot);
  scan(path.join(pluginsRoot, "themes"));
  return found;
}

const onDisk = onDiskManifestPaths();

/**
 * Keys a `plugin.json` carries that are deliberately NOT mirrored, per plugin.
 *
 * Listed rather than filtered silently, because "the bundled copy drops this
 * field" is exactly the kind of decision that has to survive review. Each entry
 * needs a reason a reader can check.
 *
 * - `ade-voice` → `extraDownloads`: this is a *registry index* field
 *   (`PluginRegistryExtraDownload` in `shared/plugins/registryIndex.ts`), not a
 *   `PluginManifest` field. `parsePluginManifest` never reads it and
 *   `PluginManifest` has nowhere to put it, so a bundled manifest literal
 *   cannot carry it — it belongs on the `MarketplaceListing`, which is where
 *   the directory publishes it too.
 */
const NON_MANIFEST_KEYS_ON_DISK: Readonly<Record<string, readonly string[]>> = {
  "ade-voice": ["extraDownloads"],
};

/**
 * Every field `PluginManifest` declares.
 *
 * A `Record<keyof PluginManifest, true>` rather than a string array so the type
 * checker requires this list to stay complete: adding a field to
 * `PluginManifest` fails to compile here until it is listed, which is what
 * keeps the "unexpected key" test below honest instead of quietly permissive.
 */
const MANIFEST_FIELDS: Record<keyof PluginManifest, true> = {
  name: true,
  version: true,
  displayName: true,
  description: true,
  icon: true,
  accent: true,
  brandIcons: true,
  minAdeVersion: true,
  vocabVersion: true,
  entry: true,
  surfaces: true,
  panels: true,
  sockets: true,
  collections: true,
  settings: true,
  cli: true,
  skills: true,
  tools: true,
  automationTriggers: true,
  automationSteps: true,
  searchProviders: true,
  keybindings: true,
  urlMatchers: true,
  chatRuntimes: true,
  webhookIngress: true,
  network: true,
  providerKeys: true,
  authSessions: true,
  credentialHandoff: true,
  projectSecrets: true,
  theme: true,
  official: true,
};

function readOnDisk(manifestPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

/**
 * Fill the one NESTED default the manifest parser supplies and a `plugin.json`
 * therefore omits.
 *
 * `PluginManifestToolInputNode`'s object variant declares `required: string[]`
 * as non-optional, so a bundled literal is obliged to write `required: []` even
 * where the shipped JSON leaves it out. That is not drift: `parseToolInputObject`
 * reads a missing `required` as `[]`, so the two are the same manifest the
 * moment the host parses the file. `ade-linear`'s `graphql` tool is the live
 * case — its `variables` object declares no required keys — and without this the
 * comparison would report a difference that does not exist at runtime.
 *
 * Deliberately the only parser behaviour restated here. Everything else is
 * compared as raw JSON against the bundled literal, so the test cannot be
 * satisfied by a second normaliser quietly agreeing with itself.
 */
function fillToolInputRequired(node: unknown): unknown {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  const record = node as Record<string, unknown>;
  if (record.type === "array") return { ...record, items: fillToolInputRequired(record.items) };
  if (record.type !== "object") return record;
  const properties = (record.properties ?? {}) as Record<string, unknown>;
  return {
    ...record,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, fillToolInputRequired(value)]),
    ),
    required: record.required ?? [],
  };
}

function normaliseTools(raw: Record<string, unknown>): Record<string, unknown> {
  // Always a copy, so the caller's `delete` below cannot reach the parsed file.
  if (!Array.isArray(raw.tools)) return { ...raw };
  return {
    ...raw,
    tools: raw.tools.map((tool) => {
      const entry = tool as Record<string, unknown>;
      return { ...entry, input: fillToolInputRequired(entry.input) };
    }),
  };
}

describe("bundled manifests mirror the plugins that ship on disk", () => {
  it("bundles exactly the official plugins the repository ships", () => {
    expect(Object.keys(BUNDLED_MANIFESTS_BY_ID).sort()).toEqual([...onDisk.keys()].sort());
  });

  // A defensive floor. If the walk above ever finds nothing — a moved
  // directory, a wrong `repoRoot` — every per-plugin case below would silently
  // stop existing and the suite would go green on zero assertions.
  it("finds the official plugins on disk", () => {
    expect(onDisk.size).toBeGreaterThanOrEqual(12);
  });

  it("ships twelve official themes", () => {
    const themeIds = Object.values(BUNDLED_MANIFESTS_BY_ID)
      .filter((manifest) => manifest.theme !== undefined)
      .map((manifest) => manifest.name)
      .sort();

    expect(themeIds).toEqual([
      "ade-theme-contrast",
      "ade-theme-frost",
      "ade-theme-ink",
      "ade-theme-kiln",
      "ade-theme-latte",
      "ade-theme-midnight",
      "ade-theme-mocha",
      "ade-theme-paper",
      "ade-theme-phosphor",
      "ade-theme-rose-ash",
      "ade-theme-solar-dusk",
      "ade-theme-spectre",
    ]);
  });

  for (const [pluginId, manifestPath] of [...onDisk].sort(([a], [b]) => a.localeCompare(b))) {
    const relative = path.relative(repoRoot, manifestPath);

    it(`${pluginId}: bundled entry equals ${relative}`, () => {
      const raw = readOnDisk(manifestPath);
      const excluded = NON_MANIFEST_KEYS_ON_DISK[pluginId] ?? [];
      const mirrored: Record<string, unknown> = normaliseTools(raw);
      for (const key of excluded) delete mirrored[key];

      // Both sides through the same helper: the on-disk JSON omits every field
      // the helper defaults (`surfaces: []`, `official: true`, …), so comparing
      // the parsed file directly would report a dozen phantom differences and
      // hide the real ones.
      const expected = withBundledManifestDefaults(
        mirrored as unknown as Parameters<typeof withBundledManifestDefaults>[0],
      );

      expect(BUNDLED_MANIFESTS_BY_ID[pluginId]).toEqual(expected);
    });

    it(`${pluginId}: directory name is the manifest name`, () => {
      expect(readOnDisk(manifestPath).name).toBe(pluginId);
    });

    it(`${pluginId}: carries no undeclared keys beyond the documented exceptions`, () => {
      const raw = readOnDisk(manifestPath);
      const unknownKeys = Object.keys(raw).filter((key) => !(key in MANIFEST_FIELDS));
      expect(unknownKeys.sort()).toEqual([...(NON_MANIFEST_KEYS_ON_DISK[pluginId] ?? [])].sort());
    });
  }
});
