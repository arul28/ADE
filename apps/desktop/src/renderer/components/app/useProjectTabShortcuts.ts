import { useEffect, useMemo } from "react";
import type { KeybindingsSnapshot } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { useAppStore } from "../../state/appStore";

/**
 * `⌃Tab` / `⇧⌃Tab`: the next or previous project tab, from any page.
 *
 * Projects open as tabs across the top of the window, so the keys that switch
 * them are the ones people already use for tabs. Like the sidebar's ⌘1–5, this
 * works while a text field has focus (a chord is never typing), but a dialog or
 * a menu keeps its own keys.
 *
 * The switch itself goes through the same store action a click on a tab uses,
 * so the worktree gate, the tab order and the saved route behave identically.
 */

const NEXT_PROJECT_BINDING = { id: "project.tab.next", fallback: "Ctrl+Tab" };
const PREV_PROJECT_BINDING = { id: "project.tab.prev", fallback: "Ctrl+Shift+Tab" };

export function useProjectTabShortcuts(args: {
  enabled: boolean;
  keybindings: KeybindingsSnapshot | null;
  /** With a single project there is nothing to cycle — open the picker instead. */
  onOpenProjectPicker: () => void;
}): void {
  const { enabled, keybindings, onOpenProjectPicker } = args;

  const bindings = useMemo(() => ({
    next: getEffectiveBinding(keybindings, NEXT_PROJECT_BINDING.id, NEXT_PROJECT_BINDING.fallback),
    prev: getEffectiveBinding(keybindings, PREV_PROJECT_BINDING.id, PREV_PROJECT_BINDING.fallback),
  }), [keybindings]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target;
      if (target instanceof Element
        && target.closest('[role="alertdialog"], [role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]')) {
        return;
      }
      const direction = eventMatchesBinding(event, bindings.next)
        ? 1
        : eventMatchesBinding(event, bindings.prev)
          ? -1
          : 0;
      if (direction === 0) return;
      event.preventDefault();
      event.stopPropagation();

      const state = useAppStore.getState();
      const roots = state.openProjectTabRoots;
      const currentRoot = state.project?.rootPath ?? null;
      const currentIndex = currentRoot ? roots.indexOf(currentRoot) : -1;
      if (roots.length < 2 || currentIndex < 0) {
        // Nothing to switch to. The key is the "projects" key either way, so
        // it opens the picker that adds a second one instead of doing nothing.
        onOpenProjectPicker();
        return;
      }
      const nextRoot = roots[(currentIndex + direction + roots.length) % roots.length];
      if (!nextRoot || nextRoot === currentRoot) return;
      void state.switchProjectToPath(nextRoot);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, enabled, onOpenProjectPicker]);
}
