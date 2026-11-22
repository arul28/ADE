/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdeAccountStatus } from "../../shared/types";
import { publishAccountStatus } from "./account";
import { createAccountValueSync, type AccountValuePass } from "./accountValueSync";

/**
 * A desktop brain's settings copy can be older than the account. Writing a
 * pass's result over the account from such a copy would bring a finished tour
 * (or a seen page) back on every device, and a write that lands after another
 * account signed in would hand one person's answers to another.
 */

type Status = { signedIn: boolean; userId: string | null };

function installBridge(pullState: () => "ready" | "failed") {
  let status: Status = { signedIn: true, userId: "user_a" };
  const bridge = {
    account: { status: vi.fn(async () => status) },
    accountSettings: {
      sync: vi.fn(async () => ({ ok: true as const, value: pullState() })),
      get: vi.fn(async () => ({ ok: true as const, value: { answer: "account" } })),
      set: vi.fn(async (_args: { value: unknown; expectedAccountUserId?: string }) => ({ ok: true as const, value: null })),
    },
  };
  (window as unknown as { ade: unknown }).ade = bridge;
  // A sign-in in this window publishes the new status, as the app's sign-in flow does.
  const signIn = (userId: string) => {
    status = { signedIn: true, userId };
    publishAccountStatus(status as AdeAccountStatus);
  };
  return { bridge, signIn };
}

afterEach(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("account value sync", () => {
  it("writes only after a pull reached the account, retries a failed pull later, and fences each write to its account", async () => {
    let pull: "ready" | "failed" = "failed";
    const { bridge, signIn } = installBridge(() => pull);
    const passes: AccountValuePass[] = [];
    const sync = createAccountValueSync({
      key: "test.value",
      timeoutMs: 5_000,
      fingerprint: ["test", "account-value-sync"],
      reconcile: (pass) => {
        passes.push(pass);
        return { write: { answer: "merged" } };
      },
    });

    // The pull failed: the read may be this brain's stale copy, so the pass takes it but writes nothing.
    await sync.reconcile();
    expect(passes).toEqual([{ remote: { answer: "account" }, userId: "user_a", fresh: false }]);
    expect(bridge.accountSettings.set).not.toHaveBeenCalled();
    expect(sync.reconciledFor("user_a")).toBe(true);

    // Right after a failure the same account does not pull again (and still writes nothing).
    pull = "ready";
    await sync.reconcile();
    expect(bridge.accountSettings.sync).toHaveBeenCalledTimes(1);
    expect(bridge.accountSettings.set).not.toHaveBeenCalled();

    // Another account signs in: its pull is not held back by the first one's failure; the write is fenced to it.
    signIn("user_b");
    await sync.reconcile();
    expect(bridge.accountSettings.sync).toHaveBeenCalledTimes(2);
    expect(passes.at(-1)).toEqual({ remote: { answer: "account" }, userId: "user_b", fresh: true });
    expect(bridge.accountSettings.set).toHaveBeenCalledTimes(1);
    expect(bridge.accountSettings.set.mock.calls[0]![0]).toMatchObject({
      key: "test.value",
      value: { answer: "merged" },
      expectedAccountUserId: "user_b",
    });
    expect(sync.reconciledFor("user_a")).toBe(false);
  });
});
