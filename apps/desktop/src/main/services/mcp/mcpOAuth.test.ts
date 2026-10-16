// @vitest-environment node

import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMcpOAuthSignIns,
  isAllowedMcpAuthEndpoint,
  type McpOAuthOutcome,
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
        resource: `${origin}/mcp`,
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
});
