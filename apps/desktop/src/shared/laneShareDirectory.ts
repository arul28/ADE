import type { LANE_SHARE_MAX_GUESTS_PER_LANE, LaneShareRisk } from "../../../account-directory/src/laneShares/contract";
import { encodeCodedErrorMessage } from "./codedError";

/**
 * What every ADE client reads from the account directory's lane share
 * routes, in one place: the id and ticket shapes, the error mapping, and the
 * parse helpers for a grant record. The host (`laneShareHostService.ts`),
 * the guest (`laneShareGuestDirectory.ts`), the move service and the links
 * all use these.
 *
 * The Worker's own copies are in `account-directory/src/laneShares/contract.ts`.
 * The renderer cannot import the Worker's files (Vite's `fs.allow`), so the
 * values are declared again here; the types come from the contract, and the
 * guest limit is tied to the contract's by its type.
 */

/** A grant id: `ls_` and 32 hex characters. */
export const LANE_SHARE_GRANT_ID_PATTERN = /^ls_[0-9a-f]{32}$/;
/** A ticket and an RFC 7638 thumbprint: 43 base64url characters. */
export const LANE_SHARE_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Most guests (pending and active) one lane may have. The type fails the build when the contract's value changes. */
export const LANE_SHARE_MAX_GUESTS: typeof LANE_SHARE_MAX_GUESTS_PER_LANE = 5;

/** The directory has no lane share routes (an older deploy): nothing about one share. */
export const LANE_SHARING_UNAVAILABLE = "lane_sharing_unavailable";
export const LANE_SHARING_UNAVAILABLE_MESSAGE = "Lane sharing is not available yet.";

/** One grant, or one action on it: `/lane-shares/<id>[/<action>]`. */
const ONE_GRANT_PATH = new RegExp(`^/lane-shares/${LANE_SHARE_GRANT_ID_PATTERN.source.slice(1, -1)}(?:/[a-z]+)?$`);

/**
 * Whether a directory 404 means "no such share for this account". Only for
 * one grant, and only with the directory's own `not_found` code
 * (`laneShares/routes.ts`). A list route's 404, or a 404 with no code (a
 * directory without the lane share routes answers plain text), means the
 * directory has no lane sharing.
 */
function laneShareDirectoryNotFound(path: string, body: unknown): boolean {
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown } }).error : null;
  return ONE_GRANT_PATH.test(path) && error?.code === "not_found";
}

type LaneShareDirectoryProblem = {
  /** The code a client acts on and shows (`laneShareModel.ts`, `laneShareGuestStore.ts`). */
  code: string;
  message: string;
  /** The directory's own code, when it gave one. */
  directoryCode: string | null;
};

/** A directory answer outside 2xx, as a code and a sentence. */
export function laneShareDirectoryProblem(status: number, body: unknown, path: string): LaneShareDirectoryProblem {
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown; message?: unknown } }).error : null;
  const directoryCode = typeof error?.code === "string" ? error.code.slice(0, 64) : null;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 300)
    : `The account directory answered ${status}.`;
  const problem = (code: string, text = message): LaneShareDirectoryProblem => ({ code, message: text, directoryCode });
  if (status === 401) return problem("signed_out", "Sign in to your ADE account.");
  if (status === 404) {
    return laneShareDirectoryNotFound(path, body)
      ? problem("not_found")
      : problem(LANE_SHARING_UNAVAILABLE, LANE_SHARING_UNAVAILABLE_MESSAGE);
  }
  if (status === 410) return problem(directoryCode === "invite_expired" ? "invite_expired" : "share_closed");
  if (status === 429) return problem("rate_limited");
  if (status >= 500) return problem("unavailable");
  return problem(directoryCode && /^[a-z_]+$/.test(directoryCode) ? directoryCode : "directory_refused");
}

/** A directory error as a coded Error (`code: message`), so IPC keeps the code. */
export function laneShareDirectoryError(status: number, body: unknown, path: string): Error {
  const problem = laneShareDirectoryProblem(status, body, path);
  return new Error(encodeCodedErrorMessage(problem.code, problem.message));
}

const RISK_LEVELS = new Set<string>(["low", "medium", "high"] satisfies LaneShareRisk[]);

export const directoryString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
export const directoryNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const directoryRisk = (value: unknown): LaneShareRisk | null =>
  typeof value === "string" && RISK_LEVELS.has(value) ? value as LaneShareRisk : null;

/** A grant record with a valid id; every other field is still untrusted. */
export function isLaneShareGrantRecord(value: unknown): value is Record<string, unknown> & { id: string } {
  return Boolean(value) && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string" && LANE_SHARE_GRANT_ID_PATTERN.test((value as { id: string }).id);
}
