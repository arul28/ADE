import type { LaneLinearIssue, LaneLinearIssueLinkRole } from "./types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function linearPrMagicWord(closeOnMerge: boolean): "Fixes" | "Refs" {
  return closeOnMerge ? "Fixes" : "Refs";
}

export function buildLinearPrTitle(issue: LaneLinearIssue): string {
  return `${issue.identifier}: ${issue.title}`.trim();
}

export function buildLinearPrReference(issue: LaneLinearIssue, closeOnMerge: boolean): string {
  return `${linearPrMagicWord(closeOnMerge)} ${issue.identifier}`;
}

export type LinearPrIssueReference = {
  issue: LaneLinearIssue;
  closeOnMerge: boolean;
  role?: LaneLinearIssueLinkRole | "primary";
};

export function ensureLinearPrReference(
  body: string,
  issue: LaneLinearIssue,
  closeOnMerge: boolean,
  options: { preserveExisting?: boolean } = {},
): string {
  const reference = buildLinearPrReference(issue, closeOnMerge);
  const identifier = escapeRegExp(issue.identifier);
  const supportedLineRe = new RegExp(`^(?:Refs|Fixes)\\s+${identifier}\\s*$`, "im");
  if (supportedLineRe.test(body)) {
    return options.preserveExisting === false
      ? body.replace(supportedLineRe, reference)
      : body;
  }
  const knownMagicRe = new RegExp(`\\b(?:Refs|Fixes)\\s+${identifier}\\b`, "i");
  if (knownMagicRe.test(body)) return body;
  const trimmed = body.trimStart();
  return trimmed.length ? `${reference}\n\n${trimmed}` : `${reference}\n`;
}

export function dedupeLinearPrIssueReferences(
  references: LinearPrIssueReference[],
): LinearPrIssueReference[] {
  const out: LinearPrIssueReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const issueId = reference.issue.id.trim() || reference.issue.identifier.trim().toUpperCase();
    if (!issueId || seen.has(issueId)) continue;
    seen.add(issueId);
    out.push(reference);
  }
  return out;
}

export function ensureLinearPrReferences(
  body: string,
  references: LinearPrIssueReference[],
  options: { preserveExisting?: boolean } = {},
): string {
  const deduped = dedupeLinearPrIssueReferences(references);
  let next = body;
  for (let index = deduped.length - 1; index >= 0; index -= 1) {
    const reference = deduped[index];
    if (!reference) continue;
    next = ensureLinearPrReference(next, reference.issue, reference.closeOnMerge, options);
  }
  return next;
}

const LINEAR_LINK_SECTION_OPEN_RE = /<!--\s*ade:linear-links\s+v=\d+[^>]*-->/i;
const LINEAR_LINK_SECTION_CLOSE = "<!-- /ade:linear-links -->";
const LINEAR_LINK_SECTION_CLOSE_RE = /<!--\s*\/ade:linear-links\s*-->/i;

/** Locate the `<!-- ade:linear-links --> ... <!-- /ade:linear-links -->` block within `body`. */
function findLinearLinkSectionBounds(body: string): { before: string; after: string } | null {
  const openIdx = body.search(LINEAR_LINK_SECTION_OPEN_RE);
  if (openIdx < 0) return null;
  const closeMatch = LINEAR_LINK_SECTION_CLOSE_RE.exec(body.slice(openIdx));
  if (!closeMatch) return null;
  return {
    before: body.slice(0, openIdx).trimEnd(),
    after: body.slice(openIdx + closeMatch.index + closeMatch[0].length),
  };
}

function joinAfter(after: string): string {
  if (!after) return "";
  return after.startsWith("\n") ? after : `\n${after}`;
}

export function renderLinearPrIssueLinkSection(references: LinearPrIssueReference[]): string {
  const deduped = dedupeLinearPrIssueReferences(references);
  if (!deduped.length) return "";
  const lines = [
    "<!-- ade:linear-links v=1 -->",
    "### Linked Linear issues",
    "",
    ...deduped.map((reference) => {
      const label = `${reference.issue.identifier}: ${reference.issue.title}`.trim();
      const renderedIssue = reference.issue.url
        ? `[${escapeMarkdownLinkText(label)}](${reference.issue.url})`
        : escapeMarkdown(label);
      const disposition = reference.closeOnMerge ? "closes on merge" : "referenced";
      return `- ${renderedIssue} - ${disposition}`;
    }),
    LINEAR_LINK_SECTION_CLOSE,
  ];
  return lines.join("\n");
}

export function ensureLinearPrIssueLinkSection(
  body: string,
  references: LinearPrIssueReference[],
): string {
  const block = renderLinearPrIssueLinkSection(references);
  const safeBody = typeof body === "string" ? body : "";
  if (!block) return removeLinearPrIssueLinkSection(safeBody);
  const bounds = findLinearLinkSectionBounds(safeBody);
  if (bounds) {
    return `${bounds.before}\n\n${block}${joinAfter(bounds.after)}`.trimEnd() + "\n";
  }
  const cleaned = stripOrphanLinearLinkOpener(safeBody);
  const trimmed = cleaned.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function stripOrphanLinearLinkOpener(body: string): string {
  const openMatch = LINEAR_LINK_SECTION_OPEN_RE.exec(body);
  if (!openMatch) return body;
  if (LINEAR_LINK_SECTION_CLOSE_RE.test(body.slice(openMatch.index))) return body;
  const before = body.slice(0, openMatch.index).trimEnd();
  let after = body.slice(openMatch.index + openMatch[0].length);
  after = after.replace(/^[ \t]*\n/, "");
  return before ? `${before}${after ? `\n${after}` : ""}` : after.replace(/^\n+/, "");
}

function removeLinearPrIssueLinkSection(body: string): string {
  const bounds = findLinearLinkSectionBounds(body);
  if (!bounds) return body;
  const next = `${bounds.before}${joinAfter(bounds.after)}`.trimEnd();
  return next ? `${next}\n` : "";
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\]\\]/g, "\\$&");
}

export function ensureLinearCommitReference(message: string, issue: LaneLinearIssue): string {
  const trimmed = message.trim();
  if (!trimmed.length) return trimmed;
  const identifier = escapeRegExp(issue.identifier);
  const knownMagicRe = new RegExp(`\\b(?:Refs|Fixes)\\s+${identifier}\\b`, "i");
  if (knownMagicRe.test(trimmed)) return trimmed;
  // If the commit message already starts with the issue identifier (e.g.
  // "LIN-123: do thing"), don't prepend a duplicate `Refs LIN-123:` block.
  const leadingIdRe = new RegExp(`^${identifier}\\s*[:\\-]`, "i");
  if (leadingIdRe.test(trimmed)) return trimmed;
  return `Refs ${issue.identifier}: ${trimmed}`;
}
