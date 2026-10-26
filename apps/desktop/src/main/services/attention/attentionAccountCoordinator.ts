import type { PushRelayClient } from "../../../../../ade-cli/src/services/push/pushRelayClient";
import {
  PushRelayRequestError,
  PushRelayUnreachableError,
} from "../../../../../ade-cli/src/services/push/pushRelayClient";
import {
  ATTENTION_SNAPSHOT_INCLUDE_MESSAGES,
  DEFAULT_ATTENTION_PREFERENCES,
  runAcknowledgmentChunks,
  unreachedOutcomeFields,
  type AttentionAcknowledgmentOutcome,
  type AttentionPreferenceScope,
  type AttentionPreferences,
  type AttentionPresence,
  type AttentionPresenceReceipt,
  type AttentionSnapshot,
} from "../../../shared/types/attention";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import type { Logger } from "../logging/logger";
import { withDeadline } from "../shared/withTimeout";

type AccountAttentionClient = Pick<
  PushRelayClient,
  | "getAttentionSnapshot"
  | "acknowledgeAttention"
  | "reportAttentionPresence"
  | "getAttentionPreferences"
  | "putAttentionPreferences"
> & Partial<Pick<PushRelayClient, "putActivityMachinePreferences" | "setAttentionSessionMuted">> & {
  /**
   * Purge every Activity row a removed machine published (relay
   * `DELETE /attention/account/machines/:machineKey`). Optional so a relay
   * client built before the route exists still satisfies the contract; the
   * desktop then reports the purge as unavailable rather than silently
   * pretending the machine's work is gone.
   */
  purgeAccountMachineActivity?: (
    expectedAccountUserId: string,
    machineKey: string,
  ) => Promise<void>;
};

type AttentionAccountCoordinatorOptions = {
  getLogger: () => Pick<Logger, "warn" | "info">;
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  accountAttentionClient?: AccountAttentionClient | null;
  getCurrentAccountOwnerId: () => string | null;
  /** Every account snapshot a window loaded (desktop notifications read these). */
  onAccountSnapshot?: (snapshot: AttentionSnapshot) => void;
  /** The account preferences a window loaded, with the owner they belong to. */
  onPreferences?: (accountOwnerId: string, preferences: AttentionPreferences) => void;
  /** A mute the relay accepted; desktop notifications apply it at once. */
  onSessionMuted?: (accountOwnerId: string, sessionId: string, muted: boolean) => void;
  /**
   * Whether the person is using this computer (OS input clock). Stamped on
   * every presence report as `userActive`; `null` leaves it out.
   */
  readUserActive?: () => boolean | null;
};

type AttentionSnapshotRequest = {
  since?: unknown;
  streamId?: unknown;
};

type AttentionAcknowledgmentRequest = {
  itemIds?: unknown;
  sourceRevisions?: unknown;
  /**
   * `itemId -> the alertFingerprint the caller had on screen`. The narrow
   * fence that replaces the retired `source_revision <= ?` predicate: an ack
   * may only land on the alert the user actually saw, so an in-flight
   * "Clear all" cannot swallow a `needs_you` that was published after the poll.
   */
  alertFingerprints?: unknown;
  expectedAccountOwnerId?: unknown;
  seenAt?: unknown;
  dismissedAt?: unknown;
};

type AttentionPreferenceRequest = {
  accountOwnerId?: unknown;
};

type AttentionPreferenceUpdateRequest = AttentionPreferenceRequest & {
  preferences?: unknown;
};

/**
 * Per-item result of one bulk acknowledgment. Defined on the wire contract in
 * `shared/types/attention` so the preload bridge, the browser adapter and this
 * coordinator cannot drift; re-exported here because this is where the shape is
 * produced.
 */
export type { AttentionAcknowledgmentOutcome };

export class ActivityAcknowledgmentStaleError extends Error {
  readonly code = "activity_acknowledgment_stale" as const;

