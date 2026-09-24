import React from "react";
import { createPortal } from "react-dom";

/**
 * The PRs page has one list column. It sits in the project sidebar when there
 * is one, and in a plain left column otherwise. The page owns an empty element
 * in that column and each surface (GitHub, Workflows, a workflow sub-tab)
 * renders its list part into it with `PrsListPortal`. A surface can nest its
 * own host below its controls, so a sub-tab's list lands under them.
 *
 * The context value means:
 * - `undefined`: no host above. The surface was rendered on its own (tests)
 *   and keeps its own inline list column.
 * - `null`: the host element has not mounted yet. Render nothing for a frame.
 */
const PrsListHostContext = React.createContext<HTMLElement | null | undefined>(undefined);

export function PrsListHostProvider({
  host,
  children,
}: {
  host: HTMLElement | null;
  children: React.ReactNode;
}) {
  return <PrsListHostContext.Provider value={host}>{children}</PrsListHostContext.Provider>;
}

export function usePrsListHost(): HTMLElement | null | undefined {
  return React.useContext(PrsListHostContext);
}

export function PrsListPortal({ children }: { children: React.ReactNode }) {
  const host = usePrsListHost();
  if (!host) return null;
  return createPortal(children, host);
}

/** Root class for anything portaled into a list host: fills it and scrolls inside. */
export const PRS_LIST_ROOT_CLASS = "flex min-h-0 flex-1 flex-col";

/** One quiet centered line, for empty lists and "nothing selected" detail. */
export function PrsQuietLine({ children, fill = false }: { children: React.ReactNode; fill?: boolean }) {
  return (
    <div
      className={fill ? "flex min-h-0 flex-1 items-center justify-center" : "px-4 py-7 text-center"}
      style={{ fontSize: 12, color: "var(--color-muted-fg)", opacity: fill ? 0.7 : 0.85 }}
    >
      {children}
    </div>
  );
}
