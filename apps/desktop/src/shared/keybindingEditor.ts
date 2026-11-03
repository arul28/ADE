// What Settings › Keyboard needs to edit the keybinding store: turning a key
// press into a binding, resolving a binding to the chord it really is on one
// platform, and saying why a chord cannot or should not be used.
//
// Pure, with the platform passed in, so the editor, the Quick slots page and a
// test can all ask the same question and get the same answer.

import type { KeybindingDefinition, KeybindingsSnapshot } from "./types";
import { KEYBINDING_UNASSIGNED } from "./keybindings";
import { quickSlotLeaderModifiers, type QuickSlotsPreferences } from "./quickSlots";

export type KeyboardPlatform = "mac" | "windows" | "linux";

/** A chord as the matcher sees it: `Mod` already turned into ⌘ or Ctrl. */
export type ResolvedChord = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

const MODIFIER_TOKENS = new Set(["mod", "ctrl", "control", "meta", "cmd", "command", "alt", "option", "shift"]);

/** Every alternative of a binding ("J,ArrowDown"), resolved for `platform`. */
export function resolveBindingChords(binding: string, platform: KeyboardPlatform): ResolvedChord[] {
  const out: ResolvedChord[] = [];
  if (!binding || binding.trim().toLowerCase() === KEYBINDING_UNASSIGNED) return out;
  for (const alternative of binding.split(",")) {
    const parts = alternative.split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) continue;
    const chord: ResolvedChord = { key: "", ctrl: false, meta: false, alt: false, shift: false };
    for (const part of parts) {
      const token = part.toLowerCase();
      if (token === "mod") {
        if (platform === "mac") chord.meta = true;
        else chord.ctrl = true;
      } else if (token === "ctrl" || token === "control") chord.ctrl = true;
      else if (token === "meta" || token === "cmd" || token === "command") chord.meta = true;
      else if (token === "alt" || token === "option") chord.alt = true;
      else if (token === "shift") chord.shift = true;
      else chord.key = token;
    }
    if (chord.key && !MODIFIER_TOKENS.has(chord.key)) out.push(chord);
  }
  return out;
}

/** One string per chord, so "Ctrl+K" and "Mod+K" compare equal on Windows. */
export function chordId(chord: ResolvedChord): string {
  return [
    chord.ctrl ? "ctrl" : "",
    chord.meta ? "meta" : "",
    chord.alt ? "alt" : "",
    chord.shift ? "shift" : "",
    chord.key,
  ].filter(Boolean).join("+");
}

// ── Capturing a key press ──────────────────────────────────────────────────

export type CaptureKeyEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
};

export type CaptureResult =
  /** Not a press to act on: IME composition, key repeat. */
  | { kind: "ignore" }
  /** Only modifiers are down so far; show them and keep listening. */
  | { kind: "modifiers"; label: ResolvedChord }
  /** A press that cannot become a shortcut, with the words to show. */
  | { kind: "refuse"; reason: string }
  | { kind: "binding"; binding: string; chord: ResolvedChord };

const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "NumLock", "ScrollLock",
]);

const NAMED_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab", "Escape", "Backspace", "Delete",
  "Home", "End", "PageUp", "PageDown", "Insert",
]);

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/**
 * The key a press is saved as. It follows the shortcut matcher
 * (`eventKeyCandidates` in `renderer/lib/keybindings.ts`), so a recorded chord
 * is one the matcher fires on:
 * - a Latin layout saves the letter it types (Dvorak's K is K, wherever it sits);
 * - a non-Latin layout (Russian `л`) saves the physical key (`KeyK` → K);
 * - Option on macOS changes what a key types (⌥K types `˚`), so with Option
 *   held a letter or digit is saved by its physical key.
 * Punctuation keeps the character the layout typed: it is what the keycap shows.
 */
