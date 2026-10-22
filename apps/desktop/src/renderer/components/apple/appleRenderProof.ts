import type { AppleDevicePose, AppleRenderRequestSpec, OpenProjectBinding } from "../../../shared/types";
import type { AppleDeviceRenderer } from "./AppleDevice3DView";
import { APPLE_RENDER_ANGLES, appleRenderContactSheet } from "./AppleRenderSheet";

/**
 * 3D renders of a lane's device filed as proof, shared by the pane (its
 * Render sheet, and `ade apple render` while a pane is live) and the
 * off-screen render host (`AppleRenderHost`). No React here: both callers
 * hold their own state.
 */

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
  rendererRef: { current: AppleDeviceRenderer | null };
  laneId: string | null;
  chatSessionId: string | null;
  deviceName: string | null;
  duoCapable: boolean;
  runtimePinRef: { current: OpenProjectBinding | null };
}): Promise<AppleRenderFiled> {
  if (!rendererRef.current) throw new Error("The 3D view is still loading.");
  const options = {
    width: 1600,
    height: 1600,
    lighting: request.lighting,
    shadow: request.shadow,
  };
  const shots = APPLE_RENDER_ANGLES.filter((angle) => request.angles.includes(angle.id));
  const images: Array<{ dataUrl: string; label: string }> = [];
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
    const rendered = rendererRef.current?.renderShots(shots.map((angle) => angle.shot), options) ?? [];
    rendered.forEach((dataUrl, index) => images.push({
      dataUrl,
      label: [pose ? pose[0]!.toUpperCase() + pose.slice(1) : null, shots[index]!.label].filter(Boolean).join(" · "),
    }));
  }
  const name = deviceName ?? "device";
  // Filed by the device's own machine, to the chat and lane there: this
  // window may be another machine pinned to it.
  const outcome: AppleRenderFiled = { filed: 0, artifactIds: [], chatSessionId: null, filePaths: [] };
  const attachRenderProof = async (proof: { dataUrl: string; title: string }) => {
    const result = await window.ade.iosSimulator.attachRenderProof(
      { laneId, chatSessionId, ...proof },
      runtimePinRef.current,
    );
    if (result.filePath) outcome.filePaths.push(result.filePath);
    if (!result.proofArtifactId) return false;
    outcome.artifactIds.push(result.proofArtifactId);
    outcome.chatSessionId ??= result.chatSessionId ?? null;
    return true;
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
  outcome.filed = filed;
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
  pin: OpenProjectBinding | null;
  render: () => Promise<number>;
  onLostAnswer?: (cause: unknown) => void;
}): Promise<void> {
  let filed = 0;
  let error: string | null = null;
  try {
    filed = await render();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  await window.ade.iosSimulator.renderComplete({ requestId, filed, error }, pin)
    .catch((cause: unknown) => onLostAnswer?.(cause));
}
