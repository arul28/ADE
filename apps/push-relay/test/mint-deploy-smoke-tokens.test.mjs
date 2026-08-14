import { afterEach, describe, expect, it, vi } from "vitest";

import {
  frontendApiHostFromPublishableKey,
  mintDeploySmokeTokens,
  mintIssuerSmokeToken,
} from "../scripts/mint-deploy-smoke-tokens.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("push-relay deploy smoke token mint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("decodes the Frontend API host from a publishable key", () => {
    const encoded = Buffer.from("clerk.example.com$").toString("base64");
    expect(frontendApiHostFromPublishableKey(`pk_live_${encoded}`)).toBe("clerk.example.com");
  });

  it("mints a development session JWT through create-session", async () => {
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return jsonResponse(200, { id: "sess_dev" });
      }
      if (url.endsWith("/sessions/sess_dev/tokens")) {
        return jsonResponse(200, { jwt: "dev.jwt.token" });
      }
      return jsonResponse(500, { error: "unexpected" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(mintIssuerSmokeToken({
      secretKey: "sk_test_x",
      publishableKey: "",
      userId: "user_dev",
      label: "secondary",
    })).resolves.toBe("dev.jwt.token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a sign-in ticket when production blocks create-session", async () => {
    const encoded = Buffer.from("accounts.example.com$").toString("base64");
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST" && !url.includes("/client/")) {
        return jsonResponse(400, { errors: [{ code: "unsupported_operation" }] });
      }
      if (url.endsWith("/sign_in_tokens")) {
        return jsonResponse(200, { token: "sit_ticket" });
      }
      if (url === "https://accounts.example.com/v1/client/sign_ins") {
        return jsonResponse(200, { client: { sessions: [{ id: "sess_prod" }] } });
      }
      if (url.endsWith("/sessions/sess_prod/tokens")) {
        return jsonResponse(200, { jwt: "prod.jwt.token" });
      }
      return jsonResponse(500, { error: "unexpected" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(mintIssuerSmokeToken({
      secretKey: "sk_live_x",
      publishableKey: `pk_live_${encoded}`,
      userId: "user_prod",
      label: "primary",
    })).resolves.toBe("prod.jwt.token");
  });

  it("mints both issuer tokens from env without logging them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return jsonResponse(200, { id: `sess_${body.user_id}` });
      }
      if (url.includes("/tokens")) {
        const sessionId = url.split("/sessions/")[1].split("/tokens")[0];
        return jsonResponse(200, { jwt: `jwt-for-${sessionId}` });
      }
      return jsonResponse(500, { error: "unexpected" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await mintDeploySmokeTokens({
      CLERK_PROD_SECRET_KEY: "sk_live_x",
      ADE_PUSH_RELAY_SMOKE_USER_ID: "user_primary",
      CLERK_SECRET_KEY: "sk_test_x",
      ADE_PUSH_RELAY_SECONDARY_SMOKE_USER_ID: "user_secondary",
    });

    expect(tokens).toEqual({
      ADE_PUSH_RELAY_SMOKE_TOKEN: "jwt-for-sess_user_primary",
      ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN: "jwt-for-sess_user_secondary",
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("jwt-for-");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("jwt-for-");
  });
});
