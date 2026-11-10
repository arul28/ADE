import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLaneShareRequest, type LaneShareEnv } from "../src/laneShares/routes";
import { handleSignupAnalyticsRequest } from "../src/signupAnalytics";
import type { LaneShareGiverView, LaneShareHostResponse } from "../src/laneShares/contract";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

/**
 * Lane sharing's access rules, through the real route handler on the real
 * migrations. Only the network is faked: Clerk's user API (the verified
 * addresses) and Resend. These rules cannot be exercised by hand without two
 * real Clerk accounts, so the tests are the check.
 */

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const GIVER = "user_giver";
const GUEST = "user_guest";
const TWIN = "user_twin";
const OTHER = "user_other";
const UNVERIFIED = "user_unverified";
const MACHINE = "machine-studio-0001";
const SECOND_MACHINE = "machine-laptop-0002";
const LANE = "lane-1111";
const WEB = "https://app.ade-app.dev";
const CLERK = "https://api.clerk.com/v1/users/";
const RESEND = "https://api.resend.com/emails";

type SqliteStatement = {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
};

/** D1 over node:sqlite with every migration applied; a batch is one transaction, as on D1. */
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(__dirname, "../migrations");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
    first: async <T>() => (db.prepare(sql).get(...params) ?? null) as T | null,
    all: async <T>() => ({ success: true, results: db.prepare(sql).all(...params) as T[] }),
    apply: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  const DB = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      db.exec("begin");
      try {
        const results = statements.map((entry) => entry.apply());
        db.exec("commit");
        return results;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
  } as unknown as D1Database;
  return {
    DB,
    exec: (sql: string, ...params: unknown[]) => { db.prepare(sql).run(...params); },
    row: (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as Record<string, unknown>,
  };
}

type ClerkAddress = { email: string; verified: boolean };

/** Clerk's user API and Resend at `fetch`. */
function fakeNetwork() {
  const realFetch = globalThis.fetch;
  const users = new Map<string, { addresses: ClerkAddress[]; firstName?: string }>([
    [GIVER, { addresses: [{ email: "Giver@Example.com", verified: true }], firstName: "Gia" }],
    [GUEST, { addresses: [{ email: "guest@example.com", verified: true }] }],
    [TWIN, { addresses: [{ email: "guest@example.com", verified: true }] }],
    [OTHER, { addresses: [{ email: "other@example.com", verified: true }] }],
    [UNVERIFIED, { addresses: [{ email: "guest@example.com", verified: false }] }],
  ]);
  const emails: Array<{ to: string[]; subject: string; text: string; html: string }> = [];
  let resendStatus = 200;
  /** When set, Clerk answers no lookup until this many have arrived: every caller reads before any writes. */
  let barrier: { expected: number; arrived: number; release: () => void; promise: Promise<void> } | null = null;

  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(CLERK)) {
      if (barrier) {
        barrier.arrived += 1;
        if (barrier.arrived >= barrier.expected) barrier.release();
        await barrier.promise;
      }
      const id = decodeURIComponent(url.slice(CLERK.length));
      const user = users.get(id);
      if (!user) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({
        id,
        first_name: user.firstName ?? null,
        last_name: null,
        username: null,
        email_addresses: user.addresses.map((address, index) => ({
          id: `idn_${index}`,
          email_address: address.email,
          verification: { status: address.verified ? "verified" : "unverified" },
        })),
      }), { status: 200 });
    }
    if (url === RESEND) {
      emails.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: resendStatus });
    }
    return realFetch(input as RequestInfo, init);
  };
  return {
    users,
    emails,
    fetchStub,
    setResendStatus: (status: number) => { resendStatus = status; },
    holdClerkUntil: (expected: number) => {
      let release = () => {};
      const promise = new Promise<void>((resolve) => { release = resolve; });
      barrier = { expected, arrived: 0, release, promise };
    },
  };
}

let clock = NOW;
let tokens: Record<string, string> = {};
let data: ReturnType<typeof sqliteD1>;
let net: ReturnType<typeof fakeNetwork>;
let env: LaneShareEnv;

