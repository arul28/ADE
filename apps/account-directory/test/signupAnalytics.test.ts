import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSignupAnalyticsRequest, type SignupAnalyticsEnv } from "../src/signupAnalytics";

const SECRET_BYTES = Buffer.from("test-signing-secret-bytes-0123456789");
const ENV: SignupAnalyticsEnv = {
  CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${SECRET_BYTES.toString("base64")}`,
  POSTHOG_PROJECT_TOKEN: "phc_public_project_token",
};
const NOW_SECONDS = 1_790_000_000;

function delivery(body: unknown, options: { id?: string; timestamp?: number; tamper?: boolean } = {}): Request {
  const text = JSON.stringify(body);
  const id = options.id ?? "msg_1";
  const timestamp = String(options.timestamp ?? NOW_SECONDS);
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${timestamp}.${text}`).digest("base64");
  return new Request("https://directory.test/webhooks/clerk", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    body: options.tamper ? text.replace("user_", "user_x") : text,
  });
}

const userCreated = {
  type: "user.created",
  data: {
    id: "user_2abc",
    created_at: 1_789_999_990_000,
    email_addresses: [{ email_address: "person@example.com" }],
    external_accounts: [{ provider: "oauth_github" }],
  },
};

describe("Clerk sign-up webhook", () => {
  let captures: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
    captures = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      captures.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records one ade_signed_up per account, on the id ADE clients identify with, without the email", async () => {
    expect((await handleSignupAnalyticsRequest(delivery(userCreated), ENV)).status).toBe(200);
    // Svix retries a delivery under the same id: same uuid, so PostHog keeps one.
    expect((await handleSignupAnalyticsRequest(delivery(userCreated), ENV)).status).toBe(200);

    expect(captures).toHaveLength(2);
    expect(captures[0]?.uuid).toBe(captures[1]?.uuid);
    expect(captures[0]).toMatchObject({
      event: "ade_signed_up",
      // The desktop and iOS identify hash, so sign-up lands on the person they build.
      distinct_id: `ade_user_${createHash("sha256").update("ade-product-analytics-account-v1:user_2abc").digest("hex").slice(0, 32)}`,
      properties: { signup_method: "github", $set_once: { clerk_user_id: "user_2abc" } },
    });
    expect(JSON.stringify(captures[0])).not.toContain("person@example.com");
  });

  it.each([
    ["a tampered body", delivery(userCreated, { tamper: true }), 401],
    ["a stale delivery", delivery(userCreated, { timestamp: NOW_SECONDS - 3_600 }), 401],
    ["another event type", delivery({ type: "user.updated", data: { id: "user_2abc" } }), 200],
  ])("records nothing for %s", async (_label, request, status) => {
    expect((await handleSignupAnalyticsRequest(request, ENV)).status).toBe(status);
    expect(captures).toHaveLength(0);
  });

  it("refuses until both secrets are set", async () => {
    const response = await handleSignupAnalyticsRequest(delivery(userCreated), { ...ENV, POSTHOG_PROJECT_TOKEN: "" });
    expect(response.status).toBe(503);
    expect(captures).toHaveLength(0);
  });
});
