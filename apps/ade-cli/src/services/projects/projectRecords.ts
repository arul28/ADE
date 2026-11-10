import {
  decodeProjectRecordIcon,
  decodeProjectRecordName,
  isSendableProjectRecordValue,
  PROJECT_RECORD_ICON_KEY,
  PROJECT_RECORD_NAME_KEY,
  PROJECT_RECORD_NO_ICON,
  projectRecordScope,
  projectRecordSendOutcome,
  type ProjectRecordIconValue,
  type ProjectRecordSendAnswer,
  type ProjectRecordSendOutcome,
} from "../../../../desktop/src/shared/projectRecord";
import {
  createProjectRecordStandInStore,
  decideProjectRecordIcon,
  readProjectRecordPending,
  writeProjectRecordPending,
  type ProjectRecordIconDecision,
  type ProjectRecordStore,
} from "../../../../desktop/src/main/services/projects/projectRecordHost";

/**
 * The shared project record (`shared/projectRecord.ts`) as the brain reads
 * and writes it: in the machine's account settings store when sync is on,
 * otherwise in each project's `.ade/project-record.json`.
 *
 * Every read is a lookup in memory, so `projects.list` can ask for every
 * project: the account store is read as one snapshot of the record's rows at
 * most once a second (each store read checks the signed-in account, which
 * reads the session file), and the stand-in is checked with a stat.
 * Shrinking an icon never happens here: callers hand in a value the icon
 * worker or the write path already made.
 *
 * With sync on, a user's choice the store cannot take (signed out, a write
 * that throws) is kept as pending in the stand-in file, the same entry the
 * desktop keeps. This machine shows the pending value, and the next read or
 * write that reaches the store sends it first. With sync off the stand-in is
 * the store, and nothing is pending.
 */

type RecordLogger = { warn(event: string, data?: Record<string, unknown>): void };

export type ProjectRecordTarget = { rootPath: string; gitOriginUrl?: string | null };

/** The account settings store, with the listing a snapshot needs. */
export type ProjectRecordAccountStore = ProjectRecordStore & {
  list(): Array<{ scope: string; key: string; value: unknown }>;
};

const SNAPSHOT_MS = 1_000;

/** A value `decodeProjectRecordIcon` reads as "invalid": a read that failed must not trigger an upload. */
const UNREADABLE = Object.freeze({ v: -1 });
const MIGRATION_RETRY_MS = 10 * 60_000;
const MIGRATION_MEMO_MAX = 256;

