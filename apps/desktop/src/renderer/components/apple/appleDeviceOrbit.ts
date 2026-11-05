// The orbit moved to the shared device layer (`components/device/deviceOrbit.ts`)
// when Android's 3D view first used it (plan §4). These are its Apple names.
export {
  DEVICE_ORBIT as APPLE_DEVICE_ORBIT,
  createDeviceOrbit as createAppleDeviceOrbit,
  deviceEaseFactor as appleEaseFactor,
  nearestScreenFacingRotation,
  quatRotationVector,
  type DeviceOrbit as AppleDeviceOrbit,
} from "../device/deviceOrbit";
