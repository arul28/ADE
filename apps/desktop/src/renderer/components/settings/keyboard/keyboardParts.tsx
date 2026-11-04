import React, { useMemo } from "react";
import type { KeybindingDefinition, KeybindingsSnapshot } from "../../../../shared/types";
import {
  chordId,
  findBindingConflicts,
  quickSlotChordConflict,
  reservedChord,
  resolveBindingChords,
  type KeyboardPlatform,
} from "../../../../shared/keybindingEditor";
import type { QuickSlotsPreferences } from "../../../../shared/quickSlots";
import { bindingKeyCaps, getEffectiveBinding } from "../../../lib/keybindings";
import { isMacPlatform, isWindowsPlatform } from "../../../lib/platform";

type QuickSlotLeader = QuickSlotsPreferences["leader"];

/** The pieces Settings › Keyboard shares between its banner and its cards. */

export function currentKeyboardPlatform(): KeyboardPlatform {
  if (isMacPlatform()) return "mac";
  return isWindowsPlatform() ? "windows" : "linux";
}

/** The Quick slots leader as keycaps, in the order the OS prints modifiers. */
export function leaderKeyCaps(leader: QuickSlotLeader, platform: KeyboardPlatform): string[] {
  if (platform !== "mac") return ["Ctrl", "Shift"];
  return leader === "alternate" ? ["⌃", "⌥"] : ["⌥", "⌘"];
}

/** Each alternative of a binding ("Mod+K,Mod+P") as its keys. */
export function bindingAlternatives(binding: string): string[][] {
  return binding
    .split(",")
    .map((alternative) => bindingKeyCaps(alternative.trim()))
    .filter((keys): keys is string[] => Boolean(keys?.length));
}

/** One chord as keycaps. */
export function KeyCaps({ keys, size }: { keys: readonly string[]; size?: "lg" }) {
  return (
    <span className="kit-keys" data-size={size}>
      {keys.map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}
    </span>
  );
}

/** Every alternative of a binding as keycaps, joined by "or". */
export function BindingCaps({ binding }: { binding: string }) {
  const alternatives = bindingAlternatives(binding);
  return (
    <>
      {alternatives.map((keys, index) => (
        <React.Fragment key={keys.join("+")}>
          {index > 0 ? <span className="ade-kbp-or">or</span> : null}
          <KeyCaps keys={keys} />
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * What each shortcut needs to say about its keys: a chord the OS, ADE's menu
 * or the browser takes first, a Quick slot that shadows it, or another
 * shortcut on the same keys. Keyed by definition id; absent means fine.
 */
export function useShortcutNotes(
  snapshot: KeybindingsSnapshot,
  leader: QuickSlotLeader,
  platform: KeyboardPlatform,
  web: boolean,
): Map<string, string[]> {
  return useMemo(() => {
    const notes = new Map<string, string[]>();
    const effective = (definition: KeybindingDefinition) =>
      getEffectiveBinding(snapshot, definition.id, definition.defaultBinding);
    for (const definition of snapshot.definitions) {
      const binding = effective(definition);
      const out: string[] = [];
      // A shipped default on a menu chord is deliberate (the Lanes filter's ⌘F).
      const shipped = new Set(resolveBindingChords(definition.defaultBinding, platform).map(chordId));
      for (const chord of resolveBindingChords(binding, platform)) {
        const reserved = shipped.has(chordId(chord)) ? null : reservedChord(chord, platform, { web });
        if (reserved) out.push(reserved.reason);
        const slot = quickSlotChordConflict(chord, leader, platform);
        if (slot) out.push(`Quick slot ${slot} uses these keys first, so this shortcut never runs.`);
      }
      const conflicts = findBindingConflicts({
        selfId: definition.id,
        binding,
        definitions: snapshot.definitions,
        effectiveBinding: effective,
        platform,
      });
      if (conflicts.length) out.push(`Same keys as ${conflicts.map((conflict) => conflict.description).join(", ")}.`);
      if (out.length) notes.set(definition.id, out);
    }
    return notes;
  }, [snapshot, leader, platform, web]);
}
