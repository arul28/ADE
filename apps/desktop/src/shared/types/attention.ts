import { ACTIVITY_EVENT_CATALOG } from "../activityCatalog";
import { normalizeCustomNotificationLink } from "../customNotificationLink";
import type { WorkBoardColumn, WorkBoardWaitingReason } from "./chat";

export const ATTENTION_CONTRACT_VERSION = 1 as const;

/**
 * `message` is a note an agent sent because the user asked to be told
 * (`ade notify` from a chat). It files in the Inbox, never in an agent column,
 * and the relay sends it only to clients that ask for it
 * (`ATTENTION_SNAPSHOT_INCLUDE_MESSAGES`), because older clients reject a
 * snapshot that carries a kind they do not know.
 */
export type AttentionItemKind = "agent" | "pull_request" | "message";

/**
 * The query value a client sends when it can read `message` items. Every
 * account-snapshot reader built after messages existed passes it.
 */
export const ATTENTION_SNAPSHOT_INCLUDE_MESSAGES = "message";

export const ATTENTION_PHASES = [
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
] as const;

export type AttentionPhase = (typeof ATTENTION_PHASES)[number];

export const ATTENTION_EVENT_KINDS = [
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
] as const;

export type AttentionEventKind = (typeof ATTENTION_EVENT_KINDS)[number];

/**
 * The event of a `message` item. Deliberately not in `ATTENTION_EVENT_KINDS`:
 * that list is the event-policy vocabulary every saved preference document must
 * cover, and a message has no policy — the user asked for it.
 */
export const ATTENTION_MESSAGE_EVENT_KIND = "agent_message" as const;
export type AttentionItemEventKind = AttentionEventKind | typeof ATTENTION_MESSAGE_EVENT_KIND;

export type AttentionDeliveryPolicy = "off" | "ambient" | "notify";

