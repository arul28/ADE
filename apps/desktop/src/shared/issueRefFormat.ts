/**
 * Provider-neutral formatting for an `IssueRef`: the lane name, the branch
 * name, and the PR magic-word reference.
 *
 * These are the generalizations of `linearIssueBranch.ts` and the two
 * magic-word modules. The Linear and GitHub functions keep their exact
 * behavior; this module is what a plugin-supplied tracker reads, and what the
 * built-in paths delegate to wherever the delegation is lossless.
 *
 * Nothing here reaches for a filesystem path, so there is no separator
 * assumption to get wrong on Windows. A branch name is a Git ref, and a Git ref
 * uses `/` on every platform.
 */

import { ISSUE_PROVIDER_GITHUB, ISSUE_PROVIDER_LINEAR, issueRefIdentity, type IssueRef } from "./issueRef";
import { sanitizeLinearIssueBranchName } from "./linearIssueBranch";

/** The parts of a ref that naming needs. Keeps callers free of full refs. */
export type IssueRefNameInput = Pick<IssueRef, "provider" | "key" | "title">;

/** The parts of a ref that the PR magic word needs. */
export type IssueRefReferenceInput = Pick<IssueRef, "provider" | "key">;

/**
 * Lowercase, collapse every non-alphanumeric run to a single `-`, and trim the
 * dashes off both ends. This is the slug half of `linearIssueBranchName`,
 * unchanged.
 */
export function slugifyIssueSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * The human name ADE gives a lane opened on `ref`. Generalizes
 * `linearIssueLaneName`: the key, a space, the title.
 */
export function issueRefLaneName(ref: IssueRefNameInput): string {
  return `${ref.key.trim()} ${ref.title.trim()}`.trim();
}

/**
 * The branch ADE derives for `ref`. Generalizes `linearIssueBranchName`.
 *
 * The KEY IS SLUGIFIED, not merely lowercased. For Linear that is a no-op:
 * a Linear identifier is `TEAMKEY-123`, drawn from `[A-Za-z0-9-]`, and on that
 * alphabet slugifying and lowercasing produce byte-identical output once
 * `sanitizeLinearIssueBranchName` has run (it collapses dash runs and strips
 * leading/trailing dashes the same way). `issueRefFormat.test.ts` proves that
 * equality against `linearIssueBranchName` over a corpus of real identifiers.
 *
 * For GitHub the key is `owner/repo#42`, and slugifying is the whole point:
 *
 * - `/` kept verbatim would make `owner/repo#42-title` a NESTED ref. Git then
 *   refuses to create the branch `owner/repo` (a directory/file conflict in
 *   `.git/refs/heads`), and any lane later named `owner/repo` collides with the
 *   whole subtree. A tracker key must not get to carve out ref namespaces.
 * - `#` is legal in a ref but is a comment character in a shell and a fragment
 *   delimiter in a URL, so it makes the branch awkward to type and to link.
 *
 * So `owner/repo#42` becomes `owner-repo-42`, a flat ref that collides with
 * nothing. `sanitizeLinearIssueBranchName` still runs last: it is the module
 * that encodes the real Git ref-format rules and it is deliberately not forked.
 */
export function issueRefBranchName(ref: IssueRefNameInput): string {
  const keySlug = slugifyIssueSegment(ref.key);
  const titleSlug = slugifyIssueSegment(ref.title);
  const branch = [keySlug, titleSlug].filter(Boolean).join("-");
  // `linear-issue` for a Linear ref, which is exactly the legacy fallback.
  const fallback = `${slugifyIssueSegment(ref.provider) || "issue"}-issue`;
  return sanitizeLinearIssueBranchName(branch || keySlug || fallback);
}

export type IssueRefPrMagicWord = "Fixes" | "Closes" | "Refs";

/**
 * The closing magic word per provider — and this map is the whole `Fixes` vs
 * `Refs` decision.
 *
 * A closing word is a PROMISE that merging the PR closes the issue. ADE may
 * only make that promise where something actually performs the close:
 *
 * - `github`: GitHub itself resolves `Closes owner/repo#42` in a PR body and
 *   closes the issue on merge. Real closure. (`Closes`, not `Fixes`, only
 *   because that is the word `githubPrMagicWord` has always emitted; GitHub
 *   treats the two identically.)
 * - `linear`: Linear's GitHub integration parses `Fixes ADE-123` out of the PR
 *   body and moves the issue on merge. Real closure, performed by Linear.
 * - anything else: nobody is listening. `Fixes ABC-12` in a GitHub PR body is
 *   inert text — GitHub only resolves `#n` and `owner/repo#n`, and ADE has no
 *   closure path of its own for a third-party tracker. Emitting `Fixes` there
 *   would advertise a state transition that never happens, and the PR would
 *   merge leaving the issue open with a body claiming otherwise. So an unknown
 *   provider gets `Refs` REGARDLESS of `closeOnMerge`.
 *
 * A plugin that can close its own issues does it in its merge handler; when
 * that exists, the provider joins this map and its word becomes truthful.
 */
