/**
 * Passkeys: the software authenticator behind ADE's built-in browser.
 *
 * The flow, once the browser is wired to this core:
 *
 * 1. A page calls `navigator.credentials.create(...)` or
 *    `navigator.credentials.get(...)`. Electron main intercepts the call; the
 *    page's arguments are untrusted input.
 * 2. Main takes `origin` from the frame's real URL and `rpId` from the relying
 *    party, then checks `rpIdAllowedForOrigin(rpId, origin)` here.
 * 3. For `create`, main asks the person to save a passkey and, if they agree,
 *    calls `createPasskey`. For `get`, main picks a stored passkey (the
 *    `candidates` array, already narrowed by its own vault lookup), asks for
 *    user verification, and calls `getAssertion`.
 * 4. Main returns the response to the page and stores the returned
 *    `StoredPasskey` sealed in ADE Passwords. `privateKeyPkcs8` is plaintext
 *    PKCS#8 in this object: it never goes to a renderer, a log line, or an
 *    analytics event, and it is cleared after sealing.
 *
 * Security rules this module and its caller must hold:
 *
 * - **Origin comes from the frame.** `origin` is the frame's committed URL
 *   origin, never `location.origin` read out of the page, never a value in the
 *   page's arguments. `rpId` comes from the request but is only honored when
 *   this module says the origin may use it. Cross-origin frames are refused
 *   (`crossOrigin` must be false).
 * - **User verification is decided by the caller.** This core never prompts.
 *   Touch ID, Windows Hello, or the ADE consent dialog runs in the caller and
 *   arrives as `userVerified`. A false value produces a UV=0 assertion that a
 *   relying party may refuse.
 * - **User presence is the interception itself.** Opening the ADE passkey
 *   prompt is a real gesture in the browser UI, so the UP flag is always set;
 *   a caller that can be driven without a person must not call this core.
 * - **The challenge comes from the server, unchanged.** It is echoed
 *   base64url in `clientDataJSON`; this core never invents one.
 * - **Signatures cover the RP ID and the client data.** `getAssertion` signs
 *   `authenticatorData || sha256(clientDataJSON)` with ES256. A verifier must
 *   check both, so a response replayed to another origin fails.
 * - **Synced passkeys keep a zero signature counter.** ADE's passkeys are
 *   software credentials that sync through the vault, so they cannot promise
 *   a monotonic per-device counter. They report `signCount` 0, set BE/BS, and
 *   behaving like iCloud Keychain (a synced platform authenticator) is the
 *   honest choice; a relying party sees a backup-eligible credential rather
 *   than a counter that goes backwards between machines. This module does not
 *   mutate the stored record, so callers may keep whatever counter they read;
 *   `updatedSignCount` is always 0.
 *
 * Attestation is `none` with an all-zero AAGUID: ADE makes no claim about
 * hardware and does not want a stable identifier shared across sites. The
 * relying party trusts the credential by registration, not by attestation.
 *
 * RP ID matching follows the browser rule: the RP ID is the page's host or a
 * parent domain of it, and never a public suffix. Public suffixes come from
 * the Public Suffix List (`tldts`), private suffixes included, so a page on
 * `alice.github.io` can never claim `github.io` — the same list Passwords'
 * site matching uses (`passwordMatching.ts`).
 */
import crypto from "node:crypto";
import { getPublicSuffix } from "tldts";
import { encodeCbor, type CborMap, type CborMapKey, type CborValue } from "./cbor";

/** ES256 with SHA-256, the one algorithm every platform authenticator supports. */
export const WEBAUTHN_ALGORITHM_ES256 = -7;

/** All zeros: no authenticator model is asserted, and nothing is shared across sites. */
export const ADE_WEBAUTHN_AAGUID_HEX = "00000000000000000000000000000000";

/** How long a credential ID this authenticator makes, in bytes. */
const CREDENTIAL_ID_BYTES = 16;
const SIGN_COUNT_BYTES = 4;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;


