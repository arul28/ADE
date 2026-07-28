import { createHash, createHmac } from "node:crypto";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type {
  AttentionItem,
  AttentionPreferences,
  AttentionPresence,
  AttentionSnapshot,
} from "../../../../desktop/src/shared/types/attention";
import type { PushDeviceRegistration } from "../../../../desktop/src/shared/types/push";
import type { PushRegistrationStore } from "./pushRegistrationStore";

const DEFAULT_RELAY_URL = "https://ade-push-relay.arulsharma1028.workers.dev";
const REQUEST_TIMEOUT_MS = 15_000;

/** APNs alert-push item, matching the relay's `parseAlertItems`. */
export type PushRelayAlertItem = {
  deviceIds?: string[] | null;
  /** May be empty for a silent badge-only item (requires `badge`). */
  title: string;
  subtitle?: string | null;
  body?: string | null;
  deepLink?: string | null;
  threadId?: string | null;
  sound?: string | null;
  interruptionLevel?: "passive" | "active" | "time-sensitive" | null;
  collapseId?: string | null;
  dedupeKey?: string | null;
  phase?: "running" | "waiting" | "terminal";
  /** Chat session the alert refers to; passed through top-level to iOS. */
  sessionId?: string | null;
  /** Pending approval item id; passed through top-level to iOS. */
  itemId?: string | null;
  /** `aps.category` — binds registered notification actions on iOS. */
  category?: string | null;
  /** `aps.badge` — awaiting-attention count for the app icon. */
  badge?: number | null;
};

/** Live Activity event item, matching the relay's `parseLiveActivityItems`. */
export type PushRelayLiveActivityItem = {
  deviceIds?: string[] | null;
  event: "start" | "update" | "end";
  activityId: string;
  attributesType?: string | null;
  attributes?: Record<string, unknown> | null;
  contentState: Record<string, unknown>;
  staleDate?: number | null;
  dismissalDate?: number | null;
  relevanceScore?: number | null;
  alert?: { title: string; body?: string | null } | null;
  dedupeKey?: string | null;
  phase?: "running" | "waiting" | "terminal";
};

export type PushRelayPublishPayload = {
  notifications?: PushRelayAlertItem[];
  liveActivity?: PushRelayLiveActivityItem[];
};

export type PushRelayHealth = {
  ok: boolean;
  apnsConfigured: boolean;
};

export type AttentionRelayPublishPayload = {
  machineName: string;
  fullSnapshot: true;
  items: AttentionItem[];
  tombstones?: Array<{ id: string; revision: number }>;
};

/**
 * Canonical string the relay commits every signed call to. Binding method,
 * path and body hash prevents replaying a captured signature against another
 * endpoint or with a mutated body. Kept byte-identical to the worker's
 * `buildSignatureBase` / `signPushRelayRequest` (see apps/push-relay/src/relay.ts).
 */
function signRequest(
  secret: string,
  args: { timestamp: string; method: string; pathname: string; body: string },
): string {
  const bodyHash = createHash("sha256").update(args.body, "utf8").digest("hex");
  const base = `${args.timestamp}.${args.method.toUpperCase()}.${args.pathname}.${bodyHash}`;
  const signature = createHmac("sha256", secret).update(base, "utf8").digest("hex");
  return `sha256=${signature}`;
}

type RelayResponse = { ok: boolean; status: number; body: Record<string, unknown> | null };

