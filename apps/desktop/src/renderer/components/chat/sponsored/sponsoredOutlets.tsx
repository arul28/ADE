import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

/**
 * Where a chat pane can show its sponsored card besides under the reply
 * (`CloudSponsoredFormat`): the dock above the prompt box, and the end of
 * each finished turn's last reply. Each place registers an empty element
 * here; `SponsoredReplySlot`, the one part that asks for a card, draws into
 * the one its format names. One store per pane.
 */
export type SponsoredOutlets = {
  dock: () => HTMLElement | null;
  inline: (turnId: string) => HTMLElement | null;
  setDock: (element: HTMLElement | null) => void;
  setInline: (turnId: string, element: HTMLElement | null) => void;
  subscribe: (listener: () => void) => () => void;
};

function createSponsoredOutlets(): SponsoredOutlets {
  let dock: HTMLElement | null = null;
  const inline = new Map<string, HTMLElement>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    dock: () => dock,
    inline: (turnId) => inline.get(turnId) ?? null,
    setDock: (element) => {
      if (dock === element) return;
      dock = element;
      changed();
    },
    setInline: (turnId, element) => {
      if (element) {
        if (inline.get(turnId) === element) return;
        inline.set(turnId, element);
      } else if (!inline.delete(turnId)) return;
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const SponsoredOutletsContext = createContext<SponsoredOutlets | null>(null);

/** The pane's store, made once. */
export function useNewSponsoredOutlets(): SponsoredOutlets {
  const [outlets] = useState(createSponsoredOutlets);
  return outlets;
}

const noOutlet = () => () => undefined;

/** The element a card of this format draws into, or null while that place isn't on the page. */
export function useSponsoredOutlet(outlets: SponsoredOutlets | null, place: "dock" | "inline" | null, turnId: string | null): HTMLElement | null {
  const read = () => {
    if (!outlets || !place) return null;
    if (place === "dock") return outlets.dock();
    return turnId ? outlets.inline(turnId) : null;
  };
  return useSyncExternalStore(outlets?.subscribe ?? noOutlet, read, read);
}

/**
 * The end of a finished turn's last reply: an inline card's sentence goes
 * here. A block with no height while empty, so the slot can tell when it is
 * on screen.
 */
export function SponsoredInlineOutlet({ turnId }: { turnId: string }) {
  const outlets = useContext(SponsoredOutletsContext);
  const ref = useCallback((element: HTMLDivElement | null) => outlets?.setInline(turnId, element), [outlets, turnId]);
  if (!outlets) return null;
  return <div ref={ref} />;
}

/** Above the prompt box: the docked card goes here. Takes no room while empty. */
export function SponsoredDockOutlet({ outlets, style }: { outlets: SponsoredOutlets; style?: React.CSSProperties }) {
  const ref = useCallback((element: HTMLDivElement | null) => outlets.setDock(element), [outlets]);
  return <div ref={ref} className="empty:hidden" style={style} />;
}
