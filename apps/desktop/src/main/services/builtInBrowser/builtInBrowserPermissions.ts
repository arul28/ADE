import { isRecord } from "../shared/utils";

const GOOGLE_AUTH_PERMISSION_CHECK_ALLOWLIST = new Set([
  "hid",
  "serial",
  "storage-access",
  "top-level-storage-access",
  "usb",
]);
const GOOGLE_AUTH_PERMISSION_REQUEST_ALLOWLIST = new Set([
  "storage-access",
  "top-level-storage-access",
]);

export function shouldAllowGoogleAuthPermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: Electron.PermissionCheckHandlerHandlerDetails,
): boolean {
  if (!GOOGLE_AUTH_PERMISSION_CHECK_ALLOWLIST.has(permission)) return false;
  return (
    isGoogleAccountsSurface(requestingOrigin)
    || isGoogleAccountsSurface(details.requestingUrl)
    || isGoogleAccountsSurface(details.embeddingOrigin)
    || isGoogleAccountsSurface(details.securityOrigin)
  );
}

export function shouldAllowGoogleAuthPermissionRequest(permission: string, details: unknown): boolean {
  if (!GOOGLE_AUTH_PERMISSION_REQUEST_ALLOWLIST.has(permission)) return false;
  if (!isRecord(details)) return false;
  return (
    isGoogleAccountsSurface(details.requestingUrl)
    || isGoogleAccountsSurface(details.requestingOrigin)
  );
}

function isGoogleAccountsSurface(value: unknown): boolean {
  const text = stringOrNull(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && (
      parsed.hostname === "accounts.google.com"
      || parsed.hostname.endsWith(".accounts.google.com")
    );
  } catch {
    return false;
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
