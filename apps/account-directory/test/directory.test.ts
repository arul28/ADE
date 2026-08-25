import { describe, expect, it, vi } from "vitest";
import { verifyCallerToken } from "../src/callerToken";
import { handleRequest, type Env } from "../src/directory";
import worker from "../src/index";
import {
  activityRelayStub,
  DIRECTORY_AUTH_SECRET,
  deviceConfirmationRequest,
  FakeD1Database,
  ISSUER,
  makeEnv,
  mintFreshAuthToken,
  mintToken,
  OAUTH_CLIENT_ID,
  register,
  registerBody,
  registrationWithRelayRetention,
  RELAY_URL,
  request,
} from "./helpers";

describe("Clerk JWKS authentication", () => {
  it("extracts sub from a valid OAuth token whose aud is the Clerk client id", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_oauth", audience: OAUTH_CLIENT_ID, azp: OAUTH_CLIENT_ID });

    await expect(verifyCallerToken(token, env)).resolves.toBe("user_oauth");
  });

  it("accepts native session tokens with no aud even when azp is origin-based", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_native", azp: "https://desktop.ade.dev" });

    await expect(verifyCallerToken(token, env)).resolves.toBe("user_native");
  });

  it("accepts an OAuth token authorized to the Clerk client through azp", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_oauth", audience: "clerk-api", azp: OAUTH_CLIENT_ID });

    await expect(verifyCallerToken(token, env)).resolves.toBe("user_oauth");
  });

  it.each([
    ["wrong issuer", { issuer: "https://wrong-issuer.test" }, "invalid issuer"],
    ["expired", { expired: true }, "token expired"],
    ["bad signature", { useBadKey: true }, "invalid token"],
    ["missing sub", { sub: null }, "missing token subject"],
    ["unapproved audience", { audience: "different-client", azp: "different-client" }, "invalid audience"],
  ] as const)("returns a classified 401 for %s", async (_label, tokenArgs, expectedError) => {
    const env = makeEnv();
    const token = await mintToken(tokenArgs);

    const response = await handleRequest(request("GET", "/account/machines", token), env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expectedError });
  });

  it("returns 401 when the bearer token is absent", async () => {
    const response = await handleRequest(request("GET", "/account/machines"), makeEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing bearer token" });
  });

  it.each([
    "CLERK_JWKS_URL",
    "CLERK_ISSUER",
    "CLERK_OAUTH_CLIENT_ID",
  ] as const)("returns 503 when %s is not configured", async (key) => {
    const env = makeEnv();
    delete env[key];

    const response = await handleRequest(
      request("GET", "/account/machines", "opaque-bearer"),
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "authentication unavailable" });
  });
});

