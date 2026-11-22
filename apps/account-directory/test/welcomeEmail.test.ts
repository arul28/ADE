import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSignupAnalyticsRequest } from "../src/signupAnalytics";
import { handleUnsubscribeRequest, runWelcomeEmails } from "../src/welcomeEmail";
import { sqliteD1 } from "./sqliteD1";

/**
 * The day-2 welcome email, end to end on the real migrations: Clerk's sign-up
 * webhook schedules it, the minute cron sends it, the unsubscribe link stops
 * it. Only the network is faked (Clerk, Resend, PostHog).
 */

const SECRET = Buffer.from("test-signing-secret-bytes-0123456789");
const SIGNED_UP = Date.UTC(2026, 10, 21, 15, 2, 0);
/** Minute 4 of the tick a day after sign-up: the first run that sends. */
const FIRST_RUN = SIGNED_UP + 24 * 60 * 60_000 + 2 * 60_000;
const TEN_MINUTES = 10 * 60_000;

function clerkDelivery(body: unknown, id: string): Request {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SECRET).update(`${id}.${timestamp}.${text}`).digest("base64");
  return new Request("https://directory.test/webhooks/clerk", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    body: text,
  });
}

function environment(DB: D1Database) {
  return {
    DB,
    CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${SECRET.toString("base64")}`,
    POSTHOG_PROJECT_TOKEN: "phc_public_project_token",
    RESEND_API_KEY: "re_test",
    CLERK_SECRET_KEY: "sk_test",
    CLOUD_CHAT_MASTER_KEY: "master-key-for-test-0123456789abcdef",
    BILLING_RETURN_ORIGIN: "https://account.ade-app.dev",
  };
}

describe("day-2 welcome email", () => {
  /** Each Resend call that went out (the answer may still be an error), by account. */
  let resendCalls: Array<{ account: string; status: number; unsubscribe: string }>;
  /** Clerk's answer status per account (default: found). */
  let clerkStatus: Record<string, number>;
  /** Resend's answers per account, in order (default: 200). */
  let resendAnswers: Record<string, number[]>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SIGNED_UP);
    resendCalls = [];
    clerkStatus = {};
    resendAnswers = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).startsWith("https://api.clerk.com/v1/users/")) {
        const account = decodeURIComponent(String(url).split("/").pop()!);
        if (clerkStatus[account]) return new Response("{}", { status: clerkStatus[account] });
        return Response.json({
          primary_email_address_id: "e1",
          email_addresses: [{ id: "e1", email_address: `${account}@example.com` }],
          private_metadata: account === "flagged_later" ? { ade_internal: true } : {},
        });
      }
      if (String(url) === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init.body));
        const account = String(body.to[0]).split("@")[0]!;
        const status = resendAnswers[account]?.shift() ?? 200;
        resendCalls.push({ account, status, unsubscribe: String(body.headers["List-Unsubscribe"]).slice(1, -1) });
        return new Response("{}", { status });
      }
      return Response.json({});
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function signUp(env: ReturnType<typeof environment>, account: string, extra: Record<string, unknown> = {}) {
    const response = await handleSignupAnalyticsRequest(
      clerkDelivery({ type: "user.created", data: { id: account, created_at: SIGNED_UP, ...extra } }, `msg_${account}`),
      env,
    );
    expect(response.status).toBe(200);
  }

  async function runAt(env: ReturnType<typeof environment>, at: number) {
    vi.setSystemTime(at);
    await runWelcomeEmails(env, at);
  }

  it("sends one email per account, retries only what can recover, and ends every row once", async () => {
    const data = sqliteD1();
    const env = environment(data.DB);
    for (const account of ["ok", "gone", "clerk_down", "resend_down", "resend_key", "lost_answer", "bad_address", "flagged_later"]) {
      await signUp(env, account);
    }
    await signUp(env, "team", { private_metadata: { ade_internal: true } });
    // Clerk redelivers: still one row.
    await signUp(env, "ok");
    clerkStatus.gone = 404;
    clerkStatus.clerk_down = 503;
    resendAnswers.resend_down = [503, 503, 503];
    resendAnswers.resend_key = [401, 200];
    resendAnswers.lost_answer = [409];
    resendAnswers.bad_address = [422];

    // A day has not passed: nothing goes out.
    await runAt(env, FIRST_RUN - TEN_MINUTES);
    expect(resendCalls).toHaveLength(0);
    // Two ticks overlap on the first run: each row is still sent at most once.
    vi.setSystemTime(FIRST_RUN);
    await Promise.all([runWelcomeEmails(env, FIRST_RUN), runWelcomeEmails(env, FIRST_RUN)]);
    await runAt(env, FIRST_RUN + TEN_MINUTES);
    await runAt(env, FIRST_RUN + 2 * TEN_MINUTES);
    await runAt(env, FIRST_RUN + 3 * TEN_MINUTES);

    expect(data.rows("select user_id, outcome, attempts from welcome_emails order by user_id")).toEqual([
      { user_id: "bad_address", outcome: "failed", attempts: 1 },
      { user_id: "clerk_down", outcome: "failed", attempts: 3 },
      { user_id: "flagged_later", outcome: "skipped_internal", attempts: 1 },
      { user_id: "gone", outcome: "skipped_no_account", attempts: 1 },
      { user_id: "lost_answer", outcome: "sent", attempts: 1 },
      { user_id: "ok", outcome: "sent", attempts: 1 },
      { user_id: "resend_down", outcome: "failed", attempts: 3 },
      { user_id: "resend_key", outcome: "sent", attempts: 2 },
    ]);
    const accepted = resendCalls.filter((call) => call.status === 200 || call.status === 409).map((call) => call.account).sort();
    expect(accepted).toEqual(["lost_answer", "ok", "resend_key"]);
    expect(resendCalls.filter((call) => call.account === "ok")).toHaveLength(1);
    expect(resendCalls.filter((call) => call.account === "resend_down")).toHaveLength(3);
  });

  it("an unsubscribe link must be the account's own, changes nothing on open, and cannot write a deleted account back", async () => {
    const data = sqliteD1();
    const env = environment(data.DB);
    for (const account of ["reader", "leaver", "later"]) await signUp(env, account);
    // `later`'s row is not due yet when the others are sent.
    data.exec("update welcome_emails set due_at = ? where user_id = 'later'", FIRST_RUN + 60 * TEN_MINUTES);
    await runAt(env, FIRST_RUN);
    const link = (account: string) => resendCalls.find((call) => call.account === account)!.unsubscribe;
    const linkFor = (account: string) => link("reader").replace("u=reader", `u=${account}`);

    // Another account's id under this account's token is refused.
    expect((await handleUnsubscribeRequest(new Request(linkFor("later"), { method: "POST" }), env)).status).toBe(400);
    // Opening the link (a mail scanner) shows a button and records nothing.
    expect((await handleUnsubscribeRequest(new Request(link("reader")), env)).status).toBe(200);
    expect(data.rows("select user_id from email_opt_outs")).toEqual([]);
    // The button opts out.
    expect((await handleUnsubscribeRequest(new Request(link("reader"), { method: "POST" }), env)).status).toBe(200);
    expect(data.rows("select user_id from email_opt_outs")).toEqual([{ user_id: "reader" }]);

    // A deleted account's old link writes nothing back.
    await handleSignupAnalyticsRequest(clerkDelivery({ type: "user.deleted", data: { id: "leaver", deleted: true } }, "msg_del"), env);
    expect(data.rows("select user_id from welcome_emails where user_id = 'leaver'")).toEqual([]);
    await handleUnsubscribeRequest(new Request(link("leaver"), { method: "POST" }), env);
    expect(data.rows("select user_id from email_opt_outs order by user_id")).toEqual([{ user_id: "reader" }]);
  });
});
