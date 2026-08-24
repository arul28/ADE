import type {
  IosSimulatorWindowIssue,
  IosSimulatorWindowSource,
} from "./iosSimulator";

/**
 * Live-view capture of the real Simulator window depends on two macOS privacy
 * grants that the app cannot see through `simctl`: Screen Recording (or
 * `desktopCapturer` hands back black thumbnails) and Automation/System Events
 * (or every window query and park silently no-ops). Both used to surface as
 * `issue: "unknown"` with a null message, so the drawer showed a blank live
 * view and named no blocker.
 *
 * These types widen the base window state with the permission truth. They live
 * beside `iosSimulator.ts` rather than in it so the capture contract can move
 * without touching the service's own type surface; fold them in when
 * convenient.
 */

export type IosSimulatorPrivacyPane = "screen-recording" | "automation";

export type IosSimulatorWindowIssueEx =
  | IosSimulatorWindowIssue
  | "screen-recording-permission"
  | "automation-denied";

export type IosSimulatorPermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export type IosSimulatorWindowPermissionHint = {
  kind: IosSimulatorPrivacyPane;
  status: IosSimulatorPermissionStatus;
  /**
   * True only when macOS will still show a prompt. Screen Recording is never
   * requestable from JS (the grant is Settings-only), while an undecided
   * Automation grant prompts on the first Apple event.
   */
  canRequest: boolean;
  settingsPane: IosSimulatorPrivacyPane;
};

export type IosSimulatorWindowStateEx = {
  appRunning: boolean;
  visible: boolean | null;
  windowCount: number | null;
  minimizedWindowCount: number | null;
  capturable: boolean | null;
  issue: IosSimulatorWindowIssueEx | null;
  message: string | null;
  permission: IosSimulatorWindowPermissionHint | null;
};

/**
 * The window-parking path runs in Electron main, whose own iOS simulator
 * service never sees a launch that the brain daemon owns — its `activeSession`
 * is always null. Callers that already hold the runtime session pass it here so
 * parking keys off the session that actually exists.
 */
export type IosSimulatorWindowCaptureSessionHint = {
  deviceUdid: string;
  deviceName: string | null;
};

export type IosSimulatorWindowSourcesResult = {
  sources: IosSimulatorWindowSource[];
  windowState: IosSimulatorWindowStateEx | null;
  /** Short, actionable blocker text. Null when `sources` is non-empty. */
  message: string | null;
};
