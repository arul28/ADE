import type { HomeWidgetType } from "./homeLayout";

/**
 * The dev home's adoption facts (`docs/logging.md`): which machine-level top
 * tab an installation opens and which home widgets it adds. Emitted from the
 * renderer, like the Work tools pane's `tool_opened`, because neither choice
 * has a durable backend mutation: the tab strip and the layout live in this
 * window.
 *
 * Coarse and closed: the tab or widget type and nothing else. Never a URL, a
 * tab, a song, a layout, a preset name, or a widget's settings. A per-value
 * 24-hour deduplication key holds this to at most one accepted event per tab
 * and per widget type per installation per UTC day (15 in all), inside the
 * existing `ade_feature_used` 140-per-day / 30-per-minute limits and the
 * shared 200-event ceiling. No ceiling was raised.
 */
const DAY_MS = 24 * 60 * 60_000;

function capture(action: "tab_opened" | "widget_added", outcome: string): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: { feature: "home", action, outcome, source: "renderer_route" },
    dedupeKey: `home_${action}:${outcome}`,
    minimumIntervalMs: DAY_MS,
  }).catch(() => undefined);
}

/** The Browser or Music top tab joined the tab strip. */
export function captureHomeTabOpened(tab: "browser" | "music"): void {
  capture("tab_opened", `tab_${tab}`);
}

/** A widget was added to the home page. */
export function captureHomeWidgetAdded(type: HomeWidgetType): void {
  capture("widget_added", `widget_${type.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`);
}
