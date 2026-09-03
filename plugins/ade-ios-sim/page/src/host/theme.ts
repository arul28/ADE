/**
 * Follow ADE's theme from inside the guest.
 *
 * Two things move together and both matter:
 *
 * - `applyAdeTheme` writes the host's palette as `--ade-*` on `:root`, which is
 *   what every `@ade-dev/ui` component reads.
 * - The same tokens are written again under the app's own `--color-*` names,
 *   which is what every ported Tailwind utility reads. Without the second write
 *   the kit would follow the host and the ported chrome would not, and the page
 *   would be two themes at once.
 *
 * A host that publishes no tokens leaves both untouched, and the page draws the
 * built-in palette `styles/palette.css` ships — ADE's own, verbatim. `scheme`
 * still lands on `data-theme`, so light and dark are right either way.
 */

import { applyAdeTheme } from "@ade-dev/ui";
import { bridge, type PluginWebviewThemeSnapshot } from "../bridge";

/** `--ade-<name>` → the app's `--color-<name>`, for the tokens that have one. */
const COLOR_ALIASES: Record<string, string> = {
  "--ade-bg": "--color-bg",
  "--ade-fg": "--color-fg",
  "--ade-surface": "--color-surface",
  "--ade-card": "--color-card",
  "--ade-card-fg": "--color-card-fg",
  "--ade-card-solid": "--color-card-solid",
  "--ade-muted": "--color-muted",
  "--ade-muted-fg": "--color-muted-fg",
  "--ade-secondary-fg": "--color-secondary-fg",
  "--ade-border": "--color-border",
  "--ade-accent": "--color-accent",
  "--ade-accent-fg": "--color-accent-fg",
  "--ade-accent-muted": "--color-accent-muted",
  "--ade-success": "--color-success",
  "--ade-warning": "--color-warning",
  "--ade-error": "--color-error",
  "--ade-info": "--color-info",
  "--ade-font-sans": "--font-sans",
  "--ade-font-mono": "--font-mono",
};

function paint(snapshot: PluginWebviewThemeSnapshot): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", snapshot.scheme);
  applyAdeTheme(snapshot.scheme, snapshot.tokens);
  for (const [token, alias] of Object.entries(COLOR_ALIASES)) {
    const value = snapshot.tokens?.[token];
    if (typeof value === "string" && value.length > 0) {
      document.documentElement.style.setProperty(alias, value);
    }
  }
}

/**
 * Paint once, then on every change. Returns the unsubscribe.
 *
 * The first paint is awaited by the caller before the tree mounts, so the page
 * never flashes the wrong scheme on open.
 */
export async function followHostTheme(): Promise<() => void> {
  const api = bridge();
  if (!api) return () => {};
  try {
    const snapshot = await api.theme?.get();
    if (snapshot) paint(snapshot);
  } catch {
    // A host with no theme to report. The built-in palette stands.
  }
  try {
    return api.events.on("theme", (next) => paint(next));
  } catch {
    return () => {};
  }
}
