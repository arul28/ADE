import { describe, expect, it } from "vitest";

import {
  dispatchKeybinding,
  isPluginKeybindingAction,
  mergePluginKeybindings,
  parsePluginKeybindingAction,
  pluginChordToTuiKey,
  validateClaudeKeybindingsConfig,
  type ClaudeKeybinding,
  type PluginKeybindingPlugin,
} from "../keybindings";
import { parsePluginChord } from "../../../../desktop/src/shared/plugins/keybindings";
import { buildHelpIndex } from "../helpIndex";

/**
 * A plugin's shortcut in `ade code`.
 *
 * The reader this file guards is a Claude Code-compatible one with a CLOSED
 * action union — an action ADE has not implemented is a warning, never a silent
 * no-op — and `plugin` was already a known namespace, so `plugin:anything`
 * parsed as known-but-unimplemented and was swallowed at dispatch. The
 * parameterized form has to be admitted without reopening that hole, which is
 * why the malformed cases below matter as much as the working one.
 */

function config(bindings: Record<string, string | null>, context = "Global") {
  return { bindings: [{ context, bindings }] };
}

function plugin(overrides: Partial<PluginKeybindingPlugin> = {}): PluginKeybindingPlugin {
  return {
    pluginId: "prompts",
    displayName: "Prompt Library",
    enabled: true,
    installedAt: "2026-01-01T00:00:00.000Z",
    // Ctrl+B, not Ctrl+P: `ade code` binds Ctrl+P to the details pane in its own
    // input handler, so a plugin asking for it is refused (see the core-chord
    // suite below). The fixture uses a chord core genuinely leaves alone.
    keybindings: [{ action: "new", binding: "Ctrl+Shift+B", label: "New prompt" }],
    ...overrides,
  };
}

describe("plugin:<pluginId>:<actionId>", () => {
  it("reads the two ids apart", () => {
    expect(parsePluginKeybindingAction("plugin:prompts:new")).toEqual({
      pluginId: "prompts",
      actionId: "new",
    });
    expect(parsePluginKeybindingAction("plugin:my-plugin.v2:do_thing")).toEqual({
      pluginId: "my-plugin.v2",
      actionId: "do_thing",
    });
    expect(isPluginKeybindingAction("plugin:prompts:new")).toBe(true);
  });

  it("leaves the core plugin actions alone", () => {
    // Two segments, not three: still the closed union's own `plugin:toggle`.
    expect(parsePluginKeybindingAction("plugin:toggle")).toBeNull();
    expect(isPluginKeybindingAction("plugin:toggle")).toBe(false);
  });

  it.each([
    ["a missing action", "plugin:prompts:"],
    ["a missing id", "plugin::new"],
    ["a third colon", "plugin:prompts:new:extra"],
    ["a space in an id", "plugin:my plugin:new"],
    ["a leading dot", "plugin:.hidden:new"],
  ])("refuses %s", (_label, action) => {
    expect(parsePluginKeybindingAction(action)).toBeNull();
  });

  it("accepts the well-formed escape as implemented, not merely known", () => {
    const diagnostics = validateClaudeKeybindingsConfig(
      config({ "ctrl+g": "plugin:prompts:new" }),
      "/tmp/keybindings.json",
    );
    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.bindings[0]?.implemented).toBe(true);
    expect(diagnostics.bindings[0]?.action).toBe("plugin:prompts:new");
  });

  it("warns in the file's own words for a malformed plugin action", () => {
    const diagnostics = validateClaudeKeybindingsConfig(
      config({ "ctrl+g": "plugin:prompts:new:extra", "ctrl+h": "plugin::new" }),
      "/tmp/keybindings.json",
    );
    expect(diagnostics.warnings).toContain("Unsupported action for ctrl+g: plugin:prompts:new:extra");
    expect(diagnostics.warnings).toContain("Unsupported action for ctrl+h: plugin::new");
    expect(diagnostics.bindingCount).toBe(0);
  });
});