export type AttentionMachineRef = {
  /** Source identity used to authenticate this machine's Attention publisher. */
  machineKey: string;
  /** Canonical account-directory/sync-relay identity used for remote routing. */
  accountMachineKey?: string | null;
  /** Stable ADE device identity when the publisher can resolve it. */
  deviceId?: string | null;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type AttentionProjectRef = {
  /**
   * The publishing machine's own database id for the project. It is a
   * `randomUUID()` minted per machine, so it is meaningful only on the machine
   * that produced the item — never use it to look a project up on a different
   * runtime.
   */
  projectId: string;
  /**
   * Machine-independent project identity, `deriveProjectId(rootPath)` — the same
   * `project_<hash>` form a runtime's own project registry uses. This is the id
   * that actually resolves across machines, and the one deep links carry.
   *
   * Optional because an older publisher omits it; readers fall back to matching
   * on `rootPath`, and only then on `projectId`.
   */
  canonicalId?: string | null;
  name: string;
  rootPath?: string | null;
};

export type AttentionSessionDestination = {
  kind: "session";
  sessionId: string;
  itemId?: string | null;
  eventId?: string | null;
};

export type AttentionPullRequestDestination = {
  kind: "pull_request";
  prId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  number: number;
  tab: "overview" | "activity" | "checks" | "files";
  eventId?: string | null;
};

export type AttentionDestination =
  | AttentionSessionDestination
  | AttentionPullRequestDestination;

export type AttentionActionKind =
  | "approve"
  | "deny"
  | "answer"
  | "restart"
  | "rerun_checks"
  | "mark_seen"
  | "dismiss"
  | "open";

export type AttentionAction = {
  id: string;
  kind: AttentionActionKind;
  label: string;
  destructive?: boolean;
  payload?: Record<string, string | number | boolean | null>;
};

export type AttentionItem = {
  contractVersion: typeof ATTENTION_CONTRACT_VERSION;
  id: string;
  revision: number;
  fingerprint: string;
  /** Alert eligibility and Activity filing. Absent on legacy items. */
  activityTier?: "signal" | "ambient" | "idle";
  /** Stable identity for row-content changes. */
  contentFingerprint?: string;
  /** Stable identity for alert deduplication. */
  alertFingerprint?: string;
  kind: AttentionItemKind;
  eventKind: AttentionItemEventKind;
  phase: AttentionPhase;
  machine: AttentionMachineRef;
  project: AttentionProjectRef;
  laneId?: string | null;
  laneName?: string | null;
  provider?: string | null;
  model?: string | null;
  /**
   * The chat-activity flavour of a running turn, mirroring
   * `SessionStatusActivityContext.chatActivityMode` in
   * `shared/sessionStatusPresentation.ts`. Optional and additive: a publisher
   * that never sets it leaves the item reading exactly as it does today, and a
   * reader that does not understand a future value must fall back to the phase.
   *
   * It exists because "planning" is a state the Activity glyph language names
   * (violet notepad) but `AttentionPhase` cannot carry — the phase vocabulary is
   * frozen push wire, and widening it would break every older client. Readers
   * validate it at the boundary (`activityChatMode`) rather than trusting it.
   */
  chatActivityMode?: "planning" | null;
  /**
   * The Work-board column this agent item files under, computed by the
   * publishing brain with the board's own rules (a failure is Needs you, a
   * snoozed row or a lane PR mid-CI or awaiting review is Waiting). Every
   * Activity surface groups by it, so the board, the desktop panel, the phone
   * and the Live Activity count the same four states.
   *
   * Optional and additive: older publishers omit it, and readers then derive a
   * column from the phase through `activityBoardColumn`. Pull-request items
   * never carry it; they are notifications, not agents.
   */
  boardColumn?: WorkBoardColumn | null;
  /** Why the item is in Waiting. Present only when `boardColumn` is `waiting`. */
  waitingReason?: WorkBoardWaitingReason | null;
  title: string;
  preview: string;
  privacyPreview: string;
  detail?: string | null;
  recentActivity?: string[];
  planProgress?: {
    completed: number;
    total: number;
    current?: string | null;
  } | null;
  destination: AttentionDestination;
  actions: AttentionAction[];
  occurredAt: string;
  updatedAt: string;
  /** Immutable timestamp for the current phase, when the publisher has one. */
  statusSince?: string | null;
  seenAt: string | null;
  dismissedAt: string | null;
  expiresAt: string | null;
};

/**
 * Attention's tone vocabulary is `sessionStatusPresentation`'s five hues plus
 * two that only pull requests ever use. The session five keep their meanings
 * exactly — see the one-hue-one-meaning rule in
 * `apps/desktop/src/shared/sessionStatusPresentation.ts`:
 *
 *   blue     work is happening, nothing is asked of you
 *   amber    YOUR MOVE — and nothing else, ever
 *   emerald  finished cleanly, you have not looked yet
 *   red      it broke
 *   neutral  true, but not actionable
 *
 * `violet` carries "a human review is outstanding" — neither "your move" (it is
 * usually someone else's) nor an outcome, and without its own hue it would have
 * to borrow amber, which is precisely the erosion the rule forbids. `cyan` is
 * currently unused by any phase; it stays in the union and the stylesheets as
 * the spare for the next PR-side distinction, and must never be handed to a
 * session state — those five hues are settled.
 */
export type AttentionTone =
  | "amber"
  | "red"
  | "violet"
  | "blue"
  | "cyan"
  | "emerald"
  | "neutral";

export const ATTENTION_TONES: readonly AttentionTone[] = [
  "amber",
  "red",
  "violet",
  "blue",
  "cyan",
  "emerald",
  "neutral",
];

export type AttentionTombstone = {
  id: string;
  revision: number;
  deletedAt: string;
};

export type AttentionSnapshot = {
  contractVersion: typeof ATTENTION_CONTRACT_VERSION;
  /** Where this snapshot was sourced. Account is canonical; machine is fallback. */
  scope?: "account" | "machine";
  /**
   * Account identity that owned a machine snapshot when it was generated.
   * Null is an explicit signed-out machine scope. Machine acknowledgments must
   * echo this value so an account switch cannot consume stale UI intent.
   */
  accountOwnerId?: string | null;
  /**
   * Operational state for ambient surfaces. Fixed codes are safe to persist;
   * concise copy tells the user what remains available and how to recover.
   */
  availability?: {
    state: "ready" | "degraded" | "signed_out" | "unavailable" | "incompatible";
    title: string;
    message: string;
    recovery: "retry" | "sign_in" | "update_host" | "restart_host" | null;
    hostName?: string | null;
  };
  /**
   * Opaque authenticated account stream identity. Revisions are monotonic only
   * inside one stream, so clients must reset atomically when this changes.
   */
  streamId?: string | null;
  revision: number;
  generatedAt: string;
  /** Current account-machine presence, returned even when no items changed. */
  machines?: AttentionMachineRef[];
  items: AttentionItem[];
  itemsTruncated?: boolean;
  tombstones?: AttentionTombstone[];
};

/**
 * One thing worth a desktop notification: an agent that needs the user, one
 * that failed, or a message an agent sent because the user asked to be told.
 *
 * Two sources feed it. This computer's brain announces its own chats the
 * moment they change (`attention_alert` runtime events), which works while every
 * ADE window is hidden. Chats on other machines arrive through the account
 * Activity snapshots the windows already poll, so they cost no extra request.
 */
export type AttentionDesktopAlert = {
  /** The Activity item this alert is about; both sources name it the same way. */
  itemId: string;
  /** `goal`: a chat reached, or got blocked on, the goal the user gave it. */
  kind: "needs_you" | "failed" | "goal" | "message";
  sessionId: string;
  title: string;
  body: string | null;
  /** When the state began; stale alerts are dropped. */
  at: string;
  /** The account-directory key of the machine that owns the chat, when known. */
  accountMachineKey: string | null;
  /**
   * The owning machine's push identity and its id for the project: the keys
   * the account's per-machine and per-project notification settings use.
   * Null from an older brain.
   */
  machineKey?: string | null;
  projectId?: string | null;
  /** The Activity alert identity, so marking it seen cannot clear a newer one. */
  alertFingerprint?: string | null;
  /** Set for alerts read from an account snapshot: opening goes through Activity. */
  item?: AttentionItem;
};

export type AttentionPresence = {
  deviceId: string;
  deviceName: string;
  platform: "macOS" | "iOS" | "web" | "unknown";
  appForeground: boolean;
  ambientSurfaceVisible: boolean;
  visibleItemIds: string[];
  observedAt: string;
  /**
   * Someone is using this computer: OS input in the last two minutes, screen
   * unlocked, machine awake. Stamped by the desktop app's main process from
   * the OS idle clock; absent where that clock is unknown (web, older apps).
   * While any computer reports `true`, the relay keeps phone alerts quiet.
   */
  userActive?: boolean;
};

/** What a presence report learned on the way out. */
export type AttentionPresenceReceipt = {
  /** The OS idle clock's answer for this computer; `null` when unknown. */
  userActive: boolean | null;
};

export type AttentionPreferenceScope = {
  eventPolicies: Record<AttentionEventKind, AttentionDeliveryPolicy>;
  /**
   * Which default event policies `eventPolicies` was saved against. Absent
   * means version 1, when review requests, requested changes and merge-ready
   * PRs notified by default. See `upgradeAttentionEventPolicies`.
   */
  eventPolicyDefaultsVersion?: number;
  notificationsEnabled: boolean;
  liveActivitiesEnabled: boolean;
  desktopFirstEnabled: boolean;
  desktopFirstDelaySeconds: number;
  soundsEnabled: boolean;
  celebrationsEnabled: boolean;
  hideDetails: boolean;
  dockBadgeScope: "local" | "account";
  quietHours: {
    enabled: boolean;
    startMinute: number;
    endMinute: number;
    timeZone: string;
  };
};

export type AttentionPreferences = {
  account: AttentionPreferenceScope;
  devices: Record<string, Partial<AttentionPreferenceScope>>;
  machines: Record<string, Partial<AttentionPreferenceScope>>;
  projects: Record<string, Partial<AttentionPreferenceScope>>;
  mutedSessionIds: string[];
};

/**
 * The most item ids ONE acknowledgment request may carry.
 *
 * DERIVED, not chosen here. It mirrors the push relay's hard bound —
 * `handleAcknowledgment` in `apps/push-relay/src/attention.ts` (the
 * `payload.itemIds.length > 64` guard, ~line 2532) rejects the WHOLE request
 * with 400, because every id becomes one statement in a single D1 batch. Raising
 * that bound is not the fix; keep this in step with it instead. The
 * machine-scoped hosts (`attention.acknowledge` in
 * `apps/ade-cli/src/multiProjectRpcServer.ts`, `attention.acknowledgeMachine` in
 * `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`) apply the same
 * 64 cap by truncating, which is worse: the ids past the cap are neither applied
 * nor reported.
 *
 * So a caller with a bigger batch — "Clear all" on an inbox over 64 rows —
 * SPLITS it into sequential requests of at most this many ids. It must never
 * truncate: a dropped id is never sent, so it is neither confirmed nor reported
 * stale, and the optimistic dismiss for it silently un-clears on the next poll.
 * That is exactly the "Clear all does not clear all" symptom.
 *
 * Raising this is not the fix, and raising it ALONE is a regression. The value
 * derives from the relay's own bound — `handleAcknowledgment` in
 * `apps/push-relay/src/attention.ts` answers 400 for `itemIds.length > 64`
 * before it parses anything else, and a relay test pins both sides of that
 * boundary. Three hosts truncate at the same 64 internally
 * (`apps/ade-cli/src/multiProjectRpcServer.ts`,
 * `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`,
 * `apps/desktop/src/main/services/adeActions/registry.ts`); client-side
 * chunking is the only reason those truncations are now unreachable. Nobody may
 * raise this number without first raising the relay's bound and replacing all
 * three truncations with chunking. The bound keeps one relay-side D1 batch
 * sane; chunking belongs on the client.
 */
export const ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT = 64;

/**
 * Per-item verdict for one bulk acknowledgment.
 *
 * Acks are monotonic and idempotent, so a partially applied batch is a normal
 * outcome rather than a failure: reporting it per item lets the caller roll back
 * only what did not land.
 *
 * The three lists are disjoint and, together, cover every id the caller sent.
 * `stale` and `unreached` both mean "roll this row back" — they differ only in
 * WHY, and that difference is the whole reason the second list exists. A row the
 * host refused really did change underneath the user, and "refresh Activity" is
 * the right instruction. A row in a chunk that threw was never answered for at
 * all: expired auth, a 5xx, a rejected CORS preflight, an owner-fence 409. Filing
 * those under `stale` told the user something changed when nothing had, and sent
 * them to refresh a list that was already correct.
 *
 * Both new fields are optional and are omitted entirely when no chunk failed, so
 * a batch that succeeds is byte-identical to what this contract carried before
 * they existed, and a producer that never populates them still reads correctly.
 */
export type AttentionAcknowledgmentOutcome = {
  /** Ids the host applied. Their optimistic state stands. */
  acknowledged: string[];
  /** Ids the host answered for and REFUSED, because they changed underneath. */
  stale: string[];
  /**
   * Ids no answer ever came back for: the chunk carrying them failed in
   * transport, or an earlier chunk aborted the loop before theirs was sent.
   */
  unreached?: string[];
  /** The transport failure that stopped the batch, for the caller's copy. */
  unreachedReason?: string;
};

/**
 * Split item ids into relay-sized acknowledgment batches, order preserved.
 *
 * Shared by the Electron main coordinator and the browser adapter so both sides
 * chunk identically. An empty input yields no batches (the callers reject that
 * earlier, with their own message).
 */
export function chunkAttentionAcknowledgmentItemIds(
  itemIds: readonly string[],
  limit: number = ATTENTION_ACKNOWLEDGMENT_BATCH_LIMIT,
): string[][] {
  const size = Math.max(1, Math.trunc(limit));
  const batches: string[][] = [];
  for (let index = 0; index < itemIds.length; index += size) {
    batches.push(itemIds.slice(index, index + size));
  }
  return batches;
}

/**
 * The optional half of an acknowledgment outcome, present only when a chunk
 * actually failed.
 *
 * Shared by the Electron main coordinator and the browser adapter so both
 * shells report a transport abort identically: omitted entirely when everything
 * was answered for — so a batch that succeeds serializes exactly as it did
 * before these fields existed — and otherwise carrying the raw failure text,
 * which the caller renders as the detail beside its own copy.
 */
export function unreachedOutcomeFields(
  unreached: string[],
  failure: unknown,
): Pick<AttentionAcknowledgmentOutcome, "unreached" | "unreachedReason"> {
  if (unreached.length === 0) return {};
  const message = failure instanceof Error ? failure.message : String(failure ?? "");
  const reason = message.trim();
  return { unreached, ...(reason ? { unreachedReason: reason } : {}) };
}

/**
 * Drive one bulk acknowledgment over relay-sized chunks and aggregate the
 * per-item verdict, so the `AttentionAcknowledgmentOutcome` invariant — the
 * three lists are disjoint and together cover every id the caller sent — is
 * enforced in ONE place instead of restated as prose in each of the four
 * chunk loops that used to compute it.
 *
 * `send` issues one chunk and returns the ids the host ANSWERED FOR and
 * refused; a scope whose host answers per chunk rather than per item (the
 * machine RPC applies the whole payload or throws) returns nothing. It must
 * rebuild every per-item map for its own chunk rather than slicing a whole
 * -batch map alongside: the machine RPC throws on a missing revision and the
 * relay 400s on a fence naming an id outside the batch.
 *
 * Failure policy: ABORT on the first throwing chunk. A chunk that throws is
 * systemic (expired auth, network down, relay 5xx) — item-specific refusals
 * come back in the returned stale ids without throwing — so pushing the rest at
 * a host that just failed only multiplies the damage. The remainder is reported
 * as `unreached` rather than rethrown, because letting the error propagate
 * would roll back the chunks that DID land and the user would watch rows they
 * cleared come back. Whether an all-failed batch rethrows stays with the
 * caller, whose scopes differ on it.
 */
export async function runAcknowledgmentChunks(
  itemIds: readonly string[],
  send: (chunk: string[]) => Promise<readonly string[]>,
): Promise<{
  acknowledged: string[];
  stale: string[];
  unreached: string[];
  failure: unknown;
}> {
  const staleIds = new Set<string>();
  const confirmed = new Set<string>();
  let failure: unknown = null;
  for (const chunk of chunkAttentionAcknowledgmentItemIds(itemIds)) {
    try {
      for (const itemId of await send(chunk)) {
        if (chunk.includes(itemId)) staleIds.add(itemId);
      }
      for (const itemId of chunk) confirmed.add(itemId);
    } catch (error) {
      failure = error;
      break;
    }
  }
  // `stale` is what the host ANSWERED and refused — those rows really did
  // change underneath the user. `unreached` is what no answer ever came for:
  // the chunk that threw plus every chunk after it. Both roll back; filing the
  // second under the first told the user their work had changed when the
  // request simply never completed.
  return {
    acknowledged: itemIds.filter((itemId) => confirmed.has(itemId) && !staleIds.has(itemId)),
    stale: itemIds.filter((itemId) => staleIds.has(itemId)),
    unreached: itemIds.filter((itemId) => !staleIds.has(itemId) && !confirmed.has(itemId)),
    failure,
  };
}

export const BALANCED_ATTENTION_EVENT_POLICIES: Record<
  AttentionEventKind,
  AttentionDeliveryPolicy
> = Object.fromEntries(
  ACTIVITY_EVENT_CATALOG.map(({ kind, defaultPolicy }) => [kind, defaultPolicy]),
) as Record<AttentionEventKind, AttentionDeliveryPolicy>;

/**
 * Version 2: only the urgent events (a question, a failure, red CI) notify by
 * default. Version 3: the phone waits 2 minutes (was 30 s) while the user is
 * at a computer. Bump it when a default changes, and add the change to
 * `upgradeAttentionEventPolicies`. The push relay applies the same rules.
 */
export const ATTENTION_EVENT_POLICY_DEFAULTS_VERSION = 3;

/** How long the phone waits while the user is at a computer, by default. */
export const DEFAULT_DESKTOP_FIRST_DELAY_SECONDS = 120;
/** The version-2 default; a saved 30 from before version 3 was this default. */
const DESKTOP_FIRST_DELAY_SECONDS_BEFORE_V3 = 30;

/** Events that notified under version 1 defaults and are ambient from version 2. */
const EVENTS_DEMOTED_IN_POLICY_DEFAULTS_V2: readonly AttentionEventKind[] = [
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready",
];

/**
 * Bring saved event policies onto the current defaults.
 *
 * Every save writes the whole `eventPolicies` map, so a "notify" saved under an
 * older version cannot tell a user's choice apart from the default it was
 * saved with. Version 2 treats it as the default and moves it to "ambient".
 * Version 3 does the same for the desktop-first delay: a saved 30 s becomes
 * the new 2 minutes. After that the scope carries the current version, so any
 * later choice stays.
 */
export function upgradeAttentionEventPolicies<T extends Partial<AttentionPreferenceScope>>(
  scope: T,
): T {
  const version = typeof scope.eventPolicyDefaultsVersion === "number"
    ? scope.eventPolicyDefaultsVersion
    : 1;
  if (version >= ATTENTION_EVENT_POLICY_DEFAULTS_VERSION) return scope;
  const eventPolicies = scope.eventPolicies ? { ...scope.eventPolicies } : undefined;
  const delayWasOldDefault = scope.desktopFirstDelaySeconds === DESKTOP_FIRST_DELAY_SECONDS_BEFORE_V3;
  if (eventPolicies && version < 2) {
    for (const kind of EVENTS_DEMOTED_IN_POLICY_DEFAULTS_V2) {
      if (eventPolicies[kind] === "notify") eventPolicies[kind] = "ambient";
    }
  }
  return {
    ...scope,
    ...(eventPolicies ? { eventPolicies } : {}),
    ...(delayWasOldDefault ? { desktopFirstDelaySeconds: DEFAULT_DESKTOP_FIRST_DELAY_SECONDS } : {}),
    eventPolicyDefaultsVersion: ATTENTION_EVENT_POLICY_DEFAULTS_VERSION,
  };
}

export const DEFAULT_ATTENTION_PREFERENCES: AttentionPreferences = {
  account: {
    eventPolicies: BALANCED_ATTENTION_EVENT_POLICIES,
    eventPolicyDefaultsVersion: ATTENTION_EVENT_POLICY_DEFAULTS_VERSION,
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    desktopFirstEnabled: true,
    desktopFirstDelaySeconds: DEFAULT_DESKTOP_FIRST_DELAY_SECONDS,
    soundsEnabled: false,
    celebrationsEnabled: true,
    hideDetails: false,
    dockBadgeScope: "local",
    quietHours: {
      enabled: false,
      startMinute: 22 * 60,
      endMinute: 8 * 60,
      timeZone: "UTC",
    },
  },
  devices: {},
  machines: {},
  projects: {},
  mutedSessionIds: [],
};

export const ATTENTION_PHASE_PRIORITY: Readonly<Record<AttentionPhase, number>> = {
  needs_you: 0,
  failed: 1,
  checks_failing: 1,
  changes_requested: 1,
  review_requested: 2,
  merge_ready: 2,
  blocked: 2,
  starting: 3,
  running: 3,
  open: 4,
  stale: 4,
  completed: 5,
  merged: 5,
  closed: 6,
};

export function attentionPhasePriority(phase: AttentionPhase): number {
  return ATTENTION_PHASE_PRIORITY[phase];
}

export function sortAttentionItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((left, right) => {
    const priority = attentionPhasePriority(left.phase) - attentionPhasePriority(right.phase);
    if (priority !== 0) return priority;
    const timestamp = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(timestamp) && timestamp !== 0) return timestamp;
    return left.id.localeCompare(right.id);
  });
}

