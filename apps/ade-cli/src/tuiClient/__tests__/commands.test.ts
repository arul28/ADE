import { describe, expect, it } from "vitest";
import { commandPlacement, parseCommand, paletteCommands } from "../commands";

describe("commands", () => {
  it("parses multi-word ADE commands before generic slash commands", () => {
    const parsed = parseCommand("/linear pull ADE-123");
    expect(parsed?.name).toBe("/linear pull");
    expect(parsed?.args).toBe("ADE-123");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
  });

  it("routes the generic ADE action escape hatch to the right pane", () => {
    const parsed = parseCommand("/ade git.listBranches {\"laneId\":\"lane-1\"}");
    expect(parsed?.name).toBe("/ade");
    expect(parsed?.args).toBe("git.listBranches {\"laneId\":\"lane-1\"}");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
  });

  it("routes runtime commands to chat", () => {
    const parsed = parseCommand("/ship now", [
      { name: "/ship", description: "Ship it", source: "sdk" },
    ]);
    expect(parsed?.userCommand?.name).toBe("/ship");
    expect(parsed ? commandPlacement(parsed) : null).toBe("chat");
  });

  it("routes Codex /fast arguments to chat", () => {
    const parsed = parseCommand("/fast on", [
      { name: "/fast", description: "Toggle Fast mode for supported models", source: "sdk", argumentHint: "[on|off|status]" },
    ]);
    expect(parsed?.name).toBe("/fast");
    expect(parsed?.args).toBe("on");
    expect(parsed?.userCommand?.name).toBe("/fast");
    expect(parsed ? commandPlacement(parsed) : null).toBe("chat");
  });

  it("lets runtime commands override single-word ADE built-ins on exact name", () => {
    const parsed = parseCommand("/status please", [
      { name: "/status", description: "Runtime status", source: "sdk" },
    ]);
    expect(parsed?.spec).toBeNull();
    expect(parsed?.userCommand?.name).toBe("/status");
    expect(parsed ? commandPlacement(parsed) : null).toBe("chat");
  });

  it("keeps provider login as an ADE-code terminal command", () => {
    const parsed = parseCommand("/login", [
      { name: "/login", description: "Claude SDK login", source: "sdk" },
    ]);
    expect(parsed?.spec?.name).toBe("/login");
    expect(parsed?.userCommand).toBeNull();
    expect(parsed ? commandPlacement(parsed) : null).toBe("inline");
  });

  it("keeps terminal control commands in ADE Code", () => {
    const parsed = parseCommand("/quit", [
      { name: "/quit", description: "Runtime quit", source: "sdk" },
    ]);
    expect(parsed?.spec?.name).toBe("/quit");
    expect(parsed?.userCommand).toBeNull();
    expect(parsed ? commandPlacement(parsed) : null).toBe("inline");
  });

  it("keeps multi-word ADE commands ahead of first-token runtime commands", () => {
    const parsed = parseCommand("/new lane perf-pass", [
      { name: "/new", description: "Start a new runtime chat", source: "sdk" },
    ]);
    expect(parsed?.name).toBe("/new lane");
    expect(parsed?.args).toBe("perf-pass");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
  });

  it("tags built-ins and user commands in the palette", () => {
    const rows = paletteCommands("/ship", [
      { name: "/ship", description: "Ship it", source: "sdk" },
    ]);
    expect(rows).toContainEqual(expect.objectContaining({ name: "/ship", source: "user" }));
  });

  it("surfaces SDK commands like /compact when filtering", () => {
    const rows = paletteCommands("/comp", [
      { name: "/compact", description: "Free up context by summarizing", source: "sdk" },
    ]);
    expect(rows).toContainEqual(expect.objectContaining({
      name: "/compact",
      source: "user",
      description: "Free up context by summarizing",
    }));
  });

  it("keeps ADE-owned inline commands aligned with dispatch when deduping", () => {
    // /clear is an ADE terminal control, so the palette must not advertise the SDK command.
    const rows = paletteCommands("/clear", [
      { name: "/clear", description: "Start a new conversation with empty context", source: "sdk" },
    ]);
    const clearRows = rows.filter((row) => row.name === "/clear");
    expect(clearRows).toHaveLength(1);
    expect(clearRows[0]?.source).toBe("ade");
    expect(clearRows[0]?.description).toBe("Clear the local terminal transcript view");

    const parsed = parseCommand("/clear", [
      { name: "/clear", description: "Start a new conversation with empty context", source: "sdk" },
    ]);
    expect(parsed?.spec?.name).toBe("/clear");
    expect(parsed?.userCommand).toBeNull();
  });

  it("dedupes slash command case variants and keeps runtime casing", () => {
    const rows = paletteCommands("/ship", [
      { name: "/shipLane", description: "Ship the lane", source: "sdk" },
      { name: "/shiplane", description: "Duplicate lower-case command", source: "sdk" },
    ]);
    expect(rows.filter((row) => row.name.toLowerCase() === "/shiplane")).toHaveLength(1);
    expect(rows.find((row) => row.name.toLowerCase() === "/shiplane")?.name).toBe("/shiplane");

    const parsed = parseCommand("/shipLane now", [
      { name: "/shiplane", description: "Ship the lane", source: "sdk" },
    ]);
    expect(parsed?.userCommand?.name).toBe("/shiplane");
    expect(parsed?.args).toBe("now");
  });

  it("returns more than 9 results for empty/short queries", () => {
    const userCommands = Array.from({ length: 20 }, (_, i) => ({
      name: `/sdk-cmd-${i}`,
      description: `SDK command ${i}`,
      source: "sdk" as const,
    }));
    const rows = paletteCommands("/", userCommands);
    expect(rows.length).toBeGreaterThan(20);
  });

  it("ranks prefix matches above substring matches", () => {
    const rows = paletteCommands("/compact", [
      { name: "/compact", description: "Free up context", source: "sdk" },
      { name: "/something-compact-related", description: "Other", source: "sdk" },
    ]);
    expect(rows[0]?.name).toBe("/compact");
  });

  it("registers /compact and /goal as chat-placement builtins", () => {
    const compact = parseCommand("/compact");
    expect(compact?.spec?.name).toBe("/compact");
    expect(compact ? commandPlacement(compact) : null).toBe("chat");

    const goal = parseCommand("/goal Ship the migration");
    expect(goal?.spec?.name).toBe("/goal");
    expect(goal?.args).toBe("Ship the migration");
    expect(goal ? commandPlacement(goal) : null).toBe("chat");

    const goalBudget = parseCommand("/goal budget 50000");
    expect(goalBudget?.spec?.name).toBe("/goal");
    expect(goalBudget?.args).toBe("budget 50000");
  });

  it("drops the legacy /resume builtin", () => {
    const rows = paletteCommands("/resume", []);
    expect(rows.find((row) => row.name === "/resume" && row.source === "ade")).toBeUndefined();
  });
});
