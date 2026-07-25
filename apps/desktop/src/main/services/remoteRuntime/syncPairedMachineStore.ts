import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type {
  DesktopPairedMachineEndpointState,
  DesktopPairedMachineCredentials,
  DesktopPairedMachinesFile,
  PairedRuntimeHelloOkPayload,
} from "../../../shared/types/pairedRuntime";
import type {
  SyncPairingHostIdentity,
  SyncAccountChallengeOkPayload,
  SyncHelloPayload,
  SyncPairingResultPayload,
  SyncPeerMetadata,
} from "../../../shared/types/sync";
import {
  ADOPT_CHANNEL_CHALLENGE_TIMEOUT_MS,
  ADOPT_CHANNEL_MAX_CLOCK_SKEW_MS,
  buildAdoptChallengeSignatureInput,
  buildAdoptHelloAad,
  buildAdoptHelloOkAad,
  decodeCanonicalBase64,
  deriveAdoptSessionKey,
  generateX25519EphemeralKeyPair,
  seal,
  supportedAdoptChannelAeads,
  unseal,
  verifyEd25519,
  type AdoptChannelAead,
} from "../../../shared/sync/adoptChannelCrypto";
import type { AdeAccountMachine } from "../../../shared/types/account";
import {
  accountMachineAdoptionRoutes,
  accountMachinePairedSyncEndpoints,
  resolveAccountHelloPairing,
  type AccountMachineAdoptionRoute,
} from "../../../shared/accountDirectory";
import {
  buildDesktopPairedHello,
  createDesktopSyncDpopProof,
  normalizeSyncEndpoint,
  openSyncEnvelopeConnection,
  waitForSyncEnvelope,
  type OpenSyncEnvelopeConnectionOptions,
  type SyncEnvelopeConnection,
} from "./syncRuntimeTransport";
import { MAX_ROUTE_ATTEMPTS } from "./pairedRuntimeRoutes";

const STORE_FILE_NAME = "desktop-paired-machines.json";
const DEFAULT_PAIRING_TIMEOUT_MS = 15_000;

export type PairWithMachineOptions = Omit<
  OpenSyncEnvelopeConnectionOptions,
  "endpoint"
> & {
  appVersion?: string;
  pairingTimeoutMs?: number;
  relayAccountToken?: string | null;
  runtimeHostGrant?: string | null;
};

export type PairWithAccountMachineOptions = Omit<
  OpenSyncEnvelopeConnectionOptions,
  "endpoint"
> & {
  appVersion?: string;
  pairingTimeoutMs?: number;
  relayBaseUrls?: readonly string[];
  accountOwnerUserId: string;
  authorizeAccountCommit?: (
    expectedOwnerUserId: string,
  ) => boolean | Promise<boolean>;
  onStage?: (stage: {
    kind: "relay" | "tailnet" | "lan";
    phase: "connecting" | "verifying";
  }) => void;
};

class AccountPairingAuthorizationError extends Error {
  readonly code = "account_session_changed";
}

const HOST_IDENTITY_VERIFICATION_ERROR =
  "Host identity verification failed — the machine may be running an older ADE.";
const ADOPT_CHANNEL_UPDATE_REQUIRED_ERROR =
  "The other Mac is running an older ADE that can't negotiate a compatible cipher — update it to the latest version.";

export class AccountHostIdentityVerificationError extends Error {
  readonly code = "account_host_identity_verification_failed";

  constructor() {
    super(HOST_IDENTITY_VERIFICATION_ERROR);
    this.name = "AccountHostIdentityVerificationError";
  }
}

function hostIdentityVerificationError(): AccountHostIdentityVerificationError {
  return new AccountHostIdentityVerificationError();
}

function parseDirectoryEd25519PublicKey(value: string): Buffer {
  const prefix = "ed25519:";
  if (!value.startsWith(prefix)) throw hostIdentityVerificationError();
  const raw = decodeCanonicalBase64(value.slice(prefix.length), 32);
  if (!raw) throw hostIdentityVerificationError();
  return raw;
}

type AccountMachineAdoptionFailure = {
  route: AccountMachineAdoptionRoute;
  reason: string;
};

function emitAccountMachineAdoptionStage(
  callback: PairWithAccountMachineOptions["onStage"],
  stage: Parameters<NonNullable<PairWithAccountMachineOptions["onStage"]>>[0],
): void {
  try {
    callback?.(stage);
  } catch {
    // Progress reporting is best-effort and must not abort adoption.
  }
}

function boundedInlineText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim() || "Unknown failure.";
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function accountMachineAdoptionRouteHost(route: AccountMachineAdoptionRoute): string {
  try {
    return boundedInlineText(new URL(route.endpoint).hostname, 96);
  } catch {
    return boundedInlineText(route.endpoint, 96);
  }
}

