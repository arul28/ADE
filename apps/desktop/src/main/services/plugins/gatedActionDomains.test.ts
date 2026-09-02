import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  allGatedActionDomains,
  buildGatedDomainDenial,
  buildSurfaceUnavailableDenial,
  gatedDomainUnavailableReason,
  pluginDisplayNameFromCatalog,
  pluginNotInstalledMessage,
  pluginStepUnavailableMessage,
  pluginStepUnavailableReason,
  resolveDisabledActionDomains,
} from "./gatedActionDomains";

/**
 * A plugin is the whole vertical, so its action domains leave with it.
 *
 * Two rules are load-bearing and asserted from both sides here. The refusal is
 * POLICY — an existing, correctly spelled domain that this machine will not
 * serve — and never a missing method, because a client that reads "no such
 * method" concludes the host is too old and silently takes a legacy path. And
 * the human name in the copy comes from the CATALOG; when no catalog knows the
 * plugin there is no invented hint at all, because a message telling a user to
 * install something ADE cannot name is worse than a plain error.
 */

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function writePluginsRoot(installed: Record<string, { enabled?: boolean }>): string {
  const root = scratchDir("ade-gated-domains-");
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(installed).map(([pluginId, record]) => [
          pluginId,
          {
            version: "1.0.0",
            enabled: record.enabled !== false,
            source: { kind: "builtin" },
            installedAt: "2026-08-01T00:00:00.000Z",
          },
        ]),
      ),
    }),
  );
  return root;
}

function writeBundledRoot(packages: Record<string, string>): string {
  const root = scratchDir("ade-gated-bundled-");
  for (const [pluginId, displayName] of Object.entries(packages)) {
    fs.mkdirSync(path.join(root, pluginId), { recursive: true });
    fs.writeFileSync(
      path.join(root, pluginId, "plugin.json"),
      JSON.stringify({ name: pluginId, displayName, version: "1.0.0" }),
    );
  }
  return root;
}

