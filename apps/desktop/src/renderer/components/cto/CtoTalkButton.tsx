import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Microphone } from "@phosphor-icons/react";

import { CtoVoiceStartSheet } from "./CtoVoiceStartSheet";
import { isVoiceCallLive } from "../../../shared/types/ctoVoice";
import { COLORS } from "../lanes/laneDesignTokens";
import { getFocusableElements } from "../ui/dialogFocus";
import { useCtoVoiceCall } from "./useCtoVoiceCall";

/**
 * "Talk to CTO".
 *
 * Always visible, even with no key configured. A feature nobody can find is a
 * feature nobody enables, so the button exists and tapping it with no key opens
 * the key sheet — the same one Settings uses, so the cost sentence, the field,
 * and the never-re-display rule have exactly one implementation.
 */
/**
 * The ring around Talk.
 *
 * A conic gradient on a square that is larger than the pill, spinning inside a
 * rounded, clipped shell; the opaque button face sits on top and leaves only
 * 1.5px of it showing as a border. Cheaper and far more robust than
 * `mask-composite`, which several of our targets still render wrong, and it is
 * one element and one keyframe rather than anything running in JS.
 *
 * Injected once from here rather than added to the global sheet: it belongs to
 * this control and nothing else styles a Talk button.
 */
const TALK_STYLE_ID = "cto-talk-style";

const TALK_CSS = `
.cto-talk-shell {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  padding: 1.5px;
  border-radius: 999px;
  overflow: hidden;
  box-shadow: 0 0 10px -3px rgba(167, 139, 250, 0.35);
  transition: box-shadow 220ms ease;
}
.cto-talk-aurora {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 230%;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  background: conic-gradient(
    from 0deg,
    #22d3ee, #60a5fa, #a78bfa, #f472b6, #fbbf24, #34d399, #22d3ee
  );
  opacity: 0.5;
  animation: cto-talk-spin 7s linear infinite;
}
.cto-talk-shell:hover {
  box-shadow: 0 0 16px -2px rgba(167, 139, 250, 0.55);
}
.cto-talk-shell:hover .cto-talk-aurora {
  opacity: 0.85;
  animation-duration: 4s;
}
/* On a call the ring speeds up; while the CTO is speaking it also breathes. */
.cto-talk-shell[data-live="true"] .cto-talk-aurora { opacity: 0.8; animation-duration: 3.5s; }
.cto-talk-shell[data-speaking="true"] .cto-talk-aurora { opacity: 0.95; animation-duration: 2s; }
.cto-talk-shell[data-speaking="true"] { animation: cto-talk-breathe 1.6s ease-in-out infinite; }
.cto-talk-face {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 29px;
  padding: 0 12px;
  border-radius: 999px;
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  background: #14121c;
  transition: background 160ms ease, color 160ms ease;
}
.cto-talk-face:hover { background: #1b1826; }
.cto-talk-face:disabled { cursor: default; }
@keyframes cto-talk-spin { to { transform: translate(-50%, -50%) rotate(1turn); } }
@keyframes cto-talk-breathe {
  0%, 100% { box-shadow: 0 0 10px -3px rgba(167, 139, 250, 0.45); }
  50% { box-shadow: 0 0 20px 0 rgba(167, 139, 250, 0.6); }
}
@media (prefers-reduced-motion: reduce) {
  .cto-talk-aurora { animation: none; }
  .cto-talk-shell[data-speaking="true"] { animation: none; }
}
`;

/** One sheet for the whole app, added the first time a Talk button mounts. */
function useTalkStyle(): void {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(TALK_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = TALK_STYLE_ID;
    style.textContent = TALK_CSS;
    document.head.append(style);
  }, []);
}

/**
 * The key sheet's modal shell.
 *
 * It was a bare `div` over a backdrop: no role, no `aria-modal`, no Escape,
 * nothing stopping Tab from walking out of it into the page behind, and no way
 * back to the button that opened it. A dialog asking for a secret is the last
 * place to leave keyboard users stranded.
 *
 * Local to this file rather than shared with `AutoHandoffModal`'s trap: both
 * read the one focusable-element list in `ui/dialogFocus`, which is the part
 * that must not drift. Lifting a common `ui/Modal` means editing that modal
 * too, which belongs to another surface.
 */
function KeyDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Focus lands inside on open and goes back where it came from on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) getFocusableElements(panel)[0]?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  // Bound at the window, not the panel: clicking the dialog's plain text
  // leaves focus on <body>, where a panel-level handler never sees the key.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-black/55 p-6"
      onClick={onClose}
      data-testid="cto-voice-key-sheet"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-[440px] rounded-2xl p-5"
        style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.border}` }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const nodes = getFocusableElements(event.currentTarget);
          if (nodes.length === 0) return;
          const first = nodes[0]!;
          const last = nodes[nodes.length - 1]!;
          const active = document.activeElement as HTMLElement | null;
          if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div id={titleId} className="mb-1 text-[13px] font-semibold" style={{ color: COLORS.textPrimary }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

export type CtoTalkButtonProps = {
  /**
   * Where the failure line is drawn.
   *
   * Not next to the button: a sentence in a right-aligned header group pushed
   * the controls around and wrapped "Talk" onto a second line. The page shows
   * it as its own line under the header, so the header never moves.
   */
  onNotice?: (message: string | null) => void;
};

export function CtoTalkButton({ onNotice }: CtoTalkButtonProps = {}) {
  const { state } = useCtoVoiceCall();
  useTalkStyle();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // `isVoiceCallLive`, not "not idle": a failed call is over, and the old
  // check left this button disabled forever after one.
  const live = isVoiceCallLive(state.phase);

  /**
   * Talk opens the sheet. Always, key or no key.
   *
   * The sheet is the only place a failure can be acted on, so the press goes
   * there first and the sheet does the connecting. Starting the call from here
   * and opening the sheet only for a missing key sends every OTHER failure — a
   * microphone that will not open, a socket that never comes up — to a one-line
   * notice under the page header with nothing to press, and "No microphone is
   * connected" needs an "Open sound settings" button beside it.
   */
  const onClick = useCallback(() => {
    if (live || sheetOpen) return;
    setNotice(null);
    setSheetOpen(true);
  }, [live, sheetOpen]);

  // The sheet owns the attempt, so the button is "connecting" exactly while it
  // is open and the call is not yet up.
  const starting = sheetOpen && !live;

  // A call that fails after it starts (a refused socket, a dropped connection)
  // reports through the call state, not the start result — and then the call
  // ends, the HUD unmounts, and the reason went with it. The page kept no
  // record, so a failed call looked like a button that did nothing.
  //
  // Latched rather than read live, because the service clears `error` on the
  // way to `ended`: by the time there is room to show it, it is gone.
  const [callFailure, setCallFailure] = useState<string | null>(null);
  useEffect(() => {
    // Only the window holding the microphone speaks for the call. Every window
    // mounts a HUD, and a failure is not news in the ones that did not call.
    if (!state.isCallOwner) return;
    if (state.error && (state.phase === "failed" || state.phase === "ended")) {
      setCallFailure(state.error);
      return;
    }
    // A new call is its own story; the last one's failure stops being current.
    if (isVoiceCallLive(state.phase)) setCallFailure(null);
  }, [state.error, state.phase, state.isCallOwner]);

  // The only place the reason is drawn. The HUD says "Call failed" inside its
  // pill and stops there: a sentence trailing below the pill has no border to
  // stay inside and lands on the composer.
  // While the sheet is open it shows its own failures, with buttons that act
  // on them. A page notice saying the same thing behind the modal is how a
  // user learns to read neither.
  const message = sheetOpen ? null : (notice ?? callFailure);

  useEffect(() => {
    onNotice?.(message);
    return () => onNotice?.(null);
  }, [message, onNotice]);

  return (
    <>
      <span
        className="cto-talk-shell"
        data-live={live ? "true" : undefined}
        data-speaking={state.phase === "speaking" ? "true" : undefined}
      >
        <span className="cto-talk-aurora" aria-hidden />
        <button
          type="button"
          onClick={onClick}
          disabled={live}
          data-testid="cto-talk-button"
          title={live ? "A call is already running" : "Talk to the CTO"}
          className="cto-talk-face"
          style={{ color: live ? COLORS.textMuted : COLORS.textPrimary }}
        >
          <Microphone size={13} weight="fill" />
          {starting ? "Connecting…" : "Talk"}
        </button>
      </span>

      {sheetOpen ? (
        <KeyDialog title="Talk to the CTO" onClose={() => setSheetOpen(false)}>
          {/* The whole flow lives in here now: key, connecting, and the card
              that explains a microphone that will not open. It closes itself
              when the call is live. */}
          <CtoVoiceStartSheet onClose={() => setSheetOpen(false)} />
        </KeyDialog>
      ) : null}
    </>
  );
}
