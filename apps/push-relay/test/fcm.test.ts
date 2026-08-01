import { exportPKCS8, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFcmTokenCacheForTesting,
  parseFcmServiceAccount,
  sendFcmPush,
} from "../src/fcm";

describe("FCM HTTP-v1 sender", () => {
  beforeEach(() => clearFcmTokenCacheForTesting());

  it("rejects incomplete service-account secrets", () => {
    expect(parseFcmServiceAccount(undefined)).toBeNull();
    expect(parseFcmServiceAccount("{}")).toBeNull();
  });

  it("mints OAuth once and sends a high-priority data-only message", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const config = parseFcmServiceAccount(JSON.stringify({
      project_id: "ade-android",
      client_email: "push@ade-android.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    expect(config).not.toBeNull();
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return calls.length === 1
        ? new Response(JSON.stringify({ access_token: "oauth-token", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ name: "projects/ade-android/messages/1" }), { status: 200 });
    };

    const first = await sendFcmPush(config!, {
      deviceToken: "fcm-registration-token-123456789",
      data: { category: "approval", sessionId: "session-1", itemId: "item-1" },
      priority: "high",
      collapseKey: "attention-1",
    }, fetchFn, 1_800_000_000_000);
    const second = await sendFcmPush(config!, {
      deviceToken: "fcm-registration-token-123456789",
      data: { category: "attention" },
    }, fetchFn, 1_800_000_001_000);

    expect(first).toMatchObject({ ok: true, tokenInvalid: false });
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(3);
    const [, request] = calls[1]!;
    const body = JSON.parse(String(request?.body));
    expect(body.message).toEqual({
      token: "fcm-registration-token-123456789",
      data: { category: "approval", sessionId: "session-1", itemId: "item-1" },
      android: { priority: "high", ttl: "86400s", collapse_key: "attention-1" },
    });
    expect(body.message).not.toHaveProperty("notification");
  });

  it("marks an UNREGISTERED token invalid", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const config = parseFcmServiceAccount(JSON.stringify({
      project_id: "ade-android",
      client_email: "invalid@ade-android.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
    }))!;
    let callCount = 0;
    const fetchFn: typeof fetch = async () => {
      callCount += 1;
      return callCount === 1
        ? new Response(JSON.stringify({ access_token: "token" }), { status: 200 })
        : new Response(JSON.stringify({
          error: {
            status: "NOT_FOUND",
            details: [{ errorCode: "UNREGISTERED" }],
          },
        }), { status: 404 });
    };

    await expect(sendFcmPush(config, {
      deviceToken: "expired-registration-token-12345",
      data: { category: "attention" },
    }, fetchFn)).resolves.toMatchObject({ ok: false, status: 404, tokenInvalid: true });
  });
});
