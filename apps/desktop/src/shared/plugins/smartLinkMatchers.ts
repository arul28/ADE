/**
 * Installed plugins' URL matchers, compiled once and run on every pasted URL.
 *
 * ## Why this is separate from `urlMatchers.ts`
 *
 * `manifest.ts` imports the grammar, and `deeplinks.ts` imports `manifest.ts`.
 * A chip carries a deeplink, so the thing that BUILDS a chip has to import
 * `deeplinks.ts` — and could not live under the manifest parser without closing
 * that circle. The grammar and its caps stay in `urlMatchers.ts`, where the
 * parser can reach them; compilation, matching and chip construction live here.
 *
 * ## The ordering rule
 *
 * Within the plugin tier the FIRST match wins, over matchers sorted by plugin
 * id and then by declaration order. Sorted rather than left in registry order
 * because the registry's order is install order, which differs between two
 * machines with the same plugins installed — and a chip that reads differently
 * on a laptop than on a desktop is a bug nobody can reproduce.
 *
 * Core's tier is ahead of this one, in `deriveSmartLinkPreview`. Core-owned
 * hosts are refused at parse as well, so the two halves agree even when a
 * manifest predates the refusal.
 *
 * ## What running a matcher costs
 *
 * A hostname lookup and one anchored regex with no alternation, no quantifiers
 * over groups and a bounded number of segments. No plugin code runs, no child
 * process is started, and nothing is fetched. That is the property that lets
 * this sit inside the composer's keystroke handler.
 */

import { buildDeeplink, PLUGIN_ISSUE_PANEL_ID } from "../deeplinks";
import type { SmartLinkPreview } from "../smartLinks";
import { isPluginRegistrationDisabled } from "./disabledContributions";
import { pluginNetworkHostAllowed } from "./network";
import {
  compilePluginUrlMatcherPattern,
  parsePluginUrlMatcherLabelTemplate,
  pluginUrlMatcherChipGlyphText,
  renderPluginUrlMatcherLabel,
  sanitizePluginUrlMatcherValue,
  type PluginManifestUrlMatcher,
  type PluginUrlMatcherLabelPart,
} from "./urlMatchers";
import { pluginBrandTokenKey, type PluginBrandGlyph } from "./vocabularyBrandIcons";

/**
 * The little a plugin has to look like for its matchers to be compiled.
 *
 * Structural on purpose, and a subset of `PluginClientInstalled`: the renderer's
 * registry array satisfies it as-is, so no caller has to build an adapter and no
 * two callers can build different ones.
 */
export type SmartLinkMatcherSource = {
  pluginId: string;
  enabled: boolean;
  urlMatchers?: readonly PluginManifestUrlMatcher[];
  /** Panels this plugin publishes, for the deeplink's panel fallback. */
  tabs?: readonly { panelId: string }[];
  /** The user's per-contribution off switch. Applied here so the compiled set
   *  IS the live set and no reader has to ask a second question. */
  disabledContributions?: readonly string[];
  /**
   * The plugin's own sanitized `brand:*` glyphs, for a chip icon that names one.
   *
   * Resolved HERE rather than at draw time because this is the last place that
   * holds both halves: the matcher's declared token and the plugin that shipped
   * the artwork. A chip carries the resolved mark, so no renderer has to reach
   * back into the registry from inside a keystroke handler.
   */
  brandIcons?: Readonly<Record<string, PluginBrandGlyph>>;
};

/** One matcher, ready to run. */
export type CompiledSmartLinkMatcher = {
  pluginId: string;
  matcherId: string;
  hosts: readonly string[];
  pattern: RegExp;
  captureNames: readonly string[];
  labelParts: readonly PluginUrlMatcherLabelPart[];
  /** The one or two characters to draw, when the icon is a monogram. */
  glyph: string | null;
  /**
   * The vector to draw, when the icon is a `brand:` token this plugin ships.
   *
   * Null when the icon is a monogram, and null when the token names a glyph row
   * the plugin did not ship — the chip then falls back to its provider mark
   * rather than printing the token. A manifest string must never reach a chip
   * as text.
   */
  mark: PluginBrandGlyph | null;
  panelId: string;
  entity: { kind: "issue"; provider: string; keyFrom: string } | null;
};

