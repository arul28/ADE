import type { ModelId, OnboardingDetectionResult } from "./core";
import type {
  LinearCatalogLabel,
  LinearCatalogState,
  LinearCatalogUser,
  LinearConnectionStatus,
  NormalizedLinearIssue,
} from "./linearSync";

export type CtoCapabilityMode = "full_tooling" | "fallback";

/**
 * Which shape of identity record the reader is looking at.
 *
 * Distinct from `CtoIdentity.version`, which is a revision counter bumped on
 * every edit and therefore says nothing about the fields present. This one only
 * moves when the record's shape changes, so a one-time migration can tell "not
 * converted yet" from "converted, and edited thirty times since".
 *
 * 2 = the fold that carried `constraints`, `personality`, `customPersonality`
 * and `communicationStyle` into `systemPromptExtension`.
 */
export const CTO_IDENTITY_SCHEMA_VERSION = 2;

/**
 * Fields older identity.yaml files still carry.
 *
 * They are no longer part of `CtoIdentity` — the preset personalities and the
 * separate constraint list were replaced by a single freeform
 * `systemPromptExtension`. They are declared here so the migration that folds
 * them into that extension has a name for what it is reading, and so nobody
 * re-adds them to the live type by accident.
 */
export type CtoLegacyIdentityFields = {
  personality?: "professional" | "casual" | "minimal" | "custom" | null;
  customPersonality?: string | null;
  communicationStyle?: {
    verbosity?: string | null;
    proactivity?: string | null;
    escalation?: string | null;
  } | null;
  constraints?: string[] | null;
};

export type CtoIdentity = {
  name: string;
  version: number;
  /**
   * Shape of the record, not its revision. Absent on anything written before
   * the legacy fold existed, which is exactly what marks it as needing one.
   */
  schemaVersion?: number;
  persona: string;
  systemPromptExtension?: string;
  onboardingState?: CtoOnboardingState;
  /**
   * Null until the user has picked a model the CTO can actually run on. A
   * stored preference on a provider that cannot redirect a live turn is
   * normalized back to null rather than silently kept, so the picker card is
   * the only way out and no CTO thread ever starts on a queue-only provider.
   */
  modelPreferences: CtoModelPreferences | null;
  /**
   * "Let the CTO reach my other machines" (Settings › CTO). Absent means on.
   * Off, every cross-machine tool answers that it is turned off, nothing is
   * paired, and the live-state roster is left out.
   *
   * The user's switch alone: the runtime refuses an `updateIdentity` patch
   * that names it from any caller but the desktop.
   */
  crossMachineEnabled?: boolean | null;
  updatedAt: string;
};

export type CtoModelPreferences = {
  provider: string;
  model: string;
  modelId?: ModelId;
  reasoningEffort?: string | null;
};

export type CtoSessionLogEntry = {
  id: string;
  prevHash?: string | null;
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: CtoCapabilityMode;
  /**
   * How many turns the user took in this session.
   *
   * Optional because the field arrived after the log did: every entry written
   * before it simply has no count, and nothing backfills them. Null and absent
   * mean the same thing — "not recorded" — and the UI hides the column rather
   * than print a zero it cannot stand behind.
   */
  turnCount?: number | null;
  createdAt: string;
};

/**
 * What the runtime hosting this CTO can do. Absent on runtimes built before the
 * field existed, and a missing key means "no": a renderer reads
 * `capabilities?.crossMachine === true`, never the inverse.
 */
export type CtoRuntimeCapabilities = {
  /** The CTO's tools can reach the account's other machines (`listMachines`, `machine` args, `runMachineAction`). */
  crossMachine?: boolean;
};

export type CtoSnapshot = {
  identity: CtoIdentity;
  recentSessions: CtoSessionLogEntry[];
  capabilities?: CtoRuntimeCapabilities;
};

export type CtoGetStateArgs = {
  recentLimit?: number;
};

