import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccountSettingsStore, type AccountSettingsRelay } from "../account/accountSettingsStore";
import { createAccountVaultStore, type AccountVaultRelay } from "../account/accountVaultStore";
import type { RemoteMcpHttpRequest } from "./remoteMcpHttp";
import { createRemoteMcpService } from "./remoteMcpService";

/**
 * Signing an MCP app in with the person's ADE account, through the service's
 * HTTP boundary. ADE's sign-in (Clerk) is a local server: it issues codes and
 * serves the signing keys, the network edge the brain really talks to.
 */

const OWNER = "user_owner";
const CLIENT_ID = "client_ade";
const RELAY = "https://relay.test";
const ENDPOINT_KEY = "a".repeat(40);
const MACHINE_KEY = "b".repeat(32);
const REDIRECT = "https://app.test/callback";
const tempDirs: string[] = [];
let server: Server;
let issuer = "";
let signingKey: CryptoKey;
/** The account ADE's sign-in says signed in; a test switches it. */
let signedInAs = OWNER;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "k1", use: "sig" }] };
  server = createServer((request, response) => {
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(jwks));
      return;
    }
    if (request.url === "/oauth/token" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        // A real Clerk would refuse a code redeemed without its PKCE verifier.
        if (!form.get("code") || !form.get("code_verifier")) {
          response.writeHead(400).end();
          return;
        }
        void new SignJWT({ azp: CLIENT_ID })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setSubject(signedInAs)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(signingKey)
          .then((token) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ access_token: token, token_type: "Bearer" }));
          });
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  signedInAs = OWNER;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The account's push relay, the network edge behind the real vault and
 * settings stores: rows in memory, shared by every computer a test makes.
 */
function fakeAccountRelay() {
  let clock = Date.parse("2026-10-28T10:00:00.000Z");
  const stamp = () => new Date((clock += 1)).toISOString();
  const vault = new Map<string, { scope: string; kind: string; key: string; value: string | null; updatedAt: string; writerDeviceId: string | null; refreshOwner: null; deleted?: boolean }>();
  const settings = new Map<string, { scope: string; key: string; value: unknown; updatedAt: string; changedAt: string | null; writerDeviceId: string | null; deleted?: boolean }>();
  const since = <T extends { updatedAt: string }>(rows: Iterable<T>, after?: string | null) =>
    [...rows].filter((row) => !after || row.updatedAt > after);
  const cursor = () => new Date(clock).toISOString();
  return {
    vaultRelay: {
      getAccountVault: async (options?: { since?: string | null }) => ({ items: since(vault.values(), options?.since), cursor: cursor(), truncated: false }),
      putAccountVault: async (items: Array<{ scope: string; kind: string; key: string; value: string }>, deviceId: string | null) => {
        const updatedAt = stamp();
        for (const item of items) vault.set(`${item.scope}/${item.kind}/${item.key}`, { ...item, updatedAt, writerDeviceId: deviceId, refreshOwner: null });
        return { updatedAt };
      },
      deleteAccountVaultItem: async (scope: string, kind: string, key: string) => {
        vault.set(`${scope}/${kind}/${key}`, { scope, kind, key, value: null, updatedAt: stamp(), writerDeviceId: null, refreshOwner: null, deleted: true });
        return true;
      },
    } as unknown as AccountVaultRelay,
    settingsRelay: {
      getAccountSettings: async (options?: { since?: string | null }) => ({ settings: since(settings.values(), options?.since), cursor: cursor(), truncated: false }),
      putAccountSettings: async (rows: Array<{ scope: string; key: string; value: unknown; changedAt?: string }>, deviceId: string | null) => {
        const updatedAt = stamp();
        for (const row of rows) settings.set(`${row.scope}/${row.key}`, { ...row, updatedAt, changedAt: row.changedAt ?? null, writerDeviceId: deviceId });
        return { updatedAt };
      },
      deleteAccountSetting: async (scope: string, key: string) => {
        settings.set(`${scope}/${key}`, { scope, key, value: null, updatedAt: stamp(), changedAt: null, writerDeviceId: null, deleted: true });
        return true;
      },
    } as unknown as AccountSettingsRelay,
  };
}

