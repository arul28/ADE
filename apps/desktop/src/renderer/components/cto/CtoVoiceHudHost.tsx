import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SceneStillRecord } from "../../../shared/chatScene";
import { isVoiceCallLive } from "../../../shared/types/ctoVoice";
import { rememberCallStill } from "../chat/sceneStillStore";
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

  /**
   * A scene drawn on a call has to leave a picture behind, and it has exactly
   * one chance to: this host is unmounted with the HUD the moment the call
   * ends, taking the frame — and anything it had not already captured — with
   * it. `SceneFrame` takes the still when the scene STOPS MOVING rather than at
   * the end of the turn, which is what makes a capture-before-unmount possible
   * at all; here it is only forwarded, twice, because the two readers are not
   * the same. The store is what the transcript card reads back, and the call is
   * what writes it into the CTO's durable record of the call.
   *
   * The call id is captured through a ref so the identity of this callback does
   * not change mid-scene and remount the frame under a running animation.
   */
  const callIdRef = useRef<string | null>(state.callId);
  callIdRef.current = state.callId;
  const keepStill = useCallback((record: SceneStillRecord) => {
    const callId = callIdRef.current;
    if (!callId) return;
    rememberCallStill(callId, record);
    void window.ade?.ctoVoice?.attachStill?.({ still: record });
  }, []);

  const canvas = useMemo(() => {
    if (!state.sceneSource) return null;
    return (
      <div className="max-h-[320px] overflow-hidden">
        <SceneFrame
          source={state.sceneSource}
          live
          scopeKey={state.callId ?? "call"}
          onStill={keepStill}
        />
      </div>
    );
  }, [state.sceneSource, state.callId, keepStill]);

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
