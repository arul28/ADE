/**
 * Which way up a device screen is, for the shared device views.
 *
 * The same four values as `AppleDeviceOrientation`, so an Apple orientation
 * passes as one. An Android device in landscape is `landscape-right` (turned
 * a quarter to the left).
 */
export type DeviceOrientation = "portrait" | "portrait-upside-down" | "landscape-left" | "landscape-right";
