/**
 * The browser pane's find-in-page bar.
 *
 * Its own file because it is a self-contained strip with its own Escape
 * contract — the bar claims the key so dismissing a six-character input does
 * not take the whole Browser tool down with it — and that rule is worth being
 * able to read on its own.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { AnimatePresence, motion } from "motion/react";
import { findMatchLabel, type BrowserFindState } from "./browserToolbarLabels";
import { revealTransition } from "../../../lib/motion";
import { cn } from "../../ui/cn";
import { FindField } from "../../shared/FindBar";
import { CHROME_BAR_CLASS, CHROME_FIELD_NO_HALO, CHROME_HAIRLINE, TOOLBAR_FOCUS, TOOLBAR_MOTION } from "./browserChrome";

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
          className={cn("shrink-0 overflow-hidden border-b", CHROME_HAIRLINE)}
        >
          <form
            role="search"
            aria-label="Find in this page"
            onSubmit={(event) => {
              event.preventDefault();
              findStep(findText, true);
            }}
            className={cn("flex min-w-0 select-none items-center gap-2 overflow-hidden px-2", CHROME_BAR_CLASS)}
          >
            <FindField
              inputRef={inputRef}
              query={findText}
              onQueryChange={(text) => {
                setFindText(text);
                queueFind(text);
              }}
              onStep={(direction) => findStep(findText, direction > 0)}
              onClose={closeFind}
              status={findError ?? findMatchLabel(findState) ?? ""}
              statusTone={findError ? "warning" : "count"}
              canStep={Boolean(findText.trim())}
              placeholder="Find on page"
              inputClassName={CHROME_FIELD_NO_HALO}
              buttonClassName={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/75 hover:bg-fg/[0.06] hover:text-fg disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
            />
          </form>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
