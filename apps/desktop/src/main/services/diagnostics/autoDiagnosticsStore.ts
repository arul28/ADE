import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAILURE_CODE_PATTERN } from "../../../shared/diagnosticsUpload";
import { writeFileAtomic } from "../state/durableFile";

/**
 * The consent flag and the spend ledger for automatic diagnostic uploads.
 *
 * ONE file for BOTH senders. The desktop main process and the brain
 * (`apps/ade-cli`) each detect different failures and each can auto-send, but
 * the budget the user is promised — "at most three a day from this computer" —
 * is a property of the install, not of a process. Two private ledgers would
 * quietly mean six. So this module is deliberately dependency-free (plain
 * `node:fs`, no Electron, no logger) and is imported by both, exactly the way
 * both already share `~/.ade/secrets/product-analytics.json`.
 *
 * The JSON shape and the atomic replace behave identically on Windows. The
 * mkdir lock does NOT quite: see `isLockContention` below for the delete-pending
 * window that makes Windows report contention as EPERM/EACCES/EBUSY instead of
 * EEXIST, which this module handles explicitly rather than assuming away.
 */

/** `<adeHome>/secrets/diagnostics-autosend.json`. */
export function resolveAutoDiagnosticsStateFile(
  adeHome?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = adeHome?.trim() || env.ADE_HOME?.trim() || path.join(os.homedir(), ".ade");
  return path.join(path.resolve(home), "secrets", "diagnostics-autosend.json");
}

/** Rolling window for both budgets. */
export const AUTO_DIAGNOSTICS_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** At most one automatic report per distinct failure code per window. */
export const MAX_AUTO_DIAGNOSTICS_PER_CODE = 1;
/** At most this many automatic reports in total per window, per install. */
export const MAX_AUTO_DIAGNOSTICS_PER_WINDOW = 3;

/**
 * Shape the server accepts for `failureCode`. Checked here so a caller that
 * invents a code never spends a send on a request the Worker will refuse.
 *
 * Re-exported from the uploader rather than written out a second time: the
 * uploader already has to know this shape to decide what it puts on the wire,
 * and two copies in the same process is how they drift.
 */
export const AUTO_DIAGNOSTICS_FAILURE_CODE_PATTERN = FAILURE_CODE_PATTERN;

/**
 * Coerces a caller's code into the server's shape, or null when it cannot be.
 *
 * Failure codes come from typed unions (`AdeRecoveryErrorCode`, an update step
 * id, a pairing refusal code) that already look like this; the normalization is
 * for the ones assembled by hand at a call site.
 */
export function normalizeAutoDiagnosticsFailureCode(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 48);
  return AUTO_DIAGNOSTICS_FAILURE_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

export type AutoDiagnosticsSource = "desktop" | "brain";

/** One spent send. Codes and timestamps only — never a report or its text. */
export type AutoDiagnosticsSend = {
  code: string;
  atMs: number;
  source: AutoDiagnosticsSource;
  /** Local path of the saved `.md`, so the toast's "View" can reveal it. */
  reportPath: string | null;
  /** Short upload handle, present once the upload succeeded. */
  reference: string | null;
  /**
   * A successful send no renderer has drained yet.
   *
   * Set on EVERY successful send, including one made while a window was open:
   * `webContents.send` does not throw when the receiving renderer has crashed
   * or has not mounted its toast host, so nothing on the sending side can know
   * the user was shown anything. Only a renderer draining this clears it.
   */
  pending: boolean;
};

export type AutoDiagnosticsState = {
  enabled: boolean;
  sends: AutoDiagnosticsSend[];
};

export type AutoDiagnosticsClaim =
  | { allowed: true; atMs: number }
  | { allowed: false; reason: "disabled" | "code_limit" | "daily_limit" | "state_unavailable" };

const LOCK_STALE_MS = 5_000;
/** Hard cap on retained entries so a long-lived install cannot grow the file. */
const MAX_RETAINED_SENDS = 24;

function readTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function readSend(value: unknown): AutoDiagnosticsSend | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = normalizeAutoDiagnosticsFailureCode(
    typeof record.code === "string" ? record.code : null,
  );
  const atMs = readTimestamp(record.atMs);
  if (!code || atMs == null) return null;
  return {
    code,
    atMs,
    source: record.source === "brain" ? "brain" : "desktop",
    reportPath: typeof record.reportPath === "string" && record.reportPath.trim()
      ? record.reportPath
      : null,
    reference: typeof record.reference === "string" && record.reference.trim()
      ? record.reference.trim()
      : null,
    pending: record.pending === true,
  };
}

