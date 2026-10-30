import type { AgentChatSlashCommand } from "../../../shared/types";
import type { CopilotSdkAgentMode, CopilotSlashCommandInfo, CopilotSlashCommandResult } from "./copilotSdkProtocol";

/**
 * Copilot's own slash commands that ADE already owns, or that only work in
 * Copilot's terminal UI. Each answers with where ADE does the same thing
 * instead of running under ADE's controls:
 * - the model, permission level and goal are ADE's chat settings, and a
 *   runtime-side change would leave ADE showing the old one;
 * - the lane fixes the working directory, ADE names the chat;
 * - `/every` and `/after` start turns while no ADE turn is listening;
 * - `/remote` hands the session to GitHub's Mission Control.
 */
const COPILOT_ADE_OWNED_COMMANDS: Record<string, string> = {
  model: "Use the model picker under the composer to change Copilot's model.",
  models: "Use the model picker under the composer to change Copilot's model.",
  permissions: "Use the permission level under the composer to change what Copilot may do without asking.",
  "allow-all": "Use the permission level under the composer (Full-auto) to let Copilot run without asking.",
  yolo: "Use the permission level under the composer (Full-auto) to let Copilot run without asking.",
  autopilot: "Use /goal <objective> to run Copilot in Autopilot until the goal is done.",
  cwd: "This chat runs in its lane's folder. Start a chat in another lane to work elsewhere.",
  cd: "This chat runs in its lane's folder. Start a chat in another lane to work elsewhere.",
  rename: "Rename the chat from its title in ADE.",
  every: "Use ADE's scheduled work to repeat a prompt (`ade chat scheduled-work create`).",
  loop: "Use ADE's scheduled work to repeat a prompt (`ade chat scheduled-work create`).",
  after: "Use ADE's scheduled work or drafts to send a prompt later.",
  remote: "Copilot remote sessions are not available in ADE. Open the chat from ADE on your phone instead.",
};

/**
 * What the `/` menu offers before a chat's runtime has listed its own
 * commands: Copilot's built-ins (runtime 1.0.105), minus the ones ADE owns.
 */
const COPILOT_BUILT_IN_COMMANDS: AgentChatSlashCommand[] = [
  { name: "/compact", description: "Summarize conversation history to reduce context window usage.", source: "sdk", argumentHint: "[focus instructions]" },
  { name: "/context", description: "Show context window token usage.", source: "sdk" },
  { name: "/usage", description: "Display session usage metrics and statistics.", source: "sdk" },
  { name: "/env", description: "Show loaded instructions, MCP servers, skills, agents, hooks and plugins.", source: "sdk" },
  { name: "/review", description: "Run the code review agent on your changes.", source: "sdk", argumentHint: "[instructions]" },
  { name: "/security-review", description: "Analyze staged and unstaged changes for security vulnerabilities.", source: "sdk", argumentHint: "[instructions]" },
  { name: "/plan", description: "Create an implementation plan before coding.", source: "sdk", argumentHint: "<prompt>" },
  { name: "/init", description: "Initialize Copilot instructions for this repository.", source: "sdk" },
  { name: "/research", description: "Run a deep research investigation using GitHub search and web sources.", source: "sdk", argumentHint: "<topic>" },
  { name: "/fleet", description: "Enable fleet mode for parallel subagent execution.", source: "sdk", argumentHint: "<prompt>" },
  { name: "/mcp", description: "Manage MCP server configuration.", source: "sdk", argumentHint: "[list|show|enable|disable|reload]" },
  { name: "/skills", description: "Manage skills.", source: "sdk", argumentHint: "[list|info|reload|add|remove]" },
  { name: "/memory", description: "Show memory status, or turn memory across sessions on or off.", source: "sdk", argumentHint: "[on|off|show]" },
  { name: "/session", description: "View session details, checkpoints, changed files and plan.", source: "sdk", argumentHint: "[info|checkpoints|files|plan]" },
  { name: "/share", description: "Share the session via GitHub and get a shareable link.", source: "sdk", argumentHint: "[link|off]" },
  { name: "/add-dir", description: "Allow file access to another directory.", source: "sdk", argumentHint: "<directory>" },
  { name: "/list-dirs", description: "Display allowed directories and path grants.", source: "sdk" },
  { name: "/reset-allowed-tools", description: "Reset session tool and path approvals.", source: "sdk" },
  { name: "/blame", description: "Trace code history with git blame and linked Copilot sessions.", source: "sdk", argumentHint: "<text | pull request | commit>" },
  { name: "/chronicle", description: "Session history tools and insights.", source: "sdk", argumentHint: "[standup|search|tips|cost-tips|improve|reindex]" },
  { name: "/plugin", description: "Manage plugins and plugin marketplaces.", source: "sdk", argumentHint: "[list]" },
  { name: "/sandbox", description: "Manage sandbox settings.", source: "sdk", argumentHint: "[status|policy|enable|disable]" },
];

