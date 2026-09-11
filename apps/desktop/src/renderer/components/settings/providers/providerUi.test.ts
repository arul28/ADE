import { describe, expect, it } from "vitest";
import { normalizeProviderVersion } from "./providerUi";
import { describeAuthenticatedAccount, describeCredentialSource } from "./cliTools";
import type { AiProviderConnectionStatus } from "../../../../shared/types";

describe("normalizeProviderVersion", () => {
  // The string that shipped to a tile as `vgrok 1.0.13 (5e9a58528b76) [stable]`
  // — binary name, commit hash, and channel tag, wider than the tile itself.
  it("keeps only the semver core of Grok's --version output", () => {
    expect(normalizeProviderVersion("grok 1.0.13 (5e9a58528b76) [stable]")).toBe("1.0.13");
  });

  it("leaves a bare version alone", () => {
    expect(normalizeProviderVersion("0.84.0")).toBe("0.84.0");
  });

  it("strips a leading v", () => {
    expect(normalizeProviderVersion("v1.2.3")).toBe("1.2.3");
  });

  it("keeps a prerelease suffix", () => {
    expect(normalizeProviderVersion("v2.0.0-beta.4")).toBe("2.0.0-beta.4");
  });

  // Pi marks a version it read from cache rather than from the SDK. That is
  // ADE's own annotation, not vendor noise, so it has to survive.
  it("preserves an ADE-appended annotation", () => {
    expect(normalizeProviderVersion("0.84.0 · cached")).toBe("0.84.0 · cached");
  });

  it("is idempotent", () => {
    const once = normalizeProviderVersion("grok 1.0.13 (5e9a58528b76) [stable]");
    expect(normalizeProviderVersion(once)).toBe(once);
  });

  it("returns null when nothing version-shaped is left", () => {
    expect(normalizeProviderVersion("unknown")).toBeNull();
    expect(normalizeProviderVersion("")).toBeNull();
    expect(normalizeProviderVersion(null)).toBeNull();
    expect(normalizeProviderVersion(undefined)).toBeNull();
    // A bare integer is not a version; printing "7" under a provider name
    // would be worse than printing nothing.
    expect(normalizeProviderVersion("7")).toBeNull();
  });
});

describe("describeAuthenticatedAccount", () => {
  const connection = (extra: Partial<AiProviderConnectionStatus>): AiProviderConnectionStatus => ({
    provider: "codex",
    authAvailable: true,
    runtimeDetected: true,
    runtimeAvailable: true,
    usageAvailable: true,
    path: null,
    blocker: null,
    lastCheckedAt: "2026-09-10T12:00:00.000Z",
    sources: [{ kind: "local-credentials", detected: true, source: "codex-auth-file" }],
    ...extra,
  });

  it("names the account and its plan", () => {
    expect(describeAuthenticatedAccount(connection({ accountEmail: "dev@example.com", accountPlan: "ChatGPT Pro" })))
      .toBe("Authenticated as dev@example.com · ChatGPT Pro");
    expect(describeAuthenticatedAccount(connection({ accountEmail: "dev@example.com" })))
      .toBe("Authenticated as dev@example.com");
    expect(describeAuthenticatedAccount(connection({}))).toBeNull();
  });

  it("leads the credential line, and falls back to the file when the account is unknown", () => {
    expect(describeCredentialSource(connection({ accountEmail: "dev@example.com", accountPlan: "ChatGPT Pro" })))
      .toBe("Authenticated as dev@example.com · ChatGPT Pro.");
    expect(describeCredentialSource(connection({})))
      .toBe("Local credentials found in ~/.codex/auth.json.");
  });
});
