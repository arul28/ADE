import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type {
  CaptureGestureFailure,
  CaptureGestureShot,
} from "../../../shared/types/captureGesture";
import type { AgentChatFileRef } from "../../../shared/types/chat";
import { useAppStore, selectActiveProjectStateKey, selectWorkViewState } from "../../state/appStore";
import { readStoredProjectRoute } from "../app/projectRouteStorage";
import { filesProjectSessionKey } from "../files/treeHelpers";
import { useEditorGroupsStore } from "../files/v2/editorGroupsStore";
import { supportsCaptureGesturePlatform } from "../../lib/platform";
import { composeCurrentViewState, formatCurrentViewState } from "./currentViewState";
import {
  describeShot,
  encodeUtf8Base64,
  isVoiceCallLive,
  planCaptureAttachments,
  resolveCaptureDeliveryTarget,
} from "./captureGestureDelivery";
import {
  captureGestureBridgeAvailable,
  readCaptureGestureEnabled,
} from "./captureGestureLocalSettings";
import { CaptureFlyIn } from "./CaptureFlyIn";

/**
 * The renderer half of the global capture gesture.
 *
 * Mounted once, inside the router and above every tab, because the gesture has
 * to work from wherever the user is — the capture arrives from the main process
 * while ADE is in the BACKGROUND, so nothing that only exists on the CTO tab
 * could receive it.
 *
 * The target is always the CTO. If a voice call is on air the shot goes into
 * the call and the composer is left alone; otherwise it is staged as a
 * composer attachment, alongside a structured note about ADE's own view when
 * ADE's own window is what got captured.
 */

/**
 * A PROBE of the CTO voice bridge, not a contract this module owns.
 *
 * `window.ade.ctoVoice` belongs to the voice call feature and may be absent
 * entirely (web client, browser preview, any build without the main-process
 * half). Every member is optional and every call is optional-chained, so a
 * bridge that is missing — or that grows a different shape — degrades to the
 * composer path instead of throwing inside a capture the user is watching for.
 */
type VoiceBridgeProbe = {
  onState?: (handler: (state: { phase?: unknown; callId?: unknown }) => void) => () => void;
  /**
   * Hand the call an image. Not part of the voice bridge today; probed so the
   * capture lands natively the moment it is. Until then the DOM event below is
   * the delivery path.
   */
  attachImage?: (args: {
    pngBase64: string;
    filename: string;
    note: string;
  }) => unknown;
};

/**
 * Fallback delivery into a live call for a renderer-only call implementation.
 * The HUD owns the call state; this is how a capture reaches it without a
 * main-process round trip.
 */
export const CTO_VOICE_CAPTURE_EVENT = "ade:cto-voice:attach-capture";

