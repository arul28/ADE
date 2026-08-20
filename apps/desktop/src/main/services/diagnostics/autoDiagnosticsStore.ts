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
 * At most this many MANUAL reports per window, per install.
 *
 * Deliberately the same number as `MAX_DIAGNOSTIC_UPLOADS_PER_DAY` in
 * `apps/account-directory/src/diagnostics.ts`, the server's per-identity daily
 * quota. That is the point: this guard exists so a person leaning on the button
 * gets one honest sentence instead of a server refusal, and matching the
 * server's number means it never refuses a report the user was still entitled
 * to send. The server stays the authority — its quota counts stored objects,
 * keyed on the caller address, and this cannot weaken it.
 *
 * More generous than the automatic budget (3 a day, one per failure class), and
 * for a plain reason: an automatic send is one nobody chose, so its ceiling is a
 * promise about what the computer does on its own. A manual send is a person
 * asking for help about a report they can read first.
 */
export const MAX_MANUAL_DIAGNOSTICS_PER_WINDOW = 5;

/**
 * The ledger code every manual send is filed under.
 *
 * Manual sends have no failure class to dedupe on — the whole point is that
 * nothing classified itself — so they share one code and are bounded only by
 * the window total above.
 */
export const MANUAL_DIAGNOSTICS_FAILURE_CODE = "user_requested";

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

/**
 * Who decided to send: ADE, or the person using it.
 *
 * TWO BUDGETS, ONE FILE. They are counted apart on purpose and neither can
 * borrow from the other: a user pressing "Send a report" must not use up the
 * automatic reports that explain the crash they are reporting, and a machine in
 * a crash loop that has burned its three automatic sends must not lock the user
 * out of asking for help. Sharing the file is still right — the lock, the
 * window and the retention cap are one mechanism — but the counters are not.
 *
 * Absent in entries written before manual sends existed, and those were all
 * automatic, so the default is `auto`.
 */
export type AutoDiagnosticsKind = "auto" | "manual";

