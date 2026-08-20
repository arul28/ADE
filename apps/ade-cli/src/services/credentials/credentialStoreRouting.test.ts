import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
} from "./credentialStore";
import { createRoutedCredentialStore } from "./credentialStoreRouting";

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
