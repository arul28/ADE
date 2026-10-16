import { useCallback, useEffect, useRef, useState } from "react";
import type { KeybindingsSnapshot } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { useLatestCallback } from "../../lib/stableIdentity";

/**
 * The Work page's shortcuts: a short list of ⌘-chords, one per action, each
 * declared in `shared/keybindings.ts` so a rebind reaches every surface that
 * reads the same id.
 *
 * Every action is a modifier chord with a mnemonic second key:
 *
 * | Keys | Does |
 * |---|---|
 * | `⌘↑` / `⌘↓` | previous / next chat in the visible list |
 * | `⌘I` | jump into the prompt box |
 * | `⌘⇧A` | the chat's actions and progress drawer |
 * | `⌘⇧N` | new chat |
 * | `⌘T` | open or close the tools pane |
 * | `Esc` | back out (close the tools pane) |
 * | `?` | this list, whenever you are not typing |
 *
 * Nothing here is an unmodified letter, so the composer and every terminal keep
 * their keys. A chord fires while a text field has focus — that is what makes
 * it fast — with one exception: `⌘↑`/`⌘↓` are caret movement inside a text
 * field or a terminal, so they are skipped there and work everywhere else.
 */

export type WorkShortcutArgs = {
  /** False when the Work route is not the front route (the page stays mounted). */
  active: boolean;
  keybindings: KeybindingsSnapshot | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  /** Open the tools pane when it is closed, close it when it is open. */
  onToggleTools: () => void;
  onCloseTools: () => void;
  /** Read at press time; the DOM is not the source of truth for "is the pane open". */
  toolsOpen: () => boolean;
};

export type WorkShortcuts = {
  /** The `?` sheet, rendered by the page. */
  keysOpen: boolean;
  setKeysOpen: (open: boolean) => void;
};

/** The shortcut ids this page reads, with the fallback the registry ships. */
export const WORK_SHORTCUT_FALLBACKS = {
  nextChat: { id: "work.chat.next", fallback: "Mod+ArrowDown" },
  prevChat: { id: "work.chat.prev", fallback: "Mod+ArrowUp" },
  focusComposer: { id: "work.chat.focusComposer", fallback: "Mod+I" },
  chatActions: { id: "work.chat.actions", fallback: "Mod+Shift+A" },
  newChat: { id: "work.chat.new", fallback: "Mod+Shift+N" },
  toggleTools: { id: "work.tools.toggle", fallback: "Mod+T" },
} as const;

/** The pane's own Escape binding (declared with the rest of the Work scope). */
export const WORK_TOOLS_BACK_BINDING = { id: "work.tools.picker", fallback: "Escape" };

/** A modal, menu or listbox answers its own keys. */
export function workChordIsClaimed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[role="alertdialog"], [role="dialog"][aria-modal="true"]')) return true;
  if (target.closest('[role="menu"], [role="listbox"]')) return true;
  return false;
}

/** A text field or a terminal's input keeps the caret-movement chords. */
export function caretChordIsClaimed(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm")) return true;
  return target.closest(
    "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']",
  ) != null;
}

/** Visible list rows, in the order the page shows them. */
export function visibleWorkSessionRowIds(root: ParentNode = document): string[] {
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-session-row][data-session-id]"));
  const ids: string[] = [];
  for (const row of rows) {
    if (row.getClientRects().length === 0) continue;
    const id = row.getAttribute("data-session-id");
    if (id) ids.push(id);
  }
  return ids;
}