const CLOSING_MAGIC_WORDS = new Map<string, IssueRefPrMagicWord>([
  [ISSUE_PROVIDER_GITHUB, "Closes"],
  [ISSUE_PROVIDER_LINEAR, "Fixes"],
]);

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** True when merging a PR that references `ref` actually closes the issue. */
export function issueRefSupportsCloseOnMerge(ref: Pick<IssueRef, "provider">): boolean {
  return CLOSING_MAGIC_WORDS.has(normalizeProvider(ref.provider));
}

/** `Fixes` / `Closes` when the close is real, `Refs` otherwise. */
export function issueRefPrMagicWord(
  ref: Pick<IssueRef, "provider">,
  closeOnMerge: boolean,
): IssueRefPrMagicWord {
  if (!closeOnMerge) return "Refs";
  return CLOSING_MAGIC_WORDS.get(normalizeProvider(ref.provider)) ?? "Refs";
}

/**
 * The one-line PR reference, e.g. `Fixes ADE-123` or `Closes ade/app#42`.
 *
 * The key goes in VERBATIM — no trim — because the built-in builders it
 * replaces interpolated their identifier verbatim, and a byte-for-byte
 * delegation is the point.
 */
export function issueRefPrReference(ref: IssueRefReferenceInput, closeOnMerge: boolean): string {
  return `${issueRefPrMagicWord(ref, closeOnMerge)} ${ref.key}`;
}

/**
 * Drop repeats, keeping the first occurrence.
 *
 * Identity is `issueRefIdentity`, which is provider-scoped, so a Jira issue
 * whose id happens to be the string `42` does not swallow GitHub issue `42`.
 * The Linear and GitHub dedupers key on the bare id and cannot tell them apart;
 * that is safe only because they each see a single provider.
 */
export function dedupeIssueRefs<T extends { issue: IssueRef }>(entries: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = issueRefIdentity(entry.issue);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The PR body: magic-word lines and one link section per tracker
// ---------------------------------------------------------------------------

export type IssueRefPrReference = {
  issue: IssueRef;
  closeOnMerge: boolean;
};

/**
 * The two providers whose PR sections are rendered by their OWN modules.
 *
 * This is a renderer-ownership list, not a provider allowlist: `linear` is
 * excluded because `renderLinearPrIssueLinkSection` must keep producing its
 * exact historical bytes, and `github` because `ensureGitHubPrIssueLinkSection`
 * already owns the `ade:github-links` markers and merges the lane's and the
 * session's GitHub links into one section. A second writer aiming at the same
 * markers would replace that section and drop the other writer's rows. Every
 * OTHER provider — a plugin tracker, present or future — is rendered here, and
 * nothing about a provider needs registering for that to work.
 */
const BUILT_IN_LINK_SECTION_PROVIDERS = new Set<string>([
  ISSUE_PROVIDER_LINEAR,
  ISSUE_PROVIDER_GITHUB,
]);

/** True when `renderIssueRefPrLinkSections` owns this provider's section. */
export function issueRefUsesGenericLinkSection(ref: Pick<IssueRef, "provider">): boolean {
  return !BUILT_IN_LINK_SECTION_PROVIDERS.has(normalizeProvider(ref.provider));
}

/**
 * The slug that names a provider's marker comment and, indirectly, its section.
 *
 * Restricted to `[a-z0-9-]` so it can be dropped into a `RegExp` without
 * escaping and cannot smuggle metacharacters out of a plugin-declared provider
 * string. Two providers whose names differ only in punctuation (`my.tracker`
 * and `my-tracker`) collapse onto one section; that is the accepted cost of a
 * marker that is safe to parse.
 */
function issueProviderSlug(provider: string): string {
  return slugifyIssueSegment(provider) || "issue";
}

/**
 * The tracker's display name, DERIVED from the provider rather than looked up:
 * each alphanumeric run is capitalized. `linear` becomes `Linear`, which is
 * what the Linear section has always said; `jira` becomes `Jira`; a provider
 * ADE has never heard of becomes its own name, title-cased. No provider has to
 * be registered anywhere to render a correct heading.
 *
 * A provider whose brand has interior capitals (`github` → `Github`) is the
 * known wart. The two providers where that matters own their own renderers and
 * their own historical headings, so it never surfaces today.
 */
export function issueProviderLabel(provider: string): string {
  const normalized = normalizeProvider(provider);
  const label = normalized.replace(/[a-z0-9]+/g, (run) => run.charAt(0).toUpperCase() + run.slice(1));
  return label || "Issue";
}

/**
 * The marker pair for one provider's section.
 *
 * The scheme is the EXISTING one, generalized: `renderLinearPrIssueLinkSection`
 * writes `<!-- ade:linear-links v=1 -->` … `<!-- /ade:linear-links -->` and the
 * GitHub renderer writes `<!-- ade:github-links v=1 -->` … — so the convention
 * already reads as `ade:{provider}-links`. Feeding it the provider slug gives
 * every tracker its own pair, and a section is found and replaced only by its
 * own markers, so two trackers can never overwrite each other. The open regex
 * tolerates extra attributes after `v=N`, exactly as the Linear one does, so a
 * later version can add them without orphaning today's sections.
 */
function issueLinkSectionMarkers(provider: string): {
  open: string;
  openRe: RegExp;
  close: string;
  closeRe: RegExp;
} {
  const slug = issueProviderSlug(provider);
  return {
    open: `<!-- ade:${slug}-links v=1 -->`,
    openRe: new RegExp(`<!--\\s*ade:${slug}-links\\s+v=\\d+[^>]*-->`, "i"),
    close: `<!-- /ade:${slug}-links -->`,
    closeRe: new RegExp(`<!--\\s*\\/ade:${slug}-links\\s*-->`, "i"),
  };
}

/** Any `ade:<slug>-links` opener, used to sweep sections nothing links any more. */
const ANY_LINK_SECTION_OPEN_RE = /<!--\s*ade:([a-z0-9-]+)-links\s+v=\d+[^>]*-->/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\]\\]/g, "\\$&");
}

