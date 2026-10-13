/**
 * The `beforeSend` / `beforeBreadcrumb` / `beforeSendLog` hooks every ADE
 * process installs: drop expected noise, enforce the per-process budget, then
 * scrub. Kept free of SDK-specific types so the Electron, Node and browser SDKs
 * can all take it.
 */
import { createEventLimiter, eventBudgetKey, FATAL_SENTRY_BUDGET, isIgnoredEvent, type SentryBudget } from "./guardrails";
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubLog,
  scrubSpan,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
  type ScrubbableLog,
  type ScrubbableSpan,
} from "./scrub";

type FilterableEvent = ScrubbableEvent & Parameters<typeof eventBudgetKey>[0] & { type?: string; level?: string };

let resolveUserId: (() => string | null | undefined) | null = null;

/**
 * Where events get their pseudonymous user: the same id PostHog sends as
 * `distinct_id` (the hashed ADE account once signed in, else the install's
 * random id), so one person can be followed across both. Read at send time,
 * so sign-in and sign-out need no wiring of their own. Null when the user has
 * product analytics off; the event then carries no user.
 */
export function setSentryUserResolver(resolver: (() => string | null | undefined) | null): void {
  resolveUserId = resolver;
}

function currentUserId(): string | null {
  try {
    return resolveUserId?.() ?? null;
  } catch {
    return null;
  }
}

export function createSentryEventHooks(budget?: SentryBudget) {
  const limiter = createEventLimiter(budget);
  const fatalLimiter = createEventLimiter(FATAL_SENTRY_BUDGET);
  return {
    beforeSend<T>(event: T): T | null {
      const candidate = event as unknown as FilterableEvent;
      if (isIgnoredEvent(candidate)) return null;
      // Crashes are the most valuable thing Sentry receives, so they do not
      // compete with ordinary errors for the budget; they have their own.
      const admitted = candidate.level === "fatal"
        ? fatalLimiter.admit(eventBudgetKey(candidate))
        : limiter.admit(eventBudgetKey(candidate));
      if (!admitted) return null;
      const userId = currentUserId();
      if (userId) candidate.user = { ...(candidate.user ?? {}), id: userId };
      return scrubEvent(candidate) as unknown as T;
    },
    beforeBreadcrumb<T>(breadcrumb: T): T | null {
      const crumb = breadcrumb as unknown as ScrubbableBreadcrumb & { category?: string };
      // Console output can carry anything a library printed; ADE's own logger
      // already contributes the useful lines as `log` breadcrumbs.
      if (crumb.category === "console") return null;
      return scrubBreadcrumb(crumb) as unknown as T;
    },
    /** Spans never pass `beforeSend`; this is their only scrub. */
    beforeSendSpan<T>(span: T): T {
      return scrubSpan(span as unknown as ScrubbableSpan) as unknown as T;
    },
    beforeSendLog<T>(log: T): T | null {
      return scrubLog(log as unknown as ScrubbableLog) as unknown as T;
    },
  };
}