/** One spent send. Codes and timestamps only — never a report or its text. */
export type AutoDiagnosticsSend = {
  code: string;
  atMs: number;
  source: AutoDiagnosticsSource;
  kind: AutoDiagnosticsKind;
  /** Local path of the saved `.md`, so the toast's "View" can reveal it. */
  reportPath: string | null;
  /** Short upload handle, present once the upload succeeded. */
  reference: string | null;
  /**
   * A successful send no renderer has acknowledged RENDERING yet.
   *
   * Set on EVERY successful send, including one made while a window was open:
   * `webContents.send` does not throw when the receiving renderer has crashed
   * or has not mounted its toast host, so nothing on the sending side can know
   * the user was shown anything. What clears it is the renderer saying so, once
   * the toast exists (`ackAutoDiagnosticsNotices`). A renderer that dies between
   * rendering and acknowledging costs one repeated toast, which is the honest
   * side of the trade: the alternative is a send the user never hears about.
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
    kind: record.kind === "manual" ? "manual" : "auto",
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
 * The patient variant, for the one caller that must not give up early: ~1s of
 * total wait, still bounded. See `setAutoDiagnosticsEnabled`.
 */
const LOCK_PATIENT_RETRY_ATTEMPTS = 50;

/**
 * mkdir-based mutual exclusion, same idiom as the identity/relay store.
 *
 * `mkdir` is atomic on every filesystem ADE runs on, and a crashed holder is
 * reclaimed after `LOCK_STALE_MS` rather than wedging the feature forever.
 *
 * The default wait is deliberately tiny — five tries, 20ms apart, so at most
 * ~100ms of blocking PER ACQUIRE. The critical section is one small file
 * rewritten a handful of times a day, so a contended lock is nearly always the
 * other process finishing its own write microseconds from now; a spin that
 * short converts almost every collision into a success while still refusing to
 * queue. Callers keep their fail-closed fallbacks for the case it does not:
 * giving up on a claim is the correct outcome, and losing a consent flip is not
 * (see `setAutoDiagnosticsEnabled`, which is why `attempts` exists).
 */
function acquireLock(
  filePath: string,
  now: () => number,
  attempts: number = LOCK_RETRY_ATTEMPTS,
): (() => void) | null {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
      if (!reclaimed && attempt < attempts - 1) sleepSync(LOCK_RETRY_MS);
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
  lockAttempts: number = LOCK_RETRY_ATTEMPTS,
): T {
  const release = acquireLock(filePath, now, lockAttempts);
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
 * Four attempts, weakest third. The lock's own short spin absorbs ordinary
 * contention; a patient retry (~1s) absorbs a holder that is slow rather than
 * gone; only past that does the unlocked write run, because dropping a
 * withdrawal of consent is worse than the narrow race that write carries.
 */
export function setAutoDiagnosticsEnabled(
  filePath: string,
  enabled: boolean,
  deps: { now?: () => number } = {},
): boolean {
  const now = deps.now ?? Date.now;

  /** The correct path. `null` means the lock never came free. */
  const writeUnderLock = (attempts?: number): boolean | null =>
    mutate<boolean | null>(
      filePath,
      now,
      (state) => ({ state: { ...state, enabled }, result: enabled }),
      () => null,
      attempts,
    );

  const sendsFingerprint = (state: AutoDiagnosticsState): string => JSON.stringify(state.sends);

  /**
   * The same read-modify-write with no lock held, which can clobber a
   * concurrent ledger write.
   *
   * So it refuses to run into one it can SEE: the ledger is read twice and the
   * replace is abandoned if it moved in between. That does not make the write
   * safe. A holder still mid-write — one that has read but not yet replaced —
   * is invisible to both reads and gets clobbered by this one, which is exactly
   * the case that got us here, since reaching this line means a holder has
   * already outlived ~1.1s of waiting. What bounds the damage is what the ledger
   * holds: at worst one send's entry is lost, costing a repeated toast or one
   * extra send against the day's budget, while the consent flip itself — the
   * thing the user is waiting on — still lands. An abandoned attempt also still
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

  // Worst case is ~1.2s of synchronous blocking on this call: ~100ms for the
  // ordinary acquire, ~1s for the patient one, ~100ms for the final retry. That
  // is a user-initiated toggle contending with a process that will not let go,
  // so waiting a beat is better than persisting the wrong answer — and every
  // wait here is bounded, none of them queue.
  const persisted =
    writeUnderLock()
    ?? writeUnderLock(LOCK_PATIENT_RETRY_ATTEMPTS)
    ?? writeWithoutLock()
    ?? writeUnderLock();
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
      // Only automatic entries count against the automatic budget; a user who
      // pressed "Send a report" has not spent any of it.
      const automatic = recent.filter((entry) => entry.kind === "auto");
      if (automatic.filter((entry) => entry.code === code).length >= MAX_AUTO_DIAGNOSTICS_PER_CODE) {
        return { state: null, result: { allowed: false, reason: "code_limit" } };
      }
      if (automatic.length >= MAX_AUTO_DIAGNOSTICS_PER_WINDOW) {
        return { state: null, result: { allowed: false, reason: "daily_limit" } };
      }
      const entry: AutoDiagnosticsSend = {
        code,
        atMs: nowMs,
        source: args.source,
        kind: "auto",
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
 * Reserves one MANUAL send, or explains why there is none to reserve.
 *
 * Same shape and the same fail-closed rules as the automatic claim, counting a
 * separate budget (see `AutoDiagnosticsKind`). Two differences, both deliberate:
 *
 *   - No consent check. The setting governs reports ADE sends BY ITSELF; a
 *     person pressing a button is not that, and refusing them would leave a
 *     user who turned off background reporting with no way to ask for help.
 *     The surface that offers the button says so plainly instead.
 *   - No per-code limit. Manual sends have no failure class to dedupe on.
 */
export function claimManualDiagnosticsSend(args: {
  filePath: string;
  source: AutoDiagnosticsSource;
  now?: () => number;
}): AutoDiagnosticsClaim {
  const now = args.now ?? Date.now;
  return mutate<AutoDiagnosticsClaim>(
    args.filePath,
    now,
    (state, readable) => {
      if (!readable) {
        return { state: null, result: { allowed: false, reason: "state_unavailable" } };
      }
      const nowMs = now();
      const recent = withinWindow(state.sends, nowMs);
      if (recent.filter((entry) => entry.kind === "manual").length >= MAX_MANUAL_DIAGNOSTICS_PER_WINDOW) {
        return { state: null, result: { allowed: false, reason: "daily_limit" } };
      }
      // A reservation is identified by (code, atMs, kind) — that triple is what
      // `completeAutoDiagnosticsSend` finds its entry by. Automatic sends are
      // unique in it by construction, since at most one per code exists in a
      // window. Manual ones are not: they ALL carry `user_requested`, so two
      // claimed in the same millisecond would be indistinguishable, and the
      // second completion would land on the first one's entry — overwriting its
      // path and reference and leaving its own blank. Stepping past a collision
      // costs nothing against a 24-hour window and keeps every reservation
      // individually completable.
      let atMs = nowMs;
      while (recent.some((entry) =>
        entry.kind === "manual"
        && entry.code === MANUAL_DIAGNOSTICS_FAILURE_CODE
        && entry.atMs === atMs)
      ) {
        atMs += 1;
      }
      const entry: AutoDiagnosticsSend = {
        code: MANUAL_DIAGNOSTICS_FAILURE_CODE,
        atMs,
        source: args.source,
        kind: "manual",
        reportPath: null,
        reference: null,
        pending: false,
      };
      return {
        state: { ...state, sends: [...recent, entry].slice(-MAX_RETAINED_SENDS) },
        result: { allowed: true, atMs },
      };
    },
    () => ({ allowed: false, reason: "state_unavailable" }),
  );
}

/**
 * Records the result of a claimed send.
 *
 * The reservation is found by (code, atMs, kind) — the triple both claims mint
 * uniquely, the automatic one because a code gets a single slot per window and
 * the manual one because it steps past a timestamp already taken. Nothing here
 * can restore that uniqueness after the fact, which is why it is established
 * where the entry is written rather than guessed at here.
 *
 * `pending` is how a send reaches the user's screen at all. The brain has no
 * renderer and the desktop cannot tell whether one received its notice, so a
 * successful send is left pending either way, offered to the next renderer that
 * subscribes, and cleared only when one acknowledges having toasted it.
 *
 * Which is why `pending` REQUIRES a reference here rather than trusting the
 * caller for it. The only thing that clears the flag is an ack naming the
 * upload, so a pending entry with no reference could never be retired: it would
 * be replayed to every renderer on every launch, forever. Both senders today
 * only set `pending` alongside a successful upload (which always carries one),
 * so this costs nothing and closes the trap for the next one.
 */
export function completeAutoDiagnosticsSend(args: {
  filePath: string;
  failureCode: string;
  atMs: number;
  reportPath: string | null;
  reference: string | null;
  pending: boolean;
  /** Which budget the reservation came out of. Defaults to the automatic one. */
  kind?: AutoDiagnosticsKind;
  now?: () => number;
}): void {
  const now = args.now ?? Date.now;
  const code = normalizeAutoDiagnosticsFailureCode(args.failureCode);
  if (!code) return;
  const kind = args.kind ?? "auto";
  const reference = args.reference?.trim() || null;
  const pending = args.pending && reference != null;
  mutate<void>(
    args.filePath,
    now,
    (state) => {
      const index = state.sends.findIndex((entry) =>
        entry.code === code && entry.atMs === args.atMs && entry.kind === kind);
      if (index < 0) return { state: null, result: undefined };
      const sends = [...state.sends];
      sends[index] = {
        ...sends[index]!,
        reportPath: args.reportPath,
        reference,
        pending,
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

/**
 * The successful sends nobody has been shown yet.
 *
 * Read-only ON PURPOSE. Handing a notice to a renderer is not the same as the
 * user seeing it — the window can go away, or never mount its toast host,
 * between the two — so listing retires nothing. `ackAutoDiagnosticsNotices` is
 * the only thing that clears `pending`, and it is called after the toast exists.
 */
export function listPendingAutoDiagnosticsNotices(filePath: string): AutoDiagnosticsNotice[] {
  return readState(filePath).state.sends
    .filter((entry) => entry.pending)
    .map((entry) => ({
      failureCode: entry.code,
      reportPath: entry.reportPath,
      reference: entry.reference,
    }));
}

/**
 * Retires the notices a renderer has actually put on screen.
 *
 * Matched by upload reference, which every pending entry has: `pending` is only
 * ever set alongside a successful upload, and a successful upload always
 * carries one. Unknown or already-cleared references are a no-op, so two
 * windows that both toasted the same send can both acknowledge it, in any
 * order, without the second one being an error.
 *
 * A lock we cannot take simply leaves the entry pending: repeating a toast once
 * is the cheap failure, and it is the one this direction chooses.
 */
export function ackAutoDiagnosticsNotices(
  filePath: string,
  references: readonly string[],
  deps: { now?: () => number } = {},
): void {
  const now = deps.now ?? Date.now;
  const wanted = new Set(
    references.map((reference) => reference?.trim()).filter((reference): reference is string => !!reference),
  );
  if (wanted.size === 0) return;
  mutate<void>(
    filePath,
    now,
    (state) => {
      if (!state.sends.some((entry) => entry.pending && entry.reference && wanted.has(entry.reference))) {
        return { state: null, result: undefined };
      }
      return {
        state: {
          ...state,
          sends: state.sends.map((entry) =>
            entry.pending && entry.reference && wanted.has(entry.reference)
              ? { ...entry, pending: false }
              : entry,
          ),
        },
        result: undefined,
      };
    },
    () => undefined,
  );
}

/**
 * Read-only view for tests and for the settings pane's spend line.
 *
 * `sendsInWindow` counts AUTOMATIC sends only, because that is the number the
 * pane's footnote is about ("at most three a day, one per problem"). Manual
 * sends are reported separately for the same reason they are counted
 * separately.
 */
export function readAutoDiagnosticsState(
  filePath: string,
  deps: { now?: () => number } = {},
): {
  enabled: boolean;
  sendsInWindow: number;
  limit: number;
  manualSendsInWindow: number;
  manualLimit: number;
} {
  const now = deps.now ?? Date.now;
  const { state } = readState(filePath);
  const recent = withinWindow(state.sends, now());
  return {
    enabled: state.enabled,
    sendsInWindow: recent.filter((entry) => entry.kind === "auto").length,
    limit: MAX_AUTO_DIAGNOSTICS_PER_WINDOW,
    manualSendsInWindow: recent.filter((entry) => entry.kind === "manual").length,
    manualLimit: MAX_MANUAL_DIAGNOSTICS_PER_WINDOW,
  };
}
