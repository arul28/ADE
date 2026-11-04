// @vitest-environment node

import { createHash } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMcpOAuthSignIns,
  isAllowedMcpAuthEndpoint,
} from "./mcpOAuth";
import { createMcpRegistryService, type McpRegistryVault } from "./mcpRegistryService";
import {
  mcpOAuthVaultKey,
  mcpRegistryToCallerServers,
  mcpSecretVaultKey,
  type McpOAuthToken,
  type McpRegistryServer,
} from "../../../shared/mcpRegistry";
import type { AccountVaultItem, AccountVaultResult } from "../../../shared/types/accountVault";

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

type FakeOAuthOptions = {
  probeStatus?: number;
  authorizationServer?: string;
  registration?: boolean;
  /** The `resource` the protected-resource metadata claims; defaults to the MCP URL. */
  resource?: string;
  holdResourceMetadata?: Deferred;
  holdToken?: Deferred;
};

type FakeOAuthServer = {
  origin: string;
  mcpUrl: string;
  server: http.Server;
  registrations: Array<Record<string, unknown>>;
  tokens: Array<URLSearchParams>;
  waitFor: (path: string) => Promise<void>;
  close: () => Promise<void>;
};

async function startOAuthServer(options: FakeOAuthOptions = {}): Promise<FakeOAuthServer> {
  const registrations: Array<Record<string, unknown>> = [];
  const tokens: Array<URLSearchParams> = [];
  const seen = new Map<string, Deferred>();
  const hit = (path: string) => {
    let signal = seen.get(path);
    if (!signal) seen.set(path, signal = deferred());
    signal.resolve();
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/mcp") {
      hit("/mcp");
      if ((options.probeStatus ?? 401) === 401) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${(server.address() as { port: number }).port}/.well-known/oauth-protected-resource/mcp"`,
        }).end();
      } else response.writeHead(options.probeStatus ?? 200).end();
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      hit(url.pathname);
      await options.holdResourceMetadata?.promise;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        resource: options.resource ?? `${origin}/mcp`,
        authorization_servers: [options.authorizationServer ?? origin],
        scopes_supported: ["tools"],
      }));
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      hit(url.pathname);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(options.registration === false ? {} : { registration_endpoint: `${origin}/register` }),
        code_challenge_methods_supported: ["S256"],
      }));
      return;
    }
    if (url.pathname === "/register") {
      hit(url.pathname);
      registrations.push(JSON.parse(await bodyOf(request)) as Record<string, unknown>);
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ client_id: "ade-client" }));
      return;
    }
    if (url.pathname === "/token") {
      hit(url.pathname);
      tokens.push(new URLSearchParams(await bodyOf(request)));
      await options.holdToken?.promise;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
        scope: "tools",
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    server,
    registrations,
    tokens,
    waitFor: (path) => {
      let signal = seen.get(path);
      if (!signal) seen.set(path, signal = deferred());
      return signal.promise;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const servers: FakeOAuthServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fakeServer(options?: FakeOAuthOptions): Promise<FakeOAuthServer> {
  const server = await startOAuthServer(options);
  servers.push(server);
  return server;
}

function serverConfig(name: string, url: string, extra: Partial<McpRegistryServer> = {}): McpRegistryServer {
  return { name, transport: "http", url, envNames: [], headerNames: [], enabled: true, ...extra };
}

async function completeBrowserRedirect(authorizeUrl: string, code = "auth-code"): Promise<Response> {
  const authorize = new URL(authorizeUrl);
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", authorize.searchParams.get("state")!);
  return fetch(redirect);
}

function memoryVault(): McpRegistryVault & { values: Map<string, string> } {
  const values = new Map<string, string>();
  const ok = <T>(value: T): AccountVaultResult<T> => ({ ok: true, value });
  return {
    values,
    async list() {
      return ok([...values].map(([key, value]): AccountVaultItem => ({ scope: "all", kind: "secret", key, value, updatedAt: "now" })));
    },
    async get(_scope, _kind, key) { return ok(values.get(key) ?? null); },
    async set(_scope, _kind, key, value) { values.set(key, value); return ok(null); },
    async remove(_scope, _kind, key) { values.delete(key); return ok(null); },
  };
}

function tokenFor(url: string, patch: Partial<McpOAuthToken> = {}): McpOAuthToken {
  return {
    v: 1,
    url,
    accessToken: "launch-secret",
    refreshToken: null,
    expiresAt: null,
    scope: null,
    clientId: "client",
    clientSecret: null,
    tokenEndpoint: "https://auth.example/token",
    resource: url,
    ...patch,
  };
}

describe("MCP OAuth sign-in", () => {
  it("discovers, registers, completes PKCE and closes its loopback listener", async () => {
    const fake = await fakeServer();
    const before = Date.now();
    let authorizeUrl = "";
    const signIns = createMcpOAuthSignIns({
      openUrl: async (url) => { authorizeUrl = url; await completeBrowserRedirect(url); },
    });
    const outcome = await signIns.signIn({ name: "Docs", url: fake.mcpUrl });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const authorize = new URL(authorizeUrl);
    const request = fake.tokens[0]!;
    const verifier = request.get("code_verifier")!;
    expect(Date.parse(outcome.token.expiresAt!)).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(request.get("grant_type")).toBe("authorization_code");
    expect(request.get("code")).toBe("auth-code");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"));
    expect(request.get("resource")).toBe(fake.mcpUrl);
    expect(new URL(fake.registrations[0]!.redirect_uris instanceof Array ? String((fake.registrations[0]!.redirect_uris as string[])[0]) : "").toString())
      .toBe(authorize.searchParams.get("redirect_uri"));
    await expect(fetch(authorize.searchParams.get("redirect_uri")!)).rejects.toThrow();
    signIns.dispose();
  });

  it.each([
    ["https remote", "https://auth.example/path", "http://127.0.0.1:5000/mcp", true],
    ["loopback HTTP for loopback MCP", "http://localhost:5000/auth", "http://127.0.0.1:5000/mcp", true],
    ["loopback HTTP for HTTPS MCP", "http://127.0.0.1/auth", "https://mcp.example/mcp", false],
    ["private IP HTTP", "http://10.0.0.5/auth", "http://127.0.0.1:5000/mcp", false],
    ["embedded credentials", "https://user:pass@auth.example", "https://mcp.example", false],
    ["unparsable URL", "not a URL", "https://mcp.example", false],
  ])("applies auth endpoint rules to %s", (_label, endpoint, mcp, allowed) => {
    expect(isAllowedMcpAuthEndpoint(endpoint, new URL(mcp))).toBe(allowed);
    expect(isAllowedMcpAuthEndpoint("https://auth.example/token", new URL(mcp))).toBe(true);
    expect(isAllowedMcpAuthEndpoint("http://10.0.0.5/token", new URL(mcp))).toBe(false);
  });

  it("refuses a metadata authorization server on a private address before opening the browser", async () => {
    const fake = await fakeServer({ authorizationServer: "http://10.0.0.5" });
    let opened = false;
    const outcome = await createMcpOAuthSignIns({ openUrl: async () => { opened = true; } })
      .signIn({ name: "Docs", url: fake.mcpUrl });
    expect(outcome.ok).toBe(false);
    expect(opened).toBe(false);
    expect(fake.registrations).toHaveLength(0);
  });

  it.each(["discovery", "browser", "token"] as const)("cancels an in-flight sign-in during %s", async (stage) => {
    const resourceGate = deferred();
    const tokenGate = deferred();
    const fake = await fakeServer({
      ...(stage === "discovery" ? { holdResourceMetadata: resourceGate } : {}),
      ...(stage === "token" ? { holdToken: tokenGate } : {}),
    });
    const opened = deferred<string>();
    const signIns = createMcpOAuthSignIns({
      openUrl: async (url) => {
        opened.resolve(url);
        if (stage === "token") void completeBrowserRedirect(url).catch(() => undefined);
        if (stage === "browser") await new Promise<void>(() => {});
      },
    });
    const attempt = signIns.signIn({ name: "Docs", url: fake.mcpUrl });
    if (stage === "discovery") await fake.waitFor("/.well-known/oauth-protected-resource/mcp");
    if (stage === "browser") await opened.promise;
    if (stage === "token") await fake.waitFor("/token");
    expect(signIns.cancel("Docs")).toBe(true);
    const outcome = await attempt;
    expect(outcome.ok).toBe(false);
    expect("cancelled" in outcome && outcome.cancelled).toBe(true);
    if (stage === "token") expect("token" in outcome).toBe(false);
    resourceGate.resolve();
    tokenGate.resolve();
    signIns.dispose();
  });

  it("cancels an older same-name sign-in and lets the newer one finish", async () => {
    const fake = await fakeServer();
    const firstOpen = deferred();
    const firstOpened = deferred();
    let openCount = 0;
    const signIns = createMcpOAuthSignIns({ openUrl: async (url) => {
      openCount += 1;
      if (openCount === 1) { firstOpened.resolve(); await firstOpen.promise; return; }
      await completeBrowserRedirect(url, "second-code");
    } });
    const first = signIns.signIn({ name: "Docs", url: fake.mcpUrl });
    await firstOpened.promise;
    const second = signIns.signIn({ name: "Docs", url: fake.mcpUrl });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: false, cancelled: true });
    expect(secondResult.ok).toBe(true);
    expect(fake.tokens.map((token) => token.get("code"))).toContain("second-code");
    firstOpen.resolve();
    signIns.dispose();
  });

  it("rejects a wrong callback state, then accepts one callback and refuses its replay", async () => {
    const tokenGate = deferred();
    const fake = await fakeServer({ holdToken: tokenGate });
    let wrongStatus = 0;
    let replayStatus = 0;
    let callbackResponse: Promise<Response> | undefined;
    const signIns = createMcpOAuthSignIns({ openUrl: async (url) => {
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "auth-code");
      redirect.searchParams.set("state", "wrong-state");
      wrongStatus = (await fetch(redirect)).status;
      redirect.searchParams.set("state", authorize.searchParams.get("state")!);
      callbackResponse = fetch(redirect);
      await fake.waitFor("/token");
      replayStatus = (await fetch(redirect)).status;
      tokenGate.resolve();
      await callbackResponse;
    } });
    const result = await signIns.signIn({ name: "Docs", url: fake.mcpUrl });
    expect(wrongStatus).toBe(400);
    expect(result.ok).toBe(true);
    expect(replayStatus).toBe(400);
    expect(fake.tokens).toHaveLength(1);
    signIns.dispose();
  });

  it.each([
    ["open server", { probeStatus: 200 } as FakeOAuthOptions],
    ["server without dynamic registration", { registration: false } as FakeOAuthOptions],
    ["metadata naming another server's resource", { resource: "https://other.example/mcp" } as FakeOAuthOptions],
  ])("does not open a browser for an unsupported flow: %s", async (_label, options) => {
    const fake = await fakeServer(options);
    let opened = false;
    const result = await createMcpOAuthSignIns({ openUrl: async () => { opened = true; } })
      .signIn({ name: "Docs", url: fake.mcpUrl });
    expect(result.ok).toBe(false);
    expect(opened).toBe(false);
    expect(fake.registrations).toHaveLength(0);
  });
});

