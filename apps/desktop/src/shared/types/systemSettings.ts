/**
 * OS settings panes ADE is allowed to deep-link into.
 *
 * The renderer never holds one of these URLs. `x-apple.systempreferences:` is
 * deliberately outside `ALLOWED_EXTERNAL_URL_SCHEMES` (http/https/mailto), so
 * handing a settings URL to `app.openExternal` always throws — which is exactly
 * how the login-import "Open System Settings" button became a dead control.
 * Instead the renderer names a pane by id and the main process resolves it
 * against this table before calling `shell.openExternal`. Adding a pane is a
 * deliberate edit here, not a widening of the URL allowlist.
 */
export const SYSTEM_SETTINGS_PANE_URLS = {
  /** macOS Privacy & Security › Full Disk Access. */
  "macos-full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
  /** macOS Privacy & Security › Screen & System Audio Recording. */
  "macos-screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  /** macOS Privacy & Security › Accessibility. */
  "macos-accessibility":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  /** macOS Privacy & Security › Microphone. */
  "macos-microphone":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  /** Windows Settings › Privacy › Microphone. */
  "windows-microphone": "ms-settings:privacy-microphone",
  /**
   * macOS Sound › Input.
   *
   * A different pane from Microphone on purpose: permission and hardware are
   * different problems, and a machine with no built-in microphone needs the one
   * that lists inputs, not the one that lists apps.
   *
   * `?input` is a real anchor, not a guess: the Sound settings extension
   * declares `allowsXAppleSystemPreferencesURLScheme` and reads a
   * `DeepLinkAnchorKey` whose values are `input`, `output` and `effects`.
   */
  "macos-sound-input": "x-apple.systempreferences:com.apple.Sound-Settings.extension?input",
  /** Windows Settings › System › Sound. */
  "windows-sound": "ms-settings:sound",
} as const;

export type SystemSettingsPaneId = keyof typeof SYSTEM_SETTINGS_PANE_URLS;

export type AppOpenSystemSettingsPaneArgs = { paneId: SystemSettingsPaneId };

export type AppOpenSystemSettingsPaneResult = { opened: boolean };

export function isSystemSettingsPaneId(value: unknown): value is SystemSettingsPaneId {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(SYSTEM_SETTINGS_PANE_URLS, value);
}
