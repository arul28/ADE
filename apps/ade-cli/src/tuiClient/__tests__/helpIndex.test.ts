import { describe, it, expect } from "vitest";
import {
  buildHelpIndex,
  buildHelpRows,
  flattenHelpRows,
  formatChordForDisplay,
  getKeybindForCommand,
  helpMatchScore,
  pushRecent,
  type HelpGroup,
} from "../helpIndex";
import { BUILTIN_COMMANDS } from "../commands";
import type { ClaudeKeybinding } from "../keybindings";

function rowNames(groups: HelpGroup[]): string[] {
  return flattenHelpRows(groups).map((r) => r.name);
}

// A minimal live-registry double: /help bound to ctrl+/, /model to ctrl+o ctrl+m.
const BINDINGS: ClaudeKeybinding[] = [
  { context: "Global", key: "ctrl+/", action: "app:help", rawAction: "app:help", implemented: true },
  { context: "Global", key: "ctrl+o ctrl+m", action: "chat:modelPicker", rawAction: "chat:modelPicker", implemented: true },
  { context: "Global", key: "ctrl+z", action: "app:redraw", rawAction: "app:redraw", implemented: false },
];

describe("buildHelpIndex", () => {

  it("places /commit under Lanes and /pr under PRs", () => {
    const groups = buildHelpIndex();
    const lanes = groups.find((g) => g.category === "Lanes");
    const prs = groups.find((g) => g.category === "PRs");
    expect(lanes?.rows.some((r) => r.name === "/commit")).toBe(true);
    expect(prs?.rows.some((r) => r.name === "/pr")).toBe(true);
  });

  it("attaches keybinds for commands bound in the live registry", () => {
    const groups = buildHelpIndex(BUILTIN_COMMANDS, BINDINGS);
    const help = flattenHelpRows(groups).find((r) => r.name === "/help");
    expect(help?.keybind).toBe("Ctrl+/");
    const model = flattenHelpRows(groups).find((r) => r.name === "/model");
    expect(model?.keybind).toBe("Ctrl+O Ctrl+M");
  });

  it("leaves unbound commands without a keybind", () => {
    const groups = buildHelpIndex(BUILTIN_COMMANDS, BINDINGS);
    const commit = flattenHelpRows(groups).find((r) => r.name === "/commit");
    expect(commit?.keybind).toBeUndefined();
  });

  it("renders no keybinds when the registry is empty (the default)", () => {
    const groups = buildHelpIndex(BUILTIN_COMMANDS, []);
    expect(flattenHelpRows(groups).every((r) => r.keybind === undefined)).toBe(true);
  });
});

describe("getKeybindForCommand", () => {

  it("degrades to undefined when no registry is provided", () => {
    expect(getKeybindForCommand("/help", null)).toBeUndefined();
    expect(getKeybindForCommand("/help", [])).toBeUndefined();
  });
});

describe("formatChordForDisplay", () => {
  it("capitalizes modifiers and single keys", () => {
    expect(formatChordForDisplay("ctrl+p")).toBe("Ctrl+P");
    expect(formatChordForDisplay("shift+tab")).toBe("Shift+Tab");
  });

  it("handles multi-stroke chords", () => {
    expect(formatChordForDisplay("ctrl+o ctrl+m")).toBe("Ctrl+O Ctrl+M");
  });
});

describe("helpMatchScore", () => {
  const row = { name: "/push", description: "Push the active lane branch", source: "ade" as const, category: "Lanes" as const };

  it("scores prefix above description", () => {
    const prefix = helpMatchScore("pus", row);
    const desc = helpMatchScore("branch", row);
    expect(prefix).toBeGreaterThan(desc);
  });

  it("returns 0 for an empty query", () => {
    expect(helpMatchScore("", row)).toBe(0);
  });

  it("disqualifies rows where a token matches nowhere", () => {
    expect(helpMatchScore("zzzqqq", row)).toBe(-1);
  });
});

describe("buildHelpRows", () => {
  const index = buildHelpIndex(BUILTIN_COMMANDS, BINDINGS);

  it("narrows to matching commands and drops emptied groups", () => {
    const rows = buildHelpRows(index, "push", []);
    const names = rowNames(rows);
    expect(names).toContain("/push");
    // No Linear command contains "push", so the Linear group must be gone.
    expect(rows.some((g) => g.category === "Linear")).toBe(false);
  });

  it("is case-insensitive in filtering", () => {
    const rows = buildHelpRows(index, "CHAT", []);
    const names = rowNames(rows);
    expect(names).toContain("/chat rename");
  });

  it("ranks prefix matches before non-prefix matches within a group", () => {
    const rows = buildHelpRows(index, "pr", []);
    const prGroup = rows.find((g) => g.category === "PRs");
    expect(prGroup).toBeDefined();
    // "/pr" is an exact/prefix hit; it must sort to the top of the PRs group.
    expect(prGroup!.rows[0].name).toBe("/pr");
  });

  it("floats a recent command above a non-recent peer at the same score", () => {
    // Empty filter ⇒ all scores equal 0; recents decide order within a group.
    const rows = buildHelpRows(index, "", ["/push"]);
    const lanes = rows.find((g) => g.category === "Lanes");
    expect(lanes).toBeDefined();
    expect(lanes!.rows[0].name).toBe("/push");
  });

  it("orders multiple recents most-recent-first", () => {
    const rows = buildHelpRows(index, "", ["/commit", "/push"]);
    const lanes = rows.find((g) => g.category === "Lanes")!;
    const commitIdx = lanes.rows.findIndex((r) => r.name === "/commit");
    const pushIdx = lanes.rows.findIndex((r) => r.name === "/push");
    expect(commitIdx).toBeLessThan(pushIdx);
  });

  it("does not break ranking with an empty recents list", () => {
    const rows = buildHelpRows(index, "", []);
    const lanes = rows.find((g) => g.category === "Lanes")!;
    // Pure alphabetical fallback.
    const names = lanes.rows.map((r) => r.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

describe("pushRecent", () => {
  it("adds to the front, de-dupes, and caps length", () => {
    let recents: string[] = [];
    recents = pushRecent(recents, "/a");
    recents = pushRecent(recents, "/b");
    recents = pushRecent(recents, "/a"); // re-run /a moves it to front
    expect(recents).toEqual(["/a", "/b"]);
  });

  it("respects the limit", () => {
    let recents: string[] = [];
    for (const n of ["/1", "/2", "/3", "/4", "/5", "/6"]) recents = pushRecent(recents, n, 5);
    expect(recents).toEqual(["/6", "/5", "/4", "/3", "/2"]);
  });
});
