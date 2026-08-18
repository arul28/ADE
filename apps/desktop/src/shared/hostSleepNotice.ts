// ---------------------------------------------------------------------------
// The transcript's account of a host that went to sleep mid-turn.
//
// A MacBook that suspends mid-turn kills the agent's in-flight API call. The
// provider SDK reports that death as a retry with cause `unknown`, and ADE used
// to print exactly that — `Claude API retry 1/10: unknown` — even though the
// main process had been told about the suspend a beat before it happened. This
// module holds the two decisions that fix it, in one dependency-free place so
// the chat service, the renderer, and their tests all agree:
//
// 1. What the single sleep chip says, and what folds two halves of it into one
//    transcript row.
// 2. When a retry failure may be blamed on the host's sleep instead of on the
//    API. This is deliberately narrow: a genuine `overloaded` or `rate_limit`
//    must keep reporting its real cause and keep its normal retry behaviour,
//    so only causes the provider itself could not name are re-attributed, and
//    only while sleep is a fact rather than a guess.
// ---------------------------------------------------------------------------

import type { MachineSleepState } from "./types/power";

/** `status` on the paused half of the chip. */
export const HOST_ASLEEP_NOTICE_STATUS = "host_asleep";
/** `status` on the resumed half, which replaces the paused half in place. */
export const HOST_AWAKE_NOTICE_STATUS = "host_awake";

/** Paused label. Sentence case, no jargon, six words at most. */
export const HOST_ASLEEP_NOTICE_MESSAGE = "Paused — computer asleep";

/**
 * How long after a wake a nameless failure may still be blamed on the sleep.
 *
 * The socket that died during the suspend is not observed as dead until
 * something touches it, which can happen a moment after the machine is back.
 * Half a minute covers that without letting a real outage minutes later inherit
 * the excuse.
 */
export const HOST_RESUME_RETRY_GRACE_MS = 30_000;

/**
 * How long an unresolved `asleep` announcement may keep excusing failures.
 *
 * `asleep` clears on a resume — an announced one, or a heartbeat gap of 60 s or
 * more. A nap SHORTER than that gap threshold whose announced resume never
 * arrived therefore leaves the state pinned `asleep` with nothing left to clear
 * it, and an unbounded read of that state turns every later `econnreset` into
 * "Paused — computer asleep" with no retry ever reported. Ten minutes matches
 * `MACHINE_SLEEP_INFERENCE_WINDOW_MS`, the window presence already uses to stop
 * believing a silence: past it, "asleep" is a claim nothing has confirmed, and
 * a real outage must be allowed to say so.
 *
 * This bound costs coverage only in the instant a machine wakes from a sleep
 * longer than the window AND its resume announcement is lost — the path the
 * resume hop's own retries exist to make vanishingly rare.
 */
export const HOST_ASLEEP_ATTRIBUTION_MAX_MS = 10 * 60_000;

/**
 * Provider retry causes that a host suspend can explain.
 *
 * Every entry is a failure the provider could not itself name — a socket that
 * stopped answering. Causes the API *did* name (`overloaded`, `rate_limit`,
 * `authentication_failed`, anything with an HTTP status) are absent on purpose:
 * those are true regardless of what the lid was doing, and re-labelling them
 * would trade one lie for another.
 */
const SUSPEND_ATTRIBUTABLE_RETRY_ERRORS = new Set([
  "unknown",
  "transient_error",
  "network_error",
  "network_failure",
  "connection_error",
  "connection_closed",
  "connection_refused",
  "connection_reset",
  "econnreset",
  "econnrefused",
  "enetdown",
  "enetunreach",
  "ehostunreach",
  "epipe",
  "etimedout",
  "socket_hang_up",
  "fetch_failed",
  "stream_error",
  "timeout",
  "request_timeout",
]);

