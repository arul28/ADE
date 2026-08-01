import { ACTIVITY_EVENT_CATALOG } from "../activityCatalog";

export const ATTENTION_CONTRACT_VERSION = 1 as const;

export type AttentionItemKind = "agent" | "pull_request";

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
  projectId: string;
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
  eventKind: AttentionEventKind;
  phase: AttentionPhase;
  machine: AttentionMachineRef;
  project: AttentionProjectRef;
  laneId?: string | null;
  laneName?: string | null;
  provider?: string | null;
  model?: string | null;
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

export type AttentionPresence = {
  deviceId: string;
  deviceName: string;
  platform: "macOS" | "iOS" | "web" | "unknown";
  appForeground: boolean;
  ambientSurfaceVisible: boolean;
  visibleItemIds: string[];
  observedAt: string;
};

export type AttentionPreferenceScope = {
  eventPolicies: Record<AttentionEventKind, AttentionDeliveryPolicy>;
  notificationsEnabled: boolean;
  liveActivitiesEnabled: boolean;
  desktopFirstEnabled: boolean;
  desktopFirstDelaySeconds: number;
  soundsEnabled: boolean;
  celebrationsEnabled: boolean;
  hideDetails: boolean;
  dockBadgeScope: "local" | "account";
  /**
   * Notch presentation, synced so a second Mac inherits the choice instead of
   * starting from the shipped default. Optional because every relay and
   * publisher older than this build omits them, and because localStorage
   * remains the offline cache of record — readers take the synced value when
   * it is present and the local one otherwise. The localStorage key strings
   * are unchanged; only the source of truth moved.
   */
  notchRevealMode?: AttentionNotchRevealMode;
  notchExpandedPanel?: boolean;
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
 * How this Mac exposes its notch surface. Events never override the selected
 * interaction mode.
 * - `minimal`: keep a tiny status visible; hover or click opens a short peek.
 * - `hover`: stay visually dormant until the pointer enters the top-edge hot
 *   zone; hover opens a peek and click may open more.
 * - `click`: keep the compact status visible; only an explicit click opens more.
 *
 * A click always still works, in every mode, so no surface is ever inert.
 */
export type AttentionNotchRevealMode = "minimal" | "hover" | "click";

export const ATTENTION_NOTCH_REVEAL_MODES: readonly AttentionNotchRevealMode[] = [
  "minimal",
  "hover",
  "click",
];

/** Matches the shipped surface, so an upgrade changes nothing on its own. */
export const DEFAULT_ATTENTION_NOTCH_REVEAL_MODE: AttentionNotchRevealMode = "hover";

export function isAttentionNotchRevealMode(
  value: unknown,
): value is AttentionNotchRevealMode {
  return (
    typeof value === "string"
    && ATTENTION_NOTCH_REVEAL_MODES.includes(value as AttentionNotchRevealMode)
  );
}

export type AttentionNotchSettings = {
  enabled: boolean;
  revealMode: AttentionNotchRevealMode;
  /**
   * When false the tall expanded panel is never shown, so the surface can
   * never grow far enough to sit over menu-bar content.
   */
  expandedPanelEnabled: boolean;
  preferredDisplayId?: number | null;
  hideDetails: boolean;
  celebrationsEnabled: boolean;
  soundsEnabled: boolean;
};

export type AttentionNotchHealth = {
  state:
    | "disabled"
    | "starting"
    | "running"
    | "missing"
    | "crash_loop"
    | "protocol_error"
    | "unsupported";
  title: string;
  message: string;
  recovery: "retry" | "reinstall_or_update" | null;
  surface: "physical_notch" | "menu_bar" | null;
};

export type AttentionNotchAcknowledgeRequest = {
  itemId: string;
  mode: "seen" | "dismiss";
};

export const BALANCED_ATTENTION_EVENT_POLICIES: Record<
  AttentionEventKind,
  AttentionDeliveryPolicy
> = Object.fromEntries(
  ACTIVITY_EVENT_CATALOG.map(({ kind, defaultPolicy }) => [kind, defaultPolicy]),
) as Record<AttentionEventKind, AttentionDeliveryPolicy>;

export const DEFAULT_ATTENTION_PREFERENCES: AttentionPreferences = {
  account: {
    eventPolicies: BALANCED_ATTENTION_EVENT_POLICIES,
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    desktopFirstEnabled: true,
    desktopFirstDelaySeconds: 30,
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
    const projectId = ownership?.project.projectId?.trim();
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