export function createMachineProjectRecords(args: {
  /** The machine's account settings store, or null when this brain has none (sync off). */
  accountStore: () => ProjectRecordAccountStore | null;
  /** Whether an ADE account is signed in (a refused write while signed out stays pending). */
  isSignedIn: () => boolean;
  logger: RecordLogger;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const migrationAttempts = new Map<string, number>();
  let snapshot: { at: number; rows: Map<string, unknown> } | null = null;
  const scopeOf = (project: ProjectRecordTarget): string | null => projectRecordScope(project.gitOriginUrl ?? null);

  const accountValue = (store: ProjectRecordAccountStore, scope: string, key: string): unknown => {
    if (!snapshot || now() - snapshot.at > SNAPSHOT_MS) {
      const rows = new Map<string, unknown>();
      for (const row of store.list()) {
        if (row.key === PROJECT_RECORD_ICON_KEY || row.key === PROJECT_RECORD_NAME_KEY) {
          rows.set(`${row.scope}\u0000${row.key}`, row.value);
        }
      }
      snapshot = { at: now(), rows };
    }
    return snapshot.rows.get(`${scope}\u0000${key}`);
  };

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  let signedInMemo: { at: number; value: boolean } | null = null;
  /** Read at most once a second: it reads the session file. */
  const isSignedIn = (): boolean => {
    if (!signedInMemo || now() - signedInMemo.at > SNAPSHOT_MS) signedInMemo = { at: now(), value: args.isSignedIn() };
    return signedInMemo.value;
  };

  const readPending = (project: ProjectRecordTarget, scope: string, key: string): unknown => {
    try {
      return readProjectRecordPending(project.rootPath, scope, key);
    } catch {
      return undefined;
    }
  };

  /** Saves or (undefined) clears the pending write. False when the file could not be written (logged). */
  const setPending = (project: ProjectRecordTarget, scope: string, key: string, value: unknown): boolean => {
    try {
      writeProjectRecordPending(project.rootPath, scope, key, value);
      return true;
    } catch (error) {
      args.logger.warn("project.record_pending_write_failed", { key, error: errorText(error) });
      return false;
    }
  };

  /**
   * One send to the account store, with the rule both hosts share: stored or
   * refused clears a pending entry (a refusal is logged); otherwise a user's
   * choice is kept pending (`keep`), a flushed one simply stays. A kept
   * choice answers `stored` only when it reached the store or the pending file.
   */
  const send = (
    project: ProjectRecordTarget,
    store: ProjectRecordAccountStore,
    scope: string,
    key: string,
    value: unknown,
    keep: boolean,
  ): ProjectRecordSendOutcome => {
    // A value that is not a valid record value (too large, damaged) is never sent.
    const sendable = isSendableProjectRecordValue(key, value);
    let answer: ProjectRecordSendAnswer = "refused";
    if (sendable) {
      try {
        // The store answers false when it dropped the write (signed out, account changed).
        answer = store.set(scope, key, value) === false ? "refused" : "accepted";
        if (answer === "accepted") snapshot = null;
      } catch (error) {
        args.logger.warn("project.record_write_failed", { key, error: errorText(error) });
        answer = "unreachable";
      }
    }
    const outcome = sendable ? projectRecordSendOutcome(answer, isSignedIn) : "refused";
    if (outcome === "keep_pending") {
      if (keep && setPending(project, scope, key, value)) args.logger.warn("project.record_write_pending", { key });
      return outcome;
    }
    if (outcome === "refused") args.logger.warn("project.record_write_dropped", { key });
    if (readPending(project, scope, key) !== undefined) setPending(project, scope, key, undefined);
    return outcome;
  };

  const read = (project: ProjectRecordTarget, scope: string, key: string): unknown => {
    try {
      const account = args.accountStore();
      if (!account) return createProjectRecordStandInStore(project.rootPath).get(scope, key);
      const pending = readPending(project, scope, key);
      if (pending === undefined) return accountValue(account, scope, key);
      // This machine's latest choice goes first; while it cannot go, it is what
      // this machine shows. Signed out, the store would only drop it again.
      if (!isSignedIn()) return pending;
      return send(project, account, scope, key, pending, false) === "refused" ? accountValue(account, scope, key) : pending;
    } catch (error) {
      args.logger.warn("project.record_read_failed", { key, error: errorText(error) });
      return UNREADABLE;
    }
  };

  /** A user's choice: kept pending when the account store cannot take it now. True when it was kept. */
  const write = (project: ProjectRecordTarget, scope: string, key: string, value: unknown): boolean => {
    const account = args.accountStore();
    if (account) {
      const outcome = send(project, account, scope, key, value, true);
      return outcome === "stored" || (outcome === "keep_pending" && readPending(project, scope, key) !== undefined);
    }
    try {
      createProjectRecordStandInStore(project.rootPath).set(scope, key, value);
      return true;
    } catch (error) {
      args.logger.warn("project.record_write_failed", { key, error: errorText(error) });
      return false;
    }
  };

  return {
    /** True when the project has an origin, so its name and icon follow the account. */
    isShared(project: ProjectRecordTarget): boolean {
      return scopeOf(project) !== null;
    },

    iconDecision(project: ProjectRecordTarget): ProjectRecordIconDecision {
      const scope = scopeOf(project);
      return decideProjectRecordIcon(scope, scope ? read(project, scope, PROJECT_RECORD_ICON_KEY) : undefined);
    },

    /** The shared display name, or null to keep the local one. */
    name(project: ProjectRecordTarget): string | null {
      const scope = scopeOf(project);
      return scope ? decodeProjectRecordName(read(project, scope, PROJECT_RECORD_NAME_KEY)) : null;
    },

    /** Stores the icon a user just chose here. False when it was not stored (logged). */
    writeIcon(project: ProjectRecordTarget, value: ProjectRecordIconValue | null): boolean {
      const scope = scopeOf(project);
      if (!scope) return false;
      if (!value) {
        // The local icon is kept; only the copy for other machines is missing.
        args.logger.warn("project.record_icon_not_shared", { reason: "too_large_or_unreadable" });
        return false;
      }
      return write(project, scope, PROJECT_RECORD_ICON_KEY, value);
    },

    /** Records that the custom icon was removed, so no machine brings its old one back. */
    writeNoIcon(project: ProjectRecordTarget): boolean {
      const scope = scopeOf(project);
      return scope ? write(project, scope, PROJECT_RECORD_ICON_KEY, PROJECT_RECORD_NO_ICON) : false;
    },

    /**
     * The one-time upload of this machine's own icon for a project from
     * before the record. Writes only while the record still has no icon, and
     * tries a repository at most once in ten minutes. `undefined` means this
     * machine has no custom icon; `null` means it has one that does not fit.
     */
    completeMigration(project: ProjectRecordTarget, value: ProjectRecordIconValue | null | undefined): void {
      const scope = scopeOf(project);
      if (!scope || value === undefined) return;
      const last = migrationAttempts.get(scope);
      if (last !== undefined && now() - last < MIGRATION_RETRY_MS) return;
      if (migrationAttempts.size >= MIGRATION_MEMO_MAX) migrationAttempts.clear();
      migrationAttempts.set(scope, now());
      if (!value) {
        args.logger.warn("project.record_icon_not_shared", { reason: "too_large_or_unreadable" });
        return;
      }
      if (decodeProjectRecordIcon(read(project, scope, PROJECT_RECORD_ICON_KEY)).state !== "absent") return;
      // Never kept pending: a late upload must not beat a newer icon, and it tries again on its own.
      const account = args.accountStore();
      if (account) send(project, account, scope, PROJECT_RECORD_ICON_KEY, value, false);
      else write(project, scope, PROJECT_RECORD_ICON_KEY, value);
    },
  };
}

export type MachineProjectRecords = ReturnType<typeof createMachineProjectRecords>;
