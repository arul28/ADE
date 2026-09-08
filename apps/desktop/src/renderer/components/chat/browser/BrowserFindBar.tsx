/**
 * The browser pane's find-in-page bar.
 *
 * Its own file because it is a self-contained strip with its own Escape
 * contract — the bar claims the key so dismissing a six-character input does
 * not take the whole Browser tool down with it — and that rule is worth being
 * able to read on its own.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { CaretLeft, CaretRight, MagnifyingGlass, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { findMatchLabel, type BrowserFindState } from "../browserToolbarLabels";
import { revealTransition } from "../../../lib/motion";
import { cn } from "../../ui/cn";
import { TOOLBAR_FOCUS, TOOLBAR_MOTION } from "./browserChrome";

export type BrowserFindBarProps = {
  open: boolean;
  reduceMotion: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  findText: string;
  setFindText: Dispatch<SetStateAction<string>>;
  queueFind: (text: string) => void;
  findStep: (text: string, forward: boolean) => void;
  closeFind: () => void;
  findError: string | null;
  findState: BrowserFindState | null;
};

export function BrowserFindBar({
  open,
  reduceMotion,
  inputRef,
  findText,
  setFindText,
  queueFind,
  findStep,
  closeFind,
  findError,
  findState,
}: BrowserFindBarProps) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="ade-browser-find"
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={revealTransition}
          /*
            Escape belongs to whichever thing is on top. The find bar claims
            it here so the pane's own capture-phase handler — which closes
            the entire tool — skips anything inside a declared scope; the
            input also stops the event itself, so the bar is safe in a shell
            that has not learned the attribute yet.
          */
          data-ade-escape-scope="find"
          data-testid="browser-find-bar"
          className="shrink-0 overflow-hidden border-b border-white/[0.08] bg-white/[0.015]"
        >
          <form
            role="search"
            aria-label="Find in this page"
            onSubmit={(event) => {
              event.preventDefault();
              findStep(findText, true);
            }}
            className="flex min-w-0 select-none items-center gap-1.5 overflow-hidden px-1.5 py-1.5"
          >
            <MagnifyingGlass size={12} className="shrink-0 text-muted-fg/55" />
            <input
              ref={inputRef}
              value={findText}
              onChange={(event) => {
                setFindText(event.target.value);
                queueFind(event.target.value);
              }}
              onKeyDownCapture={(event) => {
                if (event.key !== "Escape") return;
                // Escape closes the bar and nothing else. It used to reach
                // the pane's handler and take the whole Browser tool down
                // with it, which is a very expensive way to dismiss a
                // six-character input.
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                closeFind();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Shift-Enter walks backwards, the way every find bar does.
                event.preventDefault();
                findStep(findText, !event.shiftKey);
              }}
              placeholder="Find on page"
              aria-label="Find on page"
              className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-fg/85 outline-none placeholder:text-muted-fg/40"
            />
            <span
              role="status"
              aria-live="polite"
              className={cn(
                "min-w-0 shrink-0 truncate text-[10px]",
                findError ? "font-sans text-amber-100/80" : "font-mono text-muted-fg/75",
              )}
            >
              {findError ?? findMatchLabel(findState) ?? ""}
            </span>
            <button
              type="button"
              onClick={() => findStep(findText, false)}
              disabled={!findText.trim()}
              title="Previous match"
              aria-label="Previous match"
              className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
            >
              <CaretLeft size={11} />
            </button>
            <button
              type="button"
              onClick={() => findStep(findText, true)}
              disabled={!findText.trim()}
              title="Next match"
              aria-label="Next match"
              className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
            >
              <CaretRight size={11} />
            </button>
            <button
              type="button"
              onClick={closeFind}
              title="Close find bar"
              aria-label="Close find bar"
              className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
            >
              <X size={11} />
            </button>
          </form>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