describe("plugin chords in the terminal's spelling", () => {
  it("resolves mod to ctrl, because a terminal never sees Cmd", () => {
    expect(pluginChordToTuiKey(parsePluginChord("Mod+P")!)).toBe("ctrl+p");
  });

  it("emits modifiers in the order keypressToChord does", () => {
    // Any other order is a chord that can never fire.
    expect(pluginChordToTuiKey(parsePluginChord("Shift+Ctrl+Tab")!)).toBe("ctrl+shift+tab");
  });

  it("maps alt onto the meta flag Ink actually reports", () => {
    expect(pluginChordToTuiKey(parsePluginChord("Alt+P")!)).toBe("meta+p");
  });

  it("drops shift on a letter, which a terminal cannot report", () => {
    // Ink sends the letter and no shift bit for a control sequence, so
    // `ctrl+shift+p` would be a binding nobody could ever press.
    expect(pluginChordToTuiKey(parsePluginChord("Ctrl+Shift+P")!)).toBe("ctrl+p");
    // …but it survives on a named key, where Ink does report it.
    expect(pluginChordToTuiKey(parsePluginChord("Shift+Alt+Up")!)).toBe("meta+shift+up");
  });
});

describe("merging plugin defaults under the user's file", () => {
  const userBindings = validateClaudeKeybindingsConfig(
    config({ "ctrl+g": "app:help" }),
    "/tmp/keybindings.json",
  ).bindings;

  it("binds a plugin chord nothing else wanted", () => {
    const merged = mergePluginKeybindings([plugin()], userBindings);
    expect(merged.refusals).toEqual([]);
    expect(merged.pluginBindings).toHaveLength(1);
    expect(merged.pluginBindings[0]?.key).toBe("ctrl+b");
    expect(merged.pluginBindings[0]?.action).toBe("plugin:prompts:new");
    expect(merged.pluginBindings[0]?.context).toBe("Global");
  });

  it("lets the user's own binding win the same chord", () => {
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+G", label: "New prompt" }] })],
      userBindings,
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("core-conflict");
    expect(merged.refusals[0]?.heldBy).toBe("app:help");
    expect(merged.refusals[0]?.message).toContain("Prompt Library");
  });

  it("treats an explicit unbind as a claim on that chord too", () => {
    const unbound = validateClaudeKeybindingsConfig(
      config({ "ctrl+g": null }),
      "/tmp/keybindings.json",
    ).bindings;
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+G", label: "New prompt" }] })],
      unbound,
    );
    expect(merged.pluginBindings).toEqual([]);
  });

  it("refuses a terminal-reserved chord even with an empty user file", () => {
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "quit", binding: "Ctrl+C", label: "Quit" }] })],
      [],
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.message.length).toBeGreaterThan(0);
  });

  it("stops a plugin from stealing the prefix of a user's multi-stroke chord", () => {
    const sequence = validateClaudeKeybindingsConfig(
      config({ "ctrl+x ctrl+e": "chat:externalEditor" }),
      "/tmp/keybindings.json",
    ).bindings;
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+X", label: "New prompt" }] })],
      sequence,
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("core-conflict");
  });

  it("refuses a chord the terminal cannot tell apart from the user's", () => {
    // Distinct to the matrix, identical to a terminal: `Ctrl+Shift+B` arrives
    // as `ctrl+b`. Binding it anyway would put a shortcut in the listing that
    // the user's own binding silently swallows.
    const collides = validateClaudeKeybindingsConfig(
      config({ "ctrl+b": "history:previous" }),
      "/tmp/keybindings.json",
    ).bindings;
    const merged = mergePluginKeybindings([plugin()], collides);
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("core-conflict");
    expect(merged.refusals[0]?.heldBy).toBe("history:previous");
  });

  it("refuses two plugins whose different chords alias to one keystroke", () => {
    const merged = mergePluginKeybindings(
      [
        plugin({
          pluginId: "veteran",
          displayName: "Veteran",
          installedAt: "2025-01-01T00:00:00.000Z",
          keybindings: [{ action: "a", binding: "Ctrl+B", label: "A" }],
        }),
        plugin({
          pluginId: "newcomer",
          displayName: "Newcomer",
          installedAt: "2026-06-01T00:00:00.000Z",
          keybindings: [{ action: "b", binding: "Ctrl+Shift+B", label: "B" }],
        }),
      ],
      [],
    );
    expect(merged.pluginBindings.map((entry) => entry.pluginName)).toEqual(["Veteran"]);
    expect(merged.refusals[0]?.reason).toBe("plugin-conflict");
    expect(merged.refusals[0]?.heldBy).toBe("veteran");
  });

  it("gives a contested chord to the plugin installed first", () => {
    const merged = mergePluginKeybindings(
      [
        plugin({ pluginId: "newcomer", displayName: "Newcomer", installedAt: "2026-06-01T00:00:00.000Z" }),
        plugin({ pluginId: "veteran", displayName: "Veteran", installedAt: "2025-01-01T00:00:00.000Z" }),
      ],
      [],
    );
    expect(merged.pluginBindings.map((entry) => entry.pluginName)).toEqual(["Veteran"]);
    expect(merged.refusals[0]?.reason).toBe("plugin-conflict");
  });

  it("binds nothing for a plugin the user switched off", () => {
    const merged = mergePluginKeybindings([plugin({ enabled: false })], []);
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals).toEqual([]);
  });

  it("returns the user's file untouched when no plugin declares anything", () => {
    const merged = mergePluginKeybindings([plugin({ keybindings: [] })], userBindings);
    expect(merged.bindings).toEqual(userBindings);
  });
});

