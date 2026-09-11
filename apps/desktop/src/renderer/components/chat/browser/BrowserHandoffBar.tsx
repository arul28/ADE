/**
 * The login handoff bar.
 *
 * Its own file because it is the one strip that speaks for the agent rather
 * than about it, with its own two-state copy — "sign in" versus the automatic
 * "signed in?" offer — that is easy to get wrong when it is inlined among the
 * pane's other banners.
 */
import { Hand } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import type { BuiltInBrowserTabHandoff } from "../../../../shared/types/builtInBrowser";
import { revealTransition } from "../../../lib/motion";
import { cn } from "../../ui/cn";
import { CHROME_BAR_CLASS, TOOLBAR_FOCUS, TOOLBAR_MOTION } from "./browserChrome";

/**
 * The one coloured fill left in the chrome.
 *
 * Everything else on this pane is ghost — so amber at 10% is not decoration
 * here, it is the whole signal that the browser has stopped being the agent's
 * and started being yours.
 */
const HANDOFF_FILL = "bg-amber-500/10";

/** A button inside the amber bar: no fill of its own, just the amber type. */
const HANDOFF_BUTTON = [
  "inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] font-medium",
  "text-amber-50/90 hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-45",
].join(" ");

export type BrowserHandoffBarProps = {
  handoff: BuiltInBrowserTabHandoff | null;
  reduceMotion: boolean;
  showHandBackOffer: boolean;
  busy: string | null;
  onHandBack: (endedBy: "human" | "auto-offer") => void;
  onKeepControl: () => void;
};

export function BrowserHandoffBar({
  handoff,
  reduceMotion,
  showHandBackOffer,
  busy,
  onHandBack,
  onKeepControl,
}: BrowserHandoffBarProps) {
  return (
    /*
      Login handoff bar. The one place the pane speaks for the agent rather
      than about it: the agent said out loud that it cannot sign in, so this
      asks the person directly and hands the tab straight back when they are
      done. Amber, not red — a handoff is a request, not a failure.
    */
    <AnimatePresence initial={false}>
      {handoff ? (
        <motion.div
          key="ade-browser-handoff"
          data-testid="browser-handoff-bar"
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={revealTransition}
          className={cn("shrink-0 overflow-hidden border-b border-amber-300/15", HANDOFF_FILL)}
        >
          <div
            role="status"
            aria-live="polite"
            className={cn("flex min-w-0 items-center gap-2 overflow-hidden px-2.5 text-[11.5px] text-amber-100/85", CHROME_BAR_CLASS)}
          >
            {showHandBackOffer ? (
              <>
                <Hand size={13} weight="duotone" className="shrink-0" aria-hidden />
                <span className="min-w-0 break-words">Signed in?</span>
                <button
                  type="button"
                  onClick={() => onHandBack("auto-offer")}
                  disabled={busy === "hand-back"}
                  className={cn("ml-auto", HANDOFF_BUTTON, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
                >
                  Hand back now
                </button>
                <button
                  type="button"
                  onClick={onKeepControl}
                  className={cn(HANDOFF_BUTTON, "text-amber-100/70", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
                >
                  Keep control
                </button>
              </>
            ) : (
              <>
                <Hand size={13} weight="duotone" className="shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                  Agent needs you to sign in · &ldquo;{handoff.reason}&rdquo;
                </span>
                <button
                  type="button"
                  onClick={() => onHandBack("human")}
                  disabled={busy === "hand-back"}
                  className={cn("ml-auto", HANDOFF_BUTTON, TOOLBAR_MOTION, TOOLBAR_FOCUS)}
                >
                  Hand back
                </button>
              </>
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
