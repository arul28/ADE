import { createContext, useContext } from "react";

/**
 * The anchors the settings search matched on the open tab, or null while
 * nothing is being searched. A page that shows one part at a time (Health's
 * inner tabs) reads it to open the part that holds the match; otherwise the
 * search would hide every card of the part on screen and leave it blank.
 */
export const SettingsSearchAnchorsContext = createContext<readonly string[] | null>(null);

export function useSettingsSearchAnchors(): readonly string[] | null {
  return useContext(SettingsSearchAnchorsContext);
}
