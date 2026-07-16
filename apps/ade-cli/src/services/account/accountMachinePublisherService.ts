import type {
  AdeAccountMachineEndpoint,
  SyncRoleSnapshot,
} from "../../../../desktop/src/shared/types";
import {
  officialAccountDirectoryUrlForIssuer,
  resolveTrustedAccountDirectoryBaseUrl,
} from "../../../../desktop/src/shared/accountDirectory";
import { getSignedInAccountAccessToken } from "./accountAuthService";
import {
  getSharedAccountAttestationConfig,
  getSharedAccountAuthService,
} from "./sharedAccountAuthService";

export const ACCOUNT_MACHINE_HEARTBEAT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export type AccountMachineRegistration = {
  machineKey: string;
  deviceId: string;
  name: string;
  platform: string;
  deviceType: string;
  pubkey: null;
  reachableEndpoints: AdeAccountMachineEndpoint[];
};

type AccountMachinePublisherLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

type BrainAccountMachinePublisherLogger = AccountMachinePublisherLogger & {
  info(message: string, meta?: Record<string, unknown>): void;
};

export type AccountMachineRegistrationSnapshot = Pick<
  SyncRoleSnapshot,
  "role" | "runtimeRole" | "runtimeName" | "pairingConnectInfo" | "routeHealth"
>;

function validatedRelayUrl(raw: string, machineKey: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "wss:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.endsWith(`/connect/${machineKey}`)
  ) {
    return null;
  }
  return url.toString();
}

export function buildAccountMachineRegistration(args: {
  machineKey: string;
  snapshot: AccountMachineRegistrationSnapshot;
}): AccountMachineRegistration | null {
  const machineKey = args.machineKey.trim();
  const connectInfo = args.snapshot.pairingConnectInfo;
  const isHost = args.snapshot.runtimeRole
    ? args.snapshot.runtimeRole === "host"
    : args.snapshot.role === "brain";
  if (!machineKey || !connectInfo || !isHost) {
    return null;
  }

  const endpoints: AdeAccountMachineEndpoint[] = [];
  const seen = new Set<string>();
  const add = (endpoint: AdeAccountMachineEndpoint): void => {
    const key = JSON.stringify(endpoint);
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(endpoint);
  };

  for (const candidate of connectInfo.addressCandidates) {
    const host = candidate.host.trim();
    if (!host) continue;
    if (
      candidate.kind === "lan"
      && args.snapshot.routeHealth.listener.loopbackAdeValidated
    ) {
      add({ kind: "lan", host, port: connectInfo.port });
      continue;
    }
    if (
      candidate.kind === "tailscale"
      && args.snapshot.routeHealth.tailscale.tailscaleReachable
    ) {
      add({ kind: "tailnet", host, port: connectInfo.port });
      continue;
    }
    if (
      candidate.kind === "relay"
      && args.snapshot.routeHealth.listener.loopbackAdeValidated
      && args.snapshot.routeHealth.relay.relayControlConnected
      && args.snapshot.routeHealth.relay.relayBridgeValidated
      && args.snapshot.routeHealth.relay.reason == null
    ) {
      const url = validatedRelayUrl(host, machineKey);
      if (url) add({ kind: "relay", url });
    }
  }

  const identity = connectInfo.hostIdentity;
  return {
    machineKey,
    deviceId: identity.deviceId,
    name: args.snapshot.runtimeName?.trim() || identity.name,
    platform: identity.platform,
    deviceType: identity.deviceType,
    // Reserved for a future machine-owned key. Account pairing currently
    // proves the connecting DEVICE's DPoP key during the sync hello instead.
    pubkey: null,
    reachableEndpoints: endpoints,
  };
}

export function createAccountMachinePublisherService(options: {
  getAccessToken: () => Promise<string | null>;
  getSnapshot: () => Promise<AccountMachineRegistrationSnapshot | null>;
  getMachineKey: () => string;
  directoryBaseUrl?: () => string | null | undefined;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  logger?: AccountMachinePublisherLogger;
}) {
  const heartbeatMs = Math.max(1_000, Math.floor(options.heartbeatMs ?? ACCOUNT_MACHINE_HEARTBEAT_MS));
  const requestTimeoutMs = Math.max(250, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  let started = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;
  let lastWarning: string | null = null;

  const warnOnce = (code: string, meta: Record<string, unknown> = {}): void => {
    if (lastWarning === code) return;
    lastWarning = code;
    options.logger?.warn("account.machine_publish_failed", { code, ...meta });
  };

  const publish = async (): Promise<void> => {
    if (disposed) return;
    const baseUrl = resolveTrustedAccountDirectoryBaseUrl(
      options.directoryBaseUrl?.(),
    );
    if (!baseUrl) {
      warnOnce("invalid_directory_url");
      return;
    }

    const snapshot = await options.getSnapshot().catch(() => null);
    if (disposed || !snapshot) return;
    const registration = buildAccountMachineRegistration({
      machineKey: options.getMachineKey(),
      snapshot,
    });
    if (!registration) return;

    const accessToken = (await options.getAccessToken().catch(() => null))?.trim();
    if (disposed || !accessToken) return;

    if (disposed) return;
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await (options.fetchImpl ?? fetch)(
        `${baseUrl}/account/machines/register`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(registration),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        },
      );
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        warnOnce("http_error", { status: response.status });
        return;
      }
      lastWarning = null;
    } catch (error) {
      if (disposed && controller.signal.aborted) return;
      warnOnce(controller.signal.aborted ? "timeout" : "transport_error", {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  };

  const publishNow = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    const current = publish()
      .catch((error) => {
        warnOnce("publisher_error", {
          errorKind: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  const schedule = (): void => {
    if (!started || disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void publishNow().finally(schedule);
    }, heartbeatMs);
    timer.unref?.();
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      void publishNow().finally(schedule);
    },

    publishNow,

    dispose(): void {
      disposed = true;
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      activeController?.abort();
      activeController = null;
    },
  };
}

export type AccountMachinePublisherService = ReturnType<
  typeof createAccountMachinePublisherService
>;

/**
 * Brain-level composition seam. Keeps account credential resolution out of the
 * already-large CLI coordinator while preserving one publisher per brain.
 */
export function createBrainAccountMachinePublisherService(options: {
  secretsDir: string;
  projectRoots: () => Iterable<string>;
  getSnapshot: () => Promise<SyncRoleSnapshot | null>;
  getMachineKey: () => string;
  directoryBaseUrl?: () => string | null | undefined;
  logger: BrainAccountMachinePublisherLogger;
}): AccountMachinePublisherService {
  const accountAuthService = getSharedAccountAuthService({
    secretsDir: options.secretsDir,
    projectRoots: options.projectRoots,
    logger: options.logger,
  });
  return createAccountMachinePublisherService({
    getAccessToken: () => getSignedInAccountAccessToken(accountAuthService),
    getSnapshot: options.getSnapshot,
    getMachineKey: options.getMachineKey,
    directoryBaseUrl: () => {
      const explicit = options.directoryBaseUrl?.();
      if (explicit?.trim()) return explicit;
      return officialAccountDirectoryUrlForIssuer(getSharedAccountAttestationConfig({
        secretsDir: options.secretsDir,
        projectRoots: options.projectRoots,
      }).issuer);
    },
    logger: options.logger,
  });
}
