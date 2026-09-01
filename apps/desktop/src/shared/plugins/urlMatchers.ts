/**
 * What a plugin may declare so ITS tracker's links become smart-link chips.
 *
 * ## Why this is its own module
 *
 * Three layers need the same rules and none of them may import the other two:
 * the manifest parser validates a declared matcher, the install disclosure
 * prints it, and `smartLinkMatchers.ts` compiles it and runs it against a real
 * URL. A second spelling of the pattern language would mean a matcher the
 * parser accepted never fires, which reads to the plugin author as a platform
 * bug and to the user as a plugin that does not work.
 *
 * `manifest.ts` imports this file, so this file imports nothing that reaches
 * back — no `deeplinks`, no `sdk`. Building the chip's deeplink is therefore
 * `smartLinkMatchers.ts`'s job, not this one's. The two modules it does import,
 * `network.ts` and `builtinSurfaceRegistry.ts`, both sit strictly below it: the
 * registry in particular imports nothing at all, which is what lets the
 * built-in owner names be read here rather than mirrored.
 *
 * ## What a matcher can produce, and what it cannot
 *
 * A matcher is DATA. Matching it involves no callback into the plugin, no
 * child process, and no network. It produces exactly three things: a chip
 * label rendered from a bounded template over its own captures, a deeplink
 * into a panel the plugin already publishes, and — when it declares one — an
 * issue reference whose provider is fixed to the matcher's own declaration.
 * A plugin cannot make the chip say something it did not template, cannot
 * claim a provider it did not name, and cannot run code when someone pastes a
 * URL.
 *
 * ## The pattern language
 *
 * `pathPattern` is NOT a regular expression. A plugin that could ship a regex
 * could ship a catastrophically backtracking one, and it would run on the main
 * thread on every keystroke in the composer. The language is a restricted
 * subset with no alternation, no quantifiers and no character classes:
 *
 * ```
 * pathPattern := "/" segment ("/" segment)* [ "/" "**" ]
 * segment     := literal | capture | "*"
 * literal     := one or more of [A-Za-z0-9._~@+-]
 * capture     := "{" name "}"
 * name        := [a-z][A-Za-z0-9_]*
 * ```
 *
 * - A literal matches that exact path segment. It is escaped character by
 *   character on the way into the compiled regex, so `.` and `+` are literal
 *   dots and pluses and never metacharacters.
 * - `{name}` matches exactly one non-empty segment and captures it.
 * - `*` matches exactly one non-empty segment and captures nothing.
 * - `**` matches zero or more remaining segments and may only be last. It is
 *   what makes a trailing slug optional, which most trackers have.
 * - A trailing slash in the URL is ignored.
 *
 * Every count and length is capped (see the constants below) so the compiled
 * regex has a bounded size and a bounded number of groups.
 */

import {
  PLUGIN_BUILTIN_SURFACE_OWNER_IDS,
  type PluginBuiltinSurfaceId,
} from "./builtinSurfaceRegistry";
import { isValidPluginNetworkHost, pluginNetworkHostAllowed } from "./network";

/** The most URL matchers one plugin may declare. */
export const PLUGIN_URL_MATCHERS_PER_PLUGIN = 8;

/**
 * The most hosts one matcher may claim. Fewer than `network.hosts`: a matcher
 * names the one tracker it reads, not everything the plugin talks to.
 */
export const PLUGIN_URL_MATCHER_HOSTS_MAX = 4;

/** Longest a `pathPattern` may be. */
export const PLUGIN_URL_MATCHER_PATTERN_MAX_LENGTH = 200;

/** The most segments one pattern may hold. */
export const PLUGIN_URL_MATCHER_SEGMENTS_MAX = 12;

/** The most `{name}` captures one pattern may declare. */
export const PLUGIN_URL_MATCHER_CAPTURES_MAX = 6;

/** Longest a chip label template may be, before substitution. */
export const PLUGIN_URL_MATCHER_LABEL_TEMPLATE_MAX = 64;

/** Longest one substituted capture may be inside a rendered label. */
export const PLUGIN_URL_MATCHER_LABEL_VALUE_MAX = 48;

/** Longest a rendered chip label may be. */
export const PLUGIN_URL_MATCHER_LABEL_MAX = 80;

/**
 * Longest a chip glyph may be, counted in code points. Two, because it is drawn
 * in a badge the size of a favicon and a third would be clipped, not shrunk.
 */
