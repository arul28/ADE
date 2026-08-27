/**
 * The declared-network contract, end to end on the shared side.
 *
 * Three layers in one file on purpose: the validator, the manifest field that
 * uses it and the install line that prints it are one promise — "a plugin
 * reaches only what it declared, and you were told before you agreed" — and a
 * regression in any one of them breaks that promise the same way. The child's
 * half is proven in `pluginChildNetworkGuard.test.ts`; this file is everything
 * that runs before the plugin does.
 */

import { describe, expect, it } from "vitest";

import { describeManifestAdds } from "./installDisclosure";
import { parsePluginManifest, type PluginManifest } from "./manifest";
import {
  isValidPluginNetworkHost,
  normalizePluginNetworkHost,
  pluginNetworkHostAllowed,
  pluginNetworkRefusalMessage,
} from "./network";

function manifestOf(overrides: Record<string, unknown> = {}): PluginManifest {
  const result = parsePluginManifest({
    name: "ade-cursor-cloud",
    version: "1.0.0",
    displayName: "Cursor Cloud",
    entry: "index.js",
    official: true,
    ...overrides,
  });
  if (!result.manifest) throw new Error(`manifest did not parse: ${result.errors.join("; ")}`);
  return result.manifest;
}

describe("isValidPluginNetworkHost", () => {
  it("accepts a plain hostname and a one-level wildcard", () => {
    expect(isValidPluginNetworkHost("api.cursor.com")).toBe(true);
    expect(isValidPluginNetworkHost("huggingface.co")).toBe(true);
    expect(isValidPluginNetworkHost("*.hf.co")).toBe(true);
  });

  it("accepts localhost, the one name that stands alone", () => {
    expect(isValidPluginNetworkHost("localhost")).toBe(true);
  });

  it("refuses a scheme, a port, a path or a query", () => {
    expect(isValidPluginNetworkHost("https://api.cursor.com")).toBe(false);
    expect(isValidPluginNetworkHost("api.cursor.com:443")).toBe(false);
    expect(isValidPluginNetworkHost("api.cursor.com/v1")).toBe(false);
    expect(isValidPluginNetworkHost("api.cursor.com?x=1")).toBe(false);
  });

  it("refuses an IP literal in either family", () => {
    expect(isValidPluginNetworkHost("127.0.0.1")).toBe(false);
    expect(isValidPluginNetworkHost("10.0.0.1")).toBe(false);
    expect(isValidPluginNetworkHost("*.10.0.0.1")).toBe(false);
    expect(isValidPluginNetworkHost("::1")).toBe(false);
    expect(isValidPluginNetworkHost("[::1]")).toBe(false);
  });

  it("refuses a wildcard that claims a whole registry, or everything", () => {
    expect(isValidPluginNetworkHost("*")).toBe(false);
    expect(isValidPluginNetworkHost("*.com")).toBe(false);
    expect(isValidPluginNetworkHost("*.")).toBe(false);
  });

  it("refuses uppercase rather than folding it, so one host has one spelling", () => {
    expect(isValidPluginNetworkHost("API.cursor.com")).toBe(false);
  });

  it("refuses a wildcard anywhere but the front", () => {
    expect(isValidPluginNetworkHost("api.*.com")).toBe(false);
    expect(isValidPluginNetworkHost("*api.cursor.com")).toBe(false);
  });
});

describe("pluginNetworkHostAllowed", () => {
  it("matches an exact host and nothing near it", () => {
    expect(pluginNetworkHostAllowed("api.cursor.com", ["api.cursor.com"])).toBe(true);
    expect(pluginNetworkHostAllowed("cursor.com", ["api.cursor.com"])).toBe(false);
    expect(pluginNetworkHostAllowed("api.cursor.com.evil.test", ["api.cursor.com"])).toBe(false);
  });

  it("matches a wildcard at ANY depth, which is what the real redirect needs", () => {
    // `huggingface.co/.../resolve/main/...` answers 302 to a four-label CDN
    // host. A one-level wildcard would have failed the first download it was
    // asked to allow.
    expect(pluginNetworkHostAllowed("us.aws.cdn.hf.co", ["*.hf.co"])).toBe(true);
    expect(pluginNetworkHostAllowed("cdn.hf.co", ["*.hf.co"])).toBe(true);
  });

  it("does not let a wildcard match the apex, or a host that merely ends in the letters", () => {
    expect(pluginNetworkHostAllowed("hf.co", ["*.hf.co"])).toBe(false);
    expect(pluginNetworkHostAllowed("evilhf.co", ["*.hf.co"])).toBe(false);
  });

  it("ignores case and a trailing dot, which are the same host", () => {
    expect(pluginNetworkHostAllowed("API.Cursor.COM", ["api.cursor.com"])).toBe(true);
    expect(pluginNetworkHostAllowed("api.cursor.com.", ["api.cursor.com"])).toBe(true);
  });

  it("refuses everything when nothing is declared", () => {
    expect(pluginNetworkHostAllowed("api.cursor.com", [])).toBe(false);
    expect(pluginNetworkHostAllowed("localhost", [])).toBe(false);
  });

  it("refuses an IP literal, because no manifest can declare one", () => {
    expect(pluginNetworkHostAllowed("127.0.0.1", ["localhost"])).toBe(false);
    expect(pluginNetworkHostAllowed("[::1]", ["localhost"])).toBe(false);
  });
});

