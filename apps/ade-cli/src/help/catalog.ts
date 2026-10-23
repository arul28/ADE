import { ADE_BANNER } from "./banner";

export type HelpCatalogCommand = {
  name: string;
  aliases: string[];
  summary: string;
  usage: string[];
  subcommands?: readonly string[] | null;
};

export type HelpCatalog = {
  version: string;
  scope?: "read" | "write";
  commands?: HelpCatalogCommand[];
  command?: HelpCatalogCommand;
};

type CommandAvailability = {
  command: string;
  allowed: boolean;
  subcommands: readonly string[] | null;
};

type Availability = (topic: string, scope: "read" | "write") => CommandAvailability;

type HelpCatalogOptions = {
  version: string;
  pages: Readonly<Record<string, string>>;
  aliases: Readonly<Record<string, string>>;
  topic?: string | null;
  scope?: "read" | "write";
  availability?: Availability;
};

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;

/**
 * Whether a usage line (`ade lanes create|archive …`, with or without `$ `)
 * names something the scope can run. Global flags before the command are
 * skipped; `a|b` alternatives count when any one of them is available.
 */
export function usageLineAvailable(line: string, scope: "read" | "write", availability: Availability): boolean {
  // A help page's line ends in a description column after a wide gap.
  const usage = line.trim().replace(/^\$\s*/, "").replace(/\s{2,}.*$/, "");
  const tokens = usage.replace(/^ade\s+/, "").split(/\s+/);
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index]!;
    index += 1;
    const takesValue = !option.includes("=") && tokens[index] !== undefined && !tokens[index]!.startsWith("-");
    if (takesValue && !COMMAND_WORD.test(tokens[index]!)) index += 1;
  }
  const command = tokens[index];
  if (!command || !COMMAND_WORD.test(command)) return true;
  // The whole line is checked, flags included: `chat wait <id> --async` is
  // refused at read only even though `chat wait` is not.
  const alternatives = (tokens[index + 1] ?? "").split("|").filter((word) => COMMAND_WORD.test(word));
  if (alternatives.length === 0) return availability(tokens.slice(index).join(" "), scope).allowed;
  const rest = tokens.slice(index + 2);
  return alternatives.some((sub) => availability([command, sub, ...rest].join(" "), scope).allowed);
}

/** Drops the `$ ade …` lines of a help page that the scope cannot run. */
export function filterHelpTextForScope(text: string, scope: "read" | "write", availability: Availability): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\$ ade\s+/.test(line) || usageLineAvailable(line, scope, availability))
    .join("\n");
}

/** Builds the agent-facing view from the same pages that power `ade help`. */
export function createHelpCatalog(options: HelpCatalogOptions): HelpCatalog | null {
  const scope = options.scope;
  const rows = Object.entries(options.pages).map(([name, page]) => {
    const root = name.split(" ")[0]!;
    const rowAliases = Object.entries(options.aliases)
      .filter(([alias, target]) => target === root && alias !== root)
      .map(([alias]) => alias)
      .filter((alias) => !scope || options.availability?.(alias, scope).allowed);
    const row: HelpCatalogCommand = {
      name,
      aliases: rowAliases,
      ...parseHelpPage(page),
    };
    if (scope && options.availability) {
      const availability = options.availability(name, scope);
      row.subcommands = availability.subcommands;
      const check = options.availability;
      row.usage = row.usage.filter((line) => usageLineAvailable(line, scope, check));
    }
    return row;
  });

  const commands = scope
    ? rows.filter((row) => options.availability?.(row.name, scope).allowed)
    : rows;
  const catalog: HelpCatalog = { version: options.version };
  if (scope) catalog.scope = scope;

  if (options.topic == null) {
    catalog.commands = commands;
    return catalog;
  }

  const key = resolveHelpTopic(options.topic, options.pages, options.aliases);
  if (!key) return null;
  const row = rows.find((candidate) => candidate.name === key);
  if (!row || (scope && !options.availability?.(row.name, scope).allowed)) {
    return null;
  }
  catalog.command = row;
  return catalog;
}

function resolveHelpTopic(
  topic: string,
  pages: Readonly<Record<string, string>>,
  aliases: Readonly<Record<string, string>>,
): string | null {
  const words = topic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  words[0] = aliases[words[0]!] ?? words[0]!;
  const normalized = words.join(" ");
  if (Object.hasOwn(pages, normalized)) return normalized;
  if (words.length === 1 && Object.hasOwn(pages, words[0]!)) return words[0]!;
  return null;
}

function parseHelpPage(page: string): Pick<HelpCatalogCommand, "summary" | "usage"> {
  const withoutBanner = page.startsWith(ADE_BANNER) ? page.slice(ADE_BANNER.length) : page;
  const lines = withoutBanner.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  const bodyLines = titleIndex < 0 ? [] : lines.slice(titleIndex + 1);
  const paragraph: string[] = [];
  let started = false;
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("$ ade")) {
      if (started && !trimmed) break;
      continue;
    }
    started = true;
    paragraph.push(trimmed);
  }
  const body = paragraph.join(" ");
  const sentenceEnd = body.search(/[.!?](?:\s|$)/);
  const summary = sentenceEnd >= 0 ? body.slice(0, sentenceEnd + 1) : body;
  const usage = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("$ ade"))
    .map((line) => line.slice(2).replace(/\s{2,}.*$/, "").trim());
  return { summary, usage };
}
