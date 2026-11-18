/**
 * Where an account is in ADE's onboarding, as one account setting, so the
 * desktop, ADE Web and every other computer agree: a tour done or skipped on
 * one is done everywhere, a tip already offered is not offered again, and one
 * "last unasked showing" time paces What's new, tip cards and surveys across
 * all of them.
 *
 * The value only moves forward. Two copies combine field by field (the later
 * time wins, sets join), so a merge never brings a finished tour back. The one
 * way back is "Show me around again": it sets `resetAt`, and every tour and
 * hint answer from before it no longer counts, on any copy.
 */

/** Account-wide (`ACCOUNT_SCOPE_ALL`) key of the record. */
export const ONBOARDING_PROGRESS_SETTING_KEY = "onboarding.progress";

export type OnboardingHintAnswer = { doneAt?: number; dismissedAt?: number };

export type OnboardingProgressRecord = {
  /** "Show me around again": tour and hint answers before this no longer count. */
  resetAt?: number;
  /** Onboarding began (a welcome card ran). */
  startedAt?: number;
  /** "Skip" on the tour: no tour or hints after it. */
  skippedAt?: number;
  /** The tour's finish card was closed. */
  tourDoneAt?: number;
  hints?: Record<string, OnboardingHintAnswer>;
  /** ADE Tips ids offered as a card or tried: never offered as a card again. */
  tipsDone?: string[];
  /** The last time anything showed that the person did not ask for (What's new, a tip card, a survey, a suggestion). */
  lastUnaskedAt?: number;
};

const MAX_TIPS = 300;
const MAX_HINTS = 50;
const MAX_ID_LENGTH = 128;
/** Before ADE had onboarding; an earlier time is not one this wrote. */
const EARLIEST_MS = Date.UTC(2024, 0, 1);

function validTime(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // A clock a little ahead is fine; a time far in the future would pin a field forever.
  if (value < EARLIEST_MS || value > now + 24 * 3_600_000) return undefined;
  return value;
}

function validId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

/** A hint answer with the times it holds; undefined when it holds none. */
function hintAnswer(doneAt: number | undefined, dismissedAt: number | undefined): OnboardingHintAnswer | undefined {
  if (doneAt === undefined && dismissedAt === undefined) return undefined;
  return {
    ...(doneAt !== undefined ? { doneAt } : {}),
    ...(dismissedAt !== undefined ? { dismissedAt } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The valid part of a stored or remote value. */
export function normalizeOnboardingProgressRecord(value: unknown, now = Date.now()): OnboardingProgressRecord {
  const raw = asRecord(value);
  if (!raw) return {};
  const out: OnboardingProgressRecord = {};
  for (const field of ["resetAt", "startedAt", "skippedAt", "tourDoneAt", "lastUnaskedAt"] as const) {
    const at = validTime(raw[field], now);
    if (at !== undefined) out[field] = at;
  }
  const hints: Record<string, OnboardingHintAnswer> = {};
  let hintCount = 0;
  for (const [id, entry] of Object.entries(asRecord(raw.hints) ?? {})) {
    if (hintCount >= MAX_HINTS) break;
    const answer = asRecord(entry);
    if (!validId(id) || !answer) continue;
    const kept = hintAnswer(validTime(answer.doneAt, now), validTime(answer.dismissedAt, now));
    if (!kept) continue;
    hints[id] = kept;
    hintCount += 1;
  }
  if (hintCount) out.hints = hints;
  if (Array.isArray(raw.tipsDone)) {
    const tips = [...new Set(raw.tipsDone.filter(validId))].slice(0, MAX_TIPS);
    if (tips.length) out.tipsDone = tips;
  }
  return dropBeforeReset(out);
}

const later = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);
const earlier = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/** Tour and hint answers from before the last "Show me around again" no longer count. */
function dropBeforeReset(value: OnboardingProgressRecord): OnboardingProgressRecord {
  const { resetAt } = value;
  if (resetAt === undefined) return value;
  const keep = (at: number | undefined) => (at !== undefined && at >= resetAt ? at : undefined);
  const out: OnboardingProgressRecord = { ...value };
  out.startedAt = keep(out.startedAt);
  out.skippedAt = keep(out.skippedAt);
  out.tourDoneAt = keep(out.tourDoneAt);
  if (out.hints) {
    const hints: Record<string, OnboardingHintAnswer> = {};
    for (const [id, answer] of Object.entries(out.hints)) {
      const kept = hintAnswer(keep(answer.doneAt), keep(answer.dismissedAt));
      if (kept) hints[id] = kept;
    }
    out.hints = Object.keys(hints).length ? hints : undefined;
  }
  return compact(out);
}

function compact(value: OnboardingProgressRecord): OnboardingProgressRecord {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as OnboardingProgressRecord;
}

/**
 * Both copies in one: the later time for every answer, the earlier start,
 * every tip from either, and then nothing from before the later reset.
 * `left`'s tips come first, so a merge never pushes out one it holds.
 */
export function mergeOnboardingProgressRecords(
  left: OnboardingProgressRecord,
  right: OnboardingProgressRecord,
): OnboardingProgressRecord {
  const hints: Record<string, OnboardingHintAnswer> = { ...left.hints };
  for (const [id, answer] of Object.entries(right.hints ?? {})) {
    const current = hints[id];
    if (!current && Object.keys(hints).length >= MAX_HINTS) continue;
    const merged = hintAnswer(later(current?.doneAt, answer.doneAt), later(current?.dismissedAt, answer.dismissedAt));
    if (merged) hints[id] = merged;
  }
  const tips = [...new Set([...(left.tipsDone ?? []), ...(right.tipsDone ?? [])])].slice(0, MAX_TIPS);
  const resetAt = later(left.resetAt, right.resetAt);
  // The earlier start, of the starts that still count: one from before the reset would be dropped.
  const counts = (at: number | undefined) => (at !== undefined && (resetAt === undefined || at >= resetAt) ? at : undefined);
  return dropBeforeReset(compact({
    resetAt,
    startedAt: earlier(counts(left.startedAt), counts(right.startedAt)),
    skippedAt: later(left.skippedAt, right.skippedAt),
    tourDoneAt: later(left.tourDoneAt, right.tourDoneAt),
    hints: Object.keys(hints).length ? hints : undefined,
    tipsDone: tips.length ? tips : undefined,
    lastUnaskedAt: later(left.lastUnaskedAt, right.lastUnaskedAt),
  }));
}

function canonical(value: OnboardingProgressRecord): string {
  const hints = value.hints
    ? Object.fromEntries(Object.entries(value.hints).sort(([a], [b]) => a.localeCompare(b)))
    : undefined;
  return JSON.stringify({
    resetAt: value.resetAt,
    startedAt: value.startedAt,
    skippedAt: value.skippedAt,
    tourDoneAt: value.tourDoneAt,
    hints,
    tipsDone: value.tipsDone ? [...value.tipsDone].sort() : undefined,
    lastUnaskedAt: value.lastUnaskedAt,
  });
}

/** Whether two copies hold the same answers (tip order aside). */
export function sameOnboardingProgressRecord(a: OnboardingProgressRecord, b: OnboardingProgressRecord): boolean {
  return canonical(a) === canonical(b);
}
