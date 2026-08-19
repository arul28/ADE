import { describe, expect, it } from "vitest";
import {
  readCredentialWithState,
  readCredentialWithStateAsync,
} from "./credentialReadState";

/**
 * Models the real store: one `lastReadState` field that every read overwrites,
 * shared between the GitHub credential path and App user authentication.
 */
function createSharedStore(initial: Record<string, string> = {}) {
  const store = {
    values: { ...initial },
    lastReadState: "available",
    getSync(key: string): string | null {
      store.lastReadState = key in store.values ? "available" : "missing";
      return store.values[key] ?? null;
    },
    async get(key: string): Promise<string | null> {
      await Promise.resolve();
      store.lastReadState = key in store.values ? "available" : "missing";
      return store.values[key] ?? null;
    },
    async getWithReadState(key: string): Promise<{ value: string | null; state: string }> {
      await Promise.resolve();
      // The real store assigns and returns in the same synchronous step; the
      // captured state is what makes that pairing survive the await below.
      const state = key in store.values ? "available" : "missing";
      store.lastReadState = state;
      const value = store.values[key] ?? null;
      await Promise.resolve();
      return { value, state };
    },
    getLastReadState(): string {
      return store.lastReadState;
    },
  };
  return store;
}

describe("credentialReadState", () => {
  it("pairs a sync read with the state that read produced", () => {
    const store = createSharedStore({ "github.token.v1": " ghp_token " });

    expect(readCredentialWithState(store, "github.token.v1")).toEqual({
      value: "ghp_token",
      unreadable: false,
    });
  });

  it("reports an unreadable store rather than an absent credential", async () => {
    const store = createSharedStore();
    store.getWithReadState = async () => ({ value: null, state: "unreadable" });

    await expect(readCredentialWithStateAsync(store, "github.token.v1")).resolves.toEqual({
      value: null,
      unreadable: true,
    });
  });

  // An async read only gets to ask about the state once it has resolved, and by
  // then App user authentication may have read the same store and moved the
  // answer. Reporting that other read's verdict is how a working credential got
  // called unreadable — and an unreadable one got called merely absent.
  it("does not report a concurrent read's state as its own", async () => {
    const store = createSharedStore({ "github.token.v1": "ghp_token" });
    let unreadableRead: Promise<unknown> | null = null;
    const original = store.getWithReadState;
    store.getWithReadState = async (key: string) => {
      const result = await original(key);
      // A second reader lands while this read is still settling.
      unreadableRead = Promise.resolve().then(() => {
        store.lastReadState = "unreadable";
      });
      await unreadableRead;
      return result;
    };

    await expect(readCredentialWithStateAsync(store, "github.token.v1")).resolves.toEqual({
      value: "ghp_token",
      unreadable: false,
    });
    expect(store.getLastReadState()).toBe("unreadable");
  });

  it("treats a throwing store as unreadable", async () => {
    const store = createSharedStore();
    store.getWithReadState = async () => {
      throw new Error("decrypt failed");
    };
    const seen: unknown[] = [];

    await expect(
      readCredentialWithStateAsync(store, "github.token.v1", {
        onError: (error) => seen.push(error),
      }),
    ).resolves.toEqual({ value: null, unreadable: true });
    expect(seen).toHaveLength(1);
  });
});
