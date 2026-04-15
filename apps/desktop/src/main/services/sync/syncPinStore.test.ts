import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyncPinStore } from "./syncPinStore";

function tempFile(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "sync-pin.json");
}

describe("syncPinStore", () => {
  it("returns null before any PIN is set", () => {
    const store = createSyncPinStore({ filePath: tempFile("ade-pin-unset-") });
    expect(store.getPin()).toBeNull();
  });

  it("persists a valid 6-digit PIN and reads it back from disk", () => {
    const filePath = tempFile("ade-pin-persist-");
    const first = createSyncPinStore({ filePath });
    first.setPin("428193");
    expect(first.getPin()).toBe("428193");

    const second = createSyncPinStore({ filePath });
    expect(second.getPin()).toBe("428193");
  });

  it("rejects PINs that are not exactly six digits", () => {
    const store = createSyncPinStore({ filePath: tempFile("ade-pin-validate-") });
    expect(() => store.setPin("12345")).toThrow();
    expect(() => store.setPin("1234567")).toThrow();
    expect(() => store.setPin("abcdef")).toThrow();
    expect(() => store.setPin("12 345")).toThrow();
    expect(store.getPin()).toBeNull();
  });

  it("clears the PIN and removes the file contents", () => {
    const filePath = tempFile("ade-pin-clear-");
    const store = createSyncPinStore({ filePath });
    store.setPin("000001");
    store.clearPin();
    expect(store.getPin()).toBeNull();
    const reread = createSyncPinStore({ filePath });
    expect(reread.getPin()).toBeNull();
  });

  it("writes the file with 0600 permissions", () => {
    const filePath = tempFile("ade-pin-perms-");
    const store = createSyncPinStore({ filePath });
    store.setPin("111222");
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
