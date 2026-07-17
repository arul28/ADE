export type SmartLinkProvider = "github" | "linear" | "ade" | "generic";

export type SmartLinkKind =
  | "github_pr"
  | "github_issue"
  | "github_repo"
  | "github_commit"
  | "github_actions_run"
  | "linear_issue"
  | "ade_deeplink"
  | "web_page";

export type SmartLinkPreview = {
  url: string;
  provider: SmartLinkProvider;
  kind: SmartLinkKind;
  /** Compact, deterministic label available without network access. */
  label: string;
  /** Best-effort remote title. The canonical URL remains the source of truth. */
  title?: string | null;
  /** Sanitized, bounded image payload returned by the ADE runtime. */
  iconDataUrl?: string | null;
};

export type SmartLinkMatch = SmartLinkPreview & {
  start: number;
  end: number;
};

const URL_CANDIDATE_RE = /(?:https?:\/\/|ade:\/\/)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":"]);

function trimTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1]!)) end -= 1;

  const balancedPairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of balancedPairs) {
    while (end > 0 && value[end - 1] === close) {
      const candidate = value.slice(0, end);
      const opens = candidate.split(open).length - 1;
      const closes = candidate.split(close).length - 1;
      if (closes <= opens) break;
      end -= 1;
    }
  }
  return value.slice(0, end);
}

function titleFromSlug(slug: string | undefined): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(slug ?? "");
    } catch {
      return slug ?? "";
    }
  })();
  const normalized = decoded.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || /^\d+$/.test(normalized)) return null;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function parseGithubLink(url: URL, rawUrl: string): SmartLinkPreview | null {
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return { url: rawUrl, provider: "github", kind: "github_repo", label: rawUrl };
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  const repoLabel = `${owner}/${repo}`;
  const section = parts[2]?.toLowerCase();
  const numericId = parts[3] && /^\d+$/.test(parts[3]) ? parts[3] : null;

  if (section === "pull" && numericId) {
    return { url: rawUrl, provider: "github", kind: "github_pr", label: `${repoLabel}#${numericId}` };
  }
  if (section === "issues" && numericId) {
    return { url: rawUrl, provider: "github", kind: "github_issue", label: `${repoLabel}#${numericId}` };
  }
  if (section === "commit" && parts[3]) {
    return { url: rawUrl, provider: "github", kind: "github_commit", label: `${repoLabel}@${parts[3].slice(0, 7)}` };
  }
  if (section === "actions" && parts[3] === "runs" && parts[4]) {
    return { url: rawUrl, provider: "github", kind: "github_actions_run", label: `${repoLabel} · run ${parts[4]}` };
  }
  return { url: rawUrl, provider: "github", kind: "github_repo", label: repoLabel };
}

function parseLinearLink(url: URL, rawUrl: string): SmartLinkPreview | null {
  if (url.hostname.toLowerCase() !== "linear.app") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const issueIndex = parts.findIndex((part) => part.toLowerCase() === "issue");
  const identifier = issueIndex >= 0 ? parts[issueIndex + 1]?.toUpperCase() : null;
  if (!identifier || !/^[A-Z][A-Z0-9]+-\d+$/.test(identifier)) return null;
  return {
    url: rawUrl,
    provider: "linear",
    kind: "linear_issue",
    label: identifier,
    title: titleFromSlug(parts[issueIndex + 2]),
  };
}

export function deriveSmartLinkPreview(rawValue: string): SmartLinkPreview | null {
  const rawUrl = trimTrailingUrlPunctuation(rawValue.trim());
  if (!rawUrl) return null;
  if (/^ade:\/\//i.test(rawUrl)) {
    try {
      const parsed = new URL(rawUrl);
      const target = [parsed.hostname, ...parsed.pathname.split("/").filter(Boolean)].filter(Boolean).join("/");
      return {
        url: rawUrl,
        provider: "ade",
        kind: "ade_deeplink",
        label: target ? `ADE · ${target}` : "ADE link",
      };
    } catch {
      return null;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  return parseGithubLink(parsed, rawUrl)
    ?? parseLinearLink(parsed, rawUrl)
    ?? {
      url: rawUrl,
      provider: "generic",
      kind: "web_page",
      label: rawUrl,
    };
}

export function findSmartLinks(text: string, limit = 12): SmartLinkMatch[] {
  if (!text || limit <= 0) return [];
  const matches: SmartLinkMatch[] = [];
  URL_CANDIDATE_RE.lastIndex = 0;
  let candidate: RegExpExecArray | null;
  while ((candidate = URL_CANDIDATE_RE.exec(text)) && matches.length < limit) {
    const preview = deriveSmartLinkPreview(candidate[0]);
    if (!preview) continue;
    matches.push({
      ...preview,
      start: candidate.index,
      end: candidate.index + preview.url.length,
    });
  }
  return matches;
}

export function smartLinkDisplayLabel(preview: SmartLinkPreview): string {
  if (preview.provider === "generic" && preview.title?.trim()) return preview.title.trim();
  return preview.label;
}

export function smartLinkProviderGlyph(provider: SmartLinkProvider): string {
  if (provider === "github") return "GH";
  if (provider === "linear") return "L";
  if (provider === "ade") return "A";
  return "↗";
}

export function shouldReconcileSmartLinkDraft(
  controlledDraft: string,
  editorDraft: string,
  lastSerializedDraft: string,
): boolean {
  return controlledDraft !== editorDraft && controlledDraft !== lastSerializedDraft;
}
