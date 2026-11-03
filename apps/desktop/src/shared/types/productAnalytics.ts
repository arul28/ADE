import { normalizeAdeUsageClientSurface, type AdeUsageClientSurface } from "./usage";
import type { ProductSurveyEventPayload } from "./productSurveys";

export const PRODUCT_ANALYTICS_EVENTS = [
  "ade_app_installed",
  "ade_app_opened",
  "ade_activated",
  "ade_screen_viewed",
  "ade_project_opened",
  "ade_feature_used",
  "ade_work_session_started",
  "ade_work_session_completed",
  "ade_error",
  "ade_daily_usage_summary",
  "ade_analytics_budget",
  "ade_update_install_aborted",
  "ade_update_quit_escalated",
  "ade_update_install_did_not_land",
  "ade_update_auto_applied",
  "ade_update_auto_apply_cancelled",
  "ade_update_prompted",
  "ade_brain_recovered",
  "ade_renderer_recovered",
  "ade_publish_failing",
  "ade_relay_suppressed",
  "ade_account_session_unreadable",
  "ade_tool_fetched",
  "ade_brain_action_failed",
  // PostHog's own survey events, spelled exactly as PostHog's survey results
  // read them. Main-process only (`surveyService.ts`).
  "survey shown",
  "survey dismissed",
  "survey sent",
  // PostHog's LLM-analytics event, one per settled agent turn. Main-process
  // and brain only (`agentTurnProductAnalytics.ts`); never accepted over IPC.
  "$ai_generation",
  // PostHog error tracking. A mirror of each error Sentry admitted, after its
  // budget and scrub (`exceptionProductAnalytics.ts`); never accepted over IPC.
  "$exception",
] as const;

export type ProductAnalyticsEventName = (typeof PRODUCT_ANALYTICS_EVENTS)[number];
export type ProductAnalyticsSurface = AdeUsageClientSurface;
export type ProductAnalyticsPropertyValue = string | number | boolean | null;

/**
 * Privacy-bounded product analytics input. Callers never receive a generic
 * PostHog client: every event and property is revalidated by the shared
 * service before it can leave the machine.
 */
export type ProductAnalyticsCapture = {
  event: ProductAnalyticsEventName;
  surface: ProductAnalyticsSurface;
  properties?: Record<string, ProductAnalyticsPropertyValue>;
  /** Raw local ids are accepted only here and installation-salted before send. */
  projectId?: string | null;
  sessionId?: string | null;
  /** UUID used as PostHog's insert id so retrying a persisted event is safe. */
  clientEventId?: string | null;
  occurredAt?: string | null;
  /** Local-only fingerprint; never included in the outgoing properties. */
  dedupeKey?: string | null;
  /** Local-only repeated-event suppression window. */
  minimumIntervalMs?: number | null;
  /**
   * Survey events only: the survey and validated answers, built by the main
   * process. Never read from IPC input (`parseProductAnalyticsCapture` drops it).
   */
  survey?: ProductSurveyEventPayload;
  /**
   * `$ai_generation` only: one agent turn's model, token counts, cost and
   * duration, built by the runtime. Never read from IPC input
   * (`parseProductAnalyticsCapture` drops it). No prompt, output, or tool data.
   */
  aiGeneration?: ProductAnalyticsAiGeneration;
  /** `$exception` only: built from a scrubbed Sentry event in main or the brain, never from IPC. */
  exception?: ProductAnalyticsException;
};

/** `$exception` only: one scrubbed Sentry error, reduced to what PostHog error tracking reads. */
export type ProductAnalyticsException = {
  /** Outermost first, as Sentry lists them (a cause chain). */
  exceptions: Array<{
    type: string;
    value?: string | null;
    handled?: boolean | null;
    mechanism?: string | null;
    frames?: Array<{
      filename?: string | null;
      function?: string | null;
      lineno?: number | null;
      colno?: number | null;
      inApp?: boolean | null;
      /** The bundle's Sentry debug id, which PostHog's uploaded source maps are keyed by. */
      chunkId?: string | null;
    }>;
  }>;
  level: "error" | "fatal" | "warning";
  fingerprint?: string | null;
  /** Which ADE process: main, renderer, brain. */
  process?: string | null;
};

