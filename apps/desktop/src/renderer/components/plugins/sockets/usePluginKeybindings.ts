import React from "react";

import { KEYBINDING_DEFINITIONS } from "../../../../shared/keybindings";
import {
  buildCoreChordIndex,
  normalizeChordKeyName,
  parsePluginChord,
  pluginKeybindingRequests,
  resolvePluginKeybindings,
  type PluginChord,
  type PluginKeybindingRequest,
  type PluginKeybindingResolution,
  type ResolvedPluginKeybinding,
} from "../../../../shared/plugins/keybindings";
import { isPluginRegistrationDisabled } from "../../../../shared/plugins/disabledContributions";
import type { KeybindingsSnapshot } from "../../../../shared/types";
import type { InstalledPlugin } from "../../../lib/pluginRuntimeBridge";
import { useAppStore, useRootAppStore } from "../../../state/appStore";

/**
 * The `keybindings.register` socket: a plugin's chords, ruled on and matchable.
 *
 * The matrix itself is deliberately NOT here — it lives in
 * `shared/plugins/keybindings.ts`, above both this client and the Ink TUI, so a
 * chord that the desktop refuses is refused in `ade code` too. What this module
 * owns is the two halves the shared module cannot know: which chords count as
 * "core" in the desktop renderer, and how a real `KeyboardEvent` becomes one.
 *
 * There is no central key dispatcher in this app — two ad-hoc `keydown`
 * listeners and nothing that arbitrates between them — which is exactly why the
 * arbitration had to be built rather than borrowed. It is built here as a pure
 * resolution the caller installs a listener for, rather than as a listener of
 * its own, so the palette can read the same answer to draw a shortcut chip
 * without a second source of truth deciding what is bound.
 */

/* ── Core's claim ───────────────────────────────────────────────────────── */

/**
 * Every chord ADE itself answers to, as the matrix wants it.
 *
 * Both the shipped default AND the user's override are claimed, and that is not
 * belt-and-braces. A user who moves the command palette to `Mod+J` has told us
 * `Mod+J` is core's — a plugin taking it would silently break the rebinding
 * they just made. And leaving the vacated `Mod+K` claimable would hand the most
 * muscle-memorized chord in the product to whichever plugin asked, which is the
 * one outcome nobody would attribute correctly.
 */
export function coreChordEntries(snapshot: KeybindingsSnapshot | null): [string, string][] {
  const entries: [string, string][] = [];
  // The compiled table first, then anything the host's snapshot adds to it. A
  // definition this build ships must not become claimable because a snapshot
  // arrived late, or narrow, or null.
  for (const definition of KEYBINDING_DEFINITIONS) entries.push([definition.id, definition.defaultBinding]);
  for (const definition of snapshot?.definitions ?? []) entries.push([definition.id, definition.defaultBinding]);
  for (const override of snapshot?.overrides ?? []) {
    if (override.binding) entries.push([override.id, override.binding]);
  }
  return entries;
}

/* ── Matching a real keystroke ──────────────────────────────────────────── */

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

/**
 * Does this event fire this chord, on this platform?
 *
 * Mirrors `renderer/lib/keybindings.ts`'s `comboMatchesEvent` rather than
 * calling it, and the difference is the reason: that parser treats any token it
 * does not recognize as the KEY, so a plugin writing `"Super+K"` — a spelling
 * the shared grammar accepts — would parse there as the bare key `k` and fire
 * on every keystroke of the letter. Plugin chords go through the shared
 * grammar, and only the platform resolution happens here.
 */
export function pluginChordMatchesEvent(event: KeyboardEvent, chord: PluginChord): boolean {
  const key = normalizeChordKeyName(event.key);
  if (!key || key !== chord.key) return false;
  const isMac = isMacPlatform();
  const requiredCtrl = chord.ctrl || (chord.mod && !isMac);
  const requiredMeta = chord.meta || (chord.mod && isMac);
  if (event.ctrlKey !== requiredCtrl) return false;
  if (event.metaKey !== requiredMeta) return false;
  if (event.altKey !== chord.alt) return false;
  if (event.shiftKey !== chord.shift) return false;
  return true;
}

/**
 * The resolved binding this event fires, or null.
 *
 * Pure and exported so the listener in `AppShell` is four lines and the
 * interesting behaviour is testable without a shell.
 */
export function matchPluginKeybinding(
  event: KeyboardEvent,
  bindings: readonly ResolvedPluginKeybinding[],
): ResolvedPluginKeybinding | null {
  for (const binding of bindings) {
    const chord = parsePluginChord(binding.binding);
    if (chord && pluginChordMatchesEvent(event, chord)) return binding;
  }
  return null;
}

/**
 * Is the user typing into something right now?
 *
 * The same guard `LanesPage` uses, and it is not redundant with the shared
 * module's modifier requirement. `Mod+B` in a composer is bold in some editors
 * and a plugin action here; `Alt+Backspace`-adjacent chords delete words. A
 * shortcut that fires mid-sentence is a data-loss bug, and the cheapest correct
 * answer is that a field with focus wins.
 */
export function targetIsTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable;
}

/**
 * The whole decision one keystroke needs, in one place.
 *
 * `AppShell` installs the listener — that is where the app's other global
 * `keydown` lives, and a reader looking for what swallows a key should find
 * them together — but the listener is four lines of glue and this is the part
 * with rules in it: the typing guard, the platform resolution, and the
 * agreement to dispatch through the same path a button press uses so `composer`
 * / `dialog` / `navigate` response verbs keep working.
 *
 * Returns whether the event was consumed, so a caller can chain.
 */
