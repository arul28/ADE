import { describe, expect, it } from "vitest";
import {
  dispatchKeybinding,
  keypressToChord,
  normalizeKeyChord,
  validateClaudeKeybindingsConfig,
} from "../keybindings";

describe("keybindings", () => {
  it("normalizes common Claude chord spellings", () => {
    expect(normalizeKeyChord("Ctrl + C")).toBe("ctrl+c");
    expect(normalizeKeyChord("cmd+return")).toBe("meta+enter");
    expect(normalizeKeyChord("K")).toBe("shift+k");
    expect(normalizeKeyChord("ctrl+x ctrl+e")).toBe("ctrl+x ctrl+e");
  });

  it("validates supported actions and reserved keys", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        {
          context: "Chat",
          bindings: {
            "ctrl+j": "chat:new-line",
            "ctrl+c": "app:quit",
            "ctrl+x": "unknown:action",
          },
        },
      ],
    }, "/tmp/keybindings.json");

    expect(diagnostics.bindingCount).toBe(2);
    expect(diagnostics.warnings).toContain("Reserved shortcut cannot be rebound: ctrl+c");
    expect(diagnostics.warnings).toContain("Unsupported action for ctrl+x: unknown:action");
  });

  it("dispatches context bindings with Global fallback", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Global", bindings: { "ctrl+p": "pane:toggle", "ctrl+a": "pane:agents" } },
        { context: "Chat", bindings: { "up": "history:previous", "ctrl+g": "chat:externalEditor" } },
      ],
    });

    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "", { upArrow: true })).toBe("history:previous");
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "p", { ctrl: true })).toBe("pane:toggle");
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "a", { ctrl: true })).toBe("pane:agents");
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "g", { ctrl: true })).toBe("chat:externalEditor");
    expect(dispatchKeybinding(diagnostics.bindings, "Help", "", { upArrow: true })).toBeUndefined();
  });

  it("dispatches documented multi-key chords", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Chat", bindings: { "ctrl+x ctrl+e": "chat:externalEditor" } },
      ],
    });
    const state = { prefix: null, prefixAt: 0 };

    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "x", { ctrl: true }, state)).toBeUndefined();
    expect(state.prefix).toBe("ctrl+x");
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "e", { ctrl: true }, state)).toBe("chat:externalEditor");
    expect(state.prefix).toBeNull();
  });

  it("distinguishes disabled bindings from missing bindings", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Chat", bindings: { "ctrl+x": null } },
      ],
    });

    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "x", { ctrl: true })).toBeNull();
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "y", { ctrl: true })).toBeUndefined();
  });

  it("accepts recognized Claude actions that ADE Code does not implement yet", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Chat", bindings: { "ctrl+s": "selection:toggle" } },
      ],
    });

    expect(diagnostics.bindingCount).toBe(1);
    expect(diagnostics.warnings).toContain("Unrecognized action in known Claude namespace: selection:toggle");
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "s", { ctrl: true })).toBeUndefined();
  });

  it("converts Ink keypresses to chords", () => {
    expect(keypressToChord("", { pageDown: true })).toBe("pagedown");
    expect(keypressToChord("k", { ctrl: true })).toBe("ctrl+k");
  });
});
