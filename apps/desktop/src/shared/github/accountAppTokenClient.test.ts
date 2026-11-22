import { describe, expect, it } from "vitest";
import { createAccountAppTokenClient } from "./accountAppTokenClient";

/**
 * The account App token client. The account directory is faked at the
 * network boundary (`fetchImpl`); the cache lives in memory.
 */
describe("account App token client", () => {
  it("never hands a token that was asked for one ADE account to a caller after a switch to another", async () => {
    let accountUserId = "user_a";
    const pending: Array<{ account: string; answer: () => void }> = [];
    let arrived: () => void = () => undefined;
    /** Resolves when the next request reaches the fake directory. */
    const nextRequest = () => new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const client = createAccountAppTokenClient({
      // Each request waits until the test answers it, with the token of the
      // account whose bearer it carried.
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        const account = String(new Headers(init?.headers).get("authorization")).replace("Bearer bearer-", "");
        return await new Promise<Response>((resolve) => {
          queueMicrotask(arrived);
          pending.push({
            account,
            answer: () => resolve(Response.json({
              accessToken: `ghu_token_of_${account}`,
              useForSec: 3600,
              expiresAt: Date.now() + 3_600_000,
              githubLogin: `login-${account}`,
              githubUserId: 1,
              generation: 1,
            })),
          });
        });
      }) as typeof fetch,
      getAccountAccessToken: async () => `bearer-${accountUserId}`,
      getAccountUserId: () => accountUserId,
      getDirectoryBaseUrl: () => "https://directory.test",
      store: null,
      holderId: "test",
      clientKind: "desktop",
    });

    const firstRequest = nextRequest();
    const askedByA = client.getToken();
    await firstRequest;
    expect(pending).toHaveLength(1);
    // The person switches to account B while A's request is still out.
    accountUserId = "user_b";
    const secondRequest = nextRequest();
    const askedByB = client.getToken();
    pending[0]!.answer();

    const answerToA = await askedByA;
    expect(answerToA.ok).toBe(false);
    await secondRequest;
    expect(pending).toHaveLength(2);
    expect(pending[1]!.account).toBe("user_b");
    pending[1]!.answer();
    const answerToB = await askedByB;
    expect(answerToB).toMatchObject({ ok: true, token: "ghu_token_of_user_b" });
    expect(JSON.stringify([answerToA, answerToB])).not.toContain("ghu_token_of_user_a");
  });
});
