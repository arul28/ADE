import type { KeybindingDefinition, KeybindingsSnapshot } from "../../shared/types";

type ParsedCombo = {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

function isMacPlatform(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

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
  fallback: string
): string {
  if (!snapshot) return fallback;
  const def = snapshot.definitions.find((d) => d.id === actionId) as KeybindingDefinition | undefined;
  const override = snapshot.overrides.find((o) => o.id === actionId);
  const candidate = (override?.binding ?? def?.defaultBinding ?? fallback).trim();
  if (parseBinding(candidate).length > 0) return candidate;
  // Invalid/empty binding: fall back to default.
  const defBinding = (def?.defaultBinding ?? fallback).trim() || fallback;
  return parseBinding(defBinding).length > 0 ? defBinding : fallback;
}
