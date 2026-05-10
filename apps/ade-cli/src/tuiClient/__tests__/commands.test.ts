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

  it("routes user-defined commands to chat", () => {
    const parsed = parseCommand("/ship now", [
      { name: "/ship", description: "Ship it", source: "sdk" },
    ]);
    expect(parsed?.userCommand?.name).toBe("/ship");
    expect(parsed ? commandPlacement(parsed) : null).toBe("chat");
  });

  it("lets local project commands override ADE built-ins on exact name", () => {
    const parsed = parseCommand("/status please", [
      { name: "/status", description: "Project status prompt", source: "local" },
    ]);
    expect(parsed?.spec).toBeNull();
    expect(parsed?.userCommand?.name).toBe("/status");
    expect(parsed ? commandPlacement(parsed) : null).toBe("chat");
  });

  it("tags built-ins and user commands in the palette", () => {
    const rows = paletteCommands("/ship", [
      { name: "/ship", description: "Ship it", source: "sdk" },
    ]);
    expect(rows).toContainEqual(expect.objectContaining({ name: "/ship", source: "user" }));
  });
});
