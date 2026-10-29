import { describe, expect, it } from "vitest";

import {
  classifySlashCommand,
  slashCommandSectionKey,
} from "./slashCommandSections";

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