function formatAccountMachineAdoptionFailure(
  failure: AccountMachineAdoptionFailure,
): string {
  return `${failure.route.kind} ${accountMachineAdoptionRouteHost(failure.route)}: ${
    boundedInlineText(failure.reason, 160)
  }`;
}

function classifyAccountMachineAdoptionFailure(reason: string): string {
  if (/timed? out|timeout/i.test(reason)) return "timeout";
  if (/auth|token|credential|proof|forbidden|unauthorized/i.test(reason)) {
    return "authentication";
  }
  if (/identity|signature|device id|cipher/i.test(reason)) return "identity";
  if (/ECONN|EHOST|ENET|unreach|offline|closed|socket|websocket|refused/i.test(reason)) {
    return "unreachable";
  }
  return "unknown";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Sync connection cancelled.");
}

function coerceHostIdentity(value: unknown): SyncPairingHostIdentity | null {
  if (!isRecord(value)) return null;
  const deviceId = requiredString(value.deviceId);
  const siteId = requiredString(value.siteId);
  const name = requiredString(value.name);
  const platform = value.platform;
  const deviceType = value.deviceType;
  if (!deviceId || !siteId || !name) return null;
  if (
    platform !== "macOS"
    && platform !== "linux"
    && platform !== "windows"
    && platform !== "iOS"
    && platform !== "unknown"
  ) return null;
  if (
    deviceType !== "desktop"
    && deviceType !== "phone"
    && deviceType !== "vps"
    && deviceType !== "browser"
    && deviceType !== "unknown"
  ) return null;
  return { deviceId, siteId, name, platform, deviceType };
}

function coerceMachine(value: unknown): DesktopPairedMachineCredentials | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const hostIdentity = coerceHostIdentity(value.hostIdentity);
  const deviceId = requiredString(value.deviceId);
  const siteId = requiredString(value.siteId);
  const deviceName = requiredString(value.deviceName);
  const secret = requiredString(value.secret);
  const dpopPrivateKey = requiredString(value.dpopPrivateKey);
  const dpopPublicKey = requiredString(value.dpopPublicKey);
  const createdAt = requiredString(value.createdAt);
  const updatedAt = requiredString(value.updatedAt);
  const endpoints = Array.isArray(value.endpoints)
    ? [...new Set(value.endpoints.flatMap((entry) => {
        if (typeof entry !== "string" || !entry.trim()) return [];
        try {
          return [normalizeSyncEndpoint(entry)];
        } catch {
          return [];
        }
      }))]
    : [];
  const relayUrl = requiredString(value.relayUrl);
  const endpointStates = coerceEndpointStates(value.endpointStates, endpoints);
  if (
    !hostIdentity
    || !deviceId
    || !siteId
    || !deviceName
    || !secret
    || !dpopPrivateKey
    || !dpopPublicKey
    || !createdAt
    || !updatedAt
    || endpoints.length === 0
  ) return null;
  return {
    version: 1,
    hostIdentity,
    machineKey: requiredString(value.machineKey),
    accountOwnerUserId: requiredString(value.accountOwnerUserId),
    deviceId,
    siteId,
    deviceName,
    secret,
    dpopPrivateKey,
    dpopPublicKey,
    endpoints,
    relayUrl,
    endpointStates,
    createdAt,
    updatedAt,
  };
}

function coerceEndpointStates(
  value: unknown,
  endpoints: string[],
): DesktopPairedMachineEndpointState[] {
  const stateByEndpoint = new Map<string, {
    lastSucceededAt: number | null;
    lastDiscoveredAt: number | null;
  }>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const rawEndpoint = requiredString(entry.endpoint);
      if (!rawEndpoint) continue;
      let endpoint: string;
      try {
        endpoint = normalizeSyncEndpoint(rawEndpoint);
      } catch {
        continue;
      }
      const lastSucceededAt = typeof entry.lastSucceededAt === "number"
        && Number.isFinite(entry.lastSucceededAt)
        ? entry.lastSucceededAt
        : null;
      const lastDiscoveredAt = typeof entry.lastDiscoveredAt === "number"
        && Number.isFinite(entry.lastDiscoveredAt)
        ? entry.lastDiscoveredAt
        : null;
      const current = stateByEndpoint.get(endpoint);
      stateByEndpoint.set(endpoint, {
        lastSucceededAt: Math.max(
          current?.lastSucceededAt ?? 0,
          lastSucceededAt ?? 0,
        ) || null,
        lastDiscoveredAt: Math.max(
          current?.lastDiscoveredAt ?? 0,
          lastDiscoveredAt ?? 0,
        ) || null,
      });
    }
  }
  for (const endpoint of endpoints) {
    if (!stateByEndpoint.has(endpoint)) {
      stateByEndpoint.set(endpoint, {
        lastSucceededAt: null,
        lastDiscoveredAt: null,
      });
    }
  }
  return [...stateByEndpoint].map(([endpoint, state]) => ({
    endpoint,
    lastSucceededAt: state.lastSucceededAt,
    ...(state.lastDiscoveredAt != null
      ? { lastDiscoveredAt: state.lastDiscoveredAt }
      : {}),
  }));
}