function findVisibleElement(selector: string): HTMLElement | null {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

/**
 * Put the caret back where a person types: the chat's prompt box, or the
 * terminal's own input for a CLI session.
 *
 * Retried across frames because the target often mounts in response to the same
 * keystroke (`⌘⇧N` opens a draft, a session switch swaps the pane).
 */
export function focusWorkInputSoon(attempts = 30): void {
  let remaining = attempts;
  const tick = () => {
    const target = findVisibleElement("[data-chat-composer-text]")
      ?? findVisibleElement(".xterm textarea");
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
    remaining -= 1;
    if (remaining > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Put the keyboard inside the tools pane once it is on screen. */
export function focusWorkToolsPaneSoon(attempts = 30): void {
  let remaining = attempts;
  const tick = () => {
    const pane = document.querySelector<HTMLElement>("[data-work-tools-pane]");
    if (pane) {
      pane.focus({ preventScroll: true });
      return;
    }
    remaining -= 1;
    if (remaining > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Move the highlight through the session list and keep it on screen. */
function scrollRowIntoView(sessionId: string): void {
  document
    .querySelector<HTMLElement>(`[data-session-row][data-session-id="${CSS.escape(sessionId)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

/**
 * A chord that leaves a text field commits what is there first.
 *
 * Blur is enough for every control ADE uses — the composer keeps its draft on
 * blur — and it keeps the caret from being pulled out mid-word.
 */
function finishCurrentEdit(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

/**
 * True when the caret is already in the thing `⌘I` would focus: the chat's
 * prompt box, or a terminal's own input. `⌘I` then means "leave", so the chord
 * toggles the same way `⌘T` and `?` do.
 */
export function promptBoxHasCaret(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active.matches("[data-chat-composer-text], .xterm textarea");
}

export function useWorkShortcuts(args: WorkShortcutArgs): WorkShortcuts {
  const [keysOpen, setKeysOpen] = useState(false);
  // Read inside the key handler, which must not wait for a render.
  const keysOpenRef = useRef(false);
  keysOpenRef.current = keysOpen;
  const selectedSessionId = useLatestCallback(() => args.selectedSessionId);
  const onSelectSession = useLatestCallback(args.onSelectSession);
  const onNewChat = useLatestCallback(args.onNewChat);
  const onToggleTools = useLatestCallback(args.onToggleTools);
  const onCloseTools = useLatestCallback(args.onCloseTools);
  const keybindings = useLatestCallback(() => args.keybindings);
  const activeSessionId = useLatestCallback(() => args.selectedSessionId);

  const moveSession = useCallback((direction: 1 | -1) => {
    const ids = visibleWorkSessionRowIds();
    if (ids.length === 0) return;
    const currentId = selectedSessionId();
    const currentIndex = currentId ? ids.indexOf(currentId) : -1;
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : ids.length - 1)
      : Math.min(ids.length - 1, Math.max(0, currentIndex + direction));
    const nextId = ids[nextIndex];
    if (!nextId) return;
    if (nextId !== currentId) onSelectSession(nextId);
    scrollRowIntoView(nextId);
  }, [onSelectSession, selectedSessionId]);

  const openChatActions = useLatestCallback(() => {
    // The drawer's state lives inside `AgentChatPane`; this event is its own
    // documented entry point (transcript affordances open it the same way).
    const sessionId = activeSessionId();
    window.dispatchEvent(new CustomEvent("ade:chat:open-info", {
      detail: sessionId ? { sessionId } : {},
    }));
  });

  const toggleToolsPane = useLatestCallback(() => {
    const wasOpen = args.toolsOpen();
    if (wasOpen) onCloseTools();
    else onToggleTools();
    if (!wasOpen) focusWorkToolsPaneSoon();
  });

  const backOut = useLatestCallback(() => {
    if (args.toolsOpen()) onCloseTools();
  });

  // The bindings are read at press time, not captured at mount, so a rebind
  // takes effect without a reload.
  const bindings = useRef<Record<string, string>>({});
  bindings.current = {
    nextChat: getEffectiveBinding(keybindings(), WORK_SHORTCUT_FALLBACKS.nextChat.id, WORK_SHORTCUT_FALLBACKS.nextChat.fallback),
    prevChat: getEffectiveBinding(keybindings(), WORK_SHORTCUT_FALLBACKS.prevChat.id, WORK_SHORTCUT_FALLBACKS.prevChat.fallback),
    focusComposer: getEffectiveBinding(keybindings(), WORK_SHORTCUT_FALLBACKS.focusComposer.id, WORK_SHORTCUT_FALLBACKS.focusComposer.fallback),
    chatActions: getEffectiveBinding(keybindings(), WORK_SHORTCUT_FALLBACKS.chatActions.id, WORK_SHORTCUT_FALLBACKS.chatActions.fallback),
    newChat: getEffectiveBinding(keybindings(), WORK_SHORTCUT_FALLBACKS.newChat.id, WORK_SHORTCUT_FALLBACKS.newChat.fallback),
    toggleTools: getEffectiveBinding(keybindings(), WORK_SHORTCUT_FALLBACKS.toggleTools.id, WORK_SHORTCUT_FALLBACKS.toggleTools.fallback),
    back: getEffectiveBinding(keybindings(), WORK_TOOLS_BACK_BINDING.id, WORK_TOOLS_BACK_BINDING.fallback),
  };

  useEffect(() => {
    if (!args.active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const keys = bindings.current;
      const caretFree = !caretChordIsClaimed(event.target);

      // `?` toggles: it opens the sheet, and — this has to be decided before
      // the modal rule below, or the open sheet would own the very key that
      // closes it — it closes the sheet again. Any other modal keeps its keys,
      // because only our own sheet answers to `?`.
      if (event.key === "?" && !event.repeat && caretFree) {
        if (keysOpenRef.current) {
          event.preventDefault();
          event.stopPropagation();
          setKeysOpen(false);
          return;
        }
      }
      if (workChordIsClaimed(event.target)) return;

      if (eventMatchesBinding(event, keys.nextChat)) {
        if (!caretFree) return;
        event.preventDefault();
        event.stopPropagation();
        moveSession(1);
        return;
      }
      if (eventMatchesBinding(event, keys.prevChat)) {
        if (!caretFree) return;
        event.preventDefault();
        event.stopPropagation();
        moveSession(-1);
        return;
      }
      if (eventMatchesBinding(event, keys.focusComposer)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        // The chord toggles: the caret is already there → leave the box (the
        // page gets the keyboard back); otherwise go to it.
        if (promptBoxHasCaret()) {
          finishCurrentEdit();
          return;
        }
        finishCurrentEdit();
        focusWorkInputSoon();
        return;
      }
      if (eventMatchesBinding(event, keys.chatActions)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        openChatActions();
        return;
      }
      if (eventMatchesBinding(event, keys.newChat)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        onNewChat();
        focusWorkInputSoon();
        return;
      }
      if (eventMatchesBinding(event, keys.toggleTools)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        toggleToolsPane();
        return;
      }
      // `?` is a character first: a typable field or a terminal keeps it, which
      // is why this one asks about focus before anything else.
      if (event.key === "?") {
        if (!caretFree || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        setKeysOpen(true);
        return;
      }
      // The pane's own Escape handler answers first when focus is inside it;
      // reaching this point means focus was elsewhere, so this is "back out".
      if (eventMatchesBinding(event, keys.back)) {
        if (!args.toolsOpen()) return;
        event.preventDefault();
        event.stopPropagation();
        backOut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    args.active,
    backOut,
    moveSession,
    onNewChat,
    openChatActions,
    toggleToolsPane,
  ]);

  // The page stays mounted off-route; leave nothing open behind the route change.
  useEffect(() => {
    if (args.active) return;
    setKeysOpen(false);
  }, [args.active]);

  return { keysOpen, setKeysOpen };
}
