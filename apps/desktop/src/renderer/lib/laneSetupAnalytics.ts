/**
 * Lane-template setup and main-checkout package facts (`docs/logging.md`).
 * These are renderer decisions with no durable backend mutation: opening the
 * chat draft and starting install terminals happen in this window.
 *
 * Coarse and closed: never a lane, path, lockfile name, manager, folder count,
 * template id or name, machine, or error text. Each action/outcome pair has a
 * 24-hour deduplication key, so each counts at most once per installation per
 * UTC day: at most 5 accepted events a day, inside the existing
 * `ade_feature_used` 140-per-day / 30-per-minute limits. No ceiling was raised.
 */
const DAY_MS = 24 * 60 * 60_000;

export type LaneSetupAnalyticsFact =
  | { action: "template_setup_started"; outcome: "from_banner" | "from_settings" }
  | { action: "template_suggestion_hidden"; outcome: "completed" }
  | { action: "deps_update_started"; outcome: "completed" | "failed" };

/** Emit one allowlisted lane setup fact without letting analytics affect UI. */
export function captureLaneSetupAnalytics(fact: LaneSetupAnalyticsFact): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "lanes", ...fact, source: "renderer_route" },
      dedupeKey: `${fact.action}:${fact.outcome}`,
      minimumIntervalMs: DAY_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics must never change what lane setup does.
  }
}
