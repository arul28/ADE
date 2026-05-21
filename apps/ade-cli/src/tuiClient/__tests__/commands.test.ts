import { describe, expect, it } from "vitest";
import { commandPlacement, parseCommand, paletteCommands } from "../commands";
import { buildLinearToolRequest, parseLinearArgs } from "../linearCommands";

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

  it("routes PR comments to the right pane", () => {
    const parsed = parseCommand("/pr comments");
    expect(parsed?.name).toBe("/pr comments");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
    expect(paletteCommands("/pr comm")).toContainEqual(expect.objectContaining({
      name: "/pr comments",
      source: "ade",
      description: "Show actionable PR comments",
    }));
  });

  it("routes lane reparent to the right pane", () => {
    const parsed = parseCommand("/reparent lane-parent origin/main");
    expect(parsed?.name).toBe("/reparent");
    expect(parsed?.args).toBe("lane-parent origin/main");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
    expect(paletteCommands("/rep")).toContainEqual(expect.objectContaining({
      name: "/reparent",
      source: "ade",
      description: "Move the active lane under another lane",
    }));
  });

  it("routes /effort to the ADE Code right pane", () => {
    const parsed = parseCommand("/effort");
    expect(parsed?.spec?.name).toBe("/effort");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
    expect(paletteCommands("/eff")).toContainEqual(expect.objectContaining({
      name: "/effort",
      source: "ade",
      description: "Open the reasoning-effort picker",
    }));
  });

  it("routes /feedback to the ADE Code right pane", () => {
    const parsed = parseCommand("/feedback");
    expect(parsed?.spec?.name).toBe("/feedback");
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");
    expect(paletteCommands("/feed")).toContainEqual(expect.objectContaining({
      name: "/feedback",
      source: "ade",
      description: "Submit ADE feedback to GitHub issues",
    }));
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

  it("keeps single-word ADE pane commands local on exact name", () => {
    const parsed = parseCommand("/status please", [
      { name: "/status", description: "Runtime status", source: "sdk" },
    ]);
    expect(parsed?.spec?.name).toBe("/status");
    expect(parsed?.userCommand).toBeNull();
    expect(parsed ? commandPlacement(parsed) : null).toBe("right");

    const feedback = parseCommand("/feedback", [
      { name: "/feedback", description: "Runtime feedback", source: "sdk" },
    ]);
    expect(feedback?.spec?.name).toBe("/feedback");
    expect(feedback?.userCommand).toBeNull();
    expect(feedback ? commandPlacement(feedback) : null).toBe("right");
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
      source: "ade",
      description: "Compact the active chat context",
    }));
  });

  it("includes Claude parity builtins plus provider-agnostic skills", () => {
    const rows = paletteCommands("/", [], { provider: "claude" });
    for (const name of ["/agents", "/skills", "/init"]) {
      expect(rows).toContainEqual(expect.objectContaining({ name, source: "ade" }));
      const parsed = parseCommand(`${name} arg`, []);
      expect(parsed?.spec?.placement).toBe("right");
    }
    for (const name of ["/compact", "/usage", "/insights", "/fast", "/goal"]) {
      expect(rows).toContainEqual(expect.objectContaining({ name, source: "ade" }));
      const parsed = parseCommand(`${name} arg`, []);
      expect(parsed?.spec?.placement).toBe("chat");
    }
  });

  it("keeps provider-agnostic skills visible outside Claude chats", () => {
    const rows = paletteCommands("/", [], { provider: "codex" });
    for (const name of ["/agents", "/init", "/usage", "/insights", "/fast"]) {
      expect(rows).not.toContainEqual(expect.objectContaining({ name }));
    }
    expect(rows).toContainEqual(expect.objectContaining({
      name: "/skills",
      description: "List agent skills from project, user, and ADE bundled roots",
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      name: "/compact",
      description: "Compact the active chat context",
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      name: "/goal",
      description: "Set, clear, or inspect the active chat goal",
    }));
  });

  it("shows one provider-gated row for shared Claude and Codex chat commands", () => {
    const rows = paletteCommands("/");
    const compactRows = rows.filter((row) => row.name === "/compact");
    const goalRows = rows.filter((row) => row.name === "/goal");
    expect(compactRows).toEqual([
      expect.objectContaining({ description: "Compact the active chat context" }),
    ]);
    expect(goalRows).toEqual([
      expect.objectContaining({ description: "Set, clear, or inspect the active chat goal" }),
    ]);
  });

  it("filters provider-specific ADE commands outside supported chats", () => {
    expect(paletteCommands("/context", [], { provider: "codex" })).not.toContainEqual(
      expect.objectContaining({ name: "/context" }),
    );
    expect(paletteCommands("/output-style", [], { provider: "codex" })).not.toContainEqual(
      expect.objectContaining({ name: "/output-style" }),
    );
    expect(paletteCommands("/mcp", [], { provider: "codex" })).not.toContainEqual(
      expect.objectContaining({ name: "/mcp" }),
    );
    expect(paletteCommands("/plugin", [], { provider: "codex" })).not.toContainEqual(
      expect.objectContaining({ name: "/plugin" }),
    );
    expect(paletteCommands("/context", [], { provider: "claude" })).toContainEqual(
      expect.objectContaining({ name: "/context" }),
    );
    expect(paletteCommands("/output-style", [], { provider: "claude" })).toContainEqual(
      expect.objectContaining({ name: "/output-style" }),
    );
    expect(paletteCommands("/mcp", [], { provider: "claude" })).not.toContainEqual(
      expect.objectContaining({ name: "/mcp" }),
    );
    expect(paletteCommands("/plugin", [], { provider: "claude" })).toContainEqual(
      expect.objectContaining({ name: "/plugin" }),
    );
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

  it("does not reserve /copy as an ADE built-in", () => {
    const rows = paletteCommands("/copy", [
      { name: "/copy", description: "Runtime copy command", source: "sdk" },
    ]);
    expect(rows).toContainEqual(expect.objectContaining({
      name: "/copy",
      source: "user",
      description: "Runtime copy command",
    }));

    const parsed = parseCommand("/copy all", [
      { name: "/copy", description: "Runtime copy command", source: "sdk" },
    ]);
    expect(parsed?.spec).toBeNull();
    expect(parsed?.userCommand?.name).toBe("/copy");
    expect(parsed ? commandPlacement(parsed) : null).toBe("chat");
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

    const goalStatus = parseCommand("/goal status active");
    expect(goalStatus?.spec?.name).toBe("/goal");
    expect(goalStatus?.args).toBe("status active");
  });

  it("drops the legacy /resume builtin", () => {
    const rows = paletteCommands("/resume", []);
    expect(rows.find((row) => row.name === "/resume" && row.source === "ade")).toBeUndefined();
  });

  it("registers /info as the active-chat info command", () => {
    const info = parseCommand("/info");
    expect(info?.spec?.name).toBe("/info");
    expect(info?.spec?.placement).toBe("right");
    expect(info ? commandPlacement(info) : null).toBe("right");

    const parsed = parseCommand("/subagents");
    expect(parsed?.spec).toBeNull();
  });

  it("surfaces active ADE Code panes in the palette and not removed aliases", () => {
    const infoRows = paletteCommands("info");
    expect(infoRows.some((row) => row.name === "/info")).toBe(true);

    const effortRows = paletteCommands("effort");
    expect(effortRows.some((row) => row.name === "/effort" && row.source === "ade")).toBe(true);

    const subagentRows = paletteCommands("subagents");
    expect(subagentRows.some((row) => row.name === "/subagents")).toBe(false);

    const allRows = paletteCommands("");
    expect(allRows.some((row) => row.name === "/plan" && row.source === "ade")).toBe(false);
  });
});

