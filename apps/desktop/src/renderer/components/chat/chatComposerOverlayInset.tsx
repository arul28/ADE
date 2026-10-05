import { createContext, useContext, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";

/**
 * Height of the composer stack that floats over the bottom of the transcript.
 *
 * The thread scrolls behind the composer and its status chips, so the list has
 * to reserve that height at its end. The height changes as the prompt grows a
 * line, so it is published here and written straight onto the few elements
 * that need it. It is deliberately neither React state (each change would
 * re-render the transcript) nor an inherited CSS variable (each change would
 * restyle every transcript node).
 */
export type ChatComposerOverlayInset = {
  get(): number;
  set(px: number): void;
  subscribe(listener: (px: number) => void): () => void;
  /**
   * Where Jump to Latest docks: the right end of the chip row above the prompt,
   * but only while that row holds a chip. Null means the pill keeps its
   * default spot over the transcript.
   */
  jumpSlot: ChatComposerJumpSlot;
};

export type ChatComposerJumpSlot = {
  get(): HTMLElement | null;
  set(el: HTMLElement | null): void;
  subscribe(listener: (el: HTMLElement | null) => void): () => void;
};

function createValueStore<T>(initial: T, normalize: (value: T) => T = (value) => value) {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    set(value: T) {
      const next = normalize(value);
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createChatComposerOverlayInset(): ChatComposerOverlayInset {
  return {
    ...createValueStore(0, (px) => Math.max(0, Math.ceil(px))),
    jumpSlot: createValueStore<HTMLElement | null>(null),
  };
}

/** Marks the composer's chip row; its direct children other than the slot are chips. */
export const CHAT_COMPOSER_CHIP_ROW_ATTR = "data-chat-composer-chip-row";
/** Marks the element in the chip row that hosts a docked Jump to Latest pill. */
export const CHAT_COMPOSER_JUMP_SLOT_ATTR = "data-chat-composer-jump-slot";

/**
 * The jump slot under `root`, when the chip row next to it shows at least one
 * chip. Chips render null when they have nothing to say, so a mounted row can
 * still be empty.
 */
export function findOccupiedComposerJumpSlot(root: HTMLElement): HTMLElement | null {
  const slot = root.querySelector<HTMLElement>(`[${CHAT_COMPOSER_JUMP_SLOT_ATTR}]`);
  const row = root.querySelector<HTMLElement>(`[${CHAT_COMPOSER_CHIP_ROW_ATTR}]`);
  if (!slot || !row) return null;
  return row.querySelector(`:scope [data-testid="chat-composer-status-strip"] > *`) ? slot : null;
}

/** The current docking slot for Jump to Latest, as React state (it changes rarely). */
export function useChatComposerJumpSlot(): HTMLElement | null {
  const inset = useContext(ChatComposerOverlayInsetContext);
  const [slot, setSlot] = useState<HTMLElement | null>(() => inset?.jumpSlot.get() ?? null);
  useLayoutEffect(() => {
    if (!inset) {
      setSlot(null);
      return;
    }
    setSlot(inset.jumpSlot.get());
    return inset.jumpSlot.subscribe(setSlot);
  }, [inset]);
  return slot;
}

export const ChatComposerOverlayInsetContext = createContext<ChatComposerOverlayInset | null>(null);

/**
 * Calls `apply` with the current inset now (before paint) and on every change.
 * `apply` may change identity between renders; only the latest one runs.
 */
export function useChatComposerOverlayInset(apply: (px: number) => void): void {
  const inset = useContext(ChatComposerOverlayInsetContext);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useLayoutEffect(() => {
    if (!inset) return;
    applyRef.current(inset.get());
    return inset.subscribe((px) => applyRef.current(px));
  }, [inset]);
}

/**
 * An absolutely positioned layer that sits `baseBottomPx` above the floating
 * composer instead of underneath it.
 */
export function ChatComposerOverlayClear({
  baseBottomPx,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { baseBottomPx: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useChatComposerOverlayInset((px) => {
    if (ref.current) ref.current.style.bottom = `${baseBottomPx + px}px`;
  });
  return <div ref={ref} style={{ ...style, bottom: baseBottomPx }} {...rest} />;
}
