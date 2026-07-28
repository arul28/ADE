export const ATTENTION_CONTRACT_VERSION = 1 as const;

export type AttentionItemKind = "agent" | "pull_request";

export type AttentionPhase =
  | "starting"
  | "running"
  | "needs_you"
  | "blocked"
  | "failed"
  | "completed"
  | "stale"
  | "checks_failing"
  | "review_requested"
  | "changes_requested"
  | "merge_ready"
  | "open"
  | "merged"
  | "closed";

export type AttentionEventKind =
  | "agent_running"
  | "agent_needs_you"
  | "agent_failed"
  | "agent_completed"
  | "pr_checks_failing"
  | "pr_review_requested"
  | "pr_changes_requested"
  | "pr_merge_ready"
  | "pr_merged"
  | "pr_opened"
  | "pr_closed";

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
  projects: Record<string, Partial<AttentionPreferenceScope>>;
  mutedSessionIds: string[];
};

export type AttentionNotchSettings = {
  enabled: boolean;
  preferredDisplayId?: number | null;
  hideDetails: boolean;
  celebrationsEnabled: boolean;
  soundsEnabled: boolean;
};

export type AttentionNotchAcknowledgeRequest = {
  itemId: string;
  mode: "seen" | "dismiss";
};

export const BALANCED_ATTENTION_EVENT_POLICIES: Record<
  AttentionEventKind,
  AttentionDeliveryPolicy
> = {
  agent_running: "ambient",
  agent_needs_you: "notify",
  agent_failed: "notify",
  agent_completed: "ambient",
  pr_checks_failing: "notify",
  pr_review_requested: "notify",
  pr_changes_requested: "notify",
  pr_merge_ready: "notify",
  pr_merged: "ambient",
  pr_opened: "ambient",
  pr_closed: "ambient",
};

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
    quietHours: {
      enabled: false,
      startMinute: 22 * 60,
      endMinute: 8 * 60,
      timeZone: "UTC",
    },
  },
  devices: {},
  projects: {},
  mutedSessionIds: [],
};

const ATTENTION_PHASE_PRIORITY: Record<AttentionPhase, number> = {
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

export function attentionDestinationDeepLink(destination: AttentionDestination): string {
  if (destination.kind === "session") {
    const query = new URLSearchParams();
    if (destination.itemId) query.set("item", destination.itemId);
    if (destination.eventId) query.set("event", destination.eventId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return `ade://session/${encodeURIComponent(destination.sessionId)}${suffix}`;
  }

  const query = new URLSearchParams();
  if (destination.tab !== "overview") query.set("tab", destination.tab);
  if (destination.eventId) query.set("event", destination.eventId);
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
