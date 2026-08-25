export const CODEX_COMPACTION_STALL_MS = 180_000;
export const PINNED_CODEX_APP_SERVER_VERSION = "0.149.1";

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

export function codexServerSupportsDeferGoalContinuation(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 145);
}

/** Durable FIFO `thread/queue/*` (0.146+; ADE pins 0.149.1). */
export function codexServerSupportsThreadQueue(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

export function codexServerSupportsThreadSettings(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 146);
}

export function codexServerSupportsThreadRevert(version: CodexAppServerVersion | null): boolean {
  return codexServerAtLeast(version, 148);
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

export type { ContextCompactFailReason as CodexCompactionFailReason } from "../../../shared/contextCompaction";
export { compactionFailLabel } from "../../../shared/contextCompaction";
