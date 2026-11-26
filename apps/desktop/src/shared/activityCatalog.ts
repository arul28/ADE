import type {
  AttentionDeliveryPolicy,
  AttentionPolicyEventKind,
} from "./types/attention";

export type ActivityEventGroup = "agents" | "pull_requests" | "messages" | "ade";

export type ActivityIconKey =
  | "working"
  | "needs-you"
  | "failed"
  | "done"
  | "checks"
  | "review"
  | "changes"
  | "merge-ready"
  | "pull-request"
  | "closed"
  | "message"
  | "goal"
  | "service";

export type ActivityEventDescriptor = {
  kind: AttentionPolicyEventKind;
  group: ActivityEventGroup;
  label: string;
  description: string;
  iconKey: ActivityIconKey;
  defaultPolicy: AttentionDeliveryPolicy;
  /** It has an Activity row, so "Activity" (listed, no interruption) means something. */
  supportsAmbient: boolean;
  /**
   * Where it can notify. `computers`: only a computer shows it (the relay never
   * pushes it to a phone), so a phone's settings leave it out.
   */
  reach: "everywhere" | "computers";
  /**
   * Project and machine settings can change it. False for a notice about this
   * computer itself, which belongs to no project.
   */
  scoped: boolean;
  order: number;
};

export const ACTIVITY_EVENT_GROUPS = [
  { id: "agents", label: "Agents" },
  { id: "pull_requests", label: "Pull requests" },
  { id: "messages", label: "Messages" },
  { id: "ade", label: "ADE" },
] as const satisfies readonly { id: ActivityEventGroup; label: string }[];

/**
 * One ordered source of truth for every event ADE can put in Activity.
 * Existing Notifications copy stays verbatim so adopting the catalog is a
 * structural refactor rather than a settings-page copy change.
 *
 * Only the urgent events notify by default: a question, a failure, and red CI.
 * Everything else shows in Activity and the Live Activity without a push.
 * `ATTENTION_EVENT_POLICY_DEFAULTS_VERSION` moves accounts that saved the older,
 * louder defaults onto these once.
 */
export const ACTIVITY_EVENT_CATALOG = [
  {
    kind: "agent_needs_you",
    group: "agents",
    label: "Agent asks a question",
    description: "A run is waiting on your answer.",
    iconKey: "needs-you",
    defaultPolicy: "notify",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 0,
  },
  {
    kind: "agent_failed",
    group: "agents",
    label: "Agent fails",
    description: "A run stopped on an error.",
    iconKey: "failed",
    defaultPolicy: "notify",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 1,
  },
  {
    kind: "agent_completed",
    group: "agents",
    label: "Agent finishes",
    description: "A run reached the end of its turn.",
    iconKey: "done",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 2,
  },
  {
    kind: "agent_running",
    group: "agents",
    label: "Agent starts working",
    description: "A run picked up your request.",
    iconKey: "working",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 3,
  },
  {
    kind: "pr_checks_failing",
    group: "pull_requests",
    label: "CI fails",
    description: "Checks went red on one of your PRs.",
    iconKey: "checks",
    defaultPolicy: "notify",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 4,
  },
  {
    kind: "pr_review_requested",
    group: "pull_requests",
    label: "Review requested",
    description: "Someone asked you to review.",
    iconKey: "review",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 5,
  },
  {
    kind: "pr_changes_requested",
    group: "pull_requests",
    label: "Changes requested",
    description: "A reviewer asked for changes.",
    iconKey: "changes",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 6,
  },
  {
    kind: "pr_merge_ready",
    group: "pull_requests",
    label: "PR ready to merge",
    description: "Checks passed and reviews are in.",
    iconKey: "merge-ready",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 7,
  },
  {
    kind: "pr_merged",
    group: "pull_requests",
    label: "PR merged",
    description: "One of your PRs landed.",
    iconKey: "done",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 8,
  },
  {
    kind: "pr_opened",
    group: "pull_requests",
    label: "PR opened",
    description: "One of your PRs was opened.",
    iconKey: "pull-request",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 9,
  },
  {
    kind: "pr_closed",
    group: "pull_requests",
    label: "PR closed",
    description: "One of your PRs closed unmerged.",
    iconKey: "closed",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 10,
  },
  {
    kind: "agent_goal",
    group: "agents",
    label: "Agent reaches its goal",
    description: "A run reached, or got stuck on, the goal you gave it.",
    iconKey: "goal",
    defaultPolicy: "notify",
    supportsAmbient: false,
    reach: "computers",
    scoped: true,
    order: 11,
  },
  {
    kind: "agent_message",
    group: "messages",
    label: "Messages from agents",
    description: "An agent or automation sent you a note (ade notify).",
    iconKey: "message",
    defaultPolicy: "notify",
    supportsAmbient: true,
    reach: "everywhere",
    scoped: true,
    order: 12,
  },
  {
    kind: "ade_service",
    group: "ade",
    label: "Background service stops or recovers",
    description: "ADE's background service on this computer went into fallback, or came back.",
    iconKey: "service",
    defaultPolicy: "notify",
    supportsAmbient: false,
    reach: "computers",
    scoped: false,
    order: 13,
  },
] as const satisfies readonly ActivityEventDescriptor[];

export const ACTIVITY_EVENT_BY_KIND = Object.fromEntries(
  ACTIVITY_EVENT_CATALOG.map((descriptor) => [descriptor.kind, descriptor]),
) as Readonly<Record<AttentionPolicyEventKind, ActivityEventDescriptor>>;
