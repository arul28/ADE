import React, { useEffect, useMemo, useRef, useState } from "react";

import { isVoiceCallLive } from "../../../shared/types/ctoVoice";
import { SceneFrame } from "../chat/SceneFrame";
import { CtoVoiceHud } from "./CtoVoiceHud";
import { useCtoVoiceAudioOwner, useCtoVoiceCall } from "./useCtoVoiceCall";

/**
 * Mounts the call HUD once, at the shell level.
 *
 * It lives beside `ActivityPane` and `CommandPalette` rather than inside the
 * CTO page for one reason: a call you can only see on the CTO tab is a call you
 * have to stop working to have. Mounted here it survives every route and
 * project-tab change, which is the entire point of a HUD.
 */
export function CtoVoiceHudHost() {
  const { state, end, toggleMute, approve, deny } = useCtoVoiceCall();

  // This host is mounted once, at the shell. It owns the microphone, the
  // speaker, and the capture bridge for every surface that can start a call.
  useCtoVoiceAudioOwner(state);

  // The main process owns the call; the visible timer is the renderer's, so it
  // keeps ticking between state pushes instead of jumping a second at a time.
  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const running = isVoiceCallLive(state.phase);

  useEffect(() => {
    if (!running) {
      startedAtRef.current = null;
      setElapsedMs(0);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const tick = () => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const canvas = useMemo(() => {
    if (!state.sceneSource) return null;
    return (
      <div className="max-h-[320px] overflow-hidden">
        <SceneFrame source={state.sceneSource} live scopeKey={state.callId ?? "call"} />
      </div>
    );
  }, [state.sceneSource, state.callId]);

  return (
    <CtoVoiceHud
      state={{ ...state, elapsedMs }}
      canvas={canvas}
      onToggleMute={toggleMute}
      onEnd={() => { void end(); }}
      onApproveConfirmation={approve}
      onDenyConfirmation={deny}
    />
  );
}
