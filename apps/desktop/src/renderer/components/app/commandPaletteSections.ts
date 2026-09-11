/**
 * The command palette's pure model layer: the ordered section list that drives
 * BOTH the rendered nodes and the flat keyboard index, plus the non-React
 * helpers the palette's rows and detail pane are built from.
 *
 * Nothing here renders or touches React. `CommandPalette.tsx` keeps the JSX.
 */
import type { ProjectDetail, ProjectIcon } from "../../../shared/types";

/**
 * The palette's default list is three sections whose ORDER varies (see
 * `commandsLeadPaletteResults`). Both the rendered nodes and the flat keyboard
 * index are derived from a single ordered array of these, so there is exactly
 * one place that knows what comes first.
 */
export type PaletteSectionKey = "threads" | "commands" | "entities";

export type PaletteSection = { key: PaletteSectionKey; count: number };

export type PaletteSectionsInput = {
  /**
   * True when the query looks like a command title, which flips commands ahead
   * of threads. See `commandsLeadPaletteResults`.
   */
  commandsLead: boolean;
  /** Rows the threads/work-results section will render. */
  threadCount: number;
  /** Rows the commands section will render (the filtered command list). */
  commandCount: number;
  /** Flattened entity rows, including each section's "show more" row. */
  entityCount: number;
};

/**
 * The ONE statement of palette order.
 *
 * Threads lead because the palette is the Work sidebar's search now — with an
 * empty query the thing you most likely came here for is a chat you were just
 * in, not a command. Typing a command's full title flips it.
 *
 * A section with `count === 0` renders nothing and claims no flat indices, so
 * it is kept in the array rather than dropped: presence never shifts an index,
 * and callers can key off a section without checking whether it exists.
 */
export function buildPaletteSections({
  commandsLead,
  threadCount,
  commandCount,
  entityCount,
}: PaletteSectionsInput): PaletteSection[] {
  const threads: PaletteSection = { key: "threads", count: threadCount };
  const commands: PaletteSection = { key: "commands", count: commandCount };
  const entities: PaletteSection = { key: "entities", count: entityCount };
  return commandsLead
    ? [commands, threads, entities]
    : [threads, commands, entities];
}

/** Total number of keyboard-navigable rows across every section. */
export function paletteSectionsTotal(
  sections: readonly PaletteSection[],
): number {
  return sections.reduce((sum, section) => sum + section.count, 0);
}

/**
 * Visit each section in order with the flat index its first row occupies.
 * Sections are visited left to right and the caller never sees the running
 * counter, so a builder cannot be declared in one order and consumed in another.
 */
export function walkPaletteSections<T>(
  sections: readonly PaletteSection[],
  visit: (section: PaletteSection, startIndex: number) => T,
): T[] {
  const out: T[] = [];
  let startIndex = 0;
  for (const section of sections) {
    out.push(visit(section, startIndex));
    startIndex += section.count;
  }
  return out;
}

/** Which section owns a flat index, and where inside it that index lands. */
export function paletteSectionAt(
  sections: readonly PaletteSection[],
  index: number,
): { section: PaletteSection; offset: number } | null {
  let startIndex = 0;
  for (const section of sections) {
    const offset = index - startIndex;
    if (offset >= 0 && offset < section.count) return { section, offset };
    startIndex += section.count;
  }
  return null;
}

export function stripTrailingSeparator(input: string): string {
  if (input.length <= 1) return input;
  if (/^[a-z]:[\\/]$/i.test(input)) return input;
  if (/^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?$/i.test(input)) return input;
  return input.endsWith("/") || input.endsWith("\\")
    ? input.slice(0, -1)
    : input;
}

export function withTrailingSeparator(input: string): string {
  if (input.endsWith("/") || input.endsWith("\\")) return input;
  return `${input}${input.includes("\\") ? "\\" : "/"}`;
}