describe("linear command routing", () => {
  it("parses flags and quoted values", () => {
    expect(parseLinearArgs("run cancel run-1 --reason \"not ready\" --launch false")).toEqual({
      positionals: ["run", "cancel", "run-1"],
      options: { reason: "not ready", launch: false },
    });
  });

  it("shows usage for bare /linear instead of running a default tool", () => {
    expect(buildLinearToolRequest("")).toEqual({
      kind: "usage",
      title: "Linear",
      body: "Usage: /linear <workflows|run|route|sync|ingress> ...",
    });
  });

  it("routes sync dashboard and queue resolution", () => {
    expect(buildLinearToolRequest("sync dashboard")).toEqual({
      kind: "tool",
      title: "Linear sync dashboard",
      toolName: "getLinearSyncDashboard",
      args: {},
    });
    expect(buildLinearToolRequest("sync resolve queue-1 approve --note ok")).toEqual({
      kind: "tool",
      title: "Linear sync resolve",
      toolName: "resolveLinearSyncQueueItem",
      args: {
        queueItemId: "queue-1",
        action: "approve",
        note: "ok",
      },
    });
  });

  it("routes worker handoff and reports usage for missing fields", () => {
    expect(buildLinearToolRequest("route worker LIN-123 agent-1")).toEqual({
      kind: "tool",
      title: "Linear route worker",
      toolName: "routeLinearIssueToWorker",
      args: { issueId: "LIN-123", agentId: "agent-1" },
    });
    expect(buildLinearToolRequest("run cancel run-1")).toEqual({
      kind: "usage",
      title: "Linear run cancel",
      body: "Usage: /linear run cancel <run-id> --reason <reason>",
    });
  });
});