/**
 * Which panel a chip's deeplink opens.
 *
 * The matcher's own declaration first, then the conventional issue panel, then
 * whatever the plugin actually publishes. The last step matters: a plugin that
 * declares a matcher but names no panel still gets a chip that opens SOMETHING,
 * and `resolvePluginDeeplinkRouting` refuses a link to a panel that is not there
 * rather than drawing an empty shell.
 */
function resolveMatcherPanelId(
  matcher: PluginManifestUrlMatcher,
  source: SmartLinkMatcherSource,
): string {
  if (matcher.panelId) return matcher.panelId;
  const tabs = source.tabs ?? [];
  if (tabs.some((tab) => tab.panelId === PLUGIN_ISSUE_PANEL_ID)) return PLUGIN_ISSUE_PANEL_ID;
  return tabs[0]?.panelId ?? PLUGIN_ISSUE_PANEL_ID;
}

/**
 * The sanitized mark a `brand:` chip icon names, or null.
 *
 * `Object.hasOwn`, not a plain lookup: the token suffix comes from a manifest,
 * and `constructor` would resolve through the prototype chain to a function the
 * renderer would then try to read paths off.
 */
function resolveMatcherChipMark(
  icon: string | undefined,
  brandIcons: Readonly<Record<string, PluginBrandGlyph>> | undefined,
): PluginBrandGlyph | null {
  const token = pluginBrandTokenKey(icon);
  if (!token || !brandIcons || !Object.hasOwn(brandIcons, token)) return null;
  return brandIcons[token] ?? null;
}

/**
 * Compile every enabled plugin's matchers.
 *
 * A matcher that no longer compiles is dropped silently rather than throwing.
 * The manifest parser already refused it with a reason the author reads in
 * `ade plugin doctor`; refusing it a second time here, inside a render, would
 * turn a bad manifest into a blank composer.
 */
export function compileSmartLinkMatchers(
  sources: readonly SmartLinkMatcherSource[],
): CompiledSmartLinkMatcher[] {
  const compiled: CompiledSmartLinkMatcher[] = [];
  for (const source of [...sources].sort((a, b) => a.pluginId.localeCompare(b.pluginId))) {
    if (!source.enabled) continue;
    for (const matcher of source.urlMatchers ?? []) {
      if (isPluginRegistrationDisabled(source.disabledContributions, "urlMatcher", matcher.id)) {
        continue;
      }
      const pattern = compilePluginUrlMatcherPattern(matcher.pathPattern);
      if (!pattern.ok) continue;
      const template = parsePluginUrlMatcherLabelTemplate(
        matcher.chip.label,
        pattern.compiled.captureNames,
      );
      if (!template.ok) continue;
      compiled.push({
        pluginId: source.pluginId,
        matcherId: matcher.id,
        hosts: matcher.hosts,
        pattern: new RegExp(pattern.compiled.source),
        captureNames: pattern.compiled.captureNames,
        labelParts: template.parts,
        glyph: pluginUrlMatcherChipGlyphText(matcher.chip.icon),
        mark: resolveMatcherChipMark(matcher.chip.icon, source.brandIcons),
        panelId: resolveMatcherPanelId(matcher, source),
        entity: matcher.entity ?? null,
      });
    }
  }
  return compiled;
}