export function createPushRelayClient(args: {
  store: PushRegistrationStore;
  logger: Logger;
  baseUrl?: string;
  getAccountAccessToken?: () => Promise<string | null>;
  getAccountUserId?: () => string | null;
}) {
  const baseUrl = (args.baseUrl ?? process.env.ADE_PUSH_RELAY_URL?.trim() ?? "").trim() || DEFAULT_RELAY_URL;

  const request = async (
    method: string,
    pathSuffix: string,
    options?: {
      body?: unknown;
      signed?: boolean;
      accountAuthorized?: boolean;
      expectedAccountUserId?: string;
    },
  ): Promise<RelayResponse> => {
    const url = new URL(`${baseUrl}${pathSuffix}`);
    const bodyString = options?.body === undefined ? "" : JSON.stringify(options.body);
    const headers: Record<string, string> = {};
    if (options?.body !== undefined) headers["content-type"] = "application/json";

    if (options?.signed) {
      const { machineSecret } = args.store.getOrCreateIdentity();
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers["x-ade-push-timestamp"] = timestamp;
      // Sign the pathname exactly as it appears on the wire — the worker signs
      // `new URL(request.url).pathname`, so any percent-encoding must match.
      headers["x-ade-push-signature"] = signRequest(machineSecret, {
        timestamp,
        method,
        pathname: url.pathname,
        body: bodyString,
      });
    }
    if (options?.accountAuthorized) {
      if (
        options.expectedAccountUserId
        && args.getAccountUserId?.() !== options.expectedAccountUserId
      ) {
        return {
          ok: false,
          status: 409,
          body: { error: "ADE account changed before the request was authorized" },
        };
      }
      const token = await args.getAccountAccessToken?.();
      if (!token) {
        return { ok: false, status: 401, body: { error: "ADE account is not signed in" } };
      }
      if (
        options.expectedAccountUserId
        && args.getAccountUserId?.() !== options.expectedAccountUserId
      ) {
        return {
          ok: false,
          status: 409,
          body: { error: "ADE account changed while the request was authorized" },
        };
      }
      headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        ...(options?.body !== undefined ? { body: bodyString } : {}),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = (await response.json()) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
      clearTimeout(timeout);
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  const requireOk = (action: string, response: RelayResponse): Record<string, unknown> => {
    if (!response.ok) {
      const message = typeof response.body?.error === "string" ? response.body.error : `HTTP ${response.status}`;
      throw new Error(`push relay ${action} failed: ${message}`);
    }
    return response.body ?? {};
  };

  const machinePath = (suffix: string): string => {
    const { machineKey } = args.store.getOrCreateIdentity();
    return `/machines/${machineKey}${suffix}`;
  };

  const claimMachine = async (): Promise<void> => {
    if (args.store.isClaimed()) return;
    const { machineKey, machineSecret } = args.store.getOrCreateIdentity();
    const response = await request("POST", `/machines/${machineKey}/claim`, {
      body: { secret: machineSecret },
    });
    // 200 (already claimed with same secret) and 201 (fresh) both mean claimed.
    if (response.ok) {
      args.store.markClaimed();
      return;
    }
    requireOk("claim", response);
  };

  return {
    baseUrl,

    /** Idempotent claim; the relay treats a re-claim with the same secret as a no-op. */
    async claim(): Promise<void> {
      await claimMachine();
    },

    async registerDevice(registration: PushDeviceRegistration): Promise<void> {
      if (registration.pushToStartToken && registration.clearPushToStartToken) {
        throw new Error("Cannot set and clear pushToStartToken together.");
      }
      const body: Record<string, unknown> = {
        bundleId: registration.bundleId,
        apsEnvironment: registration.apsEnvironment,
      };
      if (registration.apnsToken) body.apnsToken = registration.apnsToken;
      if (registration.pushToStartToken) body.pushToStartToken = registration.pushToStartToken;
      if (registration.clearPushToStartToken) body.clearPushToStartToken = true;
      if (registration.platform) body.platform = registration.platform;
      if (registration.deviceName) body.deviceName = registration.deviceName;
      const response = await request("PUT", machinePath(`/devices/${encodeURIComponent(registration.deviceId)}`), {
        body,
        signed: true,
      });
      requireOk("registerDevice", response);
    },

    async unregisterDevice(deviceId: string): Promise<void> {
      const response = await request("DELETE", machinePath(`/devices/${encodeURIComponent(deviceId)}`), {
        signed: true,
      });
      requireOk("unregisterDevice", response);
    },

    async reportLiveActivityToken(report: { deviceId: string; activityId: string; token?: string | null }): Promise<void> {
      const response = await request("POST", machinePath(`/live-activity-tokens`), {
        body: {
          deviceId: report.deviceId,
          activityId: report.activityId,
          token: report.token ?? "",
        },
        signed: true,
      });
      requireOk("reportLiveActivityToken", response);
    },

    async publish(payload: PushRelayPublishPayload): Promise<Record<string, unknown>> {
      const response = await request("POST", machinePath(`/publish`), { body: payload, signed: true });
      return requireOk("publish", response);
    },

    async publishAttention(payload: AttentionRelayPublishPayload): Promise<Record<string, unknown> | null> {
      if (!args.getAccountAccessToken) return null;
      await claimMachine();
      const response = await request("POST", machinePath("/attention"), {
        body: payload,
        signed: true,
        accountAuthorized: true,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      return requireOk("publishAttention", response);
    },

    async getAttentionSnapshot(
      since = 0,
      streamId?: string | null,
    ): Promise<AttentionSnapshot | null> {
      if (!args.getAccountAccessToken) return null;
      const query = new URLSearchParams({
        since: String(Math.max(0, Math.trunc(since))),
      });
      if (streamId?.trim()) query.set("streamId", streamId.trim());
      const response = await request(
        "GET",
        `/attention/account/snapshot?${query.toString()}`,
        { accountAuthorized: true },
      );
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      return requireOk("getAttentionSnapshot", response) as unknown as AttentionSnapshot;
    },

    async acknowledgeAttention(acknowledgment: {
      itemIds: string[];
      seenAt?: string;
      dismissedAt?: string | null;
    }): Promise<Record<string, unknown> | null> {
      if (!args.getAccountAccessToken) return null;
      const response = await request("POST", "/attention/account/ack", {
        body: acknowledgment,
        accountAuthorized: true,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      return requireOk("acknowledgeAttention", response);
    },

    async reportAttentionPresence(presence: AttentionPresence): Promise<void> {
      const response = await request("POST", "/attention/account/presence", {
        body: presence,
        accountAuthorized: true,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") return;
      requireOk("reportAttentionPresence", response);
    },

    async getAttentionPreferences(
      expectedAccountUserId: string,
    ): Promise<AttentionPreferences | null> {
      const response = await request("GET", "/attention/account/preferences", {
        accountAuthorized: true,
        expectedAccountUserId,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      const body = requireOk("getAttentionPreferences", response);
      return (body.preferences ?? null) as AttentionPreferences | null;
    },

    async putAttentionPreferences(
      expectedAccountUserId: string,
      preferences: AttentionPreferences,
    ): Promise<void> {
      // Desktop edits account/project policy only. Omitting device overrides
      // lets the relay preserve concurrent phone-owned settings atomically.
      const { devices: _deviceOverrides, ...accountPreferences } = preferences;
      const response = await request("PUT", "/attention/account/preferences", {
        body: accountPreferences,
        accountAuthorized: true,
        expectedAccountUserId,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") return;
      requireOk("putAttentionPreferences", response);
    },

    async health(): Promise<PushRelayHealth> {
      const response = await request("GET", "/health");
      const body = response.body ?? {};
      return {
        ok: response.ok && body.ok === true,
        apnsConfigured: body.apnsConfigured === true,
      };
    },
  };
}

export type PushRelayClient = ReturnType<typeof createPushRelayClient>;
