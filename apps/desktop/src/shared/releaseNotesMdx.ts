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

/** The Mintlify changelog page, reduced to the summary and section bullets. */
export function parseReleaseNotesMdx(source: string): ReleaseNotesDocument | null {
  const withoutFrontmatter = source.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
  if (!withoutFrontmatter) return null;
  const divider = withoutFrontmatter.search(/\r?\n---\r?\n/);
  const summarySource = divider === -1 ? withoutFrontmatter : withoutFrontmatter.slice(0, divider);
  const sectionsSource = divider === -1 ? "" : withoutFrontmatter.slice(divider).replace(/^\r?\n---\r?\n/, "");
  const summary = plainText(summarySource.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")).join(" "));
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