export const PLUGIN_URL_MATCHER_GLYPH_MAX = 2;

/**
 * Hosts core already parses, and the surface that owns each.
 *
 * A plugin that claimed one of these would draw its own chip over ADE's GitHub
 * and Linear links — including on machines where the user never installed a
 * tracker plugin at all, since a chip is drawn from the URL alone. Refused at
 * parse, by name, so the author reads who owns it rather than shipping a
 * matcher that silently never wins.
 */
export const CORE_SMART_LINK_HOSTS: Readonly<Record<string, string>> = {
  "github.com": "GitHub",
  "linear.app": "Linear",
};

/**
 * The built-in surface whose OWNING plugin may claim a core host after all.
 *
 * The refusal above exists to stop a plugin drawing over ADE's own links. It
 * says nothing useful to the one plugin that IS the surface: `ade-linear` gates
 * the compiled Linear pane, holds the Linear credential through the handoff,
 * and is the package the tracker moves into. Refusing it `linear.app` would
 * mean the plugin can never carry the chip core draws today, so the extraction
 * could never finish.
 *
 * Three things keep this narrow.
 *
 * - Only an EXACT host is relaxed. A wildcard stays refused for everyone,
 *   including the owner: `*.linear.app` claims names core never parsed, and
 *   `*.app` would otherwise reach this door through the suffix rule.
 * - The relaxation applies only to an official package (`manifest.ts` checks
 *   `official` before it passes anything in), so a community plugin cannot
 *   reach it at all.
 * - WHICH official package owns a given surface is answered by
 *   `PLUGIN_BUILTIN_SURFACE_OWNER_IDS` in `builtinSurfaceRegistry.ts`, the same
 *   map `builtinSurfaces.ts` builds its owner table from. That registry imports
 *   nothing, so both modules read one map and neither copies it. Parse-time
 *   this is "the manifest is the owner"; install-time the host still refuses a
 *   non-owner.
 *
 * `github.com` is deliberately absent: there is no gateable `github` built-in
 * surface, so no plugin can ever claim it.
 */
export const CORE_SMART_LINK_HOST_BUILTINS: Readonly<Record<string, PluginBuiltinSurfaceId>> = {
  "linear.app": "linear",
};

/**
 * The built-in surfaces this package owns, and may therefore claim the core
 * smart-link host of.
 *
 * OWNERSHIP is what this answers, not the honoured `surfaces[].builtin` field.
 * The relaxation above used to key on that field, and it stopped working the
 * day `linear` became a SUPERSEDED surface: a plugin that supersedes may not
 * name the surface with `builtin` at all (see
 * `PLUGIN_BUILTIN_SURFACE_PRESENCE`), so `ade-linear` claimed nothing and lost
 * its own domain. Ownership is the fact the relaxation always meant, and it
 * survives both polarities.
 *
 * The owner names come straight from `PLUGIN_BUILTIN_SURFACE_OWNER_IDS` — the
 * one map `BUILTIN_SURFACE_OWNERS` in `builtinSurfaces.ts` is also built from.
 * This module used to hand-mirror them, pinned by a test, because
 * `builtinSurfaces.ts` imports this file and the arrow could not run back. The
 * mirror is gone: the map moved down into `builtinSurfaceRegistry.ts`, which
 * imports nothing and so sits below both of us, and a drift that could silently
 * cost a plugin the smart links it ships is no longer expressible.
 *
 * Narrowed to the surfaces a core host actually unlocks, so owning a built-in
 * is not by itself a claim on anything — a surface with no core host behind it
 * unlocks nothing, and the answer is empty for every package but the registered
 * owner of one that has. The caller must still establish that the manifest is
 * OFFICIAL before it uses the answer: this function reads a name, not a trust
 * level.
 */
export function coreSmartLinkBuiltinsOwnedBy(pluginId: unknown): string[] {
  if (typeof pluginId !== "string") return [];
  const id = pluginId.trim();
  if (id.length === 0) return [];
  const unlocked = [...new Set(Object.values(CORE_SMART_LINK_HOST_BUILTINS))];
  return unlocked.filter((builtin) => PLUGIN_BUILTIN_SURFACE_OWNER_IDS[builtin] === id);
}

/**
 * Issue providers core speaks for. A plugin may not claim one.
 *
 * Spelled here rather than imported from `issueRef.ts` for the reason stated at
 * the top: this module sits under `manifest.ts`, and the constants are pinned
 * against their source by a test rather than by an import.
 */
