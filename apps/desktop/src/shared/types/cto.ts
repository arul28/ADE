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
 * moves when the record's shape changes, so a later migration can tell "not
 * converted yet" from "converted, and edited thirty times since".
 *
 * 2 = CTO v2. Every record this build writes carries it; nothing reads it yet.
 * CTO v2 starts every CTO over, so there is no v1 record to convert.
 */
export const CTO_IDENTITY_SCHEMA_VERSION = 2;

export type CtoIdentity = {
  name: string;
  version: number;
  /**
   * Shape of the record, not its revision. Absent on anything written
   * before CTO v2.
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
  /**
   * Backup models, in order. When the main model fails for a reason a
   * different model would not hit (usage or rate limit, sign-in, provider
   * down), ADE moves the thread to the next one and sends the message again.
   * Each entry passes the same live-redirect check as `modelPreferences`.
   */
  fallbackModels?: CtoModelPreferences[];
  /** How the CTO looks. Absent means the default look. */
  avatar?: CtoAvatarLook | null;
  /** How the CTO talks. Absent means "focused". */
  personality?: CtoPersonality | null;
  /**
   * The person's IANA time zone, written by the desktop and the phone when
   * they open the CTO. Its routines and its sense of "now" use it, so they
   * keep their hour when the CTO lives on a computer in another zone (an ADE
   * Cloud computer runs on UTC). Absent means the home machine's zone.
   */
  timeZone?: string | null;
  updatedAt: string;
};

export type CtoModelPreferences = {
  provider: string;
  model: string;
  modelId?: ModelId;
  reasoningEffort?: string | null;
  /**
   * Claude or Codex only: which signed-in account (provider instance id on the
   * CTO's home machine) runs it. Absent means the provider's default account.
   * Moving accounts keeps the CTO's one thread (`switchAccount`).
   */
  instanceId?: string | null;
};

/* ── Look and personality ── */

export const CTO_AVATAR_SHAPES = ["pebble", "bean", "spark", "chip", "drop", "cloud", "hex"] as const;
export type CtoAvatarShape = (typeof CTO_AVATAR_SHAPES)[number];

export const CTO_AVATAR_EYES = ["caret", "round", "visor", "pixel"] as const;
export type CtoAvatarEyes = (typeof CTO_AVATAR_EYES)[number];

export const CTO_AVATAR_ENERGIES = ["calm", "lively"] as const;
export type CtoAvatarEnergy = (typeof CTO_AVATAR_ENERGIES)[number];

export type CtoAvatarLook = {
  shape: CtoAvatarShape;
  /** `#rrggbb`, lower case. The body colour, also the CTO page's accent. */
  color: string;
  eyes: CtoAvatarEyes;
  energy: CtoAvatarEnergy;
};

export const DEFAULT_CTO_AVATAR_LOOK: CtoAvatarLook = {
  shape: "pebble",
  color: "#7c9cff",
  eyes: "caret",
  energy: "lively",
};

/** Most backup models the CTO keeps. */
export const CTO_MAX_FALLBACK_MODELS = 3;

export const CTO_PERSONALITIES = ["focused", "friendly", "playful"] as const;
export type CtoPersonality = (typeof CTO_PERSONALITIES)[number];

/**
 * What the CTO is doing right now, as its avatar shows it. Derived on the
 * client from the session status; never stored.
 */
export type CtoAvatarState = "idle" | "working" | "thinking" | "waiting" | "asleep" | "happy" | "error";

/* ── Notes and open work ── */

/** Hard caps on the two notes files, in UTF-8 bytes. */
export const CTO_PROJECT_NOTES_MAX_BYTES = 4096;
export const CTO_USER_NOTES_MAX_BYTES = 2048;
/** Open items the CTO tracks at once; done items past this many are dropped oldest first. */
export const CTO_OPEN_WORK_MAX_OPEN = 20;
export const CTO_OPEN_WORK_MAX_DONE = 30;

export type CtoNotesScope = "project" | "user";

/**
 * A file the person edits whole in Settings › Memory: the two notes files, or
 * the rules (`.ade/cto/RULES.md`), which the person and the CTO share.
 */
export type CtoNotesFile = CtoNotesScope | "rules";

