import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGithubAppRequest, type GithubAppEnv } from "../src/githubApp/routes";
import { runGithubAppCron } from "../src/githubApp/grants";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

/**
 * The account's GitHub App sign-in, through its routes, on the real
 * migrations and SQL (`node:sqlite` stands in for D1). GitHub is the only
 * thing faked, at the network boundary.
 */

// Loaded at run time: the test runner's resolver does not know `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...v: unknown[]): unknown; all(...v: unknown[]): unknown[]; run(...v: unknown[]): { changes: number | bigint } };
  };
};

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** The slice of D1 the App routes use, over an in-memory SQLite with every migration applied. */
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
  }
  const statement = (sql: string, values: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...values) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...values) as T[], success: true, meta: {} }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
  });
  return {
    raw: db,
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      db.exec("begin");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        db.exec("commit");
        return results;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
  };
}

const WEB = "https://github.test";
const API = "https://api.github.test";
const BASE = "https://directory.test";

/** A GitHub that issues one token pair per code exchange or refresh, and records deletes. */
function fakeGithub() {
  let issued = 0;
  const live = new Set<string>();
  const deleted: string[] = [];
  let onRefresh: (() => void) | null = null;
  const issue = () => {
    issued += 1;
    const access = `ghu_access_${issued}`;
    live.add(access);
    return { access_token: access, expires_in: 8 * 3600, refresh_token: `ghr_refresh_${issued}`, refresh_token_expires_in: 180 * 86400 };
  };
  const passThrough = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${WEB}/login/oauth/access_token`) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type") === "refresh_token") onRefresh?.();
      return Response.json(issue());
    }
    if (url === `${API}/user`) return Response.json({ id: 4242, login: "octo" });
    if (url.startsWith(`${API}/applications/`) && url.endsWith("/token") && init?.method === "POST") {
      return Response.json({ user: { id: 4242, login: "octo" } });
    }
    if (url.startsWith(`${API}/applications/`) && init?.method === "DELETE") {
      const token = (JSON.parse(String(init.body)) as { access_token: string }).access_token;
      deleted.push(token);
      live.delete(token);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith(WEB) || url.startsWith(API)) return new Response("unexpected", { status: 500 });
    return passThrough(input, init);
  });
  return {
    spy,
    deleted,
    lastAccess: () => `ghu_access_${issued}`,
    isLive: (token: string) => live.has(token),
    onNextRefresh: (fn: () => void) => {
      onRefresh = () => {
        onRefresh = null;
        fn();
      };
    },
  };
}

type Db = ReturnType<typeof sqliteD1>;

describe("GitHub App sign-in", () => {
  let db: Db;
  let env: GithubAppEnv;
  let github: ReturnType<typeof fakeGithub>;
  const userId = "user_gh";

  beforeEach(() => {
    db = sqliteD1();
    github = fakeGithub();
    env = {
      DB: db,
      CLERK_JWKS_URL: jwksEndpoint(),
      CLERK_ISSUER: ISSUER,
      CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
      GITHUB_APP_CLIENT_ID: "Iv23test",
      GITHUB_APP_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
      GITHUB_WEB_BASE_URL: WEB,
      GITHUB_API_BASE_URL: API,
    } as unknown as GithubAppEnv;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bearer = () => mintToken({ sub: userId, audience: OAUTH_CLIENT_ID, azp: OAUTH_CLIENT_ID });
  const grantLogin = () => (db.raw.prepare("select github_login from github_app_grants where user_id = ?").get(userId) as { github_login: string } | undefined)?.github_login ?? null;
  const call = async (method: string, path: string, body?: unknown) =>
    handleGithubAppRequest(new Request(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${await bearer()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  const confirmForm = (fields: Record<string, string>) =>
    handleGithubAppRequest(new Request(`${BASE}/github/app/callback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
      body: new URLSearchParams(fields).toString(),
    }), env);

  /** Starts a sign-in and follows GitHub's redirect back to the callback: the confirm page. */
  async function toConfirmPage() {
    const started = await call("POST", "/github/app/sign-in", { client: "desktop" });
    expect(started.status, "sign-in started").toBe(201);
    const { signInId, authorizeUrl } = await started.json() as { signInId: string; authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");
    const page = await handleGithubAppRequest(new Request(`${BASE}/github/app/callback?code=one-time-code&state=${encodeURIComponent(state ?? "")}`), env);
    const html = await page.text();
    const field = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? "";
    return { signInId, status: page.status, html, confirm: field("confirm"), heldToken: github.lastAccess() };
  }

  it("saves the grant only after this browser confirms with the page's one-time value", async () => {
    const page = await toConfirmPage();
    expect(page.status).toBe(200);
    expect(page.html).toContain("@octo");
    expect(page.confirm.length).toBeGreaterThanOrEqual(20);
    // GitHub came back, but nothing is connected yet: a forwarded link stops here.
    expect(grantLogin()).toBeNull();

    const wrong = await confirmForm({ signIn: page.signInId, confirm: "x".repeat(43), choice: "connect" });
    expect(await wrong.text()).not.toContain("GitHub is connected");
    expect(grantLogin()).toBeNull();

    const connected = await confirmForm({ signIn: page.signInId, confirm: page.confirm, choice: "connect" });
    expect(connected.status).toBe(200);
    expect(await connected.text()).toContain("GitHub is connected");
    expect(grantLogin()).toBe("octo");
    expect(github.isLive(page.heldToken)).toBe(true);

    const replay = await confirmForm({ signIn: page.signInId, confirm: page.confirm, choice: "connect" });
    expect(await replay.text()).not.toContain("GitHub is connected");
    const read = await call("GET", `/github/app/sign-in/${page.signInId}`);
    expect(await read.json()).toMatchObject({ status: "done", resultCode: "ok" });
  });

  it.each([
    { label: "Cancel", choice: "cancel", late: false, readStatus: "failed" },
    { label: "a Connect after the link ran out", choice: "connect", late: true, readStatus: "expired" },
  ])("$label deletes the held token at GitHub and saves no grant", async ({ choice, late, readStatus }) => {
    const page = await toConfirmPage();
    if (late) {
      db.raw.prepare("update github_app_sign_ins set expires_at = ? where id = ?").run(Date.now() - 1000, page.signInId);
      const before = await call("GET", `/github/app/sign-in/${page.signInId}`);
      expect((await before.json() as { status: string }).status).toBe("expired");
    }
    const answer = await confirmForm({ signIn: page.signInId, confirm: page.confirm, choice });
    expect(await answer.text()).not.toContain("GitHub is connected");
    expect(grantLogin()).toBeNull();
    expect(github.deleted).toContain(page.heldToken);
    const read = await call("GET", `/github/app/sign-in/${page.signInId}`);
    expect((await read.json() as { status: string }).status).toBe(readStatus);
  });

  it("the hourly cron ends an unanswered confirm and deletes its token at GitHub", async () => {
    const page = await toConfirmPage();
    db.raw.prepare("update github_app_sign_ins set expires_at = ? where id = ?").run(Date.now() - 1000, page.signInId);
    const tick = new Date();
    tick.setUTCHours(tick.getUTCHours() === 3 ? 4 : tick.getUTCHours(), 17, 0, 0);
    await runGithubAppCron(env, tick.getTime());

    expect(github.deleted).toContain(page.heldToken);
    const row = db.raw.prepare("select status, tokens_sealed from github_app_sign_ins where id = ?").get(page.signInId) as { status: string; tokens_sealed: string | null };
    expect(row).toMatchObject({ status: "expired", tokens_sealed: null });
    const after = await confirmForm({ signIn: page.signInId, confirm: page.confirm, choice: "connect" });
    expect(await after.text()).not.toContain("GitHub is connected");
    expect(grantLogin()).toBeNull();
  });

  it("an adoption retry with the token the account already holds answers adopted, so the machine drops its copy", async () => {
    const machineSignIn = {
      accessToken: "ghu_device_flow_access_0001",
      refreshToken: "ghr_device_flow_refresh_0001",
      expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
    };
    const first = await call("POST", "/github/app/adopt", machineSignIn);
    expect(first.status).toBe(201);
    expect(grantLogin()).toBe("octo");
    // The first answer was lost; the machine sends the same record again.
    const retry = await call("POST", "/github/app/adopt", machineSignIn);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ adopted: true, githubLogin: "octo" });
    // Another machine's different sign-in is still refused.
    const other = await call("POST", "/github/app/adopt", { ...machineSignIn, accessToken: "ghu_device_flow_access_0002" });
    expect(other.status).toBe(409);
  });

  it("a renewal whose grant was disconnected meanwhile deletes its new token and serves nothing", async () => {
    const page = await toConfirmPage();
    await confirmForm({ signIn: page.signInId, confirm: page.confirm, choice: "connect" });
    expect(grantLogin(), "connected").toBe("octo");
    // The access token is spent, so the next token request renews it. While
    // GitHub answers that refresh, the person disconnects on another computer.
    db.raw.prepare("update github_app_grants set access_expires_at = ? where user_id = ?").run(Date.now() - 60_000, userId);
    github.onNextRefresh(() => {
      db.raw.prepare("delete from github_app_grants where user_id = ?").run(userId);
    });

    const answer = await call("POST", "/github/app/token", {});
    const renewedToken = github.lastAccess();
    expect(renewedToken).not.toBe(page.heldToken);
    expect(answer.status).toBe(404);
    expect(JSON.stringify(await answer.json())).not.toContain(renewedToken);
    expect(github.deleted).toContain(renewedToken);
  });
});