function joinAfter(after: string): string {
  if (!after) return "";
  return after.startsWith("\n") ? after : `\n${after}`;
}

function findLinkSectionBounds(
  body: string,
  markers: { openRe: RegExp; closeRe: RegExp },
): { before: string; after: string } | null {
  const openIdx = body.search(markers.openRe);
  if (openIdx < 0) return null;
  const closeMatch = markers.closeRe.exec(body.slice(openIdx));
  if (!closeMatch) return null;
  return {
    before: body.slice(0, openIdx).trimEnd(),
    after: body.slice(openIdx + closeMatch.index + closeMatch[0].length),
  };
}

/**
 * One provider's section, in the same shape the Linear renderer emits.
 *
 * For a Linear ref this is byte-identical to `renderLinearPrIssueLinkSection`
 * — same markers, same heading, same `- [KEY: Title](url) - disposition` rows,
 * same escaping. `issueRefFormat.test.ts` asserts that equality. The Linear
 * path still calls its own renderer; the equality is what makes the two safe to
 * live side by side.
 */
export function renderIssueRefPrLinkSection(
  provider: string,
  references: readonly IssueRefPrReference[],
): string {
  const deduped = dedupeIssueRefs(references);
  if (!deduped.length) return "";
  const markers = issueLinkSectionMarkers(provider);
  return [
    markers.open,
    `### Linked ${issueProviderLabel(provider)} issues`,
    "",
    ...deduped.map((reference) => {
      const label = `${reference.issue.key}: ${reference.issue.title}`.trim();
      const rendered = reference.issue.url
        ? `[${escapeMarkdownLinkText(label)}](${reference.issue.url})`
        : escapeMarkdown(label);
      const disposition = reference.closeOnMerge && issueRefSupportsCloseOnMerge(reference.issue)
        ? "closes on merge"
        : "referenced";
      return `- ${rendered} - ${disposition}`;
    }),
    markers.close,
  ].join("\n");
}

