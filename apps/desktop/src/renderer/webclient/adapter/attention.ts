import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  attentionDestinationDeepLink,
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
} from "../../../shared/deeplinks";
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

const ATTENTION_PHASES = new Set<AttentionPhase>([
  "starting",
  "running",
  "needs_you",
  "blocked",
  "failed",
  "completed",
  "stale",
  "checks_failing",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "open",
  "merged",
  "closed",
]);

const ATTENTION_EVENT_KINDS = new Set<AttentionEventKind>([
  "agent_running",
  "agent_needs_you",
  "agent_failed",
  "agent_completed",
  "pr_checks_failing",
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready",
  "pr_merged",
  "pr_opened",
  "pr_closed",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
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
    || !ATTENTION_EVENT_KINDS.has(candidate.eventKind as AttentionEventKind)
    || !ATTENTION_PHASES.has(candidate.phase as AttentionPhase)
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
  ) {
    throw new Error(
      "ADE Attention returned an incompatible response. Update ADE and retry.",
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
      return (partial || [...ATTENTION_EVENT_KINDS].every((kind) => kind in policies))
        && Object.entries(policies).every(([kind, policy]) =>
          ATTENTION_EVENT_KINDS.has(kind as AttentionEventKind)
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
  const devices = record(candidate?.devices);
  const projects = record(candidate?.projects);
  if (
    !candidate
    || !isPreferenceScope(candidate.account)
    || !devices
    || !Object.values(devices).every((scope) => isPreferenceScope(scope, true))
    || !projects
    || !Object.values(projects).every((scope) => isPreferenceScope(scope, true))
    || !Array.isArray(candidate.mutedSessionIds)
    || !candidate.mutedSessionIds.every((id) => typeof id === "string")
  ) {
    throw new Error(
      "Account Attention preferences were incompatible. Update ADE and retry.",
    );
  }
  return candidate as AttentionPreferences;
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
  return new Error(`Account Attention ${action} failed. ${reason}`);
}

export function createAttentionNamespace(
  infra: AdapterInfra,
  accountClient: BrowserAccountClient,
): Window["ade"]["attention"] {
  let lastSnapshotScope: AttentionSnapshot["scope"] | null = null;
  let lastSnapshotAccountOwnerId: string | null = null;
  let lastMachineItemIds = new Set<string>();

  const rememberSnapshot = (snapshot: AttentionSnapshot): AttentionSnapshot => {
    lastSnapshotScope = snapshot.scope ?? null;
    lastSnapshotAccountOwnerId = snapshot.accountOwnerId?.trim() || null;
    lastMachineItemIds = snapshot.scope === "machine"
      ? new Set(snapshot.items.map((item) => item.id))
      : new Set();
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
        message: `Update ADE on ${hostName}, then reconnect to load this machine's Attention.`,
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
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const lease = accountClient.captureSessionLease();
    if (!lease) throw new Error("Sign in to use account-wide Attention.");
    const requestOnce = async (forceRefresh: boolean): Promise<RelayResult> => {
      const accessToken = await accountClient.getAccessToken({ forceRefresh });
      if (!accountClient.isSessionLeaseCurrent(lease)) {
        throw new Error("The ADE account changed before Attention could load.");
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
    let result = await requestOnce(false);
    if (result.response.status === 401) result = await requestOnce(true);
    if (!result.response.ok) throw relayError(action, result);
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
            message: `Attention from ${hostName} is available. Sign in to combine work across every ADE machine.`,
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
          title: "Account Attention is live",
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
          "The ADE account changed after Attention loaded. Refresh Attention, then try again.",
        );
      }
      if (lastSnapshotScope === "machine") {
        if (
          lastSnapshotScope !== "machine"
          || args.itemIds.some((itemId) => !lastMachineItemIds.has(itemId))
        ) {
          throw new Error(
            "Refresh this machine's Attention before acknowledging the item.",
          );
        }
        if (
          !args.sourceRevisions
          || args.itemIds.some((itemId) =>
            !Number.isFinite(args.sourceRevisions?.[itemId]))
        ) {
          throw new Error(
            "Refresh this machine's Attention before acknowledging a changed item.",
          );
        }
        if (!infra.commands.hasAction("attention.acknowledgeMachine")) {
          const hostName = infra.client.getStatus().hostName?.trim() || "the connected ADE host";
          throw new Error(
            `Update ADE on ${hostName}, reconnect, then try this Attention action again.`,
          );
        }
        await infra.commands.call(
          "attention.acknowledgeMachine",
          args as unknown as Record<string, unknown>,
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
        return;
      }
      if (lastSnapshotScope !== "account" || !currentAccountOwnerId) {
        throw new Error("Refresh account Attention before acknowledging this item.");
      }
      await request("acknowledgment", "POST", "/attention/account/ack", args);
    },

    async reportPresence(presence: AttentionPresence) {
      if (!browserAccountIsSignedIn(accountClient.getSnapshot().state)) return;
      await request("presence", "POST", "/attention/account/presence", presence);
    },

    async getPreferences(accountOwnerId: string) {
      const owner = accountClient.getSnapshot().userId?.trim() ?? "";
      if (!owner || owner !== accountOwnerId.trim()) {
        throw new Error("The ADE account changed before Attention preferences could load.");
      }
      const result = record(await request(
        "preferences",
        "GET",
        "/attention/account/preferences",
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
        throw new Error("The ADE account changed before Attention preferences could be saved.");
      }
      const { devices: _deviceOverrides, ...accountPreferences } = preferences;
      await request(
        "preference update",
        "PUT",
        "/attention/account/preferences",
        accountPreferences,
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
        if (!lease) throw new Error("Sign in again to open this Attention item.");
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
        const switched = await infra.client.switchProject(item.project.projectId);
        if (!switched.ok) {
          throw new Error(
            `${item.machine.name} owns this item. Connect to that machine, then open ${item.project.name}.`,
          );
        }
      }
      const parsed = parseDeeplink(attentionDestinationDeepLink(item.destination, item));
      if (!parsed.ok) throw new Error("This Attention destination is invalid.");
      infra.events.emit("navigate", {
        target: deeplinkToNavigationTarget(parsed.target),
        source: "attention",
      });
    },
  };
}
