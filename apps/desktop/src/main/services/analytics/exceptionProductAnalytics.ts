import type { SentryEventMirror, SentryMirrorEvent } from "../../../shared/sentry/eventFilter";
import type { ProductAnalyticsException, ProductAnalyticsSurface } from "../../../shared/types/productAnalytics";
import type { ProductAnalyticsService } from "./productAnalyticsService";

type ExceptionAnalytics = Pick<ProductAnalyticsService, "captureInternal">;

function mirrorLevel(level: string | undefined): ProductAnalyticsException["level"] {
  if (level === "fatal") return "fatal";
  if (level === "warning") return "warning";
  return "error";
}

/** Reduce a scrubbed Sentry event to the typed payload the analytics policy re-checks. */
export function exceptionPayloadFromSentryEvent(
  event: Readonly<SentryMirrorEvent>,
): ProductAnalyticsException | null {
  const values = event.exception?.values ?? [];
  // Each bundle's debug id, by the file the SDK recorded for it. PostHog's
  // source maps are uploaded under the same ids (scripts/posthog/
  // upload-sourcemaps.mjs), so a frame that carries one symbolicates.
  const debugIds = new Map<string, string>();
  for (const image of event.debug_meta?.images ?? []) {
    if (image?.type === "sourcemap" && image.code_file && image.debug_id) debugIds.set(image.code_file, image.debug_id);
  }
  // Sentry lists a cause chain innermost-last; PostHog reads the first entry as
  // the headline, so the outermost (what was actually thrown at the top) leads.
  const exceptions: ProductAnalyticsException["exceptions"] = [...values].reverse().map((value) => ({
    type: value.type ?? "Error",
    value: value.value ?? null,
    handled: value.mechanism?.handled ?? null,
    mechanism: value.mechanism?.type ?? null,
    frames: (value.stacktrace?.frames ?? []).map((frame) => ({
      filename: frame.filename ?? null,
      function: frame.function ?? null,
      lineno: frame.lineno ?? null,
      colno: frame.colno ?? null,
      inApp: frame.in_app ?? null,
      chunkId: debugIds.get(frame.abs_path ?? "") ?? debugIds.get(frame.filename ?? "") ?? null,
    })),
  }));
  if (exceptions.length === 0) {
    // A captured message (`captureProblem`): no stack, the scrubbed text is the value.
    if (!event.message) return null;
    exceptions.push({ type: "Problem", value: event.message, handled: true, mechanism: "capture_problem" });
  }
  const processTag = event.tags?.process;
  return {
    exceptions,
    level: mirrorLevel(event.level),
    // Only a fingerprint ADE chose (`["provider", provider, kind]`). Without
    // one, PostHog groups by the stack, which the scrubbed message and the
    // trimmed frames keep stable across machines.
    fingerprint: event.fingerprint?.length ? event.fingerprint.join("|") : null,
    // `worker:<name>` tags name a worker; the policy keeps only the kind.
    process: typeof processTag === "string" ? processTag.split(":", 1)[0] ?? null : null,
  };
}

/**
 * The mirror `setSentryEventMirror` installs in main and the brain: every error
 * Sentry admitted also goes to PostHog error tracking, joined to the same
 * distinct id as the product events, so an error can be read beside what the
 * person was doing. The analytics service drops it when analytics is off.
 */
export function createExceptionAnalyticsMirror(args: {
  analytics: ExceptionAnalytics;
  surface: ProductAnalyticsSurface;
}): SentryEventMirror {
  return (event) => {
    const exception = exceptionPayloadFromSentryEvent(event);
    if (!exception) return;
    args.analytics.captureInternal({ event: "$exception", surface: args.surface, exception });
  };
}
