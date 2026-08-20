import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_CHANGE_POLL_COALESCE_MS,
  watchCredentialsForRelayRepair,
} from "./credentialChangeRelayRepair";

function createLogger() {
  return { warn: vi.fn() };
}

/** A store that hands its change listener straight back to the test. */
function createWatchableStore() {
  const listeners = new Set<() => void>();
  return {
    fire: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    store: {
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

describe("watchCredentialsForRelayRepair", () => {
  it("forces a relay poll when the shared credential file changes", async () => {
    const watchable = createWatchableStore();
    const pollNow = vi.fn(async () => undefined);

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => 0,
    });
    watchable.fire();

    expect(pollNow).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of writes into one forced poll", () => {
    // A single sign-in rewrites the file several times, and every process on
    // the machine sees each write.
    const watchable = createWatchableStore();
    const pollNow = vi.fn(async () => undefined);
    let nowMs = 1_000;

    watchCredentialsForRelayRepair({
      logger: createLogger(),
      pollNow,
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    watchable.fire();
    nowMs += CREDENTIAL_CHANGE_POLL_COALESCE_MS - 1;
    watchable.fire();
    expect(pollNow).toHaveBeenCalledTimes(1);

    nowMs += 1;
    watchable.fire();
    expect(pollNow).toHaveBeenCalledTimes(2);
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
    let nowMs = 0;

    watchCredentialsForRelayRepair({
      logger,
      pollNow: async () => {
        throw new Error("relay unreachable");
      },
      credentialStore: watchable.store,
      now: () => nowMs,
    });
    watchable.fire();
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
    watchable.fire();

    expect(pollNow).not.toHaveBeenCalled();
  });
});