  constructor(readonly staleItemIds: string[]) {
    super(
      "One or more Activity items changed after they loaded. Refresh Activity, then try again.",
    );
    this.name = "ActivityAcknowledgmentStaleError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * What the polled Activity reads (snapshot, presence, preferences) may spend,
 * end to end. Their renderer IPC timer is the 30s default; answering inside it
 * means the renderer gets a real answer (or a legible failure) instead of the
 * opaque "IPC handler timed out". User-initiated writes (acknowledge, saving
 * preferences) are bounded per relay request instead.
 */
export const ATTENTION_IPC_BUDGET_MS = 25_000;

/**
 * The account leg of a snapshot when this computer can answer for itself.
 * Long enough for a slow but working relay (one 15s fetch plus a token wait);
 * the local fallback, a read from the brain's memory, gets the rest.
 */
export const ATTENTION_ACCOUNT_SNAPSHOT_BUDGET_MS = 18_000;

/** First pause after the relay could not be reached; doubles to the max. */
const RELAY_BACKOFF_BASE_MS = 5_000;
const RELAY_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * The relay did not give an answer worth surfacing: no HTTP response at all,
 * a timeout, a rate limit, or the relay's own 5xx. Presence and preference
 * refreshes run on timers with nobody waiting on them, so these are "try again
 * later", not errors.
 */
function isRelayUnavailable(error: unknown): boolean {
  if (error instanceof PushRelayUnreachableError) return true;
  return error instanceof PushRelayRequestError
    && (error.status === 429 || error.status >= 500);
}

/** Cap on the remembered-revision cache; an account snapshot tops out well below. */
const MAX_REMEMBERED_ITEM_REVISIONS = 4_096;

/** Matches the Activity item parser's bound on the same field. */
const MAX_ALERT_FINGERPRINT_LENGTH = 1_024;

/** The revisions for one chunk. Sent whole, a map would name ids outside it. */
function pickSourceRevisions(
  revisions: Record<string, number>,
  chunk: string[],
): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const itemId of chunk) {
    const revision = revisions[itemId];
    if (revision !== undefined) picked[itemId] = revision;
  }
  return picked;
}

/**
 * The alert fences to quote for a batch.
 *
 * Caller-supplied only, with NO fallback to any cache this process happens to
 * hold: a fingerprint from another surface's poll is not what the user was
 * looking at, and quoting it is exactly how the retired revision fence
 * manufactured staleness. An item the caller did not fence is simply
 * acknowledged unfenced, so a bulk "Clear all" still clears in one call.
 */
function resolveAlertFingerprints(
  itemIds: string[],
  supplied: unknown,
): Record<string, string> {
  const requested = isRecord(supplied) ? supplied : {};
  const fingerprints: Record<string, string> = {};
  for (const itemId of itemIds) {
    const value = requested[itemId];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ALERT_FINGERPRINT_LENGTH) continue;
    fingerprints[itemId] = trimmed;
  }
  return fingerprints;
}

export class AttentionAccountCoordinator {
  private loggedRuntimeCompatibilityFailure = false;
  private lastSnapshotScope: AttentionSnapshot["scope"] | null = null;
  private lastSnapshotAccountOwnerId: string | null = null;
  private readonly lastSnapshotItemRevisions = new Map<string, number>();
  /** Consecutive relay failures; drives the backoff below. 0 = healthy. */
  private relayFailures = 0;
  /** Presence and preference reads skip the relay until this instant. */
  private relayRetryAtMs = 0;
  /** The last account-snapshot failure logged, so a long outage logs its edge. */
  private loggedAccountSnapshotFailure: string | null = null;
  /** The last presence a window reported, resent on lock, sleep and wake. */
  private lastPresence: Record<string, unknown> | null = null;
  private presenceChanges: Promise<void> = Promise.resolve();

  constructor(private readonly options: AttentionAccountCoordinatorOptions) {}

  /**
   * Record that the relay could not be reached, and log the edge into it.
   *
   * Every window reports presence on a timer and on each focus, blur and
   * visibility change, so an offline laptop or a flaky network used to send a
   * burst of doomed requests (and errors) per window switch. Backing off here,
   * in the desktop's single coordinator, covers every window at once.
   */
  private noteRelayUnavailable(source: string, error: unknown): void {
    this.relayFailures += 1;
    const backoffMs = Math.min(
      RELAY_BACKOFF_MAX_MS,
      RELAY_BACKOFF_BASE_MS * 2 ** Math.min(this.relayFailures - 1, 16),
    );
    this.relayRetryAtMs = Date.now() + backoffMs;
    if (this.relayFailures === 1) {
      this.options.getLogger().warn("attention.relay_unavailable", {
        source,
        error: error instanceof Error ? error.message : String(error),
        retryInMs: backoffMs,
      });
    }
  }

