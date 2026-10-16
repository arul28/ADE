import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeybindingsSnapshot } from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { caretChordIsClaimed, keyChordIsClaimed } from "../../lib/keyboardClaims";
import { useLatestCallback } from "../../lib/stableIdentity";

/**
 * The Work page's shortcuts: a short list of ⌘-chords, one per action, each
 * declared in `shared/keybindings.ts` so a rebind reaches every surface that
 * reads the same id.
 *
 * | Keys | Does |
 * |---|---|
 * | `⌘↑` / `⌘↓` | previous / next chat in the visible list |
 * | `⌘I` | jump into the prompt box — press it again to leave |
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
 *
 * **The page moves by acting on the control, not by re-running its action.**
 * Moving the selection clicks the row element, because the row's own activation
 * carries what a click means here: the range/toggle modifiers, and — for a row
 * whose session lives on another machine — the runtime pin that keeps later
 * commands on that machine. A key path that called the selection callback with
 * a bare id would silently lose both.
 */

export type WorkShortcutArgs = {
  /** False when the Work route is not the front route (the page stays mounted). */
  active: boolean;
  keybindings: KeybindingsSnapshot | null;
  selectedSessionId: string | null;
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

type WorkBindings = {
  nextChat: string;
  prevChat: string;
  focusComposer: string;
  chatActions: string;
  newChat: string;
  toggleTools: string;
  back: string;
};

type BindingSpec = { id: string; fallback: string };

function resolve(snapshot: KeybindingsSnapshot | null, spec: BindingSpec): string {
  return getEffectiveBinding(snapshot, spec.id, spec.fallback);
}

function readWorkBindings(snapshot: KeybindingsSnapshot | null): WorkBindings {
  return {
    nextChat: resolve(snapshot, WORK_SHORTCUT_FALLBACKS.nextChat),
    prevChat: resolve(snapshot, WORK_SHORTCUT_FALLBACKS.prevChat),
    focusComposer: resolve(snapshot, WORK_SHORTCUT_FALLBACKS.focusComposer),
    chatActions: resolve(snapshot, WORK_SHORTCUT_FALLBACKS.chatActions),
    newChat: resolve(snapshot, WORK_SHORTCUT_FALLBACKS.newChat),
    toggleTools: resolve(snapshot, WORK_SHORTCUT_FALLBACKS.toggleTools),
    back: resolve(snapshot, WORK_TOOLS_BACK_BINDING),
  };
}

/** Visible list rows, in the order the page shows them. */
function visibleWorkSessionRows(root: ParentNode = document): HTMLElement[] {
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-session-row][data-session-id]"));
  return rows.filter((row) => row.getClientRects().length > 0);
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

/**
 * Move the highlight through the session list by pressing the row.
 *
 * `[data-session-row]` is the drag wrapper; the control that selects is the
 * row face inside it (`[data-session-row-action]`). Pressing the face is what
 * carries the click's range/toggle modifiers and, for a session whose machine
 * is not this tab's, the runtime pin that keeps later commands on the owning
 * machine. Scrolling first keeps the next row on screen.
 */
function pressSessionRow(row: HTMLElement): void {
  const face = row.querySelector<HTMLElement>("[data-session-row-action]");
  if (!face) return;
  row.scrollIntoView({ block: "nearest" });
  face.click();
}

export function useWorkShortcuts(args: WorkShortcutArgs): WorkShortcuts {
  const [keysOpen, setKeysOpen] = useState(false);
  // Read inside the key handler, which must not wait for a render.
  const keysOpenRef = useRef(false);
  keysOpenRef.current = keysOpen;

  const selectedSessionId = useLatestCallback(() => args.selectedSessionId);
  const onNewChat = useLatestCallback(args.onNewChat);
  const onToggleTools = useLatestCallback(args.onToggleTools);
  const onCloseTools = useLatestCallback(args.onCloseTools);
  const toolsOpen = useLatestCallback(args.toolsOpen);
  const keybindings = useLatestCallback(() => args.keybindings);

  const moveSession = useCallback((direction: 1 | -1) => {
    const rows = visibleWorkSessionRows();
    if (rows.length === 0) return;
    const currentId = selectedSessionId();
    const currentIndex = rows.findIndex((row) => row.getAttribute("data-session-id") === currentId);
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, currentIndex + direction));
    const nextRow = rows[nextIndex];
    if (nextRow) pressSessionRow(nextRow);
  }, [selectedSessionId]);

  const openChatActions = useLatestCallback(() => {
    // The drawer's state lives inside `AgentChatPane`; this event is its own
    // documented entry point (transcript affordances open it the same way).
    const sessionId = selectedSessionId();
    window.dispatchEvent(new CustomEvent("ade:chat:open-info", {
      detail: sessionId ? { sessionId } : {},
    }));
  });

  const toggleToolsPane = useLatestCallback(() => {
    const wasOpen = toolsOpen();
    if (wasOpen) onCloseTools();
    else onToggleTools();
    if (!wasOpen) focusWorkToolsPaneSoon();
  });

  const backOut = useLatestCallback(() => {
    if (toolsOpen()) onCloseTools();
  });

  // The bindings are read at press time, not captured at mount, so a rebind
  // takes effect without a reload.
  const bindings = useRef<WorkBindings>(readWorkBindings(null));
  bindings.current = readWorkBindings(keybindings());

  useEffect(() => {
    if (!args.active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const keys = bindings.current;
      const caretFree = !caretChordIsClaimed(event.target);

      // `?` toggles: it opens the sheet, and — decided before the modal rule
      // below, or the open sheet would own the very key that closes it — it
      // closes the sheet again. Every other modal keeps its keys, because only
      // our own sheet answers to `?`.
      if (event.key === "?" && !event.repeat && caretFree && keysOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setKeysOpen(false);
        return;
      }
      if (keyChordIsClaimed(event.target)) return;

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
        const leaving = promptBoxHasCaret();
        finishCurrentEdit();
        if (!leaving) focusWorkInputSoon();
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
        if (!toolsOpen()) return;
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
    toolsOpen,
  ]);

  // The page stays mounted off-route; leave nothing open behind the route change.
  useEffect(() => {
    if (args.active) return;
    setKeysOpen(false);
  }, [args.active]);

  return useMemo(() => ({ keysOpen, setKeysOpen }), [keysOpen]);
}
