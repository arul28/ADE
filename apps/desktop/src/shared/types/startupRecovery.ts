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
  /**
   * Set aside by "Go back": what the newer version left (`…_kept.bak`).
   * `toVersion` is the version ADE went back to, `fromVersion` the one it left.
   * Never a way back; kept a week after going back worked, for support.
   */
  kept: boolean;
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

/** What the window shows: the choices, the Go back question, its progress, or what went wrong. */
export type StartupRecoveryPhase =
  | { state: "idle" }
  | { state: "confirm" }
  | { state: "checking" }
  | { state: "downloading"; percent: number | null }
  | { state: "installing" }
  /** `message`: what went wrong. `next`: what to do now. */
  | { state: "failed"; message: string; next: string };

export type StartupRecoveryWindowState = {
  /** One plain sentence: what happened. */
  line: string;
  runningVersion: string;
  /** Present only when a previous version and a matching copy exist. */
  goBack: {
    version: string;
    /** When the newest copy it restores was taken, in ms since the epoch. */
    dataFrom: number | null;
    /** What is put back, in plain words ("your chats that aren't in a project"). */
    putsBack: string[];
    /** Projects that stay as they are; 0 when none. */
    projectsLeftAlone: number;
  } | null;
  phase: StartupRecoveryPhase;
};

export type StartupRecoveryAction =
  | "try_again"
  /** Shows the Go back question; nothing changes yet. */
  | "go_back"
  | "confirm_go_back"
  | "cancel_go_back"
  | "open_logs"
  | "copy_details";
