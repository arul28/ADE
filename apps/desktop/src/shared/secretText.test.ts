import { describe, expect, it } from "vitest";
import { looksLikeSecret } from "./secretText";

describe("looksLikeSecret", () => {
  it("recognizes credential shapes, ignores paths, and stays bounded on repetitive input", () => {
    expect(looksLikeSecret(`ghp_${"a".repeat(36)}`)).toBe(true);
    expect(looksLikeSecret('api_key="abcd1234"')).toBe(true);
    expect(looksLikeSecret("~/projects/ade/.env.local")).toBe(false);

    const adversarial = "token-".repeat(3_333);
    const startedAt = performance.now();
    expect(looksLikeSecret(adversarial)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
