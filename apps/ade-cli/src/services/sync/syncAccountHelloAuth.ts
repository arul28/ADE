import type {
  SyncHelloErrorPayload,
  SyncHelloPayload,
  SyncPeerMetadata,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AccountAttestationConfig } from "../account/sharedAccountAuthService";
import type { VerifiedAccountAttestation } from "../account/accountAttestationVerifier";
import { isValidDpopPublicKey, type SyncPairingRecord, type SyncPairingStore } from "./syncPairingStore";
import { evaluatePairedHelloDpop, syncDpopFailureMessage, type SyncDpopNonceCache } from "./syncDpop";

/**
 * Shared account-hello authentication for the two ingresses that accept one:
 * the project sync host (`syncHostService`) and the projectless brain fallback
 * (`brainProjectActionsSyncHandler`). Both ran a near-identical ~170-line gate
 * chain, and the copies had already drifted — the brain's rejections carried
 * different codes for the same causes.
 *
 * The genuine divergences are options, not forks: the brain has no connection
 * arbitration and no sealed adoption, and it keeps it that way by leaving those
 * options unset. Everything else — the gate order, the strings, the commit-lock
 * discipline — is one implementation.
 */

/**
 * `null` means "no usable pairing record here yet", which the caller may not
 * distinguish from "unknown device" on the wire: telling an unauthenticated
 * caller which one it is turns this handshake into an existence oracle.
 */
export const SYNC_REPAIR_REQUIRED_MESSAGE = "This device is not paired with this machine, or its saved"
  + " pairing is no longer valid. Pair it again.";

export const SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE = "The ADE account session on this machine changed"
  + " while connecting. Try again.";

export const SYNC_ACCOUNT_VERIFY_UNAVAILABLE_MESSAGE = "This machine cannot verify ADE accounts."
  + " Update ADE on this computer, then try again.";

export const SYNC_ACCOUNT_NOT_SIGNED_IN_MESSAGE = "This machine is not signed in to an ADE account."
  + " Sign in on this computer, then try again.";

export const SYNC_ACCOUNT_DEVICE_MISMATCH_MESSAGE = "The account identity in this connection did not"
  + " match the device that sent it.";

export const SYNC_ACCOUNT_KEYLESS_RECORD_MESSAGE = "This device's saved pairing predates device-key"
  + " security. Remove it on this computer and pair it again.";

export const SYNC_ACCOUNT_OTHER_OWNER_MESSAGE = "This device is already paired to this machine under"
  + " a different ADE account.";

export const SYNC_ACCOUNT_PAIRING_WRITE_FAILED_MESSAGE = "This machine could not save the new pairing"
  + " for this device. Try again.";

export const SYNC_ACCOUNT_VERIFY_FAILED_MESSAGE = "This machine could not verify your ADE account"
  + " session. Sign out and back in on this device, then try again.";

export type SyncAccountHelloAuth = Extract<SyncHelloPayload["auth"], { kind: "account" }>;

export type SyncAccountHelloResult =
  /** Authentication succeeded. `accountPairing` is set only on a fresh adoption. */
  | {
      kind: "authenticated";
      pairingRecord: SyncPairingRecord;
      accountPairing: { deviceId: string; secret: string } | null;
      attestation: VerifiedAccountAttestation;
      connectionAttemptReserved: boolean;
    }
  /** The host said no, with a nameable cause the client can act on. */
  | { kind: "rejected"; message: string; code: SyncHelloErrorPayload["code"] }
  /** The peer moved on (closed, or a newer lifecycle took over) mid-handshake. */
  | { kind: "stale" }
  /** Another connection from the same device won arbitration. Host-only. */
  | { kind: "superseded" };

