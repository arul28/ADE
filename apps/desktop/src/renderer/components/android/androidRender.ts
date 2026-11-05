import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidRenderAngleId, AndroidRenderRequestSpec } from "../../../shared/types/androidEmulator";
import type { DeviceRenderer, DeviceRenderShot } from "../device/Device3DView";
import { deviceRenderContactSheet } from "../device/deviceRenderContactSheet";

/**
 * 3D renders of the lane's Android device, filed as proof (`ade android
 * render` and the Render sheet). No React here.
 *
 * The images are drawn here and posted to the device's machine
 * (`attachRenderProof`), which writes them and files them. For a CLI request
 * the machine knows the asking chat by the request id, so this window never
 * names the chat a proof goes to.
 */

export const ANDROID_RENDER_ANGLES: ReadonlyArray<{ id: AndroidRenderAngleId; label: string; shot: DeviceRenderShot }> = [
  { id: "front", label: "Front", shot: { yaw: 0, pitch: 0.04 } },
  { id: "three-quarter-left", label: "¾ left", shot: { yaw: -0.62, pitch: 0.14 } },
  { id: "three-quarter-right", label: "¾ right", shot: { yaw: 0.62, pitch: 0.14 } },
  { id: "back", label: "Back", shot: { yaw: Math.PI, pitch: 0.06 } },
  { id: "current", label: "This angle", shot: { current: true } },
];

export type AndroidRenderFiled = {
  filed: number;
  artifactIds: string[];
  filePaths: string[];
};

async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:video\/webm;[^,]*,/u, "data:video/webm;base64,"));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

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
  const options = { width: 1600, height: 1600, lighting: request.background, shadow: request.shadow };
  const shots = ANDROID_RENDER_ANGLES.filter((angle) => request.angles.includes(angle.id));
  const rendered = rendererRef.current.renderShots(shots.map((angle) => angle.shot), options);
  const images = rendered.map((dataUrl, index) => ({ dataUrl, label: shots[index]!.label }));
  const outcome: AndroidRenderFiled = { filed: 0, artifactIds: [], filePaths: [] };
  const attach = async (dataUrl: string, title: string) => {
    const result = await api.attachRenderProof({ laneId, requestId, dataUrl, title }, pin);
    outcome.filePaths.push(result.path);
    outcome.filed += 1;
    if (result.proofArtifactId) outcome.artifactIds.push(result.proofArtifactId);
  };
  for (const image of images) await attach(image.dataUrl, `${deviceName} · ${image.label}`);
  if (request.contactSheet && images.length > 1) {
    const sheet = await deviceRenderContactSheet(images);
    if (sheet) await attach(sheet, `${deviceName} · contact sheet`);
  }
  if (request.video) {
    const blob = await rendererRef.current?.renderTurntable({ ...options, width: 1280, height: 1280, seconds: 6 });
    if (blob) await attach(await blobDataUrl(blob), `${deviceName} · turntable`);
  }
  return outcome;
}