function mergeEndpointStates(
  endpoints: string[],
  ...stateLists: Array<DesktopPairedMachineEndpointState[] | null | undefined>
): DesktopPairedMachineEndpointState[] {
  return coerceEndpointStates(stateLists.flat(), endpoints);
}

function hostIdentityFromPeer(
  peer: SyncPeerMetadata | null | undefined,
): SyncPairingHostIdentity {
  if (!peer) throw new Error("Paired sync host did not provide an identity.");
  const deviceId = requiredString(peer?.deviceId);
  const siteId = requiredString(peer?.siteId);
  const name = requiredString(peer?.deviceName);
  if (!deviceId || !siteId || !name) {
    throw new Error("Paired sync host did not provide a valid identity.");
  }
  return {
    deviceId,
    siteId,
    name,
    platform: peer.platform,
    deviceType: peer.deviceType,
  };
}

export function generateDesktopDpopKeyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error("Could not export the desktop pairing public key.");
  return {
    privateKey: pair.privateKey.export({
      format: "der",
      type: "pkcs8",
    }).toString("base64"),
    publicKey: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]).toString("base64"),
  };
}

function machineKeyFromEndpoint(endpoint: string): string | null {
  try {
    const segments = new URL(endpoint).pathname.split("/").filter(Boolean);
    const connectIndex = segments.lastIndexOf("connect");
    return connectIndex >= 0 && segments[connectIndex + 1]
      ? decodeURIComponent(segments[connectIndex + 1]!)
      : null;
  } catch {
    return null;
  }
}

function uniqueEndpoints(...values: Array<string | null | undefined>): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value?.trim()) continue;
    let endpoint: string;
    try {
      endpoint = normalizeSyncEndpoint(value);
    } catch {
      continue;
    }
    if (seen.has(endpoint)) continue;
    seen.add(endpoint);
    normalized.push(endpoint);
  }
  return normalized;
}

export class DesktopPairedMachineStore {
  readonly path: string;

  constructor(options: { filePath?: string } = {}) {
    this.path = options.filePath
      ?? path.join(resolveMachineAdeLayout().secretsDir, STORE_FILE_NAME);
  }

  list(): DesktopPairedMachineCredentials[] {
    return this.read().machines;
  }

  get(hostDeviceIdOrMachineKey: string): DesktopPairedMachineCredentials | null {
    const id = hostDeviceIdOrMachineKey.trim();
    if (!id) return null;
    return this.list().find((machine) =>
      machine.hostIdentity.deviceId === id || machine.machineKey === id
    ) ?? null;
  }

  getForReference(ref: {
    hostIdentity: string;
    machineKey?: string | null;
  }): DesktopPairedMachineCredentials | null {
    return this.get(ref.hostIdentity)
      ?? (ref.machineKey ? this.get(ref.machineKey) : null);
  }

  save(
    credentials: DesktopPairedMachineCredentials,
    options: { replaceConnectionMetadata?: boolean } = {},
  ): DesktopPairedMachineCredentials {
    const machine = coerceMachine(credentials);
    if (!machine) throw new Error("Desktop paired machine credentials are invalid.");
    const file = this.read();
    const existing = file.machines.find((entry) =>
      entry.hostIdentity.deviceId === machine.hostIdentity.deviceId
      || (machine.machineKey && entry.machineKey === machine.machineKey)
    );
    const accountOwnerUserId = Object.prototype.hasOwnProperty.call(
      credentials,
      "accountOwnerUserId",
    )
      ? requiredString(credentials.accountOwnerUserId)
      : existing?.accountOwnerUserId ?? null;
    const saved: DesktopPairedMachineCredentials = {
      ...machine,
      accountOwnerUserId,
      createdAt: existing?.createdAt ?? machine.createdAt,
      updatedAt: nowIso(),
      endpoints: options.replaceConnectionMetadata
        ? uniqueEndpoints(...machine.endpoints)
        : uniqueEndpoints(...machine.endpoints, ...(existing?.endpoints ?? [])),
      relayUrl: options.replaceConnectionMetadata
        ? machine.relayUrl ?? null
        : machine.relayUrl ?? existing?.relayUrl ?? null,
    };
    saved.endpointStates = mergeEndpointStates(
      saved.endpoints,
      options.replaceConnectionMetadata
        ? machine.endpointStates?.filter((state) =>
            saved.endpoints.includes(state.endpoint)
          )
        : machine.endpointStates,
      options.replaceConnectionMetadata ? undefined : existing?.endpointStates,
    );
    this.write({
      version: 1,
      machines: [
        saved,
        ...file.machines.filter((entry) =>
          entry.hostIdentity.deviceId !== saved.hostIdentity.deviceId
          && (!saved.machineKey || entry.machineKey !== saved.machineKey)
        ),
      ],
    });
    return saved;
  }