/** One computer of the account, on the real vault and settings stores. */
async function makeService(
  account = fakeAccountRelay(),
  machine = { name: "Test Mac", machineKey: MACHINE_KEY, endpointKey: ENDPOINT_KEY },
  legacyFile?: object,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-service-"));
  tempDirs.push(dir);
  const stores = { adeDir: dir, getAccountUserId: () => OWNER, getDeviceId: () => machine.machineKey };
  if (legacyFile) fs.writeFileSync(path.join(dir, "remote-mcp.json"), JSON.stringify(legacyFile));
  const vault = createAccountVaultStore({ ...stores, relay: account.vaultRelay });
  const service = createRemoteMcpService({
    legacyStorePath: path.join(dir, "remote-mcp.json"),
    activityPath: path.join(dir, "activity.jsonl"),
    machineName: () => machine.name,
    listProjects: () => [],
    account: {
      signedIn: () => ({ userId: OWNER, email: "owner@example.com", name: null }),
      oauth: () => ({ issuer, clientId: CLIENT_ID }),
      attestation: () => ({ issuer, jwksUrl: `${issuer}/jwks`, oauthClientId: CLIENT_ID }),
    },
    vault,
    settings: createAccountSettingsStore({ ...stores, relay: account.settingsRelay }),
    listAccountMachines: async () => null,
  });
  service.attachRelayEndpoint(() => ({ relayUrl: RELAY, machineKey: machine.machineKey, endpointKey: machine.endpointKey, connected: true }));
  await service.setEnabled({ enabled: true });
  return Object.assign(service, { vault });
}

const SECOND = { name: "Mac mini", machineKey: "c".repeat(32), endpointKey: "d".repeat(40) };

/** One MCP request with a bearer, on the computer's own address or (with `accountKey`) the account's. */
async function mcp(service: Awaited<ReturnType<typeof makeService>>, token: string, message: object, accountKey?: string) {
  const response = await service.handleHttp({
    method: "POST",
    path: "/mcp",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
    ...(accountKey ? { mount: { kind: "account" as const, key: accountKey } } : {}),
  });
  return { status: response.status, body: response.status === 200 ? JSON.parse(response.body) as Record<string, any> : null };
}

/** The key in the account address (`<relay>/a/<key>/mcp`). */
async function accountKeyOf(service: Awaited<ReturnType<typeof makeService>>): Promise<string> {
  const url = (await service.getStatus()).serverUrl ?? "";
  const key = /\/a\/([a-f0-9]+)\/mcp$/.exec(url)?.[1];
  expect(key, `account address in ${url}`).toBeTruthy();
  return key!;
}

function request(method: string, pathAndQuery: string, body?: Record<string, string> | object, json = false): RemoteMcpHttpRequest {
  return {
    method,
    path: pathAndQuery,
    headers: json
      ? { "content-type": "application/json" }
      : { "content-type": "application/x-www-form-urlencoded" },
    body: body === undefined ? null : json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
  };
}

function formValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  expect(match, `form field ${name}`).not.toBeNull();
  return match![1]!;
}

/** Registers an app and walks it to the ADE sign-in callback. */
async function signIn(service: Awaited<ReturnType<typeof makeService>>) {
  const registered = await service.handleHttp(request("POST", "/oauth/register", {
    redirect_uris: [REDIRECT],
    client_name: "Test app",
  }, true));
  expect(registered.status).toBe(201);
  const clientId = (JSON.parse(registered.body) as { client_id: string }).client_id;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await service.handleHttp(request("POST", "/oauth/authorize", {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "app-state",
    decision: "signin",
  }));
  expect(start.status).toBe(302);
  const toAde = new URL(start.headers.location!);
  expect(`${toAde.origin}${toAde.pathname}`).toBe(`${issuer}/oauth/authorize`);
  expect(toAde.searchParams.get("redirect_uri")).toBe(`${RELAY}/oauth/callback`);
  const state = toAde.searchParams.get("state")!;
  expect(state.startsWith(`${ENDPOINT_KEY}.`)).toBe(true);
  const callback = await service.handleHttp(request("GET", `/oauth/account-callback?code=ade-code&state=${encodeURIComponent(state)}`));
  return { clientId, verifier, state, callback };
}

