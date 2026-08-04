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

  it("coerces a null bridge response to the signed-out account shape", async () => {
    const status = vi.fn(async () => null);
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: {
        account: { status },
      } as unknown as typeof window.ade,
    });

    const { fetchAccountStatus, SIGNED_OUT_ACCOUNT } = await import("./account");

    const normalized = await fetchAccountStatus({ force: true });

    expect(normalized).toBe(SIGNED_OUT_ACCOUNT);
    expect(normalized).toMatchObject({ signedIn: false, userId: null, email: null });
    expect(status).toHaveBeenCalledOnce();
  });
});

describe("account machines cache", () => {
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

  function installBridge(listMachines: () => Promise<unknown>): void {
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: { account: { listMachines } } as unknown as typeof window.ade,
    });
  }

  const okResult = {
    state: "ok" as const,
    machines: [{ machineKey: "mk-studio" }],
    message: null,
  };

  it("keeps the last known list when a later fetch fails", async () => {
    const listMachines = vi
      .fn()
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce({ state: "unavailable", machines: [], message: null });
    installBridge(listMachines as () => Promise<unknown>);

    const { fetchAccountMachines } = await import("./account");

    await expect(fetchAccountMachines({ force: true })).resolves.toBe(okResult);
    // A failed refresh must not become "no computers yet".
    await expect(fetchAccountMachines({ force: true })).resolves.toBe(okResult);
    expect(listMachines).toHaveBeenCalledTimes(2);
  });

  it("lets an authoritative signed-out result clear the cache", async () => {
    const signedOut = { state: "signed_out" as const, machines: [], message: null };
    const listMachines = vi
      .fn()
      .mockResolvedValueOnce(okResult)
      .mockResolvedValueOnce(signedOut);
    installBridge(listMachines as () => Promise<unknown>);

    const { fetchAccountMachines } = await import("./account");

    await fetchAccountMachines({ force: true });
    await expect(fetchAccountMachines({ force: true })).resolves.toBe(signedOut);
  });

  it("shares one in-flight request across concurrent openers", async () => {
    const pending = deferred<unknown>();
    const listMachines = vi.fn(() => pending.promise);
    installBridge(listMachines as () => Promise<unknown>);

    const { fetchAccountMachines } = await import("./account");

    const first = fetchAccountMachines({ force: true });
    const second = fetchAccountMachines({ force: true });
    pending.resolve(okResult);

    await expect(first).resolves.toBe(okResult);
    await expect(second).resolves.toBe(okResult);
    expect(listMachines).toHaveBeenCalledTimes(1);
  });
});

describe("account avatar presentation", () => {
  it("never uses a GitHub integration avatar while ADE is signed out", async () => {
    const { accountAvatarImage } = await import("./account");

    expect(accountAvatarImage(staleSignedOutStatus, "repo-user")).toBeNull();
  });

  it("allows the GitHub fallback only for a signed-in ADE account", async () => {
    const { accountAvatarImage } = await import("./account");

    expect(accountAvatarImage(publishedSignedInStatus, "repo-user")).toBe(
      "https://github.com/repo-user.png?size=64",
    );
  });
});
