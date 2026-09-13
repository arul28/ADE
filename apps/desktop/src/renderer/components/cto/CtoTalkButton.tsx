import React, { useCallback, useState } from "react";
import { Microphone } from "@phosphor-icons/react";

import { OpenAiKeySheet } from "../settings/OpenAiKeySheet";
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
export function CtoTalkButton() {
  const { state, start } = useCtoVoiceCall();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const live = state.phase !== "idle" && state.phase !== "ended";

  const onClick = useCallback(async () => {
    if (live || starting) return;
    setStarting(true);
    try {
      const result = await start();
      // The one failure worth a sheet rather than an error: no key yet.
      if (!result.ok && result.error === "missing-key") setSheetOpen(true);
    } finally {
      setStarting(false);
    }
  }, [live, start, starting]);

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
