import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Microphone } from "@phosphor-icons/react";

import { OpenAiKeySheet } from "../settings/OpenAiKeySheet";
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
 * Why a call could not start, in the user's terms.
 *
 * Keyed by the `error` the main process answers with. Anything not listed gets
 * the generic line — the point is that every failure says something.
 */
const START_FAILURE_MESSAGES: Record<string, string> = {
  // Every router refusal arrives as `unavailable`, not just a build without
  // the feature — the detail sentence says which one, so the headline must not
  // contradict it ("…in this build of ADE. No project is open.").
  unavailable: "ADE can't start a call right now.",
  "confirm-mode": "ADE couldn't set the CTO's permissions for a call. Check that the project has a primary lane.",
  ended: "That call ended before it connected. Try again.",
};

const DEFAULT_START_FAILURE = "ADE couldn't start the call. See the logs for details.";

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
  const { state, start } = useCtoVoiceCall();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // `isVoiceCallLive`, not "not idle": a failed call is over, and the old
  // check left this button disabled forever after one.
  const live = isVoiceCallLive(state.phase);

  const onClick = useCallback(async () => {
    if (live || starting) return;
    setStarting(true);
    setNotice(null);
    try {
      const result = await start();
      if (result.ok) return;
      // No key yet is the one failure that has a next step rather than a
      // message, so it opens the sheet.
      if (result.error === "missing-key") {
        setSheetOpen(true);
        return;
      }
      // Everything else used to fall through to nothing at all: the button
      // flickered "Connecting…" and went back to "Talk" with no HUD, no sheet
      // and no error. A control that silently does nothing is worse than one
      // that says why it cannot.
      const base = START_FAILURE_MESSAGES[result.error ?? ""] ?? DEFAULT_START_FAILURE;
      const detail = result.detail?.trim();
      // The detail is a second sentence, not a parenthetical: a bracket at the
      // end of a one-line notice is the first thing truncation eats.
      setNotice(detail ? `${base} ${detail.endsWith(".") ? detail : `${detail}.`}` : base);
    } catch (error) {
      // `ipcMain.handle` turns a main-process throw into a rejected invoke, and
      // `void onClick()` swallowed it as an unhandled rejection.
      setNotice(DEFAULT_START_FAILURE);
      // eslint-disable-next-line no-console
      console.error("[cto-voice] start failed", error);
    } finally {
      setStarting(false);
    }
  }, [live, start, starting]);

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
  // pill and stops there — the sentence it used to trail below itself had no
  // border to stay inside and landed on the composer.
  const message = notice ?? callFailure;

  useEffect(() => {
    onNotice?.(message);
    return () => onNotice?.(null);
  }, [message, onNotice]);

  return (
    <>
      <button
        type="button"
        onClick={() => { void onClick(); }}
        disabled={live}
        data-testid="cto-talk-button"
        title={live ? "A call is already running" : "Talk to the CTO"}
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[10px] font-medium transition-colors disabled:opacity-45"
        style={{ border: "1px solid rgba(255,255,255,0.12)", color: COLORS.textSecondary, whiteSpace: "nowrap" }}
      >
        <Microphone size={11} weight="bold" />
        {starting ? "Connecting…" : "Talk"}
      </button>

      {sheetOpen ? (
        <KeyDialog title="Talk to the CTO" onClose={() => setSheetOpen(false)}>
          <OpenAiKeySheet
            saveLabel="Save and start"
            onCancel={() => setSheetOpen(false)}
            onSaved={() => { setSheetOpen(false); void start(); }}
          />
        </KeyDialog>
      ) : null}
    </>
  );
}
