import type { AgentChatProvider, AgentChatSlashCommand } from "../../../desktop/src/shared/types/chat";

export type CommandPlacement = "inline" | "right" | "overlay" | "chat";

export type BuiltinCommand = {
  name: string;
  description: string;
  placement: CommandPlacement;
  argumentHint?: string;
  providers?: AgentChatProvider[];
};

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "/commit", description: "Commit lane changes", placement: "inline", argumentHint: "[message]" },
  { name: "/push", description: "Push the active lane branch", placement: "inline" },
  { name: "/pull", description: "Pull the active lane branch", placement: "inline" },
  { name: "/stage all", description: "Stage all changes in the active lane", placement: "inline" },
  { name: "/clear", description: "Clear the local terminal transcript view", placement: "inline" },
  { name: "/copy", description: "Copy the visible chat transcript", placement: "inline" },
  { name: "/end", description: "End the active chat runtime", placement: "inline" },
  { name: "/login", description: "Sign in to the active CLI-backed provider from this terminal", placement: "inline" },
  { name: "/open", description: "Open this ADE context in desktop", placement: "inline" },
  { name: "/quit", description: "Exit ade code", placement: "inline" },
  { name: "/remember", description: "Write durable ADE memory", placement: "inline", argumentHint: "<fact>" },
  { name: "/steer cancel", description: "Remove the latest staged steer message", placement: "inline" },
  { name: "/steer edit", description: "Edit the latest staged steer message", placement: "inline", argumentHint: "<text>" },
  { name: "/steer send", description: "Send the latest staged steer into a Claude turn", placement: "inline", providers: ["claude"] },
  { name: "/steer interrupt", description: "Interrupt Claude and run the latest staged steer", placement: "inline", providers: ["claude"] },
  { name: "/steer", description: "Show staged steer messages", placement: "right" },
  { name: "/new lane", description: "Create a new lane", placement: "right" },
  { name: "/new chat", description: "Create a new chat", placement: "right", argumentHint: "[title]" },
  { name: "/rename", description: "Rename the active chat", placement: "right", argumentHint: "[title]" },
  { name: "/tag", description: "Tag the active Claude chat", placement: "right", argumentHint: "<tag|clear>", providers: ["claude"] },
  { name: "/output-style", description: "List or select the active Claude output style", placement: "right", argumentHint: "[style]", providers: ["claude"] },
  { name: "/plugin", description: "List, reload, or manage Claude plugins", placement: "right", argumentHint: "[reload|native args]", providers: ["claude"] },
  { name: "/status", description: "Show project, lane, and runtime state", placement: "right" },
  { name: "/context", description: "Show Claude context usage", placement: "right", providers: ["claude"] },
  { name: "/agents", description: "List Claude agents from user and project config", placement: "right", providers: ["claude"] },
  { name: "/skills", description: "List Claude skills from user and project config", placement: "right", providers: ["claude"] },
  { name: "/mcp", description: "Show Claude MCP server status", placement: "right", providers: ["claude"] },
  { name: "/compact", description: "Compact the active chat context", placement: "chat", argumentHint: "[instructions]", providers: ["claude", "codex"] },
  { name: "/init", description: "Generate AGENTS.md and Claude pointer files", placement: "right", providers: ["claude"] },
  { name: "/usage", description: "Show Claude usage through the active SDK session", placement: "chat", providers: ["claude"] },
  { name: "/insights", description: "Generate Claude session insights through the active SDK session", placement: "chat", providers: ["claude"] },
  { name: "/fast", description: "Toggle Claude fast mode through the active SDK session", placement: "chat", argumentHint: "[on|off]", providers: ["claude"] },
  { name: "/goal", description: "Set, clear, or inspect the active chat goal", placement: "chat", argumentHint: "[<text>|clear|status active|paused|complete|budget <n>|budget clear]", providers: ["claude", "codex"] },
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
  { name: "/help", description: "Show keymap and command help", placement: "right" },
  { name: "/keybindings", description: "Show Claude-compatible keybinding config diagnostics", placement: "right" },
  { name: "/statusline", description: "Show Claude-compatible status line config", placement: "right" },
  { name: "/doctor", description: "Show ADE Code and Claude-compat diagnostics", placement: "right" },
  { name: "/model", description: "Pick the active chat model", placement: "right" },
  { name: "/effort", description: "Pick reasoning effort", placement: "right" },
  { name: "/system", description: "Show system and runtime details", placement: "right" },
  { name: "/ade", description: "Run an ADE action or force a TUI command", placement: "right", argumentHint: "<domain.action|command> [json]" },
];

