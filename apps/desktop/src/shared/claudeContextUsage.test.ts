import { describe, expect, it } from "vitest";
import {
  classifyClaudeContextCategory,
  normalizeClaudeContextUsage,
} from "./claudeContextUsage";

describe("Claude context usage kind classification", () => {
  it("classifies by kind, never by the name string free", () => {
    expect(classifyClaudeContextCategory({ kind: "free" })).toBe("free");
    expect(classifyClaudeContextCategory({ kind: "buffer" })).toBe("buffer");
    expect(classifyClaudeContextCategory({ kind: "deferred" })).toBe("deferred");
    expect(classifyClaudeContextCategory({ kind: "used" })).toBe("used");
    expect(classifyClaudeContextCategory({ kind: "used", isDeferred: true })).toBe("used");
    expect(classifyClaudeContextCategory({ isDeferred: true })).toBe("deferred");
    expect(classifyClaudeContextCategory({})).toBe("used");
  });

  it("does not invent a free row from a category named Free that is actually used", () => {
    const usage = normalizeClaudeContextUsage({
      totalTokens: 136_000,
      maxTokens: 200_000,
      percentage: 68,
      model: "Opus 5",
      categories: [
        { name: "Messages", tokens: 82_000, kind: "used" },
        { name: "MCP tools", tokens: 31_000, kind: "used", mcpServers: [
          { name: "posthog", tokens: 18_000 },
          { name: "linear", tokens: 9_000 },
          { name: "ade", tokens: 4_000 },
        ] },
        { name: "Memory files", tokens: 9_000, kind: "used" },
        { name: "Free", tokens: 64_000, kind: "free" },
        { name: "Compaction gap", tokens: 8_000, kind: "buffer" },
      ],
    });
    expect(usage.categories.map((row) => ({ name: row.name, kind: row.kind }))).toEqual([
      { name: "Messages", kind: "used" },
      { name: "MCP tools", kind: "used" },
      { name: "Memory files", kind: "used" },
      { name: "Free", kind: "free" },
      { name: "Compaction gap", kind: "buffer" },
    ]);
    expect(usage.categories.find((row) => row.name === "MCP tools")?.mcpServers).toEqual([
      { name: "posthog", tokens: 18_000 },
      { name: "linear", tokens: 9_000 },
      { name: "ade", tokens: 4_000 },
    ]);
  });

  it("does not treat a used row named free as remaining capacity", () => {
    const usage = normalizeClaudeContextUsage({
      totalTokens: 50,
      maxTokens: 100,
      categories: [
        { name: "free", tokens: 50, kind: "used" },
      ],
    });
    expect(usage.categories.filter((row) => row.kind === "used").map((row) => row.name)).toEqual(["free"]);
    expect(usage.categories.filter((row) => row.kind === "free")).toEqual([
      { name: "Free", tokens: 50, percentage: 50, kind: "free" },
    ]);
  });

  it("synthesizes remaining capacity as kind free when the SDK omitted that row", () => {
    const usage = normalizeClaudeContextUsage({
      totalTokens: 40,
      maxTokens: 100,
      categories: [{ name: "Messages", tokens: 40, kind: "used" }],
    });
    expect(usage.categories.some((row) => row.kind === "free" && row.tokens === 60)).toBe(true);
    expect(usage.categories.filter((row) => row.name.trim().toLowerCase() === "free" && row.kind !== "free")).toEqual([]);
  });

  it("reads mcp_servers when the payload is a name-to-token map", () => {
    const usage = normalizeClaudeContextUsage({
      totalTokens: 18_000,
      maxTokens: 200_000,
      categories: [
        { name: "MCP tools", tokens: 18_000, kind: "used", mcp_servers: { posthog: 18_000 } },
      ],
    });
    expect(usage.categories.find((row) => row.name === "MCP tools")?.mcpServers).toEqual([
      { name: "posthog", tokens: 18_000 },
    ]);
  });
});
