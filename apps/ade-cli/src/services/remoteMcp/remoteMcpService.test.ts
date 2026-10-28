import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-service-"));
  tempDirs.push(dir);
  const service = createRemoteMcpService({
    storePath: path.join(dir, "remote-mcp.json"),
    activityPath: path.join(dir, "activity.jsonl"),
    machineName: () => "Test Mac",
    listProjects: () => [],
    account: {
      signedIn: () => ({ userId: OWNER, email: "owner@example.com", name: null }),
      oauth: () => ({ issuer, clientId: CLIENT_ID }),
      attestation: () => ({ issuer, jwksUrl: `${issuer}/jwks`, oauthClientId: CLIENT_ID }),
    },
  });
  service.attachRelayEndpoint(() => ({ relayUrl: RELAY, endpointKey: ENDPOINT_KEY, connected: true }));
  service.setEnabled({ enabled: true });
  return service;
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
async function signIn(service: ReturnType<typeof makeService>) {
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
    const service = makeService();
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
    expect(service.getStatus().connections).toEqual([expect.objectContaining({ kind: "app", scope: "read", label: "Test app" })]);
  });

  it("refuses an ADE sign-in as another account, and the sign-in cannot be finished afterwards", async () => {
    signedInAs = "user_someone_else";
    const service = makeService();
    const { state, callback } = await signIn(service);
    expect(callback.status).toBe(403);
    expect(callback.body).not.toContain('name="csrf"');

    signedInAs = OWNER;
    const retried = await service.handleHttp(request("GET", `/oauth/account-callback?code=ade-code&state=${encodeURIComponent(state)}`));
    expect(retried.status).toBe(400);
    expect(service.getStatus().connections).toEqual([]);
  });
});