  private noteRelayAvailable(): void {
    if (this.relayFailures > 0) {
      this.options.getLogger().info("attention.relay_recovered", {
        failures: this.relayFailures,
      });
    }
    this.relayFailures = 0;
    this.relayRetryAtMs = 0;
  }

  private relayBackingOff(): boolean {
    return this.relayFailures > 0 && Date.now() < this.relayRetryAtMs;
  }

  async getSnapshot(input: unknown): Promise<AttentionSnapshot> {
    const request = isRecord(input) ? input as AttentionSnapshotRequest : {};
    const since = Number.isFinite(Number(request.since))
      ? Math.max(0, Math.trunc(Number(request.since)))
      : 0;
    const streamId =
      typeof request.streamId === "string" && request.streamId.trim()
        ? request.streamId.trim()
        : null;
    const accountOwnerId = this.currentAccountOwnerId();
    let accountFailure: unknown = null;
    const startedAt = Date.now();
    const pool = this.options.localRuntimeConnectionPool;

    if (accountOwnerId && this.options.accountAttentionClient) {
      // With a local fallback the account leg gets part of the budget; without
      // one it may use all of it.
      const accountBudgetMs = pool
        ? ATTENTION_ACCOUNT_SNAPSHOT_BUDGET_MS
        : ATTENTION_IPC_BUDGET_MS;
      const accountDeadline = new AbortController();
      const accountTimer = setTimeout(
        () => accountDeadline.abort(
          new PushRelayUnreachableError("timeout"),
        ),
        accountBudgetMs,
      );
      accountTimer.unref?.();
      try {
        const snapshot = await this.options.accountAttentionClient.getAttentionSnapshot(
          since,
          streamId,
          { signal: accountDeadline.signal },
        );
        this.noteRelayAvailable();
        this.loggedAccountSnapshotFailure = null;
        if (snapshot) {
          const accountSnapshot: AttentionSnapshot = {
            ...snapshot,
            scope: "account",
            accountOwnerId,
            availability: {
              state: "ready",
              title: "",
              message: "",
              recovery: null,
            },
          };
          this.rememberSnapshot(accountSnapshot, accountOwnerId);
          try {
            this.options.onAccountSnapshot?.(accountSnapshot);
          } catch (error) {
            this.options.getLogger().warn("attention.snapshot_observer_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return accountSnapshot;
        }
      } catch (error) {
        accountFailure = error;
        if (isRelayUnavailable(error)) this.noteRelayUnavailable("snapshot", error);
        // The poll repeats every 15s; one line per change of reason, not per poll.
        const message = error instanceof Error ? error.message : String(error);
        if (this.loggedAccountSnapshotFailure !== message) {
          this.loggedAccountSnapshotFailure = message;
          this.options.getLogger().warn("attention.account_snapshot_failed", {
            error: message,
            fallback: pool ? "local_machine" : "none",
          });
        }
      } finally {
        clearTimeout(accountTimer);
      }
    }

    if (pool) {
      try {
        // Whatever the account leg left. The connect in front of the call is
        // not covered by the transport timeout, so the deadline wraps both.
        const remainingMs = Math.max(1, ATTENTION_IPC_BUDGET_MS - (Date.now() - startedAt));
        const snapshot = await withDeadline(
          pool.callAttention<AttentionSnapshot>(
            "getMachineSnapshot",
            { include: ATTENTION_SNAPSHOT_INCLUDE_MESSAGES },
            { timeoutMs: remainingMs },
          ),
          remainingMs,
          () => new Error(
            "This computer's ADE brain did not answer in time. Activity will retry.",
          ),
        );
        const generatedAt = new Date().toISOString();
        const hostMachineKey = snapshot.streamId?.startsWith("machine:")
          ? snapshot.streamId.slice("machine:".length)
          : null;
        const keyedHostMachine = hostMachineKey
          ? snapshot.machines?.find((machine) => machine.machineKey === hostMachineKey)
          : null;
        const hostMachine = hostMachineKey
          ? keyedHostMachine ?? snapshot.machines?.[0]
          : null;
        const resolvedHostMachineKey = hostMachine?.machineKey ?? hostMachineKey;
        const stampHostMachine = <T extends { machineKey: string }>(machine: T): T =>
          machine.machineKey === resolvedHostMachineKey
            ? { ...machine, online: true, lastSeenAt: generatedAt }
            : machine;
        const machineName = hostMachine?.name?.trim() || "this computer";
        const accountAvailability = accountFailure
          ? this.describeAccountFailure(accountFailure)
          : null;
        const machineSnapshot: AttentionSnapshot = {
          ...snapshot,
          machines: snapshot.machines?.map(stampHostMachine),
          items: snapshot.items.map((item) =>
            item.machine && typeof item.machine.machineKey === "string"
              ? { ...item, machine: stampHostMachine(item.machine) }
              : item),
          scope: "machine",
          accountOwnerId,
          availability: accountOwnerId
            ? {
                state: "degraded",
                title: accountAvailability?.title ?? `Showing ${machineName} only`,
                message: accountAvailability
                  ? `${accountAvailability.message} Showing work from ${machineName}.`
                  : (
                      `Account sync is unavailable. Work from ${machineName} remains available; `
                      + "other machines may be missing."
                    ),
                recovery: accountAvailability?.recovery ?? "retry",
                hostName: machineName,
              }
            : {
                state: "signed_out",
                title: `Showing ${machineName}`,
                message: "Sign in to combine Activity across every ADE machine.",
                recovery: "sign_in",
                hostName: machineName,
              },
        };
        this.rememberSnapshot(machineSnapshot, accountOwnerId);
        return machineSnapshot;
      } catch (error) {
        const compatibilityMessage = this.describeRuntimeCompatibilityFailure(error);
        if (compatibilityMessage) {
          throw new Error(
            accountFailure
              ? (
                  "Account Activity could not connect, and this computer cannot provide a fallback. "
                  + compatibilityMessage
                )
              : compatibilityMessage,
          );
        }
        if (!accountFailure) throw error;
      }
    }

    if (accountFailure) {
      const presentation = this.describeAccountFailure(accountFailure);
      throw new Error(
        `${presentation.title}. ${presentation.message} `
        + "No safe machine-scoped fallback is available on this computer.",
      );
    }
    throw new Error(
      "Activity cannot reach this computer's ADE brain. Restart ADE on this computer, then try again.",
    );
  }

  async acknowledge(input: unknown): Promise<AttentionAcknowledgmentOutcome> {
    const request = isRecord(input) ? input as AttentionAcknowledgmentRequest : {};
    const itemIds = Array.isArray(request.itemIds)
      ? request.itemIds
        .filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
      : [];
    if (itemIds.length === 0) {
      throw new Error("At least one Activity item id is required.");
    }
    const timestamps = {
      ...(typeof request.seenAt === "string" ? { seenAt: request.seenAt } : {}),
      ...(request.dismissedAt === null || typeof request.dismissedAt === "string"
        ? { dismissedAt: request.dismissedAt }
        : {}),
    };
    /**
     * One request per chunk, with every per-item map rebuilt for that chunk.
     *
     * The maps MUST be rebuilt rather than sliced alongside: the relay rejects
     * an acknowledgment whose fence names an id outside the batch, so a whole
     * -batch map sent with a partial id list is a 400 for the entire call.
     */
    const chunkRequest = (chunk: string[]) => {
      const alertFingerprints = resolveAlertFingerprints(chunk, request.alertFingerprints);
      return {
        itemIds: chunk,
        // Omitted entirely when nothing was quoted, so an older host or relay
        // never has to reason about an empty fence object.
        ...(Object.keys(alertFingerprints).length > 0 ? { alertFingerprints } : {}),
        ...timestamps,
      };
    };
    const currentAccountOwnerId = this.currentAccountOwnerId();
    if (this.lastSnapshotAccountOwnerId !== currentAccountOwnerId) {
      throw new Error(
        "The ADE account changed after Activity loaded. Refresh Activity, then try again.",
      );
    }
    if (this.lastSnapshotScope === "machine") {
      const sourceRevisions = this.resolveSourceRevisions(itemIds, request.sourceRevisions);
      const requestedAccountOwnerId =
        request.expectedAccountOwnerId === null
        || typeof request.expectedAccountOwnerId === "string"
          ? request.expectedAccountOwnerId?.trim() || null
          : undefined;
      if (
        requestedAccountOwnerId === undefined
        || requestedAccountOwnerId !== this.lastSnapshotAccountOwnerId
      ) {
        throw new Error(
          "The machine Activity account scope changed after this item loaded. Refresh and try again.",
        );
      }
      const pool = this.options.localRuntimeConnectionPool;
      if (!pool) {
        throw new Error("Machine Activity is unavailable until this computer's ADE brain is ready.");
      }
      // The host caps a batch at the same 64, so chunk here too rather than
      // report success for ids that were never sent. It answers per CHUNK, not
      // per item — it applies the whole payload or throws — so no chunk ever
      // yields stale ids, and an id that did not land was simply never answered
      // for. It rolls back either way, but nothing about it changed underneath
      // the user.
      const machine = await runAcknowledgmentChunks(itemIds, async (chunk) => {
        await pool.callAttention<void>(
          "acknowledge",
          {
            ...chunkRequest(chunk),
            scope: "machine",
            sourceRevisions: pickSourceRevisions(sourceRevisions, chunk),
            expectedAccountOwnerId: requestedAccountOwnerId,
          },
        );
        return [];
      });
      // Nothing landed: surface the real reason, exactly as an unchunked batch
      // always has. Otherwise report the truth per item — the chunks that
      // landed must not be rolled back by the caller.
      if (machine.acknowledged.length === 0 && machine.failure) throw machine.failure;
      return {
        acknowledged: machine.acknowledged,
        stale: machine.stale,
        ...unreachedOutcomeFields(machine.unreached, machine.failure),
      };
    }
    if (this.lastSnapshotScope !== "account") {
      throw new Error("Refresh Activity before acknowledging this item.");
    }
    if (currentAccountOwnerId && this.options.accountAttentionClient) {
      const requestedAccountOwnerId =
        request.expectedAccountOwnerId === null
        || typeof request.expectedAccountOwnerId === "string"
          ? request.expectedAccountOwnerId?.trim() || null
          : undefined;
      if (
        requestedAccountOwnerId === undefined
        || requestedAccountOwnerId !== this.lastSnapshotAccountOwnerId
      ) {
        throw new Error(
          "The account Activity scope changed after this item loaded. Refresh and try again.",
        );
      }
      const sourceRevisions = this.resolveSourceRevisions(itemIds, request.sourceRevisions);
      // One relay call for the whole batch, split ONLY at the relay's hard
      // 64-id ceiling. Splitting per item (or pre-rejecting the items this
      // process has not personally seen) is what made "Clear all" and every
      // detail-sheet ack fail: the revision the coordinator quoted came from
      // another surface's poll, not from what the user was looking at. A batch
      // that fits stays exactly one call; one that does not used to be
      // truncated, which reported success for ids that never left this process.
      //
      // Mid-batch failure and per-item aggregation policy live in
      // `runAcknowledgmentChunks`, shared with the browser adapter so the two
      // shells cannot drift on them.
      const client = this.options.accountAttentionClient;
      const relay = await runAcknowledgmentChunks(itemIds, async (chunk) => {
        const result = await client.acknowledgeAttention({
          ...chunkRequest(chunk),
          sourceRevisions: pickSourceRevisions(sourceRevisions, chunk),
          expectedAccountOwnerId: requestedAccountOwnerId,
        });
        if (!result) {
          throw new Error("Sign in again, refresh Activity, then try to acknowledge this item.");
        }
        return result.stale;
      });
      // Only a batch where NOTHING landed is a failure worth interrupting for;
      // a partial result is reported per item so the caller keeps its wins.
      if (relay.acknowledged.length === 0) {
        if (relay.failure) throw relay.failure;
        if (relay.stale.length > 0) throw new ActivityAcknowledgmentStaleError(relay.stale);
      }
      return {
        acknowledged: relay.acknowledged,
        stale: relay.stale,
        ...unreachedOutcomeFields(relay.unreached, relay.failure),
      };
    }
    throw new Error("Sign in again, refresh Activity, then try to acknowledge this item.");
  }

  /**
   * Report this window's presence. Returns whether the person is using the
   * computer, so the window keeps its heartbeat fresh while they work in
   * another app (a hidden window otherwise reports every two minutes, past
   * the relay's presence window).
   */
  async reportPresence(input: unknown): Promise<AttentionPresenceReceipt> {
    const reported = isRecord(input) ? input : null;
    if (!reported || typeof reported.deviceId !== "string" || !reported.deviceId.trim()) {
      throw new Error("A valid Activity presence payload is required.");
    }
    // A window may say it is going away (`false`); "in use" only comes from
    // the OS clock here.
    const userActive = reported.platform === "iOS"
      ? null
      : reported.userActive === false
        ? false
        : this.options.readUserActive?.() ?? null;
    const { userActive: _callerClaim, ...rest } = reported;
    const presence: Record<string, unknown> = userActive === null ? rest : { ...rest, userActive };
    this.lastPresence = rest;
    await this.sendPresence(presence);
    return { userActive };
  }

  /**
   * The screen locked or the machine is going to sleep: say so now. The relay
   * would otherwise keep the phone quiet on the last "in use" report until it
   * ages out of its presence window.
   */
  reportUserAway(): Promise<void> {
    return this.queuePresenceChange("away", async () => {
      const last = this.lastPresence;
      if (!last) return;
      await this.sendPresence({
        ...last,
        appForeground: false,
        userActive: false,
        observedAt: new Date().toISOString(),
      });
    });
  }

  /** Unlocked or awake again: refresh the last report with the live clock. */
  reportUserBack(): Promise<void> {
    return this.queuePresenceChange("back", async () => {
      const last = this.lastPresence;
      if (!last) return;
      await this.reportPresence({ ...last, observedAt: new Date().toISOString() });
    });
  }

  /**
   * Away and back go out one after the other, in the order they happened: a
   * quick lock and unlock must not let the "away" land last and release the
   * phone while the person is at the computer.
   */
  private queuePresenceChange(change: "away" | "back", send: () => Promise<void>): Promise<void> {
    const next = this.presenceChanges.then(send).catch((error) => this.warnPresenceFailed(change, error));
    this.presenceChanges = next;
    return next;
  }

  /** Relay outages are already logged once by `sendPresence`; anything else lands here. */
  private warnPresenceFailed(change: "away" | "back", error: unknown): void {
    this.options.getLogger().warn("attention.presence_change_failed", {
      change,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async sendPresence(presence: Record<string, unknown>): Promise<void> {
    if (this.currentAccountOwnerId() && this.options.accountAttentionClient) {
      // Presence is a best-effort heartbeat with nobody waiting on it, and the
      // next one carries the latest state. While the relay is unreachable the
      // report is dropped, not failed.
      if (this.relayBackingOff()) return;
      try {
        await this.options.accountAttentionClient.reportAttentionPresence(
          presence as AttentionPresence,
        );
        this.noteRelayAvailable();
      } catch (error) {
        if (!isRelayUnavailable(error)) throw error;
        this.noteRelayUnavailable("presence", error);
      }
      return;
    }
    if (this.options.localRuntimeConnectionPool) {
      await this.options.localRuntimeConnectionPool.callAttention<void>(
        "reportPresence",
        presence as AttentionPresence & Record<string, unknown>,
        { timeoutMs: ATTENTION_IPC_BUDGET_MS },
      );
    }
  }

  /**
   * The account's Activity preferences, or `null` when the relay cannot be
   * reached right now. `null` means "unknown, keep what you have": answering
   * with the defaults instead would quietly undo the user's hide-details and
   * badge choices on every network blip.
   */
  async getPreferences(input: unknown): Promise<AttentionPreferences | null> {
    const request = isRecord(input) ? input as AttentionPreferenceRequest : {};
    const accountOwnerId = this.requireCurrentAccountOwner(request.accountOwnerId);
    if (this.options.accountAttentionClient) {
      if (this.relayBackingOff()) return null;
      try {
        const preferences =
          await this.options.accountAttentionClient.getAttentionPreferences(accountOwnerId)
          ?? DEFAULT_ATTENTION_PREFERENCES;
        this.noteRelayAvailable();
        this.options.onPreferences?.(accountOwnerId, preferences);
        return preferences;
      } catch (error) {
        if (!isRelayUnavailable(error)) throw error;
        this.noteRelayUnavailable("preferences", error);
        return null;
      }
    }
    if (!this.options.localRuntimeConnectionPool) return DEFAULT_ATTENTION_PREFERENCES;
    return await this.options.localRuntimeConnectionPool.callAttention<AttentionPreferences>(
      "getPreferences",
      { accountOwnerId },
      { timeoutMs: ATTENTION_IPC_BUDGET_MS },
    );
  }

  async putPreferences(input: unknown): Promise<void> {
    const request = isRecord(input) ? input as AttentionPreferenceUpdateRequest : null;
    if (!request || !isRecord(request.preferences)) {
      throw new Error("A valid Activity preferences payload is required.");
    }
    const accountOwnerId = this.requireCurrentAccountOwner(request.accountOwnerId);
    if (this.options.accountAttentionClient) {
      await this.options.accountAttentionClient.putAttentionPreferences(
        accountOwnerId,
        request.preferences as AttentionPreferences,
      );
      return;
    }
    if (!this.options.localRuntimeConnectionPool) {
      throw new Error("Account Activity is unavailable until this computer's ADE brain is ready.");
    }
    await this.options.localRuntimeConnectionPool.callAttention<void>(
      "putPreferences",
      {
        accountOwnerId,
        preferences: request.preferences,
      },
    );
  }

  async putActivityMachinePreferences(
    machineKey: unknown,
    partial: unknown,
    expectedAccountOwnerId?: unknown,
  ): Promise<void> {
    const normalizedMachineKey = typeof machineKey === "string" ? machineKey.trim() : "";
    if (!normalizedMachineKey || !isRecord(partial)) {
      throw new Error("A valid Activity machine preference update is required.");
    }
    const accountOwnerId = expectedAccountOwnerId === undefined
      ? this.currentAccountOwnerId()
      : this.requireCurrentAccountOwner(expectedAccountOwnerId);
    if (!accountOwnerId) {
      throw new Error("Sign in before changing Activity machine preferences.");
    }
    if (
      !this.options.accountAttentionClient
      || !this.options.accountAttentionClient.putActivityMachinePreferences
    ) {
      throw new Error("Account Activity is unavailable until this computer's ADE brain is ready.");
    }
    await this.options.accountAttentionClient.putActivityMachinePreferences(
      accountOwnerId,
      normalizedMachineKey,
      partial as Partial<AttentionPreferenceScope>,
    );
  }

  /**
   * Mute or unmute one chat's notifications on every device. The mute lives in
   * the account's Activity preferences, so it needs no route to the machine the
   * chat runs on.
   */
  async setSessionMuted(
    sessionId: unknown,
    muted: unknown,
    expectedAccountOwnerId?: unknown,
  ): Promise<void> {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId || typeof muted !== "boolean") {
      throw new Error("A chat and a mute setting are required.");
    }
    const accountOwnerId = expectedAccountOwnerId === undefined
      ? this.currentAccountOwnerId()
      : this.requireCurrentAccountOwner(expectedAccountOwnerId);
    if (!accountOwnerId) {
      throw new Error("Sign in to mute a chat's notifications.");
    }
    if (!this.options.accountAttentionClient?.setAttentionSessionMuted) {
      throw new Error("Account Activity is unavailable until this computer's ADE brain is ready.");
    }
    await this.options.accountAttentionClient.setAttentionSessionMuted(
      accountOwnerId,
      normalizedSessionId,
      muted,
    );
    // Desktop notifications read the last loaded preferences; apply the mute
    // to them now so a message arriving right after it stays quiet. A throw
    // here must not fail a mute the relay already saved — the renderer would
    // roll back and say it could not mute a chat that is muted.
    try {
      this.options.onSessionMuted?.(accountOwnerId, normalizedSessionId, muted);
    } catch (error) {
      this.options.getLogger().warn("attention.session_mute_observer_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Drop a removed machine's Activity from the account feed.
   *
   * Removing a machine deletes one account-directory row and nothing else, so
   * its items outlived the machine (idle rows are written with no expiry). The
   * relay owns the purge; this is the desktop's call into it, and it reports
   * failure instead of swallowing it — a machine the user believes is gone must
   * not keep showing work.
   */
  async purgeMachineActivity(machineKey: unknown): Promise<void> {
    const normalizedMachineKey = typeof machineKey === "string" ? machineKey.trim() : "";
    if (!normalizedMachineKey) {
      throw new Error("A machine is required to clear its Activity.");
    }
    const accountOwnerId = this.currentAccountOwnerId();
    if (!accountOwnerId) return;
    const purge = this.options.accountAttentionClient?.purgeAccountMachineActivity;
    if (!purge) {
      this.options.getLogger().warn("attention.machine_purge_unsupported", {
        machineKey: normalizedMachineKey,
        recovery: "update_relay_client",
      });
      return;
    }
    await purge(accountOwnerId, normalizedMachineKey);
  }

  private currentAccountOwnerId(): string | null {
    return this.options.getCurrentAccountOwnerId()?.trim() || null;
  }

  /**
   * The revisions to quote for a batch.
   *
   * The renderer's numbers are authoritative: they are the revisions the user
   * actually saw. The coordinator's own map is a per-process cache written by
   * whichever surface polled last — another window, the web
   * shell — so treating it as the source of truth quoted a revision nobody had
   * been shown and manufactured staleness for every live item. It is kept only
   * to fill in items the caller did not send.
   */
  private resolveSourceRevisions(
    itemIds: string[],
    supplied: unknown,
  ): Record<string, number> {
    const requested = isRecord(supplied) ? supplied : {};
    const revisions: Record<string, number> = {};
    for (const itemId of itemIds) {
      const value = Number(requested[itemId]);
      if (Number.isFinite(value)) {
        revisions[itemId] = value;
        continue;
      }
      const remembered = this.lastSnapshotItemRevisions.get(itemId);
      if (remembered !== undefined) revisions[itemId] = remembered;
    }
    return revisions;
  }

  private rememberSnapshot(
    snapshot: AttentionSnapshot,
    accountOwnerId: string | null,
  ): void {
    this.lastSnapshotScope = snapshot.scope ?? null;
    this.lastSnapshotAccountOwnerId = accountOwnerId;
    // Merge rather than replace. Snapshots are delta-capable and arrive from
    // several surfaces, so clearing the map on every poll dropped revisions a
    // still-open detail sheet was about to acknowledge.
    for (const item of snapshot.items) {
      this.lastSnapshotItemRevisions.delete(item.id);
      this.lastSnapshotItemRevisions.set(item.id, item.revision);
    }
    // Bounded, insertion-ordered: the oldest untouched ids fall off first.
    while (this.lastSnapshotItemRevisions.size > MAX_REMEMBERED_ITEM_REVISIONS) {
      const oldest = this.lastSnapshotItemRevisions.keys().next();
      if (oldest.done) break;
      this.lastSnapshotItemRevisions.delete(oldest.value);
    }
  }

  private requireCurrentAccountOwner(value: unknown): string {
    const accountOwnerId = typeof value === "string" ? value.trim() : "";
    if (!accountOwnerId) {
      throw new Error("A valid Activity account owner is required.");
    }
    if (this.currentAccountOwnerId() !== accountOwnerId) {
      throw new Error("The ADE account changed before Activity preferences could be used.");
    }
    return accountOwnerId;
  }

  private describeRuntimeCompatibilityFailure(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/method attention\.call failed.*code -32601|method not found|domain ['"]attention['"] is unavailable|action ['"]attention\./i
        .test(message)
    ) {
      return null;
    }
    if (!this.loggedRuntimeCompatibilityFailure) {
      this.loggedRuntimeCompatibilityFailure = true;
      this.options.getLogger().warn("attention.runtime_incompatible", {
        reason: message.slice(0, 2_000),
        recovery: "update_and_restart_ade_brain",
      });
    }
    return (
      "Account Activity requires a newer connected ADE brain. "
      + "Update and restart ADE on the host machine to see account-wide work."
    );
  }

  private describeAccountFailure(
    error: unknown,
  ): Pick<NonNullable<AttentionSnapshot["availability"]>, "title" | "message" | "recovery"> {
    if (error instanceof PushRelayRequestError && error.status === 401) {
      return {
        title: "Account session needs attention",
        message:
          "ADE could not verify your account after refreshing the session. "
          + "Sign out and back in to restore account-wide Activity.",
        recovery: "sign_in",
      };
    }
    if (error instanceof PushRelayRequestError && error.status === 503) {
      return {
        title: "Account Activity is temporarily unavailable",
        message:
          "ADE's account service is not ready. Machine-scoped work remains available while it recovers.",
        recovery: "retry",
      };
    }
    return {
      title: "Account Activity is reconnecting",
      message:
        "ADE cannot reach the account stream right now. Machine-scoped work remains available.",
      recovery: "retry",
    };
  }
}
