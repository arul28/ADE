import type { KeybindingOverride, KeybindingsSnapshot } from "../../shared/types";
import { keybindingDefinitionsFor } from "../../shared/keybindings";
import { isMacPlatform } from "./platform";
import { isWebClientMode } from "./webClientMode";

/**
 * This computer's keyboard shortcuts.
 *
 * Shortcuts belong to the keyboard and the OS in front of you, not to a
 * project or the machine a project lives on: ⌘ on a Mac and Ctrl on a PC are
 * different chords, and a project opened from another machine is still typed
 * on this one. So the overrides live in this renderer's storage, beside
 * Appearance and Quick slots, and every project reads the same set. The hosted
 * client keeps them in the browser for the same reason.
 *
 * Before this, overrides lived in each project's database behind
 * `window.ade.keybindings`. The first read on a computer with nothing saved yet
 * copies the open project's overrides once, so nothing saved there is lost.
 */

export const KEYBINDINGS_STORAGE_KEY = "ade.keybindings.v1";

const MAX_OVERRIDES = 200;

type StoredKeybindings = { version: 1; overrides: KeybindingOverride[] };

export function sanitizeKeybindingOverrides(raw: unknown): KeybindingOverride[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeybindingOverride[] = [];
  for (const entry of raw) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const binding = typeof entry?.binding === "string" ? entry.binding.trim() : "";
    if (!id || !binding || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, binding });
  }
  return out.slice(0, MAX_OVERRIDES);
}

function definitions(): KeybindingsSnapshot["definitions"] {
  return keybindingDefinitionsFor({ web: isWebClientMode(), mac: isMacPlatform() });
}

/** `null` = nothing saved on this computer yet (the one-time copy may run). */
let cached: { overrides: KeybindingOverride[] | null } | null = null;
let snapshotCache: KeybindingsSnapshot | null = null;

function readStored(): KeybindingOverride[] | null {
  if (cached) return cached.overrides;
  let overrides: KeybindingOverride[] | null = null;
  try {
    const raw = window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
    if (raw != null) overrides = sanitizeKeybindingOverrides((JSON.parse(raw) as Partial<StoredKeybindings>)?.overrides);
  } catch {
    // Unreadable storage reads as "nothing saved"; the defaults still work.
  }
  cached = { overrides };
  return overrides;
}

/**
 * The snapshot every reader uses. Stable identity until the overrides change,
 * so a selector over it does not re-render anything on an unrelated store write.
 */
export function readKeybindingsSnapshot(): KeybindingsSnapshot {
  if (snapshotCache) return snapshotCache;
  snapshotCache = { definitions: definitions(), overrides: readStored() ?? [] };
  return snapshotCache;
}

type Listener = (snapshot: KeybindingsSnapshot) => void;
const listeners = new Set<Listener>();

function emit(): void {
  snapshotCache = null;
  const snapshot = readKeybindingsSnapshot();
  for (const listener of listeners) listener(snapshot);
}

let followingOtherWindows = false;

/** Another ADE window on this computer saved: follow it. Attached once, on first use. */
function followOtherWindows(): void {
  if (followingOtherWindows || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  followingOtherWindows = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== KEYBINDINGS_STORAGE_KEY) return;
    cached = null;
    emit();
  });
}

export function subscribeKeybindings(listener: Listener): () => void {
  followOtherWindows();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Save this computer's overrides. Throws when storage refuses the write. */
export function writeKeybindingOverrides(overrides: readonly KeybindingOverride[]): KeybindingsSnapshot {
  const clean = sanitizeKeybindingOverrides(overrides);
  const stored: StoredKeybindings = { version: 1, overrides: clean };
  window.localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(stored));
  cached = { overrides: clean };
  emit();
  return readKeybindingsSnapshot();
}

let migration: Promise<void> | null = null;

/**
 * Copy the open project's stored overrides the first time this computer has
 * none of its own. Runs once per window; a read that fails (no project open
 * yet) is tried again on the next refresh.
 */
export function migrateProjectKeybindingsOnce(
  readProjectSnapshot: () => Promise<KeybindingsSnapshot>,
): Promise<void> {
  if (readStored() !== null) return Promise.resolve();
  if (migration) return migration;
  migration = readProjectSnapshot()
    .then((snapshot) => {
      // A save made while the read was out wins.
      if (readStored() !== null) return;
      writeKeybindingOverrides(sanitizeKeybindingOverrides(snapshot?.overrides));
    })
    .catch((error: unknown) => {
      // Defaults still work; the copy is tried again on the next refresh.
      console.warn("[keybindings] could not copy the project's saved shortcuts", error);
      migration = null;
    });
  return migration;
}