  remove(hostDeviceIdOrMachineKey: string): boolean {
    const id = hostDeviceIdOrMachineKey.trim();
    if (!id) return false;
    const file = this.read();
    const machines = file.machines.filter((machine) =>
      machine.hostIdentity.deviceId !== id && machine.machineKey !== id
    );
    if (machines.length === file.machines.length) return false;
    this.write({ version: 1, machines });
    return true;
  }

  removeAccountOwned(ownerUserIdValue: string): DesktopPairedMachineCredentials[] {
    const ownerUserId = ownerUserIdValue.trim();
    if (!ownerUserId) return [];
    const file = this.read();
    const removed = file.machines.filter(
      (machine) => machine.accountOwnerUserId === ownerUserId,
    );
    if (removed.length === 0) return [];
    this.write({
      version: 1,
      machines: file.machines.filter(
        (machine) => machine.accountOwnerUserId !== ownerUserId,
      ),
    });
    return removed;
  }

  pruneAccountOwned(
    currentOwnerUserIdValue: string | null,
  ): DesktopPairedMachineCredentials[] {
    const currentOwnerUserId = currentOwnerUserIdValue?.trim() || null;
    const file = this.read();
    const removed = file.machines.filter((machine) =>
      machine.accountOwnerUserId != null
      && machine.accountOwnerUserId !== currentOwnerUserId
    );
    if (removed.length === 0) return [];
    const removedHostIds = new Set(
      removed.map((machine) => machine.hostIdentity.deviceId),
    );
    this.write({
      version: 1,
      machines: file.machines.filter(
        (machine) => !removedHostIds.has(machine.hostIdentity.deviceId),
      ),
    });
    return removed;
  }

  markEndpointSucceeded(
    hostDeviceIdOrMachineKey: string,
    endpointValue: string,
    nowMs = Date.now(),
  ): DesktopPairedMachineCredentials {
    const machine = this.get(hostDeviceIdOrMachineKey);
    if (!machine) throw new Error("Paired machine was not found.");
    const endpoint = normalizeSyncEndpoint(endpointValue);
    const endpoints = uniqueEndpoints(endpoint, ...machine.endpoints);
    return this.save({
      ...machine,
      endpoints,
      endpointStates: mergeEndpointStates(
        endpoints,
        machine.endpointStates,
        [{ endpoint, lastSucceededAt: nowMs }],
      ),
    });
  }

  markEndpointsDiscovered(
    hostDeviceIdOrMachineKey: string,
    endpointValues: string[],
    nowMs = Date.now(),
  ): DesktopPairedMachineCredentials {
    const machine = this.get(hostDeviceIdOrMachineKey);
    if (!machine) throw new Error("Paired machine was not found.");
    const discoveredEndpoints = uniqueEndpoints(...endpointValues);
    const endpoints = uniqueEndpoints(...discoveredEndpoints, ...machine.endpoints);
    return this.save({
      ...machine,
      endpoints,
      endpointStates: mergeEndpointStates(
        endpoints,
        machine.endpointStates,
        discoveredEndpoints.map((endpoint) => ({
          endpoint,
          lastSucceededAt: null,
          lastDiscoveredAt: nowMs,
        })),
      ),
    });
  }

