/** Shared utilities and types for context/docs renderer surfaces. */

/** Returns a human-readable relative time for a timestamp (or "never" if null). */
export function relativeTime(ts: string | null | undefined): string {
  if (!ts) return "never";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/** Truncate a string to `size` characters; returns "-" for empty/null. */
export function shortId(value: string | null | undefined, size = 10): string {
  const raw = (value ?? "").trim();
  if (!raw) return "-";
  return raw.length > size ? raw.slice(0, size) : raw;
}

/** Regex to strip internal ADE markers from pack body. */
export const INTERNAL_PACK_MARKER_RE = /^\s*<!--\s*ADE_[A-Z0-9_:-]+\s*-->\s*$/gm;

/** Regex to extract a JSON code fence from pack body. */
export const JSON_FENCE_RE = /^```json\s*\n([\s\S]*?)\n```/m;

/** A parsed markdown section from a pack body. */
export type PackSection = {
  heading: string;
  level: number;
  content: string;
  lines: string[];
};

/** Parse a raw pack body into a JSON header and markdown sections. */
export function parsePackBody(rawBody: string): { header: Record<string, unknown> | null; sections: PackSection[] } {
  let body = rawBody.replace(INTERNAL_PACK_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();

  let header: Record<string, unknown> | null = null;
  const jsonMatch = body.match(JSON_FENCE_RE);
  if (jsonMatch?.[1]) {
    try { header = JSON.parse(jsonMatch[1]); } catch { /* ignore */ }
    body = body.replace(JSON_FENCE_RE, "").trimStart();
  }

  const lines = body.split("\n");
  const sections: PackSection[] = [];
  let current: PackSection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { heading: headingMatch[2].trim(), level: headingMatch[1].length, content: "", lines: [] };
    } else if (current) {
      current.lines.push(line);
      current.content += line + "\n";
    } else if (line.trim()) {
      current = { heading: "", level: 0, content: line + "\n", lines: [line] };
    }
  }
  if (current) sections.push(current);

  return { header, sections };
}
