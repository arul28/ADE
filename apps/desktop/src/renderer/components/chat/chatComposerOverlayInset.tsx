import { createContext, useContext, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";

/**
 * The composer stack that floats over the bottom of the transcript.
 *
 * The thread scrolls behind the composer and its status chips, so the list has
 * to reserve the stack's height at its end. The height changes as the prompt
 * grows a line, so it is published here and written straight onto the few
 * elements that need it. It is deliberately neither React state (each change
 * would re-render the transcript) nor an inherited CSS variable (each change
 * would restyle every transcript node).
 */
export type ValueStore<T> = {
  get(): T;
  set(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
};

function createValueStore<T>(initial: T, normalize: (value: T) => T = (value) => value): ValueStore<T> {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    set(value) {
      const next = normalize(value);
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ChatComposerOverlay = {
  /** Height of the floating stack, in whole pixels. */
  inset: ValueStore<number>;
  /** The floating stack's element, while it floats. */
  footer: ValueStore<HTMLElement | null>;
};

export function createChatComposerOverlay(): ChatComposerOverlay {
  return {
    inset: createValueStore(0, (px) => Math.max(0, Math.ceil(px))),
    footer: createValueStore<HTMLElement | null>(null),
  };
}

export const ChatComposerOverlayContext = createContext<ChatComposerOverlay | null>(null);

/** Marks the composer's chip row. Hidden by CSS while it holds no chip. */
export const CHAT_COMPOSER_CHIP_ROW_ATTR = "data-chat-composer-chip-row";
/** Marks the end of the chip row where Jump to Latest docks. */
export const CHAT_COMPOSER_JUMP_SLOT_ATTR = "data-chat-composer-jump-slot";

/**
 * Calls `apply` with the current inset now (before paint) and on every change.
 * `apply` may change identity between renders; only the latest one runs.
 */
export function useChatComposerOverlayInset(apply: (px: number) => void): void {
  const overlay = useContext(ChatComposerOverlayContext);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useLayoutEffect(() => {
    if (!overlay) return;
    applyRef.current(overlay.inset.get());
    return overlay.inset.subscribe((px) => applyRef.current(px));
  }, [overlay]);
}

/**
 * Where Jump to Latest docks: the end of the chip row above the prompt, while
 * that row shows a chip. Null means the pill keeps its default floating spot.
 *
 * A chip appearing or leaving changes the stack's height, so re-reading on
 * every inset change keeps this current. "Has a chip" is the same selector
 * the row's CSS uses to hide itself, matched without forcing a layout.
 */
export function useChatComposerJumpSlot(): HTMLElement | null {
  const overlay = useContext(ChatComposerOverlayContext);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!overlay) {
      setSlot(null);
      return;
    }
    const read = () => {
      const footer = overlay.footer.get();
      const row = footer?.querySelector<HTMLElement>(`[${CHAT_COMPOSER_CHIP_ROW_ATTR}]`) ?? null;
      const occupied = row !== null && row.matches(":has([data-status-strip] > *)");
      setSlot(occupied ? row.querySelector<HTMLElement>(`[${CHAT_COMPOSER_JUMP_SLOT_ATTR}]`) : null);
    };
    read();
    const offInset = overlay.inset.subscribe(read);
    const offFooter = overlay.footer.subscribe(read);
    return () => {
      offInset();
      offFooter();
    };
  }, [overlay]);
  return slot;
}

/**
 * A layer that stays clear of the floating composer: `edge` (its `bottom`, or
 * its `paddingBottom`) is `basePx` plus the composer stack's height.
 */
export function ChatComposerOverlayClear({
  basePx,
  edge = "bottom",
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { basePx: number; edge?: "bottom" | "paddingBottom" }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useChatComposerOverlayInset((px) => {
    if (ref.current) ref.current.style[edge] = `${basePx + px}px`;
  });
  return <div ref={ref} style={{ ...style, [edge]: basePx }} {...rest} />;
}
