/**
 * The one place a resolved theme touches the DOM.
 *
 * Applying a theme is a single pass: clear the variables the previous theme
 * owned, write the new theme's variables as inline styles on `<html>`, and set
 * the two identity attributes. Inline styles on the root win over both
 * stylesheet blocks, which is what lets a custom theme repaint the existing
 * `[data-theme]` structure without rewriting index.css.
 *
 * The module keeps its own list of applied property names rather than diffing
 * the element's inline styles — a diff would also remove inline variables some
 * other feature set, and `style` is a shared namespace.
 */

import type { ResolvedAdeTheme } from "../../shared/theme";

let appliedVarNames: string[] = [];

/** Remove every variable a previous `applyAdeTheme` wrote. Idempotent. */
export function clearAppliedTheme(root: HTMLElement = document.documentElement): void {
  for (const name of appliedVarNames) root.style.removeProperty(name);
  appliedVarNames = [];
}

/**
 * Paint `resolved` onto the document: inline custom properties on `<html>`,
 * `data-theme` for the structural block, and `data-theme-id` for identity.
 * Nothing below `<html>` may carry `data-theme` except a deliberately scoped
 * preview.
 *
 * Call it once per theme change — never per frame. The work is a fixed number
 * of `setProperty` calls and no layout reads, so it does not force reflow.
 */
export function applyAdeTheme(resolved: ResolvedAdeTheme, doc: Document = document): void {
  const root = doc.documentElement;
  clearAppliedTheme(root);
  for (const [name, value] of Object.entries(resolved.cssVars)) {
    root.style.setProperty(name, value);
    appliedVarNames.push(name);
  }
  const { baseMode, id } = resolved.theme;
  root.setAttribute("data-theme", baseMode);
  root.setAttribute("data-theme-id", id);
  // Native form controls, scrollbars and the caret follow this.
  root.style.colorScheme = baseMode;
  // Only `<html>` may carry the theme attributes. The stylesheet declares every
  // `--color-*` variable on `[data-theme]`, so the same attribute on `<body>`
  // or the app root redeclares the base palette one level down and hides the
  // inline overrides above. That made every shipped theme look like plain
  // dark or light.
  if (doc.body) {
    doc.body.removeAttribute("data-theme");
    doc.body.removeAttribute("data-theme-id");
  }
}

/** The names currently written to the root, for tests and diagnostics. */
export function appliedThemeVarNames(): readonly string[] {
  return appliedVarNames;
}
