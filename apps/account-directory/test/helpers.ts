import { afterEach, vi } from "vitest";
import { handleRequest, type Env } from "../src/directory";
import { FakeD1Database } from "./fakeD1";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

/**
 * Shared harness for the suites that drive the directory Worker end to end.
 *
 * The two primitives every one of them needs live next door rather than here:
 * the fake D1 in `./fakeD1` and the JWKS keypair in `./jwks`. What stays is the
 * glue that is specific to THIS Worker — its env, its relay stub, and the
 * request builders that speak its routes.
 */

export {
  FakeD1Database,
  FakeD1Statement,
  type StoredDeviceAuthorization,
  type StoredMachine,
  type StoredPairingGrant,
  type StoredRevocation,
} from "./fakeD1";
export { ISSUER, mintFreshAuthToken, mintToken, OAUTH_CLIENT_ID } from "./jwks";

afterEach(() => {
  vi.restoreAllMocks();
});

export function makeEnv(overrides: Partial<Env> = {}): Env & { DB: FakeD1Database } {
  return {
    DB: new FakeD1Database(),
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    PUSH_RELAY_URL: RELAY_URL,
    DIRECTORY_AUTH_SECRET,
    ...overrides,
  } as unknown as Env & { DB: FakeD1Database };
}

export const RELAY_URL = "https://relay.test";
/** Shared with the push relay; proves a membership change came from here. */
export const DIRECTORY_AUTH_SECRET = "directory-shared-secret";

/**
 * Stands in for the push relay so machine membership changes can be asserted
 * without a network. Machine removal and re-pairing are the only routes that
 * reach it, and both must report a relay failure rather than absorb it.
 */
export function activityRelayStub(
  respond: (url: string, init?: RequestInit) => Response = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
): {
  options: { activityRelay: { fetchImpl: typeof fetch; retryDelayMs: number } };
  calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    directoryAuth: string | null;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    directoryAuth: string | null;
  }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The Workers runtime's own rule, so a relay call that production would
    // throw on fails here too. Every relay test used to accept `"error"`,
    // which is how a 503 on every re-pair reached production.
    if (init?.redirect !== undefined && init.redirect !== "follow" && init.redirect !== "manual") {
      throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual" ("${init.redirect}" won't be implemented since it does not make sense at the edge).`);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      directoryAuth: new Headers(init?.headers).get("x-ade-directory-auth"),
    });
    return respond(String(input), init);
  }) as typeof fetch;
  return { options: { activityRelay: { fetchImpl, retryDelayMs: 0 } }, calls };
}

export function registerBody(machineKey: string, endpoints: unknown = [{ kind: "lan", host: "mac.local", port: 8787 }]) {
  return {
    machineKey,
    deviceId: `device-${machineKey}`,
    name: `Machine ${machineKey}`,
    platform: "macOS",
    deviceType: "desktop",
    pubkey: `pubkey-${machineKey}`,
    reachableEndpoints: endpoints,
  };
}

export function registrationWithRelayRetention(machineKey: string, endpoints: unknown) {
  return {
    ...registerBody(machineKey, endpoints),
    retainRelayEndpoints: true,
  };
}

export function request(
  method: string,
  pathname: string,
  token?: string,
  body?: unknown,
): Request {
  return new Request(`https://directory.test${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * The Clerk authorize URL a confirmed POST opens. The Worker answers with a
 * page that opens it (a meta refresh and a link), not a 302.
 */
export async function signInUrlFrom(response: Response): Promise<URL> {
  const body = await response.clone().text();
  const href = /<a href="([^"]+)">open the sign-in page<\/a>/.exec(body)?.[1];
  if (!href) throw new Error(`No sign-in link in response (${response.status}).`);
  return new URL(href.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
}

export function deviceConfirmationRequest(
  userCode: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://directory.test/device", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://directory.test",
      ...headers,
    },
    body: new URLSearchParams({ user_code: userCode }),
  });
}

export async function register(
  env: Env,
  token: string,
  machineKey: string,
  endpoints?: unknown,
): Promise<Response> {
  return handleRequest(request("POST", "/account/machines/register", token, registerBody(machineKey, endpoints)), env);
}

export const DEVICE_SECRET = "daemon-device-secret-with-at-least-32-bytes";

/**
 * Drive a real `/device/*` sign-in end to end and return the grant it hands
 * back. Nothing here is faked past the Clerk token endpoint: the browser
 * confirmation, the OAuth state round-trip, and the one-time redemption all
 * run, because those steps are exactly what a removed machine cannot perform.
 */
export async function completeDeviceLogin(
  env: Env & { DB: FakeD1Database },
  args: { machineKey?: string; sub?: string; now?: number } = {},
): Promise<{ grant: string | null; accessToken: string }> {
  const now = args.now ?? Date.now();
  const accessToken = await mintToken({ sub: args.sub ?? "user_1" });
  const created = await handleRequest(
    request("POST", "/device/code", undefined, {
      device_secret: DEVICE_SECRET,
      ...(args.machineKey ? { machine_key: args.machineKey } : {}),
    }),
    env,
    { now: () => now },
  );
  const device = await created.json() as Record<string, unknown>;
  const approval = await handleRequest(
    deviceConfirmationRequest(String(device.user_code)),
    env,
    { now: () => now },
  );
  const state = (await signInUrlFrom(approval)).searchParams.get("state")!;
  const tokenExchange = (async () => new Response(JSON.stringify({
    access_token: accessToken,
    refresh_token: "approved-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  await handleRequest(
    new Request(`https://directory.test/device/callback?code=one-time-code&state=${encodeURIComponent(state)}`),
    env,
    { now: () => now, fetchImpl: tokenExchange },
  );
  const redeemed = await handleRequest(
    request("POST", "/device/token", undefined, {
      device_code: device.device_code,
      device_secret: DEVICE_SECRET,
    }),
    env,
    { now: () => now + 6_000 },
  );
  const payload = await redeemed.json() as Record<string, unknown>;
  return {
    grant: typeof payload.pairing_grant === "string" ? payload.pairing_grant : null,
    accessToken,
  };
}

/** Register `machine-a`, then remove it, leaving a live revocation. */
export async function removedMachine(
  env: Env & { DB: FakeD1Database },
  token: string,
): Promise<ReturnType<typeof activityRelayStub>> {
  await register(env, token, "machine-a");
  const relay = activityRelayStub();
  await handleRequest(
    request("DELETE", "/account/machines/machine-a", token),
    env,
    relay.options,
  );
  relay.calls.length = 0;
  return relay;
}

export function pairingRequest(token: string, body: Record<string, unknown>): Request {
  return request("POST", "/account/machines/register", token, {
    ...registerBody("machine-a"),
    pairing: true,
    ...body,
  });
}