describe("machine directory", () => {
  it("serves an unauthenticated health check", async () => {
    const response = await handleRequest(request("GET", "/health"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("allows only the configured hosted origin to preflight and read the directory", async () => {
    const env = makeEnv({ WEB_CLIENT_ORIGIN: "https://app.ade.dev" });
    const token = await mintToken();
    const preflight = await handleRequest(new Request("https://directory.test/account/machines", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.ade.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.ade.dev");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "authorization, x-ade-correlation-id",
    );
    expect(preflight.headers.get("x-ade-correlation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const deletePreflight = await handleRequest(new Request(
      "https://directory.test/account/machines/machine-a",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://app.ade.dev",
          "access-control-request-method": "DELETE",
          "access-control-request-headers": "authorization, x-ade-correlation-id",
        },
      },
    ), env);
    expect(deletePreflight.status).toBe(204);
    expect(deletePreflight.headers.get("access-control-allow-methods")).toBe(
      "DELETE, OPTIONS",
    );

    const allowed = await handleRequest(new Request("https://directory.test/account/machines", {
      headers: { origin: "https://app.ade.dev", authorization: `Bearer ${token}` },
    }), env);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.ade.dev");
    expect(allowed.headers.get("access-control-expose-headers")).toBe(
      "Server-Timing, X-ADE-Correlation-ID",
    );

    const hostilePreflight = await handleRequest(new Request("https://directory.test/account/machines", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }), env);
    expect(hostilePreflight.status).toBe(403);
    const hostileRead = await handleRequest(new Request("https://directory.test/account/machines", {
      headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
    }), env);
    expect(hostileRead.status).toBe(403);
    expect(hostileRead.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("upserts registration heartbeats and isolates rows by Clerk sub", async () => {
    const env = makeEnv();
    const firstToken = await mintToken({ sub: "user_1" });
    const secondToken = await mintToken({ sub: "user_2" });
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(now - 5_000);

    const first = await register(env, firstToken, "machine-a", [{ kind: "lan", host: "old.local", port: 8787 }]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(expect.objectContaining({
      machineKey: "machine-a",
      lastSeenAt: now - 5_000,
      createdAt: now - 5_000,
      reachableEndpoints: [{ kind: "lan", host: "old.local", port: 8787 }],
    }));

    dateNow.mockReturnValue(now);
    const second = await register(env, firstToken, "machine-a", [{ kind: "relay", url: "wss://relay.test/machine-a" }]);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(expect.objectContaining({
      machineKey: "machine-a",
      lastSeenAt: now,
      createdAt: now - 5_000,
      reachableEndpoints: [{ kind: "relay", url: "wss://relay.test/machine-a" }],
    }));
    expect(env.DB.rows).toHaveLength(1);

    const otherUserList = await handleRequest(request("GET", "/account/machines", secondToken), env);
    expect(await otherUserList.json()).toEqual({ machines: [] });
  });

  it("renames an owned machine with customName and prefers it over the reported hostname", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");

    const renamed = await handleRequest(request(
      "PATCH",
      "/account/machines/machine-a",
      token,
      { customName: "  Studio Mac  " },
    ), env);

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual(expect.objectContaining({
      machineKey: "machine-a",
      name: "Machine machine-a",
      customName: "Studio Mac",
      online: true,
    }));

    const listed = await handleRequest(request("GET", "/account/machines", token), env);
    expect(await listed.json()).toEqual({
      machines: [
        expect.objectContaining({
          machineKey: "machine-a",
          name: "Machine machine-a",
          customName: "Studio Mac",
        }),
      ],
    });
  });

  it("does not clobber customName when registration heartbeats report a new hostname", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    await handleRequest(request(
      "PATCH",
      "/account/machines/machine-a",
      token,
      { customName: "Build Mac" },
    ), env);

    const heartbeatBody = registerBody("machine-a");
    heartbeatBody.name = "Renamed Hostname";
    const heartbeat = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      heartbeatBody,
    ), env);

    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toEqual(expect.objectContaining({
      name: "Renamed Hostname",
      customName: "Build Mac",
    }));
  });

  it("rejects invalid or cross-account machine renames and allows clearing a customName", async () => {
    const env = makeEnv();
    const ownerToken = await mintToken({ sub: "user_1" });
    const otherToken = await mintToken({ sub: "user_2" });
    await register(env, ownerToken, "machine-a");

    const missing = await handleRequest(request(
      "PATCH",
      "/account/machines/machine-a",
      otherToken,
      { customName: "Stolen" },
    ), env);
    expect(missing.status).toBe(404);

    const invalid = await handleRequest(request(
      "PATCH",
      "/account/machines/machine-a",
      ownerToken,
      { customName: "x".repeat(81) },
    ), env);
    expect(invalid.status).toBe(400);

    await handleRequest(request(
      "PATCH",
      "/account/machines/machine-a",
      ownerToken,
      { customName: "Studio" },
    ), env);
    const cleared = await handleRequest(request(
      "PATCH",
      "/account/machines/machine-a",
      ownerToken,
      { customName: null },
    ), env);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual(expect.objectContaining({ customName: null }));
  });

  it("echoes safe correlation ids in responses and structured logs", async () => {
    const env = makeEnv();
    const token = await mintToken();
    const correlationId = "123e4567-e89b-42d3-a456-426614174000";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handleRequest(new Request(
      "https://directory.test/account/machines?ignored=secret",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-ade-correlation-id": correlationId.toUpperCase(),
        },
      },
    ), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ade-correlation-id")).toBe(correlationId);
    const lifecycle = log.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes('"kind":"request_completed"'));
    expect(lifecycle).toBeDefined();
    expect(JSON.parse(lifecycle ?? "{}")).toMatchObject({
      svc: "ade-account-directory",
      kind: "request_completed",
      correlationId,
      route: "list",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    expect(lifecycle).not.toContain(token);
    expect(lifecycle).not.toContain("ignored=secret");
    log.mockRestore();
  });

  it("replaces invalid correlation ids instead of reflecting them", async () => {
    const token = await mintToken();
    const response = await handleRequest(new Request(
      "https://directory.test/account/machines",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-ade-correlation-id": "unsafe-value",
        },
      },
    ), makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ade-correlation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers.get("x-ade-correlation-id")).not.toBe("unsafe-value");
  });

  it("retains the authenticated machine's verified Relay route during a transient health dip", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relayEndpoint = { kind: "relay", url: "wss://relay.test/machine-a" };
    await register(env, token, "machine-a", [
      { kind: "lan", host: "old.local", port: 8787 },
      relayEndpoint,
    ]);

    const transient = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      registrationWithRelayRetention("machine-a", [
        { kind: "lan", host: "new.local", port: 8787 },
      ]),
    ), env);

    expect(transient.status).toBe(200);
    expect(await transient.json()).toEqual(expect.objectContaining({
      machineKey: "machine-a",
      reachableEndpoints: [
        { kind: "lan", host: "new.local", port: 8787 },
        relayEndpoint,
      ],
    }));
  });

  it("never retains Relay routes across owners, deletion, or an authoritative replacement", async () => {
    const env = makeEnv();
    const firstToken = await mintToken({ sub: "user_1" });
    const secondToken = await mintToken({ sub: "user_2" });
    const relayEndpoint = { kind: "relay", url: "wss://relay.test/shared-machine" };
    await register(env, firstToken, "shared-machine", [relayEndpoint]);

    const otherOwner = await handleRequest(request(
      "POST",
      "/account/machines/register",
      secondToken,
      registrationWithRelayRetention("shared-machine", [
        { kind: "lan", host: "second.local", port: 8787 },
      ]),
    ), env);
    expect(await otherOwner.json()).toEqual(expect.objectContaining({
      reachableEndpoints: [{ kind: "lan", host: "second.local", port: 8787 }],
    }));

    const authoritative = await register(env, firstToken, "shared-machine", [
      { kind: "lan", host: "first.local", port: 8787 },
    ]);
    expect(await authoritative.json()).toEqual(expect.objectContaining({
      reachableEndpoints: [{ kind: "lan", host: "first.local", port: 8787 }],
    }));

    const relay = activityRelayStub();
    await handleRequest(request(
      "DELETE",
      "/account/machines/shared-machine",
      firstToken,
    ), env, relay.options);
    // Re-adding a removed machine is a deliberate pairing, not a heartbeat, and
    // it needs a freshly proven sign-in on top of the `pairing` flag.
    const afterDelete = await handleRequest(request(
      "POST",
      "/account/machines/register",
      await mintFreshAuthToken("user_1"),
      {
        ...registrationWithRelayRetention("shared-machine", [
          { kind: "lan", host: "after-delete.local", port: 8787 },
        ]),
        pairing: true,
      },
    ), env, relay.options);
    expect(await afterDelete.json()).toEqual(expect.objectContaining({
      reachableEndpoints: [{ kind: "lan", host: "after-delete.local", port: 8787 }],
    }));
  });

  it("rejects a non-boolean Relay-retention instruction", async () => {
    const env = makeEnv();
    const token = await mintToken();
    const response = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      {
        ...registerBody("machine-a"),
        retainRelayEndpoints: "yes",
      },
    ), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request body" });
  });

  it("stores and lists a bounded Ed25519 machine public key", async () => {
    const env = makeEnv();
    const token = await mintToken();
    const pubkey = `ed25519:${Buffer.alloc(32, 4).toString("base64")}`;
    const registered = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      { ...registerBody("machine-keyed"), pubkey },
    ), env);
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual(expect.objectContaining({ pubkey }));

    const listed = await handleRequest(
      request("GET", "/account/machines", token),
      env,
    );
    expect(await listed.json()).toMatchObject({
      machines: [expect.objectContaining({ pubkey })],
    });

    const oversized = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      { ...registerBody("machine-oversized-key"), pubkey: "x".repeat(129) },
    ), env);
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({ error: "invalid request body" });
  });

  it("returns online and offline machines, online first and newest first", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now");

    dateNow.mockReturnValue(now - 120_000);
    await register(env, token, "offline");
    dateNow.mockReturnValue(now - 70_000);
    await register(env, token, "online-old");
    dateNow.mockReturnValue(now - 10_000);
    await register(env, token, "online-new");
    dateNow.mockReturnValue(now);

    const response = await handleRequest(request("GET", "/account/machines", token), env);
    const body = await response.json() as { machines: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.machines.map((machine) => machine.machineKey)).toEqual(["online-new", "online-old", "offline"]);
    expect(body.machines.map((machine) => machine.online)).toEqual([true, true, false]);
    expect(body.machines[2]).toEqual(expect.objectContaining({
      lastSeenAt: now - 120_000,
      reachableEndpoints: [{ kind: "lan", host: "mac.local", port: 8787 }],
    }));
    expect(response.headers.get("server-timing")).toMatch(
      /^auth;dur=\d+\.\d{2}, db;dur=\d+\.\d{2}$/,
    );
  });

  it("returns only the 500 most recently seen machines", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    env.DB.rows = Array.from({ length: 501 }, (_, index) => ({
      user_id: "user_1",
      machine_key: `machine-${index}`,
      device_id: `device-${index}`,
      hardware_id: null,
      name: `Machine ${index}`,
      custom_name: null,
      platform: "macOS",
      device_type: "desktop",
      pubkey: null,
      reachable_endpoints: "[]",
      power: null,
      sleep_state: null,
      sleep_state_at: null,
      last_seen_at: index,
      created_at: index,
    }));

    const response = await handleRequest(request("GET", "/account/machines", token), env);
    const body = await response.json() as { machines: Array<{ machineKey: string }> };

    expect(body.machines).toHaveLength(500);
    expect(body.machines[0]?.machineKey).toBe("machine-500");
    expect(body.machines[499]?.machineKey).toBe("machine-1");
  });

  it("honors an environment override for the online window", async () => {
    const env = makeEnv({ ONLINE_WINDOW_MS: "5000" });
    const token = await mintToken();
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(now - 10_000);
    await register(env, token, "machine-a");
    dateNow.mockReturnValue(now);

    const response = await handleRequest(request("GET", "/account/machines", token), env);
    const body = await response.json() as { machines: Array<{ online: boolean }> };
    expect(body.machines[0]?.online).toBe(false);
  });

  it("purges the removed machine's Activity through the relay with the caller's token", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub();

    const deleted = await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );

    expect(deleted.status).toBe(200);
    expect(relay.calls).toEqual([{
      url: `${RELAY_URL}/attention/account/machines/machine-a`,
      method: "DELETE",
      authorization: `Bearer ${token}`,
      directoryAuth: DIRECTORY_AUTH_SECRET,
    }]);
    expect(env.DB.revocations).toEqual([expect.objectContaining({
      user_id: "user_1",
      machine_key: "machine-a",
      device_id: "device-machine-a",
    })]);
  });

  it("reports a failed Activity purge instead of a clean removal", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub(() => new Response("boom", { status: 500 }));

    const deleted = await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );

    expect(deleted.status).toBe(502);
    expect(await deleted.json()).toMatchObject({
      ok: false,
      code: "activity_purge_failed",
      machineRemoved: true,
      activityPurged: false,
    });
    // Retried once before giving up, and the removal itself still stuck.
    expect(relay.calls).toHaveLength(2);
    expect(env.DB.rows).toHaveLength(0);
    expect(env.DB.revocations).toHaveLength(1);
  });

  it("refuses a removed machine's heartbeat registration until it pairs again", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub();
    await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );

    // The removed machine keeps a valid token and re-registers every 30 s.
    const heartbeat = await register(env, token, "machine-a");
    expect(heartbeat.status).toBe(403);
    expect(await heartbeat.json()).toMatchObject({ code: "machine_revoked" });
    expect(env.DB.rows).toHaveLength(0);

    // A `pairing: true` heartbeat from the same stale token is still refused:
    // the flag is caller-supplied, so it proves nothing on its own.
    const staleAuthPairing = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      { ...registerBody("machine-a"), pairing: true },
    ), env, relay.options);
    expect(staleAuthPairing.status).toBe(403);
    expect(await staleAuthPairing.json()).toMatchObject({
      code: "pairing_authentication_required",
    });
    expect(env.DB.revocations).toHaveLength(1);
    expect(env.DB.rows).toHaveLength(0);

    const repaired = await handleRequest(request(
      "POST",
      "/account/machines/register",
      await mintFreshAuthToken("user_1"),
      { ...registerBody("machine-a"), pairing: true },
    ), env, relay.options);
    expect(repaired.status).toBe(200);
    expect(env.DB.revocations).toHaveLength(0);
    expect(relay.calls.at(-1)).toMatchObject({
      url: `${RELAY_URL}/attention/account/machines/machine-a/pairing`,
      method: "POST",
    });
  });

  it.each([
    ["an auth_time older than the freshness bound", { authTime: Math.floor(Date.now() / 1000) - 11 * 60 }],
    ["a Clerk fva first factor older than the freshness bound", { fva: [11, -1] }],
    ["no authentication-time claim at all", {}],
    ["an fva whose first factor was never verified", { fva: [-1, -1] }],
    ["a non-numeric fva", { fva: ["fresh", -1] }],
  ] as const)("refuses a pairing registration carrying %s", async (_label, claims) => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub();
    await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );
    relay.calls.length = 0;

    const attempt = await handleRequest(request(
      "POST",
      "/account/machines/register",
      await mintToken({ sub: "user_1", ...claims }),
      { ...registerBody("machine-a"), pairing: true },
    ), env, relay.options);

    expect(attempt.status).toBe(403);
    expect(await attempt.json()).toMatchObject({ code: "pairing_authentication_required" });
    // Never reached the relay: the directory must not spend its shared secret
    // on a re-pair it has no proof of.
    expect(relay.calls).toEqual([]);
    expect(env.DB.revocations).toHaveLength(1);
  });

  it.each([
    ["a fresh OIDC auth_time", { authTime: Math.floor(Date.now() / 1000) - 60 }],
    ["a fresh Clerk fva", { fva: [0, -1] }],
    ["a Clerk fva just inside the bound", { fva: [9, -1] }],
  ] as const)("accepts a pairing registration carrying %s", async (_label, claims) => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub();
    await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );

    const repaired = await handleRequest(request(
      "POST",
      "/account/machines/register",
      await mintToken({ sub: "user_1", ...claims }),
      { ...registerBody("machine-a"), pairing: true },
    ), env, relay.options);

    expect(repaired.status).toBe(200);
    expect(env.DB.revocations).toHaveLength(0);
  });

  it("no longer lets a changed deviceId clear a revocation on its own", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub();
    await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );
    relay.calls.length = 0;

    // `deviceId` is attacker-supplied: a removed machine can mint a new one on
    // every heartbeat, so it can never be the thing that un-revokes.
    const forged = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      { ...registerBody("machine-a"), deviceId: "device-i-just-made-up" },
    ), env, relay.options);

    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ code: "machine_revoked" });
    expect(relay.calls).toEqual([]);
    expect(env.DB.revocations).toHaveLength(1);
    expect(env.DB.rows).toHaveLength(0);
  });

  it("preserves the recorded device id across a retried removal", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");

    // First pass: the relay purge fails, so the desktop tells the user to try
    // removing it again — but the `machines` row is already gone.
    const firstAttempt = await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      activityRelayStub(() => new Response("boom", { status: 500 })).options,
    );
    expect(firstAttempt.status).toBe(502);
    expect(env.DB.revocations[0]?.device_id).toBe("device-machine-a");

    // Second pass finds `existing === null`. Overwriting the stored device id
    // with NULL here would erase which install the owner actually removed.
    const retry = await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      activityRelayStub().options,
    );
    expect(retry.status).toBe(200);
    expect(env.DB.revocations[0]?.device_id).toBe("device-machine-a");

    // The same machine still cannot heartbeat its way back in...
    const heartbeat = await register(env, token, "machine-a");
    expect(heartbeat.status).toBe(403);

    // ...nor can a "reinstall" it declares by inventing a new device id.
    const reinstalled = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      { ...registerBody("machine-a"), deviceId: "device-after-reinstall" },
    ), env, activityRelayStub().options);
    expect(reinstalled.status).toBe(403);
    expect(env.DB.revocations).toHaveLength(1);

    // A genuine reinstall recovers the same way every re-pair does: the user
    // signs in again, and ADE re-pairs on that fresh authentication.
    const repaired = await handleRequest(request(
      "POST",
      "/account/machines/register",
      await mintFreshAuthToken("user_1"),
      {
        ...registerBody("machine-a"),
        deviceId: "device-after-reinstall",
        pairing: true,
      },
    ), env, activityRelayStub().options);
    expect(repaired.status).toBe(200);
    expect(env.DB.revocations).toHaveLength(0);
  });

  it("refuses to hand a membership change to the relay without directory provenance", async () => {
    const env = makeEnv({ DIRECTORY_AUTH_SECRET: undefined });
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    const relay = activityRelayStub();

    // Fails closed rather than calling the relay with only the caller's bearer
    // token — the exact credential a removed machine still holds.
    const deleted = await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );
    expect(deleted.status).toBe(502);
    expect(await deleted.json()).toMatchObject({
      code: "activity_purge_failed",
      detail: expect.stringContaining("directory relay authentication"),
    });
    expect(relay.calls).toEqual([]);
  });

  it("keeps a machine revoked when the relay cannot clear the pairing block", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await register(env, token, "machine-a");
    await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      activityRelayStub().options,
    );

    const failing = activityRelayStub(() => new Response("down", { status: 503 }));
    const repaired = await handleRequest(request(
      "POST",
      "/account/machines/register",
      await mintFreshAuthToken("user_1"),
      { ...registerBody("machine-a"), pairing: true },
    ), env, failing.options);

    // A machine back on the roster but unable to publish is worse than one
    // that retries the re-pair, so the block stays until the relay agrees.
    expect(repaired.status).toBe(503);
    expect(await repaired.json()).toMatchObject({ code: "activity_relay_unavailable" });
    expect(env.DB.revocations).toHaveLength(1);
    expect(env.DB.rows).toHaveLength(0);
  });

  it("deletes only the caller's row for a shared machine key", async () => {
    const env = makeEnv();
    const firstToken = await mintToken({ sub: "user_1" });
    const secondToken = await mintToken({ sub: "user_2" });
    await register(env, firstToken, "shared-machine");
    await register(env, secondToken, "shared-machine");

    const deleted = await handleRequest(
      request("DELETE", "/account/machines/shared-machine", firstToken),
      env,
      activityRelayStub().options,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, machineKey: "shared-machine" });

    const firstList = await handleRequest(request("GET", "/account/machines", firstToken), env);
    const secondList = await handleRequest(request("GET", "/account/machines", secondToken), env);
    expect(await firstList.json()).toEqual({ machines: [] });
    expect(await secondList.json()).toEqual({
      machines: [expect.objectContaining({ machineKey: "shared-machine" })],
    });

    const removed = await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
      .bind("user_2", "shared-machine")
      .run();
    const missing = await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
      .bind("user_2", "shared-machine")
      .run();
    expect(removed.meta.changes).toBe(1);
    expect(missing.meta.changes).toBe(0);
    expect(env.DB.rows).toHaveLength(0);
  });
});

