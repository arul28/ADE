import {
  ATTENTION_CONTRACT_VERSION,
  ATTENTION_EVENT_KINDS,
  ATTENTION_PHASES,
  DEFAULT_ATTENTION_PREFERENCES,
  attentionDestinationDeepLink,
  runAcknowledgmentChunks,
  unreachedOutcomeFields,
  type AttentionAction,
  type AttentionDestination,
  type AttentionEventKind,
  type AttentionItem,
  type AttentionMachineRef,
  type AttentionPhase,
  type AttentionPreferences,
  type AttentionPreferenceScope,
  type AttentionPresence,
  type AttentionProjectRef,
  type AttentionSnapshot,
  type AttentionTombstone,
} from "../../../shared/types";
import {
  deeplinkToNavigationTarget,
  parseDeeplink,
  type DeeplinkTarget,
} from "../../../shared/deeplinks";
import { targetToWebUrl } from "../shell/webRoutes";
import {
  browserAccountIsSignedIn,
  type BrowserAccountClient,
} from "../account/client";
import type { AdapterInfra } from "./types";

const DEFAULT_RELAY_URL = "https://ade-push-relay.arulsharma1028.workers.dev";

type RelayResult = {
  response: Response;
  body: unknown;
};

/**
 * Open an Activity destination in a new browser tab.
 *
 * Returns false when the tab could not be opened — no `window`, or a popup
 * blocker that did not see this click as user-initiated — so the caller can
 * fall back to navigating in place rather than leaving the click dead.
 */
function openWebTargetInNewTab(target: DeeplinkTarget): boolean {
  if (typeof window === "undefined") return false;
  try {
    // `noopener` keeps the new tab from reaching back into this one; without it
    // the opened document inherits a scriptable handle to the workspace.
    const opened = window.open(targetToWebUrl(target), "_blank", "noopener,noreferrer");
    return Boolean(opened);
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** Matches the notch snapshot parser's bound on the same field. */
const MAX_ALERT_FINGERPRINT_LENGTH = 1_024;

/** One chunk's slice of a per-item map. Sent whole, it would name outside ids. */
function pickForChunk<T>(source: Record<string, T>, chunk: string[]): Record<string, T> {
  const picked: Record<string, T> = {};
  for (const itemId of chunk) {
    const value = source[itemId];
    if (value !== undefined) picked[itemId] = value;
  }
  return picked;
}

/**
 * Keep an acknowledgment's alert fence to the batch it belongs to.
 *
 * Mirrors `AttentionAccountCoordinator.resolveAlertFingerprints` so the browser
 * shell and the Electron main process quote the same thing: entries for ids
 * outside the batch, blanks, and over-long values are dropped rather than sent,
 * and a dropped entry simply leaves that item unfenced.
 */
function boundedAlertFingerprints(
  itemIds: readonly string[],
  supplied: Record<string, string>,
): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const itemId of itemIds) {
    const value = supplied[itemId];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ALERT_FINGERPRINT_LENGTH) continue;
    fingerprints[itemId] = trimmed;
  }
  return fingerprints;
}

function parseMachine(value: unknown): AttentionMachineRef | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.machineKey !== "string"
    || typeof candidate.name !== "string"
    || typeof candidate.online !== "boolean"
    || !optionalString(candidate.lastSeenAt)
    || !optionalString(candidate.accountMachineKey)
    || !optionalString(candidate.deviceId)
  ) return null;
  return candidate as AttentionMachineRef;
}

function parseProject(value: unknown): AttentionProjectRef | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.projectId !== "string"
    || typeof candidate.name !== "string"
    || !optionalString(candidate.rootPath)
  ) return null;
  return candidate as AttentionProjectRef;
}

function parseDestination(value: unknown): AttentionDestination | null {
  const candidate = record(value);
  if (!candidate || !optionalString(candidate.eventId)) return null;
  if (
    candidate.kind === "session"
    && typeof candidate.sessionId === "string"
    && optionalString(candidate.itemId)
  ) return candidate as AttentionDestination;
  if (
    candidate.kind === "pull_request"
    && Number.isInteger(candidate.number)
    && candidate.number as number > 0
    && ["overview", "activity", "checks", "files"].includes(String(candidate.tab))
    && optionalString(candidate.prId)
    && optionalString(candidate.repoOwner)
    && optionalString(candidate.repoName)
  ) return candidate as AttentionDestination;
  return null;
}

