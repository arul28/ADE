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
   * A PIN re-pair that the device has not proven it received. See
   * `writeNewPairingRecord`: the fields above stay live and authoritative until
   * a legacy hello promotes the staged secret or a commit-capable client
   * acknowledges hello_ok.
   */
  pendingRotation?: PendingPairingRotation | null;
};

/** A pairing record as committed on disk, with no rotation staged behind it. */
export type CommittedPairingRecord = Omit<SyncPairingRecord, "pendingRotation">;

export type PendingPairingRotation = {
  /** Wall-clock ms after which the staged record is abandoned. */
  expiresAtMs: number;
  /** The complete record that replaces the committed one when promoted. */
  record: CommittedPairingRecord;
};

/** How long a staged re-pair waits for the device to prove it received it. */
export const PAIRING_ROTATION_WINDOW_MS = 10 * 60_000;

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
    const { pendingRotation: _pending, ...committed } = record;
    return committed;
  };

  const writeNewPairingRecord = (
    peer: SyncPeerMetadata,
    options?: NewPairingRecordOptions,
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
    if (trust.kind === "account") {
      const requestedOwnerUserId = trust.userId.trim();
      if (!requestedOwnerUserId) {
        throw pairingError("account_not_verified", "Account identity is required.");
      }
      if (existing && !existingAccountOwnerUserId) {
        throw pairingError(
          "account_not_verified",
          "A local pairing cannot be replaced through account sign-in.",
        );
      }
      if (existingAccountOwnerUserId && existingAccountOwnerUserId !== requestedOwnerUserId) {
        throw pairingError(
          "account_not_verified",
          "This device pairing belongs to a different ADE account.",
        );
      }
      accountOwnerUserId = requestedOwnerUserId;
    }
    const runtimeHostGranted = peer.deviceType === "desktop"
      && (
        consumedRuntimeHostGrant
        || trust.kind === "account"
        || trust.kind === "local"
        || (trust.kind === "pin" && options?.allowDirectPinRuntimeHost === true)
      );
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
        // Only the secret and the privileges it carries wait for the
        // acknowledgement. Descriptive fields are not credentials, so a phone
        // that was renamed shows its new name immediately instead of after a
        // handshake the user cannot see.
        peerName: replacement.peerName,
        peerPlatform: replacement.peerPlatform,
        peerDeviceType: replacement.peerDeviceType,
        pendingRotation: { expiresAtMs, record: replacement },
      };
      writeRecords(records);
      return { deviceId: peer.deviceId, secret, pendingRotationExpiresAtMs: expiresAtMs };
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
     * PIN pairing over the wire. This is the only entry point that stages its
     * rotation: it is the one whose credential crosses two more round trips
     * (pairing_result, then hello) before the device can persist it, and the
     * only one whose recovery costs the user a walk back to the Mac. Account
     * adoption returns its secret inside `hello_ok` with no acknowledged
     * follow-up, so staging it would strand devices that never send another
     * hello; local OS/SSH trust hands the secret back in-process.
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

    pairPeerViaAccount(
      peer: SyncPeerMetadata,
      attestation: VerifiedAccountAttestation,
      options?: NewPairingRecordOptions,
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
        records[normalized] = { ...entry, lastUsedAt: nowIso() };
        writeRecords(records);
        return true;
      }
      const pending = entry.pendingRotation;
      if (pending && safeHashEquals(pending.record.secretHash, presented)) {
        if (options.deferPendingCommit) {
          records[normalized] = {
            ...entry,
            pendingRotation: {
              ...pending,
              record: { ...pending.record, lastUsedAt: nowIso() },
            },
          };
        } else {
          records[normalized] = { ...pending.record, lastUsedAt: nowIso() };
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
      const pending = entry.pendingRotation;
      return pending && safeHashEquals(pending.record.secretHash, presented)
        ? { ...pending.record }
        : null;
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
      records[normalized] = { ...pending.record, lastUsedAt: nowIso() };
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
      const pending = entry.pendingRotation;
      if (pending && safeHashEquals(pending.record.secretHash, presented)) return "pending";
      return null;
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
      for (const [deviceId, record] of Object.entries(records)) {
        const owner = normalizeAccountOwnerUserId(record?.accountOwnerUserId);
        // Missing/null provenance is legacy or explicitly local trust.
        if (!owner || owner === currentOwner) continue;
        delete records[deviceId];
        removed.push(deviceId);
      }
      if (removed.length > 0) writeRecords(records);
      return removed;
    },
  };
}

export type SyncPairingStore = ReturnType<typeof createSyncPairingStore>;