/**
 * Every refusal here is a user who cannot get their computer back onto their
 * account, and by the time they ask for help the request is long gone. These
 * lines are the only window support has into WHY a call was turned away — the
 * tables record what the state is, never that.
 */
describe("refusal observability", () => {
  const LONG_MACHINE_KEY = "machine-key-0123456789abcdef";
  const LONG_DEVICE_ID = "device-id-0123456789abcdef";
  const CORRELATION_ID = "3f1d9c4e-2b7a-4c8d-9e5f-6a1b2c3d4e5f";

  /** Structured lines only; the request-lifecycle log shares the channel. */
  function captureRefusals(): Array<Record<string, unknown>> {
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      if (typeof value !== "string") return;
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (typeof parsed.event === "string") lines.push(parsed);
      } catch {
        // Not one of ours.
      }
    });
    return lines;
  }

  function correlatedRegister(token: string, body: Record<string, unknown>): Request {
    return new Request("https://directory.test/account/machines/register", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-ade-correlation-id": CORRELATION_ID,
      },
      body: JSON.stringify({
        ...registerBody(LONG_MACHINE_KEY),
        deviceId: LONG_DEVICE_ID,
        ...body,
      }),
    });
  }

  async function removedLongKeyMachine(
    env: Env & { DB: FakeD1Database },
    token: string,
  ): Promise<ReturnType<typeof activityRelayStub>> {
    await handleRequest(correlatedRegister(token, {}), env);
    const relay = activityRelayStub();
    await handleRequest(
      request("DELETE", `/account/machines/${LONG_MACHINE_KEY}`, token),
      env,
      relay.options,
    );
    relay.calls.length = 0;
    return relay;
  }

  it("emits one joinable line per refused registration and never a whole key", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedLongKeyMachine(env, token);
    const lines = captureRefusals();

    const heartbeat = await handleRequest(correlatedRegister(token, {}), env, relay.options);

    expect(heartbeat.status).toBe(403);
    expect(lines).toEqual([{
      ts: expect.any(String),
      svc: "ade-account-directory",
      event: "directory.register_refused",
      userId: "user_1",
      machineKeyPrefix: "machine-",
      deviceIdPrefix: "device-i",
      code: "machine_revoked",
      // Ties the line to the request the client already logged.
      correlationId: CORRELATION_ID,
    }]);
    // Prefixes, not identifiers: a machine key is capability-shaped.
    expect(JSON.stringify(lines)).not.toContain(LONG_MACHINE_KEY);
    expect(JSON.stringify(lines)).not.toContain(LONG_DEVICE_ID);
  });

  it("separates a missing proof from a rejected one", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedLongKeyMachine(env, token);
    const lines = captureRefusals();

    await handleRequest(correlatedRegister(token, { pairing: true }), env, relay.options);
    await handleRequest(
      correlatedRegister(token, { pairing: true, pairingGrant: "not-a-real-grant" }),
      env,
      relay.options,
    );

    // Same wire code both times — the contract is unchanged — but support's
    // first question is always which of the two it was: a client that never
    // presented a grant, or one whose grant was expired, replayed, or foreign.
    expect(lines.map((line) => [line.code, line.reason])).toEqual([
      ["pairing_authentication_required", "no_proof"],
      ["pairing_authentication_required", "grant_rejected"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("not-a-real-grant");
  });

  it("reports a relay outage on both the re-pair and the removal that needs it", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedLongKeyMachine(env, token);
    const failing = activityRelayStub(() => new Response("down", { status: 503 }));
    const lines = captureRefusals();

    await handleRequest(
      correlatedRegister(await mintFreshAuthToken("user_1"), { pairing: true }),
      env,
      failing.options,
    );
    expect(lines).toEqual([expect.objectContaining({
      event: "directory.register_refused",
      code: "activity_relay_unavailable",
      reason: expect.stringContaining("503"),
    })]);

    lines.length = 0;
    // Put the machine back so there is a live row to remove, this time with a
    // relay that answers.
    await handleRequest(
      correlatedRegister(await mintFreshAuthToken("user_1"), { pairing: true }),
      env,
      relay.options,
    );
    await handleRequest(
      request("DELETE", `/account/machines/${LONG_MACHINE_KEY}`, token),
      env,
      failing.options,
    );
    expect(lines).toEqual([expect.objectContaining({
      event: "directory.remove_refused",
      machineKeyPrefix: "machine-",
      deviceIdPrefix: "device-i",
      code: "activity_purge_failed",
    })]);
  });

  it("records a duplicate the caller could not prove its way past", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await handleRequest(correlatedRegister(token, {}), env);
    const lines = captureRefusals();

    const rotated = await handleRequest(
      correlatedRegister(token, { machineKey: "machine-key-rotated" }),
      env,
    );

    // The registration itself succeeded — only the dedup was refused — and
    // "why is my Mac listed twice" is the question this line answers.
    expect(rotated.status).toBe(200);
    expect(lines).toEqual([expect.objectContaining({
      event: "directory.supersede_refused",
      code: "supersede_authentication_required",
      reason: "duplicates=1",
    })]);
  });
});

