import React, { useCallback } from "react";
import { useRootAppStore } from "../../state/appStore";
import { audioCaptureRecorder } from "../../services/audioCaptureRecorder";
import { RecordingPill } from "./RecordingPill";

/**
 * Always-mounted header affordance for the app-global audio recorder.
 *
 * It lives in the shell chrome (TopBar), OUTSIDE any project-scoped store, and
 * subscribes to the ROOT capture slice. This is the ONLY capture UI: a plugin
 * asks for a clip from anywhere — a composer button, a row menu, a background
 * action — so the controls cannot live next to whatever triggered it. Putting
 * them in the always-mounted chrome means the microphone is visible, attributed
 * and stoppable no matter what started it or where the user has navigated
 * since.
 *
 * Renders nothing while idle (phase === "idle"), like the neighbouring
 * ResourcePressureIndicator.
 */
export function GlobalAudioCaptureIndicator() {
  const phase = useRootAppStore((s) => s.audioCapturePhase);
  const elapsed = useRootAppStore((s) => s.audioCaptureElapsed);
  const levels = useRootAppStore((s) => s.audioCaptureLevels);
  const requester = useRootAppStore((s) => s.audioCaptureRequester);

  const onCancel = useCallback(() => audioCaptureRecorder.cancel(), []);
  const onDone = useCallback(() => {
    void audioCaptureRecorder.finish();
  }, []);

  if (phase === "idle") return null;

  return (
    <div
      className="shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <RecordingPill
        phase={phase}
        requesterLabel={requester?.label ?? "A plugin"}
        elapsedSeconds={elapsed}
        levels={levels}
        onCancel={onCancel}
        onDone={onDone}
        compact
      />
    </div>
  );
}
