import React, { useCallback } from "react";
import { useRootAppStore } from "../../state/appStore";
import { globalVoiceRecorder } from "../../services/globalVoiceRecorder";
import { RecordingPill } from "./RecordingPill";

/**
 * Always-mounted header affordance for the app-global voice recorder.
 *
 * It lives in the shell chrome (TopBar), OUTSIDE any project-scoped store, and
 * subscribes to the ROOT dictation slice. Whenever a recording is in progress —
 * even after the user navigates away from the composer that started it — this
 * shows the same pill (timer + real-amplitude waveform + cancel/done) so the
 * capture is reachable from anywhere. Done/cancel here drive the same singleton
 * recorder the composer uses, so either surface can finish a recording.
 *
 * Renders nothing while idle (phase === "idle"), like the neighbouring
 * ResourcePressureIndicator.
 */
export function GlobalVoiceCaptureIndicator() {
  const phase = useRootAppStore((s) => s.dictationPhase);
  const elapsed = useRootAppStore((s) => s.dictationElapsed);
  const levels = useRootAppStore((s) => s.dictationLevels);

  const onCancel = useCallback(() => globalVoiceRecorder.cancel(), []);
  const onDone = useCallback(() => {
    void globalVoiceRecorder.finish();
  }, []);

  if (phase === "idle") return null;

  return (
    <div
      className="shrink-0"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <RecordingPill
        phase={phase}
        elapsedSeconds={elapsed}
        levels={levels}
        onCancel={onCancel}
        onDone={onDone}
        compact
      />
    </div>
  );
}
