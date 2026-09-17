import React, { useCallback, useEffect, useRef, useState } from "react";

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
 * It is one sheet on purpose. A modal that asks for a secret and then abandons
 * the user at the first obstacle — closing on Save, starting the call behind
 * itself, leaving whatever went wrong as a yellow line under the page header —
 * is worse than no modal. So the sheet stays up through connecting, closes only
 * when the call is actually live, and turns into a card with buttons when it is
 * not.
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
  // The detail sentence names the cause and the fix, so the headline only says
  // that the CALL is what could not start — not why, and not that the CTO is
  // broken.
  "chat-unavailable": "ADE can't start a call on this conversation.",
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
  /**
   * The refusal code behind the message, kept so the card can offer the fix
   * for THIS cause. Dropping it is what left a thread over its context limit
   * with nothing but "Try again", which could only ever fail the same way.
   */
  error: string | null;
  /** Present only for microphone failures, which have a pane worth opening. */
  microphone: CtoVoiceMicrophoneBlockKind | null;
};

/**
 * Retire the wedged conversation and open a fresh one.
 *
 * The sheet reaches for the bridge directly, the way it does for the system
 * settings panes: it is a modal that owns its own recovery, not a presentation
 * component someone else feeds.
 */
async function startFreshCtoSession(): Promise<boolean> {
  const startFresh = window.ade?.cto?.startFreshSession;
  if (!startFresh) return false;
  try {
    await startFresh();
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[cto-voice] fresh session failed", error);
    return false;
  }
}

/**
 * The pane that can actually fix this cause, and what the button should say.
 *
 * Permission and hardware are different problems in different panes: a machine
 * with no microphone needs the one that lists INPUTS, not the one that lists
 * apps, and sending it to the permission pane is how "ADE is already allowed"
 * becomes a dead end.
 */
function settingsActionFor(kind: CtoVoiceMicrophoneBlockKind | null): {
  label: string;
  paneId: SystemSettingsPaneId;
} | null {
  if (!kind) return null;
  const windows = rendererRuntimeTarget().platform === "win32";
  if (kind === "no-device" || kind === "unavailable") {
    return {
      label: "Open sound settings",
      paneId: windows ? "windows-sound" : "macos-sound-input",
    };
  }
  if (kind === "in-use") return null;
  return {
    label: "Open microphone settings",
    paneId: windows ? "windows-microphone" : "macos-microphone",
  };
}

/**
 * Open an OS pane by id, never by URL.
 *
 * `x-apple.systempreferences:` and `ms-settings:` are deliberately outside the
 * external-URL scheme allowlist, so main resolves a small enum against a vetted
 * table instead of the renderer handing it a string. See
 * `shared/types/systemSettings.ts`.
 */
async function openSettingsPane(paneId: SystemSettingsPaneId): Promise<void> {
  const open = window.ade?.app?.openSystemSettingsPane;
  if (!open) return;
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
  // Connecting first, always. The key step is a FALLBACK reached by asking and
  // being told there is no key — not a branch decided by probing for one — so
  // there is one path through this sheet whether a key exists or not, and a
  // machine that already has one goes straight to trying.
  const [phase, setPhase] = useState<"key" | "connecting" | "blocked">("connecting");
  const [failure, setFailure] = useState<SheetFailure | null>(null);

  const live = isVoiceCallLive(state.phase) && state.isCallOwner;

  /**
   * The verdict that was already on screen when this attempt began.
   *
   * The call store is module-scoped and keeps the last call's error for the
   * life of the window, so a sheet opened after a failed call reads a sentence
   * about a call that is already over, shows "blocked" over a HUD that is
   * running fine, and does it before this attempt has had a chance to fail on
   * its own. Re-latched at the top of every attempt, so Try again is judged the
   * same way the first press was.
   */
  const latestRef = useRef(state);
  latestRef.current = state;
  const seenErrorRef = useRef<{ callId: string | null; error: string | null }>({
    callId: state.callId,
    error: state.error,
  });

  const run = useCallback(async () => {
    seenErrorRef.current = { callId: latestRef.current.callId, error: latestRef.current.error };
    setFailure(null);
    // A previous attempt's verdict is not this one's; leaving it set would make
    // the sheet jump straight back to the card it was just dismissed from.
    clearCtoMicrophoneFailure();
    setPhase("connecting");
    try {
      const result = await start();
      if (result.ok) return;
      // The one refusal with a next step rather than a sentence.
      if (result.error === "missing-key") {
        setPhase("key");
        return;
      }
      setFailure({
        title: START_FAILURE_TITLE,
        message: describeStartFailure(result.error, result.detail),
        error: result.error ?? null,
        microphone: null,
      });
      setPhase("blocked");
    } catch (error) {
      setFailure({
        title: START_FAILURE_TITLE,
        message: DEFAULT_START_FAILURE,
        error: null,
        microphone: null,
      });
      setPhase("blocked");
      // eslint-disable-next-line no-console
      console.error("[cto-voice] start failed", error);
    }
  }, [start]);

  // The sheet starts the call itself, once, on mount. A ref rather than a
  // dependency guard because `run` is recreated whenever `start` is, and a
  // second call is the one mistake this must not make.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
  }, [run]);

  // The microphone is opened by the HUD host, not by this sheet, so its verdict
  // arrives asynchronously after `start()` has already answered `ok`.
  useEffect(() => {
    if (!microphoneFailure) return;
    setFailure({
      title: CTO_VOICE_MICROPHONE_BLOCK_TITLE,
      message: microphoneFailure.message,
      error: null,
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
    // The error this attempt inherited is not this attempt's.
    const seen = seenErrorRef.current;
    if (state.callId === seen.callId && state.error === seen.error) return;
    setFailure({ title: START_FAILURE_TITLE, message: state.error, error: null, microphone: null });
    setPhase("blocked");
  }, [phase, state.phase, state.error, state.callId]);

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

  const settingsAction = settingsActionFor(failure?.microphone ?? null);
  // The one refusal the owner can clear without leaving this sheet.
  const chatOverLimit = failure?.error === "chat-unavailable";

  return (
    <div data-testid="cto-voice-sheet-blocked">
      <div className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary }}>
        {failure?.title ?? START_FAILURE_TITLE}
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.5]" style={{ color: COLORS.textSecondary }}>
        {failure?.message ?? DEFAULT_START_FAILURE}
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        {settingsAction ? (
          <SheetButton
            label={settingsAction.label}
            testId="cto-voice-open-mic-settings"
            onClick={() => { void openSettingsPane(settingsAction.paneId); }}
          />
        ) : null}
        {chatOverLimit ? (
          <SheetButton
            label="Start a fresh session"
            testId="cto-voice-start-fresh-session"
            onClick={() => {
              void (async () => {
                setPhase("connecting");
                if (await startFreshCtoSession()) {
                  await run();
                  return;
                }
                setPhase("blocked");
              })();
            }}
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
