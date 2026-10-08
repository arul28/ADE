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
  | { provider: "github"; owner: string; repo: string; number: number; url?: string | null };

export type IssueProvider = IssueRef["provider"];

const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-\d+$/;

export function normalizeLinearIdentifier(value: string | null | undefined): string | null {
  const identifier = value?.trim().toUpperCase() ?? "";
  return LINEAR_IDENTIFIER_RE.test(identifier) ? identifier : null;
}

export function linearIssueRef(identifier: string, url?: string | null): IssueRef | null {
  const normalized = normalizeLinearIdentifier(identifier);
  return normalized ? { provider: "linear", identifier: normalized, url: url ?? null } : null;
}

/** Stable identity for a ref: the key of a tab, a cache entry, a dedupe set. */
export function issueRefKey(ref: IssueRef): string {
  if (ref.provider === "linear") return `linear:${ref.identifier}`;
  return `github:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

/** What a person calls the issue: `ADE-123`, or `#123` for GitHub. */
export function issueRefLabel(ref: IssueRef): string {
  return ref.provider === "linear" ? ref.identifier : `#${ref.number}`;
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
  return null;
}
