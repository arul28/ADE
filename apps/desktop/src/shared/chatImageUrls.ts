/**
 * URL predicates for the image events every client renders, owned once so the
 * main process, the desktop renderer, and the `ade code` TUI cannot drift on
 * what "this is a data URI" means.
 *
 * A data URI is renderable inline everywhere (the desktop CSP allows `data:`
 * under `img-src` and the hosted web client's `_headers` does too). A remote
 * URL is openable but NOT previewable — both CSPs pin image sources to an
 * explicit host allowlist — so preview code must ask for `isDataUri`, not
 * `isRemoteOrDataUri`.
 */
export function isDataUri(value: string | null | undefined): boolean {
  return typeof value === "string" && /^data:/i.test(value);
}

export function isRemoteOrDataUri(value: string | null | undefined): boolean {
  return typeof value === "string" && /^(?:https?:|data:)/i.test(value);
}