/** Hard cap on `.ade/cto/RULES.md`, in UTF-8 bytes: it rides every turn. */
export const CTO_RULES_MAX_BYTES = 4096;
/** Skills the CTO keeps at once (`.ade/cto/skills/<name>/SKILL.md`). */
export const CTO_SKILLS_MAX = 40;
/** One SKILL.md, frontmatter included, in UTF-8 bytes. */
export const CTO_SKILL_MAX_BYTES = 8192;
/** A skill's one-line description, shown to the CTO on every turn. */
export const CTO_SKILL_DESCRIPTION_MAX_CHARS = 240;

/** One skill as the index shows it: the how-to itself is read on demand. */
export type CtoSkillSummary = {
  name: string;
  description: string;
  bytes: number;
  updatedAt: string | null;
};

/** One whole skill, as `cto_memory.getSkill` answers it. */
export type CtoSkillFile = CtoSkillSummary & {
  /** The whole SKILL.md: frontmatter (`name`, `description`) and the how-to. */
  text: string;
  /** sha256 (hex) of `text`; pass it back as `CtoWriteSkillArgs.baseHash`. */
  hash: string;
};

export type CtoGetSkillArgs = { name: string };

export type CtoWriteSkillArgs = {
  name: string;
  /** The whole SKILL.md. A missing frontmatter gets one with this name. */
  text: string;
  /** sha256 (hex) of the text the editor started from; a changed file refuses the write. */
  baseHash?: string;
};

export type CtoDeleteSkillArgs = { name: string };

/** Undo one change a CTO turn's "Learned" row lists. Only the person may. */
export type CtoUndoLearnedArgs = { learnId: string; changeId: string };

export type CtoUndoLearnedResult = { undone: boolean; note?: string };

export type CtoOpenWorkItem = {
  id: string;
  text: string;
  createdAt: string;
  doneAt: string | null;
  addedBy: "cto" | "user";
};

export type CtoUpdateNotesArgs = {
  scope: CtoNotesFile;
  /** The whole notes file, one note per line. Over the cap is refused. */
  text: string;
  /**
   * sha256 (hex) of the notes text the editor started from: the snapshot's
   * `memoryHash` or `userNotesHash`. When given and the file changed since
   * (the CTO wrote a note, another device saved), the write is refused with
   * {@link CTO_NOTES_CHANGED_ERROR} instead of overwriting it.
   */
  baseHash?: string;
};

/**
 * The start of the error a notes write gets when the file changed since the
 * editor loaded it. Match it with {@link isCtoNotesChangedError}: errors lose
 * their class across IPC and sync, the message survives.
 */
export const CTO_NOTES_CHANGED_ERROR = "Notes changed since you opened them.";

export function isCtoNotesChangedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(CTO_NOTES_CHANGED_ERROR);
}

export type CtoUpdateOpenWorkArgs =
  | { op: "add"; text: string }
  | { op: "complete"; id: string }
  | { op: "reopen"; id: string }
  | { op: "remove"; id: string };

/** What `cto.refreshContext` did. A busy CTO is refreshed when its turn ends. */
export type CtoRefreshContextResult = {
  refreshed: boolean;
  /** Why nothing happened now, when `refreshed` is false. */
  reason?: string;
};

/** One message of the CTO's conversation, as `readHistory` hands it back. */
export type CtoHistoryEntry = {
  role: "user" | "assistant";
  /** Clipped to about 600 characters. */
  text: string;
  at: string;
  sessionId: string;
  /** In a search: true on the entries that matched, false on their neighbours. */
  match?: boolean;
};

export type CtoReadHistoryArgs = {
  /** Words that must all appear (case-insensitive). Absent pages the conversation newest first. */
  query?: string | null;
  /** The `nextBefore` of the previous page. */
  before?: string | null;
  /** Default 20, at most 50. */
  limit?: number;
};