/**
 * What starting a fresh CTO thread actually did.
 *
 * `handoff` is reported rather than assumed because the case this exists for
 * is a thread too full to summarize itself: `source` says whether the CTO wrote
 * its own note or ADE distilled one from the transcript, and `thin` says the
 * distillation found little to work with. The retired conversation is still in
 * History with its transcript on disk either way.
 */
export type CtoStartFreshSessionResult = {
  sessionId: string;
  previousSessionId: string | null;
  handoff: {
    written: boolean;
    thin: boolean;
    source: "model" | "deterministic" | "none";
  };
};

export type CtoEnsureSessionArgs = {
  modelId?: ModelId | null;
  reasoningEffort?: string | null;
};

export type CtoUpdateIdentityArgs = {
  patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>;
};

export type CtoListSessionLogsArgs = {
  limit?: number;
};

/* ── Onboarding ── */

/**
 * Durable per-project markers, not a setup wizard.
 *
 * The wizard is gone; what remains is `completedSteps`, which carries the
 * non-user-facing `intro` and `memory_gardener` markers. The old `dismissedAt`
 * and `completedAt` went with their last writer and their last reader.
 */
export type CtoOnboardingState = {
  completedSteps: string[];
};

export type CtoSystemPromptPreviewSection = {
  id: "doctrine" | "continuity" | "memory" | "knowledge" | "capabilities";
  title: string;
  content: string;
};

export type CtoSystemPromptPreview = {
  prompt: string;
  tokenEstimate: number;
  sections: CtoSystemPromptPreviewSection[];
};

/**
 * The immutable half of the CTO's per-turn context prefix.
 *
 * Doctrine, continuity model, memory guidance, the ADE environment knowledge
 * document and the capability manifest do not change between two turns of the
 * same conversation, so a provider thread that has already been told them holds
 * them verbatim. `key` is the content identity of `body`: it changes only when
 * the prompt itself changes (an identity rename, an edited prompt extension, a
 * new capability manifest), which is the one case a live thread must be told
 * again.
 */
export type CtoStaticContextSection = {
  title: string;
  body: string;
  key: string;
};

export type CtoGetOnboardingStateResult = CtoOnboardingState;

export type CtoCompleteOnboardingStepArgs = {
  stepId: string;
};

export type CtoPreviewSystemPromptArgs = {
  identityOverride?: Partial<CtoIdentity>;
};

export type CtoGetLinearProjectsArgs = Record<string, never>;

export type CtoLinearProject = {
  id: string;
  name: string;
  slug: string;
  teamName: string;
  teamKey?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type CtoSearchLinearIssuesArgs = {
  projectId?: string | null;
  projectSlug?: string | null;
  teamKey?: string | null;
  stateTypes?: string[];
  /** Workflow state ids; used for per-state group counts. */
  stateIds?: string[];
  assigneeId?: string | null;
  /** Only issues assigned to the connected Linear user ("My issues"). */
  assignedToViewer?: boolean;
  /** Only issues in their team's active cycle ("Current cycle"). */
  activeCycle?: boolean;
  /** Apply a Linear custom view's saved filter (ANDed with the other filters). */
  customViewId?: string | null;
  priority?: number | null;
  /** Full-text search term (Linear `searchIssues`), plus an identifier/number match. */
  query?: string | null;
  first?: number;
  after?: string | null;
  includeArchived?: boolean;
};

export type CtoSearchLinearIssuesResult = {
  issues: NormalizedLinearIssue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  /** Server-side total for a full-text search; absent for plain filter reads. */
  totalCount?: number | null;
};

export type CtoCountLinearIssuesArgs = {
  /** One count per key. Each value is the same filter shape the search takes. */
  queries: Record<string, CtoSearchLinearIssuesArgs>;
  /** Stop counting a key past this many issues and report `capped`. */
  cap?: number;
};

export type CtoLinearIssueCount = {
  count: number;
  /** True when the count stopped at the cap; show it as `${count}+`. */
  capped: boolean;
};

export type CtoCountLinearIssuesResult = {
  /** `null` for a key whose filter Linear rejected. */
  counts: Record<string, CtoLinearIssueCount | null>;
};

export type CtoLinearCustomView = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  teamKey: string | null;
  shared: boolean;
};

