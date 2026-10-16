import { describe, expect, it } from "vitest";

import {
  classifySlashCommand,
  rankSlashCommands,
  slashCommandSectionKey,
  type ClassifiableSlashCommand,
} from "./slashCommandSections";

function names(commands: ClassifiableSlashCommand[]): string[] {
  return commands.map((command) => command.name);
}

describe("rankSlashCommands", () => {
  it("ranks an exact name above longer names that merely contain its letters", () => {
    const commands: ClassifiableSlashCommand[] = [
      { name: "asc-testflight-orchestration", description: "Orchestrate TestFlight" },
      { name: "test", description: "Prove the new code works" },
      { name: "clerk-testing", description: "E2E testing for Clerk apps" },
    ];
    expect(names(rankSlashCommands(commands, "test"))[0]).toBe("test");
  });

  it("ranks /cl so `clear` beats a namespaced skill", () => {
    const commands: ClassifiableSlashCommand[] = [
      { name: "claude-security:audit", description: "Audit dependencies" },
      { name: "clear", description: "Clear chat history" },
    ];
    expect(names(rankSlashCommands(commands, "cl"))).toEqual(["clear", "claude-security:audit"]);
  });

  it("offers scattered-letter matches only when nothing better matched", () => {
    const commands: ClassifiableSlashCommand[] = [
      { name: "deploy", description: "Deploy", kind: "command" },
      { name: "destructive-reset", description: "Reset", kind: "command" },
    ];
    // "dl" is a prefix of neither; "deploy" has d…l in order, "destructive-reset"
    // has a substring hit ("destroy"→ no; it has no "dl"). Only the scattered row
    // survives, because nothing better exists.
    expect(names(rankSlashCommands(commands, "dpl"))).toEqual(["deploy"]);
    // With a real substring hit present, the scattered row is dropped.
    const mixed: ClassifiableSlashCommand[] = [
      { name: "deploy-all", description: "" },
      { name: "alpha", description: "" },
    ];
    expect(names(rankSlashCommands(mixed, "alp"))).toEqual(["alpha"]);
  });
});

describe("classifySlashCommand", () => {
  it.each([
    ["plugin:security-review", "skill", "plugin", undefined],
    ["claude.ai HubSpot:list", "mcp", "provider", "claude.ai HubSpot"],
    ["status", "command", "provider", undefined],
    ["clear", "command", "project", undefined],
  ] as const)("classifies %s as %s", (name, kind, origin, server) => {
    const result = classifySlashCommand({ name, description: "", source: name === "clear" ? "local" : "sdk" });
    expect(result.kind).toBe(kind);
    expect(result.origin).toBe(origin);
    if (server) expect(result.server).toBe(server);
  });

  it("honours a host-provided kind over the name pattern", () => {
    const result = classifySlashCommand({ name: "server:prompt", description: "", kind: "skill", origin: "project" });
    expect(result).toEqual({ kind: "skill", origin: "project", server: undefined });
    expect(slashCommandSectionKey({ name: "server:prompt", description: "", kind: "skill" })).toBe("skills");
  });
});
