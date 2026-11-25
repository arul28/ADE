/**
 * ADE's public legal pages, and the version of the privacy policy the apps
 * last told people about.
 *
 * `PRIVACY_POLICY_VERSION` is the policy's "Last updated" date
 * (`apps/web/src/app/pages/PrivacyPage.tsx`). Change both together: a new
 * version shows the one-time "We updated our Privacy Policy" notice again on
 * every desktop and web install. The iPhone app keeps its own copy
 * (`PrivacyPolicyNotice.version`, `apps/ios/ADE/App/ContentView.swift`).
 */
export const TERMS_URL = "https://ade-app.dev/terms";
export const PRIVACY_URL = "https://ade-app.dev/privacy";
/** The policy's dated list of changes. */
export const PRIVACY_CHANGES_URL = `${PRIVACY_URL}#changes`;
export const PRIVACY_POLICY_VERSION = "2026-11-25";