describe("MCP launch authorization headers", () => {
  it.each([
    ["valid sign-in", "Docs", "https://mcp.example/mcp", tokenFor("https://mcp.example/mcp"), {}, "Bearer launch-secret", []],
    ["user authorization wins case-insensitively", "Docs", "https://mcp.example/mcp", tokenFor("https://mcp.example/mcp"), { aUtHoRiZaTiOn: "Basic user-value" }, "Basic user-value", []],
    ["different URL", "Docs", "https://mcp.example/changed", tokenFor("https://mcp.example/old"), {}, undefined, []],
    ["expired sign-in", "Docs", "https://mcp.example/mcp", tokenFor("https://mcp.example/mcp", { expiresAt: "2000-01-01T00:00:00.000Z" }), {}, undefined, ["Docs"]],
    ["stdio server", "Tool", undefined, tokenFor("https://mcp.example/mcp"), {}, undefined, []],
  ] as const)("hands off the right credentials for %s", (_label, name, url, token, configuredHeaders, authorization, expired) => {
    const server = serverConfig(name, url ?? "", {
      transport: url ? "http" : "stdio",
      command: url ? undefined : "tool",
      headerNames: Object.keys(configuredHeaders),
    });
    const result = mcpRegistryToCallerServers([server], { machine: [], project: [] }, (key) => {
      if (key === mcpOAuthVaultKey(name)) return JSON.stringify(token);
      if (key === mcpSecretVaultKey(name, "header", "aUtHoRiZaTiOn")) return (configuredHeaders as { aUtHoRiZaTiOn?: string }).aUtHoRiZaTiOn ?? null;
      return null;
    });
    const config = result.servers?.[name];
    expect(config?.type).toBe(url ? "http" : "stdio");
    expect(config && "headers" in config ? config.headers?.Authorization ?? config.headers?.aUtHoRiZaTiOn : undefined).toBe(authorization);
    expect(result.signInExpired).toEqual(expired);
  });
});

