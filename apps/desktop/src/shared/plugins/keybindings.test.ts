import { describe, expect, it } from "vitest";

import {
  buildCoreChordIndex,
  chordCollisionKeys,
  formatPluginChord,
  isBindablePluginChord,
  isValidPluginKeybinding,
  normalizeChordKeyName,
  parsePluginChord,
  pluginKeybindingRequests,
  resolvePluginKeybindings,
  type PluginKeybindingRequest,
} from "./keybindings";
import { KEYBINDING_DEFINITIONS } from "../keybindings";

/**
 * The collision matrix, which is the whole feature.
 *
 * A plugin keybinding is not interesting when it works — it is interesting when
 * two things want one chord, because that is the case where the wrong answer is
 * invisible. A plugin that quietly takes ⌘K breaks the command palette with
 * nothing on screen connecting cause to effect, and a plugin that quietly LOSES
 * one advertises a shortcut that does nothing. So every refusal below is
 * asserted twice: that it happened, and that it came back with a sentence
 * someone could read.
 */

function request(overrides: Partial<PluginKeybindingRequest> = {}): PluginKeybindingRequest {
  return {
    pluginId: "prompts",
    pluginName: "Prompt Library",
    installedAt: "2026-01-01T00:00:00.000Z",
    action: "new",
    binding: "Mod+Shift+P",
    label: "New prompt",
    ...overrides,
  };
}

/** The real desktop core table, which is the index a plugin actually loses to. */
function desktopCoreChords() {
  return buildCoreChordIndex(
    KEYBINDING_DEFINITIONS.map((definition) => [definition.id, definition.defaultBinding] as const),
  );
}

describe("plugin chord grammar", () => {
  it("accepts either client's modifier spelling, in any case", () => {
    for (const spelling of ["Mod+K", "mod+k", "CTRL+k", "Control+K", "cmd+k", "Command+K", "Super+K", "Win+K"]) {
      expect(parsePluginChord(spelling), spelling).not.toBeNull();
    }
    expect(formatPluginChord(parsePluginChord("Command+Shift+P")!)).toBe("meta+shift+p");
    expect(formatPluginChord(parsePluginChord("Option+Escape")!)).toBe("alt+esc");
  });

  it("refuses multi-stroke sequences, which only one client can honour", () => {
    expect(parsePluginChord("ctrl+x ctrl+e")).toBeNull();
    expect(chordCollisionKeys("ctrl+x ctrl+e")).toEqual([]);
  });

  it("refuses a chord that names two keys", () => {
    expect(parsePluginChord("ctrl+k+j")).toBeNull();
  });

  it("requires a modifier, and shift alone is not one", () => {
    expect(isBindablePluginChord(parsePluginChord("j")!)).toBe(false);
    expect(isBindablePluginChord(parsePluginChord("Shift+J")!)).toBe(false);
    expect(isBindablePluginChord(parsePluginChord("Alt+J")!)).toBe(true);
  });

  it("keeps the keys a user presses to get out of something", () => {
    for (const reserved of ["Mod+Escape", "Mod+Enter", "Mod+Tab", "Mod+Backspace", "Mod+Delete"]) {
      expect(isValidPluginKeybinding(reserved), reserved).toBe(false);
    }
    // Terminal-fatal chords, refused the same way the TUI's RESERVED_KEYS does.
    for (const reserved of ["Ctrl+C", "Ctrl+D", "Ctrl+M", "Mod+C", "Mod+D"]) {
      expect(isValidPluginKeybinding(reserved), reserved).toBe(false);
    }
    // The same letters are fine once they are not a terminal's kill signal.
    expect(isValidPluginKeybinding("Alt+C")).toBe(true);
  });

  /**
   * Each of these is answered by the application menu or the OS before the
   * renderer sees it, so a plugin bound to one does not take the chord — it
   * runs ALONGSIDE the window action. Named individually because the report is
   * always "the plugin fires at random", never "⌘W is bound twice".
   */
  it.each([
    ["Mod+N", "opens a new window"],
    ["Mod+W", "closes the window out from under the action"],
    ["Mod+Q", "quits mid-invoke"],
    ["Mod+M", "minimizes the window"],
    ["Mod+comma", "opens settings"],
    ["Mod+S", "saves"],
    ["Mod+P", "prints"],
    ["Mod+Shift+F", "is the find family"],
    ["Mod+0", "resets zoom"],
    ["Mod+minus", "zooms out"],
    ["Mod+equal", "zooms in"],
    ["Mod+plus", "zooms in"],
  ])("refuses %s, which %s", (binding) => {
    expect(isValidPluginKeybinding(binding)).toBe(false);
  });

  it("refuses the window chords whichever modifier spelling the manifest uses", () => {
    // `mod` expands to both, so a Mac author writing Cmd and a Windows author
    // writing Ctrl get the same answer on the machine in front of them.
    for (const binding of ["Cmd+W", "Ctrl+W", "Mod+,", "Mod+-", "Mod+="]) {
      expect(isValidPluginKeybinding(binding), binding).toBe(false);
    }
  });

  it("leaves the chords a plugin may still have", () => {
    for (const binding of ["Mod+Shift+P", "Mod+K", "Alt+N", "Mod+Shift+N", "Mod+J"]) {
      expect(isValidPluginKeybinding(binding), binding).toBe(true);
    }
  });

  it("normalizes the key names the two clients spell differently", () => {
    expect(normalizeChordKeyName("ArrowUp")).toBe("up");
    expect(normalizeChordKeyName("Escape")).toBe("esc");
    expect(normalizeChordKeyName("Return")).toBe("enter");
    // The DOM's space bar, which trimming would erase into "no key at all".
    expect(normalizeChordKeyName(" ")).toBe("space");
  });
});