  async pairWithMachine(
    endpointValue: string,
    pinValue: string,
    deviceNameValue: string,
    options: PairWithMachineOptions = {},
  ): Promise<DesktopPairedMachineCredentials> {
    const endpoint = normalizeSyncEndpoint(endpointValue);
    const pin = pinValue.trim();
    const deviceName = deviceNameValue.trim();
    if (!/^\d{6}$/.test(pin)) throw new Error("Pairing PIN must contain exactly 6 digits.");
    if (!deviceName) throw new Error("Desktop device name is required.");

    const keys = generateDesktopDpopKeyPair();
    const localDeviceId = randomUUID();
    const siteId = randomUUID();
    const createdAt = nowIso();
    const connection = await openSyncEnvelopeConnection({
      endpoint,
      connectTimeoutMs: options.connectTimeoutMs,
      signal: options.signal,
      createWebSocket: options.createWebSocket,
    });
    try {
      const pairingRequestId = `pair-${randomUUID()}`;
      const pairingResponse = waitForSyncEnvelope(
        connection,
        (envelope) => envelope.type === "pairing_result"
          && envelope.requestId === pairingRequestId,
        options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
        options.signal,
      );
      try {
        connection.send("pairing_request", {
          code: pin,
          peer: {
            deviceId: localDeviceId,
            deviceName,
            platform: process.platform === "darwin"
              ? "macOS"
              : process.platform === "win32"
                ? "windows"
                : process.platform === "linux"
                  ? "linux"
                  : "unknown",
            deviceType: "desktop",
            siteId,
            dbVersion: 0,
          },
          dpopPublicKey: keys.publicKey,
          ...(options.relayAccountToken
            ? { relayAccountToken: options.relayAccountToken }
            : {}),
          ...(options.runtimeHostGrant
            ? { runtimeHostGrant: options.runtimeHostGrant }
            : {}),
        }, pairingRequestId);
      } catch (error) {
        void pairingResponse.catch(() => {});
        throw error;
      }
      const pairingEnvelope = await pairingResponse;
      const pairing = pairingEnvelope.payload as SyncPairingResultPayload;
      if (!pairing?.ok) {
        throw new Error(pairing?.error?.message?.trim() || "Pairing request failed.");
      }
      const returnedDeviceId = requiredString(pairing.deviceId);
      if (returnedDeviceId && returnedDeviceId !== localDeviceId) {
        throw new Error("Pairing host returned credentials for a different device id.");
      }
      const deviceId = returnedDeviceId ?? localDeviceId;
      const secret = requiredString(pairing.secret);
      if (!secret) throw new Error("Pairing host did not return a device secret.");

      const provisional: DesktopPairedMachineCredentials = {
        version: 1,
        hostIdentity: {
          deviceId: "pending",
          siteId: "pending",
          name: "pending",
          platform: "unknown",
          deviceType: "unknown",
        },
        machineKey: machineKeyFromEndpoint(endpoint),
        accountOwnerUserId: null,
        deviceId,
        siteId,
        deviceName,
        secret,
        dpopPrivateKey: keys.privateKey,
        dpopPublicKey: keys.publicKey,
        endpoints: [endpoint],
        createdAt,
        updatedAt: createdAt,
      };

      const helloRequestId = `hello-${randomUUID()}`;
      const helloResponse = waitForSyncEnvelope(
        connection,
        (envelope) => envelope.requestId === helloRequestId
          && (envelope.type === "hello_ok" || envelope.type === "hello_error"),
        options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
        options.signal,
      );
      try {
        connection.send(
          "hello",
          buildDesktopPairedHello(
            provisional,
            options.appVersion,
            options.relayAccountToken,
          ),
          helloRequestId,
        );
      } catch (error) {
        void helloResponse.catch(() => {});
        throw error;
      }
      const helloEnvelope = await helloResponse;
      if (helloEnvelope.type === "hello_error") {
        const payload = helloEnvelope.payload as { message?: unknown };
        throw new Error(
          typeof payload?.message === "string" && payload.message.trim()
            ? payload.message.trim()
            : "The host rejected the new desktop pairing.",
        );
      }
      const hello = helloEnvelope.payload as PairedRuntimeHelloOkPayload;
      const hostIdentity = hostIdentityFromPeer(hello.brain);
      const endpoints = uniqueEndpoints(endpoint, hello.cloudRelayWssUrl);
      return this.save({
        ...provisional,
        hostIdentity,
        machineKey: provisional.machineKey
          ?? (hello.cloudRelayWssUrl ? machineKeyFromEndpoint(hello.cloudRelayWssUrl) : null),
        endpoints,
        relayUrl: hello.cloudRelayWssUrl ?? null,
        endpointStates: endpoints.map((candidate) => ({
          endpoint: candidate,
          lastSucceededAt: candidate === endpoint ? Date.now() : null,
        })),
      });
    } finally {
      connection.close(1000, "Desktop pairing finished.");
    }
  }

