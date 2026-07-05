// Shared DTOs for the mobile push pipeline: phone → brain (sync commands) and
// brain → Cloudflare push relay. The phone never talks to the relay directly;
// it hands tokens/preferences to the brain over the paired sync WebSocket.

export type PushApsEnvironment = "sandbox" | "production";

/** Quiet hours are stored per device and honored brain-side before publishing. */
export type PushQuietHours = {
  /** "HH:MM" 24h local-to-timezone start (inclusive). */
  start: string;
  /** "HH:MM" 24h end (exclusive). A window may span midnight. */
  end: string;
  /** IANA timezone the window is evaluated in, e.g. "America/New_York". */
  timezone: string;
};

export type PushNotificationPrefs = {
  /** Master switch for alert pushes to this device. */
  enabled: boolean;
  /** Live Activity updates may stay on even when alert pushes are muted. */
  liveActivitiesEnabled?: boolean;
  /** Session ids the user muted; awaiting/failed alerts for them are skipped. */
  mutedSessionIds?: string[];
  quietHours?: PushQuietHours | null;
};

/** `push.registerDevice` command payload (phone → brain). */
export type PushDeviceRegistration = {
  deviceId: string;
  /** APNs alert-push token (hex). Absent while only Live Activities are used. */
  apnsToken?: string | null;
  /** ActivityKit push-to-start token (hex). */
  pushToStartToken?: string | null;
  bundleId: string;
  apsEnvironment: PushApsEnvironment;
  platform?: string | null;
  deviceName?: string | null;
  prefs?: PushNotificationPrefs | null;
};

/** `push.reportLiveActivityToken` command payload (phone → brain). */
export type PushLiveActivityTokenReport = {
  deviceId: string;
  activityId: string;
  /** Hex per-activity update token; empty/null removes the registration. */
  token?: string | null;
};

/** `push.getStatus` result (brain → phone) — feeds the Push Delivery panel. */
export type PushDeliveryStatus = {
  /** Whether push publishing is enabled on this machine at all. */
  publisherEnabled: boolean;
  relayUrl: string | null;
  /** Whether the relay reports its APNs signing key configured. */
  relayApnsConfigured: boolean | null;
  /** Whether this device has a registration on the brain. */
  deviceRegistered: boolean;
  registeredDeviceCount: number;
  lastPublishAt: string | null;
  lastPublishError: string | null;
  lastRelayContactAt: string | null;
};

export const PUSH_REGISTER_DEVICE_ACTION = "push.registerDevice";
export const PUSH_UNREGISTER_DEVICE_ACTION = "push.unregisterDevice";
export const PUSH_SET_PREFS_ACTION = "push.setPrefs";
export const PUSH_REPORT_LIVE_ACTIVITY_TOKEN_ACTION = "push.reportLiveActivityToken";
export const PUSH_GET_STATUS_ACTION = "push.getStatus";