function parseAction(value: unknown): AttentionAction | null {
  const candidate = record(value);
  const payload = candidate?.payload === undefined
    ? undefined
    : record(candidate.payload);
  if (
    !candidate
    || typeof candidate.id !== "string"
    || ![
      "approve",
      "deny",
      "answer",
      "restart",
      "rerun_checks",
      "mark_seen",
      "dismiss",
      "open",
    ].includes(String(candidate.kind))
    || typeof candidate.label !== "string"
    || (candidate.destructive !== undefined && typeof candidate.destructive !== "boolean")
    || (candidate.payload !== undefined && !payload)
    || (payload && !Object.values(payload).every((entry) =>
      entry === null
      || typeof entry === "string"
      || typeof entry === "number"
      || typeof entry === "boolean"))
  ) return null;
  return candidate as AttentionAction;
}

function parseAttentionItem(value: unknown): AttentionItem | null {
  const candidate = record(value);
  const machine = parseMachine(candidate?.machine);
  const project = parseProject(candidate?.project);
  const destination = parseDestination(candidate?.destination);
  const actions = Array.isArray(candidate?.actions)
    ? candidate.actions.map(parseAction)
    : null;
  const recentActivityValid = candidate?.recentActivity === undefined
    || (
      Array.isArray(candidate.recentActivity)
      && candidate.recentActivity.every((entry) => typeof entry === "string")
    );
  const progress = candidate?.planProgress === undefined || candidate?.planProgress === null
    ? candidate?.planProgress
    : record(candidate.planProgress);
  const progressValid = progress === undefined
    || progress === null
    || (
      Number.isInteger(progress.completed)
      && Number.isInteger(progress.total)
      && optionalString(progress.current)
    );
  if (
    !candidate
    || candidate.contractVersion !== ATTENTION_CONTRACT_VERSION
    || !optionalString(candidate.accountOwnerId)
    || typeof candidate.id !== "string"
    || !Number.isInteger(candidate.revision)
    || typeof candidate.fingerprint !== "string"
    || !["agent", "pull_request"].includes(String(candidate.kind))
    || !ATTENTION_EVENT_KINDS.includes(candidate.eventKind as AttentionEventKind)
    || !ATTENTION_PHASES.includes(candidate.phase as AttentionPhase)
    || (
      candidate.activityTier !== undefined
      && !["signal", "ambient", "idle"].includes(String(candidate.activityTier))
    )
    || (candidate.contentFingerprint !== undefined && typeof candidate.contentFingerprint !== "string")
    || (candidate.alertFingerprint !== undefined && typeof candidate.alertFingerprint !== "string")
    || !machine
    || !project
    || !destination
    || !actions
    || actions.some((action) => !action)
    || !optionalString(candidate.laneId)
    || !optionalString(candidate.laneName)
    || !optionalString(candidate.provider)
    || !optionalString(candidate.model)
    || typeof candidate.title !== "string"
    || typeof candidate.preview !== "string"
    || typeof candidate.privacyPreview !== "string"
    || !optionalString(candidate.detail)
    || !recentActivityValid
    || !progressValid
    || typeof candidate.occurredAt !== "string"
    || typeof candidate.updatedAt !== "string"
    || !optionalString(candidate.statusSince)
    || !optionalString(candidate.seenAt)
    || !optionalString(candidate.dismissedAt)
    || !optionalString(candidate.expiresAt)
  ) return null;
  return {
    ...candidate,
    machine,
    project,
    destination,
    actions: actions as AttentionAction[],
  } as AttentionItem;
}

function parseTombstone(value: unknown): AttentionTombstone | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.id !== "string"
    || !Number.isInteger(candidate.revision)
    || typeof candidate.deletedAt !== "string"
  ) return null;
  return candidate as AttentionTombstone;
}