/**
 * Reads the file, or reports that it could not be read.
 *
 * The distinction is the whole point. An ABSENT file is a machine that has
 * never auto-sent: the setting is on and the budget is untouched. A file that
 * exists but cannot be parsed is a machine whose spend history is unknown, and
 * forgiving an unknown counter is the same as not keeping one — so callers
 * treat it as spent. Only an explicit `enabled: false` turns the feature off,
 * which is what makes the setting default ON.
 */
function readState(filePath: string): { state: AutoDiagnosticsState; readable: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // ENOENT is the untouched machine; anything else (EACCES, EISDIR, EIO) is a
    // store we cannot account against.
    return { state: { enabled: true, sends: [] }, readable: code === "ENOENT" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: { enabled: true, sends: [] }, readable: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: { enabled: true, sends: [] }, readable: false };
  }
  const record = parsed as Record<string, unknown>;
  const sends = Array.isArray(record.sends)
    ? record.sends.map(readSend).filter((entry): entry is AutoDiagnosticsSend => entry != null)
    : [];
  return {
    // Default ON: only an explicit `false` is a withdrawal of consent.
    state: { enabled: record.enabled !== false, sends },
    readable: true,
  };
}

function serialize(state: AutoDiagnosticsState): string {
  return `${JSON.stringify(
    {
      version: 1,
      enabled: state.enabled,
      ...(state.sends.length ? { sends: state.sends } : {}),
    },
    null,
    2,
  )}\n`;
}

function writeState(filePath: string, state: AutoDiagnosticsState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath, serialize(state), { fsync: true, mode: 0o600 });
}

/**
 * Is this error "somebody else holds the lock", rather than a real fault?
 *
 * MIRRORS `isLockContention` in
 * `apps/ade-cli/src/services/credentials/credentialFileIo.ts`, copied rather
 * than imported to keep this module's one dependency rule — plain `node:fs`,
 * nothing from either app's service tree, because both apps import it. Change
 * one, change the other.
 *
 * POSIX reports a taken lock name as EEXIST. Windows does not, always: removing
 * a directory entry there only frees the name once every handle to it closes,
 * so between one holder's `rmdir` and the last handle drop the name sits in a
 * "delete pending" state and a concurrent `mkdir` fails with EPERM, EACCES or
 * EBUSY. Those are the same condition, and treating them as fatal would make
 * every concurrent toggle on Windows a coin flip on whether consent persists.
 */
function isLockContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return true;
  if (process.platform !== "win32") return false;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Bounded, synchronous wait. Same `Atomics.wait` idiom as the credential store. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_RETRY_MS = 20;
const LOCK_RETRY_ATTEMPTS = 5;

/**
 * mkdir-based mutual exclusion, same idiom as the identity/relay store.
 *
 * `mkdir` is atomic on every filesystem ADE runs on, and a crashed holder is
 * reclaimed after `LOCK_STALE_MS` rather than wedging the feature forever.
 *
 * The wait is deliberately tiny — five tries, 20ms apart, so at most ~100ms of
 * blocking. The critical section is one small file rewritten a handful of times
 * a day, so a contended lock is nearly always the other process finishing its
 * own write microseconds from now; a spin that short converts almost every
 * collision into a success while still refusing to queue. Callers keep their
 * fail-closed fallbacks for the case it does not: giving up on a claim is the
 * correct outcome, and losing a consent flip is not (see
 * `setAutoDiagnosticsEnabled`).
 */
function acquireLock(filePath: string, now: () => number): (() => void) | null {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      fs.mkdirSync(lockPath);
      return () => {
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // Another process already reclaimed it as stale; nothing to undo.
        }
      };
    } catch (error) {
      if (!isLockContention(error)) return null;
      let reclaimed = false;
      try {
        // A negative age is a clock that moved backwards after the lock was
        // taken; treating it as fresh would wedge the feature until the clock
        // caught up, so both directions past the window count as stale.
        const age = now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS || age < -LOCK_STALE_MS) {
          fs.rmdirSync(lockPath);
          reclaimed = true;
        }
      } catch {
        // Released or reclaimed underneath us; the next attempt settles it.
        reclaimed = true;
      }
      // A lock we just reclaimed is free right now, so retry immediately; a
      // live one needs the holder to finish, which is what the pause is for.
      if (!reclaimed && attempt < LOCK_RETRY_ATTEMPTS - 1) sleepSync(LOCK_RETRY_MS);
    }
  }
  return null;
}

