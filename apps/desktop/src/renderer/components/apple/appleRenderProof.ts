import { APPLE_RENDER_ANGLE_IDS, type AppleDevicePose, type AppleRenderRequestSpec, type OpenProjectBinding } from "../../../shared/types";
import type { DeviceRenderer } from "../device/deviceRenderPass";
import {
  DEVICE_RENDER_SIZE,
  deviceRenderAngles,
  fileDeviceRenders,
  renderDeviceStills,
  type DeviceRenderImage,
} from "../device/deviceRenderProof";

/**
 * 3D renders of a lane's device filed as proof, shared by the pane (its
 * Render sheet, and `ade apple render` while a pane is live) and the
 * off-screen render host (`AppleRenderHost`). No React here: both callers
 * hold their own state.
 */

export const APPLE_RENDER_ANGLES = deviceRenderAngles(APPLE_RENDER_ANGLE_IDS);

/** One `ade apple render` a render host took: who asked, and where to answer. */
export type AppleRenderJob = {
  requestId: string;
  laneId: string;
  chatSessionId: string | null;
  request: AppleRenderRequestSpec;
  /** The machine that asked, held for the whole job: every call goes there. */
  pin: OpenProjectBinding;
};

/** What one render filed: the count, the artifacts, the chat whose drawer has them, and the files. */
export type AppleRenderFiled = {
  filed: number;
  artifactIds: string[];
  /** Null when only the lane owns them (no chat drove or claimed the device). */
  chatSessionId: string | null;
  filePaths: string[];
};

/**
 * Render the lane's device and file every image (and the video) to the proof
 * drawer. For a Duo each pose folds the REAL simulator first and waits for it
 * to settle, so every shot shows the panel and layout that pose really has.
 *
 * Shared by the pane (the Render sheet, and `ade apple render` while a pane is
 * live) and the off-screen render host. Every call goes to `runtimePinRef`'s
 * machine, the one that owns the device.
 */
export async function renderAppleDeviceToProof({
  request,
  rendererRef,
  laneId,
  chatSessionId,
  deviceName,
  duoCapable,
  runtimePinRef,
}: {
  request: AppleRenderRequestSpec;
  /** Read on every use: the 3D view can swap its renderer mid-render. */
  rendererRef: { current: DeviceRenderer | null };
  laneId: string | null;
  chatSessionId: string | null;
  deviceName: string | null;
  duoCapable: boolean;
  runtimePinRef: { current: OpenProjectBinding };
}): Promise<AppleRenderFiled> {
  if (!rendererRef.current) throw new Error("The 3D view is still loading.");
  const options = {
    width: DEVICE_RENDER_SIZE,
    height: DEVICE_RENDER_SIZE,
    lighting: request.lighting,
    shadow: request.shadow,
  };
  const images: DeviceRenderImage[] = [];
  // Poses fold the real simulator; a device without a hinge has one pose.
  const passes: Array<AppleDevicePose | null> = duoCapable && request.poses.length ? request.poses : [null];
  for (const pose of passes) {
    if (pose) {
      // `setPosture` answers once the simulator has landed on the pose's
      // panel. Then iOS animates its interface into the new layout, and
      // the 3D body eases into the pose: give both time before the shot.
      await window.ade.iosSimulator.setPosture({ laneId, chatSessionId, pose }, runtimePinRef.current);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    const prefix = pose ? pose[0]!.toUpperCase() + pose.slice(1) : null;
    images.push(...renderDeviceStills(rendererRef.current, APPLE_RENDER_ANGLES, request.angles, options, prefix));
  }
  // Filed by the device's own machine, to the chat and lane there: this
  // window may be another machine pinned to it.
  const outcome: AppleRenderFiled = { filed: 0, artifactIds: [], chatSessionId: null, filePaths: [] };
  outcome.filed = await fileDeviceRenders({
    images,
    contactSheet: request.contactSheet,
    video: request.video,
    rendererRef,
    options,
    deviceName: deviceName ?? "device",
    attach: async (dataUrl, title) => {
      const result = await window.ade.iosSimulator.attachRenderProof(
        { laneId, chatSessionId, dataUrl, title },
        runtimePinRef.current,
      );
      if (result.filePath) outcome.filePaths.push(result.filePath);
      if (!result.proofArtifactId) return false;
      outcome.artifactIds.push(result.proofArtifactId);
      outcome.chatSessionId ??= result.chatSessionId ?? null;
      return true;
    },
  });
  return outcome;
}

/**
 * Run an acked `ade apple render` and tell the service how it went, on the
 * machine that asked (`pin`). A failed render is reported as its message, so
 * the CLI prints the reason instead of waiting out its 4 minutes.
 */
export async function completeAppleRenderRequest({
  requestId,
  pin,
  render,
  onLostAnswer,
}: {
  requestId: string;
  pin: OpenProjectBinding;
  render: () => Promise<AppleRenderFiled>;
  onLostAnswer?: (cause: unknown) => void;
}): Promise<void> {
  let filed = 0;
  let proofArtifactIds: string[] = [];
  let error: string | null = null;
  try {
    ({ filed, artifactIds: proofArtifactIds } = await render());
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  // This render's own proofs, so `ade apple render` cites exactly them.
  await window.ade.iosSimulator.renderComplete({ requestId, filed, error, proofArtifactIds }, pin)
    .catch((cause: unknown) => onLostAnswer?.(cause));
}
