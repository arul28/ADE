import React, { useCallback, useState } from "react";
import { Microphone } from "@phosphor-icons/react";

import { OpenAiKeySheet } from "../settings/OpenAiKeySheet";
import { isVoiceCallLive } from "../../../shared/types/ctoVoice";
import { COLORS } from "../lanes/laneDesignTokens";
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
  unavailable: "Voice calls aren't available in this build of ADE.",
  "confirm-mode": "ADE couldn't set the CTO's permissions for a call. Check that the project has a primary lane.",
  ended: "That call ended before it connected. Try again.",
};

const DEFAULT_START_FAILURE = "ADE couldn't start the call. See the logs for details.";

export function CtoTalkButton() {
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
      setNotice(START_FAILURE_MESSAGES[result.error ?? ""] ?? DEFAULT_START_FAILURE);
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
  // reports through the call state, not the start result.
  const failure = state.phase === "failed" ? state.error : null;
  const message = notice ?? failure;

  return (
    <>
      {message ? (
        <span
          data-testid="cto-talk-error"
          role="status"
          className="max-w-[320px] truncate text-[10px]"
          style={{ color: COLORS.warning }}
          title={message}
        >
          {message}
        </span>
      ) : null}
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
        <div
          className="fixed inset-0 z-[200] grid place-items-center bg-black/55 p-6"
          onClick={() => setSheetOpen(false)}
          data-testid="cto-voice-key-sheet"
        >
          <div
            className="w-full max-w-[440px] rounded-2xl p-5"
            style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.border}` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-1 text-[13px] font-semibold" style={{ color: COLORS.textPrimary }}>
              Talk to the CTO
            </div>
            <OpenAiKeySheet
              saveLabel="Save and start"
              onCancel={() => setSheetOpen(false)}
              onSaved={() => { setSheetOpen(false); void start(); }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