function parseAttentionSnapshot(value: unknown): AttentionSnapshot {
  const candidate = record(value);
  const items = Array.isArray(candidate?.items)
    ? candidate.items.map(parseAttentionItem)
    : null;
  const tombstones = candidate?.tombstones === undefined
    ? []
    : Array.isArray(candidate.tombstones)
      ? candidate.tombstones.map(parseTombstone)
      : null;
  const machines = candidate?.machines === undefined
    ? undefined
    : Array.isArray(candidate.machines)
      ? candidate.machines.map(parseMachine)
      : null;
  if (
    !candidate
    || candidate.contractVersion !== ATTENTION_CONTRACT_VERSION
    || !Number.isInteger(candidate.revision)
    || typeof candidate.generatedAt !== "string"
    || !optionalString(candidate.streamId)
    || !items
    || items.some((item) => !item)
    || !tombstones
    || tombstones.some((item) => !item)
    || machines === null
    || machines?.some((machine) => !machine)
    || (candidate.itemsTruncated !== undefined && typeof candidate.itemsTruncated !== "boolean")
  ) {
    throw new Error(
      "ADE Activity returned an incompatible response. Update ADE and retry.",
    );
  }
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    accountOwnerId: candidate.accountOwnerId as string | null | undefined,
    streamId: candidate.streamId as string | null | undefined,
    revision: candidate.revision as number,
    generatedAt: candidate.generatedAt,
    machines: machines as AttentionMachineRef[] | undefined,
    items: items as AttentionItem[],
    itemsTruncated: candidate.itemsTruncated as boolean | undefined,
    tombstones: tombstones as AttentionTombstone[],
  };
}

function isPreferenceScope(value: unknown, partial = false): value is AttentionPreferenceScope {
  const candidate = record(value);
  if (!candidate) return false;
  const required = (
    key: keyof AttentionPreferenceScope,
    predicate: (field: unknown) => boolean,
  ): boolean => partial && candidate[key] === undefined
    ? true
    : predicate(candidate[key]);
  return (
    required("eventPolicies", (field) => {
      const policies = record(field);
      if (!policies) return false;
      return (partial || ATTENTION_EVENT_KINDS.every((kind) => kind in policies))
        && Object.entries(policies).every(([kind, policy]) =>
          ATTENTION_EVENT_KINDS.includes(kind as AttentionEventKind)
          && ["off", "ambient", "notify"].includes(String(policy)));
    })
    && required("notificationsEnabled", (field) => typeof field === "boolean")
    && required("liveActivitiesEnabled", (field) => typeof field === "boolean")
    && required("desktopFirstEnabled", (field) => typeof field === "boolean")
    && required("desktopFirstDelaySeconds", (field) =>
      typeof field === "number" && Number.isFinite(field) && field >= 0)
    && required("soundsEnabled", (field) => typeof field === "boolean")
    && required("celebrationsEnabled", (field) => typeof field === "boolean")
    && required("hideDetails", (field) => typeof field === "boolean")
    && required("dockBadgeScope", (field) => field === "local" || field === "account")
    && required("quietHours", (field) => {
      const quietHours = record(field);
      return Boolean(
        quietHours
        && typeof quietHours.enabled === "boolean"
        && Number.isInteger(quietHours.startMinute)
        && Number.isInteger(quietHours.endMinute)
        && typeof quietHours.timeZone === "string",
      );
    })
  );
}

function parseAttentionPreferences(value: unknown): AttentionPreferences {
  const candidate = record(value);
  const account = record(candidate?.account);
  const normalizedAccount = account && account.dockBadgeScope === undefined
    ? { ...account, dockBadgeScope: "local" }
    : account;
  const devices = record(candidate?.devices);
  const machines = candidate?.machines === undefined ? {} : record(candidate.machines);
  const projects = record(candidate?.projects);
  if (
    !candidate
    || !isPreferenceScope(normalizedAccount)
    || !devices
    || !Object.values(devices).every((scope) => isPreferenceScope(scope, true))
    || !machines
    || !Object.values(machines).every((scope) => isPreferenceScope(scope, true))
    || !projects
    || !Object.values(projects).every((scope) => isPreferenceScope(scope, true))
    || !Array.isArray(candidate.mutedSessionIds)
    || !candidate.mutedSessionIds.every((id) => typeof id === "string")
  ) {
    throw new Error(
      "Activity preferences were incompatible. Update ADE and retry.",
    );
  }
  return {
    ...candidate,
    account: normalizedAccount,
    machines,
  } as AttentionPreferences;
}

function relayBaseUrl(): string {
  const configured = (
    import.meta.env.VITE_ADE_PUSH_RELAY_URL as string | undefined
  )?.trim();
  return (configured || DEFAULT_RELAY_URL).replace(/\/+$/, "");
}