/**
 * The keybindings FILE is opt-in and starts empty, but `ade code` still ships
 * defaults — in `useInput`, as `isCtrlInput(input, key, "p")` branches. Those
 * are core. A plugin allowed to bind one either steals it (the dispatch runs
 * ahead of the handler) or is silently dead (the handler runs ahead of the
 * dispatch); both are the failure the matrix exists to prevent.
 */
describe("chords ade code binds in code", () => {
  it("refuses the details pane chord (Ctrl+P) as reserved, before arbitration", () => {
    // `mod+p` joined RESERVED_PLUGIN_CHORDS (shared), so the refusal now comes
    // from validity — cross-client, unattributed — rather than this client's
    // core-conflict pass. Same outcome, stronger guarantee.
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+P", label: "New prompt" }] })],
      [],
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("invalid");
  });

  it.each([
    ["the command palette", "Ctrl+K"],
    ["the drawer", "Ctrl+O"],
    ["the agents pane", "Ctrl+A"],
    ["grid view", "Ctrl+G"],
    ["clipboard attach", "Ctrl+V"],
    ["the deeplink copy", "Ctrl+Y"],
  ])("refuses %s (%s) with an empty user file", (_label, binding) => {
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding, label: "New prompt" }] })],
      [],
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("core-conflict");
  });

  it("refuses a chord that only aliases onto a core one in the terminal", () => {
    // `Ctrl+Shift+P` folds to `ctrl+p` in the terminal, which is both the
    // details pane AND a reserved chord — the reserved check sees the folded
    // spelling too, so the refusal comes from validity with no attribution.
    // What matters is that the alias cannot bind.
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+Shift+P", label: "New prompt" }] })],
      [],
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("invalid");
  });

  it("refuses Option chords under either spelling, since Ink reports both as meta", () => {
    for (const binding of ["Alt+B", "Cmd+B"]) {
      const merged = mergePluginKeybindings(
        [plugin({ keybindings: [{ action: "new", binding, label: "New prompt" }] })],
        [],
      );
      expect(merged.pluginBindings).toEqual([]);
    }
  });

  it("still lets the user's own file name a core chord, and attributes it to them", () => {
    // Ctrl+K rather than Ctrl+P: the attribution path only exists for chords
    // the reserved set does not swallow first.
    const rebound = validateClaudeKeybindingsConfig(
      config({ "ctrl+k": "history:previous" }),
      "/tmp/keybindings.json",
    ).bindings;
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+K", label: "New prompt" }] })],
      rebound,
    );
    expect(merged.refusals[0]?.heldBy).toBe("history:previous");
  });

  it("binds nothing for an action id that cannot survive the plugin: escape", () => {
    // A host handing back an id with a colon in it would mint
    // `plugin:prompts:do:thing`, which parses back to nothing — a chord that
    // lists itself in /help and does nothing when pressed.
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "do:thing", binding: "Ctrl+Shift+B", label: "New prompt" }] })],
      [],
    );
    expect(merged.pluginBindings).toEqual([]);
    expect(merged.refusals[0]?.reason).toBe("invalid");
  });
});