function voiceBridge(): VoiceBridgeProbe | null {
  if (typeof window === "undefined") return null;
  const ade = (window as unknown as { ade?: { ctoVoice?: VoiceBridgeProbe } }).ade;
  return ade?.ctoVoice ?? null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function GlobalCaptureGestureHost() {
  const navigate = useNavigate();
  const location = useLocation();
  const [flyIn, setFlyIn] = useState<{ id: number; dataUrl: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Live call state, tracked out of band. A ref rather than state: the shot
  // handler reads it at the moment a capture lands, and re-rendering this host
  // on every phase change would restart the fly-in animation mid-flight.
  const voiceLiveRef = useRef(false);
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const bridge = voiceBridge();
    if (!bridge?.onState) return;
    try {
      return bridge.onState((state) => {
        voiceLiveRef.current = isVoiceCallLive(state);
      });
    } catch {
      // A bridge that refuses the subscription simply means "no live call".
      voiceLiveRef.current = false;
      return;
    }
  }, []);

  /** Everything the view-state composer needs, read at capture time. */
  const readViewState = useCallback((): string | null => {
    const state = useAppStore.getState();
    const bindingKey = selectActiveProjectStateKey(state);
    const projectRoot = state.project?.rootPath ?? null;
    const workView = projectRoot ? selectWorkViewState(projectRoot)(state) : null;
    const editorSession = projectRoot
      ? useEditorGroupsStore.getState().getSession(filesProjectSessionKey(projectRoot))
      : undefined;
    const activeGroup = editorSession
      ? editorSession.groups[editorSession.activeGroupId]
      : undefined;
    const activeTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId);
    const current = locationRef.current;
    return formatCurrentViewState(composeCurrentViewState({
      route: `${current.pathname}${current.search}${current.hash}`,
      storedRoute: bindingKey ? readStoredProjectRoute(bindingKey) : null,
      projectName: state.project?.displayName ?? null,
      projectRoot,
      selectedLaneId: state.selectedLaneId,
      laneNamesById: Object.fromEntries(state.lanes.map((lane) => [lane.id, lane.name])),
      activeWorkItemId: workView?.activeItemId ?? null,
      openFilePath: activeTab?.path ?? null,
    }));
  }, []);

  const deliverToCall = useCallback((shot: CaptureGestureShot): void => {
    const bridge = voiceBridge();
    const note = describeShot(shot);
    try {
      bridge?.attachImage?.({ pngBase64: shot.pngBase64, filename: shot.filename, note });
    } catch {
      // Fall through to the DOM event; a bridge that throws must not swallow
      // the capture.
    }
    window.dispatchEvent(new CustomEvent(CTO_VOICE_CAPTURE_EVENT, {
      detail: { shot, note },
    }));
  }, []);

  const deliverToComposer = useCallback(async (shot: CaptureGestureShot): Promise<void> => {
    const ade = window.ade;
    const session = await ade?.cto?.ensureSession().catch(() => null);
    if (!session?.id) {
      setNotice("The CTO chat is still waking up. Try the capture again in a moment.");
      return;
    }
    // Land the user on the CTO before the chips appear, so the attachment is
    // never staged onto a composer nobody is looking at.
    if (locationRef.current.pathname !== "/cto") navigate("/cto");

    const plan = planCaptureAttachments(shot, readViewState(), encodeUtf8Base64);
    const staged: AgentChatFileRef[] = [];
    try {
      const savedImage = await ade.agentChat.saveTempAttachment({
        // Raw base64, never a data URL: ADE's `connect-src` has no `data:`, so
        // anything that round-trips this through `fetch(dataUrl)` fails.
        data: plan.image.data,
        filename: plan.image.filename,
      });
      staged.push({ path: savedImage.path, type: "image" });
      if (plan.context) {
        const savedContext = await ade.agentChat.saveTempAttachment({
          data: plan.context.data,
          filename: plan.context.filename,
        });
        staged.push({ path: savedContext.path, type: "file" });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return;
    }

    for (const attachment of staged) {
      // The same event `WorkSidebar` dispatches. NOT `emitFileChip`, which
      // sends neither a sessionId nor an attachment and reaches no composer.
      window.dispatchEvent(new CustomEvent("ade:agent-chat:add-attachment", {
        detail: { sessionId: session.id, attachment },
      }));
    }
  }, [navigate, readViewState]);

  useEffect(() => {
    // `captureGestureBridgeAvailable()` rather than a property read: the hosted
    // web adapter's fallback proxy FABRICATES a callable namespace for any
    // missing property, so `window.ade.captureGesture` is truthy there and
    // `onShot` would hand back something that is not an unsubscribe function.
    if (!captureGestureBridgeAvailable()) return;
    const bridge = window.ade?.captureGesture;
    if (typeof bridge?.onShot !== "function" || typeof bridge.onFailure !== "function") return;

    const offShot = bridge.onShot((shot) => {
      const target = resolveCaptureDeliveryTarget({
        voiceBridgePresent: voiceBridge() != null,
        voiceCallLive: voiceLiveRef.current,
      });
      if (!prefersReducedMotion()) {
        setFlyIn({ id: Date.now(), dataUrl: `data:image/png;base64,${shot.pngBase64}` });
      }
      setNotice(null);
      if (target.kind === "voice-call") {
        deliverToCall(shot);
        return;
      }
      void deliverToComposer(shot);
    });
    const offFailure = bridge.onFailure((failure: CaptureGestureFailure) => {
      setNotice(failure.message);
    });
    return () => {
      if (typeof offShot === "function") offShot();
      if (typeof offFailure === "function") offFailure();
    };
  }, [deliverToCall, deliverToComposer]);

  // Push the stored preference down on mount. The setting lives in this
  // renderer's localStorage, so the main process cannot know whether to run the
  // helper until a window tells it.
  useEffect(() => {
    if (!supportsCaptureGesturePlatform() || !captureGestureBridgeAvailable()) return;
    void window.ade?.captureGesture?.updateSettings({
      enabled: readCaptureGestureEnabled(),
    }).catch(() => {
      // Health is read separately by the settings card; a failed push here is
      // not worth interrupting anyone over.
    });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <>
      {flyIn ? (
        <CaptureFlyIn
          key={flyIn.id}
          dataUrl={flyIn.dataUrl}
          onDone={() => setFlyIn(null)}
        />
      ) : null}
      {notice ? (
        <div
          role="status"
          data-capture-gesture-notice
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2147483000,
            maxWidth: 460,
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.45,
            background: "var(--color-card)",
            color: "var(--color-fg)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.28)",
          }}
        >
          {notice}
        </div>
      ) : null}
    </>
  );
}
