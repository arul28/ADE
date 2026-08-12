import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildGatedDomainDenial,
  buildMissingSurfaceDenial,
  pluginDisplayNameFromCatalog,
  pluginNotInstalledMessage,
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
  it("refuses every plugin-owned domain on a machine with no plugins", () => {
    const disabled = resolveDisabledActionDomains(writePluginsRoot({}));

    expect([...disabled].sort()).toEqual([
      "app_control",
      "ios_simulator",
      "linear_credentials",
      "linear_issue_tracker",
      "linear_oauth",
    ]);
  });

  it("opens exactly the installed plugin's domains and no others", () => {
    const disabled = resolveDisabledActionDomains(writePluginsRoot({ "ade-linear": {} }));

    expect(disabled.has("linear_issue_tracker")).toBe(false);
    expect(disabled.has("linear_credentials")).toBe(false);
    expect(disabled.has("linear_oauth")).toBe(false);
    expect(disabled.has("ios_simulator")).toBe(true);
  });

  it("treats a disabled plugin as absent", () => {
    const disabled = resolveDisabledActionDomains(
      writePluginsRoot({ "ade-ios-sim": { enabled: false } }),
    );

    expect(disabled.has("ios_simulator")).toBe(true);
  });

  it("never gates ADE's own domains", () => {
    const disabled = resolveDisabledActionDomains(writePluginsRoot({}));

    for (const domain of ["lane", "chat", "pr", "file", "git", "graph_state", "review"]) {
      expect(disabled.has(domain)).toBe(false);
    }
  });

  it("gates everything when the registry is unreadable rather than opening up", () => {
    const root = scratchDir("ade-gated-corrupt-");
    fs.writeFileSync(path.join(root, "state.json"), "{ not json");

    expect(resolveDisabledActionDomains(root).has("linear_issue_tracker")).toBe(true);
  });
});

describe("refusal copy", () => {
  it("names the plugin using the catalog's display name, not a hardcoded label", () => {
    const denial = buildGatedDomainDenial("linear_issue_tracker", () => "Linear");

    expect(denial?.message).toBe(
      "This machine doesn't have Linear. It's provided by the ade-linear plugin — available in the Marketplace.",
    );
    expect(denial?.pluginId).toBe("ade-linear");
    expect(denial?.data).toEqual({
      kind: "plugin_not_installed",
      domain: "linear_issue_tracker",
      pluginId: "ade-linear",
    });
  });

  it("invents no hint when no catalog can name the owner", () => {
    expect(buildGatedDomainDenial("ios_simulator", () => null)).toBeNull();
    expect(pluginNotInstalledMessage("ade-ios-sim", () => "  ")).toBeNull();
  });

  it("says nothing about a domain no plugin owns", () => {
    expect(buildGatedDomainDenial("lane", () => "Anything")).toBeNull();
    expect(buildGatedDomainDenial("not_a_domain", () => "Anything")).toBeNull();
  });

  it("reads the display name out of the bundled package manifests", () => {
    const builtinPluginsRoot = writeBundledRoot({ "ade-app-control": "App Control" });

    expect(pluginDisplayNameFromCatalog("ade-app-control", {
      builtinPluginsRoot,
      pluginsRoot: writePluginsRoot({}),
    })).toBe("App Control");
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

describe("buildMissingSurfaceDenial", () => {
  it("refuses a surface whose plugin is absent", () => {
    const denial = buildMissingSurfaceDenial("linear", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => "Linear",
    });

    expect(denial?.pluginId).toBe("ade-linear");
    expect(denial?.message).toContain("ade-linear plugin");
  });

  it("lets the call through once the plugin is installed", () => {
    expect(buildMissingSurfaceDenial("linear", {
      pluginsRoot: writePluginsRoot({ "ade-linear": {} }),
      lookupDisplayName: () => "Linear",
    })).toBeNull();
  });

  it("still refuses with a cold catalog — the catalog decides the advice, not the verdict", () => {
    // Failing open here would leave every paired phone reading and writing
    // through a plugin the machine no longer has, just because the display
    // name was unavailable.
    const denial = buildMissingSurfaceDenial("linear", {
      pluginsRoot: writePluginsRoot({}),
      lookupDisplayName: () => null,
    });

    expect(denial?.pluginId).toBe("ade-linear");
    expect(denial?.message).toBe("This machine doesn't have the ade-linear plugin.");
    expect(denial?.message).not.toContain("Marketplace");
  });
});