export function attentionItemNeedsInbox(item: AttentionItem): boolean {
  if (activityItemTier(item) === "idle") return false;
  if (item.dismissedAt) return false;
  if (
    item.phase === "needs_you"
    || item.phase === "failed"
    || item.phase === "checks_failing"
    || item.phase === "changes_requested"
    || item.phase === "review_requested"
    || item.phase === "merge_ready"
  ) {
    return true;
  }
  return (item.phase === "completed" || item.phase === "merged") && item.seenAt === null;
}

/**
 * Legacy snapshots predate the tier field. Derive the old signal/ambient split
 * from the phase so a mixed-version fleet still files rows consistently.
 */
export function activityItemTier(item: AttentionItem): "signal" | "ambient" | "idle" {
  if (item.activityTier) return item.activityTier;
  switch (item.phase) {
    case "needs_you":
    case "blocked":
    case "failed":
    case "checks_failing":
    case "review_requested":
    case "changes_requested":
    case "merge_ready":
      return "signal";
    default:
      return "ambient";
  }
}

/** Idle rows are also ambient: neither tier is eligible to interrupt. */
export function activityItemIsAmbient(item: AttentionItem): boolean {
  return activityItemTier(item) !== "signal";
}

export function attentionItemIsLive(item: AttentionItem): boolean {
  return (
    item.phase === "starting"
    || item.phase === "running"
    || item.phase === "needs_you"
    || item.phase === "blocked"
    || item.phase === "failed"
    || item.phase === "stale"
    || item.phase === "checks_failing"
    || item.phase === "review_requested"
    || item.phase === "changes_requested"
    || item.phase === "merge_ready"
  );
}

