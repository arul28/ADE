import { describe, expect, it } from "vitest";
import { readStoredKeySources, sourceMatchesRow } from "./harnessSources";

describe("harness key source identity", () => {
  it("keeps OpenCode custom provider credentials distinct when ids match", () => {
    const sources = readStoredKeySources(null, [], [
      {
        provider: "acme",
        credentialId: "work",
        label: "Acme",
        source: "store",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        provider: "other",
        credentialId: "work",
        label: "Other",
        source: "store",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    expect(sources).toHaveLength(2);
    expect(sourceMatchesRow(
      { kind: "key", provider: "acme", credentialId: "work", label: "Acme" },
      sources[0]!,
    )).toBe(true);
    expect(sourceMatchesRow(
      { kind: "key", provider: "other", credentialId: "work", label: "Other" },
      sources[0]!,
    )).toBe(false);
  });

  it("uses the shared default credential id for legacy provider rows", () => {
    const sources = readStoredKeySources(null, ["openai"], []);

    expect(sources).toEqual([
      expect.objectContaining({
        kind: "key",
        provider: "openai",
        credentialId: "default",
      }),
    ]);
  });
});
