import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBinding, type CaptureKeyEvent, type KeyboardPlatform } from "../../shared/keybindingEditor";
import { eventMatchesBinding } from "./keybindings";

const NAVIGATOR_PLATFORM: Record<KeyboardPlatform, string> = { mac: "MacIntel", windows: "Win32", linux: "Linux x86_64" };

function press(event: Partial<CaptureKeyEvent>): CaptureKeyEvent {
  return { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, getModifierState: () => false, ...event };
}

describe("shortcut keys: what Settings › Keyboard records is what fires", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A chord recorded in the editor must match the same press in the matcher,
  // on every platform and layout; when they disagree the shortcut saves and
  // then silently never runs.
  it.each([
    { name: "macOS ⌘K on QWERTY", platform: "mac", event: { key: "k", code: "KeyK", metaKey: true }, binding: "Mod+K" },
    // Dvorak's K sits where QWERTY has V: the letter typed is what is saved.
    { name: "macOS ⌘K on Dvorak", platform: "mac", event: { key: "k", code: "KeyV", metaKey: true }, binding: "Mod+K" },
    // A non-Latin layout types л on the K key: the physical key is saved.
    { name: "macOS ⌘K on a Russian layout", platform: "mac", event: { key: "л", code: "KeyK", metaKey: true }, binding: "Mod+K" },
    // Option changes what the key types on macOS (⌥K is ˚, ⌥1 is ¡).
    { name: "macOS ⌥⌘K", platform: "mac", event: { key: "˚", code: "KeyK", metaKey: true, altKey: true }, binding: "Mod+Alt+K" },
    { name: "macOS ⌥⌘1", platform: "mac", event: { key: "¡", code: "Digit1", metaKey: true, altKey: true }, binding: "Mod+Alt+1" },
    { name: "Windows Ctrl+K", platform: "windows", event: { key: "k", code: "KeyK", ctrlKey: true }, binding: "Mod+K" },
    { name: "Windows Ctrl+& on AZERTY", platform: "windows", event: { key: "&", code: "Digit1", ctrlKey: true }, binding: "Mod+&" },
    { name: "Linux Ctrl+K on a Russian layout", platform: "linux", event: { key: "л", code: "KeyK", ctrlKey: true }, binding: "Mod+K" },
  ] as const)("$name", ({ platform, event, binding }) => {
    vi.stubGlobal("navigator", { platform: NAVIGATOR_PLATFORM[platform] });
    const pressed = press(event);

    const recorded = captureBinding(pressed, platform);

    expect(recorded).toMatchObject({ kind: "binding", binding });
    expect(eventMatchesBinding(pressed as unknown as KeyboardEvent, binding)).toBe(true);
    // The same key without its modifiers is a different chord.
    expect(eventMatchesBinding(press({ key: event.key, code: event.code }) as unknown as KeyboardEvent, binding)).toBe(false);
  });

  // "," and "+" are the binding format's own separators, so a chord on either
  // cannot be stored; the recorder must say so rather than keep listening.
  it.each([
    { name: "⌘,", event: { key: ",", code: "Comma", metaKey: true } },
    { name: "⇧⌘+", event: { key: "+", code: "Equal", metaKey: true, shiftKey: true } },
  ])("refuses $name with a reason", ({ event }) => {
    const recorded = captureBinding(press(event), "mac");

    expect(recorded.kind).toBe("refuse");
    expect(recorded.kind === "refuse" && recorded.reason.length > 0).toBe(true);
    expect("binding" in recorded).toBe(false);
  });
});
