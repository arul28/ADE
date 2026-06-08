import fs from "node:fs";
import path from "node:path";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";

type SyncRuntimeNameStoreArgs = {
  filePath: string;
};

type SyncRuntimeNameFile = {
  runtimeName: string;
  updatedAt: string;
};

// Keep the human name short enough to fit comfortably in a Bonjour TXT record
// and the iOS picker; trim and collapse whitespace so the advertised value is
// clean.
const MAX_RUNTIME_NAME_LENGTH = 64;

function normalizeRuntimeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_RUNTIME_NAME_LENGTH);
}

function isRuntimeNameFile(value: unknown): value is SyncRuntimeNameFile {
  return (
    !!value
    && typeof value === "object"
    && typeof (value as SyncRuntimeNameFile).runtimeName === "string"
  );
}

/**
 * Per-runtime human name (e.g. "Studio – work runtime"). Stored under
 * `$ADE_HOME` next to the pairing PIN so it travels with the runtime (one
 * `siteId`/socket), NOT with the machine-shared device registry. Lets two ADE
 * runtimes on the same machine be told apart over Bonjour/pairing.
 */
export function createSyncRuntimeNameStore(args: SyncRuntimeNameStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  let cachedName: string | null | undefined;

  const readFromDisk = (): string | null => {
    if (!fs.existsSync(args.filePath)) return null;
    const parsed = safeJsonParse<SyncRuntimeNameFile | null>(
      fs.readFileSync(args.filePath, "utf8"),
      null,
    );
    if (!isRuntimeNameFile(parsed)) return null;
    const normalized = normalizeRuntimeName(parsed.runtimeName);
    return normalized.length > 0 ? normalized : null;
  };

  const load = (): string | null => {
    if (cachedName !== undefined) return cachedName;
    cachedName = readFromDisk();
    return cachedName;
  };

  return {
    getRuntimeName(): string | null {
      return load();
    },

    hasRuntimeName(): boolean {
      return load() !== null;
    },

    setRuntimeName(name: string): void {
      const normalized = normalizeRuntimeName(name);
      if (normalized.length === 0) {
        throw new Error("Machine name must not be empty.");
      }
      const payload: SyncRuntimeNameFile = {
        runtimeName: normalized,
        updatedAt: new Date().toISOString(),
      };
      writeTextAtomic(args.filePath, `${JSON.stringify(payload, null, 2)}\n`);
      cachedName = normalized;
    },

    clearRuntimeName(): void {
      try {
        fs.rmSync(args.filePath, { force: true });
      } catch {
        // ignore cleanup failures
      }
      cachedName = null;
    },
  };
}

export type SyncRuntimeNameStore = ReturnType<typeof createSyncRuntimeNameStore>;
