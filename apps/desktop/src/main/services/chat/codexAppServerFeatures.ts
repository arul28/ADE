export const CODEX_COMPACTION_STALL_MS = 180_000;
export const PINNED_CODEX_APP_SERVER_VERSION = "0.164.0";

export type CodexAppServerVersion = {
  major: number;
  minor: number;
  patch: number;
};

export function codexServerAtLeast(
  version: CodexAppServerVersion | null,
  minMinor: number,
): boolean {
  if (!version) return false;
  if (version.major > 0) return true;
  return version.minor >= minMinor;
}

/** `thread/fork` `beforeTurnId` + `excludeTurns` + paginated history (0.145). */
export function codexServerSupportsPaginatedHistory(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 145);
}

/** `thread/fork` with `beforeTurnId`: a fork that leaves out a running turn (0.145). */
export function codexServerSupportsForkBeforeTurn(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 145);
}

export function codexServerSupportsDeferGoalContinuation(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 145);
}

/** Durable FIFO `thread/queue/*` (0.146+). */
export function codexServerSupportsThreadQueue(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

export function codexServerSupportsThreadSettings(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

export function codexServerSupportsThreadRevert(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 148);
}

/**
 * `thread/rollback` was removed in 0.156 (openai/codex#44915); revert and fork
 * replace it. An unknown version may still have it, so the caller tries it and
 * turns a method-not-found answer into a clear error.
 */
export function codexServerSupportsThreadRollback(version: CodexAppServerVersion | null): boolean {
  return !codexServerAtLeast(version, 156);
}

export function codexServerSupportsBackgroundTerminals(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

export function codexServerSupportsUserShell(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

export function codexServerSupportsMemoryRpc(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

/**
 * `thread/goal/set` / `thread/goal/clear` `origin` (0.162+), which records
 * whether a person or the harness mutated the goal.
 *
 * The server documents a missing provenance as "supplies no user
 * authorization", so a goal the user typed must say so or codex will not treat
 * it as theirs. The field is omitted on anything older — an unknown version
 * included — which leaves those servers exactly as they behave today.
 */
export function codexServerSupportsGoalMutationOrigin(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 162);
}

/**
 * Experimental `thread/sample` (0.164+): one model answer on a hidden,
 * ephemeral fork of an idle thread, reusing its context and prompt cache. The
 * source conversation is never changed. An unknown version never gets it.
 */
export function codexServerSupportsThreadSample(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 164);
}

export type { ContextCompactFailReason as CodexCompactionFailReason } from "../../../shared/contextCompaction";
