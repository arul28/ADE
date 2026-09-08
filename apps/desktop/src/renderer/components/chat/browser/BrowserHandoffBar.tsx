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
          className="shrink-0 overflow-hidden border-b border-amber-300/16 bg-amber-500/[0.075]"
        >
          <div
            role="status"
            aria-live="polite"
            className="flex min-w-0 items-center gap-2 overflow-hidden px-2.5 py-1.5 text-[11px] text-amber-100/85"
          >
            {showHandBackOffer ? (
              <>
                <Hand size={12} weight="duotone" className="shrink-0" aria-hidden />
                <span className="min-w-0 break-words">Signed in?</span>
                <button
                  type="button"
                  onClick={() => onHandBack("auto-offer")}
                  disabled={busy === "hand-back"}
                  className="ml-auto shrink-0 rounded border border-amber-300/25 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-50/90 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Hand back now
                </button>
                <button
                  type="button"
                  onClick={onKeepControl}
                  className="shrink-0 rounded border border-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-amber-100/70 hover:bg-white/[0.06]"
                >
                  Keep control
                </button>
              </>
            ) : (
              <>
                <Hand size={12} weight="duotone" className="shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                  Agent needs you to sign in · &ldquo;{handoff.reason}&rdquo;
                </span>
                <button
                  type="button"
                  onClick={() => onHandBack("human")}
                  disabled={busy === "hand-back"}
                  className="ml-auto shrink-0 rounded border border-amber-300/25 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-50/90 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
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
