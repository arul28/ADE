import type {
  AttentionDeliveryPolicy,
  AttentionEventKind,
} from "./types/attention";

export type ActivityEventGroup = "agents" | "pull_requests";

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
  | "closed";

export type ActivityEventDescriptor = {
  kind: AttentionEventKind;
  group: ActivityEventGroup;
  label: string;
  description: string;
  iconKey: ActivityIconKey;
  defaultPolicy: AttentionDeliveryPolicy;
  supportsAmbient: boolean;
  order: number;
};

export const ACTIVITY_EVENT_GROUPS = [
  { id: "agents", label: "Agents" },
  { id: "pull_requests", label: "Pull requests" },
] as const satisfies readonly { id: ActivityEventGroup; label: string }[];

/**
 * One ordered source of truth for every event ADE can put in Activity.
 * Existing Notifications copy stays verbatim so adopting the catalog is a
 * structural refactor rather than a settings-page copy change.
 */
export const ACTIVITY_EVENT_CATALOG = [
  {
    kind: "agent_needs_you",
    group: "agents",
    label: "Agent asks a question",
    description: "A run is blocked waiting on your answer.",
    iconKey: "needs-you",
    defaultPolicy: "notify",
    supportsAmbient: true,
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
    order: 4,
  },
  {
    kind: "pr_review_requested",
    group: "pull_requests",
    label: "Review requested",
    description: "Someone asked you to review.",
    iconKey: "review",
    defaultPolicy: "notify",
    supportsAmbient: true,
    order: 5,
  },
  {
    kind: "pr_changes_requested",
    group: "pull_requests",
    label: "Changes requested",
    description: "A reviewer asked for changes.",
    iconKey: "changes",
    defaultPolicy: "notify",
    supportsAmbient: true,
    order: 6,
  },
  {
    kind: "pr_merge_ready",
    group: "pull_requests",
    label: "PR ready to merge",
    description: "Checks passed and reviews are in.",
    iconKey: "merge-ready",
    defaultPolicy: "notify",
    supportsAmbient: true,
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
    order: 8,
  },
  {
    kind: "pr_opened",
    group: "pull_requests",
    label: "PR opened",
    description: "One of your pull requests was opened.",
    iconKey: "pull-request",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    order: 9,
  },
  {
    kind: "pr_closed",
    group: "pull_requests",
    label: "PR closed",
    description: "One of your pull requests closed without merging.",
    iconKey: "closed",
    defaultPolicy: "ambient",
    supportsAmbient: true,
    order: 10,
  },
] as const satisfies readonly ActivityEventDescriptor[];

export const ACTIVITY_EVENT_BY_KIND = Object.fromEntries(
  ACTIVITY_EVENT_CATALOG.map((descriptor) => [descriptor.kind, descriptor]),
) as Readonly<Record<AttentionEventKind, ActivityEventDescriptor>>;
