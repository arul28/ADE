/**
 * How ADE's ten syntax colours relate to TextMate scopes.
 *
 * One table serves both directions. A VS Code theme states its syntax colours
 * as `tokenColors` keyed by TextMate scope, so the importer reads them through
 * this table. The chat code blocks are painted by Shiki, which also speaks
 * TextMate scopes, so the highlighter writes them back out through the same
 * table. Monaco names its own tokens, so it has a short table of its own.
 */

import type { AdeSyntaxKey, AdeSyntaxPalette } from "./types";

/**
 * The scopes each syntax key is read from, most specific first.
 *
 * `exact` keys accept only an entry for that very scope. A broad entry such as
 * `keyword` would otherwise paint every operator and property in the keyword
 * colour, which no theme author means.
 */
export const SYNTAX_SCOPES: Record<AdeSyntaxKey, { scopes: readonly string[]; exact?: boolean }> = {
  comment: { scopes: ["comment"] },
  keyword: { scopes: ["keyword.control", "keyword", "storage.type", "storage"] },
  string: { scopes: ["string"] },
  number: { scopes: ["constant.numeric"] },
  function: { scopes: ["entity.name.function", "support.function", "meta.function-call"] },
  type: { scopes: ["entity.name.type", "entity.name.class", "support.class", "support.type"] },
  constant: { scopes: ["constant.language", "variable.other.constant", "constant"] },
  variable: { scopes: ["variable"] },
  property: { scopes: ["variable.other.property", "support.type.property-name", "meta.object-literal.key"], exact: true },
  operator: { scopes: ["keyword.operator"], exact: true },
};

/** Monaco token names each syntax key paints, across its built-in tokenizers. */
export const MONACO_SYNTAX_TOKENS: Record<AdeSyntaxKey, readonly string[]> = {
  comment: ["comment", "comment.doc"],
  keyword: ["keyword", "keyword.json", "tag", "metatag"],
  string: ["string", "string.escape", "regexp", "attribute.value"],
  number: ["number", "number.hex", "number.float"],
  function: ["function", "entity.name.function"],
  type: ["type", "type.identifier", "namespace"],
  constant: ["constant", "variable.predefined", "annotation"],
  variable: ["identifier", "variable", "variable.parameter"],
  property: ["attribute.name", "key", "string.key.json"],
  operator: ["operator", "delimiter", "delimiter.bracket"],
};

type TokenColorRule = { scope?: unknown; settings?: { foreground?: unknown } };

function scopesOf(rule: TokenColorRule): string[] {
  if (typeof rule.scope === "string") return rule.scope.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (Array.isArray(rule.scope)) {
    return rule.scope.flatMap((entry) => (typeof entry === "string" ? entry.split(",").map((part) => part.trim()) : [])).filter(Boolean);
  }
  return [];
}

/**
 * The foreground a VS Code `tokenColors` list gives one scope, or null.
 *
 * A rule covers a scope when it names the scope itself or an ancestor of it
 * (`keyword` covers `keyword.control`). The most specific rule wins, and of two
 * equally specific rules the later one wins, which is how VS Code resolves it.
 */
export function tokenColorForScope(
  tokenColors: readonly unknown[],
  scope: string,
  options: { exact?: boolean } = {},
): string | null {
  let best: { length: number; color: string } | null = null;
  for (const raw of tokenColors) {
    if (!raw || typeof raw !== "object") continue;
    const rule = raw as TokenColorRule;
    const color = rule.settings?.foreground;
    if (typeof color !== "string") continue;
    for (const candidate of scopesOf(rule)) {
      const covers = candidate === scope || (!options.exact && scope.startsWith(`${candidate}.`));
      if (covers && (!best || candidate.length >= best.length)) best = { length: candidate.length, color };
    }
  }
  return best?.color ?? null;
}

/** The syntax colours a `tokenColors` list states, keyed by ADE syntax key. */
export function syntaxFromTokenColors(
  tokenColors: readonly unknown[],
  normalize: (value: unknown) => string | null,
): AdeSyntaxPalette {
  const out: AdeSyntaxPalette = {};
  for (const key of Object.keys(SYNTAX_SCOPES) as AdeSyntaxKey[]) {
    const { scopes, exact } = SYNTAX_SCOPES[key];
    for (const scope of scopes) {
      const hex = normalize(tokenColorForScope(tokenColors, scope, { exact }));
      if (hex) {
        out[key] = hex;
        break;
      }
    }
  }
  return out;
}