describe("dispatching a plugin chord", () => {
  const merged = mergePluginKeybindings(
    [plugin()],
    validateClaudeKeybindingsConfig(config({ "ctrl+g": "app:help" }), "/tmp/keybindings.json").bindings,
  );

  it("resolves the chord to the plugin's action in a named context", () => {
    expect(dispatchKeybinding(merged.bindings, "Chat", "b", { ctrl: true, shift: true }))
      .toBe("plugin:prompts:new");
    // Global rows answer from every context, the same way the desktop's
    // listener sits on the window rather than on a tab.
    expect(dispatchKeybinding(merged.bindings, "Help", "b", { ctrl: true, shift: true }))
      .toBe("plugin:prompts:new");
  });

  it("still resolves the user's own binding", () => {
    expect(dispatchKeybinding(merged.bindings, "Chat", "g", { ctrl: true })).toBe("app:help");
  });

  it("falls through for a chord nobody bound", () => {
    expect(dispatchKeybinding(merged.bindings, "Chat", "q", { ctrl: true })).toBeUndefined();
  });

  it("hands the user's action back when both wanted one chord", () => {
    const contested = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+G", label: "New prompt" }] })],
      validateClaudeKeybindingsConfig(config({ "ctrl+g": "app:help" }), "/tmp/keybindings.json").bindings,
    );
    expect(dispatchKeybinding(contested.bindings, "Chat", "g", { ctrl: true })).toBe("app:help");
  });
});

describe("/help lists plugin shortcuts", () => {
  it("shows a surviving chord, attributed to its plugin", () => {
    const merged = mergePluginKeybindings([plugin()], []);
    const groups = buildHelpIndex(
      [{ name: "/commit", description: "Commit lane changes", placement: "inline", category: "Lanes" }],
      [],
      merged.pluginBindings,
    );
    const pluginGroup = groups.find((group) => group.category === "Plugins");
    expect(pluginGroup?.rows).toHaveLength(1);
    expect(pluginGroup?.rows[0]?.name).toBe("/plugin-view prompts");
    expect(pluginGroup?.rows[0]?.description).toBe("Prompt Library · New prompt");
    expect(pluginGroup?.rows[0]?.keybind).toBe("Ctrl+B");
    expect(pluginGroup?.rows[0]?.source).toBe("plugin");
  });

  it("lists nothing when every declaration was refused", () => {
    const merged = mergePluginKeybindings(
      [plugin({ keybindings: [{ action: "new", binding: "Ctrl+C", label: "New prompt" }] })],
      [],
    );
    const groups = buildHelpIndex(
      [{ name: "/commit", description: "Commit lane changes", placement: "inline", category: "Lanes" }],
      [],
      merged.pluginBindings,
    );
    expect(groups.some((group) => group.category === "Plugins")).toBe(false);
  });

  it("is absent entirely when no plugin binds anything", () => {
    const groups = buildHelpIndex(
      [{ name: "/commit", description: "Commit lane changes", placement: "inline", category: "Lanes" }],
      [],
      [],
    );
    expect(groups.some((group) => group.category === "Plugins")).toBe(false);
  });
});

describe("plugin rows do not disturb the existing reader", () => {
  it("keeps a user file's own diagnostics unchanged", () => {
    const diagnostics = validateClaudeKeybindingsConfig(
      config({ "ctrl+j": "chat:new-line", "ctrl+c": "app:quit", "ctrl+x": "unknown:action" }, "Chat"),
      "/tmp/keybindings.json",
    );
    expect(diagnostics.bindingCount).toBe(2);
    expect(diagnostics.warnings).toContain("Reserved shortcut cannot be rebound: ctrl+c");
    expect(diagnostics.warnings).toContain("Unsupported action for ctrl+x: unknown:action");
  });

  it("marks every row the user wrote as theirs", () => {
    const rows: ClaudeKeybinding[] = validateClaudeKeybindingsConfig(
      config({ "ctrl+g": "app:help" }),
      "/tmp/keybindings.json",
    ).bindings;
    expect(rows.every((row) => row.source === "user")).toBe(true);
  });
});
