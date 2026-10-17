import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Apple Music user token's file, with Electron's safeStorage faked at its boundary. */
const safe = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: (text: string) => Buffer.from(`sealed:${Buffer.from(text).toString("base64")}`),
    decryptString: (data: Buffer) => {
      const text = data.toString();
      if (!text.startsWith("sealed:")) throw new Error("Error while decrypting the ciphertext");
      return Buffer.from(text.slice("sealed:".length), "base64").toString();
    },
  },
}));

const { createMusicTokenStore } = await import("./musicTokenStore");

let dir = "";
const file = () => path.join(dir, "apple-music-user-token.enc");

beforeEach(() => {
  safe.available = true;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-music-tokens-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("music token store", () => {
  it("keeps the token sealed on disk across restarts, and removes the file with the last token", async () => {
    await createMusicTokenStore({ dir }).set("music.appleMusic.userToken", "user-token-123");

    expect(fs.readFileSync(file(), "utf8")).not.toContain("user-token-123");
    expect(fs.readdirSync(dir)).toEqual(["apple-music-user-token.enc"]);
    const restarted = createMusicTokenStore({ dir });
    expect(await restarted.get("music.appleMusic.userToken")).toBe("user-token-123");

    await restarted.delete("music.appleMusic.userToken");
    expect(fs.existsSync(file())).toBe(false);
  });

  it("treats a file it cannot open as missing, and removes it", async () => {
    fs.writeFileSync(file(), "written by another build's key");
    const warn = vi.fn();

    expect(await createMusicTokenStore({ dir, logger: { warn } }).get("music.appleMusic.userToken")).toBeNull();
    expect(fs.existsSync(file())).toBe(false);
    expect(warn).toHaveBeenCalledWith("music.token_store_unreadable", expect.anything());
  });

  it("refuses to save, and writes nothing, when secure storage is unavailable", async () => {
    safe.available = false;
    await expect(createMusicTokenStore({ dir }).set("music.appleMusic.userToken", "user-token-123"))
      .rejects.toThrow(/secure storage is unavailable/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
