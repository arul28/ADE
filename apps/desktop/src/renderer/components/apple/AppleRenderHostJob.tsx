import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { appleDuoInTent } from "../../../shared/appleOrientation";
import type { AppleDeviceRenderer } from "./AppleDevice3DView";
import { AppleDeviceStage } from "./AppleDeviceStage";
import { appleDeviceSupportsDuo, createAppleDuoState, reduceAppleDuoState } from "./appleDuo";
import { laneDeviceBooted } from "./appleDeviceState";
import { isAppleDeviceOffError } from "./appleErrors";
import { useAppleDeviceStream } from "./useAppleDeviceStream";
import { appleDuoDisplayOrientation, useAppleDuoPosture } from "./useAppleDuoPosture";
import { useAppleDuoModel } from "./useAppleDuoModel";
import { completeAppleRenderRequest, renderAppleDeviceToProof, type AppleRenderFiled, type AppleRenderJob } from "./appleRenderProof";

/**
 * One `ade apple render` taken by `AppleRenderHost`: the lane's device, its
 * stream and a 3D view of it, mounted off screen for as long as the render
 * takes. Rendering is the pane's own `renderAppleDeviceToProof`; every call
 * goes to `job.pin`, the machine that asked.
 */

/** The device's picture and 3D body have this long to come up. */
const APPLE_RENDER_HOST_READY_TIMEOUT_MS = 45_000;
/** How long a Duo waits for Apple's model before rendering the drawn body. */
const APPLE_RENDER_HOST_DUO_MODEL_WAIT_MS = 8_000;

