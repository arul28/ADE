import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";

/**
 * A list that shows exactly the rows that fit its card and never scrolls.
 *
 * Every row is rendered (up to a cap) in a box that clips; after layout, rows
 * that do not end inside the box are made invisible (they keep their place,
 * so hiding them moves nothing), a heading with no visible row under it goes
 * too, and a "N more" link takes the last line. The link opens the full view:
 * a page of the app (`onMore`), or the whole list in a dialog (`dialog`).
 *
 * Rows are the list element's direct children. Mark headings (a day, a
 * "Merged this week" divider) with `data-fit-head`; they are not counted.
 * Measuring is one read pass when the box resizes or the rows change.
 *
 * A long list can pass only its first rows and the number it left out
 * (`unrendered`): hidden rows still cost style and layout on every pass over
 * the page, so a caller with far more rows than any card can show renders a
 * cap. "N more" counts the left-out rows too, and the dialog shows them all.
 */

const MORE_LINE = 26;

export type FitListMore =
  | { onMore: () => void }
  /** `close` shuts the dialog: call it when a row opens something else (a viewer, a page). */
  | { dialog: { title: string; render: (close: () => void) => ReactNode } };

export function FitList({
  children,
  more,
  className,
  listClassName,
  ariaLabel,
  role = "list",
  unrendered = 0,
}: {
  children: ReactNode;
  more?: FitListMore | null;
  /** Rows the caller left out of `children`; "N more" counts them. */
  unrendered?: number;
  className?: string;
  listClassName?: string;
  ariaLabel?: string;
  role?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(0);
  const [open, setOpen] = useState(false);
  // Room for the "N more" line only when there is somewhere for it to go.
  const reserveRef = useRef(0);
  reserveRef.current = more ? MORE_LINE : 0;
  const unrenderedRef = useRef(0);
  unrenderedRef.current = unrendered;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const list = listRef.current;
    if (!box || !list) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rows = Array.from(list.children) as HTMLElement[];
      for (const row of rows) {
        row.style.visibility = "";
        row.removeAttribute("aria-hidden");
      }
      const height = box.clientHeight;
      const top = box.getBoundingClientRect().top;
      const bottoms = rows.map((row) => row.getBoundingClientRect().bottom - top);
      // Left-out rows always need the "N more" line.
      const allFit = unrenderedRef.current === 0 && bottoms.every((bottom) => bottom <= height + 0.5);
      let shown = rows.length;
      if (!allFit) {
        const limit = height - reserveRef.current;
        shown = 0;
        while (shown < rows.length && bottoms[shown]! <= limit + 0.5) shown += 1;
        // A heading with nothing visible under it goes with its rows.
        while (shown > 0 && rows[shown - 1]!.hasAttribute("data-fit-head")) shown -= 1;
      }
      let count = 0;
      rows.forEach((row, index) => {
        if (index < shown) return;
        row.style.visibility = "hidden";
        row.setAttribute("aria-hidden", "true");
        if (!row.hasAttribute("data-fit-head")) count += 1;
      });
      setHidden(count);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const resize = new ResizeObserver(schedule);
    resize.observe(box);
    const mutation = new MutationObserver(schedule);
    mutation.observe(list, { childList: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  return (
    <div ref={boxRef} className={`ade-fit${className ? ` ${className}` : ""}`}>
      <div ref={listRef} className={listClassName} role={role} aria-label={ariaLabel}>
        {children}
      </div>
      {hidden + unrendered > 0 && more ? (
        <button
          type="button"
          className="ade-fit-more"
          onClick={() => ("onMore" in more ? more.onMore() : setOpen(true))}
        >
          {hidden + unrendered} more
          <ArrowRight size={11} weight="bold" aria-hidden />
        </button>
      ) : null}
      {open && more && "dialog" in more ? (
        <Dialog open onOpenChange={setOpen} title={more.dialog.title} width={560} maxHeight="78vh">
          <div className="ade-fit-dialog">{more.dialog.render(() => setOpen(false))}</div>
        </Dialog>
      ) : null}
    </div>
  );
}
