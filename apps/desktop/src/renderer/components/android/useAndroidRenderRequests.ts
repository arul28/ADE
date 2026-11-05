import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidRenderRequestEvent, AndroidRenderRequestSpec } from "../../../shared/types/androidEmulator";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { logRendererDebugEvent } from "../../lib/debugLog";
import type { DeviceRenderer } from "../device/deviceRenderPass";
import { renderAndroidDeviceToProof, type AndroidRenderFiled } from "./androidRender";

/** Wait for a condition the pane flips (the 3D body landing). */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return check();
}

/**
 * 3D renders of the lane's Android device: the Render sheet, and `ade
 * android render` while this pane shows the lane's live device. The pane
 * passes `handleRequest` the `android.render.request` events from its own
 * event subscription; the first window to ack draws.
 */
export function useAndroidRenderRequests({
  laneId,
  deviceName,
  runtimePinRef,
  live,
  threeD,
  setThreeD,
  onError,
}: {
  laneId: string;
  deviceName: string;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** The device draws: a render can be taken. */
  live: boolean;
  /** The 3D view is the one showing (renders come from the 3D body). */
  threeD: boolean;
  setThreeD: () => void;
  onError: (cause: unknown) => void;
}) {
  const rendererRef = useRef<DeviceRenderer | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  /** One render at a time: a second one is refused before it touches `rendering`. */
  const busyRef = useRef(false);
  const stateRef = useRef({ laneId, deviceName, live, threeD });
  stateRef.current = { laneId, deviceName, live, threeD };
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const setThreeDRef = useRef(setThreeD);
  setThreeDRef.current = setThreeD;

  const openRender = useCallback(() => {
    if (!stateRef.current.threeD) setThreeDRef.current();
    setRenderOpen(true);
  }, []);

  const run = useCallback(async (request: AndroidRenderRequestSpec, requestId: string | null): Promise<AndroidRenderFiled> => {
    if (busyRef.current) throw new Error("Another render of this device is still running. Try again when it ends.");
    busyRef.current = true;
    setRendering(true);
    try {
      if (!(await waitFor(() => rendererRef.current !== null, 10_000))) throw new Error("The 3D view is still loading.");
      return await renderAndroidDeviceToProof({
        request,
        requestId,
        rendererRef,
        laneId: stateRef.current.laneId,
        deviceName: stateRef.current.deviceName,
        pin: runtimePinRef.current,
      });
    } finally {
      busyRef.current = false;
      setRendering(false);
    }
  }, [runtimePinRef]);

  /** The Render sheet's render: filed to the lane's proof. */
  const runRender = useCallback(async (request: AndroidRenderRequestSpec) => {
    try {
      const filed = await run(request, null);
      setRenderOpen(false);
      showToast({
        id: "android-render",
        tone: "success",
        title: `Rendered ${filed.filed} item${filed.filed === 1 ? "" : "s"}`,
        message: "Filed to this lane's proof (History).",
        durationMs: READABLE_TOAST_DURATION_MS,
      });
    } catch (cause) {
      onErrorRef.current(cause);
    }
  }, [run]);

  /** `ade android render`: ack, bring up 3D, draw, report. */
  const handleRequest = useCallback((event: AndroidRenderRequestEvent) => {
    const current = stateRef.current;
    if (!current.live || event.laneId !== current.laneId) return;
    const api = window.ade?.androidEmulator;
    if (!api) return;
    const pin = runtimePinRef.current;
    void (async () => {
      const ack = await api.renderAck({ requestId: event.requestId }, pin).catch((cause: unknown) => {
        logRendererDebugEvent("android.render_ack_failed", { error: cause instanceof Error ? cause.message : String(cause) });
        return null;
      });
      // Another window took it first.
      if (!ack?.ok) return;
      if (!stateRef.current.threeD) setThreeDRef.current();
      let error: string | null = null;
      try {
        await run(event.request, event.requestId);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // A lost answer leaves `ade android render` waiting: say so here.
      await api.renderComplete({ requestId: event.requestId, error }, pin).catch((cause: unknown) => onErrorRef.current(cause));
    })();
  }, [run, runtimePinRef]);

  return { rendererRef, renderOpen, setRenderOpen, rendering, openRender, runRender, handleRequest };
}