export type CtoHistoryPage = {
  entries: CtoHistoryEntry[];
  /** Pass as `before` for the next older page; null when there is none. */
  nextBefore: string | null;
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

export type CtoGetStateArgs = Record<string, never>;

export type CtoEnsureSessionArgs = {
  modelId?: ModelId | null;
  reasoningEffort?: string | null;
};

export type CtoUpdateIdentityArgs = {
  patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>;
};

/* ── Onboarding ── */

/**
 * Durable per-project markers, not a setup wizard.
 *
 * The wizard is gone; what remains is `completedSteps`, which carries the
 * non-user-facing `intro` marker.
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
  projectMilestoneId?: string | null;
  cycleId?: string | null;
  /** In the team's estimate scale. */
  estimate?: number | null;
  /** `YYYY-MM-DD`. */
  dueDate?: string | null;
  /** A Linear issue template; it fills what the input leaves empty. */
  templateId?: string | null;
};

/** What a team offers the create form beyond the picker catalog. */
export type LinearIssueCreateOptions = {
  teamId: string;
  teamKey: string;
  cyclesEnabled: boolean;
  /** `notUsed`, `exponential`, `fibonacci`, `linear` or `tShirt`. */
  estimationType: string;
  estimationAllowZero: boolean;
  estimationExtended: boolean;
  /** The active cycle and the upcoming ones. */
  cycles: Array<{ id: string; number: number; name: string | null; startsAt: string; endsAt: string; active: boolean }>;
  templates: Array<{ id: string; name: string; description: string | null; title: string | null; priority: number | null; labelIds: string[] }>;
};

export type LinearProjectMilestone = { id: string; name: string; targetDate: string | null };

/** One file put on Linear's storage; `assetUrl` goes into markdown. */
export type LinearUploadResult = { assetUrl: string; filename: string; contentType: string };

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
  /** A non-blank title replaces the issue's title. */
  title?: string;
  /** Markdown; an empty string clears the description. */
  description?: string;
  /** `null` clears each of these. */
  projectId?: string | null;
  projectMilestoneId?: string | null;
  cycleId?: string | null;
  estimate?: number | null;
  /** `YYYY-MM-DD`. */
  dueDate?: string | null;
  parentId?: string | null;
};

export type CtoCreateLinearIssueCommentArgs = {
  issueId: string;
  body: string;
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
  /** Absent from older brains. */
  userAvatarUrl?: string | null;
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
  /** Project notes (`.ade/cto/MEMORY.md`), one note per line. iOS reads this field. */
  memory: string;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  /** Notes about the person, shared by the CTO in every project on this machine. */
  userNotes?: string;
  userNotesBytes?: number;
  userNotesLimitBytes?: number;
  /** sha256 (hex) of `memory`; pass it back as `CtoUpdateNotesArgs.baseHash`. */
  memoryHash?: string;
  /** sha256 (hex) of `userNotes`; pass it back as `CtoUpdateNotesArgs.baseHash`. */
  userNotesHash?: string;
  /** `.ade/cto/RULES.md`: standing rules the person and the CTO both edit. */
  rules?: string;
  rulesBytes?: number;
  rulesLimitBytes?: number;
  /** sha256 (hex) of `rules`; pass it back as `CtoUpdateNotesArgs.baseHash`. */
  rulesHash?: string;
  /** The CTO's skills, one how-to per kind of task, by name. */
  skills?: CtoSkillSummary[];
  /** Open and recently finished work items, open first. */
  openWork?: CtoOpenWorkItem[];
  updatedAt: string | null;
};

export type CtoGetMemoryArgs = Record<string, never>;

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

/* ── Waiting on you ── */

/**
 * One line the CTO set for a chat it started that needs the person: a merge
 * to approve, a product call, a sign-in. Set with the CTO's `setNeed` tool.
 * A need holds only while the chat stays where it was when the line was set:
 * once the chat moves (a turn, a message, an answer), the host drops it.
 */
export type CtoNeed = {
  childSessionId: string;
  /** The chat's title when read, for the row. */
  childTitle: string;
  /** The chat's lane, so a client can open it in place. Null when unknown. */
  laneId: string | null;
  /** What the person must do, in one line. */
  line: string;
  setAt: string;
};

/** The CTO's open needs, oldest first. Read with `cto.getNeeds` on the CTO's home machine. */
export type CtoNeedsSnapshot = {
  needs: CtoNeed[];
};

/** The longest need line the host keeps; a longer line is cut at a word. */
export const CTO_NEED_LINE_MAX = 160;
