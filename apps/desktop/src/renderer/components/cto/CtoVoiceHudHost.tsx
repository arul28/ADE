import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SceneStillRecord } from "../../../shared/chatScene";
import { CTO_VOICE_SCENE_FRAME_HEIGHT, isVoiceCallLive } from "../../../shared/types/ctoVoice";
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
   * at all.
   *
   * Filing is already done by then: the frame stores the still with this call's
   * id on it, so the durable record is the artifact itself and the finished
   * call's card finds its pictures by asking for them. This only keeps a copy
   * in the window's cache, so the card that appears seconds later has the
   * picture without waiting for a round trip.
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
  }, []);

  const canvas = useMemo(() => {
    if (!state.sceneSource) return null;
    return (
      <div className="overflow-hidden" style={{ maxHeight: CTO_VOICE_SCENE_FRAME_HEIGHT }}>
        <SceneFrame
          source={state.sceneSource}
          live
          // No call id means no identity to file a still under — a fallback
          // key would put every id-less scene on top of the same picture — so
          // the scene draws and simply leaves nothing behind. Null, not an
          // absent prop: the frame already refuses a still with no scope key,
          // and a conditional spread said the same thing twice.
          scopeKey={state.callId}
          voiceCallId={state.callId}
          // This host is mounted at the SHELL, outside every chat scope, so
          // the frame has no ambient session to own the pictures it files.
          // Without this every call still was filed unowned: both disk bounds
          // skipped, and the call's own "Views drawn" section — an owner query
          // — came back empty.
          ownerSessionId={state.sessionId}
          onStill={keepStill}
        />
      </div>
    );
  }, [state.sceneSource, state.callId, state.sessionId, keepStill]);

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
