// Slash-command classification and ranking for the composer's `/` menu.
//
// Two problems this fixes:
//   1. The menu filtered with a scattered-letter match and kept the first ten in
//      alphabetical order, so `/test` showed `/app-store-screenshots` and
//      `/asc-testflight-…` and never `/test` itself. Ranking here uses the same
//      tiers as `@` (exact > prefix > word-prefix > substring > scattered).
//   2. The list was one flat block. It now groups into Commands, Skills, and MCP
//      prompts, so a project skill is not buried under provider built-ins.
//
// Classification is best-effort and pure. Providers that know a command's kind
// pass `kind`/`origin`/`server`; otherwise a name pattern fills in: `plugin:x`
// is a plugin skill, any other `server:name` is an MCP prompt from `server`.

export type SlashCommandKind = "command" | "skill" | "mcp";

export type SlashCommandOrigin = "project" | "user" | "plugin" | "provider";

export type ClassifiableSlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Provenance label; desktop uses "sdk" | "local", the TUI "ade" | "user". */
  source?: string;
  kind?: SlashCommandKind;
  origin?: SlashCommandOrigin;
  /** MCP server a prompt belongs to. */
  server?: string;
};

export type SlashCommandClassification = {
  kind: SlashCommandKind;
  origin: SlashCommandOrigin;
  server?: string;
};

/** Strip a leading `/` so names compare without it. */
export function slashCommandBaseName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

export function classifySlashCommand(command: ClassifiableSlashCommand): SlashCommandClassification {
  if (command.kind) {
    return { kind: command.kind, origin: command.origin ?? defaultOrigin(command.kind), server: command.server };
  }
  const base = slashCommandBaseName(command.name);
  const separator = base.indexOf(":");
  if (separator > 0) {
    const prefix = base.slice(0, separator);
    if (prefix === "plugin") {
      return { kind: "skill", origin: "plugin" };
    }
    // `server:prompt` — an MCP prompt grouped under its server.
    return { kind: "mcp", origin: "provider", server: command.server ?? prefix };
  }
  return { kind: "command", origin: command.source === "local" ? "project" : "provider" };
}

function defaultOrigin(kind: SlashCommandKind): SlashCommandOrigin {
  return kind === "skill" ? "project" : "provider";
}

export type ScoredSlashCommand<T extends ClassifiableSlashCommand> = {
  command: T;
  score: number;
};

/** Word-prefix hit: any `-`/`:`/`/`-separated word in the name starts with the query. */
function wordPrefixHit(name: string, loweredQuery: string): boolean {
  if (!loweredQuery.length) return false;
  return name
    .toLowerCase()
    .split(/[-:/_\s]+/)
    .some((word) => word.length > 0 && word.startsWith(loweredQuery));
}

/**
 * Match score for one `/` row, or null when it does not match. Exact 0, prefix
 * or word-prefix 1, substring 2, scattered letters 3.
 */
export function scoreSlashCommand(command: ClassifiableSlashCommand, rawQuery: string): number | null {
  const query = slashCommandBaseName(rawQuery.trim()).toLowerCase();
  if (!query.length) return 0;
  const base = slashCommandBaseName(command.name).toLowerCase();
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (wordPrefixHit(base, query)) return 1;
  if (base.includes(query)) return 2;
  if (subsequenceHit(base, query)) return 3;
  return null;
}

/**
 * Rank `/` rows. Exact beats prefix/word-prefix beats substring; scattered
 * letters are only offered when no row matched better, so `/test` never loses to
 * a long name that merely contains `t…e…s…t`.
 */
export function rankSlashCommands<T extends ClassifiableSlashCommand>(
  commands: T[],
  rawQuery: string,
): T[] {
  if (!rawQuery.trim().length) {
    return [...commands].sort((a, b) => compareSlashCommands(a, b));
  }
  const scored: ScoredSlashCommand<T>[] = [];
  for (const command of commands) {
    const score = scoreSlashCommand(command, rawQuery);
    if (score === null) continue;
    scored.push({ command, score });
  }
  const best = scored.reduce<number | null>((min, row) => (min === null || row.score < min ? row.score : min), null);
  const keepScattered = best !== null && best >= 3;
  const kept = scored.filter((row) => keepScattered || row.score < 3);
  kept.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return compareSlashCommands(a.command, b.command);
  });
  return kept.map((row) => row.command);
}

function subsequenceHit(target: string, loweredQuery: string): boolean {
  let cursor = 0;
  for (const char of loweredQuery) {
    const found = target.indexOf(char, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

/** Stable order: commands, then skills, then MCP; alphabetical within a kind. */
export function compareSlashCommands(a: ClassifiableSlashCommand, b: ClassifiableSlashCommand): number {
  const rank = (command: ClassifiableSlashCommand): number => {
    const kind = classifySlashCommand(command).kind;
    return kind === "command" ? 0 : kind === "skill" ? 1 : 2;
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  const aName = slashCommandBaseName(a.name).toLowerCase();
  const bName = slashCommandBaseName(b.name).toLowerCase();
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

export type SlashCommandSectionKey = "commands" | "skills" | "mcp";

/** The section a command belongs to. */
export function slashCommandSectionKey(command: ClassifiableSlashCommand): SlashCommandSectionKey {
  const kind = classifySlashCommand(command).kind;
  return kind === "skill" ? "skills" : kind === "mcp" ? "mcp" : "commands";
}
