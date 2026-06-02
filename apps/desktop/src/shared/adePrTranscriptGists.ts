const MARKER_OPEN_RE = /<!--\s*ade:transcript-gists\s+v=\d+[^>]*-->/i;
const MARKER_CLOSE = "<!-- /ade:transcript-gists -->";
const MARKER_CLOSE_RE = /<!--\s*\/ade:transcript-gists\s*-->/i;
const ADE_LINK_MARKER_OPEN_RE = /<!--\s*ade:link\s+v=\d+[^>]*-->/i;

export type AdePrTranscriptGistLink = {
  title: string;
  url: string;
  provider?: string | null;
  entryCount?: number | null;
};

export function renderAdePrTranscriptGistLinks(links: AdePrTranscriptGistLink[]): string {
  const normalized = links
    .map((link) => ({
      title: normalizeInline(link.title) || "ADE chat transcript",
      url: link.url.trim(),
      provider: normalizeInline(link.provider),
      entryCount: Number.isFinite(Number(link.entryCount)) ? Math.max(0, Math.floor(Number(link.entryCount))) : null,
    }))
    .filter((link) => link.url.length > 0);
  const lines = [
    `<!-- ade:transcript-gists v=1 count=${normalized.length} -->`,
    "## ADE chat transcripts",
    "",
    ...normalized.map((link, index) => {
      const linkTitle = normalized.length === 1
        ? "ADE chat transcripts"
        : `ADE chat transcript ${index + 1}`;
      const details = [
        link.provider,
        link.entryCount != null ? `${link.entryCount} message${link.entryCount === 1 ? "" : "s"}` : null,
      ].filter((value): value is string => Boolean(value));
      return `- [${escapeMarkdownLinkText(linkTitle)}](${escapeMarkdownUrl(link.url)})${details.length ? ` - ${details.map(escapeMarkdownInlineText).join(" | ")}` : ""}`;
    }),
    MARKER_CLOSE,
  ];
  return lines.join("\n");
}

export function ensureAdePrTranscriptGistLinks(body: string, links: AdePrTranscriptGistLink[]): string {
  const normalizedLinks = links.filter((link) => link.url.trim().length > 0);
  const safeBody = typeof body === "string" ? body : "";
  const openIdx = safeBody.search(MARKER_OPEN_RE);
  if (!normalizedLinks.length) {
    if (openIdx < 0) return safeBody;
    const closeMatch = MARKER_CLOSE_RE.exec(safeBody.slice(openIdx));
    if (!closeMatch) return safeBody;
    const before = safeBody.slice(0, openIdx).trimEnd();
    const after = safeBody.slice(openIdx + closeMatch.index + closeMatch[0].length).trimStart();
    return [before, after].filter(Boolean).join("\n\n").trimEnd() + (before || after ? "\n" : "");
  }

  const block = renderAdePrTranscriptGistLinks(normalizedLinks);
  if (openIdx >= 0) {
    const closeMatch = MARKER_CLOSE_RE.exec(safeBody.slice(openIdx));
    if (closeMatch) {
      const before = safeBody.slice(0, openIdx).trimEnd();
      const after = safeBody.slice(openIdx + closeMatch.index + closeMatch[0].length);
      let tail: string;
      if (!after) tail = "";
      else if (after.startsWith("\n")) tail = after;
      else tail = `\n${after}`;
      return `${before}\n\n${block}${tail}`.trimEnd() + "\n";
    }
  }
  const trimmed = safeBody.trimEnd();
  if (!trimmed) return `${block}\n`;
  const adeLinkIdx = safeBody.search(ADE_LINK_MARKER_OPEN_RE);
  if (adeLinkIdx >= 0) {
    const before = safeBody.slice(0, adeLinkIdx).trimEnd();
    const after = safeBody.slice(adeLinkIdx).trimStart();
    return `${before ? `${before}\n\n` : ""}${block}\n\n${after}`.trimEnd() + "\n";
  }
  return `${trimmed}\n\n${block}\n`;
}

export function hasAdePrTranscriptGistLinks(body: string | null | undefined): boolean {
  if (!body) return false;
  return MARKER_OPEN_RE.test(body);
}

function normalizeInline(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function escapeMarkdownInlineText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