describe("cross-platform collision keys", () => {
  it("expands mod to both ctrl and meta, so a refusal is the same on every OS", () => {
    expect(chordCollisionKeys("Mod+K")).toEqual(["ctrl+k", "meta+k"]);
    expect(chordCollisionKeys("Ctrl+K")).toEqual(["ctrl+k"]);
    expect(chordCollisionKeys("Meta+K")).toEqual(["meta+k"]);
  });

  it("makes Ctrl+K and Meta+K each collide with core's Mod+K", () => {
    const core = desktopCoreChords();
    for (const binding of ["Mod+K", "Ctrl+K", "Meta+K", "Cmd+K"]) {
      const { bindings, refusals } = resolvePluginKeybindings([request({ binding })], core);
      expect(bindings, binding).toHaveLength(0);
      expect(refusals[0]?.reason, binding).toBe("core-conflict");
      expect(refusals[0]?.heldBy, binding).toBe("commandPalette.open");
    }
  });

  it("does not collide two chords that differ only by a modifier the other lacks", () => {
    const core = buildCoreChordIndex([["core.thing", "Ctrl+K"]]);
    // Meta+K is a different keystroke from Ctrl+K on every platform.
    const { bindings } = resolvePluginKeybindings([request({ binding: "Meta+K" })], core);
    expect(bindings).toHaveLength(1);
  });
});