function withinWindow(sends: readonly AutoDiagnosticsSend[], nowMs: number): AutoDiagnosticsSend[] {
  // A stamp in the future is a clock that moved; it still counts as spent so a
  // corrupted or shifted clock cannot mint extra sends.
  return sends.filter((entry) => nowMs - entry.atMs < AUTO_DIAGNOSTICS_WINDOW_MS);
}

function mutate<T>(
  filePath: string,
  now: () => number,
  fn: (state: AutoDiagnosticsState, readable: boolean) => { state: AutoDiagnosticsState | null; result: T },
  onLocked: () => T,
): T {
  const release = acquireLock(filePath, now);
  if (!release) return onLocked();
  try {
    const { state, readable } = readState(filePath);
    const outcome = fn(state, readable);
    if (outcome.state) writeState(filePath, outcome.state);
    return outcome.result;
  } catch {
    return onLocked();
  } finally {
    release();
  }
}

/** Is automatic sending on? Default ON; an unreadable store still reads ON. */
export function isAutoDiagnosticsEnabled(filePath: string): boolean {
  return readState(filePath).state.enabled;
}

/**
 * Flips the setting, preserving whatever budget has already been spent.
 *
 * Returns what is actually persisted, which is not always what was asked for.
 * This is a consent control: a toggle that reports a state it did not manage to
 * save would show the user an "off" that is really on.
 *
 * Three attempts, weakest last. The lock's own short spin already absorbs
 * ordinary contention, so reaching the unlocked write means a holder outlived
 * ~100ms — and dropping a withdrawal of consent is worse than the narrow race
 * that write carries.
 */
export function setAutoDiagnosticsEnabled(
  filePath: string,
  enabled: boolean,
  deps: { now?: () => number } = {},
): boolean {
  const now = deps.now ?? Date.now;

  /** The correct path. `null` means the lock never came free. */
  const writeUnderLock = (): boolean | null =>
    mutate<boolean | null>(
      filePath,
      now,
      (state) => ({ state: { ...state, enabled }, result: enabled }),
      () => null,
    );

  const sendsFingerprint = (state: AutoDiagnosticsState): string => JSON.stringify(state.sends);

  /**
   * The same read-modify-write with no lock held, which can clobber a
   * concurrent ledger write.
   *
   * So it refuses to run into one it can see: the ledger is read twice and the
   * replace is abandoned if it moved in between. That cannot close the window —
   * only the lock does that — but it shrinks it from the whole read-modify-write
   * to the gap between two adjacent statements, and an abandoned attempt still
   * has a locked retry behind it. `null` is "did not write".
   */
  const writeWithoutLock = (): boolean | null => {
    try {
      const before = readState(filePath).state;
      if (sendsFingerprint(readState(filePath).state) !== sendsFingerprint(before)) return null;
      writeState(filePath, { ...before, enabled });
      // Read back rather than assume: if a writer landed on top of this one,
      // their value is the truth and the caller has to be told it.
      return readState(filePath).state.enabled;
    } catch {
      return null;
    }
  };

  const persisted = writeUnderLock() ?? writeWithoutLock() ?? writeUnderLock();
  if (persisted != null) return persisted;
  // Nothing landed. Fail loudly in the only way a boolean can: report the
  // state on disk, so the pane redraws to what is real.
  return isAutoDiagnosticsEnabled(filePath);
}

/**
 * Reserves one send, or explains why there is none to reserve.
 *
 * The reservation happens BEFORE the upload, not after it. A budget that only
 * counted successes would let a machine whose uploads all fail retry the same
 * failure every time it recurs — precisely the loop auto-send is not allowed to
 * become. What the user is promised is a ceiling on how often their computer
 * talks to ADE by itself, and an attempt is what costs them.
 */
