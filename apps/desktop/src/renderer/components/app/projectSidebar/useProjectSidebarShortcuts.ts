import { useEffect, useMemo } from "react";
import type { KeybindingsSnapshot } from "../../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../../lib/keybindings";
import { isMacPlatform } from "../../../lib/platform";
import { toggleProjectSidebarHidden } from "./projectSidebarPrefs";
import {
  PROJECT_SIDEBAR_TABS,
  PROJECT_SIDEBAR_TOGGLE_KEYBINDING,
  projectSidebarTabTarget,
  visibleProjectSidebarTabs,
} from "./projectSidebarTabs";

/**
 * True when the keystroke belongs to something that must keep it.
 *
 * Off macOS these are Ctrl chords, and a terminal sends Ctrl chords to the
 * shell (Ctrl+B is readline and the tmux prefix). On macOS the chord is ⌘,
 * which never reaches the pty, so the terminal does not need it. A modal dialog
 * keeps its keys everywhere: switching tabs behind it would be confusing.
 */
function keystrokeIsClaimed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[role="alertdialog"], [role="dialog"][aria-modal="true"]')) return true;
  if (!isMacPlatform() && target.closest(".xterm")) return true;
  return false;
}

/**
 * Window shortcuts for the project sidebar: Mod+1..5 open its tabs and Mod+B
 * shows or hides it. They follow the command palette's rule and work while a
 * text field has focus, but a handler that already used the chord (bold in the
 * PR markdown editor) wins because it calls `preventDefault` first.
 */
export function useProjectSidebarShortcuts(args: {
  enabled: boolean;
  projectRoot: string | null;
  keybindings: KeybindingsSnapshot | null;
  navigate: (path: string) => void;
}): void {
  const { enabled, projectRoot, keybindings, navigate } = args;

  const bindings = useMemo(() => {
    const tabs = visibleProjectSidebarTabs(PROJECT_SIDEBAR_TABS).flatMap((tab) =>
      tab.keybinding
        ? [{ to: tab.to, binding: getEffectiveBinding(keybindings, tab.keybinding.id, tab.keybinding.fallback) }]
        : [],
    );
    const toggle = getEffectiveBinding(
      keybindings,
      PROJECT_SIDEBAR_TOGGLE_KEYBINDING.id,
      PROJECT_SIDEBAR_TOGGLE_KEYBINDING.fallback,
    );
    return { tabs, toggle };
  }, [keybindings]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (keystrokeIsClaimed(event.target)) return;
      if (eventMatchesBinding(event, bindings.toggle)) {
        event.preventDefault();
        if (!event.repeat) toggleProjectSidebarHidden();
        return;
      }
      const tab = bindings.tabs.find((entry) => eventMatchesBinding(event, entry.binding));
      if (!tab) return;
      event.preventDefault();
      if (event.repeat) return;
      navigate(projectSidebarTabTarget(tab.to, projectRoot));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, enabled, navigate, projectRoot]);
}
