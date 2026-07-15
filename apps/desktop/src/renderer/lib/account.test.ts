/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeAccountStatus } from "../../shared/types";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const publishedSignedInStatus: AdeAccountStatus = {
  signedIn: true,
  userId: "user-1",
  email: "person@example.com",
  name: "Test Person",
  expiresAt: "2026-07-16T00:00:00.000Z",
  provider: "github",
  imageUrl: null,
  configured: true,
};

const staleSignedOutStatus: AdeAccountStatus = {
  signedIn: false,
  userId: null,
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
  configured: true,
};

describe("account status cache", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: originalAde,
    });
    vi.restoreAllMocks();
  });

  it("keeps a published status when an older status fetch resolves later", async () => {
    const pendingStatus = deferred<AdeAccountStatus>();
    const status = vi.fn(() => pendingStatus.promise);
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: { account: { status } } as unknown as typeof window.ade,
    });

    const { fetchAccountStatus, publishAccountStatus, subscribeAccountStatus } =
      await import("./account");
    const observed: AdeAccountStatus[] = [];
    const unsubscribe = subscribeAccountStatus((accountStatus) => {
      observed.push(accountStatus);
    });

    const staleFetch = fetchAccountStatus({ force: true });
    expect(status).toHaveBeenCalledTimes(1);

    publishAccountStatus(publishedSignedInStatus);
    expect(observed).toEqual([publishedSignedInStatus]);

    pendingStatus.resolve(staleSignedOutStatus);
    await expect(staleFetch).resolves.toBe(staleSignedOutStatus);

    expect(observed).toEqual([publishedSignedInStatus]);
    await expect(fetchAccountStatus()).resolves.toBe(publishedSignedInStatus);
    expect(status).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
