import { createHash } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { AdeUsageClientSurface } from "../../../shared/types";
import type { ProductAnalyticsService } from "./productAnalyticsService";

const DEFAULT_INITIAL_DELAY_MS = 45_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BACKLOG_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type PendingUsageEvent = {
  id: string;
  project_id: string;
  client_surface: string;
  action: string;
  feature: string;
  session_id: string | null;
  occurred_at: string;
};

type UsageProductAnalyticsExporterArgs = {
  db: AdeDb;
  analytics: ProductAnalyticsService;
  logger: Pick<Logger, "debug">;
  initialDelayMs?: number;
  intervalMs?: number;
  batchSize?: number;
  now?: () => number;
};

function isUsageSurface(value: string): value is AdeUsageClientSurface {
  return ["desktop", "mobile", "tui", "web", "api"].includes(value);
}

function derivedEventId(baseId: string, suffix: string): string {
  const chars = createHash("sha256").update(`${baseId}:${suffix}`).digest("hex").slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sessionStart(action: string): {
  event: "ade_work_session_started";
  feature: "chat" | "cli";
} | null {
  if (action === "chat.create" || action === "chat.launch") {
    return { event: "ade_work_session_started", feature: "chat" };
  }
  if (action === "work.startCliSession" || action === "work.importExternalSession") {
    return { event: "ade_work_session_started", feature: "cli" };
  }
  return null;
}

function canonicalFeature(action: string): string {
  const prefix = action.split(".", 1)[0] ?? "other";
  return ["chat", "work", "lanes", "files", "git", "orchestration", "prs", "automations"]
    .includes(prefix)
    ? prefix
    : "other";
}

const FINAL_DROP_REASONS = new Set([
  "duplicate",
  "rate_limited",
  "daily_budget",
  "invalid_event",
  "invalid_surface",
  "transport_error",
]);

export function createUsageProductAnalyticsExporter(args: UsageProductAnalyticsExporterArgs) {
  const now = args.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(100, Math.floor(args.batchSize ?? DEFAULT_BATCH_SIZE)));
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<number> | null = null;
  let stopped = false;

  const markExpired = (): void => {
    const cutoff = new Date(now() - MAX_BACKLOG_AGE_MS).toISOString();
    args.db.run(
      `update usage_events
          set analytics_exported_at = 'expired'
        where analytics_exported_at is null
          and occurred_at < ?`,
      [cutoff],
    );
  };

  const suppressBeforeConsent = (consentSince: string): void => {
    args.db.run(
      `update usage_events
          set analytics_exported_at = 'suppressed:opt_out'
        where analytics_exported_at is null
          and occurred_at < ?`,
      [consentSince],
    );
  };

  const readPending = (consentSince: string): PendingUsageEvent[] => args.db.all<PendingUsageEvent>(
    `select id, project_id, client_surface, action, feature, session_id, occurred_at
       from usage_events
      where analytics_exported_at is null
        and occurred_at >= ?
      order by occurred_at asc, id asc
      limit ?`,
    [consentSince, batchSize],
  );

  const markExported = (ids: string[], value?: string): void => {
    if (ids.length === 0) return;
    const exportedAt = value ?? new Date(now()).toISOString();
    for (const id of ids) {
      args.db.run(
        "update usage_events set analytics_exported_at = ? where id = ? and analytics_exported_at is null",
        [exportedAt, id],
      );
    }
  };

  const execute = async (): Promise<number> => {
    if (stopped) return 0;
    const consentSince = args.analytics.getExportConsentSince();
    if (!consentSince) return 0;
    markExpired();
    suppressBeforeConsent(consentSince);
    const rows = readPending(consentSince);
    if (rows.length === 0) return 0;
    const accepted: string[] = [];
    const suppressed: Array<{ id: string; reason: string }> = [];
    for (const row of rows) {
      if (!isUsageSurface(row.client_surface)) {
        suppressed.push({ id: row.id, reason: "invalid_surface" });
        continue;
      }
      const results = [args.analytics.capture({
        event: "ade_feature_used",
        surface: row.client_surface,
        projectId: row.project_id,
        sessionId: row.session_id,
        clientEventId: row.id,
        occurredAt: row.occurred_at,
        properties: {
          feature: canonicalFeature(row.action),
          action: row.action,
          outcome: "success",
          source: "mutation",
        },
      })];
      const started = sessionStart(row.action);
      if (started) {
        results.push(args.analytics.captureInternal({
          event: started.event,
          surface: row.client_surface,
          projectId: row.project_id,
          sessionId: row.session_id,
          clientEventId: derivedEventId(row.id, started.event),
          occurredAt: row.occurred_at,
          properties: {
            feature: started.feature,
            action: row.action,
            outcome: "started",
            source: "mutation",
          },
        }));
      }
      if (results.some((result) => result.accepted)) {
        accepted.push(row.id);
        continue;
      }
      const finalReason = results.find((result) => FINAL_DROP_REASONS.has(result.reason))?.reason;
      if (finalReason) suppressed.push({ id: row.id, reason: finalReason });
    }
    for (const row of suppressed) markExported([row.id], `suppressed:${row.reason}`);
    if (accepted.length > 0) {
      // This pipeline is deliberately at-most-once locally. The shared client
      // already performs one bounded, UUID-idempotent transport retry; keeping
      // a row pending after a network failure would spend the hard local quota
      // again on every exporter pass and could suppress newer user activity.
      markExported(accepted);
      await args.analytics.flush();
    }
    return accepted.length;
  };

  const runOnce = (): Promise<number> => {
    if (inFlight) return inFlight;
    const current = execute()
      .catch((error) => {
        args.logger.debug("product_analytics.usage_export_failed", {
          errorKind: error instanceof Error ? error.name : "unknown",
        });
        return 0;
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  const start = (): void => {
    if (stopped || initialTimer || intervalTimer) return;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      void runOnce();
      if (stopped || intervalTimer) return;
      intervalTimer = setInterval(() => void runOnce(), Math.max(60_000, args.intervalMs ?? DEFAULT_INTERVAL_MS));
      intervalTimer.unref?.();
    }, Math.max(1_000, args.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS));
    initialTimer.unref?.();
  };

  const stop = (): void => {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  };

  return { start, stop, runOnce };
}

export type UsageProductAnalyticsExporter = ReturnType<typeof createUsageProductAnalyticsExporter>;
