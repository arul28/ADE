/**
 * GitHub tab filters <-> GitHub search syntax.
 *
 * One pure module shared by the renderer (which reads `label:x author:y` typed
 * into the search box as filters) and the PR service (which turns filters into
 * the `q` string for GitHub's search). Everything a person typed is untrusted:
 * a value is quoted, a login is checked against GitHub's own grammar, and a
 * qualifier that would widen or contradict the query (`repo:`, `is:`, `sort:`)
 * never reaches GitHub from the free text.
 */
import type { GitHubPrListFilters, GitHubPrSearchState } from "./types/prs";

/** The read account. */
export const GITHUB_PR_FILTER_ME = "@me";
/** Nobody assigned (`no:assignee`). Not a login: logins cannot start with `@`. */
export const GITHUB_PR_FILTER_NO_ASSIGNEE = "@none";

/** GitHub caps a label name at 50 characters; leave room for older data. */
const MAX_LABEL_LENGTH = 100;
const MAX_LABELS = 10;
/** GitHub rejects queries longer than 256 characters (qualifiers excluded). */
const MAX_TEXT_LENGTH = 200;

/** GitHub's login grammar: 1-39 alphanumerics or hyphens, no leading hyphen. */
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** An app account as GitHub prints it on a PR (`dependabot[bot]`). */
const BOT_LOGIN_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\[bot\]$/i;

/**
 * Qualifiers the free text may not carry. `repo:`/`org:`/`user:` would search
 * other repositories into this one's list; `is:`/`state:`/`type:` would fight
 * the Open/Merged/Closed tabs; `sort:` would break the paging order; and the
 * filter keys are read as filters before text is built.
 */
const BLOCKED_TEXT_QUALIFIERS = new Set([
  "repo", "org", "user", "owner", "is", "type", "state", "sort",
  "label", "author", "assignee", "no",
]);

export function emptyGitHubPrListFilters(): GitHubPrListFilters {
  return { labels: [], author: null, assignee: null };
}

/** A login without its `@`, or null when GitHub could not have issued it. */
export function normalizeGitHubLogin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^@/, "");
  if (LOGIN_RE.test(value)) return value;
  const bot = BOT_LOGIN_RE.exec(value);
  return bot ? `${bot[1]}[bot]` : null;
}

function normalizePersonFilter(raw: unknown, allowNobody: boolean): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.toLowerCase() === GITHUB_PR_FILTER_ME) return GITHUB_PR_FILTER_ME;
  if (allowNobody && value.toLowerCase() === GITHUB_PR_FILTER_NO_ASSIGNEE) return GITHUB_PR_FILTER_NO_ASSIGNEE;
  return normalizeGitHubLogin(value);
}

function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_LABEL_LENGTH) return null;
  return value;
}

/** Validates filters from any caller (renderer, phone, CLI); drops what GitHub could not match. */
export function normalizeGitHubPrListFilters(raw: unknown): GitHubPrListFilters {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(record.labels) ? record.labels : []) {
    const label = normalizeLabel(entry);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
    if (labels.length >= MAX_LABELS) break;
  }
  return {
    labels,
    author: normalizePersonFilter(record.author, false),
    assignee: normalizePersonFilter(record.assignee, true),
  };
}

export function hasGitHubPrListFilters(filters: GitHubPrListFilters | null | undefined): boolean {
  return Boolean(filters && (filters.labels.length > 0 || filters.author || filters.assignee));
}

/** Stable identity for caching and effect keys (case-insensitive like GitHub). */
export function githubPrListFiltersKey(filters: GitHubPrListFilters): string {
  return JSON.stringify([
    [...filters.labels].map((label) => label.toLowerCase()).sort(),
    filters.author?.toLowerCase() ?? null,
    filters.assignee?.toLowerCase() ?? null,
  ]);
}

/** Adds `extra` on top of `base`: labels union, a person in `extra` replaces. */
export function mergeGitHubPrListFilters(
  base: GitHubPrListFilters,
  extra: Partial<GitHubPrListFilters>,
): GitHubPrListFilters {
  return normalizeGitHubPrListFilters({
    labels: [...base.labels, ...(extra.labels ?? [])],
    author: extra.author ?? base.author,
    assignee: extra.assignee ?? base.assignee,
  });
}

type SearchToken = { raw: string; end: number };

/** Splits on whitespace, keeping a `"quoted run"` (spaces included) in one token. */
function tokenize(input: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index += 1;
    if (index >= input.length) break;
    let raw = "";
    let quoted = false;
    while (index < input.length && (quoted || !/\s/.test(input[index]!))) {
      const ch = input[index]!;
      if (ch === "\"") quoted = !quoted;
      raw += ch;
      index += 1;
    }
    tokens.push({ raw, end: index });
  }
  return tokens;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")
    ? value.slice(1, -1)
    : value;
}

export type ParsedGitHubPrSearchText = {
  /** Filters read out of the text (only what was typed; merge onto the active ones). */
  filters: Partial<GitHubPrListFilters> & { labels: string[] };
  /** The text with those qualifiers taken out. */
  text: string;
  /** False when nothing was read; `text` is then the input unchanged. */
  matched: boolean;
};

