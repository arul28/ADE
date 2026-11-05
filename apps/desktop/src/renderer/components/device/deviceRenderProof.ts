import type { DeviceRenderOptions, DeviceRenderShot, DeviceRenderer } from "./deviceRenderPass";
import { deviceRenderContactSheet } from "./deviceRenderContactSheet";

/**
 * The render-to-proof steps every device shares (Apple and Android): the
 * camera angles, the stills, the contact sheet and the turntable video. No
 * React here. Each platform takes the stills its own way (a Duo folds the
 * simulator between passes) and files each one through its own `attach`.
 */

export type DeviceRenderAngleId = "front" | "three-quarter-left" | "three-quarter-right" | "back" | "current";

const ANGLES: Record<DeviceRenderAngleId, { label: string; shot: DeviceRenderShot }> = {
  front: { label: "Front", shot: { yaw: 0, pitch: 0.04 } },
  "three-quarter-left": { label: "¾ left", shot: { yaw: -0.62, pitch: 0.14 } },
  "three-quarter-right": { label: "¾ right", shot: { yaw: 0.62, pitch: 0.14 } },
  back: { label: "Back", shot: { yaw: Math.PI, pitch: 0.06 } },
  current: { label: "This angle", shot: { current: true } },
};

export type DeviceRenderAngle<A extends DeviceRenderAngleId> = { id: A; label: string; shot: DeviceRenderShot };

/** The angles one device offers, in the order of its angle ids. */
export function deviceRenderAngles<A extends DeviceRenderAngleId>(ids: readonly A[]): ReadonlyArray<DeviceRenderAngle<A>> {
  return ids.map((id) => ({ id, ...ANGLES[id] }));
}

/** Stills are square 1600 px; the turntable is 1280 px. */
export const DEVICE_RENDER_SIZE = 1600;

export type DeviceRenderImage = { dataUrl: string; label: string };

/** Render the requested angles once, each labelled `<prefix> · <angle>`. */
export function renderDeviceStills<A extends DeviceRenderAngleId>(
  renderer: DeviceRenderer | null,
  angles: ReadonlyArray<DeviceRenderAngle<A>>,
  requested: readonly A[],
  options: DeviceRenderOptions,
  labelPrefix: string | null = null,
): DeviceRenderImage[] {
  const shots = angles.filter((angle) => requested.includes(angle.id));
  const rendered = renderer?.renderShots(shots.map((angle) => angle.shot), options) ?? [];
  return rendered.map((dataUrl, index) => ({
    dataUrl,
    label: [labelPrefix, shots[index]!.label].filter(Boolean).join(" · "),
  }));
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:video\/webm;[^,]*,/u, "data:video/webm;base64,"));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * File the stills, then the contact sheet (two stills or more) and the
 * turntable video when asked. `attach` files one image on the device's
 * machine and resolves true when it counts as filed. Resolves the count.
 */
export async function fileDeviceRenders({
  images,
  contactSheet,
  video,
  rendererRef,
  options,
  deviceName,
  attach,
}: {
  images: DeviceRenderImage[];
  contactSheet: boolean;
  video: boolean;
  /** Read on every use: the 3D view can swap its renderer mid-render. */
  rendererRef: { current: DeviceRenderer | null };
  options: DeviceRenderOptions;
  deviceName: string;
  attach: (dataUrl: string, title: string) => Promise<boolean>;
}): Promise<number> {
  let filed = 0;
  for (const image of images) {
    if (await attach(image.dataUrl, `${deviceName} · ${image.label}`)) filed++;
  }
  if (contactSheet && images.length > 1) {
    const sheet = await deviceRenderContactSheet(images);
    if (sheet && await attach(sheet, `${deviceName} · contact sheet`)) filed++;
  }
  if (video) {
    const blob = await rendererRef.current?.renderTurntable({ ...options, width: 1280, height: 1280, seconds: 6 });
    if (blob && await attach(await blobDataUrl(blob), `${deviceName} · turntable`)) filed++;
  }
  return filed;
}
