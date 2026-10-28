import type { KeybindingDefinition, KeybindingsSnapshot } from "../../shared/types";
import { WEB_KEYBINDING_DEFAULTS } from "../../shared/keybindings";
import { isMacPlatform, modifierKeyLabel } from "./platform";
import { isWebClientMode } from "./webClientMode";

type ParsedCombo = {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

function normalizeKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase();
}

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function parseOneCombo(raw: string): ParsedCombo | null {
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const combo: ParsedCombo = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };

  for (const part of parts) {
    const t = normalizeToken(part);
    if (t === "mod") {
      combo.mod = true;
      continue;
    }
    if (t === "ctrl" || t === "control") {
      combo.ctrl = true;
      continue;
    }
    if (t === "meta" || t === "cmd" || t === "command") {
      combo.meta = true;
      continue;
    }
    if (t === "alt" || t === "option") {
      combo.alt = true;
      continue;
    }
    if (t === "shift") {
      combo.shift = true;
      continue;
    }

    // Treat any unknown token as the key. If multiple unknown tokens exist,
    // prefer the last (e.g., "Mod+Shift+K").
    combo.key = normalizeKey(part);
  }

  if (!combo.key) return null;
  return combo;
}

function parseBinding(binding: string): ParsedCombo[] {
  return binding
    .split(",")
    .map((alt) => alt.trim())
    .filter(Boolean)
    .map(parseOneCombo)
    .filter((x): x is ParsedCombo => x != null);
}

function comboMatchesEvent(combo: ParsedCombo, event: KeyboardEvent): boolean {
  const key = normalizeKey(event.key);
  if (!key || key !== combo.key) return false;

  const isMac = isMacPlatform();
  const requiredCtrl = combo.ctrl || (combo.mod && !isMac);
  const requiredMeta = combo.meta || (combo.mod && isMac);

  if (event.ctrlKey !== requiredCtrl) return false;
  if (event.metaKey !== requiredMeta) return false;
  if (event.altKey !== combo.alt) return false;
  if (event.shiftKey !== combo.shift) return false;

  return true;
}

export function eventMatchesBinding(event: KeyboardEvent, binding: string): boolean {
  const combos = parseBinding(binding);
  for (const combo of combos) {
    if (comboMatchesEvent(combo, event)) return true;
  }
  return false;
}

export function getEffectiveBinding(
  snapshot: KeybindingsSnapshot | null,
  actionId: string,
  desktopFallback: string
): string {
  // In the hosted web client a browser-reserved desktop default (⌘T, Ctrl+Tab)
  // never reaches the page, so the web default replaces it — including over a
  // snapshot that still carries the desktop table. An override still wins.
  const webDefault = isWebClientMode() ? WEB_KEYBINDING_DEFAULTS[actionId] : undefined;
  const fallback = webDefault ?? desktopFallback;
  if (!snapshot) return fallback;
  const def = snapshot.definitions.find((d) => d.id === actionId) as KeybindingDefinition | undefined;
  const defaultBinding = webDefault ?? def?.defaultBinding;
  const override = snapshot.overrides.find((o) => o.id === actionId);
  const candidate = (override?.binding ?? defaultBinding ?? fallback).trim();
  if (parseBinding(candidate).length > 0) return candidate;
  // Invalid/empty binding: fall back to default.
  const defBinding = (defaultBinding ?? fallback).trim() || fallback;
  return parseBinding(defBinding).length > 0 ? defBinding : fallback;
}

/** A resolved combo, platform modifiers already applied (`Mod` → ⌘ or Ctrl). */
export type ParsedBindingCombo = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/**
 * The first alternative of a binding ("Mod+K", "Mod+K,Ctrl+P"), resolved for
 * this platform the way `eventMatchesBinding` resolves it when matching.
 *
 * Display chips and code that has to *re-play* a binding (a surface with no
 * programmatic entry point, such as the command palette) both read this, so
 * what the chip shows and what the re-play sends cannot drift.
 */
export function parsePrimaryCombo(binding: string): ParsedBindingCombo | null {
  const first = binding.split(",")[0]?.trim();
  if (!first) return null;
  const mac = isMacPlatform();
  const combo: ParsedBindingCombo = { key: "", ctrl: false, meta: false, alt: false, shift: false };
  for (const raw of first.split("+")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "mod") {
      if (mac) combo.meta = true;
      else combo.ctrl = true;
      continue;
    }
    if (token === "ctrl" || token === "control") { combo.ctrl = true; continue; }
    if (token === "meta" || token === "cmd" || token === "command") { combo.meta = true; continue; }
    if (token === "alt" || token === "option") { combo.alt = true; continue; }
    if (token === "shift") { combo.shift = true; continue; }
    combo.key = raw.trim();
  }
  return combo.key ? combo : null;
}

/** The real glyphs the OS prints for named keys in its own menus. */
const MAC_KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  enter: "↵",
  return: "↵",
  backspace: "⌫",
  delete: "⌦",
};
const WINDOWS_KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Del",
};

function keyLabel(key: string, mac: boolean): string {
  const table = mac ? MAC_KEY_GLYPHS : WINDOWS_KEY_GLYPHS;
  const glyph = table[key.toLowerCase()];
  if (glyph) return glyph;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * `⌘K` on macOS, `Ctrl+K` elsewhere — display only. Named keys render as the
 * OS glyphs (`⌘↑`, `⌃⇥`, `⎋`), so a chip reads the way the system's own menus
 * read rather than as a spelled-out token.
 */
export function bindingChipLabel(binding: string): string | null {
  const combo = parsePrimaryCombo(binding);
  if (!combo) return null;
  const mac = isMacPlatform();
  const parts: string[] = [];
  if (combo.ctrl) parts.push(mac ? "⌃" : modifierKeyLabel);
  if (combo.alt) parts.push(mac ? "⌥" : "Alt");
  if (combo.shift) parts.push(mac ? "⇧" : "Shift");
  // Off macOS there is no Meta key on the keyboard. A binding that spells the
  // modifier out ("Cmd+K", "Meta+K") resolves to the same key "Mod" does, so
  // it has to print as that key. Skipped when Ctrl already claimed the slot so
  // "Ctrl+Cmd+K" is not printed twice.
  if (combo.meta && !(!mac && combo.ctrl)) {
    parts.push(mac ? "⌘" : modifierKeyLabel);
  }
  parts.push(keyLabel(combo.key, mac));
  return mac ? parts.join("") : parts.join("+");
}

/**
 * Play a binding as a real keydown, for the surfaces that own no programmatic
 * entry point of their own (the command palette's `open` lives in `AppShell`
 * state and listens on the window). The user's own binding goes in, so a
 * rebound action still works from a button that points at it.
 */
export function fireBinding(binding: string): boolean {
  const combo = parsePrimaryCombo(binding);
  if (!combo || typeof window === "undefined") return false;
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key: combo.key,
    ctrlKey: combo.ctrl,
    metaKey: combo.meta,
    altKey: combo.alt,
    shiftKey: combo.shift,
    bubbles: true,
    cancelable: true,
  }));
  return true;
}