export function dispatchPluginKeybindingEvent(
  event: KeyboardEvent,
  bindings: readonly ResolvedPluginKeybinding[],
  run: (pluginId: string, actionId: string) => void,
): boolean {
  if (event.defaultPrevented) return false;
  if (targetIsTyping(event.target)) return false;
  const binding = matchPluginKeybinding(event, bindings);
  if (!binding) return false;
  event.preventDefault();
  run(binding.pluginId, binding.action);
  return true;
}

/* ── Display ────────────────────────────────────────────────────────────── */

const DISPLAY_KEY_LABELS: Readonly<Record<string, string>> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  space: "Space",
  esc: "Esc",
  enter: "Enter",
  tab: "Tab",
};

/**
 * A chord as a person reads it: `"⌘⇧P"` on a Mac, `"Ctrl+Shift+P"` elsewhere.
 *
 * Built from the parsed chord rather than from the manifest string, so two
 * plugins writing `"Mod+Shift+P"` and `"mod+shift+p"` draw one chip.
 */
export function formatPluginChordForDisplay(binding: string): string | null {
  const chord = parsePluginChord(binding);
  if (!chord) return null;
  const mac = isMacPlatform();
  const key = DISPLAY_KEY_LABELS[chord.key]
    ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.charAt(0).toUpperCase() + chord.key.slice(1));
  if (mac) {
    const parts = [
      chord.ctrl ? "⌃" : "",
      chord.alt ? "⌥" : "",
      chord.shift ? "⇧" : "",
      chord.mod || chord.meta ? "⌘" : "",
    ].filter(Boolean);
    return `${parts.join("")}${key}`;
  }
  const parts = [
    chord.mod || chord.ctrl ? "Ctrl" : "",
    chord.meta ? "Win" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
  ].filter(Boolean);
  return [...parts, key].join("+");
}

/* ── Resolution ─────────────────────────────────────────────────────────── */

const EMPTY_RESOLUTION: PluginKeybindingResolution = { bindings: [], refusals: [] };

/**
 * Requests from the installed set. Disabled plugins bind nothing, and neither
 * does a chord the user switched off on its own — keyed `keybinding:<action>`,
 * see `shared/plugins/disabledContributions.ts`.
 */
export function pluginKeybindingRequestsFor(
  plugins: readonly InstalledPlugin[],
): PluginKeybindingRequest[] {
  const requests: PluginKeybindingRequest[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const declarations = (plugin.keybindings ?? []).filter((declared) => !isPluginRegistrationDisabled(
      plugin.disabledContributions,
      "keybinding",
      declared.action,
    ));
    if (declarations.length === 0) continue;
    requests.push(...pluginKeybindingRequests(
      {
        pluginId: plugin.pluginId,
        displayName: plugin.displayName || plugin.pluginId,
        // Absent on a host too old to report it. Empty sorts first, which only
        // moves the tie-break — never who beats core.
        installedAt: plugin.installedAt ?? "",
      },
      [...declarations],
    ));
  }
  return requests;
}

/**
 * The identity of the inputs, as a string.
 *
 * `installedPlugins` is a fresh array on every registry poll, so memoizing on
 * its reference would hand a new resolution object to `AppShell` every few
 * seconds — reinstalling the listener and, worse, re-running the refusal log.
 * Keying on what the resolution actually depends on is what makes the result
 * stable across a poll that changed nothing.
 */
function resolutionKey(
  plugins: readonly InstalledPlugin[],
  snapshot: KeybindingsSnapshot | null,
): string {
  const pluginPart = plugins
    .filter((plugin) => plugin.enabled && (plugin.keybindings?.length ?? 0) > 0)
    .map((plugin) => [
      plugin.pluginId,
      plugin.installedAt ?? "",
      (plugin.keybindings ?? []).map((entry) => `${entry.action}=${entry.binding}=${entry.label}`).join(","),
      // Part of the identity: switching one chord off must re-resolve, and the
      // declarations themselves do not change when it does.
      (plugin.disabledContributions ?? []).join(","),
    ].join("|"))
    .join(";");
  const corePart = coreChordEntries(snapshot).map(([id, binding]) => `${id}=${binding}`).join(";");
  return `${pluginPart}::${corePart}`;
}

/**
 * Refusals already written to the console, so a remount does not repeat them.
 *
 * Module-level rather than per-hook because two callers mount this — the global
 * listener and the palette's chip — and the refusal is a fact about the install
 * set, not about either of them. The key includes the reason, so a plugin that
 * loses a chord to core and later loses it to another plugin says both.
 */
const loggedRefusals = new Set<string>();

/** Test seam. */
export function resetPluginKeybindingRefusalLog(): void {
  loggedRefusals.clear();
}

/**
 * Every plugin chord that survived the matrix, plus everything that did not.
 *
 * The refusals are logged here, once, using the sentence the matrix already
 * wrote — never a message invented at the call site, because the TUI has to be
 * able to say the same thing about the same manifest.
 */
export function usePluginKeybindings(): PluginKeybindingResolution {
  const plugins = useRootAppStore((state) => state.installedPlugins);
  const snapshot = useAppStore((state) => state.keybindings);
  const key = resolutionKey(plugins, snapshot);

  const resolution = React.useMemo(
    () => {
      const requests = pluginKeybindingRequestsFor(plugins);
      if (requests.length === 0) return EMPTY_RESOLUTION;
      return resolvePluginKeybindings(requests, buildCoreChordIndex(coreChordEntries(snapshot)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for both inputs
    [key],
  );

  React.useEffect(() => {
    for (const refusal of resolution.refusals) {
      const id = `${refusal.pluginId}::${refusal.action}::${refusal.binding}::${refusal.reason}`;
      if (loggedRefusals.has(id)) continue;
      loggedRefusals.add(id);
      console.warn(`[plugin keybindings] ${refusal.message}`);
    }
  }, [resolution]);

  return resolution;
}