afterEach(() => {
  while (scratch.length) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("resolveDisabledActionDomains", () => {
  it("refuses no plugin-owned domain on a machine with no plugins", () => {
    const disabled = resolveDisabledActionDomains(writePluginsRoot({}));

    // Every registered surface supersedes. ADE compiled the Control and
    // Simulator verbs and still answers them, so an empty machine refuses
    // nothing.
    expect([...disabled]).toEqual([]);
  });

  it("never refuses a domain behind a superseded surface, whoever is installed", () => {
    // The rule the `supersedes` polarity turns on. ADE compiled the Linear
    // verbs and still answers them, so no registry state may put a `linear_*`
    // domain in the refusal set — not an empty machine, and not one that has
    // the plugin. What moves for Linear is the CATALOG, in
    // `resolveHiddenActionNames`, never the dispatch.
    for (const root of [writePluginsRoot({}), writePluginsRoot({ "ade-linear": {} })]) {
      const disabled = resolveDisabledActionDomains(root);
      for (const domain of ["linear_issue_tracker", "linear_credentials", "linear_oauth"]) {
        expect(disabled.has(domain), domain).toBe(false);
      }
    }
  });

  it("never refuses Control or Simulator domains, whoever is installed", () => {
    for (const root of [writePluginsRoot({}), writePluginsRoot({ "ade-ios-sim": {} })]) {
      const disabled = resolveDisabledActionDomains(root);
      expect(disabled.has("ios_simulator")).toBe(false);
      expect(disabled.has("app_control")).toBe(false);
    }
  });

  it("never gates ADE's own domains", () => {
    const disabled = resolveDisabledActionDomains(writePluginsRoot({}));

    for (const domain of ["lane", "chat", "pr", "file", "git", "graph_state", "review"]) {
      expect(disabled.has(domain)).toBe(false);
    }
  });

  it("gates nothing when the registry is unreadable, because nothing is gated", () => {
    const root = scratchDir("ade-gated-corrupt-");
    fs.writeFileSync(path.join(root, "state.json"), "{ not json");

    expect([...resolveDisabledActionDomains(root)]).toEqual([]);
  });
});

describe("refusal copy", () => {
  it("names the plugin using the catalog's display name, not a hardcoded label", () => {
    expect(pluginNotInstalledMessage("ade-ios-sim", () => "iOS Simulator")).toBe(
      "This machine doesn't have iOS Simulator. It's provided by the ade-ios-sim plugin — available in the Marketplace.",
    );
    expect(buildGatedDomainDenial("ios_simulator", () => "iOS Simulator")).toBeNull();
  });

  it("invents no hint when no catalog can name the owner", () => {
    expect(buildGatedDomainDenial("ios_simulator", () => null)).toBeNull();
    expect(pluginNotInstalledMessage("ade-ios-sim", () => "  ")).toBeNull();
  });

  it("returns null for two different reasons, so a caller must gate on the SET", () => {
    // The two nulls above are indistinguishable — "not gated" and "gated but
    // unnameable" — which is why every caller that treats null as a pass has to
    // ask `allGatedActionDomains` first. The plugin action bridge in
    // `bootstrap.ts` learned this the hard way: gated domains are also in
    // `ADE_ACTION_ALLOWLIST`, so there was no generic unknown-domain error for
    // a cold catalog to land in, and a machine with an unreadable bundled root
    // handed `ios_simulator` and `app_control` straight to any plugin.
    expect(buildGatedDomainDenial("ios_simulator", () => null)).toBeNull();
    expect(buildGatedDomainDenial("lane", () => "Anything")).toBeNull();

    const gated = allGatedActionDomains();
    expect(gated.has("ios_simulator")).toBe(false);
    expect(gated.has("app_control")).toBe(false);
    expect(gated.has("lane")).toBe(false);
    expect(gated.has("linear_credentials")).toBe(false);
    expect(gated.size).toBe(0);
  });

  it("says nothing about a domain no plugin owns", () => {
    expect(buildGatedDomainDenial("lane", () => "Anything")).toBeNull();
    expect(buildGatedDomainDenial("not_a_domain", () => "Anything")).toBeNull();
  });

  it("reads the display name out of the bundled package manifests", () => {
    const builtinPluginsRoot = writeBundledRoot({ "ade-app-control": "Electron Control" });

    expect(pluginDisplayNameFromCatalog("ade-app-control", {
      builtinPluginsRoot,
      pluginsRoot: writePluginsRoot({}),
    })).toBe("Electron Control");
  });

  it("falls back to the cached registry index when nothing is bundled", () => {
    const pluginsRoot = writePluginsRoot({});
    fs.writeFileSync(
      path.join(pluginsRoot, ".index-cache.json"),
      JSON.stringify({
        version: 1,
        url: "https://example.invalid/index.json",
        fetchedAt: "2026-08-01T00:00:00.000Z",
        index: {
          version: 1,
          generatedAt: "2026-08-01T00:00:00.000Z",
          entries: [{
            pluginId: "ade-community-thing",
            displayName: "Community Thing",
            version: "2.0.0",
            repo: "https://github.com/someone/ade-community-thing",
          }],
        },
      }),
    );

    expect(pluginDisplayNameFromCatalog("ade-community-thing", {
      builtinPluginsRoot: null,
      pluginsRoot,
    })).toBe("Community Thing");
    expect(pluginDisplayNameFromCatalog("ade-unknown", {
      builtinPluginsRoot: null,
      pluginsRoot,
    })).toBeNull();
  });
});

describe("buildSurfaceUnavailableDenial", () => {
  it("lets a superseded Simulator through on a machine WITHOUT the plugin", () => {
    expect(buildSurfaceUnavailableDenial("ios", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => "iOS Simulator",
    })).toBeNull();
  });

  it("refuses a superseded Simulator once the plugin owns it", () => {
    const denial = buildSurfaceUnavailableDenial("ios", {
      pluginsRoot: writePluginsRoot({ "ade-ios-sim": {} }),
      lookupDisplayName: () => "iOS Simulator",
    });

    expect(denial?.pluginId).toBe("ade-ios-sim");
    expect(denial?.message).toContain("ade-ios-sim plugin provides iOS Simulator");
  });

  /**
   * The superseded half, and it reads the other way round in BOTH directions.
   *
   * The sync command surface is how a paired phone and the web client reach
   * ADE's compiled Linear. A machine with no `ade-linear` must serve them, the
   * way it always has — so the verdict is `builtinSurfaceDrawn`, not
   * `builtinSurfaceInstalled`.
   */
  it("lets a superseded surface through on a machine WITHOUT the plugin", () => {
    expect(buildSurfaceUnavailableDenial("linear", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => "Linear",
    })).toBeNull();
    // Disabled counts as absent, and absent means ADE draws it.
    expect(buildSurfaceUnavailableDenial("linear", {
      pluginsRoot: writePluginsRoot({ "ade-linear": { enabled: false } }),
      lookupDisplayName: () => "Linear",
    })).toBeNull();
  });

  it("refuses a superseded surface once the plugin owns it", () => {
    const denial = buildSurfaceUnavailableDenial("linear", {
      pluginsRoot: writePluginsRoot({ "ade-linear": {} }),
      lookupDisplayName: () => "Linear",
    });

    expect(denial?.pluginId).toBe("ade-linear");
    expect(denial?.message).toContain("ade-linear plugin provides Linear");
  });

  it("never tells the user to install a plugin they already have", () => {
    // The copy inverts with the verdict. "This machine doesn't have Linear" is
    // the opposite of the truth here: the plugin arrived and took the surface
    // over, so the phone must be told to use the plugin's own screen.
    const denial = buildSurfaceUnavailableDenial("linear", {
      pluginsRoot: writePluginsRoot({ "ade-linear": {} }),
      lookupDisplayName: () => "Linear",
    });

    expect(denial?.message).not.toContain("doesn't have");
    expect(denial?.message).not.toContain("Marketplace");
  });
});

