// The body and screen math moved to the shared device layer
// (`components/device/deviceScene.ts`) when Android's 3D view first used it
// (plan §4). This module keeps the Apple names and the Apple model ids.
import type { AppleDeviceModelId } from "./appleDeviceModels";

export {
  canvasHasDecoded as appleCanvasHasDecoded,
  createImportedBody,
  deviceInputSize as appleDeviceInputSize,
  displayLayout,
  disposeImportedSubtree,
  importThreeRuntime,
  orientedPointSize,
  orientedToPortrait,
  portraitToOriented,
  portraitUvToTextureUv,
  writeScreenUvs,
  type DeviceBody,
  type DisplayLayout,
  type DuoBodyControls,
  type GltfLoaderCtor,
  type ThreeNS,
} from "../device/deviceScene";

/** A body that is not a bundled GLB — today only the procedural Duo. */
export type AppleDeviceBodyModelId = AppleDeviceModelId | "duo-procedural" | "duo-v68";
