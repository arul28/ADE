/**
 * Applies the Interface preferences to the document: the interface and code
 * faces as `--font-sans` / `--font-mono` overrides on `<html>`, and
 * `data-motion="reduced"` when the user turned motion off.
 *
 * The default faces write nothing, so the stylesheet's own stacks stay the
 * single source of truth for them.
 */

import type { InterfaceMonoFont, InterfacePreferences, InterfaceSansFont } from "../state/appStore";

const SANS_STACKS: Record<InterfaceSansFont, string | null> = {
  geist: null,
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "geist-mono": '"Geist Mono", ui-monospace, monospace',
};

const MONO_STACKS: Record<InterfaceMonoFont, string | null> = {
  jetbrains: null,
  "geist-mono": '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
  system: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

function setOrClear(root: HTMLElement, name: string, value: string | null): void {
  if (value) root.style.setProperty(name, value);
  else root.style.removeProperty(name);
}

export function applyInterfacePreferences(prefs: InterfacePreferences, doc: Document = document): void {
  const root = doc.documentElement;
  setOrClear(root, "--font-sans", SANS_STACKS[prefs.sansFont]);
  setOrClear(root, "--font-mono", MONO_STACKS[prefs.monoFont]);
  if (prefs.reduceMotion) root.setAttribute("data-motion", "reduced");
  else root.removeAttribute("data-motion");
}
