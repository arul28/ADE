import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { nowIso, safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import {
  isVerifiedAccountAttestation,
  type VerifiedAccountAttestation,
} from "../account/accountAttestationVerifier";
import type { SyncPinStore } from "./syncPinStore";

export type SyncPairingRecord = {
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  peerName: string;
  peerPlatform: string;
  peerDeviceType: string;
  /** Server-issued authorization for full runtime RPC and forwarding. */
  runtimeHostGranted?: boolean;
  /** Server-issued authorization for the narrower sync-host recovery flow. */
  syncHostRecoveryGranted?: boolean;
  /**
   * Base64 X9.63 P-256 public key of the device's Secure Enclave DPoP key.
   * Once present, paired hellos from this device must carry a valid proof.
   */
  dpopPublicKey?: string | null;
  /**
   * Clerk user that created this trust through account adoption. Missing and
   * null are deliberately local/manual for backward compatibility.
   */
  accountOwnerUserId?: string | null;
  /**
   * This pairing was established by QR/PIN/SSH and only later adopted into an
   * account. Ownership lets the account gate re-use it; this flag records that
   * the underlying trust is still the user's own physical act at the Mac, so
   * `revokeAccountOwnedExcept` must not delete it when the Mac signs out or
   * switches accounts. Signing in must never retroactively destroy a machine
   * the user paired by hand.
   */
  localTrustOrigin?: boolean;
  /**
   * A PIN re-pair, or an account adoption's new secret (`secretOnly`), that
   * the device has not proven it received. See `writeNewPairingRecord`: the
   * committed secret stays live until a legacy hello promotes the staged one
   * or a commit-capable client acknowledges hello_ok.
   */
  pendingRotation?: PendingPairingRotation | null;
  /**
   * Hashes of account-adoption secrets that a later staging (another
   * adoption, or a PIN re-pair) displaced from `pendingRotation` before any
   * hello proved them. The device may have saved one, so each still
   * authenticates (the pinned DPoP key still applies) and promotes like the
   * staged secret. Newest first, at most MAX_DISPLACED_ACCOUNT_SECRETS.
   * Proving the staged secret clears it; proving a displaced one keeps the
   * staged rotation and the newer entries. Hosts that predate the field
   * ignore it.
   */
  displacedAccountSecretHashes?: string[];
};

/** A pairing record as committed on disk, with no rotation staged behind it. */
export type CommittedPairingRecord = Omit<SyncPairingRecord, "pendingRotation" | "displacedAccountSecretHashes">;

export type PendingPairingRotation = {
  /** Wall-clock ms after which the staged record is abandoned. */
  expiresAtMs: number;
  /** The complete record that replaces the committed one when promoted. */
  record: CommittedPairingRecord;
  /**
   * Only the secret is staged: the committed record already carries every
   * other field of `record`. Promotion then swaps in the new secret hash and
   * keeps whatever the committed record became meanwhile (an account sign-out
   * that demoted it), instead of restoring the fields of the staging moment.
   * Hosts that predate the flag promote `record` whole, which is the same
   * record at the moment it was staged.
   */
  secretOnly?: boolean;
};

/** How long a staged re-pair waits for the device to prove it received it. */
export const PAIRING_ROTATION_WINDOW_MS = 10 * 60_000;

/**
 * An account adoption's staged secret does not expire. The device gets the new
 * secret inside hello_ok and has no follow-up to arm a window with, so a
 * device that saved the secret and then stayed away would find it dropped.
 * The old secret stays valid meanwhile, which it was before the adoption, and
 * a paired hello still needs the record's pinned DPoP key.
 */
const ACCOUNT_ROTATION_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

/**
 * How many displaced account secrets a record keeps accepting. The host keeps
 * only hashes, so it cannot hand an unproven secret out again: each adoption
 * hello from a device that presents none mints a new one, and a device that
 * lost every one of those replies still holds the oldest. Each is 24 random
 * bytes and still needs the pinned DPoP key, so a generous bound costs a few
 * hash comparisons, never security.
 */
const MAX_DISPLACED_ACCOUNT_SECRETS = 16;

type PairingSecretsFile = Record<string, SyncPairingRecord>;
type RuntimeHostGrantFile = Record<string, { expiresAt: number }>;

type SyncPairingStoreArgs = {
  filePath: string;
  pinStore: SyncPinStore;
};

type NewPairingRecordOptions = {
  dpopPublicKey?: string | null;
  runtimeHostGrant?: string | null;
  /**
   * The sync host sets this only after a correct PIN arrives on a direct
   * LAN/tailnet socket. It must remain false for Relay-origin pairings.
   */
  allowDirectPinRuntimeHost?: boolean;
};

type AuthenticatePairingOptions = {
  /**
   * Accept a staged secret for this hello without retiring the committed one.
   * The authenticated socket must call `commitPendingRotation` after hello_ok.
   */
  deferPendingCommit?: boolean;
};

type NewPairingResult = {
  deviceId: string;
  secret: string;
  pendingRotationExpiresAtMs: number | null;
  /**
   * True when the device proved the secret it already holds and the host kept
   * it. The caller must not hand the secret back: the device has it.
   */
  keptExistingSecret?: boolean;
};

type AccountPairingOptions = NewPairingRecordOptions & {
  /**
   * The paired secret the device says it holds for this host. When it matches
   * the committed or the staged secret, adoption keeps it instead of minting a
   * new one, so no reply can be lost.
   */
  presentedSecret?: string | null;
};

type PairingTrust =
  | { kind: "pin" }
  | { kind: "local" }
  | { kind: "account"; userId: string };

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeAccountOwnerUserId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The recovery grant is only written when a record is created or rewritten, so
 * a device that paired before the grant existed would never receive it — which
 * is every already-paired device. An account-owned phone/browser record already
 * carries the exact evidence the create path decides on (`accountOwnerUserId`
 * is set only by account trust, and PIN/local trust clear it), so derive the
 * grant from the stored record itself — never from anything the connecting
 * client claims — and persist it once on the next successful hello.
 */
function withBackfilledSyncHostRecoveryGrant(record: SyncPairingRecord): SyncPairingRecord {
  if (record.syncHostRecoveryGranted === true) return record;
  if (record.peerDeviceType !== "phone" && record.peerDeviceType !== "browser") return record;
  if (!normalizeAccountOwnerUserId(record.accountOwnerUserId)) return record;
  return { ...record, syncHostRecoveryGranted: true };
}

/**
 * A pairing record's DPoP key must be a base64 uncompressed X9.63 P-256 point
 * (65 bytes, 0x04 prefix). Persisting anything else would fail-closed-lock the
 * device out of every future hello, so malformed input is treated as absent.
 */
export function isValidDpopPublicKey(value: string): boolean {
  try {
    const raw = Buffer.from(value, "base64");
    return raw.length === 65 && raw[0] === 0x04;
  } catch {
    return false;
  }
}

function safeHashEquals(expectedHash: string, actualHash: string): boolean {
  const expected = Buffer.from(expectedHash, "utf8");
  const actual = Buffer.from(actualHash, "utf8");
  if (expected.length !== actual.length) {
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function pairingError(code: "pin_not_set" | "invalid_pin" | "account_not_verified", message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

export function createSyncPairingStore(args: SyncPairingStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
  const runtimeHostGrantPath = `${args.filePath}.runtime-host-grants`;

  const readRecords = (): PairingSecretsFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<PairingSecretsFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const writeRecords = (records: PairingSecretsFile): void => {
    // 0o600 at temp-file creation so pairing secrets/DPoP keys are never
    // world-readable, even briefly before the post-write chmod.
    writeTextAtomic(args.filePath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const readRuntimeHostGrants = (): RuntimeHostGrantFile => {
    if (!fs.existsSync(runtimeHostGrantPath)) return {};
    return safeJsonParse<RuntimeHostGrantFile>(
      fs.readFileSync(runtimeHostGrantPath, "utf8"),
      {},
    );
  };

  const writeRuntimeHostGrants = (grants: RuntimeHostGrantFile): void => {
    writeTextAtomic(runtimeHostGrantPath, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(runtimeHostGrantPath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const consumeRuntimeHostGrant = (token: string | null | undefined): boolean => {
    const normalized = token?.trim();
    if (!normalized) return false;
    const tokenHash = hashSecret(normalized);
    const now = Date.now();
    const grants = readRuntimeHostGrants();
    const granted = (grants[tokenHash]?.expiresAt ?? 0) > now;
    delete grants[tokenHash];
    for (const [hash, entry] of Object.entries(grants)) {
      if (!entry || entry.expiresAt <= now) delete grants[hash];
    }
    writeRuntimeHostGrants(grants);
    return granted;
  };

  /**
   * Drops a staged rotation that nobody claimed. Returns the record to use, or
   * null when `records[deviceId]` is absent. Callers persist when it mutates.
   */
  const pruneExpiredRotation = (
    record: SyncPairingRecord | undefined,
    nowMs: number,
  ): { record: SyncPairingRecord | null; changed: boolean } => {
    if (!record) return { record: null, changed: false };
    const pending = record.pendingRotation;
    if (!pending) return { record, changed: false };
    if (pending.expiresAtMs > nowMs) return { record, changed: false };
    // The device never proved it received the replacement, so the committed
    // secret it is still holding stays authoritative.
    const { pendingRotation: _dropped, ...committed } = record;
    return { record: { ...committed, pendingRotation: null }, changed: true };
  };

  const committedView = (record: SyncPairingRecord): SyncPairingRecord => {
    const { pendingRotation: _pending, displacedAccountSecretHashes: _displaced, ...committed } = record;
    return committed;
  };

  /**
   * The displaced account secrets to keep once `record`'s staged rotation is
   * replaced. Only an account adoption's secret is kept: the device got it in
   * hello_ok and may have saved it. A PIN re-pair's secret expires anyway.
   */
  const displacedAfterRestaging = (record: SyncPairingRecord): string[] | undefined => {
    const pending = record.pendingRotation;
    const kept = [
      ...(pending?.secretOnly ? [pending.record.secretHash] : []),
      ...(record.displacedAccountSecretHashes ?? []),
    ].slice(0, MAX_DISPLACED_ACCOUNT_SECRETS);
    return kept.length > 0 ? kept : undefined;
  };

  /**
   * Which staged secret `presentedHash` proves, if any: the staged rotation,
   * or a displaced account secret. Every comparison is constant-time.
   */
  const matchStagedSecret = (
    record: SyncPairingRecord,
    presentedHash: string,
  ): { kind: "pending"; pending: PendingPairingRotation } | { kind: "displaced"; secretHash: string } | null => {
    const pending = record.pendingRotation;
    if (pending && safeHashEquals(pending.record.secretHash, presentedHash)) return { kind: "pending", pending };
    const displaced = (record.displacedAccountSecretHashes ?? []).find((hash) => safeHashEquals(hash, presentedHash));
    return displaced ? { kind: "displaced", secretHash: displaced } : null;
  };

  /**
   * What stays staged once a displaced secret is proven: everything issued
   * after it. A PIN re-pair waiting for its `pairing_commit` keeps its window,
   * and a newer adoption secret the device may also hold keeps working.
   */
  const stagedAfterDisplacedProof = (
    record: SyncPairingRecord,
    provenHash: string,
  ): Pick<SyncPairingRecord, "pendingRotation" | "displacedAccountSecretHashes"> => {
    const displaced = record.displacedAccountSecretHashes ?? [];
    const newer = displaced.slice(0, Math.max(0, displaced.indexOf(provenHash)));
    return {
      pendingRotation: record.pendingRotation ?? null,
      ...(newer.length > 0 ? { displacedAccountSecretHashes: newer } : {}),
    };
  };

  /**
   * The record a staged rotation becomes once its secret is proven. A
   * secret-only rotation keeps the committed fields as they are now.
   */
  const promotedRecord = (
    entry: SyncPairingRecord,
    staged: NonNullable<ReturnType<typeof matchStagedSecret>>,
  ): CommittedPairingRecord => {
    if (staged.kind === "displaced") return { ...committedView(entry), secretHash: staged.secretHash };
    return staged.pending.secretOnly
      ? { ...committedView(entry), secretHash: staged.pending.record.secretHash }
      : { ...staged.pending.record };
  };

  const writeNewPairingRecord = (
    peer: SyncPeerMetadata,
    options?: AccountPairingOptions,
    trust: PairingTrust = { kind: "pin" },
    stageRotation = false,
  ): NewPairingResult => {
    // Consume every presented grant to preserve its one-time semantics. A
    // direct LAN/tailnet PIN may authorize a desktop runtime host explicitly;
    // Relay PIN pairing never gets that exception. Verified same-owner account
    // pairing and local OS/SSH trust retain their existing authorization paths.
    const consumedRuntimeHostGrant = consumeRuntimeHostGrant(options?.runtimeHostGrant);
    // A same-owner Clerk attestation is itself the approved account hop gate.
    // Only desktop peers receive runtime RPC; phone/browser peers remain on the
    // mobile allowlist even when they authenticate with the same account.
    const secret = randomBytes(24).toString("hex");
    const records = readRecords();
    // Always decide against the COMMITTED record. A second re-pair arriving
    // while a rotation is still staged replaces that staged record; it never
    // chains off it, so at most one rotation is ever outstanding.
    const existing = records[peer.deviceId] ?? null;
    const existingAccountOwnerUserId = normalizeAccountOwnerUserId(existing?.accountOwnerUserId);
    let accountOwnerUserId: string | null = null;
    // Sticky once set: a later re-pair or account switch never erases the fact
    // that this trust started at the Mac.
    let localTrustOrigin = existing?.localTrustOrigin === true;
    if (trust.kind === "account") {
      const requestedOwnerUserId = trust.userId.trim();
      if (!requestedOwnerUserId) {
        throw pairingError("account_not_verified", "Account identity is required.");
      }
      // Adopting a legacy manual (QR/PIN/SSH) record into the account. This
      // used to throw outright, which stranded any signed-in device that had
      // lost its stored secret: the record on the Mac stayed local forever and
      // the only escape was walking back to the Mac. Adoption is safe because
      // the caller has already verified a DPoP proof against the key pinned on
      // THIS record — that pinned key is the sole evidence that the signing-in
      // device is the same physical device that paired manually. A record with
      // no pinned key carries no such evidence, so it is still refused here
      // (the sync host refuses it earlier too; this is the store-level backstop
      // for any other caller).
      // Validity, not truthiness — a whitespace-only field is not a pinned key,
      // and treating it as one would let the DPoP check fall back to TOFU
      // against a caller-supplied key. Matches the host-side guard.
      if (existing && !existingAccountOwnerUserId && !isValidDpopPublicKey(existing.dpopPublicKey ?? "")) {
        throw pairingError(
          "account_not_verified",
          "A local pairing without a device key cannot be adopted through account sign-in.",
        );
      }
      if (existingAccountOwnerUserId && existingAccountOwnerUserId !== requestedOwnerUserId) {
        throw pairingError(
          "account_not_verified",
          "This device pairing belongs to a different ADE account.",
        );
      }
      accountOwnerUserId = requestedOwnerUserId;
      // Adoption grants the account a way to USE this pairing; it does not
      // convert who created it. Without this the record would join the set
      // `revokeAccountOwnedExcept` deletes on sign-out, so one account hello
      // would silently make a hand-paired machine destructible — the exact
      // failure this whole change exists to remove.
      if (existing && !existingAccountOwnerUserId) {
        localTrustOrigin = true;
      }
    }
    const runtimeHostGranted = peer.deviceType === "desktop"
      && (
        consumedRuntimeHostGrant
        || trust.kind === "account"
        || trust.kind === "local"
        || (trust.kind === "pin" && options?.allowDirectPinRuntimeHost === true)
      );
    // Host recovery is narrower than runtime RPC, but it still changes
    // machine processes. Only an account-attested phone/browser receives this
    // grant; a PIN-only mobile pairing remains read-only at the brain ingress.
    const syncHostRecoveryGranted = (peer.deviceType === "phone" || peer.deviceType === "browser")
      && trust.kind === "account";
    const offeredDpopKey = options?.dpopPublicKey?.trim() || null;
    const validatedOfferedDpopKey = offeredDpopKey && isValidDpopPublicKey(offeredDpopKey)
      ? offeredDpopKey
      : null;
    const dpopPublicKey = trust.kind === "account" && existing?.dpopPublicKey
      ? existing.dpopPublicKey
      : validatedOfferedDpopKey ?? existing?.dpopPublicKey ?? null;
    const replacement: CommittedPairingRecord = {
      secretHash: hashSecret(secret),
      createdAt: existing?.createdAt ?? nowIso(),
      lastUsedAt: null,
      peerName: peer.deviceName,
      peerPlatform: peer.platform,
      peerDeviceType: peer.deviceType,
      runtimeHostGranted,
      syncHostRecoveryGranted,
      localTrustOrigin,
      // A gated re-pair may introduce or rotate the key when its caller allows
      // that. Omitting a key preserves the existing binding without downgrade.
      dpopPublicKey,
      // PIN and local OS/SSH trust explicitly declassify an older account
      // record. A legacy record with no field remains local until rewritten.
      accountOwnerUserId,
    };
    // Re-pairing used to overwrite the record the instant the host answered,
    // two round trips before the device could persist the reply. A drop in that
    // gap left the host holding credentials the device never saw, and the only
    // way out was walking back to the Mac for another PIN. So a re-pair now
    // STAGES: the committed secret the device is still holding stays live, and
    // the replacement waits for a legacy hello or a commit-capable client's
    // post-hello acknowledgement. Nothing to promote means nothing was lost —
    // the staged record simply expires. A first-time pair has no committed
    // secret to protect and is written straight through.
    if (stageRotation && existing) {
      const expiresAtMs = Date.now() + PAIRING_ROTATION_WINDOW_MS;
      records[peer.deviceId] = {
        ...committedView(existing),
        // Descriptive fields are not credentials, so a phone that was renamed
        // shows its new name immediately instead of after a handshake the user
        // cannot see.
        peerName: replacement.peerName,
        peerPlatform: replacement.peerPlatform,
        peerDeviceType: replacement.peerDeviceType,
        // Elevations wait for proof; reductions must not. Staging a PIN
        // re-pair's declassification would leave the record account-owned, so
        // the next account switch would revoke the very pairing the user just
        // re-established at the Mac. Same reasoning for a lost runtime-host
        // grant: withdrawing authority late is a privilege leak, withdrawing it
        // early costs at most one re-grant.
        accountOwnerUserId: replacement.accountOwnerUserId === null
          ? null
          : existing.accountOwnerUserId ?? null,
        runtimeHostGranted: replacement.runtimeHostGranted === false
          ? false
          : existing.runtimeHostGranted,
        syncHostRecoveryGranted: replacement.syncHostRecoveryGranted === false
          ? false
          : existing.syncHostRecoveryGranted,
        pendingRotation: { expiresAtMs, record: replacement },
        // A phone may hold an adoption's secret it never proved. A PIN reply
        // lost now must not take that one away too.
        displacedAccountSecretHashes: displacedAfterRestaging(existing),
      };
      writeRecords(records);
      return { deviceId: peer.deviceId, secret, pendingRotationExpiresAtMs: expiresAtMs };
    }
    // Account adoption of a record that already exists. It used to write the
    // new secret straight through before hello_ok left this machine, so a drop
    // before the device saved the reply left the two ends on different
    // secrets, with "pair it again" as the only way out. Now the device keeps
    // whichever secret it holds:
    // - It proved the secret it holds: keep that secret, mint nothing.
    // - It did not (an older client, or one that lost its secret): stage the
    //   new secret behind the committed one. The account's authority applies
    //   now, because the attestation is the proof; only the secret waits for
    //   the first hello that authenticates with it.
    if (trust.kind === "account" && existing) {
      const current = pruneExpiredRotation(existing, Date.now()).record!;
      const presented = options?.presentedSecret?.trim() || null;
      const presentedHash = presented ? hashSecret(presented) : null;
      const provedCommitted = presentedHash != null && safeHashEquals(current.secretHash, presentedHash);
      const provedStaged = !provedCommitted && presentedHash != null
        ? matchStagedSecret(current, presentedHash)
        : null;
      if (presented && (provedCommitted || provedStaged)) {
        records[peer.deviceId] = provedCommitted
          ? {
            ...replacement,
            secretHash: current.secretHash,
            lastUsedAt: nowIso(),
            // A staged secret is not this device's to discard: it may hold it
            // in a store another process writes.
            pendingRotation: current.pendingRotation ?? null,
            displacedAccountSecretHashes: current.displacedAccountSecretHashes,
          }
          : provedStaged!.kind === "pending"
            ? {
              // Proving the staged secret promotes it and retires the rest.
              ...replacement,
              secretHash: provedStaged!.pending.record.secretHash,
              lastUsedAt: nowIso(),
              pendingRotation: null,
            }
            : {
              ...replacement,
              secretHash: provedStaged!.secretHash,
              lastUsedAt: nowIso(),
              ...stagedAfterDisplacedProof(current, provedStaged!.secretHash),
            };
        writeRecords(records);
        return {
          deviceId: peer.deviceId,
          secret: presented,
          pendingRotationExpiresAtMs: null,
          keptExistingSecret: true,
        };
      }
      records[peer.deviceId] = {
        ...replacement,
        secretHash: current.secretHash,
        lastUsedAt: current.lastUsedAt,
        pendingRotation: {
          expiresAtMs: ACCOUNT_ROTATION_EXPIRES_AT_MS,
          record: replacement,
          secretOnly: true,
        },
        // The secret staged before this one left in an earlier hello_ok. A
        // device that saved it and then lost this reply must keep working.
        displacedAccountSecretHashes: displacedAfterRestaging(current),
      };
      writeRecords(records);
      // No window for the caller to arm: the staged secret never expires and
      // the first hello that presents it promotes it.
      return { deviceId: peer.deviceId, secret, pendingRotationExpiresAtMs: null };
    }
    records[peer.deviceId] = replacement;
    writeRecords(records);
    return {
      deviceId: peer.deviceId,
      secret,
      pendingRotationExpiresAtMs: null,
    };
  };

  return {
    issueRuntimeHostGrant(ttlMs = 10 * 60_000): string {
      const token = randomBytes(32).toString("base64url");
      const grants = readRuntimeHostGrants();
      const now = Date.now();
      for (const [hash, entry] of Object.entries(grants)) {
        if (!entry || entry.expiresAt <= now) delete grants[hash];
      }
      grants[hashSecret(token)] = {
        expiresAt: now + Math.max(1_000, Math.floor(ttlMs)),
      };
      writeRuntimeHostGrants(grants);
      return token;
    },

    /**
     * PIN pairing over the wire. Its credential crosses two more round trips
     * (pairing_result, then hello) before the device can persist it, so a
     * re-pair stages behind the committed secret for PAIRING_ROTATION_WINDOW_MS.
     * Account adoption stages too, without a window (see
     * `writeNewPairingRecord`); local OS/SSH trust hands the secret back
     * in-process and writes straight through.
     */
    pairPeer(
      peer: SyncPeerMetadata,
      pin: string,
      options?: NewPairingRecordOptions,
    ): NewPairingResult {
      if (!args.pinStore.hasPin()) {
        throw pairingError("pin_not_set", "No pairing PIN is set on this computer.");
      }
      if (!args.pinStore.verifyPin(pin)) {
        throw pairingError("invalid_pin", "Incorrect pairing PIN.");
      }
      return writeNewPairingRecord(peer, options, { kind: "pin" }, true);
    },

    /**
     * Mints (or rotates) a pairing from a verified same-account attestation.
     * This also ADOPTS a legacy manual record for the same deviceId — see
     * `writeNewPairingRecord` for why that is safe and what it still refuses.
     */
    pairPeerViaAccount(
      peer: SyncPeerMetadata,
      attestation: VerifiedAccountAttestation,
      options?: AccountPairingOptions,
    ): NewPairingResult {
      if (!isVerifiedAccountAttestation(attestation)) {
        throw pairingError("account_not_verified", "Account attestation was not verified.");
      }
      return writeNewPairingRecord(peer, options, {
        kind: "account",
        userId: attestation.userId,
      });
    },

    /**
     * Pair a device whose operator has already authenticated as a local OS
     * user. This is intentionally not reachable from the sync wire protocol;
     * the machine-local RPC/CLI adapter is the only caller. A desktop peer is
     * granted runtime-host access because the SSH login is the authorization
     * gate, while phone/browser peers remain confined to the mobile allowlist.
     */
    pairPeerViaLocalTrust(
      peer: SyncPeerMetadata,
      options?: NewPairingRecordOptions,
    ): NewPairingResult {
      return writeNewPairingRecord(peer, options, { kind: "local" });
    },

    /**
     * TOFU upgrade for legacy pairings: adopt a device key on the next
     * successfully authenticated connection. Returns false when a different
     * key is already on record (never silently swap keys outside re-pairing).
     */
    adoptDpopPublicKey(deviceId: string, dpopPublicKey: string): boolean {
      const normalized = deviceId.trim();
      const key = dpopPublicKey.trim();
      if (!normalized || !key || !isValidDpopPublicKey(key)) return false;
      const records = readRecords();
      const entry = records[normalized];
      if (!entry) return false;
      if (entry.dpopPublicKey) return entry.dpopPublicKey === key;
      entry.dpopPublicKey = key;
      writeRecords(records);
      return true;
    },

    /**
     * Authenticates a device. Legacy clients promote a staged secret when their
     * hello proves possession. Commit-capable clients defer that promotion until
     * their post-hello `pairing_commit`, keeping both secrets valid across a
     * dropped hello_ok.
     */
    authenticate(
      deviceId: string,
      secret: string,
      options: AuthenticatePairingOptions = {},
    ): boolean {
      const normalized = deviceId.trim();
      if (!normalized) return false;
      const records = readRecords();
      const pruned = pruneExpiredRotation(records[normalized], Date.now());
      const entry = pruned.record;
      if (!entry) return false;
      const presented = hashSecret(secret);
      if (safeHashEquals(entry.secretHash, presented)) {
        records[normalized] = withBackfilledSyncHostRecoveryGrant({
          ...entry,
          lastUsedAt: nowIso(),
        });
        writeRecords(records);
        return true;
      }
      const staged = matchStagedSecret(entry, presented);
      if (staged) {
        const pending = staged.kind === "pending" ? staged.pending : null;
        if (options.deferPendingCommit && pending) {
          // Backfills the committed record only. The staged replacement keeps
          // whatever the re-pair decided, so rotation staging is untouched.
          records[normalized] = withBackfilledSyncHostRecoveryGrant({
            ...entry,
            pendingRotation: {
              ...pending,
              record: { ...pending.record, lastUsedAt: nowIso() },
            },
          });
        } else {
          records[normalized] = withBackfilledSyncHostRecoveryGrant({
            ...promotedRecord(entry, staged),
            lastUsedAt: nowIso(),
            ...(staged.kind === "displaced" ? stagedAfterDisplacedProof(entry, staged.secretHash) : {}),
          });
        }
        writeRecords(records);
        return true;
      }
      if (pruned.changed) {
        records[normalized] = entry;
        writeRecords(records);
      }
      return false;
    },

    /**
     * Returns the record whose secret authenticated this socket. Unlike
     * `getPairingRecord`, this may expose the staged replacement to the one
     * connection that proved it, while every unrelated authorization read
     * continues to see only the committed record.
     */
    getPairingRecordForSecret(deviceId: string, secret: string): SyncPairingRecord | null {
      const normalized = deviceId.trim();
      if (!normalized) return null;
      const entry = pruneExpiredRotation(readRecords()[normalized], Date.now()).record;
      if (!entry) return null;
      const presented = hashSecret(secret);
      if (safeHashEquals(entry.secretHash, presented)) return committedView(entry);
      const staged = matchStagedSecret(entry, presented);
      return staged ? promotedRecord(entry, staged) : null;
    },

    /**
     * Promotes the replacement only after a socket authenticated with it and
     * received hello_ok. The host owns that session check; the store makes the
     * mutation atomic and refuses absent/expired rotations.
     */
    commitPendingRotation(deviceId: string, authenticatedSecret: string): SyncPairingRecord | null {
      const normalized = deviceId.trim();
      if (!normalized) return null;
      const records = readRecords();
      const pruned = pruneExpiredRotation(records[normalized], Date.now());
      const pending = pruned.record?.pendingRotation;
      const presented = hashSecret(authenticatedSecret);
      if (!pending || !safeHashEquals(pending.record.secretHash, presented)) {
        if (pruned.changed && pruned.record) {
          records[normalized] = pruned.record;
          writeRecords(records);
        }
        return null;
      }
      records[normalized] = { ...promotedRecord(pruned.record!, { kind: "pending", pending }), lastUsedAt: nowIso() };
      writeRecords(records);
      return committedView(records[normalized]!);
    },

    /**
     * Read-only counterpart of `authenticate` for callers that only need to
     * confirm a secret they just minted is on record. It must not promote:
     * writing a record is not the device receiving it.
     */
    verifySecret(deviceId: string, secret: string): "committed" | "pending" | null {
      const normalized = deviceId.trim();
      if (!normalized) return null;
      const entry = pruneExpiredRotation(readRecords()[normalized], Date.now()).record;
      if (!entry) return null;
      const presented = hashSecret(secret);
      if (safeHashEquals(entry.secretHash, presented)) return "committed";
      return matchStagedSecret(entry, presented) ? "pending" : null;
    },

    /**
     * Whether an unproven PIN re-pair is still waiting on this device. An
     * account adoption's staged secret does not count: it never expires, so
     * treating it like a PIN re-pair would defer every later adoption.
     */
    hasPendingPinRotation(deviceId: string): boolean {
      const normalized = deviceId.trim();
      if (!normalized) return false;
      const pending = pruneExpiredRotation(readRecords()[normalized], Date.now()).record?.pendingRotation;
      return Boolean(pending && !pending.secretOnly);
    },

    /** Whether an unproven re-pair is still waiting on this device. */
    hasPendingRotation(deviceId: string): boolean {
      const normalized = deviceId.trim();
      if (!normalized) return false;
      const entry = pruneExpiredRotation(readRecords()[normalized], Date.now()).record;
      return Boolean(entry?.pendingRotation);
    },

    /**
     * The committed record. A staged rotation is deliberately not visible here:
     * every authorization decision (DPoP key, account owner, runtime grant) has
     * to read what is live right now, not what a device might promote later.
     */
    getPairingRecord(deviceId: string): SyncPairingRecord | null {
      const normalized = deviceId.trim();
      if (!normalized) return null;
      const entry = pruneExpiredRotation(readRecords()[normalized], Date.now()).record;
      return entry ? committedView(entry) : null;
    },

    hasPairingRecord(deviceId: string): boolean {
      const normalized = deviceId.trim();
      if (!normalized) return false;
      return readRecords()[normalized] != null;
    },

    countPairingRecords(): number | null {
      if (!fs.existsSync(args.filePath)) return 0;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(args.filePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return Object.keys(parsed).length;
      } catch {
        // A damaged registry is not evidence that there are no paired peers.
        return null;
      }
    },

    revoke(deviceId: string): void {
      const normalized = deviceId.trim();
      if (!normalized) return;
      const records = readRecords();
      if (!(normalized in records)) return;
      delete records[normalized];
      writeRecords(records);
    },

    revokeAccountOwnedExcept(currentOwnerUserId: string | null): string[] {
      const currentOwner = currentOwnerUserId?.trim() || null;
      const records = readRecords();
      const removed: string[] = [];
      let demoted = false;
      for (const [deviceId, record] of Object.entries(records)) {
        const owner = normalizeAccountOwnerUserId(record?.accountOwnerUserId);
        // Missing/null provenance is legacy or explicitly local trust.
        if (!owner || owner === currentOwner) continue;
        // Adopted-from-manual pairings must survive, but SURVIVING IS NOT
        // ENOUGH: every reconnect path rejects a record whose owner no longer
        // matches the signed-in account, so merely skipping the delete would
        // leave it intact and permanently unusable — the same dead end, moved.
        // Demote it back to the pure local trust it came from. The owner gate
        // then has nothing to reject, and a later account hello re-adopts it.
        if (record?.localTrustOrigin === true) {
          if (records[deviceId]) {
            // The host-recovery grant is account-derived, so it cannot outlive
            // the ownership it came from: a demoted record is local trust
            // again, and local trust never conveys process control. Withdrawing
            // it here costs at most one re-grant on the next account hello,
            // which `withBackfilledSyncHostRecoveryGrant` performs; leaving it
            // would let a phone the switched-away account paired keep stopping
            // and restarting runtimes on this machine.
            records[deviceId] = {
              ...records[deviceId],
              accountOwnerUserId: null,
              syncHostRecoveryGranted: false,
            };
            demoted = true;
          }
          continue;
        }
        delete records[deviceId];
        removed.push(deviceId);
      }
      // A demotion is a real mutation even when nothing was deleted, so the
      // write cannot be gated on `removed` alone.
      if (removed.length > 0 || demoted) writeRecords(records);
      return removed;
    },
  };
}

export type SyncPairingStore = ReturnType<typeof createSyncPairingStore>;