describe("core always wins", () => {
  it("refuses a chord ADE ships as a default", () => {
    const { bindings, refusals } = resolvePluginKeybindings(
      [request({ binding: "Mod+K" })],
      desktopCoreChords(),
    );
    expect(bindings).toHaveLength(0);
    expect(refusals[0]?.message).toContain("Prompt Library (prompts)");
    expect(refusals[0]?.message).toContain("commandPalette.open");
  });

  it("refuses a chord the USER rebound onto, which is core's too", () => {
    // The user moved the palette to Mod+J. A plugin taking Mod+J would break
    // the rebinding they just made, with nothing saying why.
    const core = buildCoreChordIndex([
      ...KEYBINDING_DEFINITIONS.map((d) => [d.id, d.defaultBinding] as const),
      ["commandPalette.open", "Mod+J"],
    ]);
    const { bindings, refusals } = resolvePluginKeybindings([request({ binding: "Mod+J" })], core);
    expect(bindings).toHaveLength(0);
    expect(refusals[0]?.reason).toBe("core-conflict");
    expect(refusals[0]?.heldBy).toBe("commandPalette.open");
  });

  it("claims every alternative of a comma-separated core binding", () => {
    const core = desktopCoreChords();
    // `lanes.filter.focus` is "/,Mod+F" — the second alternative counts.
    const { refusals } = resolvePluginKeybindings([request({ binding: "Mod+F" })], core);
    expect(refusals[0]?.heldBy).toBe("lanes.filter.focus");
  });
});

