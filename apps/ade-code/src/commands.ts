import type { AgentChatSlashCommand } from "../../desktop/src/shared/types/chat";

export type CommandPlacement = "inline" | "right" | "overlay" | "chat";

export type BuiltinCommand = {
  name: string;
  description: string;
  placement: CommandPlacement;
  argumentHint?: string;
};

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "/commit", description: "Commit lane changes", placement: "inline", argumentHint: "[message]" },
  { name: "/push", description: "Push the active lane branch", placement: "inline" },
  { name: "/clear", description: "Clear the local terminal transcript view", placement: "inline" },
  { name: "/end", description: "End the active chat runtime", placement: "inline" },
  { name: "/open", description: "Open this ADE context in desktop", placement: "inline" },
  { name: "/quit", description: "Exit ade-code", placement: "inline" },
  { name: "/remember", description: "Write durable ADE memory", placement: "inline", argumentHint: "<fact>" },
  { name: "/new lane", description: "Create a new lane", placement: "right" },
  { name: "/new chat", description: "Create a new chat", placement: "right", argumentHint: "[title]" },
  { name: "/rename", description: "Rename the active chat", placement: "right", argumentHint: "[title]" },
  { name: "/status", description: "Show project, lane, and runtime state", placement: "right" },
  { name: "/diff", description: "Show active lane diff", placement: "right" },
  { name: "/log", description: "Show recent commits", placement: "right" },
  { name: "/pr", description: "Show pull request state", placement: "right" },
  { name: "/pr open", description: "Create or open a PR for the active lane", placement: "right" },
  { name: "/pr review", description: "Show PR reviews", placement: "right" },
  { name: "/pr checks", description: "Show PR checks", placement: "right" },
  { name: "/linear", description: "Run Linear workflow, route, sync, or ingress commands", placement: "right", argumentHint: "<group>" },
  { name: "/linear list", description: "List Linear work", placement: "right" },
  { name: "/linear workflows", description: "List Linear workflow runs", placement: "right" },
  { name: "/linear run", description: "Inspect or resolve a Linear run", placement: "right", argumentHint: "<status|resolve|cancel|reroute>" },
  { name: "/linear route", description: "Route a Linear issue", placement: "right", argumentHint: "<cto|mission|worker>" },
  { name: "/linear sync", description: "Operate Linear sync", placement: "right", argumentHint: "<dashboard|run|queue|resolve|detail>" },
  { name: "/linear ingress", description: "Inspect Linear ingress", placement: "right", argumentHint: "<status|events|webhook>" },
  { name: "/linear pull", description: "Pull a Linear ticket into chat context", placement: "right", argumentHint: "<id>" },
  { name: "/linear comment", description: "Comment on a Linear ticket", placement: "right", argumentHint: "<id> <text>" },
  { name: "/linear status", description: "Show Linear sync status", placement: "right" },
  { name: "/linear assign", description: "Assign a Linear ticket", placement: "right", argumentHint: "<id> <user>" },
  { name: "/memory", description: "Search ADE memory", placement: "right", argumentHint: "[query]" },
  { name: "/forget", description: "Open memory management", placement: "right" },
  { name: "/chats", description: "List chats in the active lane", placement: "right" },
  { name: "/switch", description: "Switch lane or chat", placement: "right", argumentHint: "[lane|chat]" },
  { name: "/resume", description: "Resume the active ended chat", placement: "right" },
  { name: "/help", description: "Show keymap and command help", placement: "right" },
  { name: "/model", description: "Pick the active chat model", placement: "right" },
  { name: "/effort", description: "Pick reasoning effort", placement: "right" },
  { name: "/system", description: "Show system and runtime details", placement: "right" },
  { name: "/ade", description: "Run an allowlisted ADE action", placement: "right", argumentHint: "<domain.action> [json]" },
];

export type ParsedCommand = {
  name: string;
  args: string;
  spec: BuiltinCommand | null;
  userCommand: AgentChatSlashCommand | null;
};

function normalizeSlashName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function parseCommand(input: string, userCommands: AgentChatSlashCommand[] = []): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [first = ""] = trimmed.split(/\s+/, 1);
  const exactLocalCommand = userCommands.find((command) => command.source === "local" && command.name === first) ?? null;
  if (exactLocalCommand) {
    return {
      name: first,
      args: trimmed.slice(first.length).trim(),
      spec: null,
      userCommand: exactLocalCommand,
    };
  }
  const candidates = [...BUILTIN_COMMANDS]
    .sort((left, right) => right.name.length - left.name.length);
  for (const spec of candidates) {
    const name = normalizeSlashName(spec.name);
    if (trimmed === name || trimmed.startsWith(`${name} `)) {
      return {
        name,
        args: trimmed.slice(name.length).trim(),
        spec,
        userCommand: null,
      };
    }
  }

  const userCommand = userCommands.find((command) => command.name === first) ?? null;
  if (userCommand) {
    return {
      name: first,
      args: trimmed.slice(first.length).trim(),
      spec: null,
      userCommand,
    };
  }

  return {
    name: first,
    args: trimmed.slice(first.length).trim(),
    spec: null,
    userCommand: null,
  };
}

export function paletteCommands(
  query: string,
  userCommands: AgentChatSlashCommand[] = [],
): Array<{ name: string; description: string; source: "ade" | "user"; argumentHint?: string }> {
  const normalizedQuery = query.trim().toLowerCase();
  const builtins = BUILTIN_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    source: "ade" as const,
    argumentHint: command.argumentHint,
  }));
  const users = userCommands.map((command) => ({
    name: command.name,
    description: command.description,
    source: "user" as const,
    argumentHint: command.argumentHint,
  }));
  return [...builtins, ...users]
    .filter((command) => {
      if (!normalizedQuery || normalizedQuery === "/") return true;
      return `${command.name} ${command.description}`.toLowerCase().includes(normalizedQuery.replace(/^\//, ""));
    })
    .slice(0, 9);
}

export function commandPlacement(command: ParsedCommand): CommandPlacement {
  if (command.spec) return command.spec.placement;
  if (command.userCommand) return "chat";
  return "chat";
}
