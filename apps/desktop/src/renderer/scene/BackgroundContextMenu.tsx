import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ImageSquare, Moon, Shuffle, Sun } from "@phosphor-icons/react";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../components/ui/ContextMenu";
import { navigateToAppTarget } from "../lib/openExternal";
import { useAppStore } from "../state/appStore";
import { ADE_THEME_FAMILIES, themeFamilyForId } from "../../shared/theme";
import { DEFAULT_SCENE_PREFERENCES } from "./scenePreferences";
import { reshuffleScene } from "./useScene";

/**
 * Anything the user can act on. A right-click on one of these is theirs
 * (rows, cards, the composer, links, text fields), not the background's.
 */
const INTERACTIVE = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='menu']",
  "[role='dialog']",
  ".kit-card",
  ".kit-row",
  "[data-chat-composer-wrapper]",
  ".ade-chat-launch-shelf",
].join(",");

/**
 * A right-click menu for the empty window background (the welcome screen and
 * the new chat page): the page's own actions first, then the background ones —
 * shuffle, light/dark, and Change background, which opens Settings ›
 * Appearance › Background.
 */
export function useBackgroundContextMenu(pageEntries: ContextMenuEntry[] = []): {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  menu: JSX.Element;
} {
  const [state, setState] = useState<ContextMenuState>(null);
  const theme = useAppStore((s) => s.theme);
  const followsSystem = useAppStore((s) => s.themeFollowsSystem);
  const setTheme = useAppStore((s) => s.setTheme);
  const setThemeFollowsSystem = useAppStore((s) => s.setThemeFollowsSystem);
  const themeId = useAppStore((s) => s.themeId);
  const shuffleOn = useAppStore((s) => (s.interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES).mode === "shuffle");

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(INTERACTIVE)) return;
    // A text selection keeps the system menu (Copy, Look Up…).
    if (window.getSelection()?.toString()) return;
    event.preventDefault();
    setState({ x: event.clientX, y: event.clientY });
  }, []);

  const entries = useMemo((): ContextMenuEntry[] => {
    const toLight = theme === "dark";
    const background: ContextMenuEntry[] = [
      ...(shuffleOn
        ? [{ kind: "item" as const, key: "shuffle", label: "Next picture", icon: Shuffle, onSelect: () => reshuffleScene() }]
        : []),
      {
        kind: "item",
        key: "mode",
        label: toLight ? "Switch to light" : "Switch to dark",
        icon: toLight ? Sun : Moon,
        hint: followsSystem ? "stops following system" : undefined,
        onSelect: () => {
          // The same switch as Settings › Appearance › Mode: this family's
          // other variant, or ADE's for a single-mode custom theme.
          setThemeFollowsSystem(false);
          const family = themeFamilyForId(themeId) ?? ADE_THEME_FAMILIES[0]!;
          setTheme(family[toLight ? "light" : "dark"].id);
        },
      },
      {
        kind: "item",
        key: "background",
        label: "Change background…",
        icon: ImageSquare,
        onSelect: () => {
          // The new-tab state holds the welcome page in front of every route,
          // so leave it first (as the top bar's Settings button does); with no
          // project open, Settings runs standalone.
          const state = useAppStore.getState();
          if (state.isNewTabOpen) state.cancelNewTab();
          if (!state.project) state.setStandaloneSettingsOpen(true);
          navigateToAppTarget({ kind: "settings", tab: "appearance", anchor: "background" });
        },
      },
    ];
    return pageEntries.length > 0
      ? [...pageEntries, { kind: "separator", key: "background-separator" }, ...background]
      : background;
  }, [followsSystem, pageEntries, setTheme, setThemeFollowsSystem, shuffleOn, theme, themeId]);

  const menu = <ContextMenu menu={state} entries={entries} onClose={() => setState(null)} label="Background" />;
  return { onContextMenu, menu };
}
