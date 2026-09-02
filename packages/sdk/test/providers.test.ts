import { describe, expect, it } from "vitest";
import {
  deriveProviderStatus,
  flattenCatalog,
  mergeProviderStatus,
  providerStatusFingerprint,
} from "../src/providers.js";
import { defaultCatalog } from "./mockRuntime.js";

describe("catalog derivation", () => {
  it("flattens every model across groups, providers and subsections", () => {
    const rows = flattenCatalog(defaultCatalog() as never);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ id: "gpt-5-codex", provider: "codex", connected: false });
  });

  it("treats a null catalog as no models and no providers", () => {
    expect(flattenCatalog(null)).toEqual([]);
    expect(deriveProviderStatus(null)).toEqual({});
  });

  it("marks a provider unauthenticated when nothing reports connected", () => {
    const status = deriveProviderStatus(defaultCatalog() as never);
    expect(status.claude!.authenticated).toBe(true);
    expect(status.codex!.authenticated).toBe(false);
    expect(status.codex!.requiresConfiguration).toBe(true);
  });

  it("marks every derived record as derived, with the probe fields null", () => {
    const status = deriveProviderStatus(defaultCatalog() as never);
    expect(status.claude).toMatchObject({
      source: "derived",
      // The honest derivation of "installed" from a catalog, and the reason a
      // UI must say "not detected" rather than "not installed" for these.
      installed: true,
      binaryPath: null,
      version: null,
      installCommand: null,
      loginCommand: null,
    });
    expect(typeof status.claude!.checkedAt).toBe("string");
  });
});

describe("provider status merge", () => {
  // A fixed `checkedAt`, so two derivations of the same catalog compare equal
  // rather than differing by whichever millisecond they were built in.
  const derived = () => deriveProviderStatus(defaultCatalog() as never, "2026-01-01T00:00:00.000Z");

  it("returns the derivation untouched when there is no probe", () => {
    expect(mergeProviderStatus(null, derived())).toEqual(derived());
  });

  it("takes the probe's measurements and the catalog's model facts", () => {
    const merged = mergeProviderStatus(
      {
        checkedAt: "2026-01-01T00:00:00.000Z",
        providers: {
          claude: {
            provider: "claude",
            displayName: "Claude Code",
            installed: true,
            binaryPath: "/usr/local/bin/claude",
            version: "1.0.99",
            authenticated: false,
            authMethod: "api-key",
            installCommand: "npm i -g claude",
            loginCommand: "claude login",
            docsUrl: "https://example.test",
            stale: false,
          },
        },
      },
      derived(),
    );
    expect(merged.claude).toMatchObject({
      source: "probed",
      installed: true,
      binaryPath: "/usr/local/bin/claude",
      version: "1.0.99",
      // The probe wins on auth even though the catalog says connected: a
      // credential file is a stronger signal than a cached catalog row.
      authenticated: false,
      authMethod: "api-key",
      // Only the catalog knows these three.
      available: true,
      modelCount: 2,
      requiresConfiguration: false,
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    // A provider the probe did not mention keeps its derived record, labelled.
    expect(merged.codex).toMatchObject({ source: "derived", binaryPath: null });
  });

  it("treats either half being cached as a stale record", () => {
    const catalog = defaultCatalog() as { stale: boolean };
    catalog.stale = true;
    const merged = mergeProviderStatus(
      {
        checkedAt: "2026-01-01T00:00:00.000Z",
        providers: { claude: { installed: true, stale: false } },
      },
      deriveProviderStatus(catalog as never),
    );
    expect(merged.claude!.stale).toBe(true);
  });

  it("fills a probe record's gaps rather than trusting undefined", () => {
    const merged = mergeProviderStatus(
      { checkedAt: "t", providers: { pi: {} } },
      derived(),
    );
    expect(merged.pi).toMatchObject({
      provider: "pi",
      displayName: "pi",
      installed: false,
      binaryPath: null,
      authenticated: false,
      modelCount: 0,
      available: false,
      source: "probed",
    });
  });

  it("notices an install or a login that moves no catalog field", () => {
    // The change a setup screen actually subscribes for. Before the probe
    // fields entered the fingerprint, installing a CLI mid-session fired
    // nothing, because the catalog had not refreshed yet.
    const before = derived();
    const after = mergeProviderStatus(
      {
        checkedAt: "t",
        providers: { claude: { installed: true, binaryPath: "/usr/local/bin/claude", authenticated: true } },
      },
      derived(),
    );
    expect(providerStatusFingerprint(before)).not.toBe(providerStatusFingerprint(after));
  });
});