export function claimAutoDiagnosticsSend(args: {
  filePath: string;
  failureCode: string;
  source: AutoDiagnosticsSource;
  now?: () => number;
}): AutoDiagnosticsClaim {
  const now = args.now ?? Date.now;
  const code = normalizeAutoDiagnosticsFailureCode(args.failureCode);
  if (!code) return { allowed: false, reason: "state_unavailable" };
  return mutate<AutoDiagnosticsClaim>(
    args.filePath,
    now,
    (state, readable) => {
      if (!state.enabled) return { state: null, result: { allowed: false, reason: "disabled" } };
      if (!readable) {
        return { state: null, result: { allowed: false, reason: "state_unavailable" } };
      }
      const nowMs = now();
      const recent = withinWindow(state.sends, nowMs);
      if (recent.filter((entry) => entry.code === code).length >= MAX_AUTO_DIAGNOSTICS_PER_CODE) {
        return { state: null, result: { allowed: false, reason: "code_limit" } };
      }
      if (recent.length >= MAX_AUTO_DIAGNOSTICS_PER_WINDOW) {
        return { state: null, result: { allowed: false, reason: "daily_limit" } };
      }
      const entry: AutoDiagnosticsSend = {
        code,
        atMs: nowMs,
        source: args.source,
        reportPath: null,
        reference: null,
        pending: false,
      };
      return {
        state: { ...state, sends: [...recent, entry].slice(-MAX_RETAINED_SENDS) },
        result: { allowed: true, atMs: nowMs },
      };
    },
    // A store we cannot lock is a store we cannot account against: fail closed
    // rather than authorize an unbounded send.
    () => ({ allowed: false, reason: "state_unavailable" }),
  );
}

/**
 * Records the result of a claimed send.
 *
 * `pending` is how a send reaches the user's screen at all. The brain has no
 * renderer and the desktop cannot tell whether one received its notice, so a
 * successful send is left pending either way and a renderer drains it into a
 * toast the next time one subscribes.
 */
export function completeAutoDiagnosticsSend(args: {
  filePath: string;
  failureCode: string;
  atMs: number;
  reportPath: string | null;
  reference: string | null;
  pending: boolean;
  now?: () => number;
}): void {
  const now = args.now ?? Date.now;
  const code = normalizeAutoDiagnosticsFailureCode(args.failureCode);
  if (!code) return;
  mutate<void>(
    args.filePath,
    now,
    (state) => {
      const index = state.sends.findIndex((entry) => entry.code === code && entry.atMs === args.atMs);
      if (index < 0) return { state: null, result: undefined };
      const sends = [...state.sends];
      sends[index] = {
        ...sends[index]!,
        reportPath: args.reportPath,
        reference: args.reference,
        pending: args.pending,
      };
      return { state: { ...state, sends }, result: undefined };
    },
    // Losing the annotation only costs a toast, never a duplicate send: the
    // reservation itself is already durable.
    () => undefined,
  );
}

export type AutoDiagnosticsNotice = {
  failureCode: string;
  reportPath: string | null;
  reference: string | null;
};

/** Takes the successful sends nobody has been shown yet, clearing them. */
export function drainAutoDiagnosticsNotices(
  filePath: string,
  deps: { now?: () => number } = {},
): AutoDiagnosticsNotice[] {
  const now = deps.now ?? Date.now;
  return mutate<AutoDiagnosticsNotice[]>(
    filePath,
    now,
    (state) => {
      const pending = state.sends.filter((entry) => entry.pending);
      if (pending.length === 0) return { state: null, result: [] };
      return {
        state: { ...state, sends: state.sends.map((entry) => ({ ...entry, pending: false })) },
        result: pending.map((entry) => ({
          failureCode: entry.code,
          reportPath: entry.reportPath,
          reference: entry.reference,
        })),
      };
    },
    () => [],
  );
}

/** Read-only view for tests and for the settings pane's spend line. */
export function readAutoDiagnosticsState(
  filePath: string,
  deps: { now?: () => number } = {},
): { enabled: boolean; sendsInWindow: number; limit: number } {
  const now = deps.now ?? Date.now;
  const { state } = readState(filePath);
  return {
    enabled: state.enabled,
    sendsInWindow: withinWindow(state.sends, now()).length,
    limit: MAX_AUTO_DIAGNOSTICS_PER_WINDOW,
  };
}