export const CORE_ISSUE_PROVIDERS: readonly string[] = ["linear", "github", "core"];

const CAPTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,23}$/;
const LITERAL_SEGMENT_PATTERN = /^[A-Za-z0-9._~@+-]{1,64}$/;
const ENTITY_PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Is this code point one that must never reach a chip?
 *
 * Written as numbers rather than a character class on purpose: the ranges are
 * invisible characters, and a source file that spells them literally cannot be
 * reviewed, diffed, or grepped. Covered are the C0 and C1 controls, the bidi
 * embedding and override marks, the zero-width and word-joiner characters, the
 * line and paragraph separators, the invisible math operators, and the byte
 * order mark.
 *
 * A chip is drawn inline with the user's own words, so a right-to-left override
 * inside a captured value does not corrupt the chip — it reorders the sentence
 * around it.
 */
function isUnsafeDisplayCodePoint(code: number): boolean {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2060 && code <= 0x2064) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0xfeff;
}

/** Drop every character {@link isUnsafeDisplayCodePoint} refuses. */
function stripUnsafeDisplayChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || isUnsafeDisplayCodePoint(code)) continue;
    out += char;
  }
  return out;
}

/**
 * The kinds of entity a matcher may name. One today; a union so adding a second
 * does not change the shape every reader already handles.
 */
export type PluginUrlMatcherEntityKind = "issue";

/** The tracker record a matched URL refers to. */
export type PluginManifestUrlMatcherEntity = {
  kind: PluginUrlMatcherEntityKind;
  /**
   * The provider stamped on every ref this matcher produces. Fixed here, in the
   * manifest, so a match can never mint a ref for someone else's tracker.
   */
  provider: string;
  /** Which `{name}` capture carries the record's key. */
  keyFrom: string;
};

/** How a matched URL is drawn in the composer and the transcript. */
export type PluginManifestUrlMatcherChip = {
  /** A bounded template over this matcher's captures, e.g. `"{project}-{num}"`. */
  label: string;
  /** One or two characters drawn in the chip's mark slot. Text, never markup. */
  icon?: string;
};

/** One declared URL matcher. */
export type PluginManifestUrlMatcher = {
  id: string;
  /** Exact or `*.`-wildcard hostnames, in the `network.hosts` grammar. */
  hosts: string[];
  pathPattern: string;
  chip: PluginManifestUrlMatcherChip;
  /**
   * The panel a chip's deeplink opens. Absent falls back, at routing time, to
   * the plugin's issue panel and then to whatever panel it publishes.
   */
  panelId?: string;
  entity?: PluginManifestUrlMatcherEntity;
};

/** A `pathPattern` compiled to something that can be run. */
export type CompiledUrlMatcherPattern = {
  /** Regex source over the URL's pathname. Group N holds capture N. */
  source: string;
  /** Capture names, in group order. Never emitted into `source`. */
  captureNames: string[];
};

/** Escape every character a regex could read as syntax. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, (char) => `\\${char}`);
}

/**
 * Compile a `pathPattern`, or say why it is not one.
 *
 * Returns the regex SOURCE rather than a `RegExp` so the validator, the compiler
 * and the tests all read the same string, and so a caller decides its own flags.
 * Capture names are returned alongside and are never written into the source: a
 * numbered group cannot be named `constructor`, cannot collide with another
 * matcher's group, and cannot smuggle regex syntax through a name.
 */
