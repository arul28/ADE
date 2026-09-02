import { describe, expect, it } from "vitest";
import {
  CLAUDE_TERMINAL_ONLY_SLASH_COMMANDS,
  claudeSlashCommandKey,
  collectClaudeTerminalSlashCommandNames,
  filterClaudeGuiSlashCommands,
  isClaudeTerminalOnlySlashCommand,
} from "./claudeGuiSlashCommands";

describe("claude GUI slash-command filter", () => {
  it("normalizes names to a leading-slash lowercase key", () => {
    expect(claudeSlashCommandKey("Exit")).toBe("/exit");
    expect(claudeSlashCommandKey("/STATUSLINE")).toBe("/statusline");
    expect(claudeSlashCommandKey("  /quit  ")).toBe("/quit");
  });

  it("treats /exit, /quit, and /statusline as terminal-only even without init extras", () => {
    for (const name of CLAUDE_TERMINAL_ONLY_SLASH_COMMANDS) {
      expect(isClaudeTerminalOnlySlashCommand(name)).toBe(true);
    }
    expect(isClaudeTerminalOnlySlashCommand("/status")).toBe(false);
    expect(isClaudeTerminalOnlySlashCommand("/agents")).toBe(false);
  });

  it("unions runtime terminal_slash_commands with the known terminal-only set", () => {
    expect(isClaudeTerminalOnlySlashCommand("/theme", ["/theme", "Statusline"])).toBe(true);
    expect(collectClaudeTerminalSlashCommandNames(["theme", { name: "/Exit" }])).toEqual([
      "/theme",
      "/exit",
    ]);
  });

  it("drops terminal-only commands from every AgentChatSurface catalog", () => {
    const commands = [
      { name: "/agents", description: "Manage agents" },
      { name: "/exit", description: "Exit the CLI." },
      { name: "/quit", description: "Exit the CLI." },
      { name: "/statusline", description: "Configure status line." },
      { name: "/status", description: "Show version" },
      { name: "/theme", description: "Change theme" },
    ];
    expect(filterClaudeGuiSlashCommands(commands).map((command) => command.name)).toEqual([
      "/agents",
      "/status",
      "/theme",
    ]);
    expect(
      filterClaudeGuiSlashCommands(commands, ["/theme"]).map((command) => command.name),
    ).toEqual(["/agents", "/status"]);
  });
});