function send(caller: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleLaneShareRequest(new Request(`https://directory.test${url}`, {
    method,
    headers: {
      ...(caller ? { authorization: `Bearer ${tokens[caller]}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

function invite(overrides: Record<string, unknown> = {}, caller = GIVER): Promise<Response> {
  return send(caller, "POST", "/lane-shares", {
    receiverEmail: " Guest@Example.com ",
    repoKey: "repo:github.com/acme/widgets",
    machineKey: MACHINE,
    laneId: LANE,
    projectLabel: "Widgets",
    laneLabel: "Fix login",
    preset: "comment",
    risk: "low",
    ...overrides,
  });
}

async function invitedId(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await invite(overrides);
  expect(response.status).toBe(201);
  return ((await response.json()) as { grant: LaneShareGiverView }).grant.id;
}

async function activeId(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = await invitedId(overrides);
  expect((await send(GUEST, "POST", `/lane-shares/${id}/accept`)).status).toBe(200);
  return id;
}

const hostRead = async (machineKey = MACHINE, caller = GIVER): Promise<LaneShareHostResponse> => {
  const response = await send(caller, "POST", "/lane-shares/host", { machineKey });
  expect(response.status).toBe(200);
  return response.json() as Promise<LaneShareHostResponse>;
};

const stateOf = async (id: string): Promise<string> =>
  ((await (await send(GIVER, "GET", `/lane-shares/${id}`)).json()) as { grant: { state: string } }).grant.state;

const MISSING_ID = "ls_00000000000000000000000000000000";

beforeEach(async () => {
  clock = NOW;
  // Minted against the real clock: the token check reads it, not the mocked one below.
  tokens = Object.fromEntries(await Promise.all([GIVER, GUEST, TWIN, OTHER, UNVERIFIED].map(async (sub) => [sub, await mintToken({ sub })])));
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  data = sqliteD1();
  net = fakeNetwork();
  vi.stubGlobal("fetch", net.fetchStub);
  for (const machineKey of [MACHINE, SECOND_MACHINE]) {
    data.exec("insert into machines (user_id, machine_key, created_at) values (?, ?, ?)", GIVER, machineKey, NOW);
  }
  data.exec("insert into machines (user_id, machine_key, created_at) values (?, ?, ?)", OTHER, "machine-other-0003", NOW);
  env = {
    DB: data.DB,
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    CLERK_SECRET_KEY: "sk_test_clerk",
    RESEND_API_KEY: "re_test",
    WEB_CLIENT_ORIGIN: WEB,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("who may see and change a grant", () => {
  it("answers anyone but the giver, the receiver and the verified invited address exactly as an id that does not exist", async () => {
    const id = await invitedId();
    const missing = await send(OTHER, "GET", `/lane-shares/${MISSING_ID}`);
    const missingBody = await missing.json();
    for (const caller of [OTHER, UNVERIFIED]) {
      const response = await send(caller, "GET", `/lane-shares/${id}`);
      expect([caller, response.status, await response.json()]).toEqual([caller, missing.status, missingBody]);
    }
    expect(missing.status).toBe(404);

    const roles = await Promise.all([GIVER, GUEST].map(async (caller) => ((await (await send(caller, "GET", `/lane-shares/${id}`)).json()) as { role: string }).role));
    expect(roles).toEqual(["giver", "invitee"]);

    // Without Clerk a stranger can't be told apart from the invitee, so both an existing and a missing id answer 503.
    env.CLERK_SECRET_KEY = undefined;
    expect((await send(OTHER, "GET", `/lane-shares/${id}`)).status).toBe(503);
    expect((await send(OTHER, "GET", `/lane-shares/${MISSING_ID}`)).status).toBe(503);
    expect((await send(GIVER, "GET", `/lane-shares/${id}`)).status).toBe(200);
  });

  it.each<[string, string, string, unknown, number, string]>([
    ["a stranger accepts", OTHER, "accept", undefined, 404, "pending"],
    ["an unverified copy of the address accepts", UNVERIFIED, "accept", undefined, 404, "pending"],
    ["the giver accepts", GIVER, "accept", undefined, 400, "pending"],
    ["the invited address accepts", GUEST, "accept", undefined, 200, "active"],
    ["the guest revokes", GUEST, "revoke", undefined, 404, "pending"],
    ["a stranger revokes", OTHER, "revoke", undefined, 404, "pending"],
    ["the giver revokes", GIVER, "revoke", undefined, 200, "revoked"],
    ["a stranger declines", OTHER, "leave", undefined, 404, "pending"],
    ["the invited address declines", GUEST, "leave", undefined, 200, "left"],
    ["the guest moves it", GUEST, "move", { machineKey: SECOND_MACHINE }, 404, "pending"],
    ["the giver moves it to a machine of another account", GIVER, "move", { machineKey: "machine-other-0003" }, 400, "pending"],
  ])("%s", async (_label, caller, action, body, status, state) => {
    const id = await invitedId();
    const response = await send(caller, "POST", `/lane-shares/${id}/${action}`, body);
    expect(response.status).toBe(status);
    expect(await stateOf(id)).toBe(state);
  });

  it.each<[string, string, unknown, number]>([
    ["the guest", GUEST, { preset: "collaborate" }, 404],
    ["a stranger", OTHER, { preset: "collaborate" }, 404],
    ["the giver, with a field outside the editable three", GIVER, { preset: "collaborate", machineKey: SECOND_MACHINE }, 400],
    ["the giver, with an unknown preset", GIVER, { preset: "admin" }, 400],
    ["the giver", GIVER, { preset: "collaborate", risk: "high" }, 200],
  ])("edit by %s", async (_label, caller, body, status) => {
    const id = await activeId();
    expect((await send(caller, "PATCH", `/lane-shares/${id}`, body)).status).toBe(status);
    const grant = ((await (await send(GIVER, "GET", `/lane-shares/${id}`)).json()) as { grant: LaneShareGiverView }).grant;
    expect(grant.preset).toBe(status === 200 ? "collaborate" : "comment");
  });

  it("lists a grant only for its giver and its receiver", async () => {
    const id = await activeId();
    const ids = async (caller: string, list: string) =>
      ((await (await send(caller, "GET", `/lane-shares/${list}`)).json()) as { grants: Array<{ id: string }> }).grants.map((grant) => grant.id);
    expect(await ids(GIVER, "given")).toEqual([id]);
    expect(await ids(GUEST, "received")).toEqual([id]);
    expect(await ids(OTHER, "given")).toEqual([]);
    expect(await ids(OTHER, "received")).toEqual([]);
    expect(await ids(GUEST, "given")).toEqual([]);
  });
});

describe("invites", () => {
  it.each<[string, Record<string, unknown>, number, string]>([
    ["the giver's own verified address", { receiverEmail: "giver@example.COM" }, 400, "self_invite"],
    ["a machine of another account", { machineKey: "machine-other-0003" }, 400, "unknown_machine"],
    ["a repo key with a credential", { repoKey: "repo:token@github.com/acme/widgets" }, 400, "bad_request"],
    ["a state that is not a preset", { preset: "owner" }, 400, "bad_request"],
    ["an end date in the past", { endsAt: NOW - 1 }, 400, "bad_request"],
  ])("refuses an invite to %s", async (_label, overrides, status, code) => {
    const response = await invite(overrides);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it("allows five guests on a lane, also when invites race, and a sixth once one is removed", async () => {
    const responses = await Promise.all(Array.from({ length: 7 }, (_, index) => invite({ receiverEmail: `g${index}@example.com` })));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 201, 409, 409]);
    const refused = responses.find((response) => response.status === 409)!;
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("guest_limit");

    const first = ((await responses.find((response) => response.status === 201)!.json()) as { grant: LaneShareGiverView }).grant;
    expect((await send(GIVER, "POST", `/lane-shares/${first.id}/revoke`)).status).toBe(200);
    expect((await invite({ receiverEmail: "g-late@example.com" })).status).toBe(201);
  });

  it("frees a guest slot when a pending invite expires", async () => {
    for (let index = 0; index < 5; index += 1) await invitedId({ receiverEmail: `g${index}@example.com` });
    expect((await invite({ receiverEmail: "sixth@example.com" })).status).toBe(409);
    clock = NOW + DAY;
    expect((await invite({ receiverEmail: "sixth@example.com" })).status).toBe(201);
  });

  it("refreshes a pending invite to the same address and refuses one to an active guest", async () => {
    const id = await invitedId();
    clock = NOW + 20 * HOUR;
    const again = await invite({ receiverEmail: "GUEST@example.com", preset: "suggest" });
    expect(again.status).toBe(200);
    const refreshed = (await again.json()) as { grant: LaneShareGiverView; refreshed: boolean };
    expect([refreshed.grant.id, refreshed.refreshed, refreshed.grant.inviteExpiresAt, refreshed.grant.preset])
      .toEqual([id, true, NOW + 20 * HOUR + DAY, "suggest"]);
    // The old window would have closed here; the refreshed one has not.
    clock = NOW + 30 * HOUR;
    expect((await send(GUEST, "POST", `/lane-shares/${id}/accept`)).status).toBe(200);

    const active = await invite();
    expect(active.status).toBe(409);
    expect(((await active.json()) as { error: { code: string } }).error.code).toBe("already_shared");
  });

  it("lets the giver invite again after the guest left", async () => {
    const id = await activeId();
    expect((await send(GUEST, "POST", `/lane-shares/${id}/leave`)).status).toBe(200);
    const second = await invitedId();
    expect(second).not.toBe(id);
    expect((await send(GUEST, "POST", `/lane-shares/${second}/accept`)).status).toBe(200);
  });

  it("caps invites per giver per day", async () => {
    for (let index = 0; index < 20; index += 1) {
      expect((await invite({ laneId: `lane-${index}`, receiverEmail: `g${index}@example.com` })).status).toBe(201);
    }
    const over = await invite({ laneId: "lane-20", receiverEmail: "g20@example.com" });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("invite_limit");
    clock = NOW + DAY;
    expect((await invite({ laneId: "lane-20", receiverEmail: "g20@example.com" })).status).toBe(201);
  });
});

describe("invite email", () => {
  it("sends the link with every client text escaped, and limits re-sends", async () => {
    const response = await invite({ laneLabel: "<img src=x onerror=alert(1)>" });
    const body = (await response.json()) as { grant: LaneShareGiverView; emailSent: boolean };
    expect(body.emailSent).toBe(true);
    expect(net.emails).toHaveLength(1);
    expect(net.emails[0]!.to).toEqual(["guest@example.com"]);
    expect(net.emails[0]!.html).toContain(`https://ade-app.dev/open?type=lane-share&amp;id=${body.grant.id}`);
    expect(net.emails[0]!.html).not.toContain("<img src=x");

    const soon = (await (await invite()).json()) as { emailSent: boolean; emailNotSentReason: string };
    expect([soon.emailSent, soon.emailNotSentReason, net.emails.length]).toEqual([false, "rate_limited", 1]);
    clock = NOW + 11 * 60_000;
    expect(((await (await invite()).json()) as { emailSent: boolean }).emailSent).toBe(true);
  });

  it.each<[string, () => void, string]>([
    ["no sender configured", () => { env.RESEND_API_KEY = undefined; }, "not_configured"],
    ["the sender failing", () => net.setResendStatus(500), "failed"],
  ])("still makes the invite with %s", async (_label, arrange, reason) => {
    arrange();
    const response = await invite();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { emailSent: boolean; emailNotSentReason: string };
    expect([body.emailSent, body.emailNotSentReason]).toEqual([false, reason]);
  });
});

describe("accept", () => {
  it.each<[string, number, string, number, string]>([
    ["a millisecond before the window closes", DAY - 1, "pending", 200, "active"],
    ["at the moment the window closes", DAY, "expired", 410, "expired"],
  ])("decides expiry on the server clock: %s", async (_label, offset, before, status, state) => {
    const id = await invitedId();
    clock = NOW + offset;
    // Read before anything writes the expiry: the derived state alone must say it.
    expect(await stateOf(id)).toBe(before);
    expect((await send(GUEST, "POST", `/lane-shares/${id}/accept`)).status).toBe(status);
    expect(await stateOf(id)).toBe(state);
  });

  it("counts an address verified after the invite was sent", async () => {
    const id = await invitedId({ receiverEmail: "late@example.com" });
    expect((await send(OTHER, "POST", `/lane-shares/${id}/accept`)).status).toBe(404);
    net.users.get(OTHER)!.addresses.push({ email: "late@example.com", verified: true });
    expect((await send(OTHER, "POST", `/lane-shares/${id}/accept`)).status).toBe(200);
  });

  it("is idempotent for two devices of one guest accepting at once", async () => {
    const id = await invitedId();
    net.holdClerkUntil(2);
    const responses = await Promise.all([1, 2].map(() => send(GUEST, "POST", `/lane-shares/${id}/accept`)));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const row = data.row("select receiver_user_id, state, version from lane_shares where id = ?", id);
    expect(row).toEqual({ receiver_user_id: GUEST, state: "active", version: 2 });
  });

  it("never makes two accounts the receiver, even when both hold the address and accept at once", async () => {
    const id = await invitedId();
    net.holdClerkUntil(2);
    const [guest, twin] = await Promise.all([GUEST, TWIN].map((caller) => send(caller, "POST", `/lane-shares/${id}/accept`)));
    expect([guest.status, twin.status].sort()).toEqual([200, 404]);
    const winner = guest.status === 200 ? GUEST : TWIN;
    expect(data.row("select receiver_user_id from lane_shares where id = ?", id).receiver_user_id).toBe(winner);
  });

  it("keeps the grant when the receiver later removes the address", async () => {
    const id = await activeId();
    net.users.get(GUEST)!.addresses = [{ email: "new@example.com", verified: true }];
    const received = (await (await send(GUEST, "GET", "/lane-shares/received")).json()) as { grants: Array<{ id: string; state: string }> };
    expect(received.grants).toEqual([expect.objectContaining({ id, state: "active" })]);
    expect((await hostRead()).grants.map((grant) => [grant.id, grant.receiverUserId])).toEqual([[id, GUEST]]);
  });
});

describe("host read", () => {
  it("drops a grant at once when it is revoked, left, ended or moved", async () => {
    const id = await activeId({ endsAt: NOW + 2 * DAY });
    expect((await hostRead()).grants).toEqual([expect.objectContaining({ id, state: "active", receiverUserId: GUEST, laneId: LANE })]);

    expect((await send(GIVER, "POST", `/lane-shares/${id}/revoke`)).status).toBe(200);
    const afterRevoke = await hostRead();
    expect(afterRevoke.grants).toEqual([]);
    expect(afterRevoke.closed).toEqual([expect.objectContaining({ id, state: "revoked" })]);
    // A second revoke changes nothing.
    expect((await send(GIVER, "POST", `/lane-shares/${id}/revoke`)).status).toBe(200);

    const ending = await activeId({ endsAt: NOW + HOUR });
    clock = NOW + HOUR;
    const afterEnd = await hostRead();
    expect(afterEnd.grants).toEqual([]);
    expect(afterEnd.closed.map((grant) => [grant.id, grant.state])).toContainEqual([ending, "ended"]);

    const moving = await activeId();
    expect((await send(GIVER, "POST", `/lane-shares/${moving}/move`, { machineKey: SECOND_MACHINE })).status).toBe(200);
    expect((await hostRead()).grants).toEqual([]);
    expect((await hostRead(SECOND_MACHINE)).grants.map((grant) => grant.id)).toEqual([moving]);
  });

  it.each<[string, string, string, Record<string, string>, number]>([
    ["another account naming the giver's machine", OTHER, MACHINE, {}, 404],
    ["a browser, even from the web client", GIVER, MACHINE, { origin: WEB }, 403],
  ])("refuses %s", async (_label, caller, machineKey, headers, status) => {
    await activeId();
    expect((await send(caller, "POST", "/lane-shares/host", { machineKey }, headers)).status).toBe(status);
  });
});

describe("origins", () => {
  it.each<[string, string, string, Record<string, string>, number]>([
    ["a preflight from the web client", "OPTIONS", "/lane-shares/given", { origin: WEB, "access-control-request-method": "GET", "access-control-request-headers": "authorization" }, 204],
    ["a preflight from another site", "OPTIONS", "/lane-shares/given", { origin: "https://evil.example", "access-control-request-method": "GET" }, 403],
    ["a read from another site", "GET", "/lane-shares/given", { origin: "https://evil.example" }, 403],
    ["a read from the web client", "GET", "/lane-shares/given", { origin: WEB }, 200],
  ])("%s", async (_label, method, url, headers, status) => {
    const response = await send(method === "OPTIONS" ? null : GIVER, method, url, undefined, headers);
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBe(status === 403 ? null : headers.origin === WEB ? WEB : null);
  });
});

describe("account deletion", () => {
  it("closes every live grant given by or to the deleted account", async () => {
    const given = await activeId();
    const pending = await invitedId({ receiverEmail: "someone@example.com" });
    const secret = Buffer.from("clerk-webhook-secret-for-this-test");
    const deleteAccount = (userId: string) => {
      const body = JSON.stringify({ type: "user.deleted", timestamp: NOW, data: { id: userId, deleted: true } });
      const timestamp = String(Math.floor(NOW / 1000));
      const signature = createHmac("sha256", secret).update(`msg_${userId}.${timestamp}.${body}`).digest("base64");
      return handleSignupAnalyticsRequest(new Request("https://directory.test/webhooks/clerk", {
        method: "POST",
        headers: { "svix-id": `msg_${userId}`, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
        body,
      }), { DB: data.DB, CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${secret.toString("base64")}` });
    };
    expect((await deleteAccount(GUEST)).status).toBe(200);
    expect(await stateOf(given)).toBe("left");
    expect(await stateOf(pending)).toBe("pending");

    expect((await deleteAccount(GIVER)).status).toBe(200);
    expect(data.row("select state, closed_reason from lane_shares where id = ?", pending)).toEqual({ state: "revoked", closed_reason: "account_deleted" });
    expect((await hostRead()).grants).toEqual([]);
  });
});
