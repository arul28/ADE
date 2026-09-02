import { describe, expect, it } from "vitest";
import { normalizeProviderVersion } from "./providerUi";

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
