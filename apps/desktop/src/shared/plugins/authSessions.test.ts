/**
 * The two auth contracts on the shared side: a host-brokered sign-in, and a
 * one-time handoff of a credential ADE already holds.
 *
 * The same three-layers-in-one-file shape as `projectSecrets.test.ts`, and for
 * the same reason: the manifest field, the install line that prints it and the
 * approval grant that remembers it are one promise — "this package can sign you
 * in to somebody, it can ask for a connection you already made, and you were
 * told both before you agreed". The enforcing halves live with the host
 * (`pluginAuthSessionService.test.ts`, `pluginCredentialHandoff.test.ts`); this
 * file is everything that runs before the plugin does.
 */

import { describe, expect, it } from "vitest";

import { describeManifestAdds } from "./installDisclosure";
import { parsePluginManifest, type PluginManifest } from "./manifest";
import { pluginApprovalGrant } from "../../main/services/plugins/pluginInstallApproval";
import {
  hasPluginActionAuthSessionRequest,
  readPluginActionAuthSession,
  readPluginActionAuthSessionRequest,
} from "./sdk";

function parse(overrides: Record<string, unknown> = {}): ReturnType<typeof parsePluginManifest> {
  return parsePluginManifest({
    name: "ade-linear",
    version: "1.0.0",
    displayName: "Linear",
    entry: "index.js",
    official: true,
    ...overrides,
  });
}

function manifestOf(overrides: Record<string, unknown> = {}): PluginManifest {
  const result = parse(overrides);
  if (!result.manifest) throw new Error(`manifest did not parse: ${result.errors.join("; ")}`);
  return result.manifest;
}

const LINEAR_FLOW = {
  id: "linear",
  provider: "Linear",
  authorizeUrl: "https://linear.app/oauth/authorize",
  callbacks: ["loopback", "app"],
  loopback: { port: 19836, path: "/oauth/callback" },
};

describe("authSessions parsing", () => {
  it("keeps a complete flow, both callbacks and all", () => {
    const manifest = manifestOf({ authSessions: [LINEAR_FLOW] });
    expect(manifest.authSessions).toEqual([{
      id: "linear",
      provider: "Linear",
      authorizeUrl: "https://linear.app/oauth/authorize",
      callbacks: ["loopback", "app"],
      loopback: { port: 19836, path: "/oauth/callback" },
    }]);
  });

  it("leaves the field absent when nothing is declared, which is the secure reading", () => {
    expect(manifestOf().authSessions).toBeUndefined();
  });

  it("refuses an authorize URL that is not https", () => {
    const result = parse({ authSessions: [{ ...LINEAR_FLOW, authorizeUrl: "http://linear.app/oauth" }] });
    expect(result.manifest?.authSessions).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("must be https");
  });

  it("refuses an authorize URL carrying userinfo, which reads as one host and resolves to another", () => {
    const result = parse({
      authSessions: [{ ...LINEAR_FLOW, authorizeUrl: "https://evil.example@linear.app/oauth/authorize" }],
    });
    expect(result.manifest?.authSessions).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("username or password");
  });

  it("refuses an authorize URL with a query, because the host builds the query", () => {
    const result = parse({
      authSessions: [{ ...LINEAR_FLOW, authorizeUrl: "https://linear.app/oauth/authorize?redirect_uri=x" }],
    });
    expect(result.manifest?.authSessions).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("query or fragment");
  });

  it("drops a loopback flow that names no port, rather than downgrading it to the relay", () => {
    const result = parse({
      authSessions: [{ ...LINEAR_FLOW, callbacks: ["loopback"], loopback: undefined }],
    });
    expect(result.manifest?.authSessions).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("loopback is required");
  });

  it("refuses a privileged port", () => {
    const result = parse({
      authSessions: [{ ...LINEAR_FLOW, loopback: { port: 80, path: "/oauth/callback" } }],
    });
    expect(result.manifest?.authSessions).toBeUndefined();
  });

  it("refuses a callback path that could escape its own segment", () => {
    const result = parse({
      authSessions: [{ ...LINEAR_FLOW, loopback: { port: 19836, path: "/oauth/../callback?x=1" } }],
    });
    expect(result.manifest?.authSessions).toBeUndefined();
  });

  it("keeps an app-only flow, which needs no loopback block at all", () => {
    const manifest = manifestOf({
      authSessions: [{ ...LINEAR_FLOW, callbacks: ["app"], loopback: undefined }],
    });
    expect(manifest.authSessions?.[0]?.callbacks).toEqual(["app"]);
    expect(manifest.authSessions?.[0]?.loopback).toBeUndefined();
  });

  it("refuses a flow that declares no callback at all", () => {
    const result = parse({ authSessions: [{ ...LINEAR_FLOW, callbacks: [] }] });
    expect(result.manifest?.authSessions).toBeUndefined();
  });

  it("keeps only the first of two flows sharing an id", () => {
    const manifest = manifestOf({
      authSessions: [LINEAR_FLOW, { ...LINEAR_FLOW, provider: "Impostor" }],
    });
    expect(manifest.authSessions).toHaveLength(1);
    expect(manifest.authSessions?.[0]?.provider).toBe("Linear");
  });
});

