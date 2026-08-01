import { createHash, createHmac } from "node:crypto";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type {
  AttentionItem,
  AttentionPreferenceScope,
  AttentionPreferences,
  AttentionPresence,
  AttentionSnapshot,
  AttentionTombstone,
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

export type ActivityAcknowledgmentRelayResult = {
  applied: string[];
  stale: string[];
};

export type LegacyAttentionRelayPublishPayload = {
  machineName: string;
  fullSnapshot: true;
  items: AttentionItem[];
  tombstones?: Array<{ id: string; revision: number }>;
};

export type ActivityPublishRequest = {
  machineName: string;
  mode: "delta" | "reconcile" | "presence";
  rosterEpoch: number;
  page?: number;
  final?: boolean;
  items: AttentionItem[];
  tombstones: AttentionTombstone[];
  fullSnapshot?: never;
};

export type ActivityPublishAcknowledgment = {
  itemId: string;
  sourceRevision: number;
  seenAt: string | null;
  dismissedAt: string | null;
};

/** Decoded response contract for both legacy and protocol-2 Activity publishes. */
export type ActivityPublishResult = {
  ok: true;
  protocol?: number;
  revision?: number;
  acks?: ActivityPublishAcknowledgment[];
  upserted?: number;
  removed?: number;
  unchanged?: boolean;
  suppressed?: boolean;
  itemsTruncated?: boolean;
};

export type AttentionRelayPublishPayload =
  | LegacyAttentionRelayPublishPayload
  | ActivityPublishRequest;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class PushRelayRequestError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(`push relay ${action} failed: ${reason}`);
    this.name = "PushRelayRequestError";
  }
}

