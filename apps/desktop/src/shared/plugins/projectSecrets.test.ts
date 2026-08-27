/**
 * The declared-project-secrets contract, on the shared side.
 *
 * The same three-layers-in-one-file shape as `network.test.ts`, and for the
 * same reason: the name rule, the manifest field that uses it and the install
 * line that prints it are one promise — "a plugin reads only the project
 * secrets it declared, and you were told before you agreed". The enforcing
 * half lives with the plugin action bridge (`bootstrap.test.ts`); this file is
 * everything that runs before the plugin does.
 */

import { describe, expect, it } from "vitest";

import { describeManifestAdds } from "./installDisclosure";
import { parsePluginManifest, type PluginManifest } from "./manifest";
import { isValidProjectSecretName } from "../types/projectSecrets";

function manifestOf(overrides: Record<string, unknown> = {}): PluginManifest {
  const result = parsePluginManifest({
    name: "ade-billing",
    version: "1.0.0",
    displayName: "Billing",
    entry: "index.js",
    ...overrides,
  });
  if (!result.manifest) throw new Error(`manifest did not parse: ${result.errors.join("; ")}`);
  return result.manifest;
}

describe("isValidProjectSecretName", () => {
  it("accepts the names the secret store itself accepts", () => {
    expect(isValidProjectSecretName("STRIPE_API_KEY")).toBe(true);
    expect(isValidProjectSecretName("a.b-c_1")).toBe(true);
  });

  it("refuses a name the store could never hold", () => {
    expect(isValidProjectSecretName("1LEADING_DIGIT")).toBe(false);
    expect(isValidProjectSecretName("has space")).toBe(false);
    expect(isValidProjectSecretName("")).toBe(false);
    expect(isValidProjectSecretName(`A${"x".repeat(128)}`)).toBe(false);
  });
});

describe("manifest projectSecrets", () => {
  it("is absent when the manifest says nothing, which is the secure reading", () => {
    expect(manifestOf().projectSecrets).toBeUndefined();
  });

  it("keeps the declared names", () => {
    expect(manifestOf({ projectSecrets: ["STRIPE_API_KEY", "SENTRY_DSN"] }).projectSecrets)
      .toEqual(["STRIPE_API_KEY", "SENTRY_DSN"]);
  });

  it("drops a malformed name with a warning rather than failing the manifest", () => {
    const result = parsePluginManifest({
      name: "ade-billing",
      version: "1.0.0",
      projectSecrets: ["STRIPE_API_KEY", "not a name"],
    });
    expect(result.errors).toEqual([]);
    expect(result.manifest?.projectSecrets).toEqual(["STRIPE_API_KEY"]);
    expect(result.warnings.length).toBe(1);
  });

  it("caps how much of a .env one plugin may ask for", () => {
    const result = parsePluginManifest({
      name: "ade-billing",
      version: "1.0.0",
      projectSecrets: ["A", "B", "C", "D", "E", "F", "G"],
    });
    expect(result.manifest?.projectSecrets?.length).toBe(6);
    expect(result.warnings.length).toBe(1);
  });
});

describe("describeManifestAdds — the project secrets line", () => {
  it("names the secrets rather than counting them", () => {
    const adds = describeManifestAdds(manifestOf({ projectSecrets: ["STRIPE_API_KEY"] }));
    expect(adds).toContain("Reads this project's secrets (.env): STRIPE_API_KEY");
  });

  it("joins several into one readable line", () => {
    const adds = describeManifestAdds(
      manifestOf({ projectSecrets: ["SENTRY_DSN", "STRIPE_API_KEY"] }),
    );
    expect(adds).toContain("Reads this project's secrets (.env): SENTRY_DSN and STRIPE_API_KEY");
  });

  it("says nothing at all for a plugin that declares none", () => {
    const adds = describeManifestAdds(manifestOf());
    expect(adds.some((line) => line.startsWith("Reads this project's secrets"))).toBe(false);
  });

  it("comes last, after the network and provider-key lines", () => {
    const adds = describeManifestAdds(manifestOf({
      network: { hosts: ["api.stripe.com"] },
      providerKeys: ["cursor"],
      projectSecrets: ["STRIPE_API_KEY"],
    }));
    expect(adds[adds.length - 1]).toBe("Reads this project's secrets (.env): STRIPE_API_KEY");
  });
});
