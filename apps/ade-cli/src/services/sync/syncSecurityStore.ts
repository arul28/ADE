import fs from "node:fs";
import path from "node:path";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";

type SyncSecurityFile = {
  /**
   * When true, paired hellos from devices without a registered DPoP key are
   * rejected, forcing a re-pair that binds a Secure Enclave key. Devices with
   * a key on record always require a valid proof regardless of this flag.
   */
  requireDpop?: boolean;
};

type SyncSecurityStoreArgs = {
  filePath: string;
};

/**
 * Machine-level sync security posture, stored next to the pairing PIN under
 * `~/.ade/secrets/`. `ADE_SYNC_REQUIRE_DPOP=1|0` overrides the stored value
 * for headless/CI setups.
 */
export function createSyncSecurityStore(args: SyncSecurityStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  const read = (): SyncSecurityFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<SyncSecurityFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const write = (value: SyncSecurityFile): void => {
    // 0o600 at temp-file creation so DPoP policy state is never world-readable.
    writeTextAtomic(args.filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  return {
    getRequireDpop(): boolean {
      const env = process.env.ADE_SYNC_REQUIRE_DPOP;
      if (env === "1") return true;
      if (env === "0") return false;
      return read().requireDpop === true;
    },

    setRequireDpop(requireDpop: boolean): void {
      write({ ...read(), requireDpop });
    },
  };
}

export type SyncSecurityStore = ReturnType<typeof createSyncSecurityStore>;
