/**
 * Which way up a device screen is, for the shared device views.
 *
 * The same four values as `AppleDeviceOrientation`, so an Apple orientation
 * passes as one. Android P0 is always "portrait".
 */
export type DeviceOrientation = "portrait" | "portrait-upside-down" | "landscape-left" | "landscape-right";