/**
 * Reads `label:x label:"a b" author:y assignee:z assignee:@me no:assignee` out
 * of the search box. With `keepTrailingToken`, a last token the person is still
 * typing (no whitespace after it yet) stays as text, so `label:bu` does not
 * become a filter half-way through `label:bug`.
 */
export function parseGitHubPrSearchText(
  input: string,
  options: { keepTrailingToken?: boolean } = {},
): ParsedGitHubPrSearchText {
  const filters: ParsedGitHubPrSearchText["filters"] = { labels: [] };
  const rest: string[] = [];
  let matched = false;
  const tokens = tokenize(input);
  tokens.forEach((token, index) => {
    const stillTyping = options.keepTrailingToken === true
      && index === tokens.length - 1
      && token.end >= input.length;
    const qualifier = /^(label|author|assignee|no):(.+)$/i.exec(token.raw);
    if (stillTyping || !qualifier) {
      rest.push(token.raw);
      return;
    }
    const key = qualifier[1]!.toLowerCase();
    const value = unquote(qualifier[2]!);
    if (key === "label") {
      const label = normalizeLabel(value);
      if (label) {
        filters.labels.push(label);
        matched = true;
        return;
      }
    } else if (key === "author") {
      const author = normalizePersonFilter(value, false);
      if (author) {
        filters.author = author;
        matched = true;
        return;
      }
    } else if (key === "assignee") {
      const assignee = normalizePersonFilter(value, false);
      if (assignee) {
        filters.assignee = assignee;
        matched = true;
        return;
      }
    } else if (key === "no" && value.toLowerCase() === "assignee") {
      filters.assignee = GITHUB_PR_FILTER_NO_ASSIGNEE;
      matched = true;
      return;
    }
    rest.push(token.raw);
  });
  if (!matched) return { filters, text: input, matched };
  const trailingSpace = /\s$/.test(input) && rest.length > 0 ? " " : "";
  return { filters, text: rest.join(" ") + trailingSpace, matched };
}

/** Free text safe to hand to GitHub: no scope-changing qualifiers, balanced quotes, bounded. */
export function sanitizeGitHubPrSearchText(text: string | null | undefined): string {
  if (!text) return "";
  const kept = tokenize(text).map((token) => token.raw).filter((raw) => {
    const qualifier = /^-?([A-Za-z-]+):/.exec(raw);
    return !qualifier || !BLOCKED_TEXT_QUALIFIERS.has(qualifier[1]!.toLowerCase());
  });
  let joined = kept.join(" ");
  if ((joined.match(/"/g)?.length ?? 0) % 2 !== 0) joined = joined.replace(/"/g, "");
  return joined.slice(0, MAX_TEXT_LENGTH).trim();
}

function personQualifier(key: "author" | "assignee", login: string): string {
  if (login === GITHUB_PR_FILTER_ME) return `${key}:@me`;
  const bot = BOT_LOGIN_RE.exec(login);
  // GitHub searches an app's PRs as `author:app/<slug>`, not by its `[bot]` login.
  if (bot) return key === "author" ? `author:app/${bot[1]}` : `${key}:${login}`;
  return `${key}:${login}`;
}

export type GitHubPrSearchQuery = {
  q: string;
  /**
   * Labels the query could not carry: GitHub search has no escape for `"`, so
   * a label containing one is left out and must be matched on the results.
   */
  unquotableLabels: string[];
};

/**
 * The GitHub search `q` for the tab: this repository, PRs only, the tab's
 * state, the filters, the free text, newest update first (so pages line up with
 * the list order). State `closed` means closed without merging, as in the tab.
 */
export function buildGitHubPrSearchQuery(args: {
  repoOwner: string;
  repoName: string;
  state: GitHubPrSearchState;
  filters: GitHubPrListFilters;
  text?: string | null;
}): GitHubPrSearchQuery {
  const filters = normalizeGitHubPrListFilters(args.filters);
  const parts = [`repo:${args.repoOwner}/${args.repoName}`, "is:pr"];
  if (args.state === "open") parts.push("is:open");
  else if (args.state === "merged") parts.push("is:merged");
  else if (args.state === "closed") parts.push("is:closed", "is:unmerged");
  const unquotableLabels: string[] = [];
  for (const label of filters.labels) {
    if (label.includes("\"")) unquotableLabels.push(label);
    else parts.push(`label:"${label}"`);
  }
  if (filters.author) parts.push(personQualifier("author", filters.author));
  if (filters.assignee === GITHUB_PR_FILTER_NO_ASSIGNEE) parts.push("no:assignee");
  else if (filters.assignee) parts.push(personQualifier("assignee", filters.assignee));
  const text = sanitizeGitHubPrSearchText(args.text);
  if (text) parts.push(text);
  parts.push("sort:updated-desc");
  return { q: parts.join(" "), unquotableLabels };
}
