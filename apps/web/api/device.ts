/**
 * Vercel serverless function behind /device — the sign-in link that
 * `ade connect` prints and draws as a QR code:
 *
 *   https://ade-app.dev/device?user_code=ABCD-EFGH
 *
 * On a phone with ADE Mobile a link that carries a code never reaches this
 * function: it is a universal link (`public/.well-known/apple-app-site-association`),
 * so the app opens on its Approve screen. Every other visitor is a browser, and
 * gets a 302 to the account directory's own confirmation page, which is where
 * the sign-in happens. Without a code that page asks for one.
 *
 * Only a well-formed code is forwarded, so this is not an open redirect: the
 * destination host is fixed and the one parameter is eight characters from a
 * fixed alphabet.
 *
 * Deliberately analytics-free, like the other functions here (docs/logging.md).
 */

import {
  FALLBACK_CACHE_CONTROL,
  pickQuery,
  rejectDisallowedMethod,
  sendRedirect,
  type VercelReq,
  type VercelRes,
} from "./releaseAssets.js";

const ACCOUNT_DIRECTORY_DEVICE_PAGE =
  "https://ade-account-directory-production.arulsharma1028.workers.dev/device";

/**
 * The directory's user-code alphabet (no 0, 1, I or O), with or without the
 * dash. It must stay equal to `USER_CODE_ALPHABET` in
 * `apps/account-directory/src/deviceAuthorization.ts`.
 */
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;

function deviceRedirectLocation(rawUserCode: string | undefined): string {
  const userCode = rawUserCode?.trim().toUpperCase() ?? "";
  if (!USER_CODE_PATTERN.test(userCode)) return ACCOUNT_DIRECTORY_DEVICE_PAGE;
  const dashed = userCode.includes("-") ? userCode : `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
  return `${ACCOUNT_DIRECTORY_DEVICE_PAGE}?user_code=${encodeURIComponent(dashed)}`;
}

export default function handler(req: VercelReq, res: VercelRes): void {
  if (rejectDisallowedMethod(req, res)) return;
  // Never cached: the code in the query is single-use and short-lived.
  sendRedirect(res, deviceRedirectLocation(pickQuery(req.query.user_code)), FALLBACK_CACHE_CONTROL);
}