type AppleRenderJobDevice = {
  udid: string;
  name: string;
  family: "iphone" | "ipad";
  deviceTypeIdentifier: string | null;
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export default function AppleRenderHostJob({
  job,
  onAnswering,
  onDone,
}: {
  job: AppleRenderJob;
  /** The job is answering the service now; nobody else should. */
  onAnswering: (requestId: string) => void;
  /** The answer is sent: unmount the job. */
  onDone: (requestId: string) => void;
}) {
  const pinRef = useRef<OpenProjectBinding | null>(job.pin);
  const rendererRef = useRef<AppleDeviceRenderer | null>(null);
  const [device, setDevice] = useState<AppleRenderJobDevice | null>(null);
  const [bodyReady, setBodyReady] = useState(false);
  const [duoModelWaitOver, setDuoModelWaitOver] = useState(false);
  const [duoState, setDuoState] = useState(() => createAppleDuoState());
  const finishedRef = useRef(false);
  const streamErrorRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onAnswering, onDone });
  callbacksRef.current = { onAnswering, onDone };

  /** Render (or fail) once, report to the machine that asked, then unmount. */
  const finish = useCallback((render: () => Promise<AppleRenderFiled>) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    callbacksRef.current.onAnswering(job.requestId);
    void completeAppleRenderRequest({
      requestId: job.requestId,
      pin: job.pin,
      render,
      onLostAnswer: (cause) => logRendererDebugEvent("apple.render_host_complete_failed", { error: messageOf(cause) }),
    }).finally(() => callbacksRef.current.onDone(job.requestId));
  }, [job]);
  const fail = useCallback((message: string) => {
    finish(() => Promise.reject(new Error(message)));
  }, [finish]);

  // The lane's device, from its own machine. A render never boots one.
  useEffect(() => {
    let cancelled = false;
    void window.ade.iosSimulator
      .deviceList({ laneId: job.laneId, chatSessionId: job.chatSessionId, installed: true }, pinRef.current)
      .then((listed) => {
        if (cancelled) return;
        const lane = listed.lane;
        if (!lane) {
          fail("This lane has no Apple device. Start one with \"ade apple start\", then render again.");
          return;
        }
        if (!laneDeviceBooted(listed)) {
          fail(`${lane.name} is off. Start it with "ade apple start", then render again.`);
          return;
        }
        setDevice({
          udid: lane.udid,
          name: lane.name,
          family: lane.family === "ipad" ? "ipad" : "iphone",
          deviceTypeIdentifier: listed.installed.find((entry) => entry.udid === lane.udid)?.deviceTypeIdentifier ?? null,
        });
      }, (cause: unknown) => {
        if (!cancelled) fail(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [fail, job.chatSessionId, job.laneId]);

  // Remembered, not shown: the ready timeout says it if nothing ever drew.
  const onStreamError = useCallback((message: string | null) => {
    if (message) streamErrorRef.current = message;
  }, []);
  const stream = useAppleDeviceStream({
    deviceUdid: device?.udid ?? null,
    laneId: job.laneId,
    chatSessionId: job.chatSessionId,
    enabled: device !== null,
    hidden: false,
    machineName: null,
    bitrateKbpsCap: null,
    runtimePinRef: pinRef,
    onError: onStreamError,
  });
  const hasFrames = stream.frameVersion > 0;

  // The pane's Duo wiring: the simulator's posture drives the drawn hinge, so
  // each pose the render folds to shows on the body too.
  const duoCapable = appleDeviceSupportsDuo({ deviceTypeIdentifier: device?.deviceTypeIdentifier ?? null });
  const { posture } = useAppleDuoPosture({
    enabled: duoCapable && hasFrames,
    deviceUdid: device?.udid ?? null,
    laneId: job.laneId,
    chatSessionId: job.chatSessionId,
    runtimePinRef: pinRef,
    pinKey: job.pin.key,
    onAngle: (angle) => setDuoState((current) => (Math.abs(current.pose.angle - angle) < 1
      ? current
      : reduceAppleDuoState(current, { type: "angle", angle }))),
  });
  const duoModel = useAppleDuoModel({ enabled: duoCapable, pinKey: job.pin.key, runtimePinRef: pinRef });
  useEffect(() => {
    if (!duoCapable) return undefined;
    const timer = window.setTimeout(() => setDuoModelWaitOver(true), APPLE_RENDER_HOST_DUO_MODEL_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [duoCapable]);

  // A stream that failed to start, or a 3D view that cannot draw, ends the job
  // now with the reason; anything slower is the ready timeout's.
  useEffect(() => {
    if (finishedRef.current || hasFrames || stream.state !== "error") return;
    const message = stream.error ?? streamErrorRef.current ?? "The device's live view did not start.";
    fail(isAppleDeviceOffError(message) ? `${device?.name ?? "The device"} is off. Start it with "ade apple start", then render again.` : message);
  }, [device?.name, fail, hasFrames, stream.error, stream.state]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      fail(streamErrorRef.current ?? "The device's picture did not come up within 45 seconds.");
    }, APPLE_RENDER_HOST_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [fail]);

  const duoSettled = !duoCapable || ((duoModel !== null || duoModelWaitOver) && (posture !== null || duoModelWaitOver));
  const ready = device !== null && bodyReady && hasFrames && duoSettled;
  useEffect(() => {
    if (!ready || !device) return;
    finish(() => renderAppleDeviceToProof({
      request: job.request,
      rendererRef,
      laneId: job.laneId,
      chatSessionId: job.chatSessionId,
      deviceName: device.name,
      duoCapable,
      runtimePinRef: pinRef,
    }));
  }, [device, duoCapable, finish, job, ready]);

  if (!device) return null;
  return (
    <AppleDeviceStage
      className="h-full w-full"
      streamUrl={stream.url}
      streamToken={stream.token}
      reconnectNonce={stream.reconnectNonce}
      mode="3d"
      viewNonce={0}
      family={device.family}
      deviceTypeName={device.name}
      deviceTypeIdentifier={device.deviceTypeIdentifier}
      orientation={appleDuoDisplayOrientation("portrait", posture)}
      devicePointSize={stream.devicePointSize}
      interactive={false}
      duo={duoCapable
        ? {
            enabled: true,
            angle: duoState.pose.angle,
            model: duoModel,
            activeScreenId: posture?.activeScreenId ?? null,
            physicalOrientation: posture?.orientation ?? null,
            tableMode: appleDuoInTent(posture),
          }
        : undefined}
      rendererRef={rendererRef}
      onDeviceInput={noop}
      onReaderStatus={stream.handleReaderStatus}
      onDimensions={stream.handleDimensions}
      onFrame={stream.noteFrame}
      frameVersion={stream.frameVersion}
      onThreeReady={() => setBodyReady(true)}
      onThreeUnavailable={fail}
    />
  );
}

function noop() {}
