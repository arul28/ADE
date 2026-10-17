/**
 * The command palette's side of chat find: the "Find "…" in this chat" row
 * and the hand-off of the palette's words to a chat opened from a palette hit.
 *
 * The palette owns the words (its parsed free-text terms); the chat owns the
 * find bar. This hook is everything the palette needs to offer one and hand
 * the other over. The target registry and pending store live in
 * `chatFindTargets.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { modifierChordLabel } from "../../lib/platform";
import { preferredChatFindTarget, setPendingChatFind } from "./chatFindTargets";

/** The group heading the find row renders under, and the group its command carries. */
export const CHAT_FIND_PALETTE_GROUP = "This chat";

/**
 * The find row's command. Structurally a palette `Command`: the palette runs it
 * like any other row.
 */
type ChatFindPaletteCommand = {
  id: "chat-find";
  title: string;
  hint: string;
  shortcut: string;
  group: typeof CHAT_FIND_PALETTE_GROUP;
  run: () => void;
};

/**
 * `words` is what find would search for: the palette's free-text terms joined.
 * The find row exists only in the palette's default mode, and only with words
 * typed and a chat on screen.
 */
export function useChatFindPaletteCommand({
  open,
  inDefaultMode,
  words,
}: {
  open: boolean;
  /** The palette shows its default list (not the project browser). */
  inDefaultMode: boolean;
  words: string;
}): {
  command: ChatFindPaletteCommand | null;
  /** Radix would hand focus back to where it was; a find bar opened from the palette keeps it. */
  keepFocusOnCloseRef: MutableRefObject<boolean>;
  handOffChatFind: (sessionId: string) => void;
} {
  // Offered while a chat is on screen. Read when the palette opens — once it
  // has focus, "the chat you were in" is history.
  const [chatFindAvailable, setChatFindAvailable] = useState(false);
  useEffect(() => {
    if (open) setChatFindAvailable(preferredChatFindTarget() != null);
  }, [open]);

  const keepFocusOnCloseRef = useRef(false);

  const command = useMemo<ChatFindPaletteCommand | null>(() => {
    if (!chatFindAvailable || !inDefaultMode || !words) return null;
    return {
      id: "chat-find",
      title: `Find “${words}” in this chat`,
      hint: "Highlights every match; ↵ and ⇧↵ step through them",
      shortcut: modifierChordLabel("F"),
      group: CHAT_FIND_PALETTE_GROUP,
      run: () => {
        const target = preferredChatFindTarget();
        if (!target) return;
        keepFocusOnCloseRef.current = true;
        target.open(words);
      },
    };
  }, [chatFindAvailable, inDefaultMode, words]);

  /**
   * Leave the palette's words for a chat opened from a message hit, so it
   * opens with its find bar holding them and ↵ walks every match there. The
   * bar shows the count without moving the view.
   */
  const handOffChatFind = useCallback(
    (sessionId: string) => {
      if (!words) return;
      keepFocusOnCloseRef.current = true;
      setPendingChatFind(sessionId, words);
    },
    [words],
  );

  return { command, keepFocusOnCloseRef, handOffChatFind };
}
