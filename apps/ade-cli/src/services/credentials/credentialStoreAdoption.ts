import {
  FILE_BACKED_CREDENTIAL_KEYS,
  credentialPathKey,
  type SyncCredentialStore,
} from "./credentialStore";
import { updateCredentialKeySync } from "./updateCredentialKey";

/**
 * The one-way migration that moves file-backed credentials out of the
 * Electron-only store and back into the shared machine file.
 *
 * Split out of credentialStore.ts because it is a migration, not a store: it
 * runs once per secrets directory, it compares two copies of one record, and it
 * is the only code here that has to decide which of two secrets is the real one.
 * Consumers import it from this module directly: re-exporting it through
 * credentialStore.ts made the two modules import each other, so the re-export
 * was removed.
 */

const adoptedSecretsDirs = new Set<string>();

/**
 * When one stored credential was last written, in epoch milliseconds, or `NaN`
 * when the record does not say.
 *
 * Deliberately generic JSON rather than a typed credential: this module stays
 * free of service-layer imports. `updatedAt` is what every record that can be
 * stranded carries today; `obtainedAt` is read as well because the account
 * session record spells the same fact that way, and a record ADE cannot date is
 * a record it cannot safely replace.
 */
export function credentialUpdatedAtMs(raw: string | null | undefined): number {
  if (!raw?.trim()) return Number.NaN;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Number.NaN;
    const record = parsed as Record<string, unknown>;
    const stamp = typeof record.updatedAt === "string"
      ? record.updatedAt
      : typeof record.obtainedAt === "string" ? record.obtainedAt : null;
    return stamp == null ? Number.NaN : Date.parse(stamp);
  } catch {
    return Number.NaN;
  }
}

/** True when the record says when it was written. */
function isDateable(raw: string | null | undefined): boolean {
  return Number.isFinite(credentialUpdatedAtMs(raw));
}

/**
 * True when the stranded desktop copy is provably newer than the shared one.
 *
 * A copy that does not say when it was written loses to one that does, and two
 * silent copies leave the shared file alone — the shared file is where the
 * brain writes, so it is the safer default.
 */
export function strandedCopyIsFresher(stranded: string, shared: string): boolean {
  const strandedAt = credentialUpdatedAtMs(stranded);
  if (!Number.isFinite(strandedAt)) return false;
  const sharedAt = credentialUpdatedAtMs(shared);
  return !Number.isFinite(sharedAt) || strandedAt > sharedAt;
}

/**
 * Moves file-backed credentials a previous build left in the Electron-only
 * store back into the shared machine file.
 *
 * Runs once per secrets directory per process, and only a pass that completes
 * counts: a pass that could not read the Electron store is retried by the next
 * store built in this process, rather than leaving the credential stranded for
 * the life of the app.
 *
 * When both stores hold the key, the fresher record wins by its `updatedAt`.
 * The shared file is usually the fresher one, because the brain writes there —
 * but a desktop build that wrote the GitHub App token into the Electron-only
 * store left the ONLY current copy there, and keeping the older shared copy
 * would hand GitHub a refresh token it has already rotated away. A value is
 * only removed from the Electron-only store once the shared file holds one, and
 * when NEITHER copy says when it was written the stranded one is left where it
 * is: an undated record is not evidence that the shared copy is the newer one,
 * and deleting the other secret on that guess is unrecoverable.
 */
export function adoptFileBackedCredentials(args: {
  primary: SyncCredentialStore;
  fileStore: SyncCredentialStore;
  identity: string;
}): { adopted: string[]; pruned: string[] } {
  const adopted: string[] = [];
  const pruned: string[] = [];
  const identity = credentialPathKey(args.identity);
  if (adoptedSecretsDirs.has(identity)) return { adopted, pruned };
  let completed = true;
  for (const key of FILE_BACKED_CREDENTIAL_KEYS) {
    let stranded: string | null = null;
    try {
      stranded = args.primary.getSync(key);
    } catch {
      // An unreadable Electron store has nothing to adopt for this key, and
      // saying so is the job of `getLastReadState`, not of this migration. The
      // pass stays incomplete so a later one can try again.
      completed = false;
      continue;
    }
    if (!stranded?.trim()) continue;
    const strandedValue = stranded;
    try {
      let wrote = false;
      // Set when the shared copy was kept only because neither record could be
      // dated — a guess, and not one worth destroying the other copy over.
      let undatedStandoff = false;
      const nextValue = (current: string | null): string | undefined => {
        if (current?.trim() && !strandedCopyIsFresher(strandedValue, current)) {
          undatedStandoff = !isDateable(strandedValue) && !isDateable(current);
          return undefined;
        }
        wrote = true;
        return strandedValue;
      };
      // Atomic when the store can be: a brain write racing this adoption must
      // be compared against what it actually wrote, and check-then-set leaves a
      // window where the comparison is made against a value that is already
      // gone.
      updateCredentialKeySync(args.fileStore, key, nextValue);
      if (wrote) adopted.push(key);
      if (!wrote && undatedStandoff) continue;
      args.primary.deleteSync(key);
      pruned.push(key);
    } catch {
      // Best effort: leaving the duplicate behind is survivable, losing the
      // credential is not.
      completed = false;
    }
  }
  if (completed) adoptedSecretsDirs.add(identity);
  return { adopted, pruned };
}