function captureKeyName(event: CaptureKeyEvent, platform: KeyboardPlatform): string | null {
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit([0-9])$/.exec(code);
  if (platform === "mac" && event.altKey && (letter || digit)) return (letter?.[1] ?? digit?.[1])!;
  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
  if (/^[0-9]$/.test(event.key)) return event.key;
  if (letter && /^[\p{L}\p{M}]+$/u.test(event.key) && !/\p{Script=Latin}/u.test(event.key)) return letter[1]!;
  // Num Lock off turns the numpad into navigation keys; keep what it produced.
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad && /^[0-9]$/.test(event.key)) return numpad[1]!;
  if (FUNCTION_KEY.test(event.key)) return event.key;
  if (NAMED_KEYS.has(event.key)) return event.key;
  if (event.key.length === 1 && event.key.trim()) {
    return /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.key;
  }
  return null;
}

function isPunctuationKey(key: string): boolean {
  return key.length === 1 && !/^[A-Z0-9]$/.test(key);
}

/** Turn one keydown into a binding, or say why it cannot be one. */
export function captureBinding(event: CaptureKeyEvent, platform: KeyboardPlatform): CaptureResult {
  if (event.isComposing || event.keyCode === 229) return { kind: "ignore" };
  if (event.repeat) return { kind: "ignore" };

  const label: ResolvedChord = {
    key: "",
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  if (platform !== "mac" && event.getModifierState?.("AltGraph")) {
    return { kind: "refuse", reason: "AltGr types characters on this keyboard layout. Pick a chord without it." };
  }
  if (MODIFIER_KEYS.has(event.key)) return { kind: "modifiers", label };
  if (event.key === " " || event.code === "Space") {
    return { kind: "refuse", reason: "Space can't be a shortcut key. Pick a letter, digit or named key." };
  }
  if (platform !== "mac" && event.metaKey) {
    return {
      kind: "refuse",
      reason: platform === "windows"
        ? "The Windows key belongs to Windows. Use Ctrl, Alt or Shift."
        : "The Super key belongs to the desktop. Use Ctrl, Alt or Shift.",
    };
  }
  const key = captureKeyName(event, platform);
  if (!key) return { kind: "refuse", reason: "That key can't be used in a shortcut." };
  if (platform === "mac" && event.altKey && isPunctuationKey(key)) {
    return { kind: "refuse", reason: "Option changes what this key types on macOS. Use a letter or digit with Option." };
  }

  const parts: string[] = [];
  if (platform === "mac") {
    if (event.metaKey) parts.push("Mod");
    if (event.ctrlKey) parts.push("Ctrl");
  } else if (event.ctrlKey) {
    parts.push("Mod");
  }
  if (event.altKey) parts.push("Alt");
  // A shifted punctuation key already names its shifted character ("?"), and
  // the matcher sees Shift held with it, so Shift stays in the binding.
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  const binding = parts.join("+");
  return { kind: "binding", binding, chord: resolveBindingChords(binding, platform)[0]! };
}

/**
 * A key press whose action fires while you type must carry Ctrl, ⌘ or Alt, or
 * every press of that letter would both type and run the shortcut. Function
 * keys are exempt; so is a page whose shortcuts stay out of text fields
 * (Lanes, Home), and the one bare default (the tools pane's Escape).
 */
export function bareKeyRefusal(
  chord: ResolvedChord,
  definition: Pick<KeybindingDefinition, "scope" | "defaultBinding">,
  platform: KeyboardPlatform,
): string | null {
  if (chord.ctrl || chord.meta || chord.alt) return null;
  if (FUNCTION_KEY.test(chord.key.toUpperCase())) return null;
  const typingScopes = new Set<KeybindingDefinition["scope"]>(["global", "work", "chat", "terminal"]);
  if (!typingScopes.has(definition.scope)) return null;
  const defaultIsBare = resolveBindingChords(definition.defaultBinding, platform)
    .some((candidate) => !candidate.ctrl && !candidate.meta && !candidate.alt);
  if (defaultIsBare) return null;
  return platform === "mac"
    ? "This shortcut works while you type. Add ⌘, ⌃ or ⌥."
    : "This shortcut works while you type. Add Ctrl or Alt.";
}

// ── Chords the user cannot have ───────────────────────────────────────────

export type ReservedChord = {
  /** Who takes the chord first. */
  owner: "system" | "menu" | "editing" | "browser" | "altgr";
  reason: string;
};

type ReservedRow = { chord: string; owner: ReservedChord["owner"]; what: string };

const EDITING: ReservedRow[] = [
  { chord: "Mod+C", owner: "editing", what: "Copy" },
  { chord: "Mod+V", owner: "editing", what: "Paste" },
  { chord: "Mod+X", owner: "editing", what: "Cut" },
  { chord: "Mod+A", owner: "editing", what: "Select all" },
  { chord: "Mod+Z", owner: "editing", what: "Undo" },
  { chord: "Mod+Shift+Z", owner: "editing", what: "Redo" },
];

// The accelerators ADE's own native menu registers (main.ts and the Electron
// menu roles). The menu takes them before the page sees the key.
const MENU_ALL: ReservedRow[] = [
  { chord: "Mod+N", owner: "menu", what: "New window" },
  { chord: "Mod+W", owner: "menu", what: "Close" },
  { chord: "Mod+F", owner: "menu", what: "Find" },
  { chord: "Mod+0", owner: "menu", what: "Actual size" },
  { chord: "Mod+=", owner: "menu", what: "Zoom in" },
  { chord: "Mod+Plus", owner: "menu", what: "Zoom in" },
  { chord: "Mod+-", owner: "menu", what: "Zoom out" },
  { chord: "Mod+R", owner: "menu", what: "Reload" },
];

const MAC_ROWS: ReservedRow[] = [
  { chord: "Mod+Q", owner: "menu", what: "Quit ADE" },
  { chord: "Mod+H", owner: "menu", what: "Hide ADE" },
  { chord: "Mod+Alt+H", owner: "menu", what: "Hide others" },
  { chord: "Mod+M", owner: "menu", what: "Minimize" },
  { chord: "Mod+Alt+I", owner: "menu", what: "Developer tools" },
  { chord: "Mod+Ctrl+F", owner: "menu", what: "Full screen" },
  { chord: "Mod+Tab", owner: "system", what: "switching apps" },
  { chord: "Mod+Shift+Tab", owner: "system", what: "switching apps" },
  { chord: "Mod+Space", owner: "system", what: "Spotlight" },
  { chord: "Ctrl+Space", owner: "system", what: "switching input sources" },
  { chord: "Mod+Shift+3", owner: "system", what: "screenshots" },
  { chord: "Mod+Shift+4", owner: "system", what: "screenshots" },
  { chord: "Mod+Shift+5", owner: "system", what: "screenshots" },
  { chord: "Mod+Shift+6", owner: "system", what: "screenshots" },
  { chord: "Mod+Alt+Escape", owner: "system", what: "Force Quit" },
  { chord: "Mod+Ctrl+Q", owner: "system", what: "Lock Screen" },
  { chord: "Mod+Alt+D", owner: "system", what: "showing the Dock" },
  { chord: "Ctrl+ArrowUp", owner: "system", what: "Mission Control" },
  { chord: "Ctrl+ArrowDown", owner: "system", what: "App Exposé" },
  { chord: "Ctrl+ArrowLeft", owner: "system", what: "switching Spaces" },
  { chord: "Ctrl+ArrowRight", owner: "system", what: "switching Spaces" },
];

const WINDOWS_ROWS: ReservedRow[] = [
  { chord: "Mod+Y", owner: "editing", what: "Redo" },
  { chord: "Mod+Shift+I", owner: "menu", what: "Developer tools" },
  { chord: "F11", owner: "menu", what: "Full screen" },
  { chord: "Alt+Tab", owner: "system", what: "switching windows" },
  { chord: "Alt+Shift+Tab", owner: "system", what: "switching windows" },
  { chord: "Alt+F4", owner: "system", what: "closing the window" },
  { chord: "Alt+Space", owner: "system", what: "the window menu" },
  { chord: "Alt+Escape", owner: "system", what: "cycling windows" },
  { chord: "Ctrl+Escape", owner: "system", what: "the Start menu" },
  { chord: "Ctrl+Shift+Escape", owner: "system", what: "Task Manager" },
  { chord: "Ctrl+Alt+Delete", owner: "system", what: "the security screen" },
];

const LINUX_ROWS: ReservedRow[] = [
  { chord: "Mod+Y", owner: "editing", what: "Redo" },
  { chord: "Mod+Shift+I", owner: "menu", what: "Developer tools" },
  { chord: "F11", owner: "menu", what: "Full screen" },
  { chord: "Alt+Tab", owner: "system", what: "switching windows" },
  { chord: "Alt+Shift+Tab", owner: "system", what: "switching windows" },
  { chord: "Alt+F4", owner: "system", what: "closing the window" },
  { chord: "Alt+F2", owner: "system", what: "the run dialog" },
  { chord: "Ctrl+Alt+T", owner: "system", what: "opening a terminal" },
  { chord: "Ctrl+Alt+Delete", owner: "system", what: "logging out" },
  { chord: "Ctrl+Alt+ArrowUp", owner: "system", what: "switching workspaces" },
  { chord: "Ctrl+Alt+ArrowDown", owner: "system", what: "switching workspaces" },
  { chord: "Ctrl+Alt+ArrowLeft", owner: "system", what: "switching workspaces" },
  { chord: "Ctrl+Alt+ArrowRight", owner: "system", what: "switching workspaces" },
];

// In a browser tab the browser answers these and the page never sees them.
const BROWSER_ROWS: ReservedRow[] = [
  { chord: "Mod+T", owner: "browser", what: "new tab" },
  { chord: "Mod+Shift+T", owner: "browser", what: "reopen tab" },
  { chord: "Mod+W", owner: "browser", what: "close tab" },
  { chord: "Mod+N", owner: "browser", what: "new window" },
  { chord: "Mod+Shift+N", owner: "browser", what: "new private window" },
  { chord: "Mod+L", owner: "browser", what: "the address bar" },
  { chord: "Mod+Q", owner: "browser", what: "quitting the browser" },
  { chord: "Ctrl+Tab", owner: "browser", what: "switching tabs" },
  { chord: "Ctrl+Shift+Tab", owner: "browser", what: "switching tabs" },
  { chord: "Ctrl+PageDown", owner: "browser", what: "switching tabs" },
  { chord: "Ctrl+PageUp", owner: "browser", what: "switching tabs" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => ({ chord: `Mod+${digit}`, owner: "browser" as const, what: "switching tabs" })),
];

function reservedRows(platform: KeyboardPlatform, web: boolean): ReservedRow[] {
  const platformRows = platform === "mac" ? MAC_ROWS : platform === "windows" ? WINDOWS_ROWS : LINUX_ROWS;
  // The hosted client has no native menu: ADE's accelerators do not exist
  // there, the browser's do.
  const appRows = web
    ? [...BROWSER_ROWS, ...platformRows.filter((row) => row.owner !== "menu")]
    : [...MENU_ALL, ...platformRows];
  return [...EDITING, ...appRows];
}

function reservedReason(row: ReservedRow, platform: KeyboardPlatform): string {
  switch (row.owner) {
    case "editing": return `${row.what} uses this chord in every text field.`;
    case "menu": return `ADE's menu uses this for ${row.what}, and the menu gets the key first.`;
    case "browser": return `Your browser keeps this chord for ${row.what}; the page never sees it.`;
    case "altgr": return row.what;
    case "system":
    default:
      return `${platform === "mac" ? "macOS" : platform === "windows" ? "Windows" : "Your desktop"} uses this for ${row.what}, before ADE sees the key.`;
  }
}

/** Why a chord belongs to something other than ADE's shortcuts, or null. */
export function reservedChord(
  chord: ResolvedChord,
  platform: KeyboardPlatform,
  options: { web?: boolean } = {},
): ReservedChord | null {
  // AltGr is reported as Ctrl+Alt on Windows, so Ctrl+Alt plus a character key
  // is a character someone types on many layouts (Ctrl+Alt+E is €).
  if (platform === "windows" && chord.ctrl && chord.alt && !chord.meta && chord.key.length === 1) {
    return { owner: "altgr", reason: "Ctrl+Alt is AltGr on many keyboard layouts, so this chord types a character." };
  }
  const id = chordId(chord);
  for (const row of reservedRows(platform, options.web === true)) {
    const reserved = resolveBindingChords(row.chord, platform)[0];
    if (reserved && chordId(reserved) === id) return { owner: row.owner, reason: reservedReason(row, platform) };
  }
  return null;
}

// ── Conflicts with other shortcuts ───────────────────────────────────────────

/**
 * Two scopes overlap when one key press could reach both. Global shortcuts
 * reach everything; the prompt box and the terminal live inside Work, so their
 * shortcuts share Work's keys; each page's own scope (Lanes, Home, …) is only
 * listened for while that page is showing.
 */
export function scopesOverlap(a: KeybindingDefinition["scope"], b: KeybindingDefinition["scope"]): boolean {
  if (a === b || a === "global" || b === "global") return true;
  const work = new Set<KeybindingDefinition["scope"]>(["work", "chat", "terminal"]);
  return work.has(a) && work.has(b);
}

export type BindingConflict = { id: string; description: string };

/** The actions that already answer to any chord in `binding`, minus `selfId`. */
export function findBindingConflicts(args: {
  selfId: string;
  binding: string;
  definitions: readonly KeybindingDefinition[];
  effectiveBinding: (definition: KeybindingDefinition) => string;
  platform: KeyboardPlatform;
}): BindingConflict[] {
  const self = args.definitions.find((definition) => definition.id === args.selfId);
  if (!self) return [];
  const wanted = new Set(resolveBindingChords(args.binding, args.platform).map(chordId));
  if (!wanted.size) return [];
  const out: BindingConflict[] = [];
  for (const other of args.definitions) {
    if (other.id === self.id || !scopesOverlap(self.scope, other.scope)) continue;
    const chords = resolveBindingChords(args.effectiveBinding(other), args.platform);
    if (chords.some((chord) => wanted.has(chordId(chord)))) {
      out.push({ id: other.id, description: other.description });
    }
  }
  return out;
}

/**
 * The Quick slot a chord would shadow, or null. Quick slots read their leader
 * plus a digit before any shortcut, so a shortcut on that chord never fires.
 */
export function quickSlotChordConflict(
  chord: ResolvedChord,
  leader: QuickSlotsPreferences["leader"],
  platform: KeyboardPlatform,
): number | null {
  if (!/^[1-9]$/.test(chord.key)) return null;
  const want = quickSlotLeaderModifiers(leader, platform === "mac");
  return chord.meta === want.meta && chord.ctrl === want.ctrl && chord.alt === want.alt && chord.shift === want.shift
    ? Number(chord.key)
    : null;
}

/**
 * The new overrides list after setting one action. A binding equal to the
 * default drops the override, so "reset" and "set it back by hand" store the
 * same thing and a later change of default still reaches this user.
 */
export function withOverride(
  snapshot: Pick<KeybindingsSnapshot, "overrides">,
  id: string,
  binding: string | null,
  defaultBinding: string,
  platform: KeyboardPlatform,
): KeybindingsSnapshot["overrides"] {
  const rest = snapshot.overrides.filter((override) => override.id !== id);
  if (binding === null) return rest;
  const sameAsDefault = binding.toLowerCase() !== KEYBINDING_UNASSIGNED
    && sameChords(binding, defaultBinding, platform);
  return sameAsDefault ? rest : [...rest, { id, binding }];
}

function sameChords(a: string, b: string, platform: KeyboardPlatform): boolean {
  const left = resolveBindingChords(a, platform).map(chordId).sort().join(",");
  const right = resolveBindingChords(b, platform).map(chordId).sort().join(",");
  return left.length > 0 && left === right;
}
