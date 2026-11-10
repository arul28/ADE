import { accountRepoScopeKey } from "./accountSettingsScope";

/**
 * The shared project record: a repository's display name and icon, the same
 * on every machine of one account.
 *
 * It is not a store of its own. The facts are rows in the account settings
 * store, filed under the repository's scope (`repo:<host>/<path>`, from
 * `accountRepoScopeKey`), so they reach every machine of the account on the
 * store's heartbeat with last-writer-wins per key. A project with no usable
 * origin has no scope and keeps its name and icon on this machine only.
 *
 * Pure: the renderer, the desktop main process and the brain all decode the
 * same values with these helpers, so they cannot disagree about what a value
 * means.
 */

export const PROJECT_RECORD_ICON_KEY = "project.icon";
export const PROJECT_RECORD_NAME_KEY = "project.name";

/**
 * The largest stored icon value, as JSON. The store takes 16,000; the margin
 * keeps a value safe from any later wrapping of the row.
 */
export const PROJECT_RECORD_ICON_MAX_VALUE_BYTES = 12_000;

/** The longest shared name, in characters (code points, so emoji stay whole). */
const PROJECT_RECORD_NAME_MAX_CHARS = 256;

const RECORD_VERSION = 1;

const ICON_DATA_URL_RE =
  /^data:(image\/(?:png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon));base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * What the record says about a project's icon:
 * - `absent`: no machine ever set it. A machine that has its own custom icon
 *   uploads it once (the migration of a project from before the record).
 * - `custom`: every machine shows this image.
 * - `none`: someone removed the custom icon. Every machine shows the icon it
 *   detects in the project files and drops its own override.
 * - `invalid`: a value this version cannot read (damaged, too large, or from
 *   a newer ADE). It is never overwritten from a read, so two versions cannot
 *   keep rewriting each other; the machine shows its local icon.
 */
type ProjectRecordIcon =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "none" }
  | { state: "custom"; dataUrl: string; mimeType: string };

export type ProjectRecordIconValue =
  | { v: typeof RECORD_VERSION; dataUrl: string }
  | { v: typeof RECORD_VERSION; none: true };

export const PROJECT_RECORD_NO_ICON: ProjectRecordIconValue = Object.freeze({ v: RECORD_VERSION, none: true as const });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The account-store scope of a project, or null when it has no usable origin. Pass the canonical origin. */
export function projectRecordScope(gitOriginUrl: string | null | undefined): string | null {
  return accountRepoScopeKey(gitOriginUrl);
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(json).length;
}

export function decodeProjectRecordIcon(raw: unknown): ProjectRecordIcon {
  if (raw === undefined || raw === null) return { state: "absent" };
  if (!isRecord(raw) || raw.v !== RECORD_VERSION) return { state: "invalid" };
  if (raw.none === true) return { state: "none" };
  const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl : "";
  const match = ICON_DATA_URL_RE.exec(dataUrl);
  if (!match?.[1] || dataUrl.length > PROJECT_RECORD_ICON_MAX_VALUE_BYTES * 2) return { state: "invalid" };
  return { state: "custom", dataUrl, mimeType: match[1] };
}

/** The value to store for a custom icon, or null when it is not an image data URL or would be over the limit. */
export function projectRecordIconValue(dataUrl: string): ProjectRecordIconValue | null {
  if (!ICON_DATA_URL_RE.test(dataUrl)) return null;
  const value: ProjectRecordIconValue = { v: RECORD_VERSION, dataUrl };
  return jsonBytes(value) < PROJECT_RECORD_ICON_MAX_VALUE_BYTES ? value : null;
}

/** Trims and limits a display name; null when nothing is left. */
function normalizeProjectRecordName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!trimmed) return null;
  const chars = Array.from(trimmed);
  return chars.length > PROJECT_RECORD_NAME_MAX_CHARS
    ? chars.slice(0, PROJECT_RECORD_NAME_MAX_CHARS).join("").trimEnd()
    : trimmed;
}

/** The shared name, or null when the record holds none (or one this version cannot read). */
export function decodeProjectRecordName(raw: unknown): string | null {
  if (!isRecord(raw) || raw.v !== RECORD_VERSION) return null;
  return normalizeProjectRecordName(raw.name);
}

/**
 * A record write this machine could not send (signed out, brain down, write
 * refused) is kept as pending, so the user's latest choice is neither lost nor
 * beaten by an older value from another machine. It lives in the local
 * stand-in file under this scope, one entry per repository scope and key.
 */
export function projectRecordPendingScope(scope: string): string {
  return `pending:${scope}`;
}

/**
 * Whether a pending value is still worth sending: an icon must be a valid
 * custom or "no icon" value under the size limit, a name a valid name. Any
 * other value is dropped, so a pending write cannot retry forever.
 */
export function isSendableProjectRecordValue(key: string, value: unknown): boolean {
  if (key === PROJECT_RECORD_ICON_KEY) {
    const icon = decodeProjectRecordIcon(value);
    if (icon.state === "none") return true;
    return icon.state === "custom" && projectRecordIconValue(icon.dataUrl) !== null;
  }
  if (key === PROJECT_RECORD_NAME_KEY) return decodeProjectRecordName(value) !== null;
  return false;
}

/** Whether two record values are the same value (they are small plain JSON). */
export function sameProjectRecordValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * How one attempt to send a record value went:
 * - `accepted`: the account store took it.
 * - `refused`: the store answered no.
 * - `unreachable`: no store answered (no brain, a brain with no store, a timeout).
 */
export type ProjectRecordSendAnswer = "accepted" | "refused" | "unreachable";

/**
 * What a host does with this machine's latest choice after one send:
 * - `stored`: done; a pending entry for the key is cleared.
 * - `keep_pending`: the store was not reachable, or it said no because no one
 *   is signed in. The choice stays pending and goes on the next read or write.
 * - `refused`: a signed-in store said no. The entry is cleared and logged, so
 *   it cannot retry forever.
 */
export type ProjectRecordSendOutcome = "stored" | "keep_pending" | "refused";

export function projectRecordSendOutcome(answer: ProjectRecordSendAnswer, signedIn: () => boolean): ProjectRecordSendOutcome {
  if (answer === "accepted") return "stored";
  if (answer === "unreachable") return "keep_pending";
  return signedIn() ? "refused" : "keep_pending";
}