const BUILT_IN_NAMES = new Set(COPILOT_BUILT_IN_COMMANDS.map((command) => command.name.slice(1)));

/** The `/` menu rows for a chat: the runtime's own list when it has one, else the built-ins. */
export function copilotSlashCommandRows(listed: readonly CopilotSlashCommandInfo[] | null): AgentChatSlashCommand[] {
  if (!listed?.length) return COPILOT_BUILT_IN_COMMANDS;
  return listed
    .filter((command) => !Object.hasOwn(COPILOT_ADE_OWNED_COMMANDS, command.name))
    .map((command) => ({
      name: `/${command.name}`,
      description: command.description,
      ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
      source: "sdk" as const,
      ...(command.kind === "skill" ? { kind: "skill" as const } : {}),
    }));
}

/** A message that names one of Copilot's commands: `/name rest`. */
export function parseCopilotSlashCommand(text: string | null | undefined): { name: string; input: string } | null {
  const match = text?.trim().match(/^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), input: match[2]?.trim() ?? "" };
}

/** ADE's answer for a command it owns; null for every other name. */
export function copilotAdeOwnedCommandReply(name: string): string | null {
  return Object.hasOwn(COPILOT_ADE_OWNED_COMMANDS, name) ? COPILOT_ADE_OWNED_COMMANDS[name]! : null;
}

/**
 * The listed command a name runs (by name or alias). Before the runtime has
 * listed its commands, the built-ins ADE offers count.
 */
export function resolveCopilotSlashCommand(
  name: string,
  listed: readonly CopilotSlashCommandInfo[] | null,
): { name: string; allowDuringAgentExecution: boolean } | null {
  if (copilotAdeOwnedCommandReply(name)) return null;
  if (!listed?.length) return BUILT_IN_NAMES.has(name) ? { name, allowDuringAgentExecution: false } : null;
  // Typed names are lowercased; the runtime's may not be (a skill's name).
  const found = listed.find((command) => command.name.toLowerCase() === name
    || command.aliases?.some((alias) => alias.toLowerCase() === name));
  if (!found || copilotAdeOwnedCommandReply(found.name)) return null;
  return { name: found.name, allowDuringAgentExecution: found.allowDuringAgentExecution };
}

/** Terminal colour codes some command output (`/usage`) keeps. */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * What ADE does with a command's answer: show its output, or send the prompt
 * the command built (for `/review`, `/plan`, `/init`, a skill) as a turn.
 */
export type CopilotCommandOutcome =
  | { kind: "output"; text: string; markdown: boolean }
  | { kind: "prompt"; prompt: string; displayPrompt: string; agentMode?: CopilotSdkAgentMode; notice?: string };

export function copilotCommandOutcome(commandName: string, result: CopilotSlashCommandResult | null | undefined): CopilotCommandOutcome {
  if (!result || typeof result !== "object") return { kind: "output", text: `/${commandName} finished.`, markdown: false };
  switch (result.kind) {
    case "agent-prompt": {
      const mode = result.mode === "plan" || result.mode === "autopilot" || result.mode === "interactive" ? result.mode : undefined;
      return {
        kind: "prompt",
        prompt: result.prompt,
        displayPrompt: result.displayPrompt || `/${commandName}`,
        ...(mode ? { agentMode: mode } : {}),
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
    case "text":
      return { kind: "output", text: result.text.replace(ANSI_PATTERN, ""), markdown: result.markdown === true };
    case "completed":
      return { kind: "output", text: result.message?.trim() || `/${commandName} finished.`, markdown: false };
    case "select-subcommand": {
      const lines = result.options.map((option) => `- \`/${result.command} ${option.name}\`: ${option.description}`);
      return { kind: "output", text: [`**${result.title}**`, "", ...lines].join("\n"), markdown: true };
    }
    case "add-timeline-entry":
      return { kind: "output", text: [result.entry.text, result.entry.url].filter(Boolean).join("\n"), markdown: true };
    case "set-model":
      return { kind: "output", text: copilotAdeOwnedCommandReply("model")!, markdown: false };
    case "set-plan-model":
      return { kind: "output", text: result.message, markdown: false };
    case "show-dialog":
      return { kind: "output", text: `/${commandName} opens a dialog that only Copilot's terminal app has. Run \`copilot\` in a terminal for it.`, markdown: false };
    default:
      return { kind: "output", text: `/${commandName} finished.`, markdown: false };
  }
}

/** Command output as chat text: markdown as is, plain text kept in its layout. */
export function copilotCommandOutputMarkdown(outcome: Extract<CopilotCommandOutcome, { kind: "output" }>): string {
  if (outcome.markdown || !outcome.text.includes("\n")) return outcome.text;
  return `\`\`\`text\n${outcome.text.replace(/```/g, "ʼʼʼ")}\n\`\`\``;
}
