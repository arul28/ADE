export type ReleaseNotesSection = {
  title: string;
  items: string[];
};

export type ReleaseNotesDocument = {
  summary: string;
  sections: ReleaseNotesSection[];
};

function plainText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isSummaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (/^[-*]\s+/.test(trimmed)) return false;
  return true;
}

/** Split intro copy from ## section bodies. Prefer an explicit --- rule; else first ##. */
function splitSummaryAndSections(body: string): { summarySource: string; sectionsSource: string } {
  const divider = body.search(/\r?\n---\r?\n/);
  if (divider !== -1) {
    return {
      summarySource: body.slice(0, divider),
      sectionsSource: body.slice(divider).replace(/^\r?\n---\r?\n/, ""),
    };
  }
  const firstSection = body.search(/\r?\n##\s+/);
  if (firstSection !== -1) {
    return {
      summarySource: body.slice(0, firstSection),
      sectionsSource: body.slice(firstSection),
    };
  }
  return { summarySource: body, sectionsSource: "" };
}

/** The Mintlify changelog page, reduced to the summary and section bullets. */
export function parseReleaseNotesMdx(source: string): ReleaseNotesDocument | null {
  const withoutFrontmatter = source.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
  if (!withoutFrontmatter) return null;
  const { summarySource, sectionsSource } = splitSummaryAndSections(withoutFrontmatter);
  const summary = plainText(summarySource.split(/\r?\n/).filter(isSummaryLine).join(" "));
  const sections: ReleaseNotesSection[] = [];
  let current: ReleaseNotesSection | null = null;
  for (const line of sectionsSource.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading) {
      const title = plainText(heading[1] ?? "");
      current = title ? { title, items: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
    if (bullet && current) {
      const item = plainText(bullet[1] ?? "");
      if (item) current.items.push(item);
    }
  }
  const kept = sections.filter((section) => section.items.length > 0);
  if (!summary && kept.length === 0) return null;
  return { summary, sections: kept };
}
