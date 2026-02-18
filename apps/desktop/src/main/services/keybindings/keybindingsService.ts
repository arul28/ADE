import type { AdeDb } from "../state/kvDb";
import type { KeybindingOverride, KeybindingsSnapshot } from "../../../shared/types";
import { KEYBINDING_DEFINITIONS } from "../../../shared/keybindings";

const KEY = "keybindings:overrides";

function sanitizeOverrides(overrides: KeybindingOverride[]): KeybindingOverride[] {
  const seen = new Set<string>();
  const out: KeybindingOverride[] = [];
  for (const raw of overrides) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const binding = typeof raw?.binding === "string" ? raw.binding.trim() : "";
    if (!id || !binding) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, binding });
  }
  return out.slice(0, 200);
}

export function createKeybindingsService({ db }: { db: AdeDb }) {
  return {
    get(): KeybindingsSnapshot {
      const stored = db.getJson<KeybindingOverride[]>(KEY) ?? [];
      return {
        definitions: KEYBINDING_DEFINITIONS,
        overrides: sanitizeOverrides(stored)
      };
    },

    set(args: { overrides: KeybindingOverride[] }): KeybindingsSnapshot {
      const overrides = sanitizeOverrides(args.overrides ?? []);
      db.setJson(KEY, overrides);
      return { definitions: KEYBINDING_DEFINITIONS, overrides };
    }
  };
}