export function defaultBrowseInput(
  projectRoot: string | null | undefined,
): string {
  return projectRoot ? "../" : "~/";
}

export function pathLabel(input: string | null | undefined): string {
  if (!input) return "";
  const segments = input.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? input;
}

export function relativeFromNow(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function dirtyBreakdownTooltip(
  breakdown: ProjectDetail["dirtyBreakdown"],
): string | undefined {
  if (!breakdown) return undefined;
  const parts: string[] = [];
  if (breakdown.staged > 0) parts.push(`${breakdown.staged} staged`);
  if (breakdown.unstaged > 0) parts.push(`${breakdown.unstaged} unstaged`);
  if (breakdown.untracked > 0) parts.push(`${breakdown.untracked} untracked`);
  return parts.length > 0 ? parts.join(" · ") : "no changes";
}

export const LANGUAGE_SWATCHES: Record<string, string> = {
  TypeScript: "#3178C6",
  JavaScript: "#F7DF1E",
  Python: "#3776AB",
  Rust: "#DE6F1B",
  Go: "#00ADD8",
  Ruby: "#CC342D",
  Java: "#B07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  "Objective-C": "#438EFF",
  "Objective-C++": "#6866FB",
  C: "#555555",
  "C++": "#F34B7D",
  "C#": "#178600",
  PHP: "#4F5D95",
  Lua: "#000080",
  Shell: "#89E051",
  PowerShell: "#012456",
  SQL: "#E38C00",
  HTML: "#E34C26",
  CSS: "#563D7C",
  SCSS: "#C6538C",
  Less: "#1D365D",
  Vue: "#41B883",
  Svelte: "#FF3E00",
  Astro: "#FF5D01",
  JSON: "#8FB1D9",
  YAML: "#CB171E",
  TOML: "#9C4221",
  Markdown: "#A78BFA",
};

// Per-location browse-path memory. The local explorer and each remote target
// have their own filesystem, so a single shared `browseInput` would leak one
// machine's path into another (showing a blank list because the path doesn't
// exist there). Keyed by `locationKey` and persisted across restarts.
const LAST_BROWSE_PATH_STORAGE_KEY = "ade.projectBrowser.lastPath.v1";

export function locationKeyFor(remoteTargetId: string | null): string {
  return remoteTargetId ? `remote:${remoteTargetId}` : "local";
}

function readLastBrowsePathMap(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_BROWSE_PATH_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadLastBrowsePath(locationKey: string): string | null {
  const map = readLastBrowsePathMap();
  const value = map[locationKey];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function saveLastBrowsePath(locationKey: string, path: string): void {
  try {
    if (!globalThis.localStorage) return;
    const map = readLastBrowsePathMap();
    if (map[locationKey] === path) return;
    map[locationKey] = path;
    globalThis.localStorage.setItem(
      LAST_BROWSE_PATH_STORAGE_KEY,
      JSON.stringify(map),
    );
  } catch {
    // Ignore unavailable/quota-exceeded localStorage.
  }
}

// Resolved project icons are stable for a given root path within a session, so
// cache them module-wide to avoid rescanning the disk on every re-highlight.
const PROJECT_ICON_CACHE_MAX = 64;
const PROJECT_ICON_CACHE = new Map<string, ProjectIcon>();

export function cachedProjectIcon(rootPath: string): ProjectIcon | undefined {
  return PROJECT_ICON_CACHE.get(rootPath);
}

export function rememberProjectIcon(rootPath: string, icon: ProjectIcon): void {
  PROJECT_ICON_CACHE.delete(rootPath);
  PROJECT_ICON_CACHE.set(rootPath, icon);
  while (PROJECT_ICON_CACHE.size > PROJECT_ICON_CACHE_MAX) {
    const oldestKey = PROJECT_ICON_CACHE.keys().next().value;
    if (typeof oldestKey !== "string") break;
    PROJECT_ICON_CACHE.delete(oldestKey);
  }
}
