import type { WebAuthnPageAnswer, WebAuthnPageRequest } from "../../../shared/types/builtInBrowserPasskeys";
import { captureError } from "../../../shared/sentry/capture";
import type { PasswordPasskeySecret } from "../../../shared/types/passwords";
import { createPasskey, getAssertion, rpIdAllowedForOrigin, WEBAUTHN_ALGORITHM_ES256 } from "./passkeys";
import type { PersonCheck } from "../passwords/personCheck";

/**
 * Desktop main's half of passkeys in ADE's browser (the tab preload's hook
 * asks; see `preload/browserMedia.ts`).
 *
 * Rules:
 * - The origin is the asking frame's own, from Electron; nothing the page
 *   sends can change it. A frame that is not same-origin with its tab's top
 *   page gets the browser's own WebAuthn (no ADE passkey in a third-party
 *   frame).
 * - The RP ID must belong to that origin (`rpIdAllowedForOrigin`).
 * - Every use and every new passkey asks the person (Touch ID / Windows
 *   Hello; a confirm on a computer with neither). The answer decides the
 *   user-verified flag; a site that requires verification gets the browser's
 *   own WebAuthn when only a confirm was possible.
 * - Nothing to offer (Passwords off, no passkey for the site, a conditional
 *   "autofill" request) means `fallback`: the page's call goes on to Chromium.
 */

const b64u = (bytes: Buffer): string => bytes.toString("base64url");
const fromB64u = (value: string): Buffer => Buffer.from(value, "base64url");

export type PasskeyPasswordsAccess = {
  enabled(): Promise<boolean>;
  passkeysForRp(rpId: string): Promise<Array<PasswordPasskeySecret & { id: string }>>;
  savePasskey(input: Omit<PasswordPasskeySecret, "kind" | "createdAt" | "updatedAt">): Promise<unknown>;
  recordUse?(input: { itemId: string; target: string }): Promise<unknown>;
};

