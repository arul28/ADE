import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
} from "./credentialStore";
import { adoptFileBackedCredentials } from "./credentialStoreAdoption";
import { ACCOUNT_SESSION_CREDENTIAL_KEY } from "../account/accountAuthService";
import { GITHUB_APP_USER_TOKEN_KEY } from "../../../../desktop/src/main/services/github/githubAppUserAuthService";

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
