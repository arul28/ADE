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
} as const;

export type SystemSettingsPaneId = keyof typeof SYSTEM_SETTINGS_PANE_URLS;

export type AppOpenSystemSettingsPaneArgs = { paneId: SystemSettingsPaneId };

export type AppOpenSystemSettingsPaneResult = { opened: boolean };

export function isSystemSettingsPaneId(value: unknown): value is SystemSettingsPaneId {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(SYSTEM_SETTINGS_PANE_URLS, value);
}
