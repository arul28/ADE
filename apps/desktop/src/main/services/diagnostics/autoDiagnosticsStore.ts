import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
 * Plain fs with no platform branches: the mkdir lock, the atomic replace and
 * the JSON shape behave identically on Windows.
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
 * Shape the server accepts for `failureCode`, mirrored from the account
 * directory's route. Checked here so a caller that invents a code never spends
 * a send on a request the Worker will refuse.
 */
export const AUTO_DIAGNOSTICS_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

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
  /** A successful send the user has not been shown a toast for yet. */
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
 * mkdir-based mutual exclusion, same idiom as the identity/relay store.
 *
 * `mkdir` is atomic on every filesystem ADE runs on including Windows, and a
 * crashed holder is reclaimed after `LOCK_STALE_MS` rather than wedging the
 * feature forever. There is deliberately no wait-and-retry: the critical
 * section is one small file touched a handful of times a day, so genuine
 * contention means two failures fired in the same instant, and dropping one of
 * those two auto-sends is the correct outcome rather than something to queue.
 */
function acquireLock(filePath: string, now: () => number): (() => void) | null {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") return null;
      try {
        // A negative age is a clock that moved backwards after the lock was
        // taken; treating it as fresh would wedge the feature until the clock
        // caught up, so both directions past the window count as stale.
        const age = now() - fs.statSync(lockPath).mtimeMs;
        if (age <= LOCK_STALE_MS && age >= -LOCK_STALE_MS) return null;
        fs.rmdirSync(lockPath);
      } catch {
        // Released or reclaimed underneath us; one more attempt settles it.
      }
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

/** Flips the setting, preserving whatever budget has already been spent. */
export function setAutoDiagnosticsEnabled(
  filePath: string,
  enabled: boolean,
  deps: { now?: () => number } = {},
): boolean {
  const now = deps.now ?? Date.now;
  return mutate<boolean>(
    filePath,
    now,
    (state) => ({ state: { ...state, enabled }, result: enabled }),
    () => {
      // A contended store must still record a withdrawal of consent, so the
      // fallback writes the flag directly rather than dropping it.
      try {
        const current = readState(filePath).state;
        writeState(filePath, { ...current, enabled });
        return enabled;
      } catch {
        return isAutoDiagnosticsEnabled(filePath);
      }
    },
  );
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
 * `pending` is how a brain-side send reaches the user's screen: the brain has
 * no renderer, so it marks the entry pending and the desktop drains it into a
 * toast the next time a window subscribes.
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