  async pairWithAccountMachine(
    machine: AdeAccountMachine,
    accountTokenValue: string,
    deviceNameValue: string,
    options: PairWithAccountMachineOptions,
  ): Promise<DesktopPairedMachineCredentials> {
    const accountToken = accountTokenValue.trim();
    const accountOwnerUserId = options.accountOwnerUserId.trim();
    const deviceName = deviceNameValue.trim();
    const expectedHostDeviceId = machine.deviceId?.trim() ?? "";
    if (!accountToken) throw new Error("ADE account sign-in is required.");
    if (!accountOwnerUserId) throw new Error("ADE account identity is required.");
    if (!deviceName) throw new Error("Desktop device name is required.");
    if (!expectedHostDeviceId) throw new Error("The account machine is missing a stable device id.");

    const hasDirectoryPubkey = typeof machine.pubkey === "string";
    const hostSigningPublicKey = hasDirectoryPubkey
      ? parseDirectoryEd25519PublicKey(machine.pubkey!)
      : null;
    const adoptionRoutes = accountMachineAdoptionRoutes(
      machine,
      options.relayBaseUrls,
    );
    const accountAuthenticationRoutes = hostSigningPublicKey
      ? adoptionRoutes
      : adoptionRoutes.filter((route) => route.kind === "relay");
    if (!hostSigningPublicKey && accountAuthenticationRoutes.length === 0) {
      throw new Error("That machine has no directory-verified WSS relay route for account authentication.");
    }
    const pairedEndpoints = accountMachinePairedSyncEndpoints(
      machine,
      options.relayBaseUrls,
    );
    if (accountAuthenticationRoutes.length === 0) {
      throw new Error("That machine has no directory-verified sync route for account authentication.");
    }

    const savedCandidate = this.get(expectedHostDeviceId) ?? this.get(machine.machineKey);
    const existing = savedCandidate?.accountOwnerUserId == null
      || savedCandidate.accountOwnerUserId === accountOwnerUserId
      ? savedCandidate
      : null;
    const keys = existing
      ? { privateKey: existing.dpopPrivateKey, publicKey: existing.dpopPublicKey }
      : generateDesktopDpopKeyPair();
    const localDeviceId = existing?.deviceId ?? randomUUID();
    const siteId = existing?.siteId ?? randomUUID();
    const createdAt = existing?.createdAt ?? nowIso();
    const proofCredentials = {
      deviceId: localDeviceId,
      secret: accountToken,
      dpopPrivateKey: keys.privateKey,
      dpopPublicKey: keys.publicKey,
    };
    const peer: SyncPeerMetadata = {
      deviceId: localDeviceId,
      deviceName,
      platform: process.platform === "darwin"
        ? "macOS"
        : process.platform === "win32"
          ? "windows"
          : process.platform === "linux"
            ? "linux"
            : "unknown",
      deviceType: "desktop",
      siteId,
      dbVersion: 0,
      capabilities: [],
      ...(options.appVersion?.trim() ? { appVersion: options.appVersion.trim() } : {}),
    };
    const correlationId = randomUUID();
    const failures: AccountMachineAdoptionFailure[] = [];
    for (const route of accountAuthenticationRoutes) {
      throwIfAborted(options.signal);
      if (route.kind !== "relay" && !hostSigningPublicKey) {
        throw new Error(
          "Refusing to send plaintext account authentication over a direct route.",
        );
      }
      emitAccountMachineAdoptionStage(options.onStage, {
        kind: route.kind,
        phase: "connecting",
      });
      let connection: SyncEnvelopeConnection;
      try {
        connection = await openSyncEnvelopeConnection({
          endpoint: route.endpoint,
          connectTimeoutMs: options.connectTimeoutMs,
          signal: options.signal,
          createWebSocket: options.createWebSocket,
          ...(route.kind === "relay" ? { correlationId } : {}),
        });
      } catch (error) {
        throwIfAborted(options.signal);
        failures.push({
          route,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      try {
        let adoptSessionKey: Buffer | null = null;
        let adoptAead: AdoptChannelAead = "chacha20-poly1305";
        let clientSupportedAeads: AdoptChannelAead[] = [];
        if (hostSigningPublicKey) {
          const challengeRequestId = `challenge-${randomUUID()}`;
          const nonce = randomBytes(32);
          const nonceBase64 = nonce.toString("base64");
          const clientEphemeral = generateX25519EphemeralKeyPair();
          const clientEphemeralPublicKey =
            clientEphemeral.publicKeyRaw.toString("base64");
          clientSupportedAeads = supportedAdoptChannelAeads();
          const challengeResponse = waitForSyncEnvelope(
            connection,
            (envelope) => envelope.requestId === challengeRequestId
              && (
                envelope.type === "account_challenge_ok"
                || envelope.type === "account_challenge_error"
              ),
            Math.min(
              ADOPT_CHANNEL_CHALLENGE_TIMEOUT_MS,
              options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
            ),
            options.signal,
          );
          try {
            connection.send("account_challenge", {
              v: 1,
              nonce: nonceBase64,
              clientEphemeralPublicKey,
              supportedAeads: clientSupportedAeads,
            }, challengeRequestId);
          } catch (error) {
            void challengeResponse.catch(() => {});
            throw error;
          }
          const challengeEnvelope = await challengeResponse;
          if (challengeEnvelope.type === "account_challenge_error") {
            // The host declined to issue a challenge (rate-limit cooldown, an
            // already-active challenge, etc.). This is NOT an identity-proof
            // failure — a MITM cannot forge a valid challenge on any other route
            // either — so surface the host's real reason and fall through to the
            // next route instead of aborting adoption with a misleading
            // "older ADE" identity error.
            const hostMessage = (challengeEnvelope.payload as { message?: unknown } | null)?.message;
            throw new Error(
              typeof hostMessage === "string" && hostMessage.trim()
                ? boundedInlineText(hostMessage, 200)
                : "The machine declined the account adoption challenge.",
            );
          }
          const challenge = challengeEnvelope.payload as
            Partial<SyncAccountChallengeOkPayload> | null;
          const hostEphemeralPublicKey = decodeCanonicalBase64(
            challenge?.hostEphemeralPublicKey,
            32,
          );
          const signature = decodeCanonicalBase64(challenge?.signature, 64);
          const challengeHasAead = challenge?.aead !== undefined;
          if (
            challengeHasAead
            && (
              typeof challenge?.aead !== "string"
              || !clientSupportedAeads.includes(challenge.aead as AdoptChannelAead)
            )
          ) {
            throw hostIdentityVerificationError();
          }
          if (challengeHasAead) {
            adoptAead = challenge!.aead as AdoptChannelAead;
          }
          if (
            challenge?.v !== 1
            || challenge.hostDeviceId !== expectedHostDeviceId
            || !Number.isSafeInteger(challenge.ts)
            || Math.abs(Date.now() - Number(challenge.ts))
              > ADOPT_CHANNEL_MAX_CLOCK_SKEW_MS
            || !hostEphemeralPublicKey
            || !signature
          ) {
            throw hostIdentityVerificationError();
          }
          const canonical = buildAdoptChallengeSignatureInput({
            hostDeviceId: challenge.hostDeviceId,
            nonce: nonceBase64,
            clientEphemeralPublicKey,
            hostEphemeralPublicKey: challenge.hostEphemeralPublicKey!,
            ts: challenge.ts!,
            ...(challengeHasAead ? { aead: challenge.aead! } : {}),
          });
          if (!verifyEd25519(hostSigningPublicKey, canonical, signature)) {
            throw hostIdentityVerificationError();
          }
          adoptSessionKey = deriveAdoptSessionKey({
            privateKey: clientEphemeral.privateKey,
            peerPublicKeyRaw: hostEphemeralPublicKey,
            nonce,
          });
          emitAccountMachineAdoptionStage(options.onStage, {
            kind: route.kind,
            phase: "verifying",
          });
        }

        if (route.kind !== "relay" && !adoptSessionKey) {
          throw new Error(
            "Refusing to send plaintext account authentication over a direct route.",
          );
        }
        const accountDpop = createDesktopSyncDpopProof(proofCredentials);
        const legacyAccountAuth = {
          deviceId: localDeviceId,
          accountToken,
          dpop: accountDpop,
        };
        let sealedAccountAuth: string | null = null;
        if (adoptSessionKey) {
          try {
            if (!clientSupportedAeads.includes(adoptAead)) {
              throw new Error(`Unsupported adoption cipher: ${adoptAead}`);
            }
            sealedAccountAuth = seal(
              adoptSessionKey,
              buildAdoptHelloAad(
                expectedHostDeviceId,
                localDeviceId,
              ),
              Buffer.from(JSON.stringify(legacyAccountAuth), "utf8"),
              undefined,
              adoptAead,
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (
              !clientSupportedAeads.includes(adoptAead)
              || /unknown cipher|unsupported/i.test(reason)
            ) {
              throw new Error(ADOPT_CHANNEL_UPDATE_REQUIRED_ERROR);
            }
            throw error;
          }
        }
        const hello: SyncHelloPayload = {
          peer,
          auth: adoptSessionKey
            ? {
                kind: "account_sealed",
                v: 1,
                deviceId: localDeviceId,
                sealed: sealedAccountAuth!,
              }
            : {
                kind: "account",
                ...legacyAccountAuth,
              },
        };
        const requestId = `account-${randomUUID()}`;
        const response = waitForSyncEnvelope(
          connection,
          (envelope) => envelope.requestId === requestId
            && (envelope.type === "hello_ok" || envelope.type === "hello_error"),
          options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS,
          options.signal,
        );
        connection.send("hello", hello, requestId);
        const envelope = await response;
        if (envelope.type === "hello_error") {
          const payload = envelope.payload as { message?: unknown };
          throw new Error(
            typeof payload.message === "string" && payload.message.trim()
              ? payload.message.trim()
              : "Account authentication was rejected.",
          );
        }
        let helloOk: PairedRuntimeHelloOkPayload;
        if (adoptSessionKey) {
          const sealedHelloOk = envelope.payload as {
            v?: unknown;
            sealed?: unknown;
          } | null;
          if (
            sealedHelloOk?.v !== 1
            || typeof sealedHelloOk.sealed !== "string"
          ) {
            throw hostIdentityVerificationError();
          }
          try {
            helloOk = JSON.parse(unseal(
              adoptSessionKey,
              buildAdoptHelloOkAad(
                expectedHostDeviceId,
                localDeviceId,
              ),
              sealedHelloOk.sealed,
              adoptAead,
            ).toString("utf8")) as PairedRuntimeHelloOkPayload;
          } catch {
            throw hostIdentityVerificationError();
          }
        } else {
          helloOk = envelope.payload as PairedRuntimeHelloOkPayload;
        }
        const hostIdentity = hostIdentityFromPeer(helloOk.brain);
        if (hostIdentity.deviceId !== expectedHostDeviceId) {
          throw new Error("Account machine endpoint identity did not match the directory record.");
        }
        const pairing = resolveAccountHelloPairing({
          accountPairing: helloOk.accountPairing,
          existingPairing: existing
            ? { deviceId: existing.deviceId, secret: existing.secret }
            : null,
          expectedDeviceId: localDeviceId,
        });
        if (!pairing) {
          throw new Error("Account-authenticated host did not provide or recognize paired credentials.");
        }
        const savedEndpoints = uniqueEndpoints(
          route.endpoint,
          ...pairedEndpoints,
          helloOk.cloudRelayWssUrl,
        );
        if (
          options.authorizeAccountCommit
          && !await options.authorizeAccountCommit(accountOwnerUserId)
        ) {
          throw new AccountPairingAuthorizationError(
            "Your ADE account changed before this machine could be saved.",
          );
        }
        return this.save({
          version: 1,
          hostIdentity,
          machineKey: machine.machineKey,
          accountOwnerUserId: existing?.accountOwnerUserId == null && existing
            ? null
            : accountOwnerUserId,
          deviceId: localDeviceId,
          siteId,
          deviceName,
          secret: pairing.secret,
          dpopPrivateKey: keys.privateKey,
          dpopPublicKey: keys.publicKey,
          endpoints: savedEndpoints,
          relayUrl: helloOk.cloudRelayWssUrl ?? null,
          endpointStates: savedEndpoints.map((candidate) => ({
            endpoint: candidate,
            lastSucceededAt: candidate === route.endpoint ? Date.now() : null,
          })),
          createdAt,
          updatedAt: nowIso(),
        });
      } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof AccountPairingAuthorizationError) throw error;
        if (error instanceof AccountHostIdentityVerificationError) {
          throw error;
        }
        failures.push({
          route,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        connection.close(1000, "Account pairing finished.");
      }
    }
    console.warn("[account] Account machine adoption failed on every route.", {
      correlationId,
      attempts: failures.slice(0, MAX_ROUTE_ATTEMPTS).map((failure) => ({
        kind: failure.route.kind,
        host: accountMachineAdoptionRouteHost(failure.route),
        failure: classifyAccountMachineAdoptionFailure(failure.reason),
      })),
      omittedAttemptCount: Math.max(0, failures.length - MAX_ROUTE_ATTEMPTS),
    });
    const visibleFailures = failures.slice(0, MAX_ROUTE_ATTEMPTS)
      .map(formatAccountMachineAdoptionFailure);
    if (failures.length > MAX_ROUTE_ATTEMPTS) {
      visibleFailures.push(
        `${failures.length - MAX_ROUTE_ATTEMPTS} more route attempts failed`,
      );
    }
    throw new Error(
      `Could not connect to ${machine.name ?? machine.machineKey} with your ADE account. ${
        visibleFailures.join("; ")
      }`,
    );
  }

  private read(): DesktopPairedMachinesFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, "utf8")) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.machines)) {
        return { version: 1, machines: [] };
      }
      return {
        version: 1,
        machines: parsed.machines
          .map(coerceMachine)
          .filter((machine): machine is DesktopPairedMachineCredentials => machine != null),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, machines: [] };
      }
      throw error;
    }
  }

  private write(file: DesktopPairedMachinesFile): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.path);
      fs.chmodSync(this.path, 0o600);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Rename removes the temp path; cleanup only matters after a failure.
      }
    }
  }
}

export async function pairWithMachine(
  endpoint: string,
  pin: string,
  deviceName: string,
  options: PairWithMachineOptions & { store?: DesktopPairedMachineStore } = {},
): Promise<DesktopPairedMachineCredentials> {
  const { store = new DesktopPairedMachineStore(), ...connectionOptions } = options;
  return await store.pairWithMachine(endpoint, pin, deviceName, connectionOptions);
}
