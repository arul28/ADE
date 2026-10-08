import fs from "node:fs";
import path from "node:path";

import { safeStorage } from "electron";

/**
 * Where the Apple Music user token lives: one small file in this app's own
 * user data, encrypted with this app's safeStorage key.
 *
 * Not the shared machine credential files. safeStorage's key belongs to the
 * app's user-data folder, so a second build (a dev app, another channel)
 * cannot decrypt the shared Electron credential file and failed the whole
 * Connect flow; and a music token has no business sharing a file with the
 * account session. Losing this file only means connecting Apple Music again,
 * so an unreadable file is treated as missing and removed.
 */
export function createMusicTokenStore(args: {
  dir: string;
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void };
}) {
  const file = path.join(args.dir, "apple-music-user-token.enc");
  const values = new Map<string, string>();
  let loaded = false;

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return;
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") values.set(key, value);
      }
    } catch (error) {
      args.logger?.warn("music.token_store_unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
      fs.rmSync(file, { force: true });
    }
  };

  const save = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("This computer's secure storage is unavailable, so ADE can't remember your Apple Music sign-in.");
    }
    fs.mkdirSync(args.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(Object.fromEntries(values))));
    fs.renameSync(tmp, file);
  };

  return {
    get: async (key: string): Promise<string | null> => {
      load();
      return values.get(key) ?? null;
    },
    set: async (key: string, value: string): Promise<void> => {
      load();
      values.set(key, value);
      save();
    },
    delete: async (key: string): Promise<void> => {
      load();
      if (!values.delete(key)) return;
      if (values.size === 0) fs.rmSync(file, { force: true });
      else save();
    },
  };
}
