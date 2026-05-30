import {
  BUILTIN_COMMANDS,
  COMMAND_CATEGORY_ORDER,
  type BuiltinCommand,
  type CommandCategory,
} from "./commands";
import type { ClaudeKeybinding, TuiKeybindingAction } from "./keybindings";

/**
 * helpIndex — pure grouping / filtering / ranking logic for the /help command
 * reference pane. Kept render-free and dependency-light so it is unit-testable
 * in isolation (see __tests__/helpIndex.test.ts). app.tsx feeds the resulting
 * {@link HelpGroup}[] into the RightPaneContent `help` variant, and RightPane.tsx
 * renders it.
 */

export type HelpRow = {
  /** Slash command name, e.g. "/commit". */
  name: string;
  description: string;
  /** Display keybind ("Ctrl+P") or undefined when the command has no binding. */
  keybind?: string;
  source: "ade" | "user";
  category: CommandCategory;
};

export type HelpGroup = {
  category: CommandCategory;
  rows: HelpRow[];
};

const UNCATEGORIZED: CommandCategory = "System";

/**
 * A handful of slash commands open a surface that is *also* reachable via a
 * global keybinding. The keybindings registry (Claude-config) is keyed by
 * app-level action, not by command name, so we map the relevant commands onto
 * their action here. Commands absent from this map render without a keybind chip
 * (the common case). Actions must be members of {@link TuiKeybindingAction}.
 */
const COMMAND_KEYBIND_ACTION: Partial<Record<string, TuiKeybindingAction>> = {
  "/help": "app:help",
  "/clear": "app:clear",
  "/quit": "app:quit",
  "/model": "chat:modelPicker",
  "/undo": "chat:undo",
  "/agents": "pane:agents",
};

/**
 * Format a normalized chord (e.g. "ctrl+p", "shift+tab", "ctrl+o ctrl+m") for
 * display in a keybind chip: capitalize each modifier/key segment.
 */
export function formatChordForDisplay(chord: string): string {
  return chord
    .split(" ")
    .map((stroke) =>
      stroke
        .split("+")
        .map((part) => (part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
        .join("+"),
    )
    .join(" ");
}

/**
 * Resolve the display keybind for a command from the live keybindings registry,
 * or undefined when the command is not bound to any global action. Degrades to
 * undefined (never throws) when the registry is empty/missing — which is the
 * default, since ADE ships no in-code default bindings (the Claude keybindings
 * file is opt-in). The first matching, implemented binding wins.
 */
export function getKeybindForCommand(
  name: string,
  bindings: readonly ClaudeKeybinding[] | null | undefined,
): string | undefined {
  if (!bindings || bindings.length === 0) return undefined;
  const action = COMMAND_KEYBIND_ACTION[name];
  if (!action) return undefined;
  const match = bindings.find((binding) => binding.implemented && binding.action === action && Boolean(binding.key));
  return match ? formatChordForDisplay(match.key) : undefined;
}

/**
 * Partition the built-in commands into ordered, non-empty category groups.
 * Category order follows {@link COMMAND_CATEGORY_ORDER}; commands without an
 * explicit category fall into the trailing "System" bucket. Optionally enriches
 * each row with its bound keybind chip from the live registry.
 */
export function buildHelpIndex(
  commands: readonly BuiltinCommand[] = BUILTIN_COMMANDS,
  bindings?: readonly ClaudeKeybinding[] | null,
): HelpGroup[] {
  const byCategory = new Map<CommandCategory, HelpRow[]>();
  for (const category of COMMAND_CATEGORY_ORDER) byCategory.set(category, []);

  for (const command of commands) {
    const category = command.category ?? UNCATEGORIZED;
    const bucket = byCategory.get(category) ?? byCategory.get(UNCATEGORIZED)!;
    bucket.push({
      name: command.name,
      description: command.description,
      keybind: getKeybindForCommand(command.name, bindings),
      source: "ade",
      category,
    });
  }

  const groups: HelpGroup[] = [];
  for (const category of COMMAND_CATEGORY_ORDER) {
    const rows = byCategory.get(category)!;
    if (rows.length > 0) groups.push({ category, rows });
  }
  return groups;
}

/**
 * Fuzzy subsequence test (same semantics as app.tsx's palette fuzzy matcher):
 * does every char of `needle` appear in `haystack` in order?
 */
function fuzzySubsequence(haystack: string, needle: string): boolean {
  let hi = 0;
  let ni = 0;
  while (hi < haystack.length && ni < needle.length) {
    if (haystack[hi] === needle[ni]) ni += 1;
    hi += 1;
  }
  return ni === needle.length;
}

/**
 * Score a help row against a query, mirroring app.tsx's palette ranking so the
 * help pane ranks consistently with the command palette:
 *   exact name 1000 · name prefix 500 · per-token name 100 · desc 40 · fuzzy 20.
 * A token that matches nowhere disqualifies the row (returns -1). Empty query
 * returns 0 (no ranking signal — caller falls back to recents + alphabetical).
 */
export function helpMatchScore(query: string, row: HelpRow): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const name = row.name.toLowerCase();
  const desc = row.description.toLowerCase();
  if (name === normalizedQuery || name === `/${normalizedQuery}`) return 1000;
  if (name.startsWith(normalizedQuery) || name.startsWith(`/${normalizedQuery}`)) return 500;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 100;
    else if (desc.includes(token)) score += 40;
    else if (fuzzySubsequence(name, token)) score += 20;
    else return -1;
  }
  return score;
}

