import { createContext, useContext } from "react";

/**
 * Where a hand-rolled popover portals to. A modal Radix dialog blocks pointer
 * events and focus outside its content, so a popover opened inside it must
 * portal into the dialog, not into `document.body`.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}
