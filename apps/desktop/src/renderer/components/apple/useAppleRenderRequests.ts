import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AppleRenderRequestSpec, OpenProjectBinding } from "../../../shared/types";
import { showToast, type ToastInput } from "../app/toast/toastStore";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { useAppStore } from "../../state/appStore";
import type { AppleDeviceRenderer } from "./AppleDevice3DView";
import { completeAppleRenderRequest, renderAppleDeviceToProof, type AppleRenderFiled } from "./appleRenderProof";

/**
 * Where a render went, with a way there. The proof lands in the drawer of the
 * chat that holds the device, which need not be the chat on screen, and a
 * person who could not find it once is owed the name of the place.
 */
function renderFiledToast(
  filed: AppleRenderFiled,
  { paneChatSessionId, local }: { paneChatSessionId: string | null; local: boolean },
): ToastInput {
  const count = `${filed.filed} item${filed.filed === 1 ? "" : "s"}`;
  const firstArtifact = filed.artifactIds[0] ?? null;
  const firstFile = filed.filePaths[0] ?? null;
  const here = Boolean(filed.chatSessionId && filed.chatSessionId === paneChatSessionId);
  const where = !filed.chatSessionId
    ? "Filed to this lane's proof (History)."
    : here
      ? "Filed to this chat's proof drawer."
      : "Filed to the proof drawer of the chat that holds this device.";
  const actions: ToastInput["actions"] = [];
  if (here && firstArtifact) {
    actions.push({
      label: "Open proof",
      onClick: () => {
        window.dispatchEvent(new CustomEvent("ade:chat:open-artifact", {
          detail: { sessionId: filed.chatSessionId, artifactId: firstArtifact },
        }));
      },
    });
  }
  // The files sit on the device's machine; Finder can only show them there.
  if (local && firstFile) {
    actions.push({
      label: "Show in Finder",
      onClick: () => {
        void window.ade.app.revealPath(firstFile).catch((error: unknown) => {
          logRendererDebugEvent("apple.render_reveal_failed", { error: error instanceof Error ? error.message : String(error) });
        });
      },
    });
  }
  return {
    id: "apple-render",
    tone: "success",
    title: `Rendered ${count}`,
    message: local && firstFile ? `${where} Saved in ${firstFile.replace(/[/\\][^/\\]*$/u, "")}.` : where,
    ...(actions.length ? { actions } : {}),
  };
}

/**
 * 3D renders of the lane's device, from the Render sheet or `ade apple
 * render`: the renderer the 3D view hands back, the sheet's open state, the
 * render itself, and the broker handshake with the device's machine.
 */
export function useAppleRenderRequests({
  laneId,
  sessionId,
  deviceName,
  duoCapable,
  runtimePinRef,
  pinKey,
  effectiveMode,
  setMode,
  live,
  stalled,
  reconnect,
  onError,
}: {
  laneId: string | null;
  sessionId: string | null;
  deviceName: string | null;
  duoCapable: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** `pin?.key`: the render subscription follows the target machine, not the pin object. */
  pinKey: string | null;
  effectiveMode: "3d" | "flat";
  setMode: (mode: "3d" | "flat") => void;
  /** The pane can take a render: a live (or briefly stalled) stream and a 3D view. */
  live: boolean;
  /**
   * The stream stalled (the window was in the background). A render still
   * goes ahead: the pane reconnects first so the shots get fresh frames.
   */
  stalled: boolean;
  reconnect: () => void;
  onError: (cause: unknown) => void;
}) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const setModeRef = useRef(setMode);
  setModeRef.current = setMode;

  const rendererRef = useRef<AppleDeviceRenderer | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const openRender = useCallback(() => {
    // Renders come from the 3D body; bring it up if the flat view is on.
    if (effectiveMode !== "3d") setModeRef.current("3d");
    setRenderOpen(true);
  }, [effectiveMode]);

  /** The Render sheet's (and the CLI's) render, with this pane's busy state, toast and errors. */
  const runRender = useCallback(async (request: AppleRenderRequestSpec): Promise<AppleRenderFiled> => {
    if (!rendererRef.current) {
      showToast({ id: "apple-render", tone: "warning", title: "The 3D view is still loading. Try again in a moment." });
      throw new Error("The 3D view is still loading.");
    }
    setRendering(true);
    try {
      const filed = await renderAppleDeviceToProof({
        request,
        rendererRef,
        laneId,
        chatSessionId: sessionId,
        deviceName,
        duoCapable,
        runtimePinRef,
      });
      // The files are on this computer when the pane's pin (else the tab) is local.
      const binding = runtimePinRef.current ?? useAppStore.getState().projectBinding;
      const local = binding?.kind !== "remote";
      showToast(renderFiledToast(filed, { paneChatSessionId: sessionId, local }));
      setRenderOpen(false);
      return filed;
    } catch (cause) {
      onErrorRef.current?.(cause);
      throw cause;
    } finally {
      setRendering(false);
    }
  }, [deviceName, duoCapable, laneId, runtimePinRef, sessionId]);

  /*
   * `ade apple render`: the service asks every window with the project open.
   * A live pane acks at once, so it always beats the off-screen render host
   * (`AppleRenderHost`), which waits before it claims. Bring up the 3D view if
   * the flat one is on, render, and report what was filed.
   */
  const runRenderRef = useRef(runRender);
  runRenderRef.current = runRender;
  const renderStateRef = useRef({ laneId, live, stalled });
  renderStateRef.current = { laneId, live, stalled };
  const reconnectStreamRef = useRef(reconnect);
  reconnectStreamRef.current = reconnect;
  useEffect(() => {
    return window.ade.iosSimulator.onEvent((event) => {
      if (event.type !== "apple.render.request") return;
      const current = renderStateRef.current;
      if (!current.live || (event.laneId && current.laneId && event.laneId !== current.laneId)) return;
      const pin = runtimePinRef.current;
      void (async () => {
        const ack = await window.ade.iosSimulator.renderAck({ requestId: event.requestId }, pin).catch((cause: unknown) => {
          logRendererDebugEvent("apple.render_ack_failed", { error: cause instanceof Error ? cause.message : String(cause) });
          return null;
        });
        // Another window's pane took it first.
        if (!ack?.ok) return;
        setModeRef.current("3d");
        if (renderStateRef.current.stalled) {
          reconnectStreamRef.current();
          const liveBy = Date.now() + 10_000;
          while (renderStateRef.current.stalled && Date.now() < liveBy) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        const deadline = Date.now() + 10_000;
        while (!rendererRef.current && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await completeAppleRenderRequest({
          requestId: event.requestId,
          pin,
          render: () => runRenderRef.current(event.request),
          // A lost answer leaves `ade apple render` waiting out its 4 minutes:
          // say so here, where the person can see it.
          onLostAnswer: (cause) => onErrorRef.current?.(cause),
        });
      })();
    }, runtimePinRef.current);
  }, [pinKey, runtimePinRef]);

  return { rendererRef, renderOpen, setRenderOpen, rendering, openRender, runRender };
}