function relayError(action: string, result: RelayResult): Error {
  const body = record(result.body);
  const reason = typeof body?.recovery === "string"
    ? body.recovery
    : typeof body?.error === "string"
      ? body.error
      : `HTTP ${result.response.status}`;
  return new Error(`Activity ${action} failed. ${reason}`);
}

/**
 * Backoff state for the push relay, shared by every Activity call.
 *
 * The relay is reached straight from the browser and is origin-gated, so a
 * rejected origin fails at CORS PREFLIGHT — `fetch` throws before any response
 * exists, and no amount of response handling downstream can see it. The Activity
 * pollers run on fixed 15s/30s timers with `.catch(() => {})`, so a permanently
 * rejected origin produced an unbounded stream of identical console errors for
 * as long as the tab stayed open.
 *
 * A failure that repeats is not worth re-asking at full rate: back off
 * exponentially and, crucially, refuse BEFORE issuing the fetch, so the
 * suppressed attempts cost no request and print nothing. Any success clears it.
 *
 * Module scope is load-bearing: the federated web client builds one adapter per
 * machine binding plus a fallback, so per-instance state would let each of them
 * hammer the same dead relay on its own schedule. Only the pollers are gated —
 * a user action is always allowed through, and its success clears the backoff
 * for everyone.
 *
 * The backoff is also scoped to the account session that earned it. Most of the
 * failures worth backing off from (a 403 for a machine on another account) are
 * properties of WHO is signed in, so carrying them across a sign-in would leave
 * a correct account throttled for up to five minutes because the previous one
 * was wrong.
 */
const RELAY_BACKOFF_BASE_MS = 5_000;
const RELAY_BACKOFF_MAX_MS = 5 * 60_000;
let relayConsecutiveFailures = 0;
let relayNextAttemptAtMs = 0;
/** `${userId}:${generation}` of the session the current backoff was earned under. */
let relayBackoffSessionKey: string | null = null;

/** Clear the push-relay backoff outright. Exported for the account-change path and tests. */
export function resetRelayPushBackoff(): void {
  relayConsecutiveFailures = 0;
  relayNextAttemptAtMs = 0;
  relayBackoffSessionKey = null;
}

function noteRelaySuccess(): void {
  resetRelayPushBackoff();
}

function noteRelayFailure(): void {
  relayConsecutiveFailures += 1;
  const backoff = Math.min(
    RELAY_BACKOFF_MAX_MS,
    RELAY_BACKOFF_BASE_MS * 2 ** (relayConsecutiveFailures - 1),
  );
  // Jitter so several surfaces polling the same dead relay do not resynchronize
  // into one thundering retry.
  relayNextAttemptAtMs = Date.now() + backoff * (0.75 + Math.random() * 0.5);
}

function relayBackoffActive(): boolean {
  return relayConsecutiveFailures > 0 && Date.now() < relayNextAttemptAtMs;
}

/**
 * Drop a backoff earned under a different account session, so a fresh or
 * corrected sign-in starts clean instead of serving out the old one's penalty.
 */
function syncRelayBackoffToSession(sessionKey: string | null): void {
  if (relayBackoffSessionKey === sessionKey) return;
  resetRelayPushBackoff();
  relayBackoffSessionKey = sessionKey;
}

