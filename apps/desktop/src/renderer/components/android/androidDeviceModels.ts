import type { DeviceModelSource } from "../device/deviceModelLoader";
import type { DeviceScreenModelSource } from "../device/deviceScene";

/*
 * The bundled Android GLBs (`assets/android-device-models/<model>.glb`). A
 * catalog entry names its model by file name; a model that is not bundled
 * falls back to the procedural body, so a model is an easy removal (plan §7).
 *
 * Each GLB follows the shared contract: portrait, front +Z, the screen mesh
 * named `device-screen` with a height of 2.2, and the colour materials named
 * `device-body` and `device-frame`. The sources and licences are in
 * `assets/android-device-models/sources.json`.
 */

const MODEL_URLS = import.meta.glob<string>("../../assets/android-device-models/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
});

export type AndroidDeviceModelSource = DeviceModelSource & DeviceScreenModelSource;

export function androidDeviceModelSource(model: string): AndroidDeviceModelSource | null {
  const url = MODEL_URLS[`../../assets/android-device-models/${model}.glb`];
  return url ? { id: `android:${model}`, url, screenNodeNames: ["device-screen"] } : null;
}
