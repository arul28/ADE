import { describe, expect, it } from "vitest";
import {
  dispatchKeybinding,
  keybindingsEditorCommand,
  keypressToChord,
  normalizeKeyChord,
  splitEditorCommand,
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

  it("dispatches the background chat launch shortcut", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Chat", bindings: { "cmd+return": "chat:launchBackground" } },
      ],
    });

    expect(diagnostics.bindingCount).toBe(1);
    expect(diagnostics.warnings).toEqual([]);
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "", { meta: true, return: true })).toBe("chat:launchBackground");
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

  it("dispatches selection copy as an implemented action", () => {
    const diagnostics = validateClaudeKeybindingsConfig({
      bindings: [
        { context: "Chat", bindings: { "ctrl+y": "selection:copy" } },
      ],
    });

    expect(diagnostics.bindingCount).toBe(1);
    expect(diagnostics.warnings).toEqual([]);
    expect(dispatchKeybinding(diagnostics.bindings, "Chat", "y", { ctrl: true })).toBe("selection:copy");
  });

  it("converts Ink keypresses to chords", () => {
    expect(keypressToChord("", { pageDown: true })).toBe("pagedown");
    expect(keypressToChord("k", { ctrl: true })).toBe("ctrl+k");
  });

  it("builds editor argv without shell parsing the target file path", () => {
    expect(splitEditorCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(keybindingsEditorCommand("/tmp/keybindings.json", "code --wait", "darwin")).toEqual({
      command: "code",
      args: ["--wait", "/tmp/keybindings.json"],
    });
    expect(keybindingsEditorCommand("/tmp/keybindings.json", undefined, "darwin")).toEqual({
      command: "open",
      args: ["/tmp/keybindings.json"],
    });
    expect(keybindingsEditorCommand("/tmp/keybindings.json", undefined, "linux")).toEqual({
      command: "xdg-open",
      args: ["/tmp/keybindings.json"],
    });
  });

  it("opens the keybindings file with the native handler on Windows", () => {
    // xdg-open does not exist on Windows; without this the /keybindings open
    // action failed silently (spawn errors are swallowed).
    expect(keybindingsEditorCommand("C:\\Users\\me\\.ade\\keybindings.json", undefined, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "C:\\Users\\me\\.ade\\keybindings.json"],
    });
    expect(keybindingsEditorCommand("C:\\keybindings.json", "code --wait", "win32")).toEqual({
      command: "code",
      args: ["--wait", "C:\\keybindings.json"],
    });
  });

  it("preserves quoted segments in VISUAL/EDITOR values", () => {
    expect(splitEditorCommand('emacsclient -a ""')).toEqual(["emacsclient", "-a", ""]);
    expect(splitEditorCommand('"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" --wait')).toEqual([
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "--wait",
    ]);
    expect(splitEditorCommand("vim -c 'set ft=json'")).toEqual(["vim", "-c", "set ft=json"]);
    expect(splitEditorCommand('code --user-data-dir "/tmp/my dir"')).toEqual([
      "code",
      "--user-data-dir",
      "/tmp/my dir",
    ]);
    expect(splitEditorCommand("edit\\ or --flag")).toEqual(["edit or", "--flag"]);
    expect(keybindingsEditorCommand("/tmp/keybindings.json", 'emacsclient -a ""', "linux")).toEqual({
      command: "emacsclient",
      args: ["-a", "", "/tmp/keybindings.json"],
    });
  });
});