export type StoredPasskey = {
  /** Base64url, as it appears in the WebAuthn response. */
  credentialId: string;
  rpId: string;
  /** Base64url. Stable per user account, not per credential. */
  userHandle: string;
  userName: string;
  userDisplayName: string;
  /** Base64 PKCS#8 DER. Sealed by the caller before it touches disk. */
  privateKeyPkcs8: string;
  /** Always 0 for ADE's synced passkeys. */
  signCount: number;
  /** ISO-8601, set once at creation. */
  createdAt: string;
};

export type CreatePasskeyArgs = {
  rpId: string;
  origin: string;
  userId: Buffer;
  userName: string;
  userDisplayName: string;
  challenge: Buffer;
  excludeCredentialIds?: Buffer[];
  /**
   * Credential IDs already stored for this RP, used only to avoid minting a
   * duplicate random ID. The request's exclude list is `excludeCredentialIds`.
   */
  existingCredentialIds: Buffer[];
  userVerified: boolean;
  crossOrigin?: false;
};

export type CreatePasskeyResult =
  | {
      credential: StoredPasskey;
      credentialId: Buffer;
      response: {
        clientDataJSON: Buffer;
        attestationObject: Buffer;
        authenticatorData: Buffer;
        /** SPKI DER of the credential public key. */
        publicKey: Buffer;
        publicKeyAlgorithm: typeof WEBAUTHN_ALGORITHM_ES256;
        transports: string[];
      };
    }
  | { error: "InvalidStateError" | "NotAllowedError" };

export type GetAssertionArgs = {
  rpId: string;
  origin: string;
  challenge: Buffer;
  /** Empty or omitted means "any credential for this RP". */
  allowCredentialIds?: Buffer[];
  candidates: StoredPasskey[];
  userVerified: boolean;
  /**
   * The frame must be same-origin with the top-level page. Only `false` is
   * accepted; a cross-origin frame needs `topOrigin` in clientDataJSON, which
   * this core intentionally does not emit.
   */
  crossOrigin?: false;
};

export type GetAssertionResult =
  | {
      credentialId: string;
      response: {
        clientDataJSON: Buffer;
        authenticatorData: Buffer;
        /** DER-encoded ECDSA P-256 signature over authData || sha256(clientDataJSON). */
        signature: Buffer;
        userHandle: Buffer;
      };
      updatedSignCount: number;
    }
  | { error: "NotAllowedError" };

/**
 * May `rpId` answer challenges for `origin`?
 *
 * The origin must be a bare https origin (http only for loopback/localhost
 * names), and the RP ID must be the host itself or a label-boundary suffix of
 * it. A bare single-label name other than `localhost` (so `com`) and a known
 * public suffix (so `co.uk`, `github.io`) are refused. IDNs must arrive
 * punycoded, because that is what the browser hands us.
 */
export function rpIdAllowedForOrigin(rpId: string, origin: string): boolean {
  const normalizedRpId = normalizeRpId(rpId);
  const url = parseWebAuthnOrigin(origin);
  if (!normalizedRpId || !url) return false;
  if (normalizedRpId !== "localhost" && getPublicSuffix(normalizedRpId, { allowPrivateDomains: true }) === normalizedRpId) return false;

  const host = stripIpv6Brackets(url.hostname.toLowerCase());

  // A bare label is a TLD (or an intranet name we cannot vouch for). The one
  // exception browsers make is localhost, including *.localhost.
  if (!normalizedRpId.includes(".") && normalizedRpId !== "localhost") return false;

  if (host === normalizedRpId) return true;

  // IP hosts have no registrable suffix; only exact equality above counts, so
  // "0.0.1" can never claim "127.0.0.1".
  if (isIpAddress(host) || isIpAddress(normalizedRpId)) return false;

  return host.endsWith(`.${normalizedRpId}`);
}

/**
 * Create a discoverable ES256 passkey with `none` attestation.
 *
 * Returns `NotAllowedError` when the origin/RP pair is not allowed or a
 * cross-origin caller slipped past the type, and `InvalidStateError` when the
 * site's exclude list names a credential that already exists.
 */
