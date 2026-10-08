/**
 * The words `ade browser attach` prints, shared by the code that prints them
 * (the attach service and the CLI) and the code that reads them back (the
 * transcript's computer-use rows on desktop, and their Swift copy on iOS).
 */

/** The browsers `ade browser attach` can reach. */
export const USER_BROWSER_IDS = ["chrome", "edge", "brave", "arc", "helium", "chromium"] as const;

export type UserBrowserId = (typeof USER_BROWSER_IDS)[number];

/** The short name a transcript row uses: "your Chrome". */
export const USER_BROWSER_SHORT_NAMES: Readonly<Record<UserBrowserId, string>> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  arc: "Arc",
  helium: "Helium",
  chromium: "Chromium",
};

/** The first word of `ade browser attach` output: `attached: Google Chrome on <machine>, tab "…"`. */
export const USER_BROWSER_ATTACHED_PREFIX = "attached:";
export const USER_BROWSER_DETACHED_PREFIX = "detached:";

/** The first line of every command made while attached: `target: your Google Chrome on <machine>`. */
export const USER_BROWSER_TARGET_PREFIX = "target:";

export function userBrowserTargetLabel(browserLabel: string, machine: string): string {
  return `your ${browserLabel} on ${machine}`;
}
