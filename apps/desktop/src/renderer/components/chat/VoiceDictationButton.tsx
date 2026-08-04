import React, { useCallback, useEffect } from "react";
import { Microphone } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import { useRootAppStore } from "../../state/appStore";
import {
  globalVoiceRecorder,
  type GlobalVoiceRecorderError,
} from "../../services/globalVoiceRecorder";
import { RecordingPill } from "../voice/RecordingPill";
import { microphonePermissionGuidance } from "./microphonePermissionGuidance";

/**
 * Voice-to-text dictation control for chat composers (desktop).
 *
 * This is now a THIN UI shell over the app-global `globalVoiceRecorder`
 * singleton: clicking the mic optimistically opens the recording pill (and the
 * composer's shimmer) before `getUserMedia` resolves, capture survives this
 * component unmounting (the singleton owns the audio graph), and the cleaned
 * transcript is inserted into whichever composer is currently registered as the
 * active dictation target (always also copied to the clipboard).
 *
 * Visibility is gated by the caller (settings toggle + model-installed status).
 * When the model is not installed the caller renders a disabled mic instead of
 * mounting this control.
 */

function messageForError(error: GlobalVoiceRecorderError): string {
  switch (error) {
    case "mic_denied":
      return microphonePermissionGuidance();
    case "mic_unavailable":
      return "Could not start the microphone.";
    case "no_audio":
      return "Didn't catch anything there, try again please.";
    case "model_not_installed":
      return "Voice model not installed.";
    case "transcribe_failed":
    default:
      return "Transcription failed. Try again.";
  }
}

export function VoiceDictationButton({
  disabled = false,
  onError,
  onOptimisticStart,
  className,
}: {
  disabled?: boolean;
  /** Optional surface for a user-facing error (e.g. mic permission denied). */
  onError?: (message: string) => void;
  /**
   * Fired the instant the mic is clicked (before getUserMedia resolves) so the
   * composer can kick off its insert-shimmer / optimistic affordance.
   */
  onOptimisticStart?: () => void;
  className?: string;
}) {
  const phase = useRootAppStore((s) => s.dictationPhase);
  const elapsed = useRootAppStore((s) => s.dictationElapsed);
  const levels = useRootAppStore((s) => s.dictationLevels);

  // Surface recorder errors (permission denial, transcription failure, …)
  // through the composer's existing error channel.
  useEffect(() => {
    if (!onError) return;
    return globalVoiceRecorder.onError((error) => onError(messageForError(error)));
  }, [onError]);

  const handleStart = useCallback(() => {
    if (disabled) return;
    if (globalVoiceRecorder.isBusy()) return;
    // Optimistic affordance: flip the pill on immediately and shimmer the box,
    // BEFORE getUserMedia resolves. The recorder reverts to idle (and emits an
    // error) if permission is denied or capture fails.
    onOptimisticStart?.();
    void globalVoiceRecorder.start();
  }, [disabled, onOptimisticStart]);

  const handleCancel = useCallback(() => globalVoiceRecorder.cancel(), []);
  const handleDone = useCallback(() => {
    void globalVoiceRecorder.finish();
  }, []);

  if (phase !== "idle") {
    return (
      <RecordingPill
        phase={phase}
        elapsedSeconds={elapsed}
        levels={levels}
        onCancel={handleCancel}
        onDone={handleDone}
        className={className}
        fontSizeStyle="calc(var(--chat-font-size) * 10 / 14)"
      />
    );
  }

  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: "Voice input",
        description: "Dictate a prompt. ADE transcribes on-device and inserts cleaned text at the cursor.",
      }}
    >
      <button
        type="button"
        onClick={handleStart}
        disabled={disabled}
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all active:scale-[0.97]",
          "text-muted-fg/35 hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] hover:text-[var(--chat-accent)]",
          disabled ? "cursor-not-allowed opacity-40" : "",
          className,
        )}
        aria-label="Start voice input"
      >
        <Microphone size={14} weight="regular" />
      </button>
    </SmartTooltip>
  );
}
