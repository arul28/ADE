import type { AgentChatProvider, AgentChatSlashCommand } from "../../../desktop/src/shared/types/chat";

export type CommandPlacement = "inline" | "right" | "overlay" | "chat";

// Category buckets for the /help command reference (grouped, searchable).
// Order here is the order categories appear in the help pane.
export type CommandCategory =
  | "Lanes"
  | "Chats"
  | "Steer"
  | "PRs"
  | "Linear"
  | "Model"
  | "Nav"
  | "System";

export const COMMAND_CATEGORY_ORDER: CommandCategory[] = [
  "Lanes",
  "Chats",
  "Steer",
  "PRs",
  "Linear",
  "Model",
  "Nav",
  "System",
];

export type BuiltinCommand = {
  name: string;
  description: string;
  placement: CommandPlacement;
  argumentHint?: string;
  providers?: AgentChatProvider[];
  category?: CommandCategory;
};

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "/commit", description: "Commit lane changes", placement: "inline", argumentHint: "[message]", category: "Lanes" },
  { name: "/push", description: "Push the active lane branch", placement: "inline", category: "Lanes" },
  { name: "/pull", description: "Pull the active lane branch (default ff-only)", placement: "inline", argumentHint: "[--ff-only|--rebase|--merge]", category: "Lanes" },
  { name: "/undo", description: "Undo the last recorded HEAD change on the active lane branch", placement: "inline", category: "Lanes" },
  { name: "/redo", description: "Redo the most recently undone HEAD change on the active lane", placement: "inline", category: "Lanes" },
  { name: "/stage all", description: "Stage all changes in the active lane", placement: "inline", category: "Lanes" },
  { name: "/clear", description: "Clear the local terminal transcript view", placement: "inline", category: "Chats" },
  { name: "/login", description: "Sign in to the active CLI-backed provider from this terminal", placement: "inline", category: "Nav" },
  { name: "/open", description: "Open this ADE context in desktop", placement: "inline", category: "Nav" },
  { name: "/quit", description: "Exit ade code", placement: "inline", category: "System" },
  { name: "/steer cancel", description: "Remove the latest staged steer message", placement: "inline", category: "Steer" },
  { name: "/steer edit", description: "Edit the latest staged steer message", placement: "inline", argumentHint: "<text>", category: "Steer" },
  { name: "/steer send", description: "Send the latest staged steer into a Claude turn", placement: "inline", providers: ["claude"], category: "Steer" },
  { name: "/steer interrupt", description: "Interrupt Claude and run the latest staged steer", placement: "inline", providers: ["claude"], category: "Steer" },
  { name: "/steer", description: "Show staged steer messages", placement: "right", category: "Steer" },
  { name: "/new lane", description: "Create a new lane", placement: "right", category: "Lanes" },
  { name: "/new chat", description: "Create a new chat", placement: "right", argumentHint: "[title]", category: "Chats" },
  { name: "/rename", description: "Rename the active chat", placement: "right", argumentHint: "[title]", category: "Chats" },
  { name: "/chat rename", description: "Rename the active chat", placement: "right", argumentHint: "[title]", category: "Chats" },
  { name: "/chat archive", description: "Archive the active chat", placement: "right", category: "Chats" },
  { name: "/chat unarchive", description: "Unarchive a chat by id or title", placement: "right", argumentHint: "<chat-id|title>", category: "Chats" },
  { name: "/chat archived", description: "List archived chats", placement: "right", argumentHint: "[filter]", category: "Chats" },
  { name: "/chat delete", description: "Delete the active chat after confirmation", placement: "right", category: "Chats" },
  { name: "/tag", description: "Tag the active Claude chat", placement: "right", argumentHint: "<tag|clear>", providers: ["claude"], category: "Model" },
  { name: "/output-style", description: "List or select the active Claude output style", placement: "right", argumentHint: "[style]", providers: ["claude"], category: "Model" },
  { name: "/plugin", description: "List, reload, or manage Claude plugins", placement: "right", argumentHint: "[reload|native args]", providers: ["claude"], category: "Model" },
  { name: "/status", description: "Show project, lane, and runtime state", placement: "right", category: "Nav" },
  { name: "/context", description: "Show chat context usage", placement: "right", category: "Nav" },
  { name: "/agents", description: "List Claude agents from user and project config", placement: "right", providers: ["claude"], category: "Nav" },
  { name: "/info", description: "Open active chat info, plan, goal, and agents", placement: "right", category: "Nav" },
  { name: "/skills", description: "List agent skills from project, user, and ADE bundled roots", placement: "right", category: "Nav" },
  { name: "/compact", description: "Compact the active chat context", placement: "chat", argumentHint: "[instructions]", providers: ["claude", "codex"], category: "Model" },
  { name: "/init", description: "Generate AGENTS.md and Claude pointer files", placement: "right", providers: ["claude"], category: "Nav" },
  { name: "/usage", description: "Show Claude usage through the active SDK session", placement: "chat", providers: ["claude"], category: "Model" },
  { name: "/insights", description: "Generate Claude session insights through the active SDK session", placement: "chat", providers: ["claude"], category: "Model" },
  { name: "/fast", description: "Toggle Claude fast mode through the active SDK session", placement: "chat", argumentHint: "[on|off]", providers: ["claude"], category: "Model" },
  { name: "/goal", description: "Set, clear, or inspect the active chat goal", placement: "chat", argumentHint: "[<text>|clear|status active|paused|complete]", providers: ["claude", "codex"], category: "Model" },
  { name: "/diff", description: "Show active lane diff", placement: "right", category: "Lanes" },
  { name: "/log", description: "Show recent commits", placement: "right", category: "Lanes" },
  { name: "/reparent", description: "Move the active lane under another lane", placement: "right", argumentHint: "<parent-lane-id|parent-name> [stack-base-ref]", category: "Lanes" },
  { name: "/lane rename", description: "Rename the active lane", placement: "right", argumentHint: "[name]", category: "Lanes" },
  { name: "/lane archive", description: "Archive the active lane", placement: "right", category: "Lanes" },
  { name: "/lane unarchive", description: "Unarchive a lane by id or name", placement: "right", argumentHint: "<lane-id|name>", category: "Lanes" },
  { name: "/lane archived", description: "List archived lanes", placement: "right", category: "Lanes" },
  { name: "/lane delete", description: "Delete the active lane after confirmation", placement: "right", category: "Lanes" },
  { name: "/pr", description: "Open PR details (summary + checks)", placement: "right", category: "PRs" },
  { name: "/pr open", description: "Create or open a PR for the active lane", placement: "right", category: "PRs" },
  { name: "/pr review", description: "Show PR reviews", placement: "right", category: "PRs" },
  { name: "/pr comments", description: "Show actionable PR comments", placement: "right", category: "PRs" },
  { name: "/pr comment", description: "Comment on the active PR", placement: "right", argumentHint: "<text>", category: "PRs" },
  { name: "/pr approve", description: "Approve the active PR", placement: "right", argumentHint: "[note]", category: "PRs" },
  { name: "/pr request-changes", description: "Request changes on the active PR", placement: "right", argumentHint: "<text>", category: "PRs" },
  { name: "/pr land", description: "Merge the active PR (needs confirm)", placement: "right", argumentHint: "[confirm] [merge|squash|rebase]", category: "PRs" },
  { name: "/pr checks", description: "Show PR checks", placement: "right", category: "PRs" },
  { name: "/linear", description: "Run Linear workflow, route, sync, or ingress commands", placement: "right", argumentHint: "<group>", category: "Linear" },
  { name: "/linear list", description: "List Linear work", placement: "right", category: "Linear" },
  { name: "/linear workflows", description: "List Linear workflow runs", placement: "right", category: "Linear" },
  { name: "/linear run", description: "Inspect or resolve a Linear run", placement: "right", argumentHint: "<status|resolve|cancel|reroute>", category: "Linear" },
  { name: "/linear route", description: "Route a Linear issue", placement: "right", argumentHint: "<cto|worker>", category: "Linear" },
  { name: "/linear sync", description: "Operate Linear sync", placement: "right", argumentHint: "<dashboard|run|queue|resolve|detail>", category: "Linear" },
  { name: "/linear ingress", description: "Inspect Linear ingress", placement: "right", argumentHint: "<status|events|webhook>", category: "Linear" },
  { name: "/linear pull", description: "Pull a Linear ticket into chat context", placement: "right", argumentHint: "<id>", category: "Linear" },
  { name: "/linear comment", description: "Comment on a Linear ticket", placement: "right", argumentHint: "<id> <text>", category: "Linear" },
  { name: "/linear comments", description: "Show comments on a Linear ticket", placement: "right", argumentHint: "<id>", category: "Linear" },
  { name: "/linear status", description: "Show Linear sync status", placement: "right", category: "Linear" },
  { name: "/linear assign", description: "Assign a Linear ticket", placement: "right", argumentHint: "<id> <user>", category: "Linear" },
  { name: "/feedback", description: "Submit ADE feedback to GitHub issues", placement: "right", category: "Nav" },
  { name: "/chats", description: "List chats in the active lane", placement: "right", argumentHint: "[filter]", category: "Chats" },
  { name: "/switch", description: "Switch lane or chat", placement: "right", argumentHint: "[lane|chat]", category: "Chats" },
  { name: "/help", description: "Show keymap and command help", placement: "right", category: "System" },
  { name: "/keybindings", description: "Show Claude-compatible keybinding config diagnostics", placement: "right", argumentHint: "[open]", category: "System" },
  { name: "/statusline", description: "Show Claude-compatible status line config", placement: "right", category: "System" },
  { name: "/doctor", description: "Show ADE Code and Claude-compat diagnostics", placement: "right", category: "System" },
  { name: "/model", description: "Open the model, reasoning, and permission picker", placement: "right", category: "Model" },
  { name: "/effort", description: "Open the reasoning-effort picker", placement: "right", category: "Model" },
  { name: "/system", description: "Show system and runtime details", placement: "right", category: "System" },
  { name: "/ade", description: "Run an ADE action or force a TUI command", placement: "right", argumentHint: "<domain.action|command> [json]", category: "System" },
];

