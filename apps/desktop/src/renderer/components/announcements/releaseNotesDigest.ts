import { bundledReleaseNotes } from "../../../shared/bundledReleaseNotes";
import { parseReleaseNotesMdx } from "../../../shared/releaseNotesMdx";
import { compareUpdateVersions } from "../../../shared/updateVersions";

/**
 * The release notes for the "And more" page: every bundled version after the
 * one the user updated from, up to this one, merged into one list per
 * section. The release skill writes the notes; any `## Section` it uses shows.
 */

export type ReleaseNotesDigestSection = {
  title: string;
  /** Bullets with their inline markdown kept (code, bold, links, "(#123)"). */
  items: string[];
};

export type ReleaseNotesDigest = {
  /** The version now running. */
  version: string;
  /** The version the update replaced, when known. */
  fromVersion: string | null;
  /** The newest version's own one-line summary. */
  summary: string;
  sections: ReleaseNotesDigestSection[];
  /** How many versions the digest covers. */
  versionCount: number;
  /** Older versions the user skipped that are not bundled; the full changelog has them. */
  truncated: boolean;
};

const ALIASES: Record<string, string> = {
  new: "New",
  "new features": "New",
  added: "New",
  improved: "Improved",
  improvements: "Improved",
  changed: "Improved",
  fixed: "Fixed",
  fixes: "Fixed",
  "bug fixes": "Fixed",
};

/** Lead with what is new, end with fixes and the per-platform sections. */
function rank(title: string): number {
  const key = title.toLowerCase();
  if (key === "new") return 0;
  if (key === "improved") return 1;
  if (key === "fixed") return 3;
  if (/^(ios|iphone|ipad|windows|macos|mac|linux|web)$/.test(key)) return 4;
  return 2;
}

function canonicalTitle(title: string): string {
  return ALIASES[title.trim().toLowerCase()] ?? title.trim();
}

export function releaseNotesDigest(version: string | null, fromVersion: string | null = null): ReleaseNotesDigest | null {
  if (!version) return null;
  const entries = bundledReleaseNotes.history
    // With no version to come from (Help › What's new), this version's notes only.
    .filter((entry) => fromVersion
      ? compareUpdateVersions(entry.version, version) <= 0 && compareUpdateVersions(entry.version, fromVersion) > 0
      : compareUpdateVersions(entry.version, version) === 0)
    .sort((a, b) => compareUpdateVersions(b.version, a.version));
  if (entries.length === 0) return null;

  const sections = new Map<string, ReleaseNotesDigestSection>();
  let summary = "";
  for (const entry of entries) {
    const doc = parseReleaseNotesMdx(entry.markdown, { keepInline: true });
    if (!doc) continue;
    if (!summary) summary = doc.summary;
    for (const section of doc.sections) {
      const title = canonicalTitle(section.title);
      const key = title.toLowerCase();
      const merged = sections.get(key) ?? { title, items: [] };
      // A release can carry an earlier one's notes again (v1.2.125 repeats
      // v1.2.124's, which most computers never got to see): list each once.
      for (const item of section.items) {
        if (!merged.items.includes(item)) merged.items.push(item);
      }
      sections.set(key, merged);
    }
  }
  const ordered = [...sections.values()]
    .map((section, index) => ({ section, index }))
    .sort((a, b) => rank(a.section.title) - rank(b.section.title) || a.index - b.index)
    .map(({ section }) => section);
  if (ordered.length === 0 && !summary) return null;

  const bundledOldest = bundledReleaseNotes.history[bundledReleaseNotes.history.length - 1]!.version;
  return {
    version,
    fromVersion,
    summary,
    sections: ordered,
    versionCount: entries.length,
    // The user came from before the oldest bundled version: the full changelog has the rest.
    truncated: Boolean(fromVersion && compareUpdateVersions(fromVersion, bundledOldest) < 0),
  };
}
