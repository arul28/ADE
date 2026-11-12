/**
 * Built-in browser adoption (`docs/logging.md`): whether an installation keeps
 * agents' tabs, and whether it watches or drives tabs on another machine.
 * Emitted from the renderer, like find's `find_opened`, because these are a
 * person's clicks in this window; keeping by clicking in the page is decided
 * in the main process and is not counted.
 *
 * Coarse and closed: the action names the decision and nothing else. Never
 * the URL, the title, the tab, the chat, the lane or the machine. A per-action
 * 24-hour deduplication key admits each action at most once per installation
 * per UTC day, so the worst case is 3 events per installation per day, inside
 * the existing `ade_feature_used` 140-per-day / 30-per-minute limits. No
 * ceiling was raised.
 */
const DAY_MS = 24 * 60 * 60_000;

export type BrowserFact = "tab_kept" | "remote_tab_watched" | "remote_tab_controlled";

export function captureBrowserFact(action: BrowserFact): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: { feature: "browser", action, outcome: "completed", source: "renderer_route" },
      dedupeKey: `browser:${action}`,
      minimumIntervalMs: DAY_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics must never change what the browser does.
  }
}