/** Fold a raw provider cause into the shape the set above is keyed by. */
function normalizeRetryErrorCause(error: string): string {
  return error.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** True when `error` names nothing the API itself reported. */
export function isSuspendAttributableRetryError(error: string): boolean {
  const normalized = normalizeRetryErrorCause(error);
  if (!normalized) return true;
  return SUSPEND_ATTRIBUTABLE_RETRY_ERRORS.has(normalized);
}

export type HostSuspendRetryAttributionInput = {
  /** The provider's own cause string, e.g. `unknown` or `overloaded`. */
  error: string;
  /**
   * HTTP status the provider attached, when it attached one. A status means a
   * server answered, which a sleeping machine's socket cannot do — so any
   * status at all disqualifies the sleep explanation.
   */
  errorStatus?: number | null;
  /** This host's own sleep state, or null when nothing tracks it. */
  sleepState: MachineSleepState | null;
  /**
   * Epoch ms at which `sleepState` last changed, or null when unreadable.
   *
   * Required to age-bound `asleep`. An announcement with no timestamp is not
   * evidence we can bound, so it does not earn the excuse on its own — the
   * resume grace below is still free to.
   */
  sleepStateAt: number | null;
  /** Epoch ms of the last observed resume, or null if the host never slept. */
  lastResumeAt: number | null;
  now: number;
  graceMs?: number;
  /** Overrides `HOST_ASLEEP_ATTRIBUTION_MAX_MS`. Tests only. */
  asleepMaxAgeMs?: number;
};

/**
 * Whether an `asleep` announcement is recent enough to still be believed.
 *
 * A clock that puts the announcement in the future is skew, not staleness, so
 * a negative age counts as fresh — the same reading `resolveMachinePresence`
 * takes of a heartbeat from the future.
 */
function isFreshSleepAnnouncement(input: HostSuspendRetryAttributionInput): boolean {
  const announcedAt = input.sleepStateAt;
  if (typeof announcedAt !== "number" || !Number.isFinite(announcedAt)) return false;
  const maxAgeMs = input.asleepMaxAgeMs ?? HOST_ASLEEP_ATTRIBUTION_MAX_MS;
  return input.now - announcedAt <= maxAgeMs;
}

/**
 * Whether this retry should be reported as "the machine was asleep" rather than
 * as a provider failure — and therefore held rather than counted.
 */
export function shouldAttributeRetryToHostSuspend(
  input: HostSuspendRetryAttributionInput,
): boolean {
  if (typeof input.errorStatus === "number" && Number.isFinite(input.errorStatus)) return false;
  if (!isSuspendAttributableRetryError(input.error)) return false;
  if (input.sleepState === "asleep" && isFreshSleepAnnouncement(input)) return true;
  const resumedAt = input.lastResumeAt;
  if (typeof resumedAt !== "number" || !Number.isFinite(resumedAt)) return false;
  const sinceResume = input.now - resumedAt;
  if (sinceResume < 0) return false;
  const graceMs = input.graceMs ?? HOST_RESUME_RETRY_GRACE_MS;
  return sinceResume <= graceMs;
}

/**
 * A sleep's duration in the shortest honest form: `40s`, `4m`, `2h 5m`.
 * Returns null when the duration is unknown or too small to be worth a number,
 * which is what makes the resumed chip degrade to a bare "Resumed".
 */
export function formatHostPausedDuration(gapMs: number | null | undefined): string | null {
  if (typeof gapMs !== "number" || !Number.isFinite(gapMs) || gapMs < 1_000) return null;
  const totalSeconds = Math.round(gapMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Resumed label. Carries the sleep's length when we measured one. */
export function hostResumedNoticeMessage(gapMs: number | null | undefined): string {
  const paused = formatHostPausedDuration(gapMs);
  return paused ? `Resumed · paused ${paused}` : "Resumed";
}

export type HostSleepNoticeShape = {
  type: string;
  status?: string;
  detail?: unknown;
};

/** True for either half of the chip. */
export function isHostSleepNoticeEvent(event: HostSleepNoticeShape): boolean {
  return event.type === "system_notice"
    && (event.status === HOST_ASLEEP_NOTICE_STATUS || event.status === HOST_AWAKE_NOTICE_STATUS);
}

/** True only for the resumed half. */
export function isHostResumedNoticeEvent(event: HostSleepNoticeShape): boolean {
  return event.type === "system_notice" && event.status === HOST_AWAKE_NOTICE_STATUS;
}

/**
 * What makes the resumed half land on the paused half's row instead of below
 * it.
 *
 * The id-less fallback is ONE constant, so every sleep notice from a host that
 * omitted the id shares a single row — two unrelated sleeps included. That is
 * the honest trade and not an oversight: with no id there is nothing to tell
 * two sleeps apart, and a per-event key would stop a matched pause/resume pair
 * from merging at all, which is the worse of the two. Every notice ADE itself
 * emits carries a `sleepId` (`hostSleepChipTracker`), so the fallback is only
 * ever reached by a foreign or pre-`sleepId` event.
 */
export function hostSleepNoticeMergeKey(event: HostSleepNoticeShape): string {
  const detail = event.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const hostSleep = (detail as { hostSleep?: { sleepId?: unknown } }).hostSleep;
    const sleepId = hostSleep?.sleepId;
    if (typeof sleepId === "string" && sleepId.trim()) return sleepId.trim();
  }
  return "host-sleep";
}
