/**
 * The `beforeSend` / `beforeBreadcrumb` / `beforeSendLog` hooks every ADE
 * process installs: drop expected noise, enforce the per-process budget, then
 * scrub. Kept free of SDK-specific types so the Electron, Node and browser SDKs
 * can all take it.
 */
import { expectedErrorKind } from "../expectedError";
import { applySentryDiagnostics, type DiagnosticEvent, type DiagnosticHint } from "./diagnostics";
import { createEventLimiter, eventBudgetKey, FATAL_SENTRY_BUDGET, isIgnoredEvent, type SentryBudget } from "./guardrails";
import { forwardLogToSentry } from "./logBridge";
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

type FilterableEvent = ScrubbableEvent & Parameters<typeof eventBudgetKey>[0] & DiagnosticEvent & { type?: string; level?: string };

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

/** The user `beforeSend` puts on an event; for events that skip it (User Feedback). */
export function resolveSentryUserId(): string | null {
  try {
    return resolveUserId?.() ?? null;
  } catch {
    return null;
  }
}

/** Whether the SDK caught this exception itself (an uncaught error or unhandled rejection). */
function isUnhandledException(event: unknown): boolean {
  const values = (event as { exception?: { values?: Array<{ mechanism?: { handled?: boolean } }> } })
    .exception?.values;
  return Array.isArray(values) && values.some((value) => value?.mechanism?.handled === false);
}

/**
 * A UI click names its element by a CSS path. One with no label
 * (`div.flex.min-h-0...`) says nothing a reader can act on, and enough of them
 * push the useful steps out of the 100 an event keeps.
 */
const READABLE_CLICK_TARGET = /\[(?:aria-label|title|name|alt|data-testid|placeholder)=|#[A-Za-z]/;

function isUnreadableClick(crumb: { category?: string; message?: string }): boolean {
  if (crumb.category !== "ui.click" && crumb.category !== "ui.input") return false;
  return !READABLE_CLICK_TARGET.test(crumb.message ?? "");
}

export function createSentryEventHooks(budget?: SentryBudget) {
  const limiter = createEventLimiter(budget);
  const fatalLimiter = createEventLimiter(FATAL_SENTRY_BUDGET);
  return {
    beforeSend<T>(event: T, hint?: DiagnosticHint & { originalException?: unknown }): T | null {
      const candidate = event as unknown as FilterableEvent;
      // An error its throw site marked as an answer (`shared/expectedError.ts`)
      // that someone caught and reported: a direct capture or a logged error.
      // Kept as a Sentry Log, never an issue. A crash or an unhandled
      // rejection stays: an answer nobody caught is a bug in whoever should have.
      const expected = candidate.level === "fatal" || isUnhandledException(candidate)
        ? null
        : expectedErrorKind(hint?.originalException);
      if (expected) {
        const original = hint?.originalException as { message?: unknown } | undefined;
        forwardLogToSentry("warn", "sentry.expected_error", {
          kind: expected,
          message: typeof original?.message === "string" ? original.message : null,
        });
        return null;
      }
      if (isIgnoredEvent(candidate)) return null;
      // Crashes are the most valuable thing Sentry receives, so they do not
      // compete with ordinary errors for the budget; they have their own.
      const budgetKey = eventBudgetKey(candidate);
      const admitted = candidate.level === "fatal"
        ? fatalLimiter.admit(budgetKey)
        : limiter.admit(budgetKey);
      if (!admitted) return null;
      const userId = resolveSentryUserId();
      if (userId) candidate.user = { ...(candidate.user ?? {}), id: userId };
      // A no-op outside main and the brain (`enableSentryDiagnostics`).
      applySentryDiagnostics(candidate, hint, budgetKey);
      return scrubEvent(candidate) as unknown as T;
    },
    beforeBreadcrumb<T>(breadcrumb: T): T | null {
      const crumb = breadcrumb as unknown as ScrubbableBreadcrumb & { category?: string; message?: string };
      // Console output can carry anything a library printed; ADE's own logger
      // already contributes the useful lines as `log` breadcrumbs.
      if (crumb.category === "console") return null;
      if (isUnreadableClick(crumb)) return null;
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