export type SyncAccountHelloAuthOptions = {
  auth: SyncAccountHelloAuth;
  peer: SyncPeerMetadata;
  transportOrigin: string | null | undefined;
  logger: Logger;
  /** Log-event namespace: `sync_host` for the project host, `sync_ingress` for the brain. */
  logPrefix: string;
  pairingStore: Pick<
    SyncPairingStore,
    "getPairingRecord" | "hasPendingRotation" | "pairPeerViaAccount" | "verifySecret"
  >;
  dpopNonceCache: SyncDpopNonceCache;
  /** Re-read on every gate: the account can change mid-handshake. */
  captureAccountAuthorization: () => Promise<{ userId: string; generation: number } | null>;
  getAccountAttestationConfig: () => AccountAttestationConfig | null | undefined;
  verifyAccountAttestation: (args: {
    token: string;
    expectedUserId: string;
    config: AccountAttestationConfig;
  }) => Promise<VerifiedAccountAttestation>;
  /** Serialized per device so two racing routes cannot both write a pairing record. */
  withCommitLock: <T>(deviceId: string, run: () => Promise<T>) => Promise<T>;
  isPeerCurrent: () => boolean;
  /**
   * Set when a sealed adoption round trip established the account credentials
   * out of band, which is the one case an account hello may arrive off the
   * relay bridge. The brain does not serve that round trip.
   */
  sealedAdoption?: boolean;
  /**
   * Host-only: reserve this device's single connection slot before mutating any
   * pairing state. `false` means a concurrent connection won.
   */
  arbitrateConnectionAttempt?: () => boolean;
  /** Host-only: log the adoption of a pre-account manual pairing record. */
  allowLegacyUpgrade?: boolean;
  /** "PIN" on the project host, "code" on the brain — same instruction, local wording. */
  pairingCodeNoun: string;
  /**
   * Code carried when this machine holds no account session at all. The brain
   * answers `relay_account_required` because its only account route is Relay.
   */
  notSignedInCode: SyncHelloErrorPayload["code"];
};

const reject = (
  message: string,
  code: SyncHelloErrorPayload["code"] = "auth_failed",
): SyncAccountHelloResult => ({ kind: "rejected", message, code });

