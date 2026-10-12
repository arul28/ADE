/**
 * Find adoption (`docs/logging.md`): where an installation opens a find bar,
 * and whether the ⌘K "Find … in this chat" hand-off gets used. Emitted from the
 * renderer, like the Work tools pane's `tool_opened` and the dev home's facts,
 * because opening a find bar has no durable backend mutation: the bar, its
 * query and its matches live in this window.
 *
 * Coarse and closed: the outcome says where the bar opened and nothing else.
 * Never the query, the chat, the diff, a file, a lane, or a match count. The
 * outcome is a closed union, so a call site cannot widen the allowlist with
 * free text. A per-outcome 24-hour deduplication key means each outcome counts
 * at most once per installation per UTC day (a rolling 24-hour minimum can
 * never admit two accepts inside one UTC day), so the worst case is 4 accepted
 * events per installation per UTC day, inside the existing `ade_feature_used`
 * 140-per-day / 30-per-minute limits and the shared 200-event ceiling. No
 * ceiling was raised.
 */
const DAY_MS = 24 * 60 * 60_000;

export type FindOpenedOutcome = "chat_shortcut" | "chat_palette" | "chat_palette_hit" | "diff_shortcut";

/** A find bar opened. `outcome` names the surface and the way it was reached. */
export function captureFindOpened(outcome: FindOpenedOutcome): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "find", action: "find_opened", outcome, source: "renderer_route" },
      dedupeKey: `find_opened:${outcome}`,
      minimumIntervalMs: DAY_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics must never change what the find bar does.
  }
}
