import type { LaneGitHubIssue } from "./types";
import { githubIssueIdentifier } from "./laneGitHubIssue";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function githubPrMagicWord(closeOnMerge: boolean): "Closes" | "Refs" {
  return closeOnMerge ? "Closes" : "Refs";
}

export function buildGitHubPrReference(issue: LaneGitHubIssue, closeOnMerge: boolean): string {
  return `${githubPrMagicWord(closeOnMerge)} ${githubIssueIdentifier(issue)}`;
}

export type GitHubPrIssueReference = {
  issue: LaneGitHubIssue;
  closeOnMerge: boolean;
};

export function ensureGitHubPrReference(
  body: string,
  issue: LaneGitHubIssue,
  closeOnMerge: boolean,
  options: { preserveExisting?: boolean } = {},
): string {
  const reference = buildGitHubPrReference(issue, closeOnMerge);
  const identifier = escapeRegExp(githubIssueIdentifier(issue));
  const numberOnly = escapeRegExp(`#${issue.number}`);
  const supportedLineRe = new RegExp(
    `^(?:Refs|Closes|Close|Closed|Fixes|Fix|Fixed|Resolves|Resolve|Resolved)\\s+(?:${identifier}|${numberOnly})\\s*$`,
    "im",
  );
  if (supportedLineRe.test(body)) {
    return options.preserveExisting === false
      ? body.replace(supportedLineRe, reference)
      : body;
  }
  const knownMagicRe = new RegExp(
    `\\b(?:Refs|Closes|Close|Closed|Fixes|Fix|Fixed|Resolves|Resolve|Resolved)\\s+(?:${identifier}|${numberOnly})\\b`,
    "i",
  );
  if (knownMagicRe.test(body)) return body;
  const trimmed = body.trimStart();
  return trimmed.length ? `${reference}\n\n${trimmed}` : `${reference}\n`;
}

export function dedupeGitHubPrIssueReferences(
  references: GitHubPrIssueReference[],
): GitHubPrIssueReference[] {
  const out: GitHubPrIssueReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const issueId = reference.issue.id.trim() || githubIssueIdentifier(reference.issue);
    if (!issueId || seen.has(issueId)) continue;
    seen.add(issueId);
    out.push(reference);
  }
  return out;
}

export function ensureGitHubPrReferences(
  body: string,
  references: GitHubPrIssueReference[],
  options: { preserveExisting?: boolean } = {},
): string {
  const deduped = dedupeGitHubPrIssueReferences(references);
  let next = body;
  for (let index = deduped.length - 1; index >= 0; index -= 1) {
    const reference = deduped[index];
    if (!reference) continue;
    next = ensureGitHubPrReference(next, reference.issue, reference.closeOnMerge, options);
  }
  return next;
}

const GITHUB_LINK_SECTION_OPEN_RE = /<!--\s*ade:github-links\s+v=\d+[^>]*-->/i;
const GITHUB_LINK_SECTION_CLOSE = "<!-- /ade:github-links -->";
const GITHUB_LINK_SECTION_CLOSE_RE = /<!--\s*\/ade:github-links\s*-->/i;

function findGitHubLinkSectionBounds(body: string): { before: string; after: string } | null {
  const openIdx = body.search(GITHUB_LINK_SECTION_OPEN_RE);
  if (openIdx < 0) return null;
  const closeMatch = GITHUB_LINK_SECTION_CLOSE_RE.exec(body.slice(openIdx));
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

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\]\\]/g, "\\$&");
}

export function renderGitHubPrIssueLinkSection(references: GitHubPrIssueReference[]): string {
  const deduped = dedupeGitHubPrIssueReferences(references);
  if (!deduped.length) return "";
  const lines = [
    "<!-- ade:github-links v=1 -->",
    "### Linked GitHub issues",
    "",
    ...deduped.map((reference) => {
      const label = `${githubIssueIdentifier(reference.issue)}: ${reference.issue.title}`.trim();
      const renderedIssue = `[${escapeMarkdownLinkText(label)}](${reference.issue.url})`;
      const disposition = reference.closeOnMerge ? "closes on merge" : "referenced";
      return `- ${renderedIssue} - ${disposition}`;
    }),
    GITHUB_LINK_SECTION_CLOSE,
  ];
  return lines.join("\n");
}

export function ensureGitHubPrIssueLinkSection(
  body: string,
  references: GitHubPrIssueReference[],
): string {
  const block = renderGitHubPrIssueLinkSection(references);
  const safeBody = typeof body === "string" ? body : "";
  if (!block) {
    const bounds = findGitHubLinkSectionBounds(safeBody);
    if (!bounds) return safeBody;
    const next = `${bounds.before}${joinAfter(bounds.after)}`.trimEnd();
    return next ? `${next}\n` : "";
  }
  const bounds = findGitHubLinkSectionBounds(safeBody);
  if (bounds) {
    return `${bounds.before}\n\n${block}${joinAfter(bounds.after)}`.trimEnd() + "\n";
  }
  const trimmed = safeBody.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export function parseGitHubIssueRef(value: string): { owner?: string; repo?: string; number: number } | null {
  const trimmed = value.trim();
  const full = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/);
  if (full?.[1] && full[2] && full[3]) {
    return { owner: full[1], repo: full[2], number: Number(full[3]) };
  }
  const hash = trimmed.match(/^#?(\d+)$/);
  if (hash?.[1]) return { number: Number(hash[1]) };
  return null;
}
