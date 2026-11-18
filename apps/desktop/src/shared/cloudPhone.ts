/**
 * The ADE Cloud iPhone's shared names: the actions of the `cloud_phone`
 * domain (`cloudPhoneService`), and the device id `ios@cloud` agents and the
 * tools pane pick it with. See docs/features/apple-device/ade-cloud-iphone.md.
 */

/** What an agent may call on a cloud iPhone; `getStatus().capabilities` reports it. */
export const CLOUD_PHONE_AGENT_ACTIONS = [
  "getStatus",
  "start",
  "stop",
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

/** A view link drives the phone from a window: the person's, never an agent's. */
export const CLOUD_PHONE_USER_ONLY_ACTIONS = ["view"] as const;

/** Each model's screen in points (input and `look` coordinates), for the 3D body and taps. */
export const CLOUD_PHONE_POINT_SIZE: Readonly<Record<string, { width: number; height: number }>> = {
  iphone: { width: 402, height: 874 },
  "iphone-pro-max": { width: 440, height: 956 },
  ipad: { width: 834, height: 1210 },
};

/** The simulator device type each model is, for the 3D body's model map. */
export const CLOUD_PHONE_DEVICE_TYPE_NAME: Readonly<Record<string, string>> = {
  iphone: "iPhone 17 Pro",
  "iphone-pro-max": "iPhone 17 Pro Max",
  ipad: "iPad Pro 11-inch (M5)",
};

/** `cloud_phone.getStatus` as the tools pane reads it (`cloudPhoneService`). */
export type CloudPhoneStatusView = {
  access: "on" | "soon" | "off";
  minutes: { included: number; used: number; left: number } | null;
  phone: {
    id: string;
    state: "starting" | "ready" | "ended";
    device: string;
    readyAt: number | null;
    queueUntil: number | null;
    endReason: string | null;
    stopNotice: string | null;
  } | null;
  capabilities: readonly string[];
  supported: boolean;
  reason: string | null;
};

/** `cloud_phone.view`: a link that shows the live phone, for this account only. */
export type CloudPhoneViewLink = { url: string; expiresAt: number; control: boolean };
