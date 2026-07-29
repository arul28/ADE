import type { AdeUsageClientSurface } from "./usage";

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
  "ade_publish_failing",
  "ade_relay_suppressed",
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

const PRODUCT_ANALYTICS_SURFACES = ["desktop", "mobile", "tui", "web", "api"] as const;

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
  const surface = forcedSurface ?? value.surface;
  if (!(PRODUCT_ANALYTICS_SURFACES as readonly unknown[]).includes(surface)) {
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
      surface: surface as ProductAnalyticsSurface,
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
  /** Browser-local first-run choice is still required before collection. */
  consentRequired?: boolean;
};
