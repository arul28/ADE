import type { KeyObject } from "node:crypto";
import {
  ADOPT_CHANNEL_CHALLENGE_TTL_MS,
  buildAdoptChallengeSignatureInput,
  buildAdoptHelloAad,
  buildAdoptHelloOkAad,
  decodeCanonicalBase64,
  deriveAdoptSessionKey,
  generateX25519EphemeralKeyPair,
  negotiateAdoptChannelAead,
  seal,
  signEd25519,
  unseal,
  type AdoptChannelAead,
} from "../../../../desktop/src/shared/sync/adoptChannelCrypto";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import type { SyncDpopProof, SyncHelloPayload } from "../../../../desktop/src/shared/types";

/**
 * The sealed account-adoption handshake, shared by the two hosts that serve
 * it: the project sync host (`syncHostService.ts`) and the projectless brain
 * (`brainProjectActionsSyncHandler.ts`). This file owns the protocol's
 * decisions (what a valid challenge is, which cipher is chosen, how the
 * ephemeral key is derived and signed, and how a sealed hello is opened), so
 * a fix lands in both hosts at once. Each host keeps its own throttling,
 * logging, peer state and socket replies, and calls these in the same order
 * it always has.
 */

/**
 * Sunset this compatibility path once ADE's supported-client floor guarantees
 * every account adopter advertises `supportedAeads`. There is no
 * minSupportedVersion gate in the sync handshake today; removal belongs in
 * `validateAccountChallenge` below, where a missing list can then be rejected
 * and the conditional AEAD transcript fields can become unconditional.
 */
export const ALLOW_LEGACY_UNBOUND_ADOPTION_AEAD = true;

export type ParsedAccountChallenge = {
  nonce: string;
  nonceBytes: Buffer;
  clientEphemeralPublicKey: string;
  clientEphemeralPublicKeyBytes: Buffer;
  supportedAeads: string[] | null;
};

export function parseAccountChallengePayload(payload: unknown): ParsedAccountChallenge | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.v !== 1) return null;
  const nonceBytes = decodeCanonicalBase64(value.nonce, 32);
  const clientEphemeralPublicKeyBytes = decodeCanonicalBase64(
    value.clientEphemeralPublicKey,
    32,
  );
  const supportedAeads = value.supportedAeads === undefined
    ? null
    : value.supportedAeads;
  if (
    !nonceBytes
    || !clientEphemeralPublicKeyBytes
    || typeof value.nonce !== "string"
    || typeof value.clientEphemeralPublicKey !== "string"
    || (
      supportedAeads !== null
      && (
        !Array.isArray(supportedAeads)
        || supportedAeads.some((entry) => typeof entry !== "string")
      )
    )
  ) {
    return null;
  }
  return {
    nonce: value.nonce,
    nonceBytes,
    clientEphemeralPublicKey: value.clientEphemeralPublicKey,
    clientEphemeralPublicKeyBytes,
    supportedAeads,
  };
}

export type UnsealedAccountAuth = Extract<SyncHelloPayload["auth"], { kind: "account" }>;

export function parseUnsealedAccountAuth(value: unknown): UnsealedAccountAuth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const account = value as Record<string, unknown>;
  const deviceId = toOptionalString(account.deviceId);
  const accountToken = toOptionalString(account.accountToken);
  if (!deviceId || !accountToken) return null;
  if (
    account.dpop != null
    && (typeof account.dpop !== "object" || Array.isArray(account.dpop))
  ) return null;
  const runtimeHostGrant = account.runtimeHostGrant == null
    ? null
    : toOptionalString(account.runtimeHostGrant);
  if (account.runtimeHostGrant != null && !runtimeHostGrant) return null;
  return {
    kind: "account",
    deviceId,
    accountToken,
    dpop: account.dpop as SyncDpopProof | null | undefined,
    ...(runtimeHostGrant ? { runtimeHostGrant } : {}),
  };
}

/** What a peer holds between `account_challenge_ok` and its sealed hello. Single use. */
export type AdoptChallengeState = {
  sessionKey: Buffer;
  nonce: string;
  hostDeviceId: string;
  expiresAtMs: number;
  aead: AdoptChannelAead;
  /** False only for a legacy client that advertised no ciphers. */
  aeadBoundToSignature: boolean;
};

/**
 * Why a challenge was refused, with the sentence for `account_challenge_error`.
 * - `invalid`: malformed, or sent without a request id (hosts count it as abuse).
 * - `legacy_unbound`: an old client with no cipher list, refused by policy.
 * - `incompatible`: no cipher both sides support.
 */
export type AdoptChallengeRefusal =
  | { kind: "invalid"; message: string }
  | { kind: "legacy_unbound"; message: string }
  | { kind: "incompatible"; message: string; challenge: ParsedAccountChallenge };

/** Parses and checks an `account_challenge`, in the order both hosts apply. */
export function validateAccountChallenge(args: {
  requestId: string | null | undefined;
  payload: unknown;
  hostSupportedAeads: readonly AdoptChannelAead[];
}):
  | { ok: true; challenge: ParsedAccountChallenge; aead: AdoptChannelAead }
  | { ok: false; refusal: AdoptChallengeRefusal } {
  const challenge = args.requestId ? parseAccountChallengePayload(args.payload) : null;
  if (!challenge) {
    return { ok: false, refusal: { kind: "invalid", message: "Invalid account adoption challenge." } };
  }
  if (challenge.supportedAeads === null && !ALLOW_LEGACY_UNBOUND_ADOPTION_AEAD) {
    return {
      ok: false,
      refusal: {
        kind: "legacy_unbound",
        message: "This ADE version must advertise account adoption ciphers. Update ADE on this device.",
      },
    };
  }
  const aead = negotiateAdoptChannelAead(challenge.supportedAeads, args.hostSupportedAeads);
  if (!aead) {
    return {
      ok: false,
      refusal: {
        kind: "incompatible",
        message: "No compatible account adoption cipher is available. Update ADE on both devices.",
        challenge,
      },
    };
  }
  return { ok: true, challenge, aead };
}

