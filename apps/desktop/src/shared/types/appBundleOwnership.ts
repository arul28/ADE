/**
 * Whether THIS computer's installed ADE.app can be updated without an
 * administrator password.
 *
 * On macOS the updater (Squirrel.Mac) installs as root, behind a password
 * prompt, whenever the running app bundle is not writable by the signed-in
 * user. That happens after one install done with admin rights: every file
 * ends up owned by root, the privileged install writes a root-owned copy
 * again, and every later update asks for the password. ADE detects it and
 * offers to give the bundle back to the user.
 *
 * Windows installs per user (under LocalAppData) and never hits this, so the
 * status there is `not_applicable`.
 */

export type AppBundleOwnershipState =
  /** The bundle is writable by this user; updates install without a password. */
  | "ok"
  /** Some of the bundle is not writable by this user (usually owned by root). */
  | "needs_fix"
  /** Not a packaged macOS app, or it runs from a read-only place. */
  | "not_applicable"
  /** The check itself failed (the bundle could not be read). */
  | "unknown";

export type AppBundleOwnershipStatus = {
  state: AppBundleOwnershipState;
  /** Plain-language reason for `not_applicable` / `unknown`; null otherwise. */
  reason: string | null;
  /** Absolute path of the running `.app`, when there is one. */
  bundlePath: string | null;
  /** Paths inside the bundle (relative, `.` for the bundle itself) this user cannot write. */
  problemPaths: string[];
  /** Account that owns the bundle folder ("root"), when it is not this user. */
  ownerName: string | null;
  /**
   * Whether this user can write to the folder that holds ADE.app. When false
   * the updater still needs a password even after the bundle is fixed, and
   * the fix cannot change that.
   */
  parentWritable: boolean | null;
  /** The Terminal command that fixes it by hand. Null when there is nothing to fix. */
  manualCommand: string | null;
  /** ADE version this status was read for; a new version re-raises a dismissed banner. */
  appVersion: string | null;
  checkedAt: string;
};

export type AppBundleOwnershipFixOutcome =
  /** The bundle is writable by this user now. */
  | "fixed"
  /** The command ran but the bundle is still not writable. */
  | "still_root_owned"
  /** The user closed the macOS password prompt. */
  | "cancelled"
  /** macOS refused, or the command failed. */
  | "failed"
  /** Nothing to fix here (not macOS, dev build, already fine). */
  | "not_applicable";

export type AppBundleOwnershipFixResult = {
  outcome: AppBundleOwnershipFixOutcome;
  /** One sentence for the user. */
  message: string;
  /** The status read again after the fix ran. */
  status: AppBundleOwnershipStatus;
};

/** `window.ade.appBundleOwnership`. Absent on the web client. */
export type AppBundleOwnershipBridge = {
  /** Cached after the first read; `refresh: true` reads the bundle again. */
  getStatus: (args?: { refresh?: boolean }) => Promise<AppBundleOwnershipStatus>;
  /** Asks for the administrator password once and gives the bundle back to this user. */
  fix: () => Promise<AppBundleOwnershipFixResult>;
};