describe("MCP registry OAuth service", () => {
  it("stores sign-in privately, reports state without the token, and prunes it with the server", async () => {
    const fake = await fakeServer();
    const vault = memoryVault();
    const service = createMcpRegistryService({
      vault,
      adeHome: "/tmp/ade-mcp-oauth-test",
      commandExists: () => true,
      openUrl: async (url) => { await completeBrowserRedirect(url); },
    });
    const docs = serverConfig("Docs", fake.mcpUrl);
    const signedIn = await service.signIn(docs);
    const key = mcpOAuthVaultKey("Docs");
    const check = await service.check([docs]);
    expect(signedIn.ok).toBe(true);
    expect(vault.values.has(key)).toBe(true);
    expect(check.ok && check.value.signIns).toMatchObject([{ server: "Docs", state: "valid" }]);
    expect(JSON.stringify(check)).not.toContain("access-secret");
    const unsigned = await service.check([serverConfig("Unsigned", fake.mcpUrl)]);
    expect(unsigned.ok && unsigned.value.signIns).toMatchObject([{ server: "Unsigned", state: "needed" }]);
    const headerAuth = await service.check([serverConfig("HeaderAuth", fake.mcpUrl, { headerNames: ["Authorization"] })]);
    expect(headerAuth.ok && headerAuth.value.signIns).toEqual([]);
    expect((await service.pruneSecrets("Docs", docs)).ok).toBe(true);
    expect(vault.values.has(key)).toBe(true);
    expect((await service.pruneSecrets("Docs", null)).ok).toBe(true);
    expect(vault.values.has(key)).toBe(false);
    await service.signIn(docs);
    expect((await service.signOut("Docs")).ok).toBe(true);
    expect(vault.values.has(key)).toBe(false);
    service.dispose();
  });

  it("renews a due sign-in once when two checks race, and stores the new token", async () => {
    const holdToken = deferred();
    const fake = await fakeServer({ holdToken });
    const vault = memoryVault();
    const docs = serverConfig("Docs", fake.mcpUrl);
    const key = mcpOAuthVaultKey("Docs");
    vault.values.set(key, JSON.stringify(tokenFor(fake.mcpUrl, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      tokenEndpoint: `${fake.origin}/token`,
    })));
    const service = createMcpRegistryService({ vault, adeHome: "/tmp/ade-mcp-oauth-test", commandExists: () => true });
    const first = service.check([docs]);
    const second = service.check([docs]);
    await fake.waitFor("/token");
    holdToken.resolve();
    const results = await Promise.all([first, second]);
    expect(fake.tokens).toHaveLength(1);
    expect(fake.tokens[0]?.get("grant_type")).toBe("refresh_token");
    expect(fake.tokens[0]?.get("refresh_token")).toBe("old-refresh");
    for (const result of results) expect(result.ok && result.value.signIns).toMatchObject([{ server: "Docs", state: "valid" }]);
    expect(JSON.parse(vault.values.get(key)!).accessToken).toBe("access-secret");
    service.dispose();
  });
});

