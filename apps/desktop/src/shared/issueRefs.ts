import { deriveSmartLinkPreview } from "./smartLinks";

/**
 * A pointer to one issue in one tracker.
 *
 * Every surface that opens an issue — a chat link, a chip, a lane badge, a
 * deeplink — reduces what it has to this shape first, so the viewer, the tools
 * pane tab and the sheet never have to know where the click came from.
 *
 * A Linear identifier (`ADE-123`) is unique across the workspace, so it is the
 * whole address. A GitHub number is only unique inside its repository, so the
 * repository travels with it.
 */
export type IssueRef =
  | { provider: "linear"; identifier: string; url?: string | null }
  | { provider: "github"; owner: string; repo: string; number: number; url?: string | null }
  | { provider: "jira"; siteUrl: string; key: string; url?: string | null };

export type IssueProvider = IssueRef["provider"];

const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,9}-\d+$/;

export function normalizeLinearIdentifier(value: string | null | undefined): string | null {
  const identifier = value?.trim().toUpperCase() ?? "";
  return LINEAR_IDENTIFIER_RE.test(identifier) ? identifier : null;
}

export function linearIssueRef(identifier: string, url?: string | null): IssueRef | null {
  const normalized = normalizeLinearIdentifier(identifier);
  return normalized ? { provider: "linear", identifier: normalized, url: url ?? null } : null;
}

export function normalizeJiraIssueKey(value: string | null | undefined): string | null {
  const key = value?.trim().toUpperCase() ?? "";
  return JIRA_ISSUE_KEY_RE.test(key) ? key : null;
}

function normalizedJiraSiteUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function jiraIssueRef(siteUrl: string, key: string, url?: string | null): IssueRef | null {
  const site = normalizedJiraSiteUrl(siteUrl);
  const normalizedKey = normalizeJiraIssueKey(key);
  if (!site || !normalizedKey) return null;
  return { provider: "jira", siteUrl: site, key: normalizedKey, url: url ?? `${site}/browse/${normalizedKey}` };
}

/** Stable identity for a ref: the key of a tab, a cache entry, a dedupe set. */
export function issueRefKey(ref: IssueRef): string {
  if (ref.provider === "linear") return `linear:${ref.identifier}`;
  if (ref.provider === "github") return `github:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
  const site = normalizedJiraSiteUrl(ref.siteUrl) ?? ref.siteUrl.toLowerCase().replace(/\/$/, "");
  return `jira:${site.toLowerCase()}:${ref.key.toUpperCase()}`;
}

/** What a person calls the issue: `ADE-123`, or `#123` for GitHub. */
export function issueRefLabel(ref: IssueRef): string {
  if (ref.provider === "linear") return ref.identifier;
  return ref.provider === "github" ? `#${ref.number}` : ref.key;
}

export function issueRefsEqual(a: IssueRef, b: IssueRef): boolean {
  return issueRefKey(a) === issueRefKey(b);
}

/**
 * The issue a URL points at, or null when it is not an issue link.
 *
 * Reuses the smart-link classifier so a URL that draws as an issue chip and a
 * URL that opens the issue viewer can never disagree.
 */
export function issueRefFromUrl(rawUrl: string | null | undefined): IssueRef | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const keyMatch = /^\/browse\/([^/]+)\/?$/i.exec(parsed.pathname);
    if (keyMatch) {
      const ref = jiraIssueRef(parsed.origin, keyMatch[1]!, rawUrl);
      if (ref) return ref;
    }
  } catch {
    return null;
  }
  const preview = deriveSmartLinkPreview(rawUrl);
  if (!preview) return null;
  if (preview.kind === "linear_issue") return linearIssueRef(preview.label, preview.url);
  if (preview.kind === "github_issue") {
    let parsed: URL;
    try {
      parsed = new URL(preview.url);
    } catch {
      return null;
    }
    const [owner, repo, section, number] = parsed.pathname.split("/").filter(Boolean);
    const issueNumber = Number(number);
    if (!owner || !repo || section?.toLowerCase() !== "issues" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return null;
    }
    return { provider: "github", owner, repo: repo.replace(/\.git$/i, ""), number: issueNumber, url: preview.url };
  }
  return null;
}

/** Plain JSON for persistence; anything that is not a valid ref reads as null. */
export function parseStoredIssueRef(value: unknown): IssueRef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.provider === "linear" && typeof record.identifier === "string") {
    return linearIssueRef(record.identifier, typeof record.url === "string" ? record.url : null);
  }
  if (
    record.provider === "github"
    && typeof record.owner === "string"
    && typeof record.repo === "string"
    && typeof record.number === "number"
    && Number.isSafeInteger(record.number)
    && record.number > 0
    && record.owner.trim()
    && record.repo.trim()
  ) {
    return {
      provider: "github",
      owner: record.owner.trim(),
      repo: record.repo.trim(),
      number: record.number,
      url: typeof record.url === "string" ? record.url : null,
    };
  }
  if (record.provider === "jira" && typeof record.siteUrl === "string" && typeof record.key === "string") {
    return jiraIssueRef(record.siteUrl, record.key, typeof record.url === "string" ? record.url : null);
  }
  return null;
}