export function attentionDestinationDeepLink(
  destination: AttentionDestination,
  ownership?: Pick<AttentionItem, "machine" | "project">,
): string {
  const appendOwnership = (query: URLSearchParams): void => {
    const accountMachineKey = ownership?.machine.accountMachineKey?.trim();
    if (accountMachineKey) query.set("accountMachineKey", accountMachineKey);
    // Prefer the machine-independent id: a deep link is opened by whichever
    // machine the user happens to be on, and the publisher's own database uuid
    // resolves nowhere but the publisher.
    //
    // The project's absolute `rootPath` is deliberately NOT stamped. ADE links
    // are meant to be pasted into PR descriptions, Linear issues and Slack, and
    // a `projectRoot=/Users/<name>/Projects/<client>` parameter leaks the local
    // username and directory layout to every reader. Nothing is lost: the
    // canonical id above IS `deriveProjectId(rootPath)`, and the receiver's
    // `resolveLocalProjectRoot` recomputes that hash from each root it knows
    // (step 3), which matches exactly when a path comparison would have.
    // Older links still carry the parameter, and the parser still reads it.
    const project = ownership?.project;
    const projectId = project?.canonicalId?.trim() || project?.projectId?.trim();
    if (projectId) query.set("projectId", projectId);
  };
  if (destination.kind === "session") {
    const query = new URLSearchParams();
    if (destination.itemId) query.set("item", destination.itemId);
    if (destination.eventId) query.set("event", destination.eventId);
    appendOwnership(query);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return `ade://session/${encodeURIComponent(destination.sessionId)}${suffix}`;
  }

  const query = new URLSearchParams();
  if (destination.tab !== "overview") query.set("tab", destination.tab);
  if (destination.eventId) query.set("event", destination.eventId);
  appendOwnership(query);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  if (destination.repoOwner && destination.repoName) {
    return `ade://pr/${encodeURIComponent(destination.repoOwner)}/${encodeURIComponent(
      destination.repoName,
    )}/${destination.number}${suffix}`;
  }
  return `ade://pr/${destination.number}${suffix}`;
}