export function createPushRelayClient(args: {
  store: PushRegistrationStore;
  logger: Logger;
  baseUrl?: string;
  getAccountAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
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
    const requestOnce = async (forceRefresh: boolean): Promise<RelayResponse> => {
      const expectedAccountUserId = options?.expectedAccountUserId;
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
          expectedAccountUserId
          && args.getAccountUserId?.() !== expectedAccountUserId
        ) {
          return {
            ok: false,
            status: 409,
            body: { error: "ADE account changed before the request was authorized" },
          };
        }
        const token = await args.getAccountAccessToken?.(
          forceRefresh ? { forceRefresh: true } : undefined,
        );
        if (!token) {
          return {
            ok: false,
            status: 401,
            body: {
              error: expectedAccountUserId
                ? "ADE account has no usable access token"
                : "ADE account is not signed in",
            },
          };
        }
        if (
          expectedAccountUserId
          && args.getAccountUserId?.() !== expectedAccountUserId
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
          const value: unknown = await response.json();
          parsed = isRecord(value) ? value : null;
        } catch {
          parsed = null;
        }
        if (
          expectedAccountUserId
          && args.getAccountUserId?.() !== expectedAccountUserId
        ) {
          return {
            ok: false,
            status: 409,
            body: { error: "ADE account changed while the relay response was in flight" },
          };
        }
        return { ok: response.ok, status: response.status, body: parsed };
      } catch (error) {
        clearTimeout(timeout);
        throw error instanceof Error ? error : new Error(String(error));
      }
    };

    const first = await requestOnce(false);
    if (!options?.accountAuthorized || first.status !== 401) return first;

    // A cached Clerk token can be revoked or rejected before its signed expiry.
    // Retry the exact request once with a forced refresh. Account-owner fencing
    // runs again before and after refresh, so an account switch can never send
    // the replacement credential on behalf of the prior owner.
    return await requestOnce(true);
  };

  const requireOk = (action: string, response: RelayResponse): Record<string, unknown> => {
    if (!response.ok) {
      const message = typeof response.body?.error === "string" ? response.body.error : `HTTP ${response.status}`;
      throw new PushRelayRequestError(action, response.status, message);
    }
    return response.body ?? {};
  };

  const requireAttentionSnapshot = (
    response: RelayResponse,
  ): AttentionSnapshot => {
    const body = requireOk("getAttentionSnapshot", response);
    const valid = body.contractVersion === 1
      && (body.streamId === null || typeof body.streamId === "string")
      && Number.isSafeInteger(body.revision)
      && Number(body.revision) >= 0
      && typeof body.generatedAt === "string"
      && !Number.isNaN(Date.parse(body.generatedAt))
      && Array.isArray(body.items)
      && Array.isArray(body.tombstones)
      && (body.machines === undefined || Array.isArray(body.machines));
    if (!valid) {
      throw new PushRelayRequestError(
        "getAttentionSnapshot",
        502,
        "relay returned an invalid Activity snapshot",
      );
    }
    return body as unknown as AttentionSnapshot;
  };

  const requireActivityPublishResult = (
    response: RelayResponse,
  ): ActivityPublishResult => {
    const body = requireOk("publishAttention", response);
    const validOptionalCount = (value: unknown): boolean =>
      value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
    const validOptionalBoolean = (value: unknown): boolean =>
      value === undefined || typeof value === "boolean";
    if (
      body.ok !== true
      || (
        body.protocol !== undefined
        && (!Number.isSafeInteger(body.protocol) || Number(body.protocol) <= 0)
      )
      || !validOptionalCount(body.revision)
      || !validOptionalCount(body.upserted)
      || !validOptionalCount(body.removed)
      || !validOptionalBoolean(body.unchanged)
      || !validOptionalBoolean(body.suppressed)
      || !validOptionalBoolean(body.itemsTruncated)
      || (body.acks !== undefined && !Array.isArray(body.acks))
    ) {
      throw new PushRelayRequestError(
        "publishAttention",
        502,
        "relay returned an invalid Activity publish result",
      );
    }
    const acknowledgments = (body.acks ?? []).map((value) => {
      if (!isRecord(value)) return null;
      const itemId = typeof value.itemId === "string" ? value.itemId.trim() : "";
      const sourceRevision = Number(value.sourceRevision);
      const seenAt = value.seenAt;
      const dismissedAt = value.dismissedAt;
      if (
        !itemId
        || !Number.isSafeInteger(sourceRevision)
        || sourceRevision < 0
        || (seenAt !== null && typeof seenAt !== "string")
        || (dismissedAt !== null && typeof dismissedAt !== "string")
        || (typeof seenAt === "string" && Number.isNaN(Date.parse(seenAt)))
        || (typeof dismissedAt === "string" && Number.isNaN(Date.parse(dismissedAt)))
      ) {
        return null;
      }
      return { itemId, sourceRevision, seenAt, dismissedAt };
    });
    if (acknowledgments.some((value) => value === null)) {
      throw new PushRelayRequestError(
        "publishAttention",
        502,
        "relay returned an invalid Activity publish result",
      );
    }
    return {
      ok: true,
      ...(body.protocol !== undefined ? { protocol: Number(body.protocol) } : {}),
      ...(body.revision !== undefined ? { revision: Number(body.revision) } : {}),
      ...(body.acks !== undefined
        ? { acks: acknowledgments as ActivityPublishAcknowledgment[] }
        : {}),
      ...(body.upserted !== undefined ? { upserted: Number(body.upserted) } : {}),
      ...(body.removed !== undefined ? { removed: Number(body.removed) } : {}),
      ...(body.unchanged !== undefined ? { unchanged: body.unchanged as boolean } : {}),
      ...(body.suppressed !== undefined ? { suppressed: body.suppressed as boolean } : {}),
      ...(body.itemsTruncated !== undefined
        ? { itemsTruncated: body.itemsTruncated as boolean }
        : {}),
    };
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

    async publishAttention(payload: AttentionRelayPublishPayload): Promise<ActivityPublishResult | null> {
      if (!args.getAccountAccessToken) return null;
      const expectedAccountUserId = args.getAccountUserId?.() ?? undefined;
      if (!expectedAccountUserId) return null;
      await claimMachine();
      const response = await request("POST", machinePath("/attention"), {
        body: payload,
        signed: true,
        accountAuthorized: true,
        expectedAccountUserId,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      return requireActivityPublishResult(response);
    },

    async getAttentionSnapshot(
      since = 0,
      streamId?: string | null,
    ): Promise<AttentionSnapshot | null> {
      if (!args.getAccountAccessToken) return null;
      const expectedAccountUserId = args.getAccountUserId?.() ?? undefined;
      if (!expectedAccountUserId) return null;
      const query = new URLSearchParams({
        since: String(Math.max(0, Math.trunc(since))),
      });
      if (streamId?.trim()) query.set("streamId", streamId.trim());
      const response = await request(
        "GET",
        `/attention/account/snapshot?${query.toString()}`,
        { accountAuthorized: true, expectedAccountUserId },
      );
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      return requireAttentionSnapshot(response);
    },

    async acknowledgeAttention(acknowledgment: {
      itemIds: string[];
      sourceRevisions?: Record<string, number>;
      seenAt?: string;
      dismissedAt?: string | null;
      expectedAccountOwnerId?: string | null;
    }): Promise<ActivityAcknowledgmentRelayResult | null> {
      if (!args.getAccountAccessToken) return null;
      const currentAccountUserId = args.getAccountUserId?.()?.trim() || null;
      const expectedAccountUserId = acknowledgment.expectedAccountOwnerId === undefined
        ? currentAccountUserId
        : acknowledgment.expectedAccountOwnerId?.trim() || null;
      if (expectedAccountUserId !== currentAccountUserId) {
        throw new Error(
          "The ADE account changed before the Activity acknowledgment could sync.",
        );
      }
      if (!currentAccountUserId) return null;
      const response = await request("POST", "/attention/account/ack", {
        body: acknowledgment,
        accountAuthorized: true,
        expectedAccountUserId: expectedAccountUserId ?? undefined,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return null;
      }
      const body = requireOk("acknowledgeAttention", response);
      if (
        !Array.isArray(body.applied)
        || !body.applied.every((itemId) => typeof itemId === "string")
        || !Array.isArray(body.stale)
        || !body.stale.every((itemId) => typeof itemId === "string")
      ) {
        throw new PushRelayRequestError(
          "acknowledgeAttention",
          502,
          "relay returned an invalid Activity acknowledgment",
        );
      }
      return {
        applied: body.applied,
        stale: body.stale,
      };
    },

    async reportAttentionPresence(presence: AttentionPresence): Promise<void> {
      const expectedAccountUserId = args.getAccountUserId?.() ?? undefined;
      if (!expectedAccountUserId) return;
      const response = await request("POST", "/attention/account/presence", {
        body: presence,
        accountAuthorized: true,
        expectedAccountUserId,
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
      // Desktop edits account/project policy only. Omitting device and machine
      // overrides lets the relay preserve concurrent scope-owned settings.
      const {
        devices: _deviceOverrides,
        machines: _machineOverrides,
        ...accountPreferences
      } = preferences;
      const response = await request("PUT", "/attention/account/preferences", {
        body: accountPreferences,
        accountAuthorized: true,
        expectedAccountUserId,
      });
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") return;
      requireOk("putAttentionPreferences", response);
    },

    async putActivityMachinePreferences(
      expectedAccountUserId: string,
      machineKey: string,
      partial: Partial<AttentionPreferenceScope>,
    ): Promise<void> {
      const response = await request(
        "PATCH",
        `/attention/account/preferences/machines/${encodeURIComponent(machineKey)}`,
        {
          body: partial,
          accountAuthorized: true,
          expectedAccountUserId,
        },
      );
      if (response.status === 401 && response.body?.error === "ADE account is not signed in") {
        return;
      }
      requireOk("putActivityMachinePreferences", response);
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