export function compilePluginUrlMatcherPattern(
  pattern: unknown,
): { ok: true; compiled: CompiledUrlMatcherPattern } | { ok: false; reason: string } {
  if (typeof pattern !== "string") return { ok: false, reason: "must be a string" };
  const text = pattern.trim();
  if (text.length === 0) return { ok: false, reason: "is empty" };
  if (text.length > PLUGIN_URL_MATCHER_PATTERN_MAX_LENGTH) {
    return {
      ok: false,
      reason: `is longer than ${PLUGIN_URL_MATCHER_PATTERN_MAX_LENGTH} characters`,
    };
  }
  if (!text.startsWith("/")) return { ok: false, reason: 'must start with "/"' };

  const segments = text.slice(1).split("/");
  if (segments.length > PLUGIN_URL_MATCHER_SEGMENTS_MAX) {
    return { ok: false, reason: `has more than ${PLUGIN_URL_MATCHER_SEGMENTS_MAX} segments` };
  }

  const captureNames: string[] = [];
  const parts: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === "**") {
      if (index !== segments.length - 1) {
        return { ok: false, reason: 'may only use "**" as its last segment' };
      }
      // Zero or more remaining segments — the optional trailing slug.
      parts.push("(?:/[^/]+)*");
      continue;
    }
    if (segment === "*") {
      parts.push("/[^/]+");
      continue;
    }
    if (segment.startsWith("{") && segment.endsWith("}")) {
      const name = segment.slice(1, -1);
      if (!CAPTURE_NAME_PATTERN.test(name)) {
        return { ok: false, reason: `declares a capture "${segment}" that is not a name` };
      }
      if (captureNames.includes(name)) {
        return { ok: false, reason: `declares the capture "{${name}}" twice` };
      }
      if (captureNames.length >= PLUGIN_URL_MATCHER_CAPTURES_MAX) {
        return {
          ok: false,
          reason: `declares more than ${PLUGIN_URL_MATCHER_CAPTURES_MAX} captures`,
        };
      }
      captureNames.push(name);
      parts.push("/([^/]+)");
      continue;
    }
    if (!LITERAL_SEGMENT_PATTERN.test(segment)) {
      return {
        ok: false,
        reason: `has a segment "${segment}" that is not a literal, "{name}", "*" or "**"`,
      };
    }
    parts.push(`/${escapeRegexLiteral(segment)}`);
  }

  // A trailing slash is the same URL. Anchored at both ends so a matcher for
  // `/issue/{key}` cannot claim `/issue/{key}/attachments/secret`.
  return { ok: true, compiled: { source: `^${parts.join("")}/?$`, captureNames } };
}

/** Is this a `pathPattern` a manifest may declare? */
export function isValidPluginUrlMatcherPattern(value: unknown): value is string {
  return compilePluginUrlMatcherPattern(value).ok;
}

/**
 * Which core surface owns this host, if one does.
 *
 * A wildcard is refused when it covers a core host OR anything under one.
 * `pluginNetworkHostAllowed` alone would not do it: by that rule `*.github.com`
 * does not match the apex `github.com`, so a plugin could claim every OTHER
 * name under GitHub's domain and draw its own chips there. The domain is the
 * thing being claimed, not one hostname in it, so the suffix is compared
 * directly and `*.github.com` is refused for the same reason `github.com` is.
 *
 * `pluginNetworkHostAllowed` still decides the exact-and-wildcard question at
 * MATCH time, in `smartLinkMatchers.ts`. This is the parse-time claim check.
 */
export function coreSmartLinkHostOwner(
  host: unknown,
  claimedBuiltins?: ReadonlySet<string>,
): string | null {
  if (typeof host !== "string") return null;
  const entry = host.trim().toLowerCase();
  if (entry.length === 0) return null;
  const suffix = entry.startsWith("*.") ? entry.slice(2) : null;
  for (const [coreHost, owner] of Object.entries(CORE_SMART_LINK_HOSTS)) {
    if (entry === coreHost) {
      // The owner of the built-in surface may claim its own host. See
      // CORE_SMART_LINK_HOST_BUILTINS for why this is not a hole.
      const builtin = CORE_SMART_LINK_HOST_BUILTINS[coreHost];
      if (builtin && claimedBuiltins?.has(builtin)) continue;
      return owner;
    }
    // A wildcard is refused for everyone, owner included. `*.app` reaches this
    // branch through the suffix rule and is not a claim on Linear.
    if (suffix && (coreHost === suffix || coreHost.endsWith(`.${suffix}`))) return owner;
  }
  return null;
}

/** Is this a host a URL matcher may claim? Same grammar as `network.hosts`. */
export function isValidPluginUrlMatcherHost(value: unknown): value is string {
  return isValidPluginNetworkHost(value) && coreSmartLinkHostOwner(value) === null;
}

/**
 * Is this a provider a matcher's entity may claim?
 *
 * Uppercase is refused rather than folded, for the reason `network.ts` refuses
 * an uppercase host: a provider is stamped on every issue ref the matcher
 * produces and compared as a string by everything downstream, so it must have
 * exactly one spelling.
 */