export function createPasskey(args: CreatePasskeyArgs): CreatePasskeyResult {
  const url = parseWebAuthnOrigin(args.origin);
  const rpId = normalizeRpId(args.rpId);
  if (!url || !rpId || !rpIdAllowedForOrigin(rpId, args.origin)) return { error: "NotAllowedError" };
  if (isCrossOrigin(args.crossOrigin)) return { error: "NotAllowedError" };

  const excluded = new Set((args.excludeCredentialIds ?? []).map((id) => Buffer.from(id).toString("base64url")));
  if (excluded.size > 0) {
    const alreadyExists = (args.existingCredentialIds ?? []).some((id) => excluded.has(Buffer.from(id).toString("base64url")));
    if (alreadyExists) return { error: "InvalidStateError" };
  }

  const existing = new Set((args.existingCredentialIds ?? []).map((id) => Buffer.from(id).toString("base64url")));
  const credentialId = mintCredentialId(existing);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyPkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const publicKeySpki = publicKey.export({ type: "spki", format: "der" });
  const jwk = publicKey.export({ format: "jwk" }) as crypto.JsonWebKey;
  if (!jwk.x || !jwk.y) throw new Error("The generated P-256 key has no affine coordinates.");

  const coseKey: CborMap = new Map<CborMapKey, CborValue>([
    [1, 2], // kty: EC2
    [3, WEBAUTHN_ALGORITHM_ES256], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, "base64url")], // x
    [-3, Buffer.from(jwk.y, "base64url")], // y
  ]);

  const authData = buildAuthenticatorData({
    rpId,
    flags: FLAG_USER_PRESENT
      | (args.userVerified ? FLAG_USER_VERIFIED : 0)
      | FLAG_BACKUP_ELIGIBLE
      | FLAG_BACKED_UP
      | FLAG_ATTESTED_CREDENTIAL_DATA,
    signCount: 0,
    attestedCredential: {
      aaguid: Buffer.from(ADE_WEBAUTHN_AAGUID_HEX, "hex"),
      credentialId,
      coseKey,
    },
  });

  const clientDataJSON = buildClientDataJSON("webauthn.create", args.challenge, url.origin);
  const attestationObject = encodeCbor(
    new Map<CborMapKey, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map<CborMapKey, CborValue>()],
      ["authData", authData],
    ]),
  );

  return {
    credential: {
      credentialId: credentialId.toString("base64url"),
      rpId,
      userHandle: Buffer.from(args.userId).toString("base64url"),
      userName: args.userName,
      userDisplayName: args.userDisplayName,
      privateKeyPkcs8: privateKeyPkcs8.toString("base64"),
      signCount: 0,
      createdAt: new Date().toISOString(),
    },
    credentialId,
    response: {
      clientDataJSON,
      attestationObject,
      authenticatorData: authData,
      publicKey: publicKeySpki,
      publicKeyAlgorithm: WEBAUTHN_ALGORITHM_ES256,
      transports: ["internal", "hybrid"],
    },
  };
}

/**
 * Sign an assertion for the first candidate that matches the RP (and the
 * allow list, when one is given). Candidate order is the caller's; the caller
 * decides which passkey to offer and whether the person verified.
 *
 * `updatedSignCount` is always 0: see the synced-passkey note in the header.
 */
export function getAssertion(args: GetAssertionArgs): GetAssertionResult {
  const url = parseWebAuthnOrigin(args.origin);
  const rpId = normalizeRpId(args.rpId);
  if (!url || !rpId || !rpIdAllowedForOrigin(rpId, args.origin)) return { error: "NotAllowedError" };
  if (isCrossOrigin(args.crossOrigin)) return { error: "NotAllowedError" };

  const allow = args.allowCredentialIds && args.allowCredentialIds.length > 0
    ? new Set(args.allowCredentialIds.map((id) => Buffer.from(id).toString("base64url")))
    : null;

  for (const candidate of args.candidates) {
    if (normalizeRpId(candidate.rpId) !== rpId) continue;
    if (allow && !allow.has(candidate.credentialId)) continue;
    if (!BASE64URL.test(candidate.credentialId)) continue;
    const privateKey = loadCredentialPrivateKey(candidate);
    if (!privateKey) continue;

    const clientDataJSON = buildClientDataJSON("webauthn.get", args.challenge, url.origin);
    const authData = buildAuthenticatorData({
      rpId,
      flags: FLAG_USER_PRESENT
        | (args.userVerified ? FLAG_USER_VERIFIED : 0)
        | FLAG_BACKUP_ELIGIBLE
        | FLAG_BACKED_UP,
      signCount: 0,
    });
    const clientDataHash = sha256(clientDataJSON);
    const signature = crypto.sign("sha256", Buffer.concat([authData, clientDataHash]), {
      key: privateKey,
      dsaEncoding: "der",
    });

    return {
      credentialId: candidate.credentialId,
      response: {
        clientDataJSON,
        authenticatorData: authData,
        signature,
        userHandle: decodeUserHandle(candidate.userHandle),
      },
      updatedSignCount: 0,
    };
  }

  return { error: "NotAllowedError" };
}

