type UpsertByHeadingArgs = {
  content: string;
  heading: string; // e.g. "## Narrative"
  startMarker: string;
  endMarker: string;
  body: string;
};

export type SectionLocator =
  | { id: string; kind: "markers"; startMarker: string; endMarker: string }
  | { id: string; kind: "heading"; heading: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findLineEnd(content: string, fromIndex: number): number {
  const idx = content.indexOf("\n", fromIndex);
  return idx >= 0 ? idx + 1 : content.length;
}

function findNextIndex(content: string, regex: RegExp, fromIndex: number): number {
  let flags = regex.flags;
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("m")) flags += "m";
  const re = new RegExp(regex.source, flags);
  re.lastIndex = Math.max(0, fromIndex);
  const match = re.exec(content);
  return match ? match.index : -1;
}

export function extractBetweenMarkers(content: string, startMarker: string, endMarker: string): string | null {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
  const body = content.slice(startIdx + startMarker.length, endIdx).trim();
  return body.length ? body : "";
}

export function replaceBetweenMarkers(args: {
  content: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): { content: string; changed: boolean } {
  const startIdx = args.content.indexOf(args.startMarker);
  const endIdx = args.content.indexOf(args.endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    return { content: args.content, changed: false };
  }

  const before = args.content.slice(0, startIdx + args.startMarker.length);
  const after = args.content.slice(endIdx);
  const nextBody = args.body.trim();
  const updated = `${before}\n${nextBody}\n${after}`;
  return { content: updated, changed: updated !== args.content };
}

export function upsertSectionByHeading(args: UpsertByHeadingArgs): { content: string; insertedMarkers: boolean } {
  // First preference: marker-based replacement.
  const replaced = replaceBetweenMarkers({
    content: args.content,
    startMarker: args.startMarker,
    endMarker: args.endMarker,
    body: args.body
  });
  if (replaced.changed || (args.content.includes(args.startMarker) && args.content.includes(args.endMarker))) {
    return { content: replaced.content, insertedMarkers: false };
  }

  // Upgrade older packs: insert markers inside an existing heading section.
  const headingRe = new RegExp(`^${escapeRegExp(args.heading)}\\s*$`, "m");
  const match = headingRe.exec(args.content);
  if (match?.index != null) {
    const headingStart = match.index;
    const headingLineEnd = findLineEnd(args.content, headingStart);

    const nextHeadingIdx = findNextIndex(args.content, /^##\s+/gm, headingLineEnd);
    const nextHrIdx = findNextIndex(args.content, /^---\s*$/gm, headingLineEnd);

    const candidates = [nextHeadingIdx, nextHrIdx].filter((idx) => idx >= 0);
    const sectionEnd = candidates.length ? Math.min(...candidates) : args.content.length;

    const before = args.content.slice(0, headingLineEnd);
    const after = args.content.slice(sectionEnd);
    const body = args.body.trim();
    const updated = `${before}${args.startMarker}\n${body}\n${args.endMarker}\n${after}`;
    return { content: updated, insertedMarkers: true };
  }

  // If the heading doesn't exist, append a new section at the end.
  const trimmed = args.content.trimEnd();
  const body = args.body.trim();
  const suffix = `${args.heading}\n${args.startMarker}\n${body}\n${args.endMarker}\n`;
  const updated = trimmed.length ? `${trimmed}\n\n${suffix}` : `${suffix}`;
  return { content: updated, insertedMarkers: true };
}

export function extractSectionByHeading(content: string, heading: string): string | null {
  const headingRe = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingRe.exec(content);
  if (!match?.index && match?.index !== 0) return null;

  const headingStart = match.index;
  const headingLineEnd = findLineEnd(content, headingStart);

  const nextHeadingIdx = findNextIndex(content, /^##\s+/gm, headingLineEnd);
  const nextHrIdx = findNextIndex(content, /^---\s*$/gm, headingLineEnd);
  const candidates = [nextHeadingIdx, nextHrIdx].filter((idx) => idx >= 0);
  const sectionEnd = candidates.length ? Math.min(...candidates) : content.length;

  const body = content.slice(headingLineEnd, sectionEnd).trim();
  return body.length ? body : "";
}

export function extractSectionContent(content: string, locator: SectionLocator): string | null {
  if (locator.kind === "markers") return extractBetweenMarkers(content, locator.startMarker, locator.endMarker);
  if (locator.kind === "heading") return extractSectionByHeading(content, locator.heading);
  return null;
}

export function computeSectionChanges(args: {
  before: string | null;
  after: string;
  locators: SectionLocator[];
}): Array<{ sectionId: string; changeType: "added" | "removed" | "modified" }> {
  const norm = (value: string | null): string | null => {
    if (value == null) return null;
    return String(value).replace(/\r\n/g, "\n").trim();
  };

  const beforeContent = args.before ?? "";
  const out: Array<{ sectionId: string; changeType: "added" | "removed" | "modified" }> = [];

  for (const locator of args.locators) {
    const a = norm(extractSectionContent(beforeContent, locator));
    const b = norm(extractSectionContent(args.after, locator));

    if (a == null && b == null) continue;
    if (a == null && b != null) {
      out.push({ sectionId: locator.id, changeType: "added" });
      continue;
    }
    if (a != null && b == null) {
      out.push({ sectionId: locator.id, changeType: "removed" });
      continue;
    }
    if (a !== b) out.push({ sectionId: locator.id, changeType: "modified" });
  }

  return out;
}

export function renderJsonSection(heading: string, value: unknown, opts: { pretty?: boolean } = {}): string[] {
  const pretty = opts.pretty !== false;
  let json = "";
  try {
    json = pretty ? JSON.stringify(value ?? null, null, 2) : JSON.stringify(value ?? null);
  } catch {
    json = pretty
      ? JSON.stringify({ error: "Failed to serialize JSON section." }, null, 2)
      : JSON.stringify({ error: "Failed to serialize JSON section." });
  }
  return [heading, "```json", json, "```", ""];
}