export async function answerWebAuthnRequest(input: {
  request: WebAuthnPageRequest;
  /** The asking frame's origin, from Electron. */
  frameOrigin: string;
  /** The tab's top-level origin. */
  topOrigin: string;
  passwords: PasskeyPasswordsAccess | null;
  checkPerson: (reason: string, actionLabel: string) => Promise<PersonCheck | null>;
  /** Which saved account to use when several match; null when the person cancels. */
  chooseAccount: (rpId: string, accounts: string[]) => Promise<number | null>;
  /** True once the page gave up on this request: nothing is signed or saved after that. */
  cancelled?: () => boolean;
}): Promise<WebAuthnPageAnswer> {
  const gaveUp: WebAuthnPageAnswer = { error: "NotAllowedError", message: "The page cancelled the request." };
  const { request, frameOrigin } = input;
  if (!input.passwords) return { fallback: true };
  if (frameOrigin !== input.topOrigin) return { fallback: true };
  let host: string;
  try {
    host = new URL(frameOrigin).hostname;
  } catch {
    return { fallback: true };
  }
  const rpId = (request.rpId ?? host).toLowerCase();
  if (!rpIdAllowedForOrigin(rpId, frameOrigin)) {
    return { error: "SecurityError", message: `${rpId} is not a valid relying party for ${frameOrigin}.` };
  }
  const failed = (what: string) => (error: unknown) => {
    captureError(error, { tags: { area: "passwords", op: `passkeys_${what}` } });
    return null;
  };
  if (!(await input.passwords.enabled().catch(failed("enabled")))) return { fallback: true };

  if (request.kind === "get") {
    if (request.mediation === "conditional" || request.mediation === "silent") return { fallback: true };
    const saved = (await input.passwords.passkeysForRp(rpId).catch(failed("lookup"))) ?? [];
    const matching = request.allowCredentialIds.length
      ? saved.filter((passkey) => request.allowCredentialIds.includes(passkey.credentialId))
      : saved;
    if (!matching.length) return { fallback: true };
    // Several accounts on one site (work and personal): the person picks one,
    // so a sign-in never quietly uses whichever was saved first.
    let allowed = matching;
    if (matching.length > 1) {
      const picked = await input.chooseAccount(rpId, matching.map((passkey) => passkey.userDisplayName || passkey.userName || "Unnamed account"));
      if (picked === null || !matching[picked]) return { error: "NotAllowedError", message: "The person cancelled the passkey sign-in." };
      allowed = [matching[picked]];
    }
    const check = await input.checkPerson(`sign in to ${rpId} with a passkey saved in ADE`, "Sign in");
    if (!check) return { error: "NotAllowedError", message: "The person cancelled the passkey sign-in." };
    if (input.cancelled?.()) return gaveUp;
    if (request.userVerification === "required" && check !== "biometric") return { fallback: true };
    const result = getAssertion({
      rpId,
      origin: frameOrigin,
      challenge: fromB64u(request.challenge),
      allowCredentialIds: request.allowCredentialIds.map(fromB64u),
      candidates: allowed,
      userVerified: check === "biometric",
    });
    if ("error" in result) return { error: result.error, message: "No saved passkey matched." };
    const used = allowed.find((passkey) => passkey.credentialId === result.credentialId);
    if (used) void input.passwords.recordUse?.({ itemId: used.id, target: rpId }).catch(failed("activity"));
    return {
      kind: "get",
      credentialId: result.credentialId,
      clientDataJSON: b64u(result.response.clientDataJSON),
      authenticatorData: b64u(result.response.authenticatorData),
      signature: b64u(result.response.signature),
      userHandle: b64u(result.response.userHandle),
    };
  }

  // create
  if (request.algorithms.length && !request.algorithms.includes(WEBAUTHN_ALGORITHM_ES256)) {
    return { error: "NotSupportedError", message: "ADE's passkeys use ES256, which this site does not accept." };
  }
  const existing = (await input.passwords.passkeysForRp(rpId).catch(failed("lookup"))) ?? [];
  if (request.excludeCredentialIds.some((id) => existing.some((passkey) => passkey.credentialId === id))) {
    return { error: "InvalidStateError", message: "A passkey for this account is already saved in ADE." };
  }
  const who = request.userName || request.userDisplayName || "this account";
  const check = await input.checkPerson(`save a passkey for ${who} on ${rpId} in ADE Passwords`, "Save passkey");
  if (!check) return { error: "NotAllowedError", message: "The person cancelled saving the passkey." };
  if (input.cancelled?.()) return gaveUp;
  if (request.userVerification === "required" && check !== "biometric") return { fallback: true };
  const made = createPasskey({
    rpId,
    origin: frameOrigin,
    userId: fromB64u(request.userId),
    userName: request.userName,
    userDisplayName: request.userDisplayName,
    challenge: fromB64u(request.challenge),
    excludeCredentialIds: request.excludeCredentialIds.map(fromB64u),
    existingCredentialIds: existing.map((passkey) => fromB64u(passkey.credentialId)),
    userVerified: check === "biometric",
  });
  if ("error" in made) return { error: made.error, message: "ADE could not make the passkey." };
  await input.passwords.savePasskey({
    rpId: made.credential.rpId,
    credentialId: made.credential.credentialId,
    userHandle: made.credential.userHandle,
    userName: made.credential.userName,
    userDisplayName: made.credential.userDisplayName,
    privateKeyPkcs8: made.credential.privateKeyPkcs8,
    signCount: made.credential.signCount,
  });
  return {
    kind: "create",
    credentialId: b64u(made.credentialId),
    clientDataJSON: b64u(made.response.clientDataJSON),
    attestationObject: b64u(made.response.attestationObject),
    authenticatorData: b64u(made.response.authenticatorData),
    publicKey: b64u(made.response.publicKey),
    publicKeyAlgorithm: made.response.publicKeyAlgorithm,
    transports: made.response.transports,
    credProps: request.wantsCredProps,
  };
}

const B64U = /^[A-Za-z0-9_-]{0,4096}$/;
const text = (value: unknown, max = 512): string => (typeof value === "string" ? value.slice(0, max) : "");
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && B64U.test(id)).slice(0, 64) : []);
const verification = (value: unknown): "required" | "preferred" | "discouraged" =>
  value === "required" || value === "discouraged" ? value : "preferred";

/** The tab's request, checked field by field; null when it is not one. */
export function parseWebAuthnPageRequest(payload: unknown): WebAuthnPageRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const challenge = text(raw.challenge, 4096);
  if (!challenge || !B64U.test(challenge)) return null;
  const rpId = typeof raw.rpId === "string" && raw.rpId.trim() ? raw.rpId.trim().slice(0, 253) : null;
  if (raw.kind === "create") {
    const userId = text(raw.userId, 256);
    if (!userId || !B64U.test(userId)) return null;
    return {
      kind: "create",
      rpId,
      rpName: typeof raw.rpName === "string" ? raw.rpName.slice(0, 200) : null,
      userId,
      userName: text(raw.userName, 200),
      userDisplayName: text(raw.userDisplayName, 200),
      challenge,
      excludeCredentialIds: ids(raw.excludeCredentialIds),
      algorithms: Array.isArray(raw.algorithms) ? raw.algorithms.filter((alg): alg is number => Number.isInteger(alg)).slice(0, 16) : [],
      userVerification: verification(raw.userVerification),
      wantsCredProps: raw.wantsCredProps === true,
    };
  }
  if (raw.kind === "get") {
    return {
      kind: "get",
      rpId,
      challenge,
      allowCredentialIds: ids(raw.allowCredentialIds),
      userVerification: verification(raw.userVerification),
      mediation: typeof raw.mediation === "string" ? raw.mediation.slice(0, 20) : null,
    };
  }
  return null;
}