function buildAuthenticatorData(args: {
  rpId: string;
  flags: number;
  signCount: number;
  attestedCredential?: { aaguid: Buffer; credentialId: Buffer; coseKey: CborMap };
}): Buffer {
  const parts: Buffer[] = [
    sha256(Buffer.from(args.rpId, "utf8")),
    Buffer.from([args.flags]),
    encodeSignCount(args.signCount),
  ];
  if (args.attestedCredential) {
    const { aaguid, credentialId, coseKey } = args.attestedCredential;
    if (aaguid.length !== 16) throw new Error("AAGUID must be 16 bytes.");
    if (credentialId.length > 0xffff) throw new Error("Credential ID is too long.");
    parts.push(aaguid);
    parts.push(encodeUint16(credentialId.length));
    parts.push(credentialId);
    parts.push(encodeCbor(coseKey));
  }
  return Buffer.concat(parts);
}

/**
 * `{"type":...,"challenge":...,"origin":...,"crossOrigin":false}` with that
 * key order. The challenge is base64url without padding, as WebAuthn requires.
 */
function buildClientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: Buffer, origin: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge: Buffer.from(challenge).toString("base64url"),
      origin,
      crossOrigin: false,
    }),
    "utf8",
  );
}

function mintCredentialId(existing: Set<string>): Buffer {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const credentialId = crypto.randomBytes(CREDENTIAL_ID_BYTES);
    if (!existing.has(credentialId.toString("base64url"))) return credentialId;
  }
  throw new Error("Could not mint a unique credential ID.");
}

function loadCredentialPrivateKey(passkey: StoredPasskey): crypto.KeyObject | null {
  if (!BASE64.test(passkey.privateKeyPkcs8)) return null;
  try {
    const key = crypto.createPrivateKey({
      key: Buffer.from(passkey.privateKeyPkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (key.asymmetricKeyType !== "ec") return null;
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

function decodeUserHandle(userHandle: string): Buffer {
  if (userHandle === "") return Buffer.alloc(0);
  if (!BASE64URL.test(userHandle)) return Buffer.alloc(0);
  return Buffer.from(userHandle, "base64url");
}

function parseWebAuthnOrigin(origin: string): URL | null {
  if (typeof origin !== "string" || origin.length === 0) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (url.protocol === "http:" && !isLocalHostname(url.hostname)) return null;
  return url;
}

function normalizeRpId(rpId: string): string | null {
  if (typeof rpId !== "string") return null;
  const value = rpId.trim().toLowerCase();
  if (!value || value.length > 253) return null;
  // A bare label is a TLD unless it is localhost; rpIdAllowedForOrigin has the
  // full explanation. Reject it here too so no caller can hash a TLD.
  if (!value.includes(".") && value !== "localhost") return null;
  const labels = value.split(".");
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) return null;
  return value;
}

function isLocalHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase());
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpAddress(hostname: string): boolean {
  return IPV4.test(hostname) || hostname.includes(":");
}

function isCrossOrigin(value: unknown): boolean {
  // The type says `false`; JavaScript callers are not typed. Never emit a
  // clientDataJSON that claims same-origin for a cross-origin frame.
  return value === true;
}

function sha256(input: Buffer): Buffer {
  return crypto.createHash("sha256").update(input).digest();
}

function encodeUint16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function encodeSignCount(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid signature counter.");
  const bytes = Buffer.alloc(SIGN_COUNT_BYTES);
  bytes.writeUInt32BE(value);
  return bytes;
}
