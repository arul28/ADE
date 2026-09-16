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

/**
 * The account owner removed this machine. Distinct from every other 4xx because
 * it is TERMINAL: retrying cannot succeed, and a caller that treats it as a
 * transient failure will hammer the relay forever while the user believes the
 * machine is gone. Callers must stop their publish loop and surface it.
 */
export class PushRelayMachineRevokedError extends PushRelayRequestError {
  readonly code = "machine_revoked" as const;

  constructor(action: string, readonly revokedAt: string | null) {
    super(action, 403, "this machine was removed from your ADE account");
    this.name = "PushRelayMachineRevokedError";
  }
}

/**
 * Recognise the relay's revocation response. Shape-checked rather than
 * status-only: a plain 403 from a proxy is not a revocation.
 */
export function readMachineRevokedResponse(
  status: number,
  body: Record<string, unknown> | null,
): { revokedAt: string | null } | null {
  if (status !== 403 || !body || body.code !== "machine_revoked") return null;
  const revokedAt = typeof body.revokedAt === "string"
    && !Number.isNaN(Date.parse(body.revokedAt))
    ? body.revokedAt
    : null;
  return { revokedAt };
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
      // Every machine-signed route can answer the terminal revocation, not just
      // the account-authorized Activity one: a removed machine still holds a
      // valid machine signature, so the legacy publish and live-activity-token
      // routes gate server-side too. Raised as the terminal error here so a
      // caller on the legacy path stops its loop instead of retrying a
      // de-authorization on every flush, forever.
      const revoked = readMachineRevokedResponse(response.status, response.body);
      if (revoked) throw new PushRelayMachineRevokedError(action, revoked.revokedAt);
      const message = typeof response.body?.error === "string" ? response.body.error : `HTTP ${response.status}`;
      throw new PushRelayRequestError(action, response.status, message);
    }
    return response.body ?? {};
  };

  /**
   * The preamble every account settings/vault call repeats.
   *
   * All six owe the same three things: a token and a signed-in account to ask
   * with, the same `since`/`scope` query builder, and the same ladder of
   * statuses that mean "I could not ask" rather than "here is the answer". They
   * are not the same answer to the caller: "nothing changed" lets it advance
   * its cursor, while "I could not ask" must leave the cursor and the cache
   * exactly where they were — so `asked: false` is never collapsed into an
   * empty page.
   *
   * The status policy is passed in per call rather than inferred. The vault
   * fails closed on 503 (the relay has no encryption key: an operator problem,
   * so it reads as "ask again later"); settings have nothing to encrypt and no
   * 503 to interpret, and making them share one ladder would be a behaviour
   * change disguised as a cleanup.
   */
  const accountRequest = async (
    action: string,
    method: string,
    pathSuffix: string,
    options?: {
      body?: unknown;
      /** Appended as a query string; blank and absent values are dropped. */
      query?: Record<string, string | null | undefined>;
      /** Statuses that mean "could not ask". Always includes 401. */
      couldNotAsk?: readonly number[];
      /** Statuses handed back to the caller instead of throwing. */
      allowStatuses?: readonly number[];
    },
  ): Promise<{ asked: false } | { asked: true; status: number; body: Record<string, unknown> }> => {
    if (!args.getAccountAccessToken) return { asked: false };
    const expectedAccountUserId = args.getAccountUserId?.() ?? undefined;
    if (!expectedAccountUserId) return { asked: false };
    let suffix = pathSuffix;
    if (options?.query) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(options.query)) {
        const trimmed = value?.trim();
        if (trimmed) query.set(name, trimmed);
      }
      if (query.toString()) suffix += `?${query.toString()}`;
    }
    const response = await request(method, suffix, {
      ...(options?.body === undefined ? {} : { body: options.body }),
      accountAuthorized: true,
      expectedAccountUserId,
    });
    if (response.status === 401) return { asked: false };
    if (options?.couldNotAsk?.includes(response.status)) return { asked: false };
    if (options?.allowStatuses?.includes(response.status)) {
      return { asked: true, status: response.status, body: response.body ?? {} };
    }
    return { asked: true, status: response.status, body: requireOk(action, response) };
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
      // A removed machine keeps a valid signature and a valid account token —
      // only the roster says it no longer belongs. Raise it as its own terminal
      // error so the publisher stops instead of retrying on every flush.
      const revoked = readMachineRevokedResponse(response.status, response.body);
      if (revoked) {
        throw new PushRelayMachineRevokedError("publishAttention", revoked.revokedAt);
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
      /**
       * `itemId -> the alertFingerprint the client displayed`. The relay
       * rejects an ack (reporting the id as `stale`) when the stored
       * `alert_fingerprint` differs, so an in-flight bulk ack cannot swallow an
       * alert published after the poll. Items omitted here are unfenced.
       */
      alertFingerprints?: Record<string, string>;
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

    /**
     * Purge every Activity row a machine published and revoke its ability to
     * publish more. Called when the account owner removes the machine: the
     * directory delete only drops the roster row, and without this the removed
     * machine's agents stay in the feed forever (its own key is the only thing
     * the relay's epoch sweep is scoped to).
     *
     * Errors propagate deliberately. A partial removal — roster row gone,
     * Activity left behind — must reach the user, not be swallowed into a
     * success message beside a feed that still lists the machine.
     */
    async purgeAccountMachineActivity(
      expectedAccountUserId: string,
      machineKey: string,
    ): Promise<void> {
      const trimmedMachineKey = machineKey.trim();
      if (!trimmedMachineKey) {
        throw new PushRelayRequestError(
          "purgeAccountMachineActivity",
          400,
          "a machine key is required to purge Activity",
        );
      }
      const response = await request(
        "DELETE",
        `/attention/account/machines/${encodeURIComponent(trimmedMachineKey)}`,
        { accountAuthorized: true, expectedAccountUserId },
      );
      // Already purged (or never published) is the desired end state, not a
      // failure — removing a machine twice must not report an error.
      if (response.status === 404) return;
      requireOk("purgeAccountMachineActivity", response);
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

    /**
     * Read account settings changed after `since`.
     *
     * Returns `null` — never an empty page — when this machine has no account
     * token. The two answers mean opposite things to the caller: "nothing
     * changed" lets it advance its cursor, while "I could not ask" must leave
     * the cursor and the cache exactly where they were.
     */
    async getAccountSettings(options?: {
      since?: string | null;
      scope?: string | null;
    }): Promise<AccountSettingsPage | null> {
      const result = await accountRequest("getAccountSettings", "GET", "/attention/account/settings", {
        query: { since: options?.since, scope: options?.scope },
      });
      if (!result.asked) return null;
      const body = result.body;
      return {
        settings: Array.isArray(body.settings)
          ? body.settings.map(decodeAccountSettingRecord).filter((row): row is AccountSettingRecord => row !== null)
          : [],
        cursor: typeof body.cursor === "string" ? body.cursor : null,
        truncated: body.truncated === true,
      };
    },

    /**
     * Upload a batch. Returns `null` when there was no token to ask with, so an
     * offline machine keeps its queue instead of believing it flushed.
     */
    async putAccountSettings(
      settings: AccountSettingWrite[],
      deviceId: string | null,
    ): Promise<{ updatedAt: string | null } | null> {
      if (!args.getAccountAccessToken) return null;
      if (!(args.getAccountUserId?.() ?? undefined)) return null;
      if (!settings.length) return { updatedAt: null };
      const result = await accountRequest("putAccountSettings", "PUT", "/attention/account/settings", {
        body: { settings, ...(deviceId ? { deviceId } : {}) },
      });
      if (!result.asked) return null;
      return {
        updatedAt: typeof result.body.updatedAt === "string" ? result.body.updatedAt : null,
      };
    },

    /** The way out. A reset that cannot reach the account is not a reset. */
    async deleteAccountSetting(scope: string, key: string): Promise<boolean | null> {
      const result = await accountRequest(
        "deleteAccountSetting",
        "DELETE",
        `/attention/account/settings/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
        { allowStatuses: [404] },
      );
      if (!result.asked) return null;
      // Already gone is the desired end state, not a failure.
      if (result.status === 404) return false;
      return result.body.deleted === true;
    },

    /**
     * Read vault items changed after `since`.
     *
     * `null` means this machine had no account token to ask with — or that the
     * relay has no encryption key and failed closed — which is not the same
     * answer as an empty page and must not advance a cursor.
     */
    async getAccountVault(options?: {
      since?: string | null;
      scope?: string | null;
    }): Promise<AccountVaultPage | null> {
      const result = await accountRequest("getAccountVault", "GET", "/attention/account/vault", {
        query: { since: options?.since, scope: options?.scope },
        couldNotAsk: [503],
      });
      if (!result.asked) return null;
      const body = result.body;
      return {
        items: Array.isArray(body.items)
          ? body.items.map(decodeAccountVaultItem).filter((row): row is AccountVaultItem => row !== null)
          : [],
        cursor: typeof body.cursor === "string" ? body.cursor : null,
        truncated: body.truncated === true,
      };
    },

    async putAccountVault(
      items: AccountVaultWrite[],
      deviceId: string | null,
    ): Promise<{ updatedAt: string | null } | null> {
      if (!args.getAccountAccessToken) return null;
      if (!(args.getAccountUserId?.() ?? undefined)) return null;
      if (!items.length) return { updatedAt: null };
      const result = await accountRequest("putAccountVault", "PUT", "/attention/account/vault", {
        body: { items, ...(deviceId ? { deviceId } : {}) },
        couldNotAsk: [503],
      });
      if (!result.asked) return null;
      return {
        updatedAt: typeof result.body.updatedAt === "string" ? result.body.updatedAt : null,
      };
    },

    /** Revoking has to work from any machine, including one you no longer have. */
    async deleteAccountVaultItem(
      scope: string,
      kind: string,
      key: string,
    ): Promise<boolean | null> {
      const result = await accountRequest(
        "deleteAccountVaultItem",
        "DELETE",
        `/attention/account/vault/${encodeURIComponent(scope)}/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
        { couldNotAsk: [503], allowStatuses: [404] },
      );
      if (!result.asked) return null;
      if (result.status === 404) return false;
      return result.body.deleted === true;
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

/** One setting as the relay reports it. */
export type AccountSettingRecord = {
  scope: string;
  key: string;
  value: unknown;
  updatedAt: string;
  changedAt: string | null;
  writerDeviceId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readTimestamp(value: unknown): string | null {
  const timestamp = readNonEmptyString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null;
}

/** Validate one settings row at the relay boundary before it enters a cache. */
export function decodeAccountSettingRecord(value: unknown): AccountSettingRecord | null {
  if (!isRecord(value)) return null;
  const scope = readNonEmptyString(value.scope);
  const key = readNonEmptyString(value.key);
  const updatedAt = readTimestamp(value.updatedAt);
  const changedAt = readNullableString(value.changedAt);
  const writerDeviceId = readNullableString(value.writerDeviceId);
  if (!scope || !key || !updatedAt || changedAt === undefined || writerDeviceId === undefined) return null;
  return { scope, key, value: value.value, updatedAt, changedAt, writerDeviceId };
}

/** One setting as a client sends it. `changedAt` is diagnostics, not ordering. */
export type AccountSettingWrite = {
  scope: string;
  key: string;
  value: unknown;
  changedAt?: string;
};

export type AccountSettingsPage = {
  settings: AccountSettingRecord[];
  /**
   * Pass back as `since` next time. Null only when the account has never
   * written a setting, which is a legitimate starting state.
   */
  cursor: string | null;
  /**
   * The relay says so explicitly rather than leaving a client to infer it from
   * a full page — guessing either loops forever on an exactly-full page or
   * stops one page early on the next.
   */
  truncated: boolean;
};

export type PushRelayClient = ReturnType<typeof createPushRelayClient>;

/** What ADE stores in the vault. Closed, because each kind needs an owner. */
export type AccountVaultItemKind =
  | "secret"
  | "provider_key"
  | "integration"
  | "provider_api_key"
  | "linear_refresh_token"
  | "project_secret";

export type AccountVaultItem = {
  scope: string;
  kind: AccountVaultItemKind;
  key: string;
  /**
   * The credential, or null when the relay could not open its stored bytes.
   *
   * Null is never "absent". A client that treats it as absent will helpfully
   * overwrite a credential that is still good on every other machine.
   */
  value: string | null;
  updatedAt: string;
  writerDeviceId: string | null;
  refreshOwner: string | null;
};

const ACCOUNT_VAULT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "secret",
  "provider_key",
  "integration",
  "provider_api_key",
  "linear_refresh_token",
  "project_secret",
]);

/** Validate one vault row before callers can mistake corrupt data for a secret. */
export function decodeAccountVaultItem(value: unknown): AccountVaultItem | null {
  if (!isRecord(value)) return null;
  const scope = readNonEmptyString(value.scope);
  const kind = readNonEmptyString(value.kind);
  const key = readNonEmptyString(value.key);
  const updatedAt = readTimestamp(value.updatedAt);
  const itemValue = value.value === null || typeof value.value === "string" ? value.value : undefined;
  const writerDeviceId = readNullableString(value.writerDeviceId);
  const refreshOwner = readNullableString(value.refreshOwner);
  if (
    !scope
    || !kind
    || !ACCOUNT_VAULT_ITEM_KINDS.has(kind)
    || !key
    || !updatedAt
    || itemValue === undefined
    || writerDeviceId === undefined
    || refreshOwner === undefined
  ) return null;
  return {
    scope,
    kind: kind as AccountVaultItemKind,
    key,
    value: itemValue,
    updatedAt,
    writerDeviceId,
    refreshOwner,
  };
}

export type AccountVaultWrite = {
  scope: string;
  kind: AccountVaultItemKind;
  key: string;
  value: string;
  /** The machine allowed to exchange a rotating credential; null if it never rotates. */
  refreshOwner?: string | null;
};

export type AccountVaultPage = {
  items: AccountVaultItem[];
  cursor: string | null;
  truncated: boolean;
};
