import type { AgentChatSlashCommand } from "../../../shared/types";
import { discoverClaudeSlashCommands } from "./claudeSlashCommandDiscovery";
import { discoverCodexSlashCommands } from "./codexSlashCommandDiscovery";
import { discoverCursorSlashCommands } from "./cursorSlashCommandDiscovery";
import { slashCommandKey } from "./markdownSlashCommandDiscovery";

export function discoverAllProjectSlashCommands(workspaceRoot: string): AgentChatSlashCommand[] {
  const byName = new Map<string, AgentChatSlashCommand>();
  function add(command: { name: string; description: string; argumentHint?: string }): void {
    const key = slashCommandKey(command.name);
    if (key === "/login") return;
    if (byName.has(key)) return;
    byName.set(key, {
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      source: "sdk",
    });
  }

  for (const command of discoverClaudeSlashCommands(workspaceRoot)) add(command);
  for (const command of discoverCodexSlashCommands(workspaceRoot)) add(command);
  for (const command of discoverCursorSlashCommands(workspaceRoot)) add(command);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