/**
 * Apply the live filter, fuzzy ranking, and recents floatation to the indexed
 * groups, returning a fresh set of groups (empty groups dropped).
 *
 * Ranking within each group:
 *   1. recents first (most-recent wins), then
 *   2. higher fuzzy score, then
 *   3. alphabetical by name.
 * With an empty filter every command is kept (score 0) so the pane shows the
 * full reference; recents still float to the top of their group.
 */
export function buildHelpRows(
  groups: readonly HelpGroup[],
  filterQuery: string,
  recents: readonly string[] = [],
): HelpGroup[] {
  const query = filterQuery.trim();
  // recents[0] is most-recent ⇒ give it the highest rank weight.
  const recentRank = new Map<string, number>();
  recents.forEach((name, index) => {
    if (!recentRank.has(name)) recentRank.set(name, recents.length - index);
  });

  const result: HelpGroup[] = [];
  for (const group of groups) {
    const scored: Array<{ row: HelpRow; score: number; recent: number }> = [];
    for (const row of group.rows) {
      const score = helpMatchScore(query, row);
      if (query && score < 0) continue; // token didn't match anywhere
      scored.push({ row, score, recent: recentRank.get(row.name) ?? 0 });
    }
    scored.sort((a, b) => {
      if (a.recent !== b.recent) return b.recent - a.recent;
      if (a.score !== b.score) return b.score - a.score;
      return a.row.name.localeCompare(b.row.name);
    });
    if (scored.length > 0) {
      result.push({ category: group.category, rows: scored.map((entry) => entry.row) });
    }
  }
  return result;
}

/**
 * Flatten grouped rows into the linear navigation order (group order preserved,
 * rows in their ranked order) so ↑↓ can index a single list and the renderer can
 * map a flat index back to a row.
 */
export function flattenHelpRows(groups: readonly HelpGroup[]): HelpRow[] {
  const flat: HelpRow[] = [];
  for (const group of groups) flat.push(...group.rows);
  return flat;
}

/**
 * Push a command name onto the front of a recents list (most-recent-first),
 * de-duplicating and capping length. Pure — returns a new array.
 */
export function pushRecent(recents: readonly string[], name: string, limit = 5): string[] {
  const next = [name, ...recents.filter((existing) => existing !== name)];
  return next.slice(0, limit);
}
