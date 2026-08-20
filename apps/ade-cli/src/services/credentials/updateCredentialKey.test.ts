import { describe, expect, it, vi } from "vitest";
import {
  supportsAtomicCredentialUpdate,
  updateCredentialKeySync,
  type UpdatableCredentialStore,
} from "./updateCredentialKey";

/**
 * A store whose rungs can be removed one at a time, so each test picks the rung
 * it means instead of hoping the ladder falls through.
 */
function createStore(
  options: { atomicKey?: boolean; atomicMap?: boolean; values?: Record<string, string> } = {},
) {
  const values: Record<string, string> = { ...(options.values ?? {}) };
  const calls: string[] = [];
  const store: UpdatableCredentialStore = {
    getSync: (key) => {
      calls.push("getSync");
      return values[key] ?? null;
    },
    setSync: (key, value) => {
      calls.push("setSync");
      values[key] = value;
    },
    deleteSync: (key) => {
      calls.push("deleteSync");
      delete values[key];
    },
  };
  if (options.atomicMap !== false) {
    store.updateSync = (updater) => {
      calls.push("updateSync");
      const draft = { ...values };
      if (updater(draft) === false) return;
      for (const key of Object.keys(values)) delete values[key];
      Object.assign(values, draft);
    };
  }
  if (options.atomicKey !== false) {
    store.updateKeySync = (key, mutator) => {
      calls.push("updateKeySync");
      const next = mutator(values[key] ?? null);
      if (next === undefined) return;
      if (next === null) delete values[key];
      else values[key] = next;
    };
  }
  return { store, values, calls };
}

describe("updateCredentialKeySync", () => {
  it("takes the per-key rung first, because a routed store has only that one", () => {
    const { store, values, calls } = createStore({ values: { "a.key": "old" } });

    const mode = updateCredentialKeySync(store, "a.key", (current) => `${current}+new`);

    expect(mode).toBe("atomic");
    expect(values["a.key"]).toBe("old+new");
    expect(calls).toEqual(["updateKeySync"]);
  });

  it("wraps the whole-map rung when the store cannot update one key", () => {
    const { store, values, calls } = createStore({
      atomicKey: false,
      values: { "a.key": "old", "b.key": "untouched" },
    });

    const mode = updateCredentialKeySync(store, "a.key", (current) => `${current}+new`);

    expect(mode).toBe("atomic");
    expect(values).toEqual({ "a.key": "old+new", "b.key": "untouched" });
    expect(calls).toEqual(["updateSync"]);
  });

  it("falls back to a non-atomic read-modify-write and says so", () => {
    const { store, values, calls } = createStore({
      atomicKey: false,
      atomicMap: false,
      values: { "a.key": "old" },
    });

    const mode = updateCredentialKeySync(store, "a.key", (current) => `${current}+new`);

    expect(mode).toBe("read_modify_write");
    expect(values["a.key"]).toBe("old+new");
    expect(calls).toEqual(["getSync", "setSync"]);
  });

  it("writes nothing on every rung when the mutator declines", () => {
    for (const options of [
      {},
      { atomicKey: false },
      { atomicKey: false, atomicMap: false },
    ]) {
      const { store, values } = createStore({ ...options, values: { "a.key": "old" } });
      const mutator = vi.fn(() => undefined);

      updateCredentialKeySync(store, "a.key", mutator);

      expect(mutator).toHaveBeenCalledWith("old");
      expect(values).toEqual({ "a.key": "old" });
    }
  });

  it("deletes the key on every rung when the mutator returns null", () => {
    for (const options of [
      {},
      { atomicKey: false },
      { atomicKey: false, atomicMap: false },
    ]) {
      const { store, values } = createStore({
        ...options,
        values: { "a.key": "old", "b.key": "untouched" },
      });

      updateCredentialKeySync(store, "a.key", () => null);

      expect(values).toEqual({ "b.key": "untouched" });
    }
  });

  it("shows an absent key to the mutator as null on every rung", () => {
    for (const options of [
      {},
      { atomicKey: false },
      { atomicKey: false, atomicMap: false },
    ]) {
      const { store, values } = createStore(options);
      const mutator = vi.fn((current: string | null) => (current === null ? "fresh" : "wrong"));

      updateCredentialKeySync(store, "a.key", mutator);

      expect(mutator).toHaveBeenCalledWith(null);
      expect(values["a.key"]).toBe("fresh");
    }
  });
});

describe("supportsAtomicCredentialUpdate", () => {
  it("is true while either atomic rung is available", () => {
    expect(supportsAtomicCredentialUpdate(createStore().store)).toBe(true);
    expect(supportsAtomicCredentialUpdate(createStore({ atomicKey: false }).store)).toBe(true);
  });

  it("is false for a store that can only get and set", () => {
    // Callers that compare-and-swap ask this first: degraded to check-then-set,
    // their write is not weaker, it is a different write that clobbers a peer.
    const { store } = createStore({ atomicKey: false, atomicMap: false });
    expect(supportsAtomicCredentialUpdate(store)).toBe(false);
  });
});