describe("credentialHandoff parsing", () => {
  it("keeps a built-in surface an official package names", () => {
    expect(manifestOf({ credentialHandoff: ["linear"] }).credentialHandoff).toEqual(["linear"]);
  });

  it("refuses the field for a community package", () => {
    const result = parse({ official: false, credentialHandoff: ["linear"] });
    expect(result.manifest?.credentialHandoff).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("official plugins");
  });

  it("refuses an id that is not a built-in surface", () => {
    const result = parse({ credentialHandoff: ["not-a-surface"] });
    expect(result.manifest?.credentialHandoff).toBeUndefined();
  });
});

describe("install disclosure", () => {
  it("says who it signs you in to, and names the port it listens on", () => {
    const lines = describeManifestAdds(manifestOf({ authSessions: [LINEAR_FLOW] }));
    expect(lines).toContain("Signs you in to Linear, and listens on port 19836 while you do");
  });

  it("says nothing about a port for a flow that binds none", () => {
    const lines = describeManifestAdds(manifestOf({
      authSessions: [{ ...LINEAR_FLOW, callbacks: ["app"], loopback: undefined }],
    }));
    expect(lines).toContain("Signs you in to Linear");
  });

  it("warns that the package will ask for a connection you already made", () => {
    const lines = describeManifestAdds(manifestOf({ credentialHandoff: ["linear"] }));
    // "Asks to use" and never "uses": the install is not the consent, and a
    // separate card is. A line that claimed the credential had moved would be
    // the card's job done by something the card has not asked yet.
    expect(lines).toContain("Asks to use the Linear connection you already set up in ADE");
  });

  it("says neither thing for a package that declares neither", () => {
    const lines = describeManifestAdds(manifestOf()).join("\n");
    expect(lines).not.toContain("Signs you in");
    expect(lines).not.toContain("Asks to use");
  });
});

describe("approval grant", () => {
  it("stays empty for a package that adds none of the disclosed capabilities", () => {
    expect(pluginApprovalGrant(manifestOf())).toBe("");
  });

  it("changes when a flow is repointed at a different provider, so the card is shown again", () => {
    const before = pluginApprovalGrant(manifestOf({ authSessions: [LINEAR_FLOW] }));
    const after = pluginApprovalGrant(manifestOf({
      authSessions: [{ ...LINEAR_FLOW, provider: "Somebody Else" }],
    }));
    expect(before).not.toBe(after);
  });

  it("changes when a flow moves to a different loopback port", () => {
    const before = pluginApprovalGrant(manifestOf({ authSessions: [LINEAR_FLOW] }));
    const after = pluginApprovalGrant(manifestOf({
      authSessions: [{ ...LINEAR_FLOW, loopback: { port: 19999, path: "/oauth/callback" } }],
    }));
    expect(before).not.toBe(after);
  });

  it("changes when a package starts asking for a built-in credential", () => {
    const before = pluginApprovalGrant(manifestOf());
    const after = pluginApprovalGrant(manifestOf({ credentialHandoff: ["linear"] }));
    expect(before).not.toBe(after);
  });

  it("does not change for a package that only reordered its declarations", () => {
    const flowB = { ...LINEAR_FLOW, id: "linear-eu", provider: "Linear EU", loopback: { port: 19837, path: "/cb" } };
    const one = pluginApprovalGrant(manifestOf({ authSessions: [LINEAR_FLOW, flowB] }));
    const two = pluginApprovalGrant(manifestOf({ authSessions: [flowB, LINEAR_FLOW] }));
    expect(one).toBe(two);
  });
});

describe("the authSession action result", () => {
  it("reads a plugin's half as a bare session id and nothing else", () => {
    expect(readPluginActionAuthSessionRequest({ authSession: { sessionId: "linear" } }))
      .toEqual({ sessionId: "linear" });
  });

  it("ignores a url a plugin tried to smuggle into its half", () => {
    // The plugin half has no `url` field at all, so a forged one is simply not
    // read. This is the property the whole result kind exists for: there is no
    // path by which a URL a plugin typed reaches a browser.
    const forged = readPluginActionAuthSessionRequest({
      authSession: { sessionId: "linear", url: "https://evil.example/steal" },
    });
    expect(forged).toEqual({ sessionId: "linear" });
    expect(readPluginActionAuthSession({
      authSession: { sessionId: "linear", url: "https://evil.example/steal" },
    })).toBeNull();
  });

  it("reads the host's stamped half only when it is complete", () => {
    expect(readPluginActionAuthSession({
      authSession: {
        sessionId: "linear",
        url: "https://linear.app/oauth/authorize?state=abc",
        transport: "app",
        callbackScheme: "ade",
      },
    })).toEqual({
      sessionId: "linear",
      url: "https://linear.app/oauth/authorize?state=abc",
      transport: "app",
      callbackScheme: "ade",
    });
    expect(readPluginActionAuthSession({
      authSession: { sessionId: "linear", url: "https://linear.app/x", transport: "carrier-pigeon" },
    })).toBeNull();
  });

  it("still reports a malformed request, so a dead Connect button is a logged line", () => {
    expect(hasPluginActionAuthSessionRequest({ authSession: {} })).toBe(true);
    expect(readPluginActionAuthSessionRequest({ authSession: {} })).toBeNull();
    expect(hasPluginActionAuthSessionRequest({ message: "no" })).toBe(false);
  });
});