describe("plugin step refusal", () => {
  // An automation step names a plugin directly, so unlike the domain path it
  // has no generic error to fall back on: the sentence IS the run's
  // errorMessage. It therefore always answers, degrading the copy when the
  // catalog is cold rather than withholding it.
  it("uses the catalog's display name and points at the Marketplace", () => {
    expect(pluginStepUnavailableMessage("ade-linear", () => "Linear")).toBe(
      "This machine doesn't have Linear. It's provided by the ade-linear plugin — available in the Marketplace.",
    );
  });

  it("names the plugin id when no catalog can name the plugin", () => {
    expect(pluginStepUnavailableMessage("ade-linear", () => null)).toBe(
      "This machine doesn't have the ade-linear plugin.",
    );
    // No invented advice: the degraded sentence stops at the registered fact.
    expect(pluginStepUnavailableMessage("ade-linear", () => "   ")).not.toContain("Marketplace");
  });

  it("stays silent for an installed, enabled plugin", () => {
    expect(pluginStepUnavailableReason("ade-linear", {
      pluginsRoot: writePluginsRoot({ "ade-linear": {} }),
      lookupDisplayName: () => "Linear",
    })).toBeNull();
  });

  it("refuses a plugin that is installed but switched off", () => {
    // A disabled plugin's child never starts, so the invoke would fail anyway —
    // with the host's own wording rather than one naming what to switch on.
    expect(pluginStepUnavailableReason("ade-linear", {
      pluginsRoot: writePluginsRoot({ "ade-linear": { enabled: false } }),
      lookupDisplayName: () => "Linear",
    })).toContain("Linear");
  });

  it("refuses a plugin that was never installed", () => {
    expect(pluginStepUnavailableReason("ade-linear", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => null,
    })).toBe("This machine doesn't have the ade-linear plugin.");
  });
});

describe("gatedDomainUnavailableReason", () => {
  it("stays silent for a domain no plugin refuses, installed or not", () => {
    expect(gatedDomainUnavailableReason("ios_simulator", {
      pluginsRoot: writePluginsRoot({ "ade-ios-sim": {} }),
      lookupDisplayName: () => "iOS Simulator",
    })).toBeNull();
    expect(gatedDomainUnavailableReason("ios_simulator", {
      pluginsRoot: writePluginsRoot({ "ade-ios-sim": { enabled: false } }),
      lookupDisplayName: () => "iOS Simulator",
    })).toBeNull();
    expect(gatedDomainUnavailableReason("ios_simulator", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => "iOS Simulator",
    })).toBeNull();
  });

  it("stays silent for a domain no plugin gates", () => {
    // ADE's own domains are not a plugin's to refuse, installed or not.
    expect(gatedDomainUnavailableReason("lane", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => "Linear",
    })).toBeNull();
  });
});
