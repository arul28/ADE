/**
 * `GET /client/minimum`: the oldest ADE build each kind of install may still
 * run. Path and response shape only: nothing here imports the Worker, so the
 * desktop, ADE Web and the brain can import it (the phone reads the same keys).
 *
 * Public: no bearer, so a signed-out app and a stale web tab read it too. The
 * owner sets it with `scripts/release-tools/client-minimum.mjs`; no release
 * moves it. Every value is null until the owner sets one, and null means "no
 * minimum": nothing is blocked.
 *
 * A client blocks itself only when it is below its minimum AND an update that
 * meets the minimum is published where it updates from (the desktop's track
 * feed, the App Store, TestFlight). A minimum ahead of what is published, or a
 * read that fails, never blocks anyone.
 */
export const CLIENT_MINIMUM_PATH = "/client/minimum";

/** Where an iPhone build was installed from; each has its own minimum. */
export type IosInstallSource = "appStore" | "testFlight" | "betaApp";

export type ClientMinimumResponse = {
  /**
   * Desktop app, its brain and the `ade` CLI, per update track: a version
   * such as "1.2.131" (stable) or "1.2.131-beta.2" (beta). Alpha and
   * development builds have no minimum.
   */
  desktop: { stable: string | null; beta: string | null };
  /**
   * iPhone. The App Store install compares its marketing version (what the
   * store shows); a TestFlight install of the ADE app (`com.ade.ios`) and the
   * ADE Beta app (`com.ade.ios.beta`) compare their build number.
   */
  ios: {
    appStore: { version: string } | null;
    testFlight: { build: number } | null;
    betaApp: { build: number } | null;
  };
  /** Where each kind of install gets the update. Always present. */
  links: {
    /** The desktop download page (every platform). */
    download: string;
    /** The ADE app on the App Store. */
    appStore: string;
    /** The ADE app's TestFlight public link. */
    testFlight: string;
    /** The ADE Beta app's TestFlight public link. */
    betaAppTestFlight: string;
  };
  /** When the owner last set it; null when never set. */
  updatedAt: string | null;
};

export const CLIENT_MINIMUM_LINKS: ClientMinimumResponse["links"] = {
  download: "https://ade-app.dev/download",
  appStore: "https://apps.apple.com/app/id6762759870",
  testFlight: "https://testflight.apple.com/join/ZSdJGKPy",
  betaAppTestFlight: "https://testflight.apple.com/join/SsxDjqbF",
};

/**
 * `POST /account/delete`: the signed-in person deletes their own ADE account.
 * Takes the account bearer and `{ "confirm": "delete" }`. Clerk deletes the
 * user, and its `user.deleted` webhook removes everything ADE holds for it
 * (computers, plan, saved chats, vault, project list), the same path as a
 * deletion from Clerk's dashboard. The app signs out after a 200.
 */
export const ACCOUNT_DELETE_PATH = "/account/delete";

export type AccountDeleteResponse = { deleted: true };
