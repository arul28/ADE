import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
} from "./credentialStore";
import { createRoutedCredentialStore } from "./credentialStoreRouting";
import { adoptFileBackedCredentials } from "./credentialStoreAdoption";
import { ACCOUNT_SESSION_CREDENTIAL_KEY } from "../account/accountAuthService";
import { GITHUB_APP_USER_TOKEN_KEY } from "../../../../desktop/src/main/services/github/githubAppUserAuthService";
import {
  supportsAtomicCredentialUpdate,
  updateCredentialKeySync,
  type UpdatableCredentialStore,
} from "./updateCredentialKey";

// One suite for the three facets of composing credential stores over one
// secrets directory: per-key routing, the one-time adoption migration, and the
// shared atomic-update ladder. Each facet keeps its own fixtures inside its
// describe so the merge changes nothing about what is proven.

describe("routed credential store", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-credentials-routing-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** The Electron-only store, faked so the tests need no OS keychain. */
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`safe:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const raw = value.toString("utf8");
      if (!raw.startsWith("safe:")) throw new Error("not a safeStorage payload");
      return raw.slice("safe:".length);
    },
  };

  describe("createRoutedCredentialStore", () => {
    let fileStore: EncryptedFileCredentialStore;
    let primary: ElectronSafeStorageCredentialStore;
    let routed: ReturnType<typeof createRoutedCredentialStore>;

    beforeEach(() => {
      fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      fileStore.setSync("github.appUserToken.v1", "stored-app-token");
      primary.setSync("linear.token.v1", "lin_secret");
      routed = createRoutedCredentialStore({ primary, fileStore });
    });

    it("reads each key from the file that key belongs in", () => {
      // The desktop app's own store is Electron-only, and the file-backed keys it
      // shares with the brain live outside it. Routing per key is what makes "the
      // brain and the app share this credential" true for readers.
      expect(routed.getSync("github.appUserToken.v1")).toBe("stored-app-token");
      expect(routed.getSync("linear.token.v1")).toBe("lin_secret");
      expect(fileStore.getSync("linear.token.v1")).toBeNull();
      expect(primary.getSync("github.appUserToken.v1")).toBeNull();
    });

    it("answers getLastReadState about the file the read actually went to", () => {
      // An unreadable sibling must not make a good credential look unreadable.
      routed.getSync("linear.token.v1");
      expect(routed.getLastReadState?.()).toBe("available");
    });

    it("writes a file-backed key through to the shared file, including updateKeySync", () => {
      routed.setSync("github.appUserToken.v1", "renewed-app-token");
      routed.updateKeySync?.("github.appUserToken.v1", (current) => `${current}+ledger`);

      expect(new EncryptedFileCredentialStore({ secretsDir: tempDir })
        .getSync("github.appUserToken.v1")).toBe("renewed-app-token+ledger");
    });

    it("refuses a whole-map update instead of pointing it at one of the two files", () => {
      // `updateSync` rewrites the ENTIRE credential map. A routed store has two
      // maps in two files, so binding either one hands the updater a view that is
      // missing the other file's keys and writes its results where nobody reads
      // them. Callers already carry a per-key fallback for a store without it.
      expect(routed.updateSync).toBeUndefined();
    });
  });
});

describe("file-backed credential adoption", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-credentials-adoption-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** The Electron-only store, faked so the tests need no OS keychain. */
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`safe:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const raw = value.toString("utf8");
      if (!raw.startsWith("safe:")) throw new Error("not a safeStorage payload");
      return raw.slice("safe:".length);
    },
  };

  describe("adoptFileBackedCredentials", () => {
    it("never overwrites the shared file's credential with a stale safeStorage copy", () => {
      const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      const fresh = JSON.stringify({
        accessToken: "fresh-from-brain",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      fileStore.setSync("github.appUserToken.v1", fresh);
      const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      fs.writeFileSync(
        path.join(tempDir, "credentials.safe.enc"),
        Buffer.concat([
          Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
          safeStorage.encryptString(JSON.stringify({
            "github.appUserToken.v1": JSON.stringify({
              accessToken: "stale-from-june",
              updatedAt: "2026-06-01T00:00:00.000Z",
            }),
          })),
        ]),
      );

      const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

      expect(adoption.adopted).toEqual([]);
      expect(adoption.pruned).toContain("github.appUserToken.v1");
      expect(fileStore.getSync("github.appUserToken.v1")).toBe(fresh);
      expect(primary.getSync("github.appUserToken.v1")).toBeNull();
    });

    it("dates a record that says obtainedAt rather than updatedAt", () => {
      // The account session spells the same fact that way, and a record ADE
      // cannot date is a record it will not replace.
      const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      fileStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify({
        accessToken: "session-from-june",
        obtainedAt: "2026-06-01T00:00:00.000Z",
      }));
      const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      const stranded = JSON.stringify({
        accessToken: "session-from-august",
        obtainedAt: "2026-08-01T00:00:00.000Z",
      });
      fs.writeFileSync(
        path.join(tempDir, "credentials.safe.enc"),
        Buffer.concat([
          Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
          safeStorage.encryptString(JSON.stringify({ [ACCOUNT_SESSION_CREDENTIAL_KEY]: stranded })),
        ]),
      );

      const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

      expect(adoption.adopted).toContain(ACCOUNT_SESSION_CREDENTIAL_KEY);
      expect(fileStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(stranded);
    });

    // Two secrets, neither of which says when it was written. Keeping the shared
    // one is a guess, and deleting the other on that guess is unrecoverable — so
    // the stranded copy stays where it is.
    it("leaves an undatable stranded copy alone rather than destroying it", () => {
      const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      fileStore.setSync("github.appUserToken.v1", "shared-copy-with-no-date");
      const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      fs.writeFileSync(
        path.join(tempDir, "credentials.safe.enc"),
        Buffer.concat([
          Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
          safeStorage.encryptString(JSON.stringify({
            "github.appUserToken.v1": "stranded-copy-with-no-date",
          })),
        ]),
      );

      const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

      expect(adoption.adopted).toEqual([]);
      expect(adoption.pruned).toEqual([]);
      expect(fileStore.getSync("github.appUserToken.v1")).toBe("shared-copy-with-no-date");
      expect(primary.getSync("github.appUserToken.v1")).toBe("stranded-copy-with-no-date");
    });

    it("adopts a stranded safeStorage copy that is newer than the shared one", () => {
      // The build that wrote the App token into the Electron-only store left the
      // ONLY current copy there. Keeping the older shared copy hands GitHub a
      // refresh token it has already rotated away, which kills the credential.
      const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      fileStore.setSync(GITHUB_APP_USER_TOKEN_KEY, JSON.stringify({
        accessToken: "ghu_from_june",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }));
      const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      const stranded = JSON.stringify({
        accessToken: "ghu_from_august",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      fs.writeFileSync(
        path.join(tempDir, "credentials.safe.enc"),
        Buffer.concat([
          Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
          safeStorage.encryptString(JSON.stringify({ [GITHUB_APP_USER_TOKEN_KEY]: stranded })),
        ]),
      );

      const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

      expect(adoption.adopted).toContain(GITHUB_APP_USER_TOKEN_KEY);
      expect(fileStore.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBe(stranded);
      expect(primary.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBeNull();
    });

    it("keeps the shared copy when the stranded safeStorage copy is older", () => {
      const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      const shared = JSON.stringify({
        accessToken: "ghu_from_august",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      fileStore.setSync(GITHUB_APP_USER_TOKEN_KEY, shared);
      const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      fs.writeFileSync(
        path.join(tempDir, "credentials.safe.enc"),
        Buffer.concat([
          Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
          safeStorage.encryptString(JSON.stringify({
            [GITHUB_APP_USER_TOKEN_KEY]: JSON.stringify({
              accessToken: "ghu_from_june",
              updatedAt: "2026-06-01T00:00:00.000Z",
            }),
          })),
        ]),
      );

      const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

      expect(adoption.adopted).toEqual([]);
      expect(adoption.pruned).toContain(GITHUB_APP_USER_TOKEN_KEY);
      expect(fileStore.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBe(shared);
      expect(primary.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBeNull();
    });

    it("retries adoption in the same process after a pass that could not read the Electron store", () => {
      // Marking the directory adopted before the pass succeeds strands the
      // credential for the whole life of the app: nothing constructs the store
      // again with a fresh chance to read it.
      const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
      const stranded = JSON.stringify({
        accessToken: "ghu_stranded",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
      fs.writeFileSync(
        path.join(tempDir, "credentials.safe.enc"),
        Buffer.concat([
          Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
          safeStorage.encryptString(JSON.stringify({ [GITHUB_APP_USER_TOKEN_KEY]: stranded })),
        ]),
      );
      const locked = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      vi.spyOn(locked, "getSync").mockImplementation(() => {
        throw new Error("safeStorage is locked");
      });

      const firstPass = adoptFileBackedCredentials({ primary: locked, fileStore, identity: tempDir });
      expect(firstPass.adopted).toEqual([]);

      const unlocked = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
      const secondPass = adoptFileBackedCredentials({ primary: unlocked, fileStore, identity: tempDir });

      expect(secondPass.adopted).toContain(GITHUB_APP_USER_TOKEN_KEY);
      expect(fileStore.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBe(stranded);
    });
  });
});

describe("updateCredentialKeySync ladder", () => {
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
});
