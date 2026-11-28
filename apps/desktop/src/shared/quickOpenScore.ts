import type { FilesQuickOpenItem } from "./types/files";

/**
 * Quick open's path ranking, in one place for every caller: a machine's own
 * file index (`fileSearchIndexService.ts`) and the file names an ADE Cloud
 * computer saved before it slept (`cloudMentionSnapshot.ts`), so the `@` menu
 * lists the same files asleep as awake.
 */

/** Starting score for the empty-query browse ranking; one point per path segment is deducted. */
const BROWSE_BASE_SCORE = 100;

/**
 * Empty query browses the workspace: rank shallower paths first. Both
 * separators count so Windows-style paths depth-rank identically.
 */
function scoreBrowseDepth(normalizedPath: string): number {
  let depth = 0;
  for (const ch of normalizedPath) if (ch === "/" || ch === "\\") depth += 1;
  return Math.max(1, BROWSE_BASE_SCORE - depth);
}

function scorePathForNeedle(normalized: string, needle: string): number {
  if (normalized === needle) return 1000;
  if (normalized.endsWith(`/${needle}`) || normalized.endsWith(`\\${needle}`)) return 900;
  const idx = normalized.indexOf(needle);
  return idx < 0 ? -1 : 600 - idx;
}

/** A path's score for a query; negative when it does not match. */
export function scoreQuickOpenPath(pathValue: string, query: string, allowComposerPrefixFallback: boolean): number {
  const normalized = pathValue.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return scoreBrowseDepth(normalized);
  const directScore = scorePathForNeedle(normalized, needle);
  if (directScore >= 0) return directScore;

  if (!allowComposerPrefixFallback) return -1;

  // Composer @-file queries can contain ordinary prose after an extensionless
  // path whose filename or directory contains spaces. A path index cannot
  // know that boundary from the string alone, so try progressively shorter
  // space-delimited prefixes and keep the longest matching one. This is kept
  // behind an explicit composer-only mode so generic quick-open searches keep
  // their whole-query semantics.
  const isRootLevelPath = !normalized.includes("/") && !normalized.includes("\\");
  const words = needle.split(/[ \t]+/);
  let best = -1;
  for (let end = words.length - 1; end > 0; end -= 1) {
    const prefix = words.slice(0, end).join(" ");
    const score = isRootLevelPath
      ? (normalized.startsWith(prefix) ? 600 : -1)
      : scorePathForNeedle(normalized, prefix);
    if (score < 0) continue;
    // Prefer a longer path prefix when multiple indexed paths share the same
    // beginning. The tiny fractional tie-break preserves existing score tiers.
    best = Math.max(best, score + Math.min(prefix.length, 999) / 1000);
  }
  return best;
}

/** Files, then folders when asked, ranked best first (equal scores by path). */
export function rankQuickOpenPaths(args: {
  files: Iterable<string>;
  directories?: Iterable<string>;
  query: string;
  limit: number;
  allowComposerPrefixFallback?: boolean;
  includeDirectories?: boolean;
}): FilesQuickOpenItem[] {
  const fallback = Boolean(args.allowComposerPrefixFallback);
  const scored: FilesQuickOpenItem[] = [];
  for (const path of args.files) {
    const score = scoreQuickOpenPath(path, args.query, fallback);
    if (score >= 0) scored.push({ path, score });
  }
  if (args.includeDirectories && args.directories) {
    for (const path of args.directories) {
      const score = scoreQuickOpenPath(path, args.query, fallback);
      if (score >= 0) scored.push({ path, score, isDirectory: true });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, Math.max(0, args.limit));
}