export type ProductAnalyticsAiGeneration = {
  provider: string;
  /** The model id the runtime reported; sent only when it is a built-in catalog model. */
  model?: string | null;
  status: "completed" | "interrupted" | "failed";
  feature: "chat" | "automations";
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  reasoningTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
};

export type ProductAnalyticsCaptureResult = {
  accepted: boolean;
  reason:
    | "accepted"
    | "not_configured"
    | "disabled"
    | "invalid_event"
    | "invalid_surface"
    | "duplicate"
    | "rate_limited"
    | "daily_budget"
    | "transport_error";
};

export type ProductAnalyticsCaptureParseResult =
  | { ok: true; value: ProductAnalyticsCapture }
  | { ok: false; reason: "invalid_event" | "invalid_surface" };

/** Normalize untrusted IPC/sync input before it reaches the typed service. */
export function parseProductAnalyticsCapture(
  input: unknown,
  forcedSurface?: ProductAnalyticsSurface,
): ProductAnalyticsCaptureParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid_event" };
  }
  const value = input as Record<string, unknown>;
  if (!(PRODUCT_ANALYTICS_EVENTS as readonly unknown[]).includes(value.event)) {
    return { ok: false, reason: "invalid_event" };
  }
  const surface = normalizeAdeUsageClientSurface(forcedSurface ?? value.surface);
  if (!surface) {
    return { ok: false, reason: "invalid_surface" };
  }
  if (
    value.properties !== undefined
    && (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties))
  ) {
    return { ok: false, reason: "invalid_event" };
  }
  const optionalText = ["projectId", "sessionId", "clientEventId", "occurredAt", "dedupeKey"] as const;
  if (optionalText.some((key) => value[key] !== undefined && value[key] !== null && typeof value[key] !== "string")) {
    return { ok: false, reason: "invalid_event" };
  }
  if (
    value.minimumIntervalMs !== undefined
    && value.minimumIntervalMs !== null
    && typeof value.minimumIntervalMs !== "number"
  ) {
    return { ok: false, reason: "invalid_event" };
  }
  return {
    ok: true,
    value: {
      event: value.event as ProductAnalyticsEventName,
      surface,
      ...(value.properties === undefined
        ? {}
        : { properties: value.properties as Record<string, ProductAnalyticsPropertyValue> }),
      ...(value.projectId === undefined ? {} : { projectId: value.projectId as string | null }),
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string | null }),
      ...(value.clientEventId === undefined ? {} : { clientEventId: value.clientEventId as string | null }),
      ...(value.occurredAt === undefined ? {} : { occurredAt: value.occurredAt as string | null }),
      ...(value.dedupeKey === undefined ? {} : { dedupeKey: value.dedupeKey as string | null }),
      ...(value.minimumIntervalMs === undefined
        ? {}
        : { minimumIntervalMs: value.minimumIntervalMs as number | null }),
    },
  };
}

export type ProductAnalyticsStatus = {
  configured: boolean;
  enabled: boolean;
  effective: boolean;
  host: string;
  dailyBudget: number;
  acceptedToday: number;
  droppedToday: number;
  day: string;
};

/**
 * What this desktop window needs to record a session replay, or null while
 * analytics is off. Desktop renderer only (one IPC, not a runtime action), so
 * no other machine, the web client or the CLI ever reads it. `distinctId` is
 * the id main's events carry (the account hash once signed in, else the
 * install's anonymous id) so a recording joins the same PostHog person.
 */
export type ProductAnalyticsReplayConfig = {
  projectToken: string;
  apiHost: string;
  distinctId: string;
};
