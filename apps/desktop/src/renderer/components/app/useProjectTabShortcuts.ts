import { useEffect, useMemo } from "react";
import type { KeybindingsSnapshot } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { keyChordIsClaimed } from "../../lib/keyboardClaims";
import { isImeComposing } from "../../lib/imeComposition";

/**
 * `⌃⇥` / `⇧⌃⇥`: the next or previous project tab, from any page.
 *
 * Projects open as tabs across the top of the window, so the keys that switch
 * them are the ones people already use for tabs. Like the sidebar's ⌘1–5 this
 * works while a text field has focus (a chord is never typing), but a dialog or
 * a menu keeps its own keys.
 *
 * The switch itself is a **press on the real tab element**, not a re-run of the
 * switch action. That is what makes the shortcut behave exactly like a click —
 * the busy guard, leaving a machine route, the local-vs-remote dispatch and the
 * error handling all live on the tab — and it is also how the cycle follows what
 * is on screen (`aria-current` marks the active tab, the DOM order is the visual
 * order, and a remote tab is in the same strip as a local one).
 */

const NEXT_PROJECT_BINDING = { id: "project.tab.next", fallback: "Ctrl+Tab" };
const PREV_PROJECT_BINDING = { id: "project.tab.prev", fallback: "Ctrl+Shift+Tab" };

/** The project tabs on screen, in the order the top bar shows them. */
function visibleProjectTabs(root: ParentNode = document): HTMLElement[] {
  const tabs = Array.from(root.querySelectorAll<HTMLElement>("[data-project-tab-key]"));
  return tabs.filter((tab) => tab.getClientRects().length > 0);
}

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
      if (event.defaultPrevented || isImeComposing(event) || event.repeat) return;
      if (keyChordIsClaimed(event.target)) return;
      const direction = eventMatchesBinding(event, bindings.next)
        ? 1
        : eventMatchesBinding(event, bindings.prev)
          ? -1
          : 0;
      if (direction === 0) return;
      event.preventDefault();
      event.stopPropagation();

      const tabs = visibleProjectTabs();
      if (tabs.length < 2) {
        // Nothing to switch to. The key is the "projects" key either way, so it
        // opens the picker that adds a second one instead of doing nothing.
        onOpenProjectPicker();
        return;
      }
      const activeIndex = tabs.findIndex((tab) => tab.getAttribute("aria-current") === "true");
      const nextIndex = activeIndex < 0
        ? (direction > 0 ? 0 : tabs.length - 1)
        : (activeIndex + direction + tabs.length) % tabs.length;
      tabs[nextIndex]?.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, enabled, onOpenProjectPicker]);
}
