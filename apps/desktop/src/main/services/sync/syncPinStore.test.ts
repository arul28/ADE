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

  it("persists a valid 6-digit PIN as a hash and verifies it after reload", () => {
    const filePath = tempFile("ade-pin-persist-");
    const first = createSyncPinStore({ filePath });
    first.setPin("428193");
    expect(first.getPin()).toBe("428193");
    expect(first.hasPin()).toBe(true);
    expect(first.verifyPin("428193")).toBe(true);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).not.toContain("428193");
    expect(JSON.parse(raw)).toMatchObject({
      version: 2,
      algorithm: "pbkdf2-sha256",
    });

    const second = createSyncPinStore({ filePath });
    expect(second.getPin()).toBeNull();
    expect(second.hasPin()).toBe(true);
    expect(second.verifyPin("428193")).toBe(true);
    expect(second.verifyPin("111111")).toBe(false);
  });

  it("rejects PINs that are not exactly six digits", () => {
    const store = createSyncPinStore({ filePath: tempFile("ade-pin-validate-") });
    expect(() => store.setPin("12345")).toThrow();
    expect(() => store.setPin("1234567")).toThrow();
    expect(() => store.setPin("abcdef")).toThrow();
    expect(() => store.setPin("12 345")).toThrow();
    expect(store.getPin()).toBeNull();
    expect(store.hasPin()).toBe(false);
  });

  it("clears the PIN and removes the file contents", () => {
    const filePath = tempFile("ade-pin-clear-");
    const store = createSyncPinStore({ filePath });
    store.setPin("000001");
    store.clearPin();
    expect(store.getPin()).toBeNull();
    const reread = createSyncPinStore({ filePath });
    expect(reread.getPin()).toBeNull();
    expect(reread.hasPin()).toBe(false);
  });

  it("writes the file with 0600 permissions", () => {
    const filePath = tempFile("ade-pin-perms-");
    const store = createSyncPinStore({ filePath });
    store.setPin("111222");
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("migrates a legacy plaintext PIN file to hashed storage", () => {
    const filePath = tempFile("ade-pin-legacy-");
    fs.writeFileSync(filePath, `${JSON.stringify({ pin: "222333", updatedAt: "2026-04-17T00:00:00.000Z" })}\n`);
    const store = createSyncPinStore({ filePath });

    expect(store.hasPin()).toBe(true);
    expect(store.getPin()).toBe("222333");
    expect(store.verifyPin("222333")).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("222333");
  });
});
