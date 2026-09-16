import React, { useCallback, useEffect, useState } from "react";

import { OpenAiKeySheet } from "../settings/OpenAiKeySheet";
import {
  CTO_VOICE_MICROPHONE_BLOCK_TITLE,
  isVoiceCallLive,
  type CtoVoiceMicrophoneBlockKind,
} from "../../../shared/types/ctoVoice";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { rendererRuntimeTarget } from "../../lib/platform";
import { COLORS } from "../lanes/laneDesignTokens";
import {
  clearCtoMicrophoneFailure,
  useCtoMicrophoneFailure,
  useCtoVoiceCall,
} from "./useCtoVoiceCall";

/**
 * Everything between pressing Talk with no key and hearing the CTO.
 *
 * It is one sheet on purpose. The flow used to end at Save: the sheet closed,
 * the call was started behind it, and whatever went wrong afterwards arrived as
 * a yellow line under the page header with no way to act on it. A modal that
 * asks for a secret and then abandons the user at the first obstacle is worse
 * than no modal — so the sheet stays up through connecting, closes only when
 * the call is actually live, and turns into a card with buttons when it is not.
 *
 * Failures render HERE while it is open, and only fall back to the page notice
 * once it has closed. Two places showing the same sentence at once is how a
 * user learns to read neither.
 */

const START_FAILURE_TITLE = "ADE cannot start the call";

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

/** The start result's two sentences, joined as sentences rather than a bracket. */
export function describeStartFailure(error: string | undefined, detail: string | undefined): string {
  const base = START_FAILURE_MESSAGES[error ?? ""] ?? DEFAULT_START_FAILURE;
  const trimmed = detail?.trim();
  if (!trimmed) return base;
  return `${base} ${trimmed.endsWith(".") ? trimmed : `${trimmed}.`}`;
}

type SheetFailure = {
  title: string;
  message: string;
  /** Present only for microphone failures, which have a pane worth opening. */
  microphone: CtoVoiceMicrophoneBlockKind | null;
};

/**
 * Open the OS pane for the microphone.
 *
 * By pane id, never by URL: `x-apple.systempreferences:` and `ms-settings:` are
 * deliberately outside the external-URL scheme allowlist, so main resolves a
 * small enum against a vetted table instead of the renderer handing it a
 * string. See `shared/types/systemSettings.ts`.
 */
async function openMicrophoneSettings(): Promise<void> {
  const open = window.ade?.app?.openSystemSettingsPane;
  if (!open) return;
  const paneId: SystemSettingsPaneId = rendererRuntimeTarget().platform === "win32"
    ? "windows-microphone"
    : "macos-microphone";
  try {
    await open(paneId);
  } catch {
    // A pane that will not open is not worth a second failure on top of the
    // one already on screen.
  }
}

function SheetButton({
  label,
  onClick,
  primary = false,
  testId,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors"
      style={primary
        ? { background: COLORS.accent, color: "#0b0b0c" }
        : { border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary }}
    >
      {label}
    </button>
  );
}

export function CtoVoiceStartSheet({ onClose }: { onClose: () => void }) {
  const { state, start } = useCtoVoiceCall();
  const microphoneFailure = useCtoMicrophoneFailure();
  const [phase, setPhase] = useState<"key" | "connecting" | "blocked">("key");
  const [failure, setFailure] = useState<SheetFailure | null>(null);

  const live = isVoiceCallLive(state.phase) && state.isCallOwner;

  const run = useCallback(async () => {
    setFailure(null);
    // A previous attempt's verdict is not this one's; leaving it set would make
    // the sheet jump straight back to the card it was just dismissed from.
    clearCtoMicrophoneFailure();
    setPhase("connecting");
    try {
      const result = await start();
      if (result.ok) return;
      setFailure({
        title: START_FAILURE_TITLE,
        message: describeStartFailure(result.error, result.detail),
        microphone: null,
      });
      setPhase("blocked");
    } catch (error) {
      setFailure({
        title: START_FAILURE_TITLE,
        message: DEFAULT_START_FAILURE,
        microphone: null,
      });
      setPhase("blocked");
      // eslint-disable-next-line no-console
      console.error("[cto-voice] start failed", error);
    }
  }, [start]);

  // The microphone is opened by the HUD host, not by this sheet, so its verdict
  // arrives asynchronously after `start()` has already answered `ok`.
  useEffect(() => {
    if (!microphoneFailure) return;
    setFailure({
      title: CTO_VOICE_MICROPHONE_BLOCK_TITLE,
      message: microphoneFailure.message,
      microphone: microphoneFailure.kind,
    });
    setPhase("blocked");
  }, [microphoneFailure]);

  // The one exit that is not a click: the call is up, so the sheet's job is
  // done. Guarded on `blocked` because a call that failed and was torn down can
  // pass back through a live-looking phase on its way to `ended`.
  useEffect(() => {
    if (live && phase === "connecting") onClose();
  }, [live, phase, onClose]);

  // A call that died before it went live, with nothing the microphone can
  // explain — a refused key, a socket that never came up. The sentence is the
  // runtime's, and it belongs in the sheet while the sheet is the thing on
  // screen.
  useEffect(() => {
    if (phase !== "connecting") return;
    if (isVoiceCallLive(state.phase) || !state.error) return;
    setFailure({ title: START_FAILURE_TITLE, message: state.error, microphone: null });
    setPhase("blocked");
  }, [phase, state.phase, state.error]);

  if (phase === "key") {
    return (
      <OpenAiKeySheet
        saveLabel="Save and start"
        onCancel={onClose}
        onSaved={() => { void run(); }}
      />
    );
  }

  if (phase === "connecting") {
    return (
      <div className="flex items-center gap-2 py-3" data-testid="cto-voice-sheet-connecting">
        <span
          className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-transparent"
          style={{ borderTopColor: COLORS.accent, borderRightColor: COLORS.accent }}
          aria-hidden
        />
        <span className="text-[12px]" style={{ color: COLORS.textSecondary }}>Connecting…</span>
      </div>
    );
  }

  return (
    <div data-testid="cto-voice-sheet-blocked">
      <div className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary }}>
        {failure?.title ?? START_FAILURE_TITLE}
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.5]" style={{ color: COLORS.textSecondary }}>
        {failure?.message ?? DEFAULT_START_FAILURE}
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        {failure?.microphone ? (
          <SheetButton
            label="Open microphone settings"
            testId="cto-voice-open-mic-settings"
            onClick={() => { void openMicrophoneSettings(); }}
          />
        ) : null}
        <SheetButton
          label="Try again"
          testId="cto-voice-try-again"
          onClick={() => { void run(); }}
        />
        <SheetButton label="Close" testId="cto-voice-sheet-close" primary onClick={onClose} />
      </div>
    </div>
  );
}
