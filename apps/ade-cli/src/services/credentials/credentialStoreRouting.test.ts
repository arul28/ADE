import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
} from "./credentialStore";
import { createRoutedCredentialStore } from "./credentialStoreRouting";
import { adoptFileBackedCredentials } from "./credentialStoreAdoption";

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
  it("routes file-backed keys to the shared file and adopts ones stranded in safeStorage", () => {
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    // What an older build left behind: the App token sealed in the file only the
    // desktop app can open.
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({
          "github.appUserToken.v1": "stranded-app-token",
          "linear.token.v1": "lin_secret",
        })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });
    const routed = createRoutedCredentialStore({ primary, fileStore });

    expect(adoption.adopted).toContain("github.appUserToken.v1");
    expect(fileStore.getSync("github.appUserToken.v1")).toBe("stranded-app-token");
    expect(primary.getSync("github.appUserToken.v1")).toBeNull();
    expect(routed.getSync("github.appUserToken.v1")).toBe("stranded-app-token");
    // Everything else keeps going to the Electron-only store.
    expect(routed.getSync("linear.token.v1")).toBe("lin_secret");
    expect(fileStore.getSync("linear.token.v1")).toBeNull();

    // The read state answers about the file the read actually went to, so an
    // unreadable sibling cannot make a good credential look unreadable.
    routed.getSync("linear.token.v1");
    expect(routed.getLastReadState?.()).toBe("available");

    // A write through the routed store reaches the brain, and so does the
    // atomic single-key update the refresh ledger runs on.
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
    const routed = createRoutedCredentialStore({
      primary: new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage }),
      fileStore: new EncryptedFileCredentialStore({ secretsDir: tempDir }),
    });

    expect(routed.updateSync).toBeUndefined();
  });
});