/** The `account_challenge_ok` payload. */
export type AdoptChallengeReply = {
  v: 1;
  hostDeviceId: string;
  ts: number;
  hostEphemeralPublicKey: string;
  signature: string;
  aead?: AdoptChannelAead;
};

/**
 * Answers a valid challenge: a fresh X25519 key, the session key derived from
 * it, and the host identity's signature over the transcript. Throws when the
 * host identity is missing or the peer's key is not a valid point; the host
 * clears the peer's challenge, charges it, and replies "Host identity is
 * unavailable." The thunks run inside, so their failures throw from here too.
 */
export function issueAdoptChallenge(args: {
  challenge: ParsedAccountChallenge;
  aead: AdoptChannelAead;
  signingPrivateKey: () => KeyObject;
  hostDeviceId: () => string;
  now: () => number;
}): { state: AdoptChallengeState; reply: AdoptChallengeReply } {
  const { challenge, aead } = args;
  const signingPrivateKey = args.signingPrivateKey();
  const hostDeviceId = args.hostDeviceId();
  const hostEphemeral = generateX25519EphemeralKeyPair();
  const hostEphemeralPublicKey = hostEphemeral.publicKeyRaw.toString("base64");
  const ts = args.now();
  const aeadBoundToSignature = challenge.supportedAeads !== null;
  const canonical = buildAdoptChallengeSignatureInput({
    hostDeviceId,
    nonce: challenge.nonce,
    clientEphemeralPublicKey: challenge.clientEphemeralPublicKey,
    hostEphemeralPublicKey,
    ts,
    ...(aeadBoundToSignature ? { aead } : {}),
  });
  const sessionKey = deriveAdoptSessionKey({
    privateKey: hostEphemeral.privateKey,
    peerPublicKeyRaw: challenge.clientEphemeralPublicKeyBytes,
    nonce: challenge.nonceBytes,
  });
  const signature = signEd25519(signingPrivateKey, canonical).toString("base64");
  return {
    state: {
      sessionKey,
      nonce: challenge.nonce,
      hostDeviceId,
      expiresAtMs: ts + ADOPT_CHANNEL_CHALLENGE_TTL_MS,
      aead,
      aeadBoundToSignature,
    },
    reply: {
      v: 1,
      hostDeviceId,
      ts,
      hostEphemeralPublicKey,
      signature,
      ...(aeadBoundToSignature ? { aead } : {}),
    },
  };
}

/** A sealed hello that opened: its reply is sealed under the same key. */
export type SealedAdoption = {
  sessionKey: Buffer;
  hostDeviceId: string;
  clientDeviceId: string;
  aead: AdoptChannelAead;
  aeadBoundToSignature: boolean;
};

/**
 * Opens an `account_sealed` hello against the challenge this socket was
 * issued. The caller has already taken the challenge off the peer (it is
 * single use even when this fails). A refusal carries the `hello_error`
 * message; `openError` is set when decryption or parsing threw, for the
 * host's own log.
 */
export function openSealedAccountHello(args: {
  challenge: AdoptChallengeState | null;
  now: number;
  helloPeerDeviceId: string;
  sealedAuth: { deviceId: string; sealed: string };
}):
  | { ok: true; auth: UnsealedAccountAuth; adoption: SealedAdoption }
  | { ok: false; message: string; openError?: unknown } {
  const { challenge, sealedAuth } = args;
  if (!challenge) return { ok: false, message: "A completed account challenge is required." };
  if (challenge.expiresAtMs < args.now) return { ok: false, message: "The account challenge expired." };
  if (sealedAuth.deviceId !== args.helloPeerDeviceId || !sealedAuth.sealed) {
    return { ok: false, message: "The sealed account hello is invalid." };
  }
  try {
    const plaintext = unseal(
      challenge.sessionKey,
      buildAdoptHelloAad(challenge.hostDeviceId, sealedAuth.deviceId),
      sealedAuth.sealed,
      challenge.aead,
    );
    const auth = parseUnsealedAccountAuth(JSON.parse(plaintext.toString("utf8")));
    if (!auth || auth.deviceId !== sealedAuth.deviceId) {
      return { ok: false, message: "The sealed account credentials are invalid." };
    }
    return {
      ok: true,
      auth,
      adoption: {
        sessionKey: challenge.sessionKey,
        hostDeviceId: challenge.hostDeviceId,
        clientDeviceId: sealedAuth.deviceId,
        aead: challenge.aead,
        aeadBoundToSignature: challenge.aeadBoundToSignature,
      },
    };
  } catch (error) {
    return { ok: false, message: "The sealed account credentials could not be opened.", openError: error };
  }
}

/** The sealed `hello_ok` for an adoption socket. */
export function sealAdoptHelloOk(adoption: SealedAdoption, helloOkPayload: unknown): { v: 1; sealed: string } {
  return {
    v: 1,
    sealed: seal(
      adoption.sessionKey,
      buildAdoptHelloOkAad(adoption.hostDeviceId, adoption.clientDeviceId),
      Buffer.from(JSON.stringify(helloOkPayload), "utf8"),
      undefined,
      adoption.aead,
    ),
  };
}