/** Run the compiled matchers against one URL. First match wins. */
export function matchSmartLinkMatchers(
  url: URL,
  rawUrl: string,
  matchers: readonly CompiledSmartLinkMatcher[],
): SmartLinkPreview | null {
  if (matchers.length === 0) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  for (const matcher of matchers) {
    if (!pluginNetworkHostAllowed(url.hostname, matcher.hosts)) continue;
    const found = matcher.pattern.exec(url.pathname);
    if (!found) continue;

    // Null prototype: a capture name comes from a manifest, and a plain object
    // would answer `constructor` and `toString` with functions off the chain.
    const captures: Record<string, string> = Object.create(null);
    matcher.captureNames.forEach((name, index) => {
      captures[name] = found[index + 1] ?? "";
    });

    const label = renderPluginUrlMatcherLabel(matcher.labelParts, captures);
    // A template that rendered to nothing means every capture it named was
    // empty. Showing the URL is worse than showing nothing, but showing an
    // EMPTY chip is worse than both — it is a box the user cannot read or
    // explain. Decline instead and let the generic tier draw the link.
    if (!label) return null;

    const issueKey = matcher.entity
      ? sanitizePluginUrlMatcherValue(captures[matcher.entity.keyFrom] ?? "")
      : "";
    const issue = matcher.entity && issueKey
      ? { provider: matcher.entity.provider, key: issueKey }
      : null;

    return {
      url: rawUrl,
      provider: `plugin:${matcher.pluginId}`,
      kind: "plugin_entity",
      label,
      ...(matcher.glyph ? { glyph: matcher.glyph } : {}),
      ...(matcher.mark ? { glyphMark: matcher.mark } : {}),
      plugin: {
        pluginId: matcher.pluginId,
        matcherId: matcher.matcherId,
        deeplink: buildDeeplink(
          {
            kind: "plugin",
            pluginId: matcher.pluginId,
            panelId: matcher.panelId,
            // The same context an `ade://issue/…` link hands a panel, so a chip
            // and a deeplink into the same record open the same view.
            ...(issue ? { context: { issue: { provider: issue.provider, key: issue.key } } } : {}),
          },
          { form: "ade" },
        ),
        ...(issue ? { issue } : {}),
      },
    };
  }
  return null;
}

/**
 * The callback `deriveSmartLinkPreview` and `findSmartLinks` take.
 *
 * Built once per registry change and held by the caller, so compiling does not
 * happen on the keystroke path — only matching does.
 */
export function smartLinkPluginMatcher(
  matchers: readonly CompiledSmartLinkMatcher[],
): (url: URL, rawUrl: string) => SmartLinkPreview | null {
  return (url, rawUrl) => matchSmartLinkMatchers(url, rawUrl, matchers);
}

/**
 * Which plugin speaks for which tracker on this machine.
 *
 * The same declaration that draws the chip answers the deeplink's ownership
 * question, which is the point: a plugin that can recognise a tracker's URLs is
 * a plugin that can draw that tracker's issues, and asking it to say so twice
 * would let the two answers disagree.
 *
 * A DISABLED plugin still owns its tracker here, which is the one place this
 * differs from {@link compileSmartLinkMatchers}. The two answer different
 * questions: a disabled plugin must not draw chips, but it is still the thing
 * the reader installed for that tracker, and hiding it turns the refusal from
 * "Jira is switched off" into "nothing here reads jira". `resolveIssueDeeplink
 * Routing` has its own presence gate and names the plugin; it just needs to be
 * told who to name. Enabled owners sort first so a disabled plugin never blocks
 * an enabled one that claims the same tracker.
 */
export function issueProviderOwnersFromMatchers(
  sources: readonly SmartLinkMatcherSource[],
): Array<{ provider: string; pluginId: string; panelId?: string | null }> {
  const ordered = [...sources].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.pluginId.localeCompare(b.pluginId);
  });

  const owners: Array<{ provider: string; pluginId: string; panelId?: string | null }> = [];
  const claimed = new Set<string>();
  for (const source of ordered) {
    for (const matcher of source.urlMatchers ?? []) {
      if (!matcher.entity) continue;
      if (isPluginRegistrationDisabled(source.disabledContributions, "urlMatcher", matcher.id)) {
        continue;
      }
      const provider = matcher.entity.provider;
      // First claim wins, over a stable sort, so two plugins for one tracker
      // resolve the same way on every machine.
      if (claimed.has(provider)) continue;
      claimed.add(provider);
      owners.push({
        provider,
        pluginId: source.pluginId,
        panelId: resolveMatcherPanelId(matcher, source),
      });
    }
  }
  return owners;
}
