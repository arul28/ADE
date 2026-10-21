/**
 * A file under `public/`, addressed so it loads both from the packaged app's
 * `file://` shell (relative) and from a dev or hosted server (root-relative).
 */
export function publicAssetUrl(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
    return `/${normalized}`;
  }
  return `./${normalized}`;
}