export function createAttentionNamespace(
  infra: AdapterInfra,
  accountClient: BrowserAccountClient,
): Window["ade"]["attention"] {
  let lastSnapshotScope: AttentionSnapshot["scope"] | null = null;
  let lastSnapshotAccountOwnerId: string | null = null;

  const rememberSnapshot = (snapshot: AttentionSnapshot): AttentionSnapshot => {
    lastSnapshotScope = snapshot.scope ?? null;
    lastSnapshotAccountOwnerId = snapshot.accountOwnerId?.trim() || null;
    return snapshot;
  };

  const incompatibleMachineSnapshot = (): AttentionSnapshot => {
    const hostName = infra.client.getStatus().hostName?.trim() || "Connected ADE host";
    return {
      contractVersion: ATTENTION_CONTRACT_VERSION,
      scope: "machine",
      availability: {
        state: "incompatible",
        title: `${hostName} needs an ADE update`,
        message: `Update ADE on ${hostName}, then reconnect to load this machine's Activity.`,
        recovery: "update_host",
        hostName,
      },
      streamId: null,
      revision: 0,
      generatedAt: new Date().toISOString(),
      items: [],
      tombstones: [],
    };
  };


  const request = async (
    action: string,
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    body?: unknown,
    options: { userInitiated?: boolean } = {},
  ): Promise<unknown> => {
    const lease = accountClient.captureSessionLease();
    syncRelayBackoffToSession(lease ? `${lease.userId}:${lease.generation}` : null);
    // The backoff exists to silence the fixed-interval pollers. A user who just
    // clicked something gets their attempt, and if it succeeds the pollers
    // resume immediately.
    if (!options.userInitiated && relayBackoffActive()) {
      throw new Error("ADE Activity is temporarily unavailable; retrying shortly.");
    }
    if (!lease) throw new Error("Sign in to use account-wide Activity.");
    const requestOnce = async (forceRefresh: boolean): Promise<RelayResult> => {
      const accessToken = await accountClient.getAccessToken({ forceRefresh });
      if (!accountClient.isSessionLeaseCurrent(lease)) {
        throw new Error("The ADE account changed before Activity could load.");
      }
      const response = await fetch(`${relayBaseUrl()}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const parsed = await response.json().catch(() => null);
      return { response, body: parsed };
    };
    let result: RelayResult;
    try {
      result = await requestOnce(false);
      if (result.response.status === 401) result = await requestOnce(true);
    } catch (error) {
      // Network-level failure: a rejected CORS preflight, DNS, or the socket.
      // There is no response to inspect, which is exactly why this needed to be
      // caught here rather than left to the status checks below.
      noteRelayFailure();
      throw error;
    }
    if (!result.response.ok) {
      // 5xx and 429 are transient; other 4xx mean this client is not going to
      // be served until something changes. Both back off — the difference is
      // only how fast they reach the cap, and that is not worth a second knob.
      noteRelayFailure();
      throw relayError(action, result);
    }
    noteRelaySuccess();
    return result.body ?? {};
  };

  return {
    async getSnapshot(since = 0, streamId?: string | null) {
      if (!browserAccountIsSignedIn(accountClient.getSnapshot().state)) {
        if (!infra.commands.hasAction("attention.getMachineSnapshot")) {
          return rememberSnapshot(incompatibleMachineSnapshot());
        }
        const remoteSnapshot = await infra.commands.call<unknown | null>(
          "attention.getMachineSnapshot",
          {},
          {
            fallback: null,
            idempotent: true,
            requireProject: false,
          },
        );
        if (remoteSnapshot === null) return rememberSnapshot(incompatibleMachineSnapshot());
        const snapshot = parseAttentionSnapshot(remoteSnapshot);
        const hostName = infra.client.getStatus().hostName?.trim() || "this ADE machine";
        return rememberSnapshot({
          ...snapshot,
          scope: "machine",
          availability: {
            state: "signed_out",
            title: `Showing ${hostName} only`,
            message: `Activity from ${hostName} is available. Sign in to combine work across every ADE machine.`,
            recovery: "sign_in",
            hostName,
          },
        });
      }
      const query = new URLSearchParams({
        since: String(Math.max(0, Math.trunc(since))),
      });
      if (streamId?.trim()) query.set("streamId", streamId.trim());
      const snapshot = parseAttentionSnapshot(await request(
        "snapshot",
        "GET",
        `/attention/account/snapshot?${query.toString()}`,
      ));
      return rememberSnapshot({
        ...snapshot,
        scope: "account",
        accountOwnerId: accountClient.getSnapshot().userId?.trim() || null,
        availability: {
          state: "ready",
          title: "Activity is live",
          message: "Work from every signed-in ADE machine is available.",
          recovery: null,
        },
      });
    },

    async acknowledge(args) {
      const accountSnapshot = accountClient.getSnapshot();
      const currentAccountOwnerId = browserAccountIsSignedIn(accountSnapshot.state)
        ? accountSnapshot.userId?.trim() || null
        : null;
      if (currentAccountOwnerId !== lastSnapshotAccountOwnerId) {
        throw new Error(
          "The ADE account changed after Activity loaded. Refresh Activity, then try again.",
        );
      }
      // Deliberately NOT fenced on "did this adapter personally see the item at
      // this exact revision". Revision is a raw epoch-ms that advances on every
      // publish, so a live agent outruns any poll and that fence rejected the
      // normal case. The narrow fence that remains is `alertFingerprints`: the
      // caller quotes the alert identity it rendered per item, and the relay
      // refuses only when the stored alert has since changed — which is exactly
      // the case where an in-flight bulk ack would otherwise swallow a
      // `needs_you` the user never saw. Items with no quoted fingerprint stay
      // unfenced, so one bulk call still clears the inbox.
      //
      // Every per-item map is rebuilt PER CHUNK rather than sliced alongside:
      // the relay rejects an acknowledgment whose fence names an id outside the
      // batch, so a whole-batch map sent with a partial id list is a 400 for
      // the entire call.
      const chunkRequest = (chunk: string[]) => ({
        ...args,
        itemIds: chunk,
        ...(args.alertFingerprints
          ? { alertFingerprints: boundedAlertFingerprints(chunk, args.alertFingerprints) }
          : {}),
        ...(args.sourceRevisions
          ? { sourceRevisions: pickForChunk(args.sourceRevisions, chunk) }
          : {}),
      });
      // Chunked, never truncated: this shell used to send the whole list, so a
      // "Clear all" over a large inbox hit the relay's hard `itemIds.length >
      // 64` rejection and dismissed nothing at all. Chunking, the abort policy
      // and the per-item aggregation all live in `runAcknowledgmentChunks`,
      // shared with the Electron coordinator so the two shells cannot drift.
      if (lastSnapshotScope === "machine") {
        if (!infra.commands.hasAction("attention.acknowledgeMachine")) {
          const hostName = infra.client.getStatus().hostName?.trim() || "the connected ADE host";
          throw new Error(
            `Update ADE on ${hostName}, reconnect, then try this Activity action again.`,
          );
        }
        // The host answers per CHUNK, not per item: it applies the whole
        // payload or throws. So no chunk yields stale ids, and an id that did
        // not land was never answered for — `unreached`, not `stale`. It rolls
        // back either way, but nothing about it changed underneath the user.
        const machine = await runAcknowledgmentChunks(args.itemIds, async (chunk) => {
          await infra.commands.call(
            "attention.acknowledgeMachine",
            chunkRequest(chunk) as unknown as Record<string, unknown>,
            {
              fallback: () => {
                throw new Error(
                  "The connected ADE host could not acknowledge this machine item.",
                );
              },
              idempotent: false,
              requireProject: false,
            },
          );
          return [];
        });
        if (machine.acknowledged.length === 0 && machine.failure) throw machine.failure;
        return {
          acknowledged: machine.acknowledged,
          stale: machine.stale,
          ...unreachedOutcomeFields(machine.unreached, machine.failure),
        };
      }
      if (lastSnapshotScope !== "account" || !currentAccountOwnerId) {
        throw new Error("Refresh account Activity before acknowledging this item.");
      }
      // One relay call per chunk, and its per-item verdict is returned rather
      // than discarded, so a partially applied "Clear all" keeps the rows it
      // actually cleared.
      const relay = await runAcknowledgmentChunks(args.itemIds, async (chunk) => {
        const result = record(await request(
          "acknowledgment",
          "POST",
          "/attention/account/ack",
          chunkRequest(chunk),
          { userInitiated: true },
        ));
        return Array.isArray(result?.stale)
          ? result.stale.filter((itemId): itemId is string => typeof itemId === "string")
          : [];
      });
      // Nothing landed: surface the real reason rather than a silent partial.
      if (relay.acknowledged.length === 0 && relay.failure) throw relay.failure;
      return {
        acknowledged: relay.acknowledged,
        stale: relay.stale,
        ...unreachedOutcomeFields(relay.unreached, relay.failure),
      };
    },

    async reportPresence(presence: AttentionPresence) {
      if (!browserAccountIsSignedIn(accountClient.getSnapshot().state)) return;
      await request("presence", "POST", "/attention/account/presence", presence);
    },

    async getPreferences(accountOwnerId: string) {
      const owner = accountClient.getSnapshot().userId?.trim() ?? "";
      if (!owner || owner !== accountOwnerId.trim()) {
        throw new Error("The ADE account changed before Activity settings could load.");
      }
      const result = record(await request(
        "preferences",
        "GET",
        "/attention/account/preferences",
        undefined,
        { userInitiated: true },
      ));
      return result?.preferences === undefined
        ? DEFAULT_ATTENTION_PREFERENCES
        : parseAttentionPreferences(result.preferences);
    },

    async putPreferences(
      accountOwnerId: string,
      preferences: AttentionPreferences,
    ) {
      const owner = accountClient.getSnapshot().userId?.trim() ?? "";
      if (!owner || owner !== accountOwnerId.trim()) {
        throw new Error("The ADE account changed before Activity settings could be saved.");
      }
      const {
        devices: _deviceOverrides,
        machines: _machineOverrides,
        ...accountPreferences
      } = preferences;
      await request(
        "preference update",
        "PUT",
        "/attention/account/preferences",
        accountPreferences,
        { userInitiated: true },
      );
    },

    /**
     * Per-machine notification mute. It has its own relay route rather than
     * riding the preferences PUT because that PUT strips `devices` and
     * `machines` before replacing the account document — a partial machine
     * scope written that way would race every other tab editing preferences.
     */
    async putMachinePreferences(
      accountOwnerId: string,
      machineKey: string,
      preferences: Partial<AttentionPreferenceScope>,
    ) {
      const owner = accountClient.getSnapshot().userId?.trim() ?? "";
      if (!owner || owner !== accountOwnerId.trim()) {
        throw new Error("The ADE account changed before Activity settings could be saved.");
      }
      const key = machineKey.trim();
      if (!key) throw new Error("A machine is required to change its notifications.");
      await request(
        "machine preference update",
        "PATCH",
        `/attention/account/preferences/machines/${encodeURIComponent(key)}`,
        preferences,
        { userInitiated: true },
      );
    },

    async openItem(item: AttentionItem) {
      const accountSnapshot = accountClient.getSnapshot();
      const ownerMachineKey = item.machine.accountMachineKey?.trim() ?? "";
      const ownerMachine = ownerMachineKey
        ? accountSnapshot.machines.find((machine) => machine.machineKey === ownerMachineKey)
        : item.machine.deviceId
          ? accountSnapshot.machines.find((machine) => machine.deviceId === item.machine.deviceId)
          : null;
      const currentHostDeviceId = infra.client.getStatus().hostDeviceId?.trim() ?? "";
      if (ownerMachine && ownerMachine.deviceId !== currentHostDeviceId) {
        const lease = accountClient.captureSessionLease();
        if (!lease) throw new Error("Sign in again to open this Activity item.");
        const accessToken = await accountClient.getAccessToken();
        await infra.client.pairWithAccountMachine({
          machine: ownerMachine,
          accessToken,
          accountSessionLease: lease,
          isAccountSessionLeaseCurrent: (candidate) =>
            accountClient.isSessionLeaseCurrent(candidate),
          deviceName: `ADE Web on ${
            typeof window === "undefined"
              ? "browser"
              : window.location.hostname || "browser"
          }`,
          relayBaseUrls: accountClient.getRelayBaseUrls(),
          getRelayAccountToken: () => accountClient.getAccessToken(),
        });
      } else if (
        (ownerMachineKey || item.machine.deviceId)
        && !ownerMachine
        && item.machine.deviceId !== currentHostDeviceId
      ) {
        throw new Error(
          `${item.machine.name} owns this item but is no longer available in your ADE account.`,
        );
      }
      if (
        item.project.projectId
        && item.project.projectId !== infra.state.getProjectId()
      ) {
        // The item's projectId is the owning machine's `ade.db` uuid, which the
        // host's project registry has never seen — its resolver matches the
        // registry id OR the root path, so the root path is what actually
        // lands. Sending both keeps a same-machine id match working.
        const switched = await infra.client.switchProject(
          item.project.projectId,
          item.project.rootPath ?? null,
        );
        if (!switched.ok) {
          throw new Error(
            `${item.machine.name} owns this item. Connect to that machine, then open ${item.project.name}.`,
          );
        }
      }
      const parsed = parseDeeplink(attentionDestinationDeepLink(item.destination, item));
      if (!parsed.ok) throw new Error("This Activity destination is invalid.");
      const target = deeplinkToNavigationTarget(parsed.target);
      // Web opens the agent in a NEW TAB: the current tab is a workspace the
      // user is in the middle of, and an Activity click is a side errand.
      // A blocked popup is not a failure — fall back to navigating in place.
      if (openWebTargetInNewTab(parsed.target)) return;
      infra.events.emit("navigate", { target, source: "attention" });
    },
  };
}
