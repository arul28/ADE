import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_CHANGE_POLL_COALESCE_MS,
  watchCredentialsForRelayRepair,
} from "./credentialChangeRelayRepair";

const APP_TOKEN_KEY = "github.appUserToken.v1";

function createLogger() {
  return { warn: vi.fn() };
}

/**
 * A store that hands its change listener straight back to the test, backed by
 * a values map so tests can write one key and fire the watcher.
 */
function createWatchableStore(
  options: { identity?: string; values?: Record<string, string> } = {},
) {
  const listeners = new Set<() => void>();
  const values: Record<string, string> = { ...(options.values ?? {}) };
  let reads = 0;
  let readsFail = false;
  const fire = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    fire,
    /** How many times the credential was actually decrypted. */
    readCount: () => reads,
    /** Stands in for a locked or corrupt store: every read throws. */
    setReadsFail: (fail: boolean) => {
      readsFail = fail;
    },
    /** Write one key and notify, the way a real credential write does. */
    write: (key: string, value: string) => {
      values[key] = value;
      fire();
    },
    writeAppToken: (value: string) => {
      values[APP_TOKEN_KEY] = value;
      fire();
    },
    listenerCount: () => listeners.size,
    store: {
      getSync: (key: string) => {
        reads += 1;
        if (readsFail) throw new Error("credential store unreadable");
        return values[key] ?? null;
      },
      ...(options.identity === undefined
        ? {}
        : { credentialStoreIdentity: () => options.identity as string }),
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

describe("watchCredentialsForRelayRepair", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces a relay poll when the shared credential file changes", () => {
    const watchable = createWatchableStore();
    const pollNow = vi.fn(async () => undefined);

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => 0,
    });
    watchable.writeAppToken("token-1");

    expect(pollNow).toHaveBeenCalledTimes(1);
  });

  it("polls once more after the last write of a burst", () => {
    // A single sign-in rewrites the file several times, and every process on
    // the machine sees each write. The burst must still end in a poll that
    // sees the FINAL credential, not be dropped on the floor.
    const watchable = createWatchableStore();
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 1_000;

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    watchable.writeAppToken("token-1");
    expect(pollNow).toHaveBeenCalledTimes(1);

    nowMs += 100;
    watchable.writeAppToken("token-2");
    nowMs += 100;
    watchable.writeAppToken("token-3");
    // Still inside the window: the burst has been coalesced, not polled again.
    expect(pollNow).toHaveBeenCalledTimes(1);

    nowMs = 1_000 + CREDENTIAL_CHANGE_POLL_COALESCE_MS;
    vi.advanceTimersByTime(CREDENTIAL_CHANGE_POLL_COALESCE_MS);
    // Exactly one extra poll for the whole burst, and it ran after the last
    // write.
    expect(pollNow).toHaveBeenCalledTimes(2);
  });

  it("does not force a poll when another credential key changes", () => {
    // Account sessions rotate constantly and share the file. Whole-file
    // re-encryption makes the raw bytes change every time, so only the
    // decrypted App token says whether the relay has anything to re-check.
    const watchable = createWatchableStore({
      values: { [APP_TOKEN_KEY]: "token-1" },
    });
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 1_000;

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    watchable.write("account.session.v1", "session-2");
    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2;
    watchable.write("account.session.v1", "session-3");
    vi.advanceTimersByTime(CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2);

    expect(pollNow).not.toHaveBeenCalled();
  });

  it("forces a poll when the App credential value changes", () => {
    const watchable = createWatchableStore({
      values: { [APP_TOKEN_KEY]: "token-1" },
    });
    const pollNow = vi.fn(async () => undefined);

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => 1_000,
    });
    watchable.writeAppToken("token-2");

    expect(pollNow).toHaveBeenCalledTimes(1);
  });

  it("forces a poll when the App credential cannot be read", () => {
    // A read failure says nothing about whether the App credential moved, so
    // it must fail OPEN. Treating it as "unchanged" is how a repair the user
    // already finished sat out the full five-minute cooldown.
    const watchable = createWatchableStore({
      values: { [APP_TOKEN_KEY]: "token-1" },
    });
    watchable.setReadsFail(true);
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 1_000;

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    watchable.fire();
    expect(pollNow).toHaveBeenCalledTimes(1);

    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS;
    watchable.fire();
    expect(pollNow).toHaveBeenCalledTimes(2);
  });

  it("recovers from an unreadable baseline instead of suppressing every later poll", () => {
    // The baseline is read at install time. If the store was locked then, the
    // watcher must not compare later reads against that non-answer forever.
    const watchable = createWatchableStore({
      values: { [APP_TOKEN_KEY]: "token-1" },
    });
    watchable.setReadsFail(true);
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 1_000;

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });

    watchable.setReadsFail(false);
    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2;
    watchable.fire();
    expect(pollNow).toHaveBeenCalledTimes(1);

    // Readable again and unchanged: the scoped comparison is back on.
    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2;
    watchable.fire();
    expect(pollNow).toHaveBeenCalledTimes(1);
  });

  it("decrypts the credential once per change however many watchers share the file", () => {
    // Reading this key takes the file lock and decrypts the whole store. Ten
    // open projects must not pay for that ten times to learn the same fact.
    const watchable = createWatchableStore({ identity: "shared-file-read-count" });
    const now = () => 0;

    const stopFirst = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: vi.fn(async () => undefined),
      credentialStore: watchable.store,
      now,
    });
    const stopSecond = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: vi.fn(async () => undefined),
      credentialStore: watchable.store,
      now,
    });
    expect(watchable.readCount()).toBe(1);

    watchable.writeAppToken("token-1");
    expect(watchable.readCount()).toBe(2);

    stopFirst();
    stopSecond();
  });

  it("keeps notifying the other watchers when one of them throws", () => {
    // The shared watch is an aggregate over independent subscribers, so it owes
    // them the same per-subscriber isolation the store's own watcher documents.
    const watchable = createWatchableStore({ identity: "shared-file-isolation" });
    const survivingPoll = vi.fn(async () => undefined);

    const stopThrowing = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: vi.fn(async () => undefined),
      credentialStore: watchable.store,
      // Throws from inside the listener itself, before the poll is reached.
      now: () => {
        throw new Error("clock unavailable");
      },
    });
    const stopSurviving = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: survivingPoll,
      credentialStore: watchable.store,
      now: () => 0,
    });

    expect(() => watchable.writeAppToken("token-1")).not.toThrow();
    expect(survivingPoll).toHaveBeenCalledTimes(1);

    stopThrowing();
    stopSurviving();
  });

  it("shares one underlying watcher across stores over the same file", () => {
    // Every project runtime in the process installs a repair watcher, and they
    // all read the same machine credential file.
    const watchable = createWatchableStore({ identity: "machine-credentials" });
    const firstPoll = vi.fn(async () => undefined);
    const secondPoll = vi.fn(async () => undefined);
    let nowMs = 1_000;

    const stopFirst = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: firstPoll,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    const stopSecond = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: secondPoll,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    expect(watchable.listenerCount()).toBe(1);

    watchable.writeAppToken("token-1");
    expect(firstPoll).toHaveBeenCalledTimes(1);
    expect(secondPoll).toHaveBeenCalledTimes(1);

    // Dropping one keeps the other alive.
    stopFirst();
    expect(watchable.listenerCount()).toBe(1);
    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2;
    watchable.writeAppToken("token-2");
    expect(firstPoll).toHaveBeenCalledTimes(1);
    expect(secondPoll).toHaveBeenCalledTimes(2);

    // The last stop disposes the underlying watcher.
    stopSecond();
    expect(watchable.listenerCount()).toBe(0);
  });

  it("leaves behaviour unchanged when the store cannot be watched", () => {
    const stop = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow: vi.fn(),
      credentialStore: {},
    });

    expect(() => stop()).not.toThrow();
  });

  it("keeps the watch alive when a forced poll rejects", async () => {
    const watchable = createWatchableStore();
    const logger = createLogger();

    watchCredentialsForRelayRepair({
      logger,
      pollNow: async () => {
        throw new Error("relay unreachable");
      },
      credentialStore: watchable.store,
      now: () => 0,
    });
    watchable.writeAppToken("token-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "automations.github_relay_credential_repoll_failed",
      { error: "relay unreachable" },
    );
    expect(watchable.listenerCount()).toBe(1);
  });

  it("stops forcing polls once the subscription is dropped", () => {
    const watchable = createWatchableStore();
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 0;

    const stop = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    stop();
    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2;
    watchable.writeAppToken("token-1");

    expect(pollNow).not.toHaveBeenCalled();
  });

  it("drops a coalesced poll that was still pending when the watch stopped", () => {
    const watchable = createWatchableStore();
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 1_000;

    const stop = watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    watchable.writeAppToken("token-1");
    nowMs += 100;
    watchable.writeAppToken("token-2");
    stop();
    vi.advanceTimersByTime(CREDENTIAL_CHANGE_POLL_COALESCE_MS * 2);

    expect(pollNow).toHaveBeenCalledTimes(1);
  });
});