// ADE-owned local controls must dispatch in the TUI even if the active runtime
// exposes a user slash command with the same single-token name.
const ADE_LOCAL_SINGLE_WORD_COMMANDS = new Set(
  BUILTIN_COMMANDS
    .filter((command) => command.placement !== "chat" && !command.name.includes(" "))
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
  const adeOwnedOverride = candidates.find((command) => {
    const key = slashCommandKey(command.name);
    return key === firstKey && ADE_LOCAL_SINGLE_WORD_COMMANDS.has(key);
  });
  if (adeOwnedOverride) {
    return {
      name: adeOwnedOverride.name,
      args: trimmed.slice(first.length).trim(),
      spec: adeOwnedOverride,
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

export type PaletteCommand = {
  name: string;
  description: string;
  source: "ade" | "user";
  argumentHint?: string;
  placement?: CommandPlacement;
};

export function paletteCommands(
  query: string,
  userCommands: AgentChatSlashCommand[] = [],
  options: { provider?: AgentChatProvider | null } = {},
): PaletteCommand[] {
  const normalizedQuery = query.trim().toLowerCase();
  const queryToken = normalizedQuery.replace(/^\//, "");
  const builtins = BUILTIN_COMMANDS
    .filter((command) => !command.providers?.length || (options.provider ? command.providers.includes(options.provider) : true))
    .map((command) => ({
      name: command.name,
      description: command.description,
      source: "ade" as const,
      argumentHint: command.argumentHint,
      placement: command.placement,
    }));
  const users = userCommands.map((command) => ({
    name: command.name,
    description: command.description,
    source: "user" as const,
    argumentHint: command.argumentHint,
    placement: "chat" as CommandPlacement,
  }));
  // Dedupe by name. Runtime/user chat commands can still replace chat-placement
  // built-ins, but ADE local controls must match parseCommand dispatch so a row
  // marked as opening the right pane never falls through as a chat message.
  const byName = new Map<string, PaletteCommand>();
  for (const command of builtins) {
    const key = slashCommandKey(command.name);
    if (!byName.has(key)) byName.set(key, command);
  }
  for (const command of users) {
    const key = slashCommandKey(command.name);
    if (ADE_LOCAL_SINGLE_WORD_COMMANDS.has(key)) continue;
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