describe("ADE MCP sign-in", () => {
  it("issues one read-only token after the computer's own account signs in and allows, and nothing replays", async () => {
    const service = await makeService();
    const { clientId, verifier, state, callback } = await signIn(service);
    expect(callback.status).toBe(200);
    const consent = { nonce: formValue(callback.body, "nonce"), csrf: formValue(callback.body, "csrf") };

    const allowed = await service.handleHttp(request("POST", "/oauth/consent", { ...consent, decision: "allow", access: "read" }));
    expect(allowed.status).toBe(302);
    const back = new URL(allowed.headers.location!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("app-state");
    const code = back.searchParams.get("code")!;

    const exchange = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier };
    const token = await service.handleHttp(request("POST", "/oauth/token", exchange));
    expect(token.status).toBe(200);
    const issued = JSON.parse(token.body) as { access_token: string; scope: string };
    expect(issued.scope).toBe("ade:read");

    // Every step is single use.
    expect((await service.handleHttp(request("POST", "/oauth/consent", { ...consent, decision: "allow", access: "write" }))).status).toBe(400);
    expect((await service.handleHttp(request("POST", "/oauth/token", exchange))).status).toBe(400);
    expect((await service.handleHttp(request("GET", `/oauth/account-callback?code=ade-code&state=${encodeURIComponent(state)}`))).status).toBe(400);

    // The token works, at the access the person chose.
    const list = await service.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const tool = (JSON.parse(list.body) as { result: { tools: Array<{ annotations: { readOnlyHint: boolean } }> } }).result.tools[0]!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect((await service.getStatus()).connections).toEqual([expect.objectContaining({ kind: "app", scope: "read", label: "Test app" })]);
  });

  it("refuses an ADE sign-in as another account, and the sign-in cannot be finished afterwards", async () => {
    signedInAs = "user_someone_else";
    const service = await makeService();
    const { state, callback } = await signIn(service);
    expect(callback.status).toBe(403);
    expect(callback.body).not.toContain('name="csrf"');

    signedInAs = OWNER;
    const retried = await service.handleHttp(request("GET", `/oauth/account-callback?code=ade-code&state=${encodeURIComponent(state)}`));
    expect(retried.status).toBe(400);
    expect((await service.getStatus()).connections).toEqual([]);
  });
});

describe("ADE MCP across the account's computers", () => {
  it("answers a token from one computer on another, at the account address, until it is revoked", async () => {
    const account = fakeAccountRelay();
    const studio = await makeService(account);
    const mini = await makeService(account, SECOND);
    const key = await accountKeyOf(studio);
    // Both computers serve one account address: the second adopted the first one's secret.
    expect(await accountKeyOf(mini)).toBe(key);

    const created = studio.createToken({ label: "Script", scope: "read" });
    await studio.vault.sync();
    const listed = await mcp(mini, created.token, { method: "tools/list" }, key);
    expect(listed.status).toBe(200);
    expect(listed.body?.result.tools.length).toBeGreaterThan(0);
    // Another account's address is not this one's.
    expect((await mcp(mini, created.token, { method: "tools/list" }, "e".repeat(40))).status).toBe(404);

    expect(studio.removeConnection({ id: created.connection.id }).removed).toBe(true);
    await studio.vault.sync();
    // What the minute-old copy pull does on the other computer.
    await mini.vault.sync();
    expect((await mcp(mini, created.token, { method: "tools/list" }, key)).status).toBe(401);
    expect((await mcp(studio, created.token, { method: "tools/list" }, key)).status).toBe(401);
  });

  it("keeps a token from before accounts to the computer it was made on", async () => {
    const token = `ade_mcp_${randomBytes(32).toString("base64url")}`;
    const legacy = {
      version: 1,
      enabled: true,
      migratedAt: null,
      connections: [{
        id: "0123456789abcdef", kind: "token", label: "Old script", scope: "write",
        tokenHash: createHash("sha256").update(token, "utf8").digest("hex"), tokenHint: token.slice(-4),
        createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, redirectHost: null,
      }],
    };
    const account = fakeAccountRelay();
    const studio = await makeService(account, undefined, legacy);
    await studio.vault.sync();
    const mini = await makeService(account, SECOND);
    await mini.vault.sync();
    expect((await mini.getStatus()).connections).toEqual([
      expect.objectContaining({ id: "0123456789abcdef", onlyMachine: expect.objectContaining({ machineKey: MACHINE_KEY }) }),
    ]);

    const call = { method: "tools/call", params: { name: "machines_list", arguments: {} } };
    const here = await mcp(studio, token, call);
    expect(here.body?.result.isError).not.toBe(true);
    // On the other computer the token is known, and refused for everything.
    const there = await mcp(mini, token, call);
    expect(there.body?.result.isError).toBe(true);
    expect(JSON.stringify(there.body?.result.content)).toContain("Reconnect the app");
    const catalog = await mcp(mini, token, { method: "resources/read", params: { uri: "ade://commands" } });
    expect(catalog.body?.error?.message).toContain("Reconnect the app");
    expect((await mcp(mini, token, { method: "prompts/list" })).body?.result.prompts).toEqual([]);
  });
});