function ensureOneLinkSection(
  body: string,
  provider: string,
  references: readonly IssueRefPrReference[],
): string {
  const block = renderIssueRefPrLinkSection(provider, references);
  if (!block) return body;
  const markers = issueLinkSectionMarkers(provider);
  const bounds = findLinkSectionBounds(body, markers);
  if (bounds) {
    return `${bounds.before}\n\n${block}${joinAfter(bounds.after)}`.trimEnd() + "\n";
  }
  const cleaned = stripOrphanLinkOpener(body, markers);
  const trimmed = cleaned.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** Drop an opener whose closer someone hand-edited away, so it cannot double. */
function stripOrphanLinkOpener(body: string, markers: { openRe: RegExp; closeRe: RegExp }): string {
  const openMatch = markers.openRe.exec(body);
  if (!openMatch) return body;
  if (markers.closeRe.test(body.slice(openMatch.index))) return body;
  const before = body.slice(0, openMatch.index).trimEnd();
  let after = body.slice(openMatch.index + openMatch[0].length);
  after = after.replace(/^[ \t]*\n/, "");
  return before ? `${before}${after ? `\n${after}` : ""}` : after.replace(/^\n+/, "");
}

function removeLinkSection(body: string, provider: string): string {
  const bounds = findLinkSectionBounds(body, issueLinkSectionMarkers(provider));
  if (!bounds) return body;
  const next = `${bounds.before}${joinAfter(bounds.after)}`.trimEnd();
  return next ? `${next}\n` : "";
}

/** Group refs by provider, first-seen order, so section order is stable. */
function groupByProvider(
  references: readonly IssueRefPrReference[],
): Map<string, IssueRefPrReference[]> {
  const groups = new Map<string, IssueRefPrReference[]>();
  for (const reference of references) {
    const provider = normalizeProvider(reference.issue.provider);
    const group = groups.get(provider);
    if (group) group.push(reference);
    else groups.set(provider, [reference]);
  }
  return groups;
}

/**
 * Write one link section per tracker, replacing each in place.
 *
 * A second write with the same references is a no-op: every section is located
 * by its own marker pair and rewritten, never appended twice. A section whose
 * provider has dropped out of `references` is swept — but only a section this
 * renderer owns, so the Linear and GitHub sections are never touched here.
 *
 * With no references at all the body is returned unchanged rather than swept
 * clean. That matches `applyLinearPrLinkage`, which returns early when a lane
 * has nothing to say: a lane that momentarily reads back no links must not
 * strip a section off a live PR.
 */
export function ensureIssueRefPrLinkSections(
  body: string,
  references: readonly IssueRefPrReference[],
): string {
  const safeBody = typeof body === "string" ? body : "";
  const deduped = dedupeIssueRefs(references);
  if (!deduped.length) return safeBody;

  const groups = groupByProvider(deduped);
  let next = safeBody;
  for (const [provider, group] of groups) {
    next = ensureOneLinkSection(next, provider, group);
  }

  const present = new Set([...groups.keys()].map((provider) => issueProviderSlug(provider)));
  for (const slug of readLinkSectionSlugs(next)) {
    if (present.has(slug)) continue;
    if (BUILT_IN_LINK_SECTION_PROVIDERS.has(slug)) continue;
    next = removeLinkSection(next, slug);
  }
  return next;
}

function readLinkSectionSlugs(body: string): string[] {
  const slugs = new Set<string>();
  for (const match of body.matchAll(ANY_LINK_SECTION_OPEN_RE)) {
    const slug = match[1]?.toLowerCase();
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

/**
 * Put `Refs ABC-12` (or the provider's closing word) at the top of the body,
 * unless the body already carries a magic-word line for that issue.
 *
 * The recognized words are every word the two built-in writers can emit, so a
 * line a human wrote by hand — or an older ADE wrote — is found and not
 * duplicated. `preserveExisting: false` rewrites such a line to the disposition
 * the lane now records; the default leaves a hand-edited line alone.
 */
export function ensureIssueRefPrReference(
  body: string,
  reference: IssueRefPrReference,
  options: { preserveExisting?: boolean } = {},
): string {
  const line = issueRefPrReference(reference.issue, reference.closeOnMerge);
  const key = escapeRegExp(reference.issue.key);
  if (!reference.issue.key.trim()) return body;
  const words = "Refs|Fixes|Closes|Resolves";
  // `[ \t]*`, not `\s*`: `\s` matches a newline, so a greedy trailing `\s*$`
  // swallows the blank line after the reference and the rewrite silently
  // reflows the body. (`ensureLinearPrReference` has that `\s*$` and loses one
  // blank line the first time it rewrites a line. Left alone there — its bytes
  // are pinned — but not reproduced here.)
  const supportedLineRe = new RegExp(`^(?:${words})\\s+${key}[ \\t]*$`, "im");
  if (supportedLineRe.test(body)) {
    return options.preserveExisting === false ? body.replace(supportedLineRe, line) : body;
  }
  const knownMagicRe = new RegExp(`\\b(?:${words})\\s+${key}\\b`, "i");
  if (knownMagicRe.test(body)) return body;
  const trimmed = body.trimStart();
  return trimmed.length ? `${line}\n\n${trimmed}` : `${line}\n`;
}

/** `ensureIssueRefPrReference` for a list, keeping the given order top-down. */
export function ensureIssueRefPrReferences(
  body: string,
  references: readonly IssueRefPrReference[],
  options: { preserveExisting?: boolean } = {},
): string {
  const deduped = dedupeIssueRefs(references);
  let next = body;
  for (let index = deduped.length - 1; index >= 0; index -= 1) {
    const reference = deduped[index];
    if (!reference) continue;
    next = ensureIssueRefPrReference(next, reference, options);
  }
  return next;
}
