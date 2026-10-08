import { musicAvailable } from "./musicStore";

/** The machine-level Music top tab. Not a project surface. */
export const MUSIC_TAB_ROUTE = "/music";

/** The keybinding that opens it, with the default it falls back to. */
export const MUSIC_TAB_KEYBINDING = { id: "shell.music.open", fallback: "Mod+Shift+M" } as const;

export function isMusicTabRoute(pathname: string): boolean {
  return pathname === MUSIC_TAB_ROUTE || pathname.startsWith(`${MUSIC_TAB_ROUTE}/`);
}

/** The desktop app has Music; the hosted web client does not. */
export function musicTabAvailable(): boolean {
  return musicAvailable();
}
