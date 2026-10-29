import { basenameCrossPlatform } from "./pathDisplay";

/**
 * URL predicates for the image events every client renders, owned once so the
 * main process and the desktop renderer cannot drift on
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

/** A `file://` URL as the OS path it names; anything else as it is. */
function fileUrlToLocalPath(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  const raw = value.replace(/^file:\/\//i, "");
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep the raw path
  }
  // `file:///C:/x.png` names a Windows path; drop the slash before the drive.
  return decoded.replace(/^\/([a-z]:[\\/])/i, "$1");
}

const ABSOLUTE_PATH = /^(?:\/|[a-z]:[\\/])/i;

/**
 * The file an image view opened, as an OS path on the chat's machine, or null
 * when it names none (a data URI, a remote URL). Codex sends a path or a
 * `file://` URL. OpenCode views stored before the path was recorded carry the
 * absolute path they read only as their title.
 */
export function imageViewLocalPath(view: { path?: string | null; url?: string | null; title?: string | null }): string | null {
  const path = view.path?.trim();
  if (path) return fileUrlToLocalPath(path);
  const url = view.url?.trim();
  if (url && /^file:\/\//i.test(url)) return fileUrlToLocalPath(url);
  const title = view.title?.trim();
  return title && ABSOLUTE_PATH.test(title) ? title : null;
}

/** The name a view goes by: a file name, never a whole path or a data URI. */
export function imageViewName(view: { path?: string | null; url?: string | null; title?: string | null }): string {
  const title = view.title?.trim();
  if (title && !isDataUri(title)) return ABSOLUTE_PATH.test(title) ? basenameCrossPlatform(title) || "image" : title;
  const path = imageViewLocalPath(view);
  if (path) return basenameCrossPlatform(path) || "image";
  const url = view.url?.trim();
  if (!url || isDataUri(url)) return "image";
  try {
    const parsed = new URL(url);
    return basenameCrossPlatform(parsed.pathname) || parsed.hostname || "image";
  } catch {
    return "image";
  }
}

/**
 * Whether a view has a picture this window can show: a file on the chat's
 * machine, or its own inline bytes. A remote URL does not count: the CSP pins
 * `img-src` to an allowlist, so it would paint an empty box.
 */
export function imageViewHasPicture(view: { path?: string | null; url?: string | null; title?: string | null }): boolean {
  return imageViewLocalPath(view) !== null || isDataUri(view.url);
}