export function isValidPluginUrlMatcherProvider(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const provider = value.trim();
  if (!ENTITY_PROVIDER_PATTERN.test(provider)) return false;
  return !CORE_ISSUE_PROVIDERS.includes(provider);
}

/** One piece of a parsed chip label template. */
export type PluginUrlMatcherLabelPart = { text: string } | { capture: string };

/**
 * Split a chip label template into literal text and capture references.
 *
 * Refused when the template is malformed or names a capture the pattern does not
 * declare — a chip reading `{key}` because nothing filled it is worse than the
 * manifest being refused with the reason.
 */
export function parsePluginUrlMatcherLabelTemplate(
  template: unknown,
  captureNames: readonly string[],
): { ok: true; parts: PluginUrlMatcherLabelPart[] } | { ok: false; reason: string } {
  if (typeof template !== "string") return { ok: false, reason: "must be a string" };
  const text = template.trim();
  if (text.length === 0) return { ok: false, reason: "is empty" };
  if (text.length > PLUGIN_URL_MATCHER_LABEL_TEMPLATE_MAX) {
    return {
      ok: false,
      reason: `is longer than ${PLUGIN_URL_MATCHER_LABEL_TEMPLATE_MAX} characters`,
    };
  }

  const parts: PluginUrlMatcherLabelPart[] = [];
  let cursor = 0;
  let referenced = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    if (open < 0) {
      const tail = text.slice(cursor);
      if (tail.includes("}")) return { ok: false, reason: 'has an unmatched "}"' };
      parts.push({ text: tail });
      break;
    }
    const literal = text.slice(cursor, open);
    if (literal.includes("}")) return { ok: false, reason: 'has an unmatched "}"' };
    if (literal) parts.push({ text: literal });
    const close = text.indexOf("}", open + 1);
    if (close < 0) return { ok: false, reason: 'has an unmatched "{"' };
    const name = text.slice(open + 1, close);
    if (!captureNames.includes(name)) {
      return { ok: false, reason: `refers to "{${name}}", which the pathPattern does not capture` };
    }
    referenced += 1;
    if (referenced > PLUGIN_URL_MATCHER_CAPTURES_MAX) {
      return {
        ok: false,
        reason: `refers to more than ${PLUGIN_URL_MATCHER_CAPTURES_MAX} captures`,
      };
    }
    parts.push({ capture: name });
    cursor = close + 1;
  }
  if (parts.length === 0) return { ok: false, reason: "is empty" };
  return { ok: true, parts };
}

/**
 * One captured value, made safe to draw.
 *
 * Percent-decoded, because a chip showing `ADE%2D123` is showing the wrong
 * thing; stripped of invisible characters, because the chip sits inside the
 * user's own sentence; and clamped, because the composer gives it one line.
 */
export function sanitizePluginUrlMatcherValue(value: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  return stripUnsafeDisplayChars(decoded)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PLUGIN_URL_MATCHER_LABEL_VALUE_MAX);
}

/**
 * Render a parsed template against a match's captures.
 *
 * `Object.hasOwn`, not a plain lookup: a capture name is a manifest field, and
 * `constructor` or `toString` resolve through the prototype chain to FUNCTIONS.
 * A plain `captures[name] ?? ""` would append the source text of
 * `Object.prototype.constructor` to the chip. The same reasoning as
 * `pluginIcon`'s in `renderer/components/plugins/pluginIcons.tsx`.
 */
export function renderPluginUrlMatcherLabel(
  parts: readonly PluginUrlMatcherLabelPart[],
  captures: Readonly<Record<string, string>>,
): string {
  let out = "";
  for (const part of parts) {
    if ("capture" in part) {
      const value = Object.hasOwn(captures, part.capture) ? captures[part.capture] : undefined;
      out += typeof value === "string" ? sanitizePluginUrlMatcherValue(value) : "";
    } else {
      out += part.text;
    }
    if (out.length >= PLUGIN_URL_MATCHER_LABEL_MAX) break;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, PLUGIN_URL_MATCHER_LABEL_MAX);
}

/** Is this a chip glyph a manifest may declare? */
export function isValidPluginUrlMatcherGlyph(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const glyph = value.trim();
  if (glyph.length === 0) return false;
  // Counted in code points, not UTF-16 units, so one emoji is one character.
  if (Array.from(glyph).length > PLUGIN_URL_MATCHER_GLYPH_MAX) return false;
  return stripUnsafeDisplayChars(glyph) === glyph;
}
