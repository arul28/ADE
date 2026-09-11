import type { BrowserLinkOpenMode } from "../../shared/types/config";

/** Modifier state of the click that opened a link. */
export type LinkOpenModifiers = {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};

export type LinkOpenTarget = "in-app" | "external";

export type ResolveLinkOpenTargetArgs = {
  /** The `browser.linkOpenMode` preference. */
  mode: BrowserLinkOpenMode;
  modifiers?: LinkOpenModifiers | null;
  /** Which key counts as "Mod". Injected so the rule is testable per OS. */
  isMac?: boolean;
};

/**
 * Where one link click should open.
 *
 * Two escape hatches sit on top of the preference, and they are absolute so a
 * person never has to open Settings to get the other behaviour once:
 *
 * - **Mod+Click** (Cmd on macOS, Ctrl elsewhere) always opens externally. This
 *   is the platform gesture for "somewhere else", and it is the escape hatch
 *   that matters: a site that will not render in the embedded view, or an OAuth
 *   flow the person wants in their own signed-in browser, must always have a
 *   way out. It wins over Shift for exactly that reason.
 * - **Shift+Click** always opens in ADE.
 */
export function resolveLinkOpenTarget({
  mode,
  modifiers,
  isMac = false,
}: ResolveLinkOpenTargetArgs): LinkOpenTarget {
  const modPressed = isMac ? Boolean(modifiers?.metaKey) : Boolean(modifiers?.ctrlKey);
  if (modPressed) return "external";
  if (modifiers?.shiftKey) return "in-app";
  return mode === "external" ? "external" : "in-app";
}
