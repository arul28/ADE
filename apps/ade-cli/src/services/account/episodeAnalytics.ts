import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";

/**
 * One event per failure episode, per day. Long enough that a machine stuck in
 * the same failure for a week reports once a day rather than once a restart.
 */
export const EPISODE_ANALYTICS_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type EpisodeAnalytics = {
  report(input: {
    dedupeValue: string | number;
    properties: ProductAnalyticsCapture["properties"];
  }): void;
  /** The condition cleared: a genuinely new episode may report again. */
  end(): void;
};

/**
 * Edge-triggered analytics for a failure EPISODE: at most one event while the
 * condition holds, re-armed only once it clears. A brain that can never read
 * the credential file the app just wrote, or that has been failing to publish
 * for minutes, publishes nothing while the user only sees "onboarding is
 * broken" — one event per episode makes that measurable without turning a
 * persistent failure into a per-attempt firehose.
 *
 * `capture` is an accessor rather than the handler itself so the owning service
 * keeps reading its (optionally late-bound) capture option at report time.
 */
export function createEpisodeAnalytics(args: {
  event: ProductAnalyticsCapture["event"];
  dedupePrefix: string;
  capture: () => ((input: ProductAnalyticsCapture) => void) | undefined;
}): EpisodeAnalytics {
  let emitted = false;
  return {
    report(input): void {
      if (emitted) return;
      emitted = true;
      args.capture()?.({
        event: args.event,
        surface: "api",
        properties: input.properties,
        dedupeKey: `${args.dedupePrefix}:${input.dedupeValue}`,
        minimumIntervalMs: EPISODE_ANALYTICS_MINIMUM_INTERVAL_MS,
      });
    },
    end(): void {
      emitted = false;
    },
  };
}
