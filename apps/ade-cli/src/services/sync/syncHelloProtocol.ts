import type {
  SyncHelloPayload,
  SyncPairingRequestPayload,
  SyncPeerMetadata,
} from "../../../../desktop/src/shared/types";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import { normalizeSyncApplicationCompressionOffer } from "./syncProtocol";

/**
 * The ONE parser for `hello` and `pairing_request` payloads.
 *
 * There used to be two. The project-scoped sync host had this implementation;
 * the brain's projectless fallback ingress handler
 * (`brainProjectActionsSyncHandler`) had a narrower hand-rolled copy that knew
 * only `bootstrap` and `paired` auth. Every client that grew a new auth shape —
 * the web client's `account` hello, the desktop's `account_sealed` adoption —
 * was answered by the fallback with a flat "Invalid hello payload." on a
 * machine that had never opened a project, which is exactly the machine those
 * clients are supposed to be able to reach. The copy also silently dropped
 * `connectionAttempt`, so route arbitration was blind on that path.
 *
 * Patching the copy is what previous fixes did, and it drifted again within a
 * release each time. There is no copy now: both ingress paths import this.
 */

export const CONNECTION_ATTEMPT_ID_MAX_CHARS = 128;
export const CONNECTION_ATTEMPT_MAX_FUTURE_MS = 5 * 60_000;

/** Bearer-ish credentials carried in a hello; bounded so a socket cannot mint work. */
const MAX_RELAY_ACCOUNT_TOKEN_CHARS = 16_384;

export function parseHelloPayload(payload: unknown): SyncHelloPayload | null {
  const value = payload as SyncHelloPayload | null;
  const peer = value?.peer;
  if (!peer || typeof peer !== "object") return null;
  if (!toOptionalString(peer.deviceId) || !toOptionalString(peer.deviceName) || !toOptionalString(peer.siteId)) {
    return null;
  }
  const auth = value?.auth;
  let normalizedAuth = auth ?? null;
  if (!normalizedAuth) {
    const token = toOptionalString(value?.token);
    if (!token) return null;
    normalizedAuth = {
      kind: "bootstrap",
      token,
    };
  }
  if (normalizedAuth.kind === "bootstrap") {
    if (!toOptionalString(normalizedAuth.token)) return null;
  } else if (normalizedAuth.kind === "paired") {
    if (!toOptionalString(normalizedAuth.deviceId) || !toOptionalString(normalizedAuth.secret)) return null;
    if (
      normalizedAuth.relayAccountToken != null
      && (
        !toOptionalString(normalizedAuth.relayAccountToken)
        || normalizedAuth.relayAccountToken.length > MAX_RELAY_ACCOUNT_TOKEN_CHARS
      )
    ) return null;
  } else if (normalizedAuth.kind === "account") {
    if (!toOptionalString(normalizedAuth.deviceId) || !toOptionalString(normalizedAuth.accountToken)) return null;
    if (
      normalizedAuth.dpop != null
      && (typeof normalizedAuth.dpop !== "object" || Array.isArray(normalizedAuth.dpop))
    ) return null;
    if (normalizedAuth.runtimeHostGrant != null && !toOptionalString(normalizedAuth.runtimeHostGrant)) return null;
  } else if (normalizedAuth.kind === "account_sealed") {
    if (
      normalizedAuth.v !== 1
      || !toOptionalString(normalizedAuth.deviceId)
      || !toOptionalString(normalizedAuth.sealed)
    ) return null;
  } else {
    return null;
  }
  const dbVersionBySite: Record<string, number> = {};
  if (peer.dbVersionBySite && typeof peer.dbVersionBySite === "object" && !Array.isArray(peer.dbVersionBySite)) {
    for (const [site, version] of Object.entries(peer.dbVersionBySite)) {
      const normalizedSite = site.trim();
      const normalizedVersion = Number(version);
      if (normalizedSite && Number.isFinite(normalizedVersion) && normalizedVersion >= 0) {
        dbVersionBySite[normalizedSite] = Math.floor(normalizedVersion);
      }
    }
  }
  const rawConnectionAttempt = peer.connectionAttempt;
  let connectionAttempt: SyncPeerMetadata["connectionAttempt"];
  if (rawConnectionAttempt != null) {
    const id = toOptionalString(rawConnectionAttempt.id);
    const startedAtMs = Number(rawConnectionAttempt.startedAtMs);
    if (
      !id
      || id.length > CONNECTION_ATTEMPT_ID_MAX_CHARS
      || !/^[A-Za-z0-9._:-]+$/.test(id)
      || !Number.isSafeInteger(startedAtMs)
      || startedAtMs <= 0
      || startedAtMs > Date.now() + CONNECTION_ATTEMPT_MAX_FUTURE_MS
    ) return null;
    connectionAttempt = { id, startedAtMs };
  }
  return {
    peer: {
      deviceId: String(peer.deviceId).trim(),
      deviceName: String(peer.deviceName).trim(),
      platform: peer.platform ?? "unknown",
      deviceType: peer.deviceType ?? "unknown",
      siteId: String(peer.siteId).trim(),
      dbVersion: Number(peer.dbVersion ?? 0),
      ...(Object.keys(dbVersionBySite).length > 0 ? { dbVersionBySite } : {}),
      ...(connectionAttempt ? { connectionAttempt } : {}),
      capabilities: Array.isArray(peer.capabilities)
        ? peer.capabilities
          .filter((capability): capability is string => typeof capability === "string")
          .map((capability) => capability.trim())
          .filter(Boolean)
        : [],
      ...(toOptionalString(peer.appVersion) ? { appVersion: toOptionalString(peer.appVersion)! } : {}),
      ...(toOptionalString(peer.appBuild) ? { appBuild: toOptionalString(peer.appBuild)! } : {}),
      ...(toOptionalString(peer.bundleIdentifier) ? { bundleIdentifier: toOptionalString(peer.bundleIdentifier)! } : {}),
    },
    auth: normalizedAuth,
    compression: normalizeSyncApplicationCompressionOffer(value?.compression),
  };
}

export function parsePairingRequestPayload(payload: unknown): SyncPairingRequestPayload | null {
  const value = payload as SyncPairingRequestPayload | null;
  const code = toOptionalString(value?.code);
  const peer = value?.peer;
  if (!code || !peer || typeof peer !== "object") return null;
  if (!toOptionalString(peer.deviceId) || !toOptionalString(peer.deviceName) || !toOptionalString(peer.siteId)) {
    return null;
  }
  const dpopPublicKey = toOptionalString(value?.dpopPublicKey);
  const relayAccountToken = toOptionalString(value?.relayAccountToken);
  if (
    value?.relayAccountToken != null
    && (!relayAccountToken || relayAccountToken.length > MAX_RELAY_ACCOUNT_TOKEN_CHARS)
  ) {
    return null;
  }
  const runtimeHostGrant = toOptionalString(value?.runtimeHostGrant);
  const pairingCommitVersion = value?.pairingCommitVersion === 1 ? 1 : null;
  return {
    code,
    peer: {
      deviceId: String(peer.deviceId).trim(),
      deviceName: String(peer.deviceName).trim(),
      platform: peer.platform ?? "unknown",
      deviceType: peer.deviceType ?? "unknown",
      siteId: String(peer.siteId).trim(),
      dbVersion: Number(peer.dbVersion ?? 0),
    },
    ...(dpopPublicKey ? { dpopPublicKey } : {}),
    ...(relayAccountToken ? { relayAccountToken } : {}),
    ...(runtimeHostGrant ? { runtimeHostGrant } : {}),
    ...(pairingCommitVersion ? { pairingCommitVersion } : {}),
  };
}
