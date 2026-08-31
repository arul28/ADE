import { describe, expect, it } from "vitest";
import {
  ADE_RESERVED_MCP_SERVER_NAMES,
  CALLER_MCP_CAPABLE_PROVIDERS,
  CALLER_MCP_SUPPORT,
  MAX_CALLER_MCP_SERVERS,
  parseCallerMcpServers,
  callerMcpServersToCodexConfig,
  callerMcpServersToDroidList,
  callerMcpSupport,
  callerMcpUnsupportedTransport,
  normalizeCallerMcpCapability,
  normalizeCallerMcpServers,
  providerAcceptsCallerMcpServers,
  resolveCallerMcpCapability,
} from "./callerMcpServers";

describe("callerMcpServers", () => {
  describe("normalizeCallerMcpServers", () => {
    it("returns null rather than an empty object when nothing survives", () => {
      // Every injection site spreads `...(servers ? { mcpServers: servers } : {})`.
      // An empty object is truthy, so returning `{}` would attach an empty
      // mcpServers key to chats that asked for none — the exact drift the
      // "normal chats unchanged" invariant forbids.
      expect(normalizeCallerMcpServers(undefined)).toBeNull();
      expect(normalizeCallerMcpServers({})).toBeNull();
      expect(normalizeCallerMcpServers({ broken: { type: "http" } })).toBeNull();
      expect(normalizeCallerMcpServers([{ type: "http", url: "x" }])).toBeNull();
    });

    it("drops servers that cannot be handed to a provider verbatim", () => {
      expect(normalizeCallerMcpServers({
        noUrl: { type: "http" },
        noCommand: { type: "stdio", args: ["x"] },
        unknownType: { type: "grpc", url: "https://example.test" },
        blankUrl: { type: "sse", url: "   " },
        good: { type: "http", url: "https://example.test/mcp" },
      })).toEqual({ good: { type: "http", url: "https://example.test/mcp" } });
    });

    it("keeps only the optional fields that were actually supplied", () => {
      expect(normalizeCallerMcpServers({
        a: { type: "http", url: " https://example.test/mcp ", headers: { k: "v", bad: 1 } },
        b: { type: "stdio", command: " node ", args: ["s.js", 7], env: {} },
      })).toEqual({
        a: { type: "http", url: "https://example.test/mcp", headers: { k: "v" } },
        b: { type: "stdio", command: "node", args: ["s.js"] },
      });
    });
  });

  describe("CALLER_MCP_SUPPORT", () => {
    it("names a mechanism for every provider ADE ships", () => {
      expect(Object.keys(CALLER_MCP_SUPPORT).sort()).toEqual([
        "claude",
        "codex",
        "cursor",
        "droid",
        "opencode",
        "pi",
      ]);
    });

    it("names a delivery mechanism for every provider too", () => {
      // Delivery and strict mode used to live in two parallel maps keyed by
      // provider, which is two chances to add a provider to one of them.
      for (const [provider, support] of Object.entries(CALLER_MCP_SUPPORT)) {
        expect(support.delivery, `${provider} must describe how servers reach it`).toBeTruthy();
      }
    });

    it("attaches a residual to exactly the best-effort providers", () => {
      // A best-effort claim with no residual is a promise ADE cannot keep, and
      // an "enforced" claim with a residual is a lie. This is the invariant the
      // per-provider report to an SDK embedder rests on.
      for (const [provider, support] of Object.entries(CALLER_MCP_SUPPORT)) {
        if (support.level === "best-effort") {
          expect(support.residual, `${provider} must describe its residual`).toBeTruthy();
        } else {
          expect(support.residual, `${provider} must not claim a residual`).toBeNull();
        }
      }
    });

    it("reports Pi as having no MCP surface at all", () => {
      expect(callerMcpSupport("pi")?.level).toBe("unsupported");
      expect(providerAcceptsCallerMcpServers("pi")).toBe(false);
      expect(providerAcceptsCallerMcpServers("claude")).toBe(true);
    });

    it("returns null for a provider with no recorded decision", () => {
      expect(callerMcpSupport("some-future-provider")).toBeNull();
      expect(callerMcpSupport("constructor")).toBeNull();
    });

    it("refuses a provider with no recorded decision instead of failing open", () => {
      // `callerMcpSupport(p)?.level !== "unsupported"` was true for a
      // provider missing from the table — a new provider added without a
      // decision here would silently accept injected servers and drop them.
      expect(providerAcceptsCallerMcpServers("some-future-provider")).toBe(false);
      expect(providerAcceptsCallerMcpServers("constructor")).toBe(false);
      expect(providerAcceptsCallerMcpServers("")).toBe(false);
    });

    it("derives the capable-provider list from the table", () => {
      // The refusal message names these. A hand-written list drifts the moment
      // a provider is added.
      expect([...CALLER_MCP_CAPABLE_PROVIDERS].sort())
        .toEqual(["claude", "codex", "cursor", "droid", "opencode"]);
      expect(CALLER_MCP_CAPABLE_PROVIDERS).not.toContain("pi");
    });
  });

  describe("callerMcpUnsupportedTransport", () => {
    it("names the sse servers Codex has no client for", () => {
      // Codex's config has exactly `command` and `url`, and `url` is streamable
      // HTTP. An sse server handed over would be dialed as HTTP — connected to
      // the wrong protocol rather than refused.
      expect(callerMcpUnsupportedTransport("codex", {
        a: { type: "sse", url: "https://example.test/mcp" },
        b: { type: "http", url: "https://example.test/mcp" },
        c: { type: "sse", url: "https://example.test/two" },
      })).toEqual({ transport: "sse", names: ["a", "c"] });
    });

    it("returns null for an inherited Object.prototype key instead of throwing", () => {
      // The transports map was read with a bare index, so "constructor"
      // resolved to `Object.prototype.constructor` — truthy, `.length === 1` —
      // and the for..of over a function threw inside the create-path refusal
      // gate, turning an unknown provider into a crash.
      for (const junk of ["constructor", "toString", "hasOwnProperty", "__proto__", "nope"]) {
        expect(callerMcpUnsupportedTransport(junk, {
          a: { type: "sse", url: "https://example.test/mcp" },
        }), junk).toBeNull();
      }
    });

    it("clears Codex servers on transports it does speak, and every other provider", () => {
      expect(callerMcpUnsupportedTransport("codex", {
        a: { type: "http", url: "https://example.test/mcp" },
        b: { type: "stdio", command: "node" },
      })).toBeNull();
      expect(callerMcpUnsupportedTransport("claude", {
        a: { type: "sse", url: "https://example.test/mcp" },
      })).toBeNull();
    });
  });

  describe("resolveCallerMcpCapability", () => {
    it("reports a strict-only request on a strict-capable provider as delivered", () => {
      // `delivered` means "nothing the caller asked for was dropped", not
      // "servers exist" — a strict-only request has nothing to deliver.
      expect(resolveCallerMcpCapability("claude", { hasServers: false, strictRequested: true })).toEqual({
        level: "enforced",
        mechanism: CALLER_MCP_SUPPORT.claude.mechanism,
        residual: null,
        delivered: true,
        strictRequested: true,
      });
    });

    it("reports a strict-only request on a provider with no MCP surface as undelivered", () => {
      // The over-correction: gating `delivered` on the presence of servers made
      // this `true`, so a Pi session claimed a strict request was honored while
      // reporting there is no MCP surface to enforce anything on.
      expect(resolveCallerMcpCapability("pi", { hasServers: false, strictRequested: true })).toMatchObject({
        level: "unsupported",
        delivered: false,
      });
    });

    it("describes delivery only when strict mode was never requested", () => {
      // A Codex chat with servers and no strict request used to report the
      // strict mechanism and Codex's strict-mode residual — a caveat about an
      // enforcement ADE was not performing.
      const report = resolveCallerMcpCapability("codex", { hasServers: true, strictRequested: false });
      expect(report.strictRequested).toBe(false);
      expect(report.residual).toBeNull();
      expect(report.mechanism).not.toContain("enabled = false");
      expect(report.mechanism).toContain("mcp_servers");
      expect(report.delivered).toBe(true);
    });

    it("names both the delivery and the strict mechanism when both were asked for", () => {
      const report = resolveCallerMcpCapability("codex", { hasServers: true, strictRequested: true });
      expect(report.strictRequested).toBe(true);
      expect(report.mechanism).toContain(CALLER_MCP_SUPPORT.codex.mechanism);
      expect(report.residual).toBe(CALLER_MCP_SUPPORT.codex.residual);
    });

    it("reports a provider with no recorded decision as undelivered", () => {
      expect(resolveCallerMcpCapability("some-future-provider", { hasServers: true, strictRequested: true })).toEqual({
        level: "unsupported",
        mechanism: "No MCP decision is recorded for provider 'some-future-provider'.",
        residual: null,
        delivered: false,
        strictRequested: true,
      });
    });
  });

  describe("normalizeCallerMcpCapability", () => {
    it("drops a persisted residual when the report itself says strict was not requested", () => {
      // A residual names what strict mode could not exclude. A rehydrated
      // delivery-only report that still carries one would show the user a
      // caveat about an isolation this chat never asked for — the same gate
      // `resolveCallerMcpCapability` and the SDK's normalizer apply.
      expect(normalizeCallerMcpCapability({
        level: "best-effort",
        mechanism: "thread config overlay",
        residual: "a plugin-contributed server survives",
        delivered: true,
        strictRequested: false,
      })).toEqual({
        level: "best-effort",
        mechanism: "thread config overlay",
        residual: null,
        delivered: true,
        strictRequested: false,
      });
    });

    it("drops the residual when the strict fallback resolves to false", () => {
      // Pre-`strictRequested` records resolve through the session row's own
      // flag; when that says not-strict, the residual goes with it.
      expect(normalizeCallerMcpCapability({
        level: "best-effort",
        mechanism: "thread config overlay",
        residual: "a plugin-contributed server survives",
        delivered: true,
      }, false)).toMatchObject({ residual: null, strictRequested: false });
    });

    it("keeps the residual when strict mode was actually requested", () => {
      expect(normalizeCallerMcpCapability({
        level: "best-effort",
        mechanism: "thread config overlay",
        residual: "a plugin-contributed server survives",
        delivered: true,
      }, true)).toMatchObject({
        residual: "a plugin-contributed server survives",
        strictRequested: true,
      });
    });
  });

  describe("callerMcpServersToDroidList", () => {
    it("emits the exact shapes Droid's strict schema accepts", () => {
      // InitializeSessionRequestParams validates this list with a STRICT zod
      // union: the stdio variant has NO `type` key, and http/sse headers are an
      // ARRAY of { name, value } pairs. Spreading ADE's own shape failed both
      // rules at once and the session never initialized.
      expect(callerMcpServersToDroidList({
        local: { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" } },
        remote: { type: "http", url: "https://example.test/mcp", headers: { auth: "t", k: "v" } },
        events: { type: "sse", url: "https://example.test/sse" },
      })).toEqual([
        { name: "local", command: "node", args: ["s.js"], env: { A: "1" } },
        {
          type: "http",
          name: "remote",
          url: "https://example.test/mcp",
          headers: [{ name: "auth", value: "t" }, { name: "k", value: "v" }],
        },
        { type: "sse", name: "events", url: "https://example.test/sse" },
      ]);
      // No `type` on the stdio entry, at all — `.strict()` rejects unknown keys.
      expect(callerMcpServersToDroidList({ local: { type: "stdio", command: "node" } })[0])
        .not.toHaveProperty("type");
    });
  });

  describe("callerMcpServersToCodexConfig", () => {
    it("emits Codex's TOML keys and an explicit enabled flag", () => {
      // `enabled: true` is not redundant: a user's `[mcp_servers]` defaults
      // could otherwise leave a caller's server switched off, and strict mode
      // writes `enabled = false` into the same merged table.
      expect(callerMcpServersToCodexConfig({
        remote: { type: "sse", url: "https://example.test/mcp", headers: { auth: "t" } },
        local: { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" } },
      })).toEqual({
        remote: { url: "https://example.test/mcp", http_headers: { auth: "t" }, enabled: true },
        local: { command: "node", args: ["s.js"], env: { A: "1" }, enabled: true },
      });
    });
  });
});

/**
 * The create path must refuse what it cannot deliver. `normalizeCallerMcpServers`
 * drops the unusable, which is right for rehydrating a persisted record and
 * wrong for a caller's request: a dropped server hands back a chat quietly
 * missing tools it asked for.
 */
describe("parseCallerMcpServers", () => {
  const ok = { type: "http" as const, url: "https://example.test/mcp" };

  it("returns null for absent or empty input", () => {
    expect(parseCallerMcpServers(undefined)).toBeNull();
    expect(parseCallerMcpServers(null)).toBeNull();
    expect(parseCallerMcpServers({})).toBeNull();
  });

  it("names every offending key at once", () => {
    // One round trip per mistake would be a poor contract for a programmatic
    // caller assembling a config.
    let message = "";
    try {
      parseCallerMcpServers({ "bad name": ok, alsoBad: { type: "http" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("bad name");
    expect(message).toContain("alsoBad");
  });

  it("rejects a url that is not absolute http(s)", () => {
    for (const url of ["not-a-url", "/relative/path", "ftp://example.test/mcp"]) {
      expect(() => parseCallerMcpServers({ s: { type: "http", url } }), url).toThrow(/s/);
    }
    // file: would read local paths through whatever client the provider uses.
    expect(() => parseCallerMcpServers({ s: { type: "sse", url: "file:///etc/passwd" } }))
      .toThrow(/http: or https:/);
  });

  it("accepts a well-formed https server", () => {
    expect(parseCallerMcpServers({ good: ok })).toEqual({ good: ok });
  });

  it("rejects names outside the allowed character set", () => {
    for (const name of ["has space", "has/slash", "has.dot", "", "a".repeat(65)]) {
      expect(() => parseCallerMcpServers({ [name]: ok }), JSON.stringify(name)).toThrow();
    }
    expect(parseCallerMcpServers({ "a-b_C9": ok })).toBeTruthy();
  });

  it("rejects names ADE injects itself", () => {
    // A collision would shadow an ADE-managed server or be shadowed by it,
    // silently and differently per provider depending on merge order.
    for (const name of ADE_RESERVED_MCP_SERVER_NAMES) {
      expect(() => parseCallerMcpServers({ [name]: ok }), name).toThrow(/reserved/);
    }
  });

  it("caps the number of injected servers", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_CALLER_MCP_SERVERS + 1 }, (_, i) => [`s${i}`, ok]),
    );
    expect(() => parseCallerMcpServers(tooMany)).toThrow(/more than the/);
  });

  it("rejects an unsupported transport rather than dropping it", () => {
    expect(() => parseCallerMcpServers({ s: { type: "grpc", url: "https://example.test" } }))
      .toThrow(/unsupported type/);
  });
});

describe("normalizeCallerMcpServers stays lenient", () => {
  it("drops invalid entries instead of throwing, for the rehydration path", () => {
    // A corrupt persisted field must never make an existing chat unloadable.
    expect(normalizeCallerMcpServers({
      good: { type: "http", url: "https://example.test/mcp" },
      "bad name": { type: "http", url: "https://example.test/mcp" },
      computer_use: { type: "http", url: "https://example.test/mcp" },
      brokenUrl: { type: "http", url: "nope" },
    })).toEqual({ good: { type: "http", url: "https://example.test/mcp" } });
  });
});
