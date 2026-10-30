/**
 * The "ADE could not start" window and the database copies behind its "Go
 * back" choice. See docs/plans/beta-track.md, "Database compatibility".
 */

/** Which database a copy belongs to. */
export type LocalDatabaseKind = "machine" | "personal" | "project";

/**
 * One copy ADE took of a database before a new version first opened it:
 * `<db>.pre-<toVersion>-from-<fromVersion>.bak`, beside the database.
 */
export type DatabaseCopyInfo = {
  path: string;
  fileName: string;
  databaseKind: LocalDatabaseKind;
  /** A project's name; for the other kinds the UI names it. */
  databaseLabel: string;
  databasePath: string;
  /** The version that was about to open the database (as written in the name). */
  toVersion: string;
  /** The version that had it before; null when ADE did not know which. */
  fromVersion: string | null;
  /** When the copy was written, in ms since the epoch. */
  takenAt: number;
  /** The copy and any `-wal` or `-shm` file beside it. */
  sizeBytes: number;
};

export type DatabaseCopyDeleteResult = { deleted: true } | { deleted: false; reason: string };

/** `window.ade.databaseCopies`: this computer's copies only, so it takes no pin. */
export type DatabaseCopiesBridge = {
  list: () => Promise<DatabaseCopyInfo[]>;
  reveal: (path: string) => Promise<{ revealed: boolean }>;
  delete: (path: string) => Promise<DatabaseCopyDeleteResult>;
};

/** What the window shows while "Go back" runs. */
export type StartupRecoveryPhase =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "downloading"; percent: number | null }
  | { state: "installing" }
  | { state: "failed"; message: string };

export type StartupRecoveryWindowState = {
  /** One plain line: what failed. */
  line: string;
  runningVersion: string;
  /** Present only when a previous version and a matching copy exist. */
  goBack: {
    version: string;
    /** When the newest copy it restores was taken, in ms since the epoch. */
    dataFrom: number | null;
  } | null;
  phase: StartupRecoveryPhase;
};

export type StartupRecoveryAction = "try_again" | "go_back" | "open_logs" | "copy_details";
