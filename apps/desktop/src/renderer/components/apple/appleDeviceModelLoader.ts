// The model loader moved to the shared device layer
// (`components/device/deviceModelLoader.ts`) when Android's 3D view first used
// it (plan §4). These are its Apple names; the cache is the one module's.
export {
  __testClearDeviceModelCache as __testClearAppleModelCache,
  createDeviceModelLoader,
  loadDeviceModelInstance as loadAppleDeviceModelInstance,
} from "../device/deviceModelLoader";
