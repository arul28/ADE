/**
 * A provider a plugin's URL matcher speaks for, namespaced by its plugin id.
 *
 * Namespaced rather than bare so a plugin can never be mistaken for a core
 * provider by a reader that only string-compares: every switch in this system
 * has a `default`, and `plugin:acme-jira` takes it.
 */
export type PluginSmartLinkProvider = `plugin:${string}`;

export type SmartLinkProvider =
  | "github"
  | "linear"
  | "ade"
  | "generic"
  | PluginSmartLinkProvider;

export type SmartLinkKind =
  | "github_pr"
  | "github_issue"
  | "github_repo"
  | "github_commit"
  | "github_actions_run"
  | "linear_issue"
  | "ade_deeplink"
  | "plugin_entity"
  | "web_page";

/**
 * What a plugin's URL matcher produced, carried on the preview it made.
 *
 * Every field is data the matcher declared or captured. Nothing here is a
 * handle to the plugin: drawing a chip runs no plugin code, and a client that
 * does not know what to do with a binding still draws the label.
 */
export type SmartLinkPluginBinding = {
  pluginId: string;
  /** The `urlMatchers[].id` that won. */
  matcherId: string;
  /** `ade://plugin/<id>/<panel>` for the panel that draws this record. */
  deeplink: string;
  /** Present when the matcher declares an `entity`. Provider is the matcher's. */
  issue?: { provider: string; key: string } | null;
};

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
  /**
   * One or two characters for the chip's mark slot, when the provider has no
   * compiled-in mark. Text, never markup — see `smartLinkGlyph`.
   */
  glyph?: string | null;
  /** Set when a plugin's declared URL matcher produced this preview. */
  plugin?: SmartLinkPluginBinding | null;
};

/**
 * How a caller offers plugin matchers to the parser.
 *
 * A callback rather than the compiled matchers themselves, so this module stays
 * dependency-free. It is imported by main, preload, the renderer, the web
 * adapter, the browser mock and the CLI's TUI, and only one of those has a
 * plugin registry to read; the rest pass nothing and get exactly today's
 * behaviour.
 */
export type SmartLinkParseOptions = {
  /**
   * Asked once per URL, AFTER every core parser has declined and BEFORE the
   * generic fallback. Must be synchronous and must not fetch: it runs on every
   * keystroke that ends a word in the composer.
   */
  matchPlugin?: (url: URL, rawUrl: string) => SmartLinkPreview | null;
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

/**
 * The preview for one URL.
 *
 * Tiering, and it is the whole ordering rule: core parsers first, then the
 * caller's plugin matchers, then the generic web page. Core is first so a
 * plugin cannot draw over ADE's own GitHub and Linear links — the manifest
 * parser already refuses those hosts, and this is the second half of the same
 * guarantee, enforced where the match actually happens. Generic is last because
 * it never declines, so anything after it would be dead.
 */
export function deriveSmartLinkPreview(
  rawValue: string,
  options?: SmartLinkParseOptions,
): SmartLinkPreview | null {
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
    ?? matchPluginSmartLink(parsed, rawUrl, options)
    ?? {
      url: rawUrl,
      provider: "generic",
      kind: "web_page",
      label: rawUrl,
    };
}

/**
 * The plugin tier, kept behind a guard so a throwing matcher cannot take the
 * composer down. A matcher is compiled from an untrusted manifest, and a chip
 * is drawn inside a keystroke handler.
 */
function matchPluginSmartLink(
  url: URL,
  rawUrl: string,
  options: SmartLinkParseOptions | undefined,
): SmartLinkPreview | null {
  if (!options?.matchPlugin) return null;
  try {
    return options.matchPlugin(url, rawUrl) ?? null;
  } catch {
    return null;
  }
}

export function findSmartLinks(
  text: string,
  limit = 12,
  options?: SmartLinkParseOptions,
): SmartLinkMatch[] {
  if (!text || limit <= 0) return [];
  const matches: SmartLinkMatch[] = [];
  URL_CANDIDATE_RE.lastIndex = 0;
  let candidate: RegExpExecArray | null;
  while ((candidate = URL_CANDIDATE_RE.exec(text)) && matches.length < limit) {
    const preview = deriveSmartLinkPreview(candidate[0], options);
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

/**
 * The text mark for a chip.
 *
 * A plugin's declared glyph wins over the provider default, because a plugin
 * provider has no default worth showing — `smartLinkProviderGlyph` answers "↗"
 * for it, which is the generic web arrow and says nothing about the tracker.
 * Prefer this over `smartLinkProviderGlyph` on any surface that can see a
 * plugin match; the bare provider form stays for callers that only ever hold a
 * provider, such as the TUI's prompt strip.
 */
export function smartLinkGlyph(preview: SmartLinkPreview): string {
  const declared = preview.glyph?.trim();
  return declared || smartLinkProviderGlyph(preview.provider);
}

export function shouldReconcileSmartLinkDraft(
  controlledDraft: string,
  editorDraft: string,
  lastSerializedDraft: string,
): boolean {
  return controlledDraft !== editorDraft && controlledDraft !== lastSerializedDraft;
}