export function sanitizeAttentionPreview(value: string, maxLength = 160): string {
  const normalized = value
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/**
 * A custom notification — `ade notify`, an agent, or an automation's "Send
 * notification" step. The relay sends the text exactly as written, to every
 * phone on the account, and enforces the same limits
 * (apps/push-relay/src/attention.ts keeps its own copy: it imports nothing).
 */
export const CUSTOM_NOTIFICATION_TITLE_MAX = 64;
export const CUSTOM_NOTIFICATION_BODY_MAX = 160;
export const CUSTOM_NOTIFICATION_HOURLY_LIMIT = 60;

export type CustomNotificationInput = {
  title: string;
  body?: string | null;
  /** Where a tap goes. ADE links only (`ade://…`). */
  open?: string | null;
};

/**
 * The reason a custom notification cannot be sent as written, in words a CLI
 * user or an automation author can act on, or null when it is valid.
 */
export function customNotificationProblem(input: {
  title?: unknown;
  body?: unknown;
  open?: unknown;
}): string | null {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return "A notification needs a title.";
  if (title.length > CUSTOM_NOTIFICATION_TITLE_MAX) {
    return `The title is ${title.length} characters; the limit is ${CUSTOM_NOTIFICATION_TITLE_MAX}.`;
  }
  if (input.body != null) {
    if (typeof input.body !== "string") return "The body must be text.";
    const body = input.body.trim();
    if (body.length > CUSTOM_NOTIFICATION_BODY_MAX) {
      return `The body is ${body.length} characters; the limit is ${CUSTOM_NOTIFICATION_BODY_MAX}.`;
    }
  }
  if (input.open != null && input.open !== "") {
    if (typeof input.open !== "string") return "The open link must be text.";
    const link = normalizeCustomNotificationLink(input.open);
    if (!link.ok) return link.problem;
  }
  return null;
}

/** What `attention.sendNotification` answers. */
export type CustomNotificationResult = {
  sent?: boolean;
  devices: number;
  delivered: number;
  skipped: number;
  failed: number;
  remaining: number | null;
  /** Why the link was left off, when it could not be opened. */
  linkSkipped?: string;
};

/**
 * One sentence about what a custom notification did, for `ade notify --text`
 * and the automation editor's test send, so the two say it the same way.
 */
export function describeCustomNotificationResult(
  result: Partial<CustomNotificationResult> & {
    delivery?: unknown;
    repeat?: unknown;
    accountSignedIn?: unknown;
    chatTitle?: unknown;
  },
): { tone: "ok" | "warn"; message: string } {
  // Sent from a chat: it is that chat's message, delivered through Activity,
  // so there are no per-phone counts to report at send time.
  if (result.delivery === "chat") {
    const link = result.linkSkipped ? ` The link was left off: ${result.linkSkipped}` : "";
    if (result.repeat === true) {
      return { tone: "warn", message: `Not sent again: this chat sent the same notification a few minutes ago.${link}` };
    }
    if (result.accountSignedIn === false) {
      return {
        tone: "warn",
        message: `Shown in the chat and on this computer. Phones get it once this computer is signed in (\`ade login\`).${link}`,
      };
    }
    return { tone: "ok", message: `Sent. It shows in the chat, in Activity, and on your phone unless you're at your computer or muted this chat.${link}` };
  }
  const devices = Number(result.devices) || 0;
  const delivered = Number(result.delivered) || 0;
  const skipped = Number(result.skipped) || 0;
  if (devices === 0) {
    return {
      tone: "warn",
      message: "No phone is signed in to this ADE account, so nothing was sent. Sign in on the ADE iPhone app to get notifications.",
    };
  }
  if (delivered === 0) {
    return {
      tone: "warn",
      message: skipped > 0
        ? "Nothing was sent: every phone on the account has notifications off, is in quiet hours, or muted this machine."
        : "ADE couldn't deliver the notification to any phone. Try again in a moment.",
    };
  }
  const quiet = skipped > 0 ? ` · ${skipped} quiet` : "";
  const left = typeof result.remaining === "number" ? ` · ${result.remaining} left this hour` : "";
  const link = result.linkSkipped ? `. The link was left off: ${result.linkSkipped}` : "";
  return { tone: "ok", message: `Sent to ${delivered} phone${delivered === 1 ? "" : "s"}${quiet}${left}${link}` };
}
