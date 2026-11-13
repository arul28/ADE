/**
 * The tab preload's message after the person sends a login form by hand
 * (`preload/browserMedia.ts`). It carries the values to desktop main only;
 * main decides from the tab's own URL whether to offer "Save to Passwords?".
 */
export const BUILT_IN_BROWSER_LOGIN_SUBMITTED_CHANNEL = "ade:built-in-browser:login-submitted" as const;

export type BuiltInBrowserLoginSubmission = {
  username: string | null;
  /** Null for the username-only first step of a two-step sign-in. */
  password: string | null;
};

/** What the renderer is told: never the password. */
export type BuiltInBrowserSaveLoginOffer = {
  offerId: string;
  tabId: string;
  site: string;
  username: string | null;
  /** An existing saved login for this site and username has a different password. */
  updatesItemId: string | null;
};
