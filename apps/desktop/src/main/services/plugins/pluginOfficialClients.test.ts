import { afterEach, describe, expect, it } from "vitest";

import { PluginSdkError } from "../../../shared/plugins/sdk";
import { BUILTIN_SURFACE_OWNERS } from "../../../shared/plugins/builtinSurfaces";
import { ADE_LINEAR_APP_CLIENT_ID } from "../cto/linearAppClient";
import { assertNoClientSecret, officialOAuthClientForPlugin } from "./pluginOfficialClients";

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof PluginSdkError ? error.code : `threw:${String(error)}`;
  }
}

/**
 * The broker that closes the OAuth gap: a fresh install had no way to obtain
 * ADE's own `client_id`, so the only reachable connection was a pasted API key.
 *
 * Two properties matter and neither is about shape. A plugin that does not own
 * the built-in gets nothing, and NOBODY ever gets a client secret.
 */
describe("officialOAuthClientForPlugin", () => {
  const previousOverride = process.env.ADE_LINEAR_CLIENT_ID;

  afterEach(() => {
    if (previousOverride === undefined) delete process.env.ADE_LINEAR_CLIENT_ID;
    else process.env.ADE_LINEAR_CLIENT_ID = previousOverride;
  });

  it("lends the Linear plugin ADE's public client id, its authorize URL and its scopes", () => {
    delete process.env.ADE_LINEAR_CLIENT_ID;

    const answer = officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "linear" });

    expect(answer.provider).toBe("linear");
    expect(answer.clientId).toBe(ADE_LINEAR_APP_CLIENT_ID);
    expect(answer.authorizeUrl).toBe("https://linear.app/oauth/authorize");
    // `admin` is load-bearing: Linear only delivers data-change webhooks for a
    // workspace whose authorization carries it, so a plugin told the narrower
    // grant would build a connection whose webhooks silently never fire.
    expect(answer.scopes).toEqual(["read", "write", "admin"]);
  });

  it("never answers with a client secret, whatever the answer carries", () => {
    const answer = officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "linear" });

    for (const key of Object.keys(answer)) {
      expect(key.toLowerCase()).not.toContain("secret");
    }
    expect(answer).not.toHaveProperty("clientSecret");
    // The guard itself, not just the value it guarded. A later entry that
    // resolved its id out of a stored blob is the edit this catches, and a
    // guard that never fires is a guard nobody has tested.
    expect(() => assertNoClientSecret({
      provider: "linear",
      clientId: "public",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientSecret: "shhh",
    } as any)).toThrow(/refusing to answer/);
  });

  it("refuses every plugin that does not own the built-in surface", () => {
    // Owners of OTHER surfaces, not made-up ids: an `ade-graph` that declared
    // itself the Linear plugin is the attack this check exists for, and a test
    // using a nonexistent id would pass on the "no owner at all" branch instead.
    for (const owner of BUILTIN_SURFACE_OWNERS) {
      if (owner.builtinId === "linear") continue;
      expect(codeOf(() => officialOAuthClientForPlugin({
        pluginId: owner.ownerPluginId,
        provider: "linear",
      }))).toBe("not_permitted");
    }
    expect(codeOf(() => officialOAuthClientForPlugin({
      pluginId: "community-tracker",
      provider: "linear",
    }))).toBe("not_permitted");
  });

  it("refuses a provider ADE bundles no client for with the same code", () => {
    // Same code as a non-owner refusal, deliberately: a plugin able to tell the
    // two apart could enumerate which providers ADE has registered apps for by
    // asking for each in turn.
    expect(codeOf(() => officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "jira" })))
      .toBe("not_permitted");
  });

  it("matches the provider case-insensitively so one spelling is not a refusal", () => {
    expect(officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "  Linear " }).provider)
      .toBe("linear");
  });

  it("refuses an empty provider as invalid_args rather than as a permission", () => {
    expect(codeOf(() => officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "   " })))
      .toBe("invalid_args");
  });

  it("reads the environment override at call time, not at module load", () => {
    process.env.ADE_LINEAR_CLIENT_ID = "test-app-client-id";

    expect(officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "linear" }).clientId)
      .toBe("test-app-client-id");
  });

  it("falls back to the bundled id when the override is set but blank", () => {
    // A blank override is a misconfiguration, not an instruction to disable
    // sign-in. Treating it as one would take OAuth away from every user of a
    // build whose deploy script exported an empty variable.
    process.env.ADE_LINEAR_CLIENT_ID = "   ";

    expect(ADE_LINEAR_APP_CLIENT_ID.length).toBeGreaterThan(0);
    expect(officialOAuthClientForPlugin({ pluginId: "ade-linear", provider: "linear" }).clientId)
      .toBe(ADE_LINEAR_APP_CLIENT_ID);
  });
});