export async function authenticateSyncAccountHello(
  options: SyncAccountHelloAuthOptions,
): Promise<SyncAccountHelloResult> {
  const {
    auth,
    peer,
    logger,
    logPrefix,
    pairingStore,
    isPeerCurrent,
  } = options;

  if (auth.deviceId !== peer.deviceId) {
    return reject(SYNC_ACCOUNT_DEVICE_MISMATCH_MESSAGE);
  }
  // Account bearer credentials must never traverse or authenticate a plaintext
  // direct route. Paired devices reconnect directly with their stored secret +
  // DPoP key instead.
  if (!options.sealedAdoption && options.transportOrigin !== "relay-bridge") {
    logger.warn(`${logPrefix}.account_auth_requires_relay`, {
      deviceId: auth.deviceId,
      transportOrigin: options.transportOrigin ?? null,
    });
    return reject(
      "Signing in cannot authenticate a direct connection to this machine."
        + ` Connect through ADE Relay, or pair this device with a ${options.pairingCodeNoun}.`,
    );
  }

  try {
    const authorization = await options.captureAccountAuthorization();
    if (!isPeerCurrent()) return { kind: "stale" };
    if (!authorization) {
      logger.warn(`${logPrefix}.account_owner_missing`, { deviceId: auth.deviceId });
      return reject(SYNC_ACCOUNT_NOT_SIGNED_IN_MESSAGE, options.notSignedInCode);
    }
    const config = options.getAccountAttestationConfig();
    if (!config) {
      // Not a pairing problem: the pairing record, if any, is fine. Saying
      // `auth_failed` here reads as "pair it again" on every client.
      return reject(SYNC_ACCOUNT_VERIFY_UNAVAILABLE_MESSAGE, "host_update_required");
    }
    const attestation = await options.verifyAccountAttestation({
      token: auth.accountToken,
      expectedUserId: authorization.userId,
      config,
    });
    if (!isPeerCurrent()) return { kind: "stale" };
    const commitAuthorization = await options.captureAccountAuthorization();
    if (!isPeerCurrent()) return { kind: "stale" };
    if (
      !commitAuthorization
      || commitAuthorization.userId !== authorization.userId
      || commitAuthorization.generation !== authorization.generation
    ) {
      logger.warn(`${logPrefix}.account_auth_session_changed`, { deviceId: auth.deviceId });
      return reject(SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE, "account_session_changed");
    }

    return await options.withCommitLock(auth.deviceId, async (): Promise<SyncAccountHelloResult> => {
      if (!isPeerCurrent()) return { kind: "stale" };
      // The account can change while this candidate waits behind another
      // route's commit. Re-capture inside the lock, before any pairing
      // mutation or connection-attempt reservation.
      const lockedAuthorization = await options.captureAccountAuthorization();
      if (!isPeerCurrent()) return { kind: "stale" };
      if (
        !lockedAuthorization
        || lockedAuthorization.userId !== authorization.userId
        || lockedAuthorization.generation !== authorization.generation
      ) {
        return reject(SYNC_ACCOUNT_SESSION_CHANGED_MESSAGE, "account_session_changed");
      }

      const existingPairingRecord = pairingStore.getPairingRecord(auth.deviceId);
      // Validity, not truthiness. `evaluatePairedHelloDpop` resolves its stored
      // key with `.trim() || null`, so a whitespace-only field would pass a
      // truthy check here and then fall into that function's TOFU branch —
      // verifying the proof against the key the CALLER supplied. Both guards
      // have to agree on what a key is.
      if (existingPairingRecord && !isValidDpopPublicKey(existingPairingRecord.dpopPublicKey ?? "")) {
        logger.warn(`${logPrefix}.account_existing_keyless_rejected`, { deviceId: auth.deviceId });
        return reject(SYNC_ACCOUNT_KEYLESS_RECORD_MESSAGE);
      }
      const dpopFailure = evaluatePairedHelloDpop({
        storedPublicKey: existingPairingRecord?.dpopPublicKey ?? null,
        deviceId: auth.deviceId,
        secret: auth.accountToken,
        proof: auth.dpop ?? null,
        requireDpop: true,
        nonceCache: options.dpopNonceCache,
      });
      if (dpopFailure) {
        logger.warn(`${logPrefix}.account_dpop_rejected`, {
          deviceId: auth.deviceId,
          reason: dpopFailure,
        });
        return reject(syncDpopFailureMessage(dpopFailure));
      }
      const existingAccountOwner = existingPairingRecord?.accountOwnerUserId?.trim() || null;
      if (existingAccountOwner && existingAccountOwner !== authorization.userId) {
        return reject(SYNC_ACCOUNT_OTHER_OWNER_MESSAGE);
      }
      let connectionAttemptReserved = false;
      if (options.arbitrateConnectionAttempt) {
        if (!options.arbitrateConnectionAttempt()) return { kind: "superseded" };
        connectionAttemptReserved = true;
      }
      // A legacy manual (QR/PIN/SSH) record for this same deviceId used to end
      // the handshake right here: the host kept the local record and answered
      // hello_ok with no `accountPairing`, so a signed-in device that no longer
      // held the manual secret could never reconnect without physically
      // returning to the machine. It is adopted instead — the DPoP proof above
      // already established, against the key pinned on THIS record, that the
      // caller is the same physical device, and the account attestation was
      // verified and re-captured under the commit lock.
      const upgradingLegacyPairing = Boolean(existingPairingRecord) && !existingAccountOwner;
      // A PIN re-pair the device has not acknowledged yet is staged on this
      // record. Adoption writes through, which would drop that staged secret
      // and leave the device's `pairing_commit` with nothing to promote. The
      // staging window exists to make a re-pair survive a lost reply, so it
      // wins — the device keeps the secret it already holds.
      if (
        upgradingLegacyPairing
        && existingPairingRecord
        && pairingStore.hasPendingRotation(auth.deviceId)
      ) {
        logger.info(`${logPrefix}.account_adoption_deferred_pending_rotation`, {
          deviceId: auth.deviceId,
        });
        return {
          kind: "authenticated",
          pairingRecord: existingPairingRecord,
          accountPairing: null,
          attestation,
          connectionAttemptReserved,
        };
      }
      // Written through rather than staged. Staging exists to protect a
      // credential the device is still holding across two more round trips, and
      // only PIN pairing has that shape. An account hello has no
      // acknowledgement to arm, and staging deliberately withholds elevations,
      // so a staged adoption would leave the record local for exactly as long
      // as the bug it fixes.
      const paired = pairingStore.pairPeerViaAccount(peer, attestation, {
        dpopPublicKey: existingPairingRecord ? null : auth.dpop?.publicKey ?? null,
        runtimeHostGrant: auth.runtimeHostGrant ?? null,
      });
      // Read-only: this confirms the record we just wrote is readable, and must
      // not be mistaken for the device proving it received the secret (which is
      // what promotes a staged rotation).
      if (!pairingStore.verifySecret(paired.deviceId, paired.secret)) {
        return reject(SYNC_ACCOUNT_PAIRING_WRITE_FAILED_MESSAGE);
      }
      const pairingRecord = pairingStore.getPairingRecord(paired.deviceId);
      if (!pairingRecord) {
        return reject(SYNC_ACCOUNT_PAIRING_WRITE_FAILED_MESSAGE);
      }
      if (upgradingLegacyPairing && options.allowLegacyUpgrade) {
        logger.info(`${logPrefix}.account_legacy_pairing_upgraded`, { deviceId: auth.deviceId });
      }
      return {
        kind: "authenticated",
        pairingRecord,
        accountPairing: { deviceId: paired.deviceId, secret: paired.secret },
        attestation,
        connectionAttemptReserved,
      };
    });
  } catch (error) {
    logger.warn(`${logPrefix}.account_auth_rejected`, {
      deviceId: auth.deviceId,
      reason: typeof (error as { code?: unknown } | null)?.code === "string"
        ? (error as { code: string }).code
        : "verification_failed",
    });
    return reject(SYNC_ACCOUNT_VERIFY_FAILED_MESSAGE);
  }
}
