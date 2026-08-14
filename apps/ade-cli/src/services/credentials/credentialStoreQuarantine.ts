import fs from "node:fs";
import path from "node:path";
import {
  ensureMode600,
  isEnoent,
  readJsonObject,
  unlinkIfExists,
  writeFileAtomic,
} from "./credentialFileIo";
import type { CredentialStoreReadFailureReason } from "./credentialStore";

/**
 * Setting an unreadable credential file aside so the process that hit it can
 * keep running.
 *
 * The alternative — refusing to write — is what crash-looped the ADE brain
 * under launchd: its first startup act mints the sync bootstrap token, and a
 * write that throws on an unreadable store is a process exit and an immediate
 * relaunch, forever. Quarantine keeps the "never write an empty store over real
 * credentials" invariant by preserving the bytes instead of refusing to run.
 *
 * Type-only import of the failure reason back from `credentialStore`: the cycle
 * is erased at compile time, and the reason genuinely belongs to the read that
 * produced it rather than to this module.
 */

/**
 * A credential file that could not be read and was moved aside so the process
 * that hit it could keep running.
 *
 * `recoverable` means a peer process may still hold the key (an `os`-sealed
 * store quarantined by the brain, which the desktop app can open). Those are
 * merged back automatically by the first store instance that can decrypt them —
 * see `recoverQuarantinedStore`. Anything else is kept purely for diagnostics.
 */
export type CredentialStoreQuarantineRecord = {
  version: 1;
  at: string;
  /** Basename of the quarantined ciphertext, in the same directory. */
  file: string;
  reason: CredentialStoreReadFailureReason;
  recoverable: boolean;
};

/**
 * How long a recoverable quarantine keeps being retried before ADE stops
 * expecting a peer to turn up with the key. Generous on purpose: the peer here
 * is usually "the user opens the desktop app", which can be a fortnight away on
 * a machine that only runs the brain.
 */
export const QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function quarantineMarkerPath(credentialsPath: string): string {
  return `${credentialsPath}.quarantine.json`;
}

function isQuarantineRecord(value: unknown): value is CredentialStoreQuarantineRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<CredentialStoreQuarantineRecord>;
  return record.version === 1
    && typeof record.at === "string"
    && Number.isFinite(Date.parse(record.at))
    && typeof record.file === "string"
    // A marker names a sibling file, never a path: it is read by processes that
    // may be less trusted than whatever wrote it, and following `../` out of the
    // secrets directory is not a thing this format needs to support.
    && record.file.length > 0
    && !record.file.includes("/")
    && !record.file.includes("\\")
    && record.file !== "."
    && record.file !== ".."
    && (record.reason === "decrypt_failure"
      || record.reason === "no_os_key_material"
      || record.reason === "store_format")
    && typeof record.recoverable === "boolean";
}

export function readCredentialStoreQuarantine(
  credentialsPath: string,
): CredentialStoreQuarantineRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(quarantineMarkerPath(credentialsPath), "utf8"),
    ) as unknown;
    return isQuarantineRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Copies the unreadable ciphertext to a timestamped sibling and records a marker
 * beside it. The caller holds the store's lock and is expected to replace the
 * original with a fresh store immediately after.
 *
 * COPY, not rename, and that is a Windows correctness requirement: deleting or
 * renaming a file there only succeeds once every handle to it closes, so a peer
 * process mid-read turns the rename into EPERM/EACCES/EBUSY. Copying leaves the
 * original in place for the caller's ordinary atomic write to replace — the same
 * operation every credential write already performs, so quarantine adds no new
 * Windows failure mode. Returns null when there was nothing to set aside.
 */
export function quarantineCredentialFile(args: {
  credentialsPath: string;
  reason: CredentialStoreReadFailureReason;
  recoverable: boolean;
  now?: Date;
}): CredentialStoreQuarantineRecord | null {
  const at = args.now ?? new Date();
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const file = `${path.basename(args.credentialsPath)}.quarantined-${stamp}`;
  const target = path.join(path.dirname(args.credentialsPath), file);
  try {
    fs.copyFileSync(args.credentialsPath, target);
    ensureMode600(target);
  } catch (error: unknown) {
    if (isEnoent(error)) return null; // A peer already replaced or removed it.
    throw new Error(
      "ADE could not set aside the unreadable credential store, so it was left untouched.",
      { cause: error },
    );
  }
  const record: CredentialStoreQuarantineRecord = {
    version: 1,
    at: at.toISOString(),
    file,
    reason: args.reason,
    recoverable: args.recoverable,
  };
  writeQuarantineRecord(args.credentialsPath, record);
  pruneExpiredQuarantineFiles(args.credentialsPath);
  return record;
}

/**
 * Records — or updates — the marker. Best effort: it only drives recovery and
 * reporting, so losing it must never fail the write the quarantine unblocked.
 */
export function writeQuarantineRecord(
  credentialsPath: string,
  record: CredentialStoreQuarantineRecord,
): void {
  try {
    writeFileAtomic(
      quarantineMarkerPath(credentialsPath),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch {
    // Reporting-only state.
  }
}

export function clearQuarantineMarker(credentialsPath: string): void {
  try {
    unlinkIfExists(quarantineMarkerPath(credentialsPath));
  } catch {
    // A stale marker is not worth failing a read for.
  }
}

/** Reads a quarantined copy without the store's key-derivation or rewrites. */
export function readQuarantinedStoreFile(
  credentialsPath: string,
  record: CredentialStoreQuarantineRecord,
): Record<string, unknown> | null {
  return readJsonObject(path.join(path.dirname(credentialsPath), record.file));
}

export function deleteQuarantinedStoreFile(
  credentialsPath: string,
  record: CredentialStoreQuarantineRecord,
): void {
  unlinkIfExists(path.join(path.dirname(credentialsPath), record.file));
}

/**
 * Drops quarantined ciphertext nobody came back for. Diagnostics are worth a
 * month, not forever — these files are undecryptable-by-anyone in the corrupt
 * case and decryptable-by-a-peer in the recoverable one, and neither should
 * accumulate one copy per failed startup.
 */
export function pruneExpiredQuarantineFiles(credentialsPath: string): void {
  const dir = path.dirname(credentialsPath);
  const prefix = `${path.basename(credentialsPath)}.quarantined-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const active = readCredentialStoreQuarantine(credentialsPath)?.file ?? null;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry === active) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry));
      if (Date.now() - stat.mtimeMs <= QUARANTINE_RETENTION_MS) continue;
      fs.unlinkSync(path.join(dir, entry));
    } catch {
      // Best effort housekeeping.
    }
  }
}

export function quarantineHasExpired(
  record: CredentialStoreQuarantineRecord,
  now: number = Date.now(),
): boolean {
  return now - Date.parse(record.at) > QUARANTINE_RETENTION_MS;
}
