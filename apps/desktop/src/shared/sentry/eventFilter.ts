/**
 * The `beforeSend` / `beforeBreadcrumb` / `beforeSendLog` hooks every ADE
 * process installs (and `tracesSampler`): drop everything from a build the
 * update gate blocks, drop expected noise, enforce the per-process budget,
 * then scrub. Kept free of SDK-specific types so the Electron, Node and browser SDKs
 * can all take it.
 */
import { isGateExemptVersion, type DesktopUpdateRequirement } from "../clientUpdateGate";
import { expectedErrorKind } from "../expectedError";
import { resolveSentryMachineId, resolveSentryUserId } from "./capture";
import { SENTRY_TRACES_SAMPLE_RATE } from "./config";
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

type FilterableEvent = ScrubbableEvent & Parameters<typeof eventBudgetKey>[0] & DiagnosticEvent & SentryMirrorEvent & { type?: string; level?: string };

// The user resolver lives in `capture.ts`; re-exported for the processes that install it here.
export { resolveSentryUserId, setSentryMachineIdResolver, setSentryUserResolver } from "./capture";

/**
 * Receives each error event `beforeSend` admitted, after the budget and the
 * scrub. Main and the brain mirror it to
 * PostHog error tracking, so PostHog sees exactly what Sentry was allowed to
 * see and never more. Must not throw or keep the event.
 */
export type SentryEventMirror = (event: Readonly<SentryMirrorEvent>) => void;

export type SentryMirrorEvent = {
  level?: string;
  /** `ade@<version>` of the build that raised it; a crash from the previous launch keeps its own. */
  release?: string;
  /** Set only where ADE named the failure (`captureError(..., { fingerprint })`). */
  fingerprint?: string[];
  message?: string;
  tags?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { handled?: boolean; type?: string };
      stacktrace?: {
        frames?: Array<{ filename?: string; abs_path?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean }>;
      };
    }>;
  };
  /**
   * The SDK moves each frame's debug id here before `beforeSend` (one image
   * per bundle, `code_file` = the frame's `abs_path` or `filename`). The ids
   * are the ones `sentry-cli sourcemaps inject` stamped into the bundles.
   */
  debug_meta?: {
    images?: Array<{ type?: string; code_file?: string; debug_id?: string }>;
  };
};

let mirrorEvent: SentryEventMirror | null = null;

export function setSentryEventMirror(mirror: SentryEventMirror | null): void {
  mirrorEvent = mirror;
}

/** What `clientUpdateGate` says about this process's own build. */
export type SentryUpdateGateReading = {
  /** The gate's `self`; null or absent while the gate has not answered. */
  requirement: Pick<DesktopUpdateRequirement, "required"> | null | undefined;
  /** This process's build version. */
  version: string | null | undefined;
};

/**
 * True when this build's own reports go nowhere: the update gate blocks it
 * (below the owner's minimum, "Update ADE to keep working" on screen), so
 * they come from a build that is already fixed. Sentry's release filter would
 * drop them at its edge, but our Sentry plan does not have it
 * (`scripts/release-tools/client-minimum.mjs`), so each build drops its own.
 * A gate that has not answered, and a build with no minimum (dev, Alpha,
 * preview), never drop.
 */
export function isBlockedBuildTelemetry(reading: SentryUpdateGateReading | null | undefined): boolean {
  return reading?.requirement?.required === true && !isGateExemptVersion(reading.version);
}

let resolveUpdateGate: (() => SentryUpdateGateReading | null | undefined) | null = null;

/**
 * Where the hooks read the update gate: set once by the process that owns
 * the gate state (main's `clientUpdateGate`, the window's store, the brain's
 * check), read at send time. While it says blocked, error events, Sentry Logs
 * and new traces are dropped. Renderer events and logs pass main's hooks, so
 * main's gate covers them; the window's own spans need the window's store.
 */
export function setSentryUpdateGateResolver(resolver: (() => SentryUpdateGateReading | null | undefined) | null): void {
  resolveUpdateGate = resolver;
}

/** A resolver that throws drops nothing. */
function isBlockedBuildNow(): boolean {
  if (!resolveUpdateGate) return false;
  try {
    return isBlockedBuildTelemetry(resolveUpdateGate());
  } catch {
    return false;
  }
}

/**
 * The one log a blocked build still sends, once per block: it is how the
 * owner sees which machines a minimum holds back.
 */
const LOGS_KEPT_WHILE_BLOCKED = new Set<string>(["client_update.required"]);

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
      if (isBlockedBuildNow()) return null;
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
      const machineId = resolveSentryMachineId();
      if (machineId) candidate.tags = { ...(candidate.tags ?? {}), machine_id: machineId };
      // A no-op outside main and the brain (`enableSentryDiagnostics`).
      applySentryDiagnostics(candidate, hint, budgetKey);
      const scrubbed = scrubEvent(candidate);
      if (mirrorEvent && (scrubbed.exception?.values?.length || scrubbed.level === "error" || scrubbed.level === "fatal")) {
        try {
          mirrorEvent(scrubbed);
        } catch {
          // The mirror is a second copy; it never costs Sentry the event.
        }
      }
      return scrubbed as unknown as T;
    },
    beforeBreadcrumb<T>(breadcrumb: T): T | null {
      const crumb = breadcrumb as unknown as ScrubbableBreadcrumb & { category?: string; message?: string };
      // Console output can carry anything a library printed; ADE's own logger
      // already contributes the useful lines as `log` breadcrumbs.
      if (crumb.category === "console") return null;
      if (isUnreadableClick(crumb)) return null;
      return scrubBreadcrumb(crumb) as unknown as T;
    },
    /**
     * Use in place of `tracesSampleRate`: a blocked build starts no trace
     * (`beforeSendSpan` cannot drop a span). Otherwise the same rate, and a
     * trace that arrives sampled stays sampled.
     */
    tracesSampler(context: { inheritOrSampleWith?: (fallbackSampleRate: number) => number }): number {
      if (isBlockedBuildNow()) return 0;
      return context.inheritOrSampleWith?.(SENTRY_TRACES_SAMPLE_RATE) ?? SENTRY_TRACES_SAMPLE_RATE;
    },
    /** Spans never pass `beforeSend`; this is their only scrub. */
    beforeSendSpan<T>(span: T): T {
      return scrubSpan(span as unknown as ScrubbableSpan) as unknown as T;
    },
    beforeSendLog<T>(log: T): T | null {
      const scrubbable = log as unknown as ScrubbableLog;
      if (isBlockedBuildNow() && !LOGS_KEPT_WHILE_BLOCKED.has(String(scrubbable.message ?? ""))) return null;
      const machineId = resolveSentryMachineId();
      if (machineId) scrubbable.attributes = { ...(scrubbable.attributes ?? {}), machine_id: machineId };
      return scrubLog(scrubbable) as unknown as T;
    },
  };
}
