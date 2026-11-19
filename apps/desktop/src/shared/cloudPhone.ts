/**
 * The ADE Cloud iPhone's shared names: the actions of the `cloud_phone`
 * domain (`cloudPhoneService`), the models and their screens, and the shapes
 * the tools pane reads. See docs/features/apple-device/ade-cloud-iphone.md.
 */

import {
  CLOUD_PHONE_DEVICES,
  isCloudPhoneDevice,
  type CloudPhoneDevice,
  type CloudPhoneState,
  type CloudPhoneView,
} from "../../../account-directory/src/cloud/contract";

/** `CloudPhoneView` is `cloud_phone.view`: a link that shows the live phone, for this account only. */
export { CLOUD_PHONE_DEVICES, isCloudPhoneDevice, type CloudPhoneDevice, type CloudPhoneView };

/**
 * The actions that run the phone, so spend the plan's minutes: each starts the
 * phone when it isn't running. The RPC server stamps who is asking on them and
 * the phone holds unattended agents to the agent limits (`cloudPhoneAgentGuard`).
 */
export const CLOUD_PHONE_SPEND_ACTIONS = [
  "start",
  "look",
  "act",
  "screenshot",
  "launch",
  "installApp",
  "control",
  "logs",
  "record",
  "runTests",
] as const;

/** What an agent may call on a cloud iPhone; `getStatus().capabilities` reports it. */
export const CLOUD_PHONE_AGENT_ACTIONS = ["getStatus", "stop", ...CLOUD_PHONE_SPEND_ACTIONS] as const;

/**
 * A view link drives the phone from a window, and `keepAlive` is the pane's
 * "still here" (one cheap call that resets NoMac's idle clock, never a start):
 * the person's, never an agent's.
 */
export const CLOUD_PHONE_USER_ONLY_ACTIONS = ["view", "keepAlive"] as const;

/** A phone with no tool call or person's input for this long stops (NoMac counts watching as idle). */
export const CLOUD_PHONE_IDLE_SECONDS = 300;
/** The longest one phone runs; a new one starts after (its workspace stays). */
export const CLOUD_PHONE_MAX_MINUTES = 120;

/** Each model: its screen in points (input and `look` coordinates), its simulator name, its label. */
export const CLOUD_PHONE_MODELS: Readonly<Record<CloudPhoneDevice, { points: { width: number; height: number }; deviceTypeName: string; label: string }>> = {
  iphone: { points: { width: 402, height: 874 }, deviceTypeName: "iPhone 17 Pro", label: "iPhone 17 Pro" },
  "iphone-pro-max": { points: { width: 440, height: 956 }, deviceTypeName: "iPhone 17 Pro Max", label: "iPhone 17 Pro Max" },
  ipad: { points: { width: 834, height: 1210 }, deviceTypeName: "iPad Pro 11-inch (M5)", label: "iPad Pro 11-inch" },
};

/** A phone's device as NoMac names it, or the iPhone for one this build doesn't know. */
export function cloudPhoneDeviceOf(value: unknown): CloudPhoneDevice {
  return isCloudPhoneDevice(value) ? value : "iphone";
}

/**
 * How long one phone call may take, end to end, so the caller never gives up
 * while the brain still works: a build may wait 6 minutes for a free phone,
 * upload and unpack for up to 10, then build for up to 15 (the service's own
 * limits). The CLI and the RPC timeout table read these.
 */
export const CLOUD_PHONE_BUILD_TIMEOUT_MS = 32 * 60_000;
/** Any other phone call, which may first wait up to 6 minutes for a free phone. */
export const CLOUD_PHONE_CALL_TIMEOUT_MS = 7 * 60_000;

/** `cloud_phone.getStatus` as the tools pane reads it (`cloudPhoneService`). */
export type CloudPhoneStatusView = CloudPhoneState & {
  /** Every action an agent may call on this device. */
  capabilities: readonly string[];
  supported: boolean;
  /** One line for a person or agent when it can't be used. */
  reason: string | null;
  /**
   * When this brain last sent the live phone a tool call (ms), which resets
   * NoMac's idle clock; null when it sent none to this phone (another
   * machine's brain may have). The idle stop is due `CLOUD_PHONE_IDLE_SECONDS` after.
   */
  lastActivityAt?: number | null;
};
