/**
 * Lane facts from this window (`docs/logging.md`): lane-template setup and
 * main-checkout packages (renderer decisions with no durable backend
 * mutation), and the lane settings a person chose, recorded once the save or
 * rename succeeded: the branch name pattern, where new lanes start, a branch
 * renamed, the automatic archive / free up / delete rules turned on or off,
 * and Free up space on an archived lane.
 *
 * Coarse and closed: never a lane, branch, pattern text, path, lockfile name,
 * manager, folder count, template id or name, machine, day count, or error
 * text. Each action/outcome pair has a 24-hour deduplication key, so each
 * counts at most once per installation per UTC day: at most 22 accepted events
 * a day, inside the existing `ade_feature_used` 140-per-day / 30-per-minute
 * limits. No ceiling was raised.
 */
const DAY_MS = 24 * 60 * 60_000;

export type LaneSetupAnalyticsFact =
  | { action: "template_setup_started"; outcome: "from_banner" | "from_settings" }
  | { action: "template_suggestion_hidden"; outcome: "completed" }
  | { action: "deps_update_started"; outcome: "completed" | "failed" }
  | { action: "branch_pattern_changed"; outcome: "pattern_ade" | "pattern_user" | "pattern_none" | "pattern_custom" }
  | { action: "start_default_changed"; outcome: "start_default" | "start_primary" | "start_branch" }
  | { action: "branch_renamed"; outcome: "completed" | "failed" }
  | { action: "auto_archive_changed" | "auto_free_up_changed" | "auto_delete_changed"; outcome: "enabled" | "disabled" }
  | { action: "space_freed" | "deleted_lane_restored"; outcome: "completed" | "failed" };

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