/**
 * Two machines on one account share a vault and a rotating grant. The token
 * server revokes the grant on any replayed refresh token, which is exactly
 * what happens to a real sign-in when two machines renew at once. Each machine
 * is its own copy of the module (its own in-process renewal map) with its own
 * ADE home and sync device id, as two computers would be.
 */
describe("MCP sign-in renewal across machines", () => {
  const URL_ = "https://docs.example/mcp";
  const KEY = mcpOAuthVaultKey("Docs");
  const homes: string[] = [];

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  /** A shared vault with the Worker's rule: the last write wins, and it carries its owner. */
  function sharedVault(nowMs: () => number) {
    const rows = new Map<string, { value: string; updatedAt: string; refreshOwner: string | null }>();
    const ok = <T>(value: T): AccountVaultResult<T> => ({ ok: true, value });
    return {
      rows,
      seed(value: string, refreshOwner: string | null, updatedAtMs = nowMs()) {
        rows.set(KEY, { value, refreshOwner, updatedAt: new Date(updatedAtMs).toISOString() });
      },
      async list() {
        return ok([...rows].map(([key, row]): AccountVaultItem => ({
          scope: "all", kind: "secret", key, value: null, updatedAt: row.updatedAt, refreshOwner: row.refreshOwner,
        })));
      },
      async get(_scope: string, _kind: string, key: string) { return ok(rows.get(key)?.value ?? null); },
      async set(_scope: string, _kind: string, key: string, value: string, options?: { refreshOwner?: string | null }) {
        rows.set(key, { value, refreshOwner: options?.refreshOwner ?? null, updatedAt: new Date(nowMs()).toISOString() });
        return ok(null);
      },
      async sync() { return ok("ready"); },
    };
  }

  /** A token endpoint that rotates the refresh token and revokes the grant on a replay. */
  function rotatingServer() {
    let current = "rt-0";
    let turn = 0;
    const state = { exchanges: 0, revoked: false };
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const presented = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
      state.exchanges += 1;
      if (state.revoked || presented !== current) {
        state.revoked = true;
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      turn += 1;
      current = `rt-${turn}`;
      return new Response(JSON.stringify({ access_token: `at-${turn}`, refresh_token: current, expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    return { state, fetchImpl };
  }

  async function machine(deviceId: string, vault: ReturnType<typeof sharedVault>, fetchImpl: typeof fetch) {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `ade-mcp-${deviceId}-`));
    homes.push(home);
    fs.mkdirSync(path.join(home, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(home, "secrets", "sync-device-id"), deviceId);
    const server = { name: "Docs", transport: "http", url: URL_, enabled: true };
    fs.writeFileSync(path.join(home, "account-settings.json"), JSON.stringify({ settings: { "all\u0000mcp.servers": { value: [server] } } }));
    vi.resetModules();
    const mod = await import("./mcpRegistryService");
    return mod.createMcpRegistryAuthTokenResolver({
      adeHome: home,
      readSecret: async (key) => vault.rows.get(key)?.value ?? null,
      writeSecret: async (key, value, refreshOwner) => (await vault.set("all", "secret", key, value, { refreshOwner })).ok,
      getVault: () => vault,
      fetch: fetchImpl,
    });
  }

  const tokenJson = (accessToken: string, refreshToken: string, expiresAtMs: number) => JSON.stringify(tokenFor(URL_, {
    accessToken, refreshToken, expiresAt: new Date(expiresAtMs).toISOString(), tokenEndpoint: "https://docs.example/token",
  }));

  afterEach(() => { vi.useRealTimers(); });

  it("lets only the owner renew, and the other machine reads what the owner published", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-03T12:00:00Z") });
    const vault = sharedVault(() => Date.now());
    const server = rotatingServer();
    vault.seed(tokenJson("at-0", "rt-0", Date.now() + 5 * 60_000), "device-a", Date.now() - 60 * 60_000);
    const a = await machine("device-a", vault, server.fetchImpl);
    const b = await machine("device-b", vault, server.fetchImpl);

    await Promise.all([a(URL_), b(URL_), a(URL_), b(URL_)]);
    expect(server.state).toEqual({ exchanges: 1, revoked: false });
    expect(vault.rows.get(KEY)?.refreshOwner).toBe("device-a");
    expect((await b(URL_)).accessToken).toBe("at-1");
    expect(server.state.exchanges).toBe(1);
  });

  it("takes over from an owner that went quiet, once, and only after its claim has stood", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-03T12:00:00Z") });
    const vault = sharedVault(() => Date.now());
    const server = rotatingServer();
    const expiredAt = Date.now() - 11 * 60_000;
    vault.seed(tokenJson("at-0", "rt-0", expiredAt), "device-gone", expiredAt - 60 * 60_000);
    const a = await machine("device-a", vault, server.fetchImpl);
    const b = await machine("device-b", vault, server.fetchImpl);

    // Both see a stale owner and claim; nobody exchanges yet.
    await Promise.all([a(URL_), b(URL_)]);
    expect(server.state.exchanges).toBe(0);
    const claimant = vault.rows.get(KEY)?.refreshOwner;
    expect(["device-a", "device-b"]).toContain(claimant);

    const owner = claimant === "device-a" ? a : b;
    const other = claimant === "device-a" ? b : a;
    // The fresh claim is not stale even though the token still is: the other
    // machine leaves it alone instead of claiming back.
    vi.setSystemTime(Date.now() + 31_000);
    await other(URL_);
    expect(server.state.exchanges).toBe(0);
    expect(vault.rows.get(KEY)?.refreshOwner).toBe(claimant);
    await Promise.all([owner(URL_), other(URL_), owner(URL_), other(URL_)]);
    expect(server.state).toEqual({ exchanges: 1, revoked: false });
    expect(vault.rows.get(KEY)?.refreshOwner).toBe(claimant);
    expect((await other(URL_)).accessToken).toBe("at-1");
  });

  it("claims an ownerless (older ADE) sign-in before renewing it, so two machines never both exchange", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-03T12:00:00Z") });
    const vault = sharedVault(() => Date.now());
    const server = rotatingServer();
    vault.seed(tokenJson("at-0", "rt-0", Date.now() + 5 * 60_000), null, Date.now() - 60 * 60_000);
    const a = await machine("device-a", vault, server.fetchImpl);
    const b = await machine("device-b", vault, server.fetchImpl);

    const first = await Promise.all([a(URL_), b(URL_)]);
    expect(server.state.exchanges).toBe(0);
    // Still signed in while the claim settles: the old token has minutes left.
    for (const lookup of first) expect(lookup.accessToken).toBe("at-0");
    // A claim stands before its machine exchanges, so a claim it has not yet
    // seen overwritten (another machine's, still syncing) cannot make two.
    vi.setSystemTime(Date.now() + 5_000);
    await Promise.all([a(URL_), b(URL_)]);
    expect(server.state.exchanges).toBe(0);

    vi.setSystemTime(Date.now() + 31_000);
    await Promise.all([a(URL_), b(URL_)]);
    expect(server.state).toEqual({ exchanges: 1, revoked: false });
  });
});
