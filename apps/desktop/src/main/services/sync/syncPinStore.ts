import fs from "node:fs";
import path from "node:path";
import { safeJsonParse, writeTextAtomic } from "../shared/utils";

type SyncPinStoreArgs = {
  filePath: string;
};

type SyncPinFile = {
  pin: string;
  updatedAt: string;
};

const PIN_PATTERN = /^\d{6}$/;

export function createSyncPinStore(args: SyncPinStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  let cached: string | null = null;

  const readFromDisk = (): string | null => {
    if (!fs.existsSync(args.filePath)) return null;
    const parsed = safeJsonParse<SyncPinFile | null>(
      fs.readFileSync(args.filePath, "utf8"),
      null,
    );
    const pin = typeof parsed?.pin === "string" ? parsed.pin.trim() : "";
    return PIN_PATTERN.test(pin) ? pin : null;
  };

  return {
    getPin(): string | null {
      if (cached !== null) return cached;
      cached = readFromDisk();
      return cached;
    },

    setPin(pin: string): void {
      const trimmed = pin.trim();
      if (!PIN_PATTERN.test(trimmed)) {
        throw new Error("PIN must be 6 digits.");
      }
      const payload: SyncPinFile = {
        pin: trimmed,
        updatedAt: new Date().toISOString(),
      };
      writeTextAtomic(args.filePath, `${JSON.stringify(payload, null, 2)}\n`);
      try {
        fs.chmodSync(args.filePath, 0o600);
      } catch {
        // ignore chmod failures on platforms that don't support it
      }
      cached = trimmed;
    },

    clearPin(): void {
      try {
        fs.rmSync(args.filePath, { force: true });
      } catch {
        // ignore cleanup failures
      }
      cached = null;
    },
  };
}

export type SyncPinStore = ReturnType<typeof createSyncPinStore>;
