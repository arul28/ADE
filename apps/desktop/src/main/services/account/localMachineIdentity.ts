/**
 * localMachineIdentity.ts
 *
 * The one place that answers "which machine is this?" for the account
 * directory.
 *
 * The machine key is the identity every other machine on the account files this
 * computer's data under: the directory lists it, peers stamp it onto incoming
 * usage rollups, and the runtime bridge hands it to the renderer. Anything that
 * publishes under a *different* key — a hostname, a random id — is publishing a
 * second, phantom computer that no peer will ever reconcile with the real one.
 *
 * This module deliberately depends on nothing from Electron so services outside
 * the IPC layer (the usage rollup publisher, the CLI-hosted brain) can resolve
 * the same identity without importing the bridge.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdeAccountLocalMachineIdentity } from "../../../shared/types";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { createSyncCloudRelayStore } from "../../../../../ade-cli/src/services/sync/syncCloudRelayStore";

/**
 * "Someone else created this file first" — the outcome that means re-read, not
 * fail.
 *
 * POSIX reports it as EEXIST. Windows does not: a name is only unlinked once
 * every open handle to it closes, so a concurrent `wx` against a delete-pending
 * name fails with EPERM, EACCES or EBUSY instead. Treating those as fatal
 * throws here, and the caller's fallback for a thrown identity is to publish
 * nothing — the machine drops out of the account directory on Windows for as
 * long as two processes race the first write. Mirrors `isLockContention` in
 * `ade-cli/src/services/credentials/credentialStore.ts`; see windows-quirks §6.
 */
export function isCreateContention(error: unknown, platform: NodeJS.Platform): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return true;
  if (platform !== "win32") return false;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

export function getOrCreateLocalAccountMachineIdentity(args: {
  secretsDir?: string;
  randomUUID?: () => string;
  /**
   * Injectable so the Windows branch above is provable on a macOS or Linux
   * runner. Windows-only behaviour that only a Windows host can exercise is
   * behaviour nobody checks until it breaks in front of a user.
   */
  platform?: NodeJS.Platform;
} = {}): AdeAccountLocalMachineIdentity {
  const platform = args.platform ?? process.platform;
  const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
  const deviceIdPath = path.join(secretsDir, "sync-device-id");
  // Owner-only: this directory holds the sync device id and the cloud relay
  // machine identity. `mode` applies only to directories this call creates, so
  // an existing directory keeps whatever mode it already had, and `recursive`
  // still makes a repeat call a no-op.
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const readDeviceId = (): string | null => {
    try {
      const value = fs.readFileSync(deviceIdPath, "utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  };

  let deviceId = readDeviceId();
  if (!deviceId) {
    const candidate = (args.randomUUID ?? nodeRandomUUID)();
    try {
      fs.writeFileSync(deviceIdPath, `${candidate}\n`, { flag: "wx", mode: 0o600 });
      deviceId = candidate;
    } catch (error) {
      if (!isCreateContention(error, platform)) throw error;
      deviceId = readDeviceId();
    }
  }
  if (!deviceId) throw new Error("Local ADE device identity is unavailable.");
  try {
    fs.chmodSync(deviceIdPath, 0o600);
  } catch {
    // Best-effort on filesystems without POSIX mode support.
  }

  const machineCloudRelayStore = createSyncCloudRelayStore({
    filePath: path.join(secretsDir, "sync-cloud-relay.json"),
  });
  const { machineKey } = machineCloudRelayStore.getMachineIdentity();
  return { machineKey, deviceId };
}