export type LinearIssueRelationKind = "blocks" | "blocked_by" | "related" | "duplicate";

export type LinearIssueCreateInput = {
  /** Team key ("VER") or team id. */
  teamKey: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  parentId?: string | null;
  stateId?: string | null;
  assigneeId?: string | null;
  priority?: number | null;
  labelIds?: string[];
};

/** One entry of the viewer's Linear inbox. */
export type LinearInboxNotification = {
  id: string;
  /** Linear's notification type, e.g. "issueMention", "issueNewComment", "issueAssignedToYou". */
  type: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntilAt: string | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
  actorInitials?: string | null;
  /** Linear's own one-line headline and the "who did what" line under it. */
  title?: string | null;
  subtitle?: string | null;
  /** Opens the item in Linear (issues, pull requests, projects). */
  url?: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
  issueStateName: string | null;
  issueStateType: string | null;
  commentId: string | null;
  commentBody: string | null;
};

/** The ADE Linear agent in the connected workspace (from the relay). */
export type LinearAgentStatus = {
  ok: true;
  orgId: string;
  orgName: string | null;
  installed: boolean;
  appUserId: string | null;
  installedAt: string | null;
  installedByMe: boolean;
  fallbackMode: "reply" | "runner";
  runnerIsMe: boolean;
  runnerConfigured: boolean;
  me: {
    linearUserId: string | null;
    registered: boolean;
    /** This Linear user's delegations go to a different ADE account. */
    routedToOtherAccount?: boolean;
  };
  members: Array<{
    linearUserId: string;
    displayName: string | null;
    isMe: boolean;
    registeredAt: string | null;
    lastSeenAt: string | null;
  }>;
};

/** The ADE agent panel in Settings: relay status plus this machine's rule state. */
export type LinearAgentOverview = {
  /** False when the relay could not be reached or ADE is not signed in. */
  available: boolean;
  message: string | null;
  status: LinearAgentStatus | null;
  /** Enabled rules on this machine with a `linear.agent_*` trigger. */
  rules: Array<{ id: string; name: string; enabled: boolean; triggerTypes: string[]; modelId: string | null; laneMode: string | null }>;
  /** Linear agent sessions this machine is running now. */
  activeSessions: Array<{ agentSessionId: string; chatSessionId: string; laneId: string | null; issueIdentifier: string | null; startedAt: string }>;
};

export type CtoGetLinearIssueArgs = {
  issueId: string;
};

export type CtoUpdateLinearIssueArgs = {
  issueId: string;
  stateId?: string;
  /** `null` unassigns. */
  assigneeId?: string | null;
  /** 0 none, 1 urgent, 2 high, 3 normal, 4 low. */
  priority?: number;
  addedLabelIds?: string[];
  removedLabelIds?: string[];
};

export type CtoGetLinearIssueCommentsArgs = {
  issueId: string;
};

export type CtoLinearIssueComment = {
  id: string;
  body: string;
  createdAt: string;
  userName: string;
  userDisplayName: string;
};

export type CtoGetLinearIssuePickerDataResult = {
  projects: CtoLinearProject[];
  users: LinearCatalogUser[];
  states: LinearCatalogState[];
  /** Workspace and team labels. Optional: older brains do not send it. */
  labels?: LinearCatalogLabel[];
};

export type CtoLinearQuickViewProject = CtoLinearProject & {
  url: string | null;
  color: string | null;
  icon: string | null;
  description: string | null;
  statusName: string | null;
  statusType: string | null;
  health: string | null;
  progress: number | null;
  scope: number | null;
  priority: number | null;
  priorityLabel: string | null;
  issueCount: number | null;
  completedIssueCount: number | null;
  startDate: string | null;
  targetDate: string | null;
  leadName: string | null;
  teamKeys: string[];
};

