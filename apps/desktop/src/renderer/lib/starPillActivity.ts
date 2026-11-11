import type { NudgeShowing } from "./nudgePill";

/**
 * The desktop "Star ADE on GitHub" pill's analytics. A sent message reaches
 * the pill through `nudgePillActivity.ts`.
 */

const DAY_MS = 24 * 60 * 60_000;

/**
 * The star prompt funnel (`docs/logging.md`): which showing of the pill was
 * seen, clicked, dismissed, and ended in a star. Never the GitHub account, the
 * message count, or the machine. The whole funnel is a handful of events per
 * account for its lifetime: `shown` once per showing (tracked in the synced
 * prefs), `dismissed` at most twice, `repo_starred` once, and `clicked` only
 * on a click while the pill shows. The 24-hour per-action/showing dedupe key
 * is a backstop on top, inside the existing `ade_feature_used` 140-per-day /
 * 30-per-minute limits. No ceiling was raised.
 */
export type StarPromptAnalyticsFact = {
  action: "star_prompt_shown" | "star_prompt_clicked" | "star_prompt_dismissed" | "repo_starred";
  /**
   * Which showing (`starPillShowing`). The shared type has three; the star
   * pill's schedule ends at its second dismissal, so only `prompt_first` and
   * `prompt_second` are ever sent (the analytics allowlist takes all three).
   */
  outcome: NudgeShowing;
};

/** Emit one allowlisted star prompt fact without letting analytics affect UI. */
export function captureStarPromptAnalytics(fact: StarPromptAnalyticsFact): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "star_prompt", ...fact, source: "renderer_route" },
      dedupeKey: `${fact.action}:${fact.outcome}`,
      minimumIntervalMs: DAY_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics must never change what the pill does.
  }
}
