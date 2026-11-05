import type { OpenProjectBinding } from "../../../shared/types";
import { ANDROID_RENDER_ANGLE_IDS, type AndroidRenderRequestSpec } from "../../../shared/types/androidEmulator";
import type { DeviceRenderer } from "../device/deviceRenderPass";
import { DEVICE_RENDER_SIZE, deviceRenderAngles, fileDeviceRenders, renderDeviceStills } from "../device/deviceRenderProof";

/**
 * 3D renders of the lane's Android device, filed as proof (`ade android
 * render` and the Render sheet). No React here.
 *
 * The images are drawn here and posted to the device's machine
 * (`attachRenderProof`), which writes them and files them. For a CLI request
 * the machine knows the asking chat by the request id, so this window never
 * names the chat a proof goes to.
 */

export const ANDROID_RENDER_ANGLES = deviceRenderAngles(ANDROID_RENDER_ANGLE_IDS);

export type AndroidRenderFiled = {
  filed: number;
  artifactIds: string[];
  filePaths: string[];
};

export async function renderAndroidDeviceToProof({
  request,
  requestId,
  rendererRef,
  laneId,
  deviceName,
  pin,
}: {
  request: AndroidRenderRequestSpec;
  /** The CLI request this answers; null for the Render sheet. */
  requestId: string | null;
  /** Read on every use: the 3D view can swap its renderer mid-render. */
  rendererRef: { current: DeviceRenderer | null };
  laneId: string;
  deviceName: string;
  pin: OpenProjectBinding | null;
}): Promise<AndroidRenderFiled> {
  const api = window.ade?.androidEmulator;
  if (!api) throw new Error("Android Development is not available here.");
  if (!rendererRef.current) throw new Error("The 3D view is still loading.");
  const options = { width: DEVICE_RENDER_SIZE, height: DEVICE_RENDER_SIZE, lighting: request.background, shadow: request.shadow };
  const images = renderDeviceStills(rendererRef.current, ANDROID_RENDER_ANGLES, request.angles, options);
  const outcome: AndroidRenderFiled = { filed: 0, artifactIds: [], filePaths: [] };
  outcome.filed = await fileDeviceRenders({
    images,
    contactSheet: request.contactSheet ?? false,
    video: request.video,
    rendererRef,
    options,
    deviceName,
    attach: async (dataUrl, title) => {
      const result = await api.attachRenderProof({ laneId, requestId, dataUrl, title }, pin);
      outcome.filePaths.push(result.path);
      if (result.proofArtifactId) outcome.artifactIds.push(result.proofArtifactId);
      // The file is written on the device's machine either way.
      return true;
    },
  });
  return outcome;
}
