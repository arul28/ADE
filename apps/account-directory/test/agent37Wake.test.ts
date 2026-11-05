import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AGENT37_WAKE_LEAD_MS, handleAgent37WakeRequest, runAgent37Wakes, type Agent37WakeEnv } from "../src/agent37Wake";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

/**
 * Timed wakes: a sleeping Agent 37 machine's next timer is held here and the
 * cron requests its wake URL before it is due. What a caller depends on: the
 * machine is woken once, ahead of its time, and never later; a newer time it
 * sent wins; and the cron only ever requests an Agent 37 machine address.
 * Runs the migration's real SQL on SQLite.
 */

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const URL_ = "https://directory.test/agent37/wake";
const WAKE = "https://wake-abc123.agent37.app";

// Loaded at run time: this Vitest's resolver doesn't know `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** D1's statement surface over node:sqlite, with the real migration applied. */
function sqliteD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "../migrations/0016_agent37_wakes.sql"), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      db.prepare(sql).run(...(params as never[]));
      return { success: true };
    },
    first: async <T>() => (db.prepare(sql).get(...(params as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function env(): Agent37WakeEnv {
  return { CLERK_JWKS_URL: jwksEndpoint(), CLERK_ISSUER: ISSUER, CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID, DB: sqliteD1() } as Agent37WakeEnv;
}

async function send(target: Agent37WakeEnv, method: "PUT" | "DELETE", body: unknown, sub = "user_1"): Promise<Response> {
  return handleAgent37WakeRequest(new Request(URL_, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${await mintToken({ sub })}` },
    body: JSON.stringify(body),
  }), target, NOW);
}

describe("agent37 timed wakes", () => {
  it("wakes a machine once, ahead of its timer, with the latest time it sent", async () => {
    const target = env();
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(String(url));
      return new Response(null, { status: 502 });
    }) as unknown as typeof fetch;

    expect((await send(target, "PUT", { instanceId: "abcde12345", url: WAKE, at: NOW + 60 * 60_000 })).status).toBe(200);
    // The machine moved its timer earlier before sleeping again: that one counts.
    expect((await send(target, "PUT", { instanceId: "abcde12345", url: WAKE, at: NOW + 30 * 60_000 })).status).toBe(200);

    expect(await runAgent37Wakes(target, { now: NOW + 30 * 60_000 - AGENT37_WAKE_LEAD_MS - 60_000, fetchImpl })).toEqual({ woken: 0, failed: 0 });
    expect(await runAgent37Wakes(target, { now: NOW + 30 * 60_000 - AGENT37_WAKE_LEAD_MS, fetchImpl })).toEqual({ woken: 1, failed: 0 });
    // Woken once: the old hour-out time was replaced, not kept beside it.
    expect(await runAgent37Wakes(target, { now: NOW + 2 * 60 * 60_000, fetchImpl })).toEqual({ woken: 0, failed: 0 });
    expect(requested).toEqual([WAKE]);
  });

  it("forgets a cleared timer, and keeps one account's machine apart from another's", async () => {
    const target = env();
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(String(url));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await send(target, "PUT", { instanceId: "abcde12345", url: WAKE, at: NOW + 10 * 60_000 });
    await send(target, "PUT", { instanceId: "abcde12345", url: "https://wake-other.agent37.app", at: NOW + 10 * 60_000 }, "user_2");
    // Another account clearing the same machine id leaves this account's row alone.
    await send(target, "DELETE", { instanceId: "abcde12345" }, "user_2");
    expect(await runAgent37Wakes(target, { now: NOW + 10 * 60_000, fetchImpl })).toEqual({ woken: 1, failed: 0 });
    expect(requested).toEqual([WAKE]);
  });

  it.each([
    ["an address that isn't an Agent 37 machine", { instanceId: "abcde12345", url: "https://evil.example.com", at: NOW + 60_000 }],
    ["an Agent 37 address with a path", { instanceId: "abcde12345", url: `${WAKE}/admin`, at: NOW + 60_000 }],
    ["plain http", { instanceId: "abcde12345", url: "http://wake-abc123.agent37.app", at: NOW + 60_000 }],
    ["a malformed machine id", { instanceId: "../x", url: WAKE, at: NOW + 60_000 }],
    ["a time months away", { instanceId: "abcde12345", url: WAKE, at: NOW + 90 * 24 * 60 * 60_000 }],
  ])("refuses %s", async (_label, body) => {
    const target = env();
    expect((await send(target, "PUT", body)).status).toBe(400);
    const requested: string[] = [];
    await runAgent37Wakes(target, {
      now: NOW + 365 * 24 * 60 * 60_000,
      fetchImpl: (async (url: string) => { requested.push(String(url)); return new Response(null); }) as unknown as typeof fetch,
    });
    expect(requested).toEqual([]);
  });

  it("refuses a caller without an account bearer", async () => {
    const response = await handleAgent37WakeRequest(new Request(URL_, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "abcde12345", url: WAKE, at: NOW + 60_000 }),
    }), env(), NOW);
    expect(response.status).toBe(401);
  });
});