export type CtoLinearQuickViewTeam = {
  id: string;
  key: string;
  name: string;
  displayName: string;
  color: string | null;
  issueCount: number | null;
  cyclesEnabled: boolean | null;
  private: boolean | null;
};

export type CtoLinearQuickView = {
  connection: LinearConnectionStatus;
  organization: {
    id: string;
    name: string;
    urlKey: string | null;
    logoUrl: string | null;
    gitBranchFormat: string | null;
    createdIssueCount: number | null;
    roadmapEnabled: boolean | null;
    customersEnabled: boolean | null;
    releasesEnabled: boolean | null;
  } | null;
  viewer: {
    id: string;
    name: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    admin: boolean | null;
    guest: boolean | null;
    url: string | null;
  } | null;
  projects: CtoLinearQuickViewProject[];
  teams: CtoLinearQuickViewTeam[];
  assignedIssues: NormalizedLinearIssue[];
  recentIssues: NormalizedLinearIssue[];
  fetchedAt: string;
  sdk: {
    packageName: "@linear/sdk";
    surfaces: string[];
  };
};

export type CtoStartLinearOAuthArgs = Record<string, never>;

export type CtoSetLinearOAuthClientArgs = {
  clientId: string;
  clientSecret?: string | null;
};

export type CtoClearLinearOAuthClientArgs = Record<string, never>;

export type CtoStartLinearOAuthResult = {
  sessionId: string;
  authUrl: string;
  redirectUri: string;
};

export type CtoLinearOAuthSessionState = "pending" | "completed" | "failed" | "expired";

export type CtoGetLinearOAuthSessionArgs = {
  sessionId: string;
};

export type CtoGetLinearOAuthSessionResult = {
  status: CtoLinearOAuthSessionState;
  connection?: LinearConnectionStatus;
  error?: string | null;
};

export type CtoRunProjectScanArgs = Record<string, never>;

export type CtoRunProjectScanResult = {
  detection: OnboardingDetectionResult | null;
};

/* ── Smart memory ── */

/**
 * Snapshot of the CTO's durable memory surface. The iOS client decodes this
 * exact shape via the `cto.getMemory` sync command, so the field names and
 * types here are a cross-platform contract — do not rename them.
 */
export type CtoMemorySnapshot = {
  memory: string;
  threadState: string;
  dailyLog: string;
  dailyLogDate: string;
  updatedAt: string | null;
  /** The one project brief. Null until the CTO writes one. */
  projectBrief: string | null;
  /** Threads the CTO has directed. Null when none have been recorded. */
  projectThreads: string | null;
  /** Ranked project facts. Null when the context store has nothing to show. */
  projectItems: string | null;
};

export type CtoGetMemoryArgs = Record<string, never>;

export type CtoUpdateMemoryArgs = {
  memory: string;
};

export type CtoSearchMemoryArgs = {
  query: string;
  limit?: number;
};

export type CtoMemorySearchRow = {
  file: "MEMORY.md" | "thread-state.md" | "daily" | "memory-archive.md" | "context";
  date: string | null;
  line: number;
  snippet: string;
};

export type CtoSearchMemoryResult = {
  query: string;
  rows: CtoMemorySearchRow[];
};

/* ── Attention ── */

/**
 * Whether the CTO thread is blocked on the user. The CTO chat is deliberately
 * hidden from every lane/session roster, so it cannot borrow the Work tab's
 * attention dot — this is the one signal that keeps a hidden thread from going
 * silent when it asks a question.
 */
export type CtoAttentionState =
  | { status: "idle"; awaitingInput: false; since: null }
  | {
      status: "awaiting-input";
      awaitingInput: true;
      /** When the thread started waiting; null when the exact time is unavailable. */
      since: string | null;
    }
  | {
      /** Clients retain their last known badge state when inspection fails. */
      status: "unknown";
      awaitingInput: false;
      since: null;
    };
