/**
 * What a plugin's search provider hands back, and how little of it is trusted.
 *
 * A `searchProviders` declaration (see `./manifest.ts`) buys a plugin one thing:
 * its action is invoked live, on a debounced keystroke, while someone is typing
 * in ⌘K. The answer is arbitrary JSON from another process, arriving on the one
 * surface in ADE where a thrown error or a runaway string is most expensive —
 * the palette is what a user reaches for when they are already lost, so it must
 * never be the thing that breaks. Every value below is therefore read the way
 * `readPluginActionNavigation` reads a navigate verb: recognized fields are
 * copied out, everything else is dropped, and an unreadable row is skipped
 * rather than surfaced as a failure.
 *
 * Lives in `shared/` rather than beside the renderer hook that consumes it for
 * one reason: this is a WIRE contract, not a rendering decision. The desktop
 * palette is the first client, and the `search.*` action domain, the `ade
 * search` CLI and iOS all reach the same providers through the same
 * `plugin.invoke`; a parser that lived in `renderer/components/**` would be
 * re-implemented — differently — by the second one to arrive. The rendering
 * decisions (attribution, grouping, per-plugin caps) stay in the hook, because
 * those genuinely are the palette's business.
 */

import { bounded, isRecord, truncated } from "./parse";
import { readPluginActionNavigation, type PluginActionNavigation } from "./sdk";

/**
 * Rows one plugin may occupy in the palette, however many providers it declares.
 *
 * The cap is per PLUGIN, not per provider: it bounds how much of a shared
 * surface one extension can take, and a plugin that split its results across its
 * two allowed providers to claim double the room would be defeating the point.
 * Eight is roughly one screenful beside ADE's own sections — enough for a plugin
 * to be genuinely useful, small enough that the palette still reads as ADE's.
 */
export const PLUGIN_SEARCH_RESULTS_PER_PLUGIN = 8;

/**
 * Rows read out of a single response before the rest are ignored.
 *
 * A liveness bound rather than a policy: {@link PLUGIN_SEARCH_RESULTS_PER_PLUGIN}
 * is what the palette shows, and this only stops a provider that answered with
 * ten thousand rows from being parsed in full on a keystroke. Deliberately
 * larger than the render cap so a provider whose best matches are not first
 * still gets its eight.
 */
export const PLUGIN_SEARCH_ROWS_PER_RESPONSE = 64;

/**
 * The most rows this reader will LOOK at, however many it keeps. Generous
 * enough that a provider returning junk ahead of its real answers still fills
 * the list, small enough that a provider returning nothing but junk cannot make
 * every keystroke walk its whole array.
 */
export const PLUGIN_SEARCH_ROWS_SCAN_MAX = 512;

/** Render bounds. Long values are cut, not refused — see `parse.ts`'s two readers. */
export const PLUGIN_SEARCH_TITLE_MAX_CHARS = 120;
export const PLUGIN_SEARCH_SUBTITLE_MAX_CHARS = 160;

/**
 * Ceiling on a row's id, which is REJECTED rather than truncated when over.
 *
 * The one field here that is an identity instead of a rendering: it is echoed
 * back to the plugin as `resultId` when the row is opened, and two long ids that
 * differ past the cut would become the same row after truncation — silently
 * opening the wrong result.
 */
export const PLUGIN_SEARCH_RESULT_ID_MAX_CHARS = 256;

/**
 * One result row, as the palette is willing to render it.
 *
 * `navigate` is the same verb an action response carries, parsed by the same
 * reader, so a provider can answer a query with rows that already know where
 * they go. A row without one is opened by invoking the provider's action again
 * with `{query, resultId}` — which is how a provider does its expensive work at
 * open time rather than on every keystroke.
 */
export type PluginSearchResult = {
  id: string;
  title: string;
  subtitle?: string;
  navigate?: PluginActionNavigation;
};

/**
 * The rows out of a provider's response, or none.
 *
 * Two accepted envelopes and no others: the bare array, and `{results: [...]}`.
 * The second exists because an SDK action handler naturally returns an object —
 * it is the same shape every other plugin verb rides in — and a provider that
 * answered `{results}` getting silently zero results would be indistinguishable
 * from a provider with nothing to say. Anything else is not a shape this build
 * knows, and "no results" is the honest reading of that.
 */
function resultRows(response: unknown): unknown[] | null {
  if (Array.isArray(response)) return response;
  if (isRecord(response) && Array.isArray(response.results)) return response.results;
  return null;
}

/**
 * Parse a provider's answer. Never throws, never partially trusts a row.
 *
 * A row needs an id and a title to exist at all: without an id it cannot be
 * keyed or echoed back on open, and without a title there is nothing to render,
 * so both are absence rather than an error. Duplicate ids inside one response
 * keep the first — a provider that repeats itself gets one row, not a React key
 * collision.
 */
export function readPluginSearchResults(response: unknown): PluginSearchResult[] {
  const rows = resultRows(response);
  if (!rows) return [];
  const results: PluginSearchResult[] = [];
  const seen = new Set<string>();
  // Bounds SCANNED rows, not accepted ones. Breaking on `results.length` alone
  // means a response of 200k rows that all fail validation is walked in full on
  // every debounced keystroke, which is the opposite of the liveness bound this
  // ceiling is documented as.
  let scanned = 0;
  for (const raw of rows) {
    if (results.length >= PLUGIN_SEARCH_ROWS_PER_RESPONSE) break;
    scanned += 1;
    if (scanned > PLUGIN_SEARCH_ROWS_SCAN_MAX) break;
    if (!isRecord(raw)) continue;
    const id = bounded(raw.id, PLUGIN_SEARCH_RESULT_ID_MAX_CHARS);
    const title = truncated(raw.title, PLUGIN_SEARCH_TITLE_MAX_CHARS);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const subtitle = truncated(raw.subtitle, PLUGIN_SEARCH_SUBTITLE_MAX_CHARS);
    // Reused, not re-implemented: the panel-id rule and the context byte
    // ceiling — including its "over budget → keep the panel, drop the context"
    // degradation — are the same ones a `plugin` deeplink and an action
    // response are held to, and a second reader here would drift from them.
    const navigate = readPluginActionNavigation(raw);
    results.push({
      id,
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(navigate ? { navigate } : {}),
    });
  }
  return results;
}
