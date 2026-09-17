import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sceneScopeKeyFor, type SceneStillRecord } from "../../../shared/chatScene";
import { CTO_VOICE_SCENE_FRAME_HEIGHT, isVoiceCallLive } from "../../../shared/types/ctoVoice";
import { ChatRuntimeScopeProvider } from "../chat/ChatRuntimeScope";
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
    const source = state.sceneSource;
    if (!source) return null;
    return (
      // This host is mounted at the SHELL, outside every chat scope, so the
      // frame had no ambient session to own the pictures it files and every
      // call still was filed unowned: both disk bounds skipped, and the call's
      // own "Views drawn" section — an owner query — empty. The call knows its
      // chat, so the host supplies the scope rather than reaching past it.
      //
      // Unpinned and unbound, which is what the CTO thread is: a local chat on
      // this machine, so `isRemote` stays false and the frame resolves its
      // stills through `ade-artifact://` exactly as it does inside a pane.
      <ChatRuntimeScopeProvider pin={null} binding={null} laneId={null} sessionId={state.sessionId}>
        <div className="overflow-hidden" style={{ maxHeight: CTO_VOICE_SCENE_FRAME_HEIGHT }}>
          <SceneFrame
            source={source}
            live
            // PER VIEW, not per call. This host keeps ONE mounted frame for the
            // whole call and swaps its source as the CTO draws, and main keeps
            // one still per scope key — so a bare call id meant filing view two
            // deleted view one, leaving the record naming a single view and the
            // live card drawing broken tiles. A genuine redraw of the same view
            // hashes the same and still supersedes itself.
            //
            // No call id means no identity to file under — a fallback key would
            // put every id-less scene on top of the same picture — so the scene
            // draws and simply leaves nothing behind.
            scopeKey={state.callId ? sceneScopeKeyFor(state.callId, source) : null}
            // The bare call id: this is what the finished call's card asks by.
            voiceCallId={state.callId}
            onStill={keepStill}
          />
        </div>
      </ChatRuntimeScopeProvider>
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