const ADE_OWNED_SINGLE_WORD_COMMANDS = new Set(
  BUILTIN_COMMANDS
    .filter((command) => command.placement === "inline" && !command.name.includes(" "))
    .map((command) => command.name.toLowerCase()),
);

const ADE_OWNED_CLAUDE_PARITY_COMMANDS = new Set([
  "/agents",
  "/skills",
  "/compact",
  "/init",
  "/usage",
  "/insights",
  "/fast",
  "/goal",
]);

export type ParsedCommand = {
  name: string;
  args: string;
  spec: BuiltinCommand | null;
  userCommand: AgentChatSlashCommand | null;
};

function normalizeSlashName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function slashCommandKey(value: string): string {
  return normalizeSlashName(value).toLowerCase();
}

export function parseCommand(input: string, userCommands: AgentChatSlashCommand[] = []): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [first = ""] = trimmed.split(/\s+/, 1);
  const firstKey = slashCommandKey(first);
  const candidates = [...BUILTIN_COMMANDS]
    .sort((left, right) => right.name.length - left.name.length);

  // Preserve ADE's multi-word commands (`/new lane`, `/pr open`, `/linear pull`)
  // even when a runtime exposes a first-token command like `/new`.
  for (const spec of candidates.filter((candidate) => candidate.name.includes(" "))) {
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

  const exactUserCommand = userCommands.find((command) => slashCommandKey(command.name) === firstKey) ?? null;
  const adeOwnedSingleWordCommand = candidates.find((command) =>
    slashCommandKey(command.name) === firstKey && ADE_OWNED_SINGLE_WORD_COMMANDS.has(slashCommandKey(command.name))
  );
  if (adeOwnedSingleWordCommand) {
    return {
      name: adeOwnedSingleWordCommand.name,
      args: trimmed.slice(first.length).trim(),
      spec: adeOwnedSingleWordCommand,
      userCommand: null,
    };
  }

  if (exactUserCommand) {
    return {
      name: exactUserCommand.name,
      args: trimmed.slice(first.length).trim(),
      spec: null,
      userCommand: exactUserCommand,
    };
  }

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

  const userCommand = userCommands.find((command) => slashCommandKey(command.name) === firstKey) ?? null;
  if (userCommand) {
    return {
      name: userCommand.name,
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
  options: { provider?: AgentChatProvider | null } = {},
): Array<{ name: string; description: string; source: "ade" | "user"; argumentHint?: string }> {
  const normalizedQuery = query.trim().toLowerCase();
  const queryToken = normalizedQuery.replace(/^\//, "");
  const builtins = BUILTIN_COMMANDS
    .filter((command) => !command.providers?.length || (options.provider ? command.providers.includes(options.provider) : true))
    .map((command) => ({
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
  // Dedupe by name. Most runtime/user commands win over ADE built-ins, but
  // ADE-owned inline terminal controls must match parseCommand dispatch.
  const byName = new Map<string, { name: string; description: string; source: "ade" | "user"; argumentHint?: string }>();
  for (const command of builtins) {
    const key = slashCommandKey(command.name);
    if (!byName.has(key)) byName.set(key, command);
  }
  for (const command of users) {
    const key = slashCommandKey(command.name);
    if (ADE_OWNED_SINGLE_WORD_COMMANDS.has(key)) continue;
    if (ADE_OWNED_CLAUDE_PARITY_COMMANDS.has(key)) continue;
    byName.set(key, command);
  }
  const merged = [...byName.values()];
  const filtered = !queryToken
    ? merged
    : merged.filter((command) => `${command.name} ${command.description}`.toLowerCase().includes(queryToken));
  // Rank: name-prefix matches first, then name-substring, then description matches, then alphabetical.
  filtered.sort((a, b) => {
    if (queryToken) {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aPrefix = aName.startsWith(`/${queryToken}`) ? 0 : aName.includes(queryToken) ? 1 : 2;
      const bPrefix = bName.startsWith(`/${queryToken}`) ? 0 : bName.includes(queryToken) ? 1 : 2;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    }
    return a.name.localeCompare(b.name);
  });
  return filtered.slice(0, 80);
}

export function commandPlacement(command: ParsedCommand): CommandPlacement {
  return command.spec?.placement ?? "chat";
}