describe("normalizePluginNetworkHost", () => {
  it("lowercases and drops the fully-qualified trailing dot", () => {
    expect(normalizePluginNetworkHost("API.Cursor.COM.")).toBe("api.cursor.com");
  });

  it("answers null for a blank or non-string host", () => {
    expect(normalizePluginNetworkHost("   ")).toBeNull();
    expect(normalizePluginNetworkHost(undefined)).toBeNull();
  });
});

describe("pluginNetworkRefusalMessage", () => {
  it("names the host, the plugin and the fix", () => {
    const message = pluginNetworkRefusalMessage({
      pluginId: "ade-cursor-cloud",
      host: "evil.test",
      declared: ["api.cursor.com"],
    });
    expect(message).toContain("evil.test");
    expect(message).toContain("ade-cursor-cloud");
    expect(message).toContain("api.cursor.com");
    expect(message).toContain("network");
  });

  it("says a plugin declares nothing rather than printing an empty list", () => {
    const message = pluginNetworkRefusalMessage({
      pluginId: "hello-plugin",
      host: "evil.test",
      declared: [],
    });
    expect(message).toContain("declares no outbound network");
  });
});

describe("parsePluginManifest — network", () => {
  it("carries a declared host list", () => {
    const manifest = manifestOf({ network: { hosts: ["api.cursor.com"] } });
    expect(manifest.network).toEqual({ hosts: ["api.cursor.com"] });
  });

  it("leaves the field absent when nothing is declared", () => {
    expect(manifestOf().network).toBeUndefined();
  });

  it("collapses an empty list to absent, so 'no network' has one spelling", () => {
    expect(manifestOf({ network: { hosts: [] } }).network).toBeUndefined();
  });

  it("drops a bad host with a warning and keeps the good ones", () => {
    const result = parsePluginManifest({
      name: "ade-cursor-cloud",
      version: "1.0.0",
      network: { hosts: ["api.cursor.com", "https://evil.test", "127.0.0.1"] },
    });
    expect(result.errors).toEqual([]);
    expect(result.manifest?.network).toEqual({ hosts: ["api.cursor.com"] });
    expect(result.warnings.length).toBe(2);
  });

  it("errors on a malformed container rather than silently granting nothing", () => {
    const result = parsePluginManifest({
      name: "ade-cursor-cloud",
      version: "1.0.0",
      network: ["api.cursor.com"],
    });
    expect(result.errors).toContain("network must be an object with a hosts array");
  });

  it("caps the list at eight hosts", () => {
    const hosts = Array.from({ length: 10 }, (_, index) => `h${index}.example.com`);
    const result = parsePluginManifest({ name: "big", version: "1.0.0", network: { hosts } });
    expect(result.manifest?.network?.hosts.length).toBe(8);
    expect(result.warnings.some((warning) => warning.includes("network.hosts"))).toBe(true);
  });
});

describe("parsePluginManifest — providerKeys", () => {
  it("carries a declared provider", () => {
    expect(manifestOf({ providerKeys: ["cursor"] }).providerKeys).toEqual(["cursor"]);
  });

  it("leaves the field absent when nothing is declared", () => {
    expect(manifestOf().providerKeys).toBeUndefined();
  });

  it("drops a provider ADE stores no key for", () => {
    const result = parsePluginManifest({
      name: "ade-cursor-cloud",
      version: "1.0.0",
      providerKeys: ["cursor", "not-a-provider"],
    });
    expect(result.errors).toEqual([]);
    expect(result.manifest?.providerKeys).toEqual(["cursor"]);
    expect(result.warnings.length).toBe(1);
  });
});

describe("describeManifestAdds — the two capability lines", () => {
  it("says which hosts the plugin talks to", () => {
    const adds = describeManifestAdds(manifestOf({ network: { hosts: ["api.cursor.com"] } }));
    expect(adds).toContain("Talks to api.cursor.com");
  });

  it("joins several hosts into one readable line", () => {
    const adds = describeManifestAdds(
      manifestOf({ network: { hosts: ["huggingface.co", "*.hf.co"] } }),
    );
    expect(adds).toContain("Talks to huggingface.co and *.hf.co");
  });

  it("names the provider key in the words the user knows it by", () => {
    const adds = describeManifestAdds(manifestOf({ providerKeys: ["cursor"] }));
    expect(adds).toContain("Uses your Cursor API key");
  });

  it("pluralizes two provider keys", () => {
    const adds = describeManifestAdds(manifestOf({ providerKeys: ["cursor", "openai"] }));
    expect(adds).toContain("Uses your Cursor and OpenAI API keys");
  });

  it("says neither line for a plugin that declares neither", () => {
    const adds = describeManifestAdds(manifestOf());
    expect(adds.some((line) => line.startsWith("Talks to"))).toBe(false);
    expect(adds.some((line) => line.startsWith("Uses your"))).toBe(false);
  });
});
