import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSafeStorageKeyName, STABLE_SAFE_STORAGE_NAME } from "./safeStorageKeyName";

// A wrong answer here loses saved secrets: a key name that changes under
// files sealed with the old key leaves them unreadable for good.
describe("resolveSafeStorageKeyName", () => {
  let root = "";
  let userDataPath = "";
  let adeHome = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-safe-storage-name-"));
    userDataPath = path.join(root, "ade-desktop-alpha");
    adeHome = path.join(root, ".ade-alpha");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const resolve = (overrides: { channel?: string | null; platform?: NodeJS.Platform } = {}) =>
    resolveSafeStorageKeyName({
      channel: overrides.channel === undefined ? "alpha" : overrides.channel,
      platform: overrides.platform ?? "darwin",
      userDataPath,
      adeHome,
    });

  const put = (relativeToRoot: string, content: string | Buffer) => {
    const filePath = path.join(root, relativeToRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  it("leaves Stable and Windows on Electron's own name", () => {
    expect(resolve({ channel: null })).toBeNull();
    expect(resolve({ platform: "win32" })).toBeNull();
    expect(fs.existsSync(adeHome)).toBe(false);
  });

  it.each([
    ["the machine safeStorage file", ".ade-alpha/secrets/credentials.safe.enc", "x"],
    ["the API key file", ".ade-alpha/secrets/api-keys.v1.bin", "x"],
    ["a Linear token", ".ade-alpha/secrets/linear-token.v1.bin", "x"],
    ["the GitHub token file", "ade-desktop-alpha/secrets/github/github-token.v1.bin", "x"],
    ["a music sign-in", "ade-desktop-alpha/music-player/spotify-session.enc", "x"],
    ["an older safeStorage file under the shared name", ".ade-alpha/secrets/credentials.json.enc", "v10\u0001sealed"],
  ])("keeps the shared name for an install that has %s", (_label, file, content) => {
    put(file, content);
    expect(resolve()).toBe(STABLE_SAFE_STORAGE_NAME);
    // Written down, so a later launch cannot pick another name.
    fs.rmSync(path.join(root, file));
    expect(resolve()).toBe(STABLE_SAFE_STORAGE_NAME);
  });

  it("keeps the shared name for a channel that has run before", () => {
    // A project folder is not known at launch, and its `.ade/secrets` is sealed
    // with the same key: an install that already ran must not change the name
    // under files this check cannot see.
    put(".ade-alpha/ade.db", "");
    expect(resolve()).toBe(STABLE_SAFE_STORAGE_NAME);
  });

  it("gives a first launch its own name and keeps it once files exist", () => {
    // No ADE home yet: nothing on this machine was sealed with the shared key.
    expect(resolve()).toBe("ade-desktop-alpha");

    // The next launch finds this launch's sealed files, and must not go back
    // to the shared name that cannot read them.
    put(".ade-alpha/secrets/credentials.safe.enc", "sealed with ade-desktop-alpha");
    expect(resolve()).toBe("ade-desktop-alpha");

    // One folder's marker gone: the other still decides, and is copied back.
    fs.rmSync(userDataPath, { recursive: true, force: true });
    expect(resolve()).toBe("ade-desktop-alpha");
    expect(fs.existsSync(path.join(userDataPath, "safe-storage-key.json"))).toBe(true);
  });

  it("keeps the shared name when the choice cannot be written down", () => {
    // Files where the folders should be: neither marker can be saved.
    put(".ade-alpha", "not a folder");
    put("ade-desktop-alpha", "not a folder");
    expect(resolve()).toBe(STABLE_SAFE_STORAGE_NAME);
  });
});