describe("plugin versus plugin", () => {
  const core = buildCoreChordIndex([]);

  it("gives the chord to whoever was installed first", () => {
    const { bindings, refusals } = resolvePluginKeybindings(
      [
        request({ pluginId: "newcomer", pluginName: "Newcomer", installedAt: "2026-06-01T00:00:00.000Z" }),
        request({ pluginId: "veteran", pluginName: "Veteran", installedAt: "2025-01-01T00:00:00.000Z" }),
      ],
      core,
    );
    expect(bindings.map((binding) => binding.pluginId)).toEqual(["veteran"]);
    expect(refusals[0]?.pluginId).toBe("newcomer");
    expect(refusals[0]?.reason).toBe("plugin-conflict");
    expect(refusals[0]?.heldBy).toBe("veteran");
  });

  it("is not decided by the order the caller gathered the requests", () => {
    const gathered = [
      request({ pluginId: "veteran", pluginName: "Veteran", installedAt: "2025-01-01T00:00:00.000Z" }),
      request({ pluginId: "newcomer", pluginName: "Newcomer", installedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const forward = resolvePluginKeybindings(gathered, core);
    const reversed = resolvePluginKeybindings([...gathered].reverse(), core);
    expect(forward.bindings.map((b) => b.pluginId)).toEqual(reversed.bindings.map((b) => b.pluginId));
  });

  it("breaks an identical install time by plugin id, so a restart cannot flip it", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const { bindings, refusals } = resolvePluginKeybindings(
      [
        request({ pluginId: "zeta", pluginName: "Zeta", installedAt: at }),
        request({ pluginId: "alpha", pluginName: "Alpha", installedAt: at }),
      ],
      core,
    );
    expect(bindings.map((binding) => binding.pluginId)).toEqual(["alpha"]);
    expect(refusals[0]?.pluginId).toBe("zeta");
  });

  it("still refuses across the mod/ctrl split between two plugins", () => {
    const { bindings, refusals } = resolvePluginKeybindings(
      [
        request({ pluginId: "first", installedAt: "2025-01-01T00:00:00.000Z", binding: "Mod+Shift+P" }),
        request({ pluginId: "second", installedAt: "2026-01-01T00:00:00.000Z", binding: "Ctrl+Shift+P" }),
      ],
      buildCoreChordIndex([]),
    );
    expect(bindings.map((binding) => binding.pluginId)).toEqual(["first"]);
    expect(refusals[0]?.reason).toBe("plugin-conflict");
  });
});

describe("one plugin's own declarations", () => {
  it("binds only the first chord for a repeated action", () => {
    const { bindings, refusals } = resolvePluginKeybindings(
      [
        request({ action: "new", binding: "Mod+Shift+P" }),
        request({ action: "new", binding: "Alt+P" }),
      ],
      buildCoreChordIndex([]),
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.binding).toBe("Mod+Shift+P");
    expect(refusals[0]?.reason).toBe("duplicate-action");
    expect(refusals[0]?.message).toContain("more than one keyboard shortcut");
  });

  it("lets one plugin bind two different actions", () => {
    const { bindings, refusals } = resolvePluginKeybindings(
      [
        request({ action: "new", binding: "Mod+Shift+P" }),
        request({ action: "search", binding: "Alt+P" }),
      ],
      buildCoreChordIndex([]),
    );
    expect(bindings).toHaveLength(2);
    expect(refusals).toHaveLength(0);
  });

  it("does not let a second plugin reuse the same action name to sneak past the dedupe", () => {
    const { bindings } = resolvePluginKeybindings(
      [
        request({ pluginId: "one", action: "new", binding: "Mod+Shift+P" }),
        request({ pluginId: "two", action: "new", binding: "Alt+P" }),
      ],
      buildCoreChordIndex([]),
    );
    expect(bindings).toHaveLength(2);
  });
});

describe("invalid chords", () => {
  it.each([
    ["no modifier", "j"],
    ["shift only", "Shift+J"],
    ["reserved bare key", "Mod+Escape"],
    ["terminal kill signal", "Ctrl+C"],
    ["multi-stroke", "ctrl+x ctrl+e"],
    ["nothing at all", ""],
    ["modifier with no key", "Mod+"],
  ])("refuses %s with reason 'invalid'", (_label, binding) => {
    const { bindings, refusals } = resolvePluginKeybindings(
      [request({ binding })],
      buildCoreChordIndex([]),
    );
    expect(bindings).toHaveLength(0);
    expect(refusals[0]?.reason).toBe("invalid");
    expect(refusals[0]?.heldBy).toBeNull();
  });
});

describe("nothing is dropped silently", () => {
  it("gives every refusal a non-empty, attributed sentence", () => {
    const core = desktopCoreChords();
    const { refusals } = resolvePluginKeybindings(
      [
        request({ pluginId: "a", pluginName: "A", installedAt: "2025-01-01T00:00:00.000Z", action: "x", binding: "Alt+Y" }),
        request({ pluginId: "a", pluginName: "A", installedAt: "2025-01-01T00:00:00.000Z", action: "x", binding: "Alt+Z" }),
        request({ pluginId: "b", pluginName: "B", installedAt: "2026-01-01T00:00:00.000Z", action: "y", binding: "Alt+Y" }),
        request({ pluginId: "c", pluginName: "C", installedAt: "2026-02-01T00:00:00.000Z", action: "z", binding: "Mod+K" }),
        request({ pluginId: "d", pluginName: "D", installedAt: "2026-03-01T00:00:00.000Z", action: "w", binding: "q" }),
      ],
      core,
    );
    expect(refusals.map((refusal) => refusal.reason).sort()).toEqual(
      ["core-conflict", "duplicate-action", "invalid", "plugin-conflict"],
    );
    for (const refusal of refusals) {
      expect(refusal.message.length, refusal.reason).toBeGreaterThan(0);
      expect(refusal.message, refusal.reason).toContain(refusal.pluginId);
    }
  });

  it("carries the canonical chords a surviving binding answers to", () => {
    const { bindings } = resolvePluginKeybindings(
      [request({ binding: "Mod+Shift+P" })],
      buildCoreChordIndex([]),
    );
    expect(bindings[0]?.collisionKeys).toEqual(["ctrl+shift+p", "meta+shift+p"]);
  });
});

describe("manifest declarations become requests", () => {
  it("carries the plugin's identity and install time onto every declaration", () => {
    const requests = pluginKeybindingRequests(
      { pluginId: "prompts", displayName: "Prompt Library", installedAt: "2026-01-01T00:00:00.000Z" },
      [
        { action: "new", binding: "Mod+Shift+P", label: "New prompt" },
        { action: "search", binding: "Alt+P", label: "Search prompts" },
      ],
    );
    expect(requests).toHaveLength(2);
    expect(requests.every((entry) => entry.pluginId === "prompts")).toBe(true);
    expect(requests.every((entry) => entry.installedAt === "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(requests[1]?.label).toBe("Search prompts");
  });
});