describe("machine power and sleep state", () => {
  async function registerWithPower(
    env: Env & { DB: FakeD1Database },
    token: string,
    machineKey: string,
    extra: Record<string, unknown>,
  ): Promise<Response> {
    return handleRequest(
      request("POST", "/account/machines/register", token, {
        ...registerBody(machineKey),
        ...extra,
      }),
      env,
    );
  }

  it("stores and returns a laptop's battery and announced sleep state", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    const response = await registerWithPower(env, token, "laptop", {
      power: { batteryPercent: 63, charging: false, onExternalPower: false },
      sleepState: "asleep",
      sleepStateAt: 1_700_000_000_000,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      power: { batteryPercent: 63, charging: false, onExternalPower: false },
      sleepState: "asleep",
      sleepStateAt: 1_700_000_000_000,
    }));
  });

  it("keeps a battery-less desktop battery-less rather than reporting 0%", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    const response = await registerWithPower(env, token, "studio", {
      power: { batteryPercent: null, charging: null, onExternalPower: true },
      sleepState: "awake",
    });

    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      power: { batteryPercent: null, charging: null, onExternalPower: true },
      sleepState: "awake",
    }));
  });

  it("accepts a host that reports no power at all", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    const response = await register(env, token, "old-host");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      power: null,
      sleepState: null,
      sleepStateAt: null,
    }));
  });

  it("degrades malformed power fields to null instead of rejecting the machine", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    const response = await registerWithPower(env, token, "confused", {
      power: { batteryPercent: 240, charging: "yes", onExternalPower: true },
      sleepState: "hibernating",
      sleepStateAt: "recently",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      // The machine stays reachable; only the unusable values are dropped.
      power: { batteryPercent: null, charging: null, onExternalPower: true },
      sleepState: null,
      sleepStateAt: null,
    }));
  });

  it("drops a power object with nothing usable in it", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    const response = await registerWithPower(env, token, "garbage", {
      power: { batteryPercent: "full", charging: 1, onExternalPower: "yes" },
    });

    await expect(response.json()).resolves.toEqual(expect.objectContaining({ power: null }));
  });

  it("timestamps a sleep state the host reported without one", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    const response = await registerWithPower(env, token, "untimed", { sleepState: "asleep" });

    const body = await response.json() as { sleepStateAt: number | null };
    expect(body.sleepStateAt).toEqual(expect.any(Number));
  });

  it("does not let an older host's heartbeat erase a stored power state", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await registerWithPower(env, token, "laptop", {
      power: { batteryPercent: 41, charging: true, onExternalPower: true },
      sleepState: "asleep",
      sleepStateAt: 1_700_000_000_000,
    });

    // A second brain on the same machine, built before power existed.
    const response = await register(env, token, "laptop");

    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      power: { batteryPercent: 41, charging: true, onExternalPower: true },
      sleepState: "asleep",
      sleepStateAt: 1_700_000_000_000,
    }));
  });

  it("publishes the wake that follows a sleep", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await registerWithPower(env, token, "laptop", {
      sleepState: "asleep",
      sleepStateAt: 1_700_000_000_000,
    });

    const response = await registerWithPower(env, token, "laptop", {
      sleepState: "awake",
      sleepStateAt: 1_700_000_060_000,
    });

    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      sleepState: "awake",
      sleepStateAt: 1_700_000_060_000,
    }));
  });

  it("lists power alongside the machines it belongs to", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await registerWithPower(env, token, "laptop", {
      power: { batteryPercent: 12, charging: false, onExternalPower: false },
      sleepState: "asleep",
      sleepStateAt: 1_700_000_000_000,
    });

    const response = await handleRequest(request("GET", "/account/machines", token), env);
    const body = await response.json() as { machines: Array<Record<string, unknown>> };

    expect(body.machines[0]).toEqual(expect.objectContaining({
      machineKey: "laptop",
      power: { batteryPercent: 12, charging: false, onExternalPower: false },
      sleepState: "asleep",
    }));
  });
});
