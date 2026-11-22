import { fail } from "./cloud/http";
import {
  CLIENT_MINIMUM_LINKS,
  CLIENT_MINIMUM_PATH,
  type ClientMinimumResponse,
} from "./clientMinimumContract";

/**
 * `GET /client/minimum` (`clientMinimumContract.ts`).
 *
 * Public and read-only: the values are not secret, and a client that cannot
 * sign in (signed out, an expired token) must still learn that it has to
 * update. One D1 row (`client_minimums`, id 1) that only the owner's script
 * writes. Read at most once a minute per isolate; a failed read answers the
 * last good value, or "no minimum", so a database blip never blocks anyone.
 */

export type ClientMinimumEnv = { DB?: D1Database };

const CACHE_MS = 60_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

let cached: { at: number; value: ClientMinimumResponse } | null = null;

function emptyMinimum(): ClientMinimumResponse {
  return {
    desktop: { stable: null, beta: null },
    ios: { appStore: null, testFlight: null, betaApp: null },
    links: { ...CLIENT_MINIMUM_LINKS },
    updatedAt: null,
  };
}

function version(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value.trim()) ? value.trim() : null;
}

function build(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The stored body, checked field by field: anything malformed reads as no minimum. */
export function parseClientMinimum(body: unknown, updatedAt: string | null): ClientMinimumResponse {
  const root = record(body);
  const desktop = record(root.desktop);
  const ios = record(root.ios);
  const appStore = version(record(ios.appStore).version);
  const testFlight = build(record(ios.testFlight).build);
  const betaApp = build(record(ios.betaApp).build);
  return {
    desktop: { stable: version(desktop.stable), beta: version(desktop.beta) },
    ios: {
      appStore: appStore ? { version: appStore } : null,
      testFlight: testFlight ? { build: testFlight } : null,
      betaApp: betaApp ? { build: betaApp } : null,
    },
    links: { ...CLIENT_MINIMUM_LINKS },
    updatedAt,
  };
}

async function readMinimum(env: ClientMinimumEnv, now: number): Promise<ClientMinimumResponse> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  if (!env.DB) return cached?.value ?? emptyMinimum();
  try {
    const row = await env.DB.prepare("select body, updated_at from client_minimums where id = 1")
      .first<{ body: string; updated_at: string | null }>();
    let body: unknown = null;
    try {
      body = row?.body ? JSON.parse(row.body) : null;
    } catch {
      body = null;
    }
    const value = parseClientMinimum(body, row?.updated_at ?? null);
    cached = { at: now, value };
    return value;
  } catch (error) {
    console.warn("client_minimum.read_failed", error instanceof Error ? error.message : String(error));
    return cached?.value ?? emptyMinimum();
  }
}

export function isClientMinimumRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === CLIENT_MINIMUM_PATH;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "600",
};

export async function handleClientMinimumRequest(request: Request, env: ClientMinimumEnv, now = Date.now()): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail("bad_request", "That method isn't allowed here.", 405);
  }
  const value = await readMinimum(env, now);
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
