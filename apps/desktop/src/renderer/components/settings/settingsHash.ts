/**
 * A `location.hash` as the manifest wants it: no leading `#`, percent-decoding
 * applied, and a malformed escape treated as literal text rather than thrown.
 *
 * Three call sites decoded the hash themselves — provider deeplinks, tab
 * resolution, and the scroll effect — which meant three chances for one of them
 * to forget the try/catch and take the settings page down on a URL a user can
 * type by hand.
 */
export function decodeSettingsHash(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
