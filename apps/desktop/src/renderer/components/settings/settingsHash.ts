/**
 * A `location.hash` as the manifest wants it: no leading `#`, percent-decoding
 * applied, and a malformed escape treated as literal text rather than thrown.
 *
 * Three call sites decoded the hash themselves — provider deeplinks, tab
 * resolution, and the scroll effect — which meant three chances for one of them
 * to forget the try/catch and take the settings page down on a URL a user can
 * type by hand.
 */
/**
 * Places inside Settings › ADE Cloud a link opens directly: the dashboard
 * opens the Plan and billing row, or its Free up space flow. Each starts with
 * `cloud-`, so the hash alone opens the ADE Cloud page.
 */
export const ADE_CLOUD_PLAN_ANCHOR = "cloud-plan";
export const ADE_CLOUD_FREE_SPACE_ANCHOR = "cloud-free-space";

export function adeCloudSettingsRoute(anchor: typeof ADE_CLOUD_PLAN_ANCHOR | typeof ADE_CLOUD_FREE_SPACE_ANCHOR): string {
  return `/settings?tab=integrations#${anchor}`;
}

export function decodeSettingsHash(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
