import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AppleDevicePose, AppleRenderRequestSpec, OpenProjectBinding } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import { logRendererDebugEvent } from "../../lib/debugLog";
import type { AppleDeviceRenderer } from "./AppleDevice3DView";
import { APPLE_RENDER_ANGLES, appleRenderContactSheet } from "./AppleRenderSheet";

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

  /**
   * Render the device: for a Duo each pose folds the REAL simulator first and
   * waits for it to settle, so every shot shows the panel and layout that
   * pose really has. Every image (and the video) is filed to the proof drawer.
   */
  const runRender = useCallback(async (request: AppleRenderRequestSpec): Promise<number> => {
    const renderer = rendererRef.current;
    if (!renderer) {
      showToast({ id: "apple-render", tone: "warning", title: "The 3D view is still loading. Try again in a moment." });
      throw new Error("The 3D view is still loading.");
    }
    setRendering(true);
    const options = {
      width: 1600,
      height: 1600,
      lighting: request.lighting,
      shadow: request.shadow,
    };
    const shots = APPLE_RENDER_ANGLES.filter((angle) => request.angles.includes(angle.id));
    const images: Array<{ dataUrl: string; label: string }> = [];
    try {
      // Poses fold the real simulator; a device without a hinge has one pose.
      const passes: Array<AppleDevicePose | null> = duoCapable && request.poses.length ? request.poses : [null];
      for (const pose of passes) {
        if (pose) {
          // `setPosture` answers once the simulator has landed on the pose's
          // panel. Then iOS animates its interface into the new layout, and
          // the 3D body eases into the pose: give both time before the shot.
          await window.ade.iosSimulator.setPosture({ laneId, chatSessionId: sessionId, pose }, runtimePinRef.current);
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        }
        const rendered = rendererRef.current?.renderShots(shots.map((angle) => angle.shot), options) ?? [];
        rendered.forEach((dataUrl, index) => images.push({
          dataUrl,
          label: [pose ? pose[0]!.toUpperCase() + pose.slice(1) : null, shots[index]!.label].filter(Boolean).join(" · "),
        }));
      }
      const name = deviceName ?? "device";
      // Filed by the device's own machine, to the chat and lane there: this
      // window may be another machine pinned to it.
      const attachRenderProof = async (proof: { dataUrl: string; title: string }) => {
        const result = await window.ade.iosSimulator.attachRenderProof(
          { laneId, chatSessionId: sessionId, ...proof },
          runtimePinRef.current,
        );
        return Boolean(result.proofArtifactId);
      };
      let filed = 0;
      for (const image of images) {
        if (await attachRenderProof({ dataUrl: image.dataUrl, title: `${name} · ${image.label}` })) filed++;
      }
      if (request.contactSheet && images.length > 1) {
        const sheet = await appleRenderContactSheet(images);
        if (sheet && await attachRenderProof({ dataUrl: sheet, title: `${name} · contact sheet` })) filed++;
      }
      if (request.video) {
        const blob = await rendererRef.current?.renderTurntable({ ...options, width: 1280, height: 1280, seconds: 6 });
        if (blob) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).replace(/^data:video\/webm;[^,]*,/, "data:video/webm;base64,"));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          if (await attachRenderProof({ dataUrl, title: `${name} · turntable` })) filed++;
        }
      }
      showToast({ id: "apple-render", tone: "success", title: `Rendered ${filed} item${filed === 1 ? "" : "s"} to the proof drawer` });
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
   * `ade apple render`: the service asks the pane open for this lane. Ack at
   * once (so the CLI knows a pane took it), bring up the 3D view if the flat
   * one is on, render, and report what was filed.
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
        let filed = 0;
        let error: string | null = null;
        try {
          filed = await runRenderRef.current(event.request);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        // A lost answer leaves `ade apple render` waiting out its 4 minutes:
        // say so here, where the person can see it.
        await window.ade.iosSimulator.renderComplete({ requestId: event.requestId, filed, error }, pin)
          .catch((cause: unknown) => onErrorRef.current?.(cause));
      })();
    }, runtimePinRef.current);
  }, [pinKey, runtimePinRef]);

  return { rendererRef, renderOpen, setRenderOpen, rendering, openRender, runRender };
}
