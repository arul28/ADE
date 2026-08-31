// ---------------------------------------------------------------------------
// Agent chat types
// ---------------------------------------------------------------------------

import type { AdeCardPayload } from "../adeCard";
import type { ModelId } from "./core";
import type { CtoCapabilityMode } from "./cto";
import type { FileDiff } from "./git";
import type { LaneGitHubIssue, LaneLinearIssue, SessionLinearIssueLink } from "./lanes";
import type { OrchestrationContextItem, OrchestrationRole } from "./orchestration";
import type { AdeRecoveryErrorCode } from "./recovery";
import type { SessionBackgroundWork } from "../sessionCanonicalState";
import type { RuntimeProcessSummary } from "./sessions";
import type { SubagentCapability } from "../subagentCapabilities";
import { providerDisplayLabel } from "../pendingInputLabels";

/**
 * `"plugin"` is one value, not one per plugin. A session owned by a plugin
 * chat runtime says so with `provider: "plugin"` and names WHICH plugin in
 * {@link AgentChatSession.runtimeRef}. Minting a provider string per installed
 * plugin would put an unbounded, install-time-discovered set into a union that
 * ~20 provider-keyed maps across four clients close over, and every one of them
 * would have to grow a case that no client could enumerate ahead of time.
 */
export type AgentChatProvider =
  | "codex"
  | "claude"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi"
  | "plugin"
  | (string & {});

export type AgentChatSessionStatus = "active" | "idle" | "ended";
export type AgentChatSessionProfile = "light" | "workflow";

export type DelegationMode = "exclusive" | "bounded_parallel" | "recovery";

export type DelegationIntent =
  | "planner"
  | "implementation"
  | "validation"
  | "specialist"
  | "subagent"
  | "parallel_subtasks"
  | "recovery";

export type DelegationScope = {
  kind: "phase" | "step" | "worker" | "batch";
  key: string;
  label?: string | null;
};

export type DelegationContractStatus =
  | "launching"
  | "active"
  | "completed"
  | "failed"
  | "launch_failed"
  | "recovering"
  | "blocked"
  | "canceled";

export type DelegationLaunchState =
  | "awaiting_context"
  | "fetching_context"
  | "awaiting_worker_launch"
  | "launching_worker"
  | "waiting_on_worker"
  | "recovering"
  | "completed"
  | "blocked";

export type CoordinatorCapability =
  | "observe"
  | "fetch_project_context"
  | "spawn_top_level_worker"
  | "spawn_nested_worker"
  | "spawn_parallel_workers"
  | "read_repo"
  | "message_workers"
  | "ask_user"
  | "run_control"
  | "update_state";

export type DelegationFailureCategory =
  | "run_context_bug"
  | "provider_unreachable"
  | "permission_denied"
  | "tool_schema_error"
  | "native_tool_violation"
  | "unknown";

export type DelegationContract = {
  schemaVersion: 1;
  contractId: string;
  runId: string;
  ownerKind: "coordinator";
  workerIntent: DelegationIntent;
  mode: DelegationMode;
  scope: DelegationScope;
  phaseKey: string | null;
  status: DelegationContractStatus;
  launchState: DelegationLaunchState | null;
  activeWorkerIds: string[];
  coordinatorCapabilities: CoordinatorCapability[];
  launchPolicy: {
    maxLaunchAttempts: number;
  };
  failurePolicy: {
    retryLimit: number;
    escalation: "intervention" | "retry" | "stop";
  };
  batchId?: string | null;
  parentContractId?: string | null;
  failure?: {
    category: DelegationFailureCategory;
    message: string;
    retryAfterMs?: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatSurfaceMode = "standard" | "resolver";
export type ChatSurfaceProfile = "standard" | "persistent_identity";

export type ChatSurfaceChipTone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

export type OperatorNavigationSurface = "work" | "lanes" | "cto";

export type OperatorNavigationSuggestion = {
  surface: OperatorNavigationSurface;
  label: string;
  href: string;
  laneId?: string | null;
  sessionId?: string | null;
};

export type ChatSurfaceChip = {
  label: string;
  tone?: ChatSurfaceChipTone;
};

export type ChatSurfacePresentation = {
  mode: ChatSurfaceMode;
  profile?: ChatSurfaceProfile;
  title?: string | null;
  subtitle?: string | null;
  accentColor?: string | null;
  assistantLabel?: string | null;
  messagePlaceholder?: string | null;
  chips?: ChatSurfaceChip[];
  showMcpStatus?: boolean;
};

export type AgentChatApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";
export type AgentChatClaudePermissionMode = "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions";
export type AgentChatClaudeOutputStyleSource = "builtin" | "user" | "project" | "plugin";
export type AgentChatClaudeOutputStyle = {
  name: string;
  description?: string;
  source: AgentChatClaudeOutputStyleSource;
  filePath?: string;
  pluginPath?: string;
};
export type AgentChatClaudePlugin = {
  name: string;
  path: string;
  source: "local";
  description?: string;
  version?: string;
};
export type AgentChatClaudePluginsArgs = {
  sessionId?: string;
  laneId?: string;
};
export type AgentChatReloadClaudePluginsArgs = {
  sessionId: string;
};
export type AgentChatReloadClaudePluginsResult = {
  plugins: AgentChatClaudePlugin[];
  commands: Array<{ name: string; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
  errorCount: number;
};
export type AgentChatCodexApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type AgentChatCodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AgentChatCodexConfigSource = "flags" | "config-toml";
export type AgentChatOpenCodePermissionMode = "plan" | "edit" | "full-auto" | "config-toml";
export type AgentChatDroidPermissionMode = "read-only" | "auto-low" | "auto-medium" | "auto-high" | "agi";

export type AgentChatResumeFailureKind = "thread_missing" | "provider_environment" | "transient" | "unknown";
export type AgentChatSpawnKind = "subagent" | "peer";

/**
 * Terminal outcome of a spawned child chat, delivered to the spawner. Rides the
 * `subagent` wake message's metadata and the `peer` `spawn_completed` notice
 * detail — one shape both producer and every renderer consumer narrow off.
 */
export type AgentChatSpawnCompletion = {
  childSessionId: string;
  childTitle: string;
  spawnKind: AgentChatSpawnKind;
  /** Child turn whose completion produced this delivery. Enables durable dedupe. */
  childTurnId?: string;
  status: "completed" | "failed" | "stopped";
  summary?: string;
  /**
   * Human messages the user sent to the child during this turn. Present on
   * subagent wakes so the parent can see the two-drivers overlap before it
   * follows up. Omitted when the count is zero.
   */
  humanMessageCount?: number;
};

/**
 * The `spawn_completed` notice's message text. One definition so the emitted
 * `message` and the chip that renders it can never drift — the chip re-states
 * the sentence rather than echoing the stored string, because a stored one may
 * be older than the current wording.
 */
export function spawnCompletedNoticeMessage(childTitle: string): string {
  return `Chat "${childTitle}" finished its turn`;
}

/**
 * The fallback line shown when a chat is blocked on the user and there is no
 * question text to show instead.
 *
 * One definition because this copy is not local to the chat pane: it becomes
 * the notch card's subtitle, the phone's push body and the lock screen preview.
 * Every provider used to spell its own variant of "<Provider> needs input
 * before it can continue" — a sentence about the agent where the user wanted a
 * sentence about them, and six places to fix when the wording changed.
 *
 * @param count how many answers are outstanding; omit or pass 1 for the
 * singular. Anything above one gets the plural.
 */
export function waitingOnYouDescription(count?: number): string {
  return (count ?? 1) > 1 ? "Waiting on your answers." : "Waiting on your answer.";
}

export type AgentChatSpawnDispatchMetadata = {
  /** Trusted caller session that dispatched this turn to its direct child. */
  parentSessionId: string;
  dispatchedAt: string;
};

export type AgentChatAgentRelayMetadata = {
  /** Trusted caller session, derived from its bound identity. */
  fromSessionId: string;
};

export type AgentChatHostContinuationMetadata = {
  reason:
    | "provider_schedule_cleanup"
    | "plan_followup"
    | "interrupted_turn_recovery"
    | "continuity_recovery"
    | "cto_intro";
};

export type AgentChatContinuityRecovery = {
  state: "required" | "reconstructed";
  reason: AgentChatResumeFailureKind;
  provider: string;
  originalThreadId: string | null;
  at: string;
  detail?: string;
  reconstructedThreadId?: string;
  supersededBySessionId?: string;
};

export type AgentChatNoticeDetailMetric = {
  label: string;
  value: string;
  tone?: ChatSurfaceChipTone;
};

export type AgentChatNoticeDetailSection = {
  title: string;
  items: Array<string | AgentChatNoticeDetailMetric>;
};

export type AgentChatNoticeDetail = {
  kind?: "continuity_recovery" | "disk_pressure";
  state?: "required" | "reconstructed" | "normal" | "warning" | "critical" | "exhausted";
  reason?: AgentChatResumeFailureKind;
  originalThreadId?: string | null;
  reconstructedThreadId?: string;
  supersededBySessionId?: string;
  title?: string;
  summary?: string;
  metrics?: AgentChatNoticeDetailMetric[];
  sections?: AgentChatNoticeDetailSection[];
  permissionModeTransition?: "entered_plan_mode" | "exited_plan_mode";
  /**
   * Access mode in force after the transition. The renderer applies this
   * directly instead of guessing: on exit it used to hardcode `default`,
   * which silently demoted a session that had been in `bypassPermissions`
   * or `acceptEdits` before it entered plan mode.
   */
  permissionModeAfterTransition?: AgentChatClaudePermissionMode;
  /**
   * Deep-link to a child chat session spawned from this one (the
   * "Subagent spawned" chip on `status: "subagent_spawned"` notices).
   * Desktop navigates to the session; the TUI switches to it; iOS renders
   * the notice message (extra fields are ignored by its decoder).
   */
  spawnedSession?: {
    sessionId: string;
    laneId?: string | null;
    title?: string;
  };
  spawnKind?: AgentChatSpawnKind;
  /**
   * True when an inline spawned-chat card (`subagent_started`) accompanies this
   * `subagent_spawned` notice — i.e. a plain (non-orchestration) spawn. The
   * renderer suppresses the quiet pill in that case (the card is the surface) and
   * keeps the pill only for orchestration-run children, which emit the notice but
   * no inline card. Absent/false → render the pill.
   */
  hasInlineCard?: boolean;
  spawnCompletion?: AgentChatSpawnCompletion;
  spawnTakeover?: {
    childSessionId: string;
    childTitle: string;
  };
  spawnCompletionDeliveryFailure?: {
    childTurnId: string;
    parentSessionId: string;
    error: string;
  };
  crossMachineHandoff?: {
    handoffId: string;
    targetMachineName: string;
    targetLaneId: string;
    targetSessionId: string;
  };
  /**
   * Identity of one host sleep, carried by both halves of the pause/resume
   * chip (`status: "host_asleep"` then `"host_awake"`). The renderer folds the
   * two into a SINGLE transcript row by this id, so a machine that sleeps
   * mid-turn adds one artifact to the transcript and then resolves it in
   * place — never a second banner under the first.
   */
  hostSleep?: {
    sleepId: string;
    /** How long the machine was out. Present on the resumed half when measured. */
    pausedMs?: number;
  };
};

export type AgentChatLocalFileRef = {
  path: string;
  type: "file" | "image";
};

export type AgentChatImageUrlRef = {
  path: string;
  type: "image-url";
  url: string;
};

export type AgentChatFileRef = AgentChatLocalFileRef | AgentChatImageUrlRef;

/**
 * Stage an attachment that already exists on the same machine as the main
 * process, by path. Local-only by construction: `sourcePath` names a file on
 * the client's disk, so this never routes to a remote runtime — a paired host
 * gets the bytes over the attachment upload route (or base64) instead.
 */
export type AgentChatCopyTempAttachmentArgs = {
  /** Absolute path on this machine, from `webUtils.getPathForFile`. */
  sourcePath: string;
  /** Display name; only its extension is used for the staged copy. */
  filename: string;
};

/**
 * How the composer must move an attachment to the machine that owns the chat,
 * and the ceiling that path can carry.
 *
 * - `copy` — same machine. Send the path, the brain copies the file.
 * - `upload` — paired host advertising the streamed HTTP route. Send the path,
 *   the main process streams the bytes.
 * - `base64` — everything else: a host predating the upload route, a
 *   relay-routed socket, or a client with no real path for the file (clipboard
 *   paste, hosted web). Read the bytes and use `saveTempAttachment`, which
 *   keeps the legacy image-only contract capped at
 *   `LEGACY_MAX_CHAT_ATTACHMENT_BYTES`.
 *
 * The cap travels WITH the mode on purpose. A renderer that hardcoded 50 MB
 * would let a user stage a file the chosen transport then rejects halfway.
 */
export type ChatAttachmentStagingMode = {
  mode: "copy" | "upload" | "base64";
  maxBytes: number;
};

/** MIME/extension checks for photos from iPhone and other HEIF-producing cameras. */
const HEIC_MIME_RE = /^image\/hei[cf](?:[-+;]|$)/i;
const HEIC_EXTENSION_RE = /\.(heic|heif)$/i;

export type HeicConversionErrorCode = "unavailable" | "failed";

export type ConvertImageToJpegResult =
  | { ok: true; data: string; filename: string; mimeType: "image/jpeg" }
  | { ok: false; errorCode: HeicConversionErrorCode };

const IMAGE_ATTACHMENT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

/** Return the MIME type for a supported image filename/path, if its suffix is known. */
export function getImageAttachmentMediaType(filePath: string): string | null {
  const extension = filePath.match(/\.[^./\\]+$/)?.[0]?.toLowerCase();
  return extension ? IMAGE_ATTACHMENT_MEDIA_TYPES[extension] ?? null : null;
}

export function isImageAttachmentPath(filePath: string): boolean {
  return getImageAttachmentMediaType(filePath) !== null;
}

export function isHeicAttachment(filePath: string, mimeType?: string | null): boolean {
  return HEIC_MIME_RE.test(mimeType ?? "") || HEIC_EXTENSION_RE.test(filePath);
}

export type AgentChatLinearIssueContextAttachment = {
  type: "linear_issue";
  issue: LaneLinearIssue;
  source?: "manual" | "lane_link";
  attachedAt?: string;
};

export type AgentChatGitHubIssueContextAttachment = {
  type: "github_issue";
  issue: LaneGitHubIssue;
  source?: "manual" | "lane_link";
  attachedAt?: string;
};

/**
 * Ephemeral plan-annotation attachment produced by the orchestration plan
 * panel popover (see `goal.md` §10.7). Lives only in the composer tray; not
 * persisted to the manifest in v1. The payload carries the anchor (what was
 * selected) and the user's free-form comment, so the lead sees what was
 * being commented on when the message is sent.
 */
export type AgentChatOrchestrationAnnotationContextAttachment = {
  type: "orchestration_annotation";
  item: OrchestrationContextItem;
  source?: "manual";
  attachedAt?: string;
};

export type AgentChatContextAttachment =
  | AgentChatLinearIssueContextAttachment
  | AgentChatGitHubIssueContextAttachment
  | AgentChatOrchestrationAnnotationContextAttachment;

/** Max attachments per parallel multi-lane launch (same refs sent to each child session). */
export const PARALLEL_CHAT_MAX_ATTACHMENTS = 12;

/** Infer whether a file path points to an image or a generic file. */
export function inferAttachmentType(
  filePath: string,
  mimeType?: string | null,
): AgentChatLocalFileRef["type"] {
  if (mimeType?.toLowerCase().startsWith("image/")) return "image";
  return isImageAttachmentPath(filePath) ? "image" : "file";
}

/** Merge two attachment lists, deduplicating by path (last-write wins). */
export function mergeAttachments(
  current: AgentChatFileRef[],
  incoming: AgentChatFileRef[],
): AgentChatFileRef[] {
  const deduped = new Map<string, AgentChatFileRef>();
  for (const attachment of current) deduped.set(attachment.path, attachment);
  for (const attachment of incoming) {
    if (!attachment.path.trim().length) continue;
    deduped.set(attachment.path, attachment);
  }
  return [...deduped.values()];
}

export type AgentChatPlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type CodexPlanState = "active" | "delta" | "updated" | "complete";

export type CodexWebSearchAction = {
  type: string;
  status?: "pending" | "running" | "completed" | "failed";
  query?: string;
  queries?: string[];
  url?: string;
  title?: string;
  snippet?: string;
};

export type CodexWebSearchResult = {
  url?: string;
  title?: string;
  snippet?: string;
};

export type AgentChatMcpAppContext = {
  connectorId?: string;
  linkId?: string;
  resourceUri?: string;
  appName?: string;
  templateId?: string;
  actionName?: string;
};

/** Provider-neutral source identity retained from structured MCP tool events. */
export type AgentChatMcpToolSource = {
  server: string;
  tool: string;
  pluginId?: string;
  resourceUri?: string;
  appContext?: AgentChatMcpAppContext;
};

export type CodexSafetyBufferingState = {
  threadId?: string | null;
  turnId?: string | null;
  model?: string | null;
  useCases?: string[];
  reasons?: string[];
  showBufferingUi: boolean;
  fasterModel?: string | null;
};

export type CodexModerationMetadata = {
  threadId?: string | null;
  turnId?: string | null;
  metadata: Record<string, unknown> | null;
};

export type CodexTokenUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Codex `reasoningOutputTokens` (reasoning models) — surfaced in the context-usage tooltip. */
  reasoningTokens?: number;
  totalTokens?: number;
};

export type CodexThreadTokenUsage = {
  threadId?: string | null;
  turnId?: string | null;
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
};

export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "cancelled"
  | "unknown";

export type CodexThreadGoal = {
  objective?: string | null;
  tokenBudget?: number | null;
  status?: CodexThreadGoalStatus;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CodexThreadGoalUpdateKind = "set" | "status" | "sync" | "budget";

export type ClaudeActiveGoal = {
  condition: string;
  iterations: number;
  setAt: number;
  tokensAtStart: number;
  lastReason?: string;
  updatedAt: number;
};

export type AgentChatCompletionArtifact = {
  type: string;
  description: string;
  reference?: string;
};

export type AgentChatCompletionStatus = "completed" | "partial" | "blocked";

export type AgentChatCompletionReport = {
  timestamp: string;
  summary: string;
  status: AgentChatCompletionStatus;
  artifacts: AgentChatCompletionArtifact[];
  blockerDescription?: string | null;
};

export type AgentChatRuntime = "local" | "cloud";

/**
 * The provider value every plugin-owned chat session carries.
 *
 * One value for every plugin, deliberately — see {@link AgentChatProvider}.
 * Which plugin, and which of its declared runtimes, is
 * {@link AgentChatRuntimeRef}.
 */
export const PLUGIN_CHAT_PROVIDER = "plugin";

/**
 * Who owns a chat session's turns, when it is not one of ADE's own runtimes.
 *
 * Every field is HOST-INJECTED. A plugin never states its own `pluginId`: the
 * host reads it from the child connection that asked, and a write aimed at a
 * session whose `runtimeRef.pluginId` is somebody else is refused rather than
 * relabelled. That is the whole security story of the plugin chat seam — a
 * plugin can write into a transcript, so the only question that matters is
 * WHICH transcript, and the plugin does not get to answer it.
 *
 * `externalId` is the plugin's own name for the conversation — a cloud agent
 * id, a thread id, a ticket. ADE stores it, indexes it, and never interprets
 * it.
 */
export type AgentChatRuntimeRef = {
  /** The plugin that owns this session's turns. */
  pluginId: string;
  /** Which of that plugin's declared `chatRuntimes` owns it. */
  runtimeId: string;
  /** The plugin's own identifier for the conversation. Opaque to ADE. */
  externalId: string;
};

/** Longest `externalId` the host stores. A pointer, never a payload. */
export const AGENT_CHAT_RUNTIME_EXTERNAL_ID_MAX = 256;

/**
 * What a client puts on a plugin-owned chat: the runtime's own name, and the
 * icon its manifest declared.
 *
 * Resolved by the host from the manifest and carried on the session, because
 * every client needs it and none of them can read a manifest. `icon` is a
 * Phosphor name, the same vocabulary a plugin's panels and sockets already
 * draw from, so a client that cannot resolve it falls back to the plugin
 * glyph rather than to another provider's logo.
 */
export type AgentChatRuntimeLabel = {
  /** "Cursor Cloud". Shown in the chat header and the session row. */
  displayName: string;
  /** Phosphor icon name from the plugin's manifest, when it declared one. */
  icon?: string;
  /** The owning plugin's own display name, for "from <plugin>" attributions. */
  pluginDisplayName?: string;
};

export function isAgentChatRuntimeRef(value: unknown): value is AgentChatRuntimeRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pluginId === "string" && record.pluginId.length > 0
    && typeof record.runtimeId === "string" && record.runtimeId.length > 0
    && typeof record.externalId === "string"
    && record.externalId.length > 0
    && record.externalId.length <= AGENT_CHAT_RUNTIME_EXTERNAL_ID_MAX;
}

/**
 * True when this session's turns belong to a plugin.
 *
 * Read `runtimeRef`, not `provider`. The provider value is what the clients
 * render; the ref is what decides where a turn goes, and a session that
 * somehow carries one without the other must still route to its owner rather
 * than fall through to an ADE runtime that has no thread for it.
 */
/**
 * What to call the agent on the other end of a chat, on any client.
 *
 * The ONE function every surface should ask, rather than each of them keying a
 * map off `provider`. For ADE's own runtimes it is the provider's name, exactly
 * as before. For a plugin-owned session it is the runtime's own name — "Cursor
 * Cloud", not "Plugin" — because the person opened a conversation with that
 * thing and the word "plugin" tells them nothing about which one.
 *
 * Falls back through the last label the host resolved, then the provider name,
 * then `fallback`, so an uninstalled plugin's old conversations keep reading
 * the way they always did.
 */
export function chatSessionAgentLabel(
  session: {
    provider?: AgentChatProvider;
    runtimeRef?: AgentChatRuntimeRef | null;
    runtimeLabel?: AgentChatRuntimeLabel | null;
  } | null | undefined,
  fallback: string,
): string {
  const declared = session?.runtimeLabel?.displayName?.trim();
  if (declared?.length) return declared;
  return providerDisplayLabel(session?.provider, fallback);
}

/**
 * The icon a client should draw beside {@link chatSessionAgentLabel}.
 *
 * A Phosphor name for a plugin-owned session, or null for everything else —
 * for which the client keeps using the provider logo it already has. Null is
 * also the answer for a plugin that declared no icon, and the client falls
 * back to its generic plugin glyph rather than to another provider's mark.
 */
export function chatSessionAgentIcon(
  session: { runtimeLabel?: AgentChatRuntimeLabel | null } | null | undefined,
): string | null {
  const icon = session?.runtimeLabel?.icon?.trim();
  return icon?.length ? icon : null;
}

export function isPluginOwnedChatSession(
  session: { provider?: AgentChatProvider; runtimeRef?: AgentChatRuntimeRef | null } | null | undefined,
): boolean {
  return isAgentChatRuntimeRef(session?.runtimeRef);
}

export type AgentChatImportProvider = "claude" | "codex";

export type AgentChatImportedFrom = {
  provider: string;
  sessionId: string;
  importedAt: number;
};

export type AgentChatCloudRunStatus =
  | "creating"
  | "running"
  | "finished"
  | "error"
  | "cancelled"
  | "expired";

export type AgentChatScheduledWakeMetadata = {
  scheduleId: string;
  kind: "wakeup" | "cron" | "loop";
  firedAt: string;
  reason?: string;
  late?: boolean;
};

export type AgentChatUnprocessedReplayMetadata = {
  sourceSteerId: string;
  action: "run_next";
  replacementMessageId: string;
};

export type AgentChatUnprocessedMessageResolutionMetadata = {
  action: "run_next" | "dismiss";
  state: "completed";
  resolvedAt: string;
  replacementMessageId?: string;
};

export type AgentChatEventMetadata = Record<string, unknown> & {
  /** Marks a synthetic unattended turn started by ADE's durable scheduler. */
  scheduledWake?: AgentChatScheduledWakeMetadata;
  /** Rides a `subagent` completion delivery so the renderer can render its
   * typed completion divider whether it steers an active turn or wakes an idle chat. */
  spawnCompletion?: AgentChatSpawnCompletion;
  /** Marks a child turn as parent-dispatched so completion may wake the parent. */
  spawnDispatch?: AgentChatSpawnDispatchMetadata;
  /** Marks a message another bound agent (a grandchild reporting in, a sibling,
   * or the session itself) sent to this chat. Coordination, not a new mission. */
  agentRelay?: AgentChatAgentRelayMetadata;
  /** Marks a host-authored prompt that continues or repairs the chat's own work
   * rather than assigning new work, so it never reassigns ownership of a
   * spawned child's current mission. */
  hostContinuation?: AgentChatHostContinuationMetadata;
  /** Provenance on the replacement message created by Run next. */
  replayedFromUnprocessedSteer?: AgentChatUnprocessedReplayMetadata;
  /** Renderer-folded terminal state for the original unprocessed bubble. */
  unprocessedMessageResolution?: AgentChatUnprocessedMessageResolutionMetadata;
};

export type AgentChatScheduledWorkKind =
  | "wakeup"
  | "cron"
  | "loop"
  | "remote_trigger"
  | "background_task";

export type AgentChatScheduledWorkStatus =
  | "scheduled"
  | "paused"
  | "running"
  | "fired"
  | "missed"
  | "completed"
  | "cancelled"
  | "failed"
  | "stopped";

export type AgentChatScheduledWorkOrigin =
  | "schedule_wakeup"
  | "cron"
  | "loop"
  | "action"
  | "remote_trigger"
  | "background_task"
  | "sdk";

export type AgentChatEvent =
  | {
      type: "user_message";
      text: string;
      displayText?: string;
      metadata?: AgentChatEventMetadata | null | undefined;
      messageId?: string;
      attachments?: AgentChatFileRef[];
      contextAttachments?: AgentChatContextAttachment[];
      turnId?: string;
      steerId?: string;
      /**
       * Durable user-message lifecycle. `delivered` and `inline` remain
       * accepted legacy values for older transcripts and clients.
       */
      deliveryState?: "queued" | "accepted" | "processed" | "unprocessed" | "delivered" | "inline" | "failed";
      processed?: boolean;
      runtime?: AgentChatRuntime;
    }
  | {
      /**
       * Durable resolution for a terminal accepted-but-unprocessed steer.
       * Keeping this separate from the replacement user message makes
       * Run next and Dismiss idempotent across retries, app restarts, and
       * different ADE surfaces.
       */
      type: "user_message_resolution";
      steerId: string;
      action: "run_next" | "dismiss";
      state: "completed";
      resolvedAt: string;
      replacementMessageId?: string;
      turnId?: string;
    }
  | {
      type: "text";
      text: string;
      messageId?: string;
      /** Provider-origin timestamp. Display-only; transcript ordering remains envelope-based. */
      originTimestamp?: string;
      turnId?: string;
      itemId?: string;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      mcp?: AgentChatMcpToolSource;
      itemId: string;
      logicalItemId?: string;
      parentItemId?: string;
      turnId?: string;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "tool_result";
      tool: string;
      result: unknown;
      mcp?: AgentChatMcpToolSource;
      resultOriginalBytes?: number;
      resultOmittedBytes?: number;
      itemId: string;
      logicalItemId?: string;
      parentItemId?: string;
      turnId?: string;
      status?: "running" | "completed" | "failed" | "interrupted";
      structured?: unknown;
      toolResultMeta?: unknown;
      timedOutAfterMs?: number;
      backgroundCwdHint?: string;
      grepTotals?: {
        files?: number;
        lines?: number;
      };
      runtime?: AgentChatRuntime;
    }
  | {
      type: "file_change";
      path: string;
      diff: string;
      diffOriginalBytes?: number;
      diffOmittedBytes?: number;
      kind: "create" | "modify" | "delete";
      itemId: string;
      logicalItemId?: string;
      turnId?: string;
      status?: "running" | "completed" | "failed";
    }
  | {
      type: "command";
      command: string;
      cwd: string;
      output: string;
      outputOriginalBytes?: number;
      outputOmittedBytes?: number;
      itemId: string;
      logicalItemId?: string;
      turnId?: string;
      exitCode?: number | null;
      durationMs?: number | null;
      status: "running" | "completed" | "failed";
      /** Codex `!` / `/shell` runs unsandboxed via `thread/shellCommand`. */
      source?: "userShell";
      runtime?: AgentChatRuntime;
    }
  | {
      type: "plan";
      steps: AgentChatPlanStep[];
      turnId?: string;
      explanation?: string | null;
      itemId?: string;
      state?: CodexPlanState;
      streamingText?: string;
    }
  | {
      type: "reasoning";
      text: string;
      textOriginalBytes?: number;
      textOmittedBytes?: number;
      turnId?: string;
      itemId?: string;
      summaryIndex?: number;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "approval_request";
      itemId: string;
      logicalItemId?: string;
      kind: "command" | "file_change" | "tool_call";
      description: string;
      turnId?: string;
      detail?: unknown;
      /**
       * What is actually being asked, when this event carries a
       * `PendingInputRequest`.
       *
       * `kind` above describes the *shape* of the thing being confirmed and has
       * no word for "the agent asked you a question" — so Claude's
       * AskUserQuestion rode this event as a `tool_call` approval, and every
       * downstream surface (push, the notch, the lock screen) offered
       * "Approve/Deny" for something that wants prose. The answer branches were
       * unreachable code.
       *
       * Optional and additive: an event without it is an approval, which is
       * exactly what every build before this one meant by sending one.
       */
      requestKind?: PendingInputKind;
    }
  | {
      type: "pending_input_resolved";
      itemId: string;
      resolution: "accepted" | "declined" | "cancelled";
      /**
       * What the user actually sent, so the transcript receipt can read it back
       * after a reload instead of showing a bare "answered".
       *
       * Sanitized by `sanitizeAnswersForTranscript` before it is written: an
       * `isSecret` question contributes no key at all (this event is durable
       * and replicates to every paired device), and the payload is capped so a
       * pasted essay cannot become an oversized synced event.
       */
      answers?: Record<string, string | string[]>;
      turnId?: string;
    }
  | {
      type: "status";
      turnStatus: "started" | "completed" | "interrupted" | "failed";
      turnId?: string;
      message?: string;
    }
  | {
      type: "delegation_state";
      contract: DelegationContract;
      message?: string;
      turnId?: string;
    }
  | {
      type: "error";
      message: string;
      detail?: string;
      turnId?: string;
      itemId?: string;
      errorInfo?: string | {
        category: "auth" | "rate_limit" | "budget" | "network" | "busy" | "unknown" | "agent_cli_missing" | "agent_cli_auth";
        code?: AdeRecoveryErrorCode;
        provider?: string;
        model?: string;
        resumeFailure?: {
          kind: AgentChatResumeFailureKind;
          rolloutFileFound: boolean | null;
          detail: string;
        };
        agentCli?: {
          agent: string;
          displayName: string;
          category: "missing" | "unauthenticated";
          installCommand: string;
          authCommand: string;
        };
      };
      runtime?: AgentChatRuntime;
    }
  | {
      type: "done";
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      model?: string;
      modelId?: ModelId;
      /** Canonical model used for provider billing/pricing resolution. */
      canonicalModel?: string;
      /** API route that served the model (firstParty, bedrock, vertex, etc.). */
      modelProvider?: string;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
        cacheReadTokens?: number | null;
        cacheCreationTokens?: number | null;
        /** Reasoning/thinking output tokens (Codex/Droid/OpenCode/Claude). */
        reasoningTokens?: number | null;
        /** Effective context window for the model that produced this turn, when the runtime reports one. */
        contextWindow?: number | null;
      };
      costUsd?: number | null;
      /** HTTP status attached to an SDK terminal API error (notably 429/529). */
      apiErrorStatus?: number | null;
      /** Why fast mode was disabled for this result, when reported by Claude. */
      fastModeDisabledReason?: string;
      /** Provider UUID of the user message this result acknowledges. */
      userMessageUuid?: string;
      /** Wall-clock timestamp at which the provider request was sent. */
      requestSentWallMs?: number;
      // Set only at render time when multiple done events from one cancellation
      // (parent + subagents) are consolidated into a single row.
      subagentStoppedCount?: number;
      terminalReason?: string;
      terminalReasonSource?: "sdk";
      runtime?: AgentChatRuntime;
    }
  | {
      type: "activity";
      activity: "thinking" | "working" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling" | "web_searching" | "spawning_agent";
      detail?: string;
      turnId?: string;
      runtime?: AgentChatRuntime;
    }
  | {
      type: "tokens";
      turnId: string;
      itemId?: string;
      runtime?: AgentChatRuntime;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      contextWindow?: number;
    }
  /**
   * Generic ADE-emitted chat card. One wire contract, three renderers
   * (desktop / TUI / iOS); `variant` selects the rich rendering and every
   * surface degrades to `fallbackText` + deeplink for a variant it does not
   * know. `cardId` is identity — a repeat emit MERGES into the row already in
   * the transcript rather than appending a duplicate, so a card can track a
   * long-running thing (CI, a build, an artifact pull) in one chronological
   * row. See `../adeCard.ts` for the payload and its helpers.
   */
  | ({ type: "ade_card" } & AdeCardPayload)
  | {
      type: "cloud_artifact";
      turnId: string;
      itemId: string;
      agentId: string;
      runId: string;
      path: string;
      lanePath: string;
      mimeType?: string | null;
      sizeBytes?: number;
    }
  | {
      type: "cloud_status";
      turnId: string;
      runId: string;
      status: AgentChatCloudRunStatus;
      detail?: string | null;
      gitBranch?: string | null;
      prUrl?: string | null;
    }
  | {
      type: "step_boundary";
      stepNumber: number;
      turnId?: string;
    }
  | {
      type: "todo_update";
      items: Array<{
        id: string;
        description: string;
        status: "pending" | "in_progress" | "completed";
      }>;
      turnId?: string;
    }
  | {
      type: "subagent_started";
      taskId: string;
      agentId?: string;
      /** Claude SDK parent session that owns this native child transcript. */
      providerSessionId?: string;
      parentAgentId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      parentToolUseId?: string | null;
      description: string;
      background?: boolean;
      taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
      spawnKind?: AgentChatSpawnKind;
      workflowName?: string;
      turnId?: string;
    }
  | {
      type: "subagent_progress";
      taskId: string;
      agentId?: string;
      parentAgentId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      parentToolUseId?: string | null;
      description?: string;
      summary: string;
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
        /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
        costUsd?: number;
      };
      lastToolName?: string;
      taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
      workflowName?: string;
      turnId?: string;
    }
  | {
      type: "subagent_result";
      taskId: string;
      agentId?: string;
      parentAgentId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      parentToolUseId?: string | null;
      status: "completed" | "failed" | "stopped";
      summary: string;
      finalSummary?: string;
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
        /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
        costUsd?: number;
      };
      taskType?: "subagent" | "background" | "local_workflow" | "cron" | "other";
      workflowName?: string;
      worktreePath?: string;
      worktreeBranch?: string;
      totalTokens?: number;
      toolUseCount?: number;
      turnId?: string;
    }
  | {
      type: "subagent.started";
      agentId: string;
      parentToolUseId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      description?: string;
      background?: boolean;
      turnId?: string;
    }
  | {
      type: "subagent.progress";
      agentId: string;
      parentToolUseId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      text?: string;
      tokens?: number;
      lastToolName?: string;
      turnId?: string;
    }
  | {
      type: "subagent.completed";
      agentId: string;
      parentToolUseId?: string | null;
      agentType?: string;
      model?: string | null;
      reasoningEffort?: string | null;
      label?: string | null;
      summary: string;
      status?: "completed" | "failed" | "stopped";
      usage?: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
      };
      turnId?: string;
    }
  // ── Droid AGI mission events (orchestrator mode) ──────────────────────────
  // Emitted only when a Droid session runs in AGI/orchestrator mode. They drive
  // the Missions tab; non-AGI runtimes never emit them.
  | {
      type: "mission_state";
      state: AgentChatMissionState;
      turnId?: string;
    }
  | {
      type: "mission_features";
      /** The full current feature checklist (replaces, not appends). */
      features: AgentChatMissionFeature[];
      turnId?: string;
    }
  | {
      type: "mission_progress";
      /** The full current progress log (replaces, not appends). */
      entries: AgentChatMissionProgressEntry[];
      turnId?: string;
    }
  | {
      type: "structured_question";
      question: string;
      options?: Array<{ label: string; value: string }>;
      itemId: string;
      turnId?: string;
    }
  | {
      type: "tool_use_summary";
      summary: string;
      toolUseIds: string[];
      turnId?: string;
    }
  | {
      type: "scheduled_work_update";
      id: string;
      kind: AgentChatScheduledWorkKind;
      status: AgentChatScheduledWorkStatus;
      origin?: AgentChatScheduledWorkOrigin;
      title?: string;
      summary?: string;
      prompt?: string;
      reason?: string;
      cron?: string;
      nextRunAt?: string;
      lastRunAt?: string;
      firedAt?: string;
      late?: boolean;
      recurring?: boolean;
      durable?: boolean;
      sourceToolUseId?: string;
      sourceTaskId?: string;
      turnId?: string;
      error?: string;
    }
  | {
      type: "transcript_retraction";
      messageIds: string[];
      reason?: "model_refusal_fallback" | "assistant_supersedes" | "provider";
      replacementMessageId?: string;
      turnId?: string;
    }
  | {
      type: "context_compact";
      trigger: "manual" | "auto" | "ade_fallback";
      preTokens?: number;
      postTokens?: number;
      tokensRemoved?: number;
      durationMs?: number;
      provider?: "claude" | "codex" | "opencode" | "cursor" | "droid" | "pi";
      /** Stable merge key for started→completed pairs that may land on different turns. */
      compactionId?: string;
      /** After the second compaction in a session, surfaces as "(N× this session)" in the pill. */
      sessionCompactionCount?: number;
      // Lifecycle of the compaction. Runtimes that expose a begin signal (Claude's
      // `compacting` status, OpenCode's compaction part) emit a "started" event when
      // compaction begins and a "completed" event when it ends, so the UI can show a
      // live "compacting…" indicator instead of only the finished result. Omitted by
      // legacy/completion-only sources (treated as "completed"). "failed" covers
      // interrupt, teardown, and a wall-clock stall so the divider cannot spin forever.
      state?: "started" | "completed" | "failed";
      failReason?: "interrupted" | "timed_out" | "teardown";
      turnId?: string;
    }
  | {
      type: "codex_context_compaction";
      turnId: string;
      state: "started" | "completed" | "failed";
      trigger: "manual" | "auto";
      compactionId?: string;
      failReason?: "interrupted" | "timed_out" | "teardown";
    }
  | {
      type: "codex_safety_buffering";
      state: CodexSafetyBufferingState;
      turnId?: string;
    }
  | {
      type: "codex_moderation_metadata";
      metadata: CodexModerationMetadata;
      turnId?: string;
    }
  | {
      type: "turn_diagnostics";
      turnId?: string;
      moderationChecks?: number;
      optionalIntegrationFailures?: Array<{
        integration: string;
        message?: string | null;
      }>;
    }
  | {
      type: "codex_sleep";
      itemId: string;
      turnId?: string;
      durationMs?: number | null;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "context_usage";
      usage: AgentChatContextUsage;
      origin?: "command" | "live" | "compact" | "snapshot";
      state?: AgentChatContextUsageState;
      /** Monotonic within one Claude runtime; rejects stale async snapshots. */
      sampleId?: number;
      capturedAt?: string;
      turnId?: string;
    }
  | {
      type: "conversation_reset";
      newConversationId: string;
      turnId?: string;
    }
  | {
      type: "interrupt_receipt";
      stillQueuedUuids: string[];
      cancelledUuids?: string[];
      stopMode?: AgentChatStopMode;
      recoveryId?: string;
      known: Array<{ uuid: string; preview: string; steerId?: string }>;
      turnId?: string;
    }
  | {
      type: "queue_recovery";
      recoveryId: string;
      state: "available" | "restored" | "expired";
      messageCount: number;
      expiresAt: string;
      stopMode: AgentChatStopMode;
      restoredSteers?: Array<{
        steerId: string;
        text: string;
        attachments?: AgentChatFileRef[];
        contextAttachments?: AgentChatContextAttachment[];
      }>;
      turnId?: string;
    }
  | {
      type: "command_lifecycle";
      commandUuid: string;
      status: "queued" | "started" | "completed" | "cancelled" | "discarded";
      preview?: string;
      steerId?: string;
      turnId?: string;
    }
  | {
      type: "claude_goal_updated";
      goal: ClaudeActiveGoal;
      turnId?: string;
    }
  | {
      type: "claude_goal_cleared";
      turnId?: string;
    }
  | {
      type: "api_retry";
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      turnId?: string;
    }
  | {
      type: "system_notice";
      noticeKind: "auth" | "rate_limit" | "hook" | "file_persist" | "info" | "provider_health" | "thread_error" | "warning" | "error" | "config";
      severity?: "info" | "warning" | "error";
      status?: string;
      message: string;
      detail?: string | AgentChatNoticeDetail;
      steerId?: string;
      turnId?: string;
    }
  | {
      type: "completion_report";
      report: AgentChatCompletionReport;
      turnId?: string;
    }
  | {
      type: "web_search";
      query: string;
      action?: string;
      actions?: CodexWebSearchAction[];
      results?: CodexWebSearchResult[];
      resultsTotal?: number;
      itemId: string;
      logicalItemId?: string;
      turnId?: string;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "auto_approval_review";
      targetItemId: string;
      reviewStatus: "started" | "completed";
      action?: string;
      review?: string;
      turnId?: string;
    }
  | {
      type: "prompt_suggestion";
      suggestion: string;
      turnId?: string;
    }
  | {
      type: "codex_image_generation";
      itemId: string;
      turnId?: string;
      prompt?: string | null;
      revisedPrompt?: string | null;
      result?: string | null;
      /** Local filesystem path if Codex saved the image to disk; null when the result is purely a URL/data URI. */
      savedPath?: string | null;
      /** Metadata when a large inline data URI was omitted from durable history or mobile sync. */
      resultOriginalBytes?: number;
      resultOmittedBytes?: number;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "codex_image_view";
      itemId: string;
      turnId?: string;
      path?: string | null;
      url?: string | null;
      title?: string | null;
      /** Metadata when a large inline data URI was omitted from durable history or mobile sync. */
      urlOriginalBytes?: number;
      urlOmittedBytes?: number;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "codex_token_usage";
      usage: CodexThreadTokenUsage;
      turnId?: string;
    }
  | {
      type: "codex_turn_stalled";
      turnId: string;
      threadId?: string;
      reason: "no_output" | "no_progress" | "waiting_on_input" | "waiting_on_approval" | "app_server_state_unknown";
      message: string;
      recoveryOptions?: Array<"wait" | "steer" | "interrupt_retry_same_thread" | "restart_resume_thread">;
      sourceSessionId?: string;
      parentSessionId?: string;
      detectedAt?: string;
      turnStartedAt?: string;
      lastProgressAt?: string;
      automaticRecoveryAttempted?: boolean;
    }
  | {
      /**
       * Provider-neutral turn-health contract. Codex-specific events remain
       * readable for backwards compatibility, while new surfaces should prefer
       * this event when both are present.
       */
      type: "turn_health";
      provider: string;
      turnId: string;
      state: "stalled";
      reason: "no_output" | "no_progress" | "waiting_on_input" | "waiting_on_approval" | "runtime_state_unknown";
      message: string;
      turnStartedAt: string;
      lastProgressAt: string;
      detectedAt: string;
      recoveryCount: number;
      supportedActions: AgentChatTurnRecoveryAction[];
      automaticRecoveryAttempted: boolean;
      /** Owning child chat when this health event is mirrored into a parent. */
      sourceSessionId?: string;
    }
  | {
      type: "codex_turn_recovery";
      turnId: string;
      action: "restart_resume_thread";
      state: "recovering" | "recovered" | "failed";
      message: string;
      automatic: boolean;
      at: string;
    }
  | {
      type: "turn_recovery";
      provider: string;
      turnId: string;
      action: AgentChatTurnRecoveryAction;
      state: "recovering" | "recovered" | "failed";
      message: string;
      automatic: boolean;
      at: string;
      recoveryCount: number;
    }
  | {
      type: "codex_thread_deleted";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "codex_goal_updated";
      goal: CodexThreadGoal | null;
      updateKind?: CodexThreadGoalUpdateKind;
      turnId?: string;
    }
  | {
      type: "codex_goal_cleared";
      turnId?: string;
    }
  | {
      type: "turn_diff_summary";
      turnId: string;
      beforeSha: string;
      afterSha: string;
      files: TurnDiffFile[];
      totalAdditions: number;
      totalDeletions: number;
    }
  | {
      /**
       * Transient push event signalling a change to a chat session's
       * summary-level metadata (title, manuallyNamed). Not persisted to
       * the transcript — purely a renderer-state patch so the chat header
       * can refresh without a full session list re-fetch.
       */
      type: "session_meta_updated";
      title?: string;
      manuallyNamed?: boolean;
      claudeTag?: string | null;
      /** Signals that persisted envelope history changed and open views must refetch. */
      historyInvalidated?: boolean;
      // Permission/interaction mode fields — emitted when a client (e.g. iOS)
      // changes the mode via updateSession so other renderers patch their
      // composer state without waiting for a turn-lifecycle event. All optional
      // and backward-compatible; a title-only emit carries none of them.
      permissionMode?: AgentChatPermissionMode;
      interactionMode?: AgentChatInteractionMode | null;
      claudePermissionMode?: AgentChatClaudePermissionMode;
      codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
      codexSandbox?: AgentChatCodexSandbox;
      codexConfigSource?: AgentChatCodexConfigSource;
      opencodePermissionMode?: AgentChatOpenCodePermissionMode;
      droidPermissionMode?: AgentChatDroidPermissionMode;
      cursorModeId?: string | null;
      cursorModeSnapshot?: AgentChatCursorModeSnapshot;
      cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
      spawnKind?: AgentChatSpawnKind;
      subagentTakeoverPromptShownAt?: string | null;
      // Accept turnId for uniformity with other variants — ignored by handlers.
      turnId?: string;
    };

export type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
  provenance?: {
    messageId?: string;
    providerMessageId?: string;
    providerParentAgentId?: string | null;
    providerOrigin?: string | null;
    providerSupersedes?: string[];
    providerRetractedMessageIds?: string[];
    threadId?: string | null;
    role?: "user" | "orchestrator" | "worker" | "agent" | null;
    targetKind?: string | null;
    sourceSessionId?: string | null;
    attemptId?: string | null;
    stepKey?: string | null;
    laneId?: string | null;
    runId?: string | null;
  };
};

export type AgentChatEventHistorySnapshot = {
  sessionId: string;
  events: AgentChatEventEnvelope[];
  /**
   * True when any history was omitted from this snapshot, either because the
   * transcript tail was bounded or because maxEvents windowed the result.
   */
  truncated: boolean;
  transcriptTruncated?: boolean;
  windowTruncated?: boolean;
  /**
   * Authoritative answer to "is there older history to page back to?".
   * Derived from the transcript tail read and the merge window rather than
   * from cursor bookkeeping, so it stays correct when the snapshot was served
   * from the in-memory ring buffer. Clients must gate any "load earlier
   * messages" affordance on this instead of on `tailStartOffset > 0`, which
   * can hold a conservative end-of-file cursor. Optional for compatibility
   * with older desktop/runtime pairs.
   */
  hasOlderHistory?: boolean;
  /**
   * Explicitly false means the session id did not resolve in this project
   * runtime. Optional for compatibility with older desktop/runtime pairs.
   */
  sessionFound?: boolean;
  /**
   * True when the bound runtime could not be reached, so no history could be
   * read. This is NOT an authoritative "session does not exist" answer —
   * clients must not clear or tombstone the chat on it.
   */
  unavailable?: boolean;
  /**
   * Byte offset in the transcript file where the hydrated tail window began.
   * Pass it as `beforeOffset` to `getChatEventHistoryPage` to page older
   * history. Null/undefined when the session had no transcript file or the
   * transcript was not truncated at the file level (nothing older on disk).
   */
  tailStartOffset?: number | null;
};

export type AgentChatEventHistoryPage = {
  sessionId: string;
  events: AgentChatEventEnvelope[];
  /** Byte offset in the transcript where this page begins. Pass as the next request's beforeOffset. 0 = head reached. */
  startOffset: number;
  hasMore: boolean;
  sessionFound: boolean;
  /**
   * True when the bound runtime could not be reached, so no page could be
   * read. This is NOT an authoritative "session does not exist" answer —
   * clients must not clear or tombstone the chat on it.
   */
  unavailable?: boolean;
};

export type AgentChatPermissionMode = "default" | "auto" | "plan" | "edit" | "full-auto" | "config-toml";
export type AgentChatExecutionMode = "focused" | "parallel" | "subagents" | "teams";
export type AgentChatInteractionMode =
  | "default"
  | "plan"
  | "orchestrator-lead"
  | "orchestrator-worker"
  | "orchestrator-validator";
/**
 * Optional fields persisted on chat sessions/summaries when the session is part
 * of an orchestration run. All fields are optional for migration tolerance —
 * older sessions deserialise cleanly with these absent.
 */
export type OrchestrationSessionFields = {
  orchestrationRunId?: string;
  orchestrationRole?: OrchestrationRole;
  orchestrationParentSessionId?: string;
  spawnKind?: AgentChatSpawnKind;
  /**
   * When the takeover banner was dismissed or Take over was chosen. Brain-side
   * so desktop, iOS, and ADE Code do not re-show it. Absent means not shown yet.
   */
  subagentTakeoverPromptShownAt?: string | null;
  /**
   * False when the parent chat is gone or not a chat session. Renderers hide
   * the takeover banner instead of resurrecting it against a dead parent.
   */
  orchestrationParentReachable?: boolean;
  orchestrationTag?: string;
  orchestrationStepId?: string;
  orchestrationBundlePath?: string;
};
export type AgentChatIdentityKey = "cto";
export type AgentChatSurface = "work" | "automation" | "personal";
export type AgentChatCursorConfigValue = string | boolean | number;
export type AgentChatCursorConfigSelectOption = {
  value: string;
  label: string;
  description?: string | null;
  groupId?: string | null;
  groupLabel?: string | null;
};
export type AgentChatCursorConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean";
  currentValue: AgentChatCursorConfigValue | null;
  options?: AgentChatCursorConfigSelectOption[];
};
export type AgentChatCursorModeSnapshot = {
  modeConfigId?: string | null;
  currentModeId: string | null;
  availableModeIds: string[];
  modelConfigId?: string | null;
  currentModelId?: string | null;
  availableModelIds?: string[];
  configOptions?: AgentChatCursorConfigOption[];
};
export type PendingInputSource = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi" | "ade";
export type PendingInputKind = "approval" | "question" | "structured_question" | "permissions" | "plan_approval" | "model_selection";

export type PendingInputOption = {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
  previewFormat?: "markdown" | "html";
  /**
   * The approval decision this option stands for, on an `approval` card.
   *
   * An approval card renders its own buttons rather than a radio list, so it
   * cannot show a caller's options unless it knows what each one answers. When
   * every option of the first question carries this, the card renders those
   * options as its buttons — the caller's words, not "Accept"/"Decline". Absent,
   * the card keeps its generic buttons, so a caller that does not set it is
   * unaffected.
   */
  decision?: AgentChatApprovalDecision;
};

export type PendingInputQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: PendingInputOption[] | null;
  multiSelect?: boolean;
  allowsFreeform?: boolean;
  isSecret?: boolean;
  defaultAssumption?: string | null;
  impact?: string | null;
};

/**
 * Who is really asking, when the `source` alone cannot say.
 *
 * `PendingInputSource` is a closed union of runtimes plus `"ade"`, so every card
 * the host raises on its own authority — a plugin install, a removal, an
 * enable — arrives as `"ade"` and draws ADE's own mark above the word "ADE".
 * For a plugin gate that is wrong in the one place it matters most: the reader
 * is being asked to run somebody's code, and the card names the host rather
 * than the thing being installed. Three rounds of user reports said so.
 *
 * So the asker's identity travels beside the source rather than inside it. The
 * union stays closed (nothing here can invent a new runtime), the fallback stays
 * exactly what it was for every caller that sets nothing, and a card that DOES
 * carry an origin draws that plugin's own icon and name.
 *
 * The fields are the ones {@link https://../../renderer/components/plugins/pluginIcons.tsx pluginIdentity}
 * takes, so the card resolves the same picture the Marketplace does — a Phosphor
 * token, a `brand:*` vendor mark, or the derived glyph-and-colour a plugin that
 * named no icon gets. Nothing here is agent-supplied: the host fills it from the
 * manifest it parsed for the disclosure.
 */
export type PendingInputOrigin = {
  kind: "plugin";
  pluginId: string;
  displayName: string;
  /** Manifest icon token — a Phosphor name or a `brand:*` vendor mark. */
  icon?: string | null;
  /** Manifest accent hex, when it declared one. */
  accent?: string | null;
};

export type PendingInputRequest = {
  requestId: string;
  itemId?: string;
  source: PendingInputSource;
  kind: PendingInputKind;
  title?: string | null;
  description?: string | null;
  questions: PendingInputQuestion[];
  allowsFreeform: boolean;
  blocking: boolean;
  canProceedWithoutAnswer: boolean;
  options?: PendingInputOption[];
  providerMetadata?: Record<string, unknown>;
  autoResolutionMs?: number | null;
  turnId?: string | null;
  /**
   * The plugin this card is really about, when the host raised it for one.
   * Optional and additive: absent means the card identifies itself by `source`,
   * which is what every runtime gate does. See {@link PendingInputOrigin}.
   */
  origin?: PendingInputOrigin;
};

export type AgentChatSession = {
  id: string;
  laneId: string;
  provider: AgentChatProvider;
  /** Runtime-facing model token (CLI shortId or direct API model id), persisted as a plain string for compatibility. */
  model: string;
  modelId?: ModelId;
  sessionProfile?: AgentChatSessionProfile;
  goal?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** Effective service tier reported by the Codex app-server, when known. */
  codexServiceTier?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  /**
   * Access mode in force before the session entered plan mode, so leaving
   * plan mode restores it.
   *
   * Entering plan mode sets `claudePermissionMode` to `"plan"`, which is not
   * an access mode — `normalizeClaudeAccessMode` strips it. Without this
   * stash, exiting plan mode would resolve through the fallback and silently
   * demote a full-auto session to `default`.
   */
  claudePrePlanAccessMode?: Exclude<AgentChatClaudePermissionMode, "plan"> | null;
  claudeOutputStyle?: string | null;
  claudeBackgroundJobShort?: string | null;
  claudeBackgroundResumeSessionId?: string | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  piProfileId?: string | null;
  piProviderId?: string | null;
  piModelId?: string | null;
  /** Native Pi JSONL session pointer used for SDK resume and CLI handoff. */
  piSessionId?: string | null;
  piSessionFile?: string | null;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue>;
  /**
   * MCP servers injected by an external embedder at chat creation. Persisted so
   * a resumed chat rebuilds the same tool surface it started with — an SDK
   * caller that reconnects to an existing chat does not resend them.
   */
  mcpServers?: Record<string, AgentChatMcpServerConfig>;
  /**
   * Set only when the caller stated a preference: `true` withholds the user's
   * own MCP config, `false` asks for it even on a lightweight session that
   * would otherwise be strict. Absent means the session profile decides.
   */
  strictMcpConfig?: boolean;
  /**
   * What this chat's provider could actually do with the caller's MCP request.
   * Present only when a caller asked for injected servers or strict mode, so an
   * embedder learns "Pi ignored your servers" instead of assuming they landed.
   */
  mcpCapability?: AgentChatMcpCapability;
  /** Durable Cursor Cloud agent id once this session has been promoted to cloud. */
  cursorCloudAgentId?: string;
  /** Default runtime for new turns in this session (set on promotion). */
  cursorRuntime?: AgentChatRuntime;
  /** Turn id at which the session was first promoted to cloud (renders the system bubble). */
  cursorPromotedTurnId?: string;
  /**
   * Set when a plugin owns this session's turns. See {@link AgentChatRuntimeRef}.
   * Present implies `provider === "plugin"`.
   */
  runtimeRef?: AgentChatRuntimeRef;
  /** How the owning plugin's runtime is named and drawn. See {@link AgentChatRuntimeLabel}. */
  runtimeLabel?: AgentChatRuntimeLabel;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  completion?: AgentChatCompletionReport | null;
  codexGoal?: CodexThreadGoal | null;
  claudeGoal?: ClaudeActiveGoal | null;
  codexTokenUsage?: CodexThreadTokenUsage | null;
  protocolCapabilities?: string[];
  runtimeMode?: AgentChatRuntimeMode;
  status: AgentChatSessionStatus;
  /** Start of the currently active provider turn; live-only and cleared when idle. */
  currentTurnStartedAt?: string | null;
  idleSinceAt?: string | null;
  archivedAt?: string | null;
  threadId?: string;
  continuityRecovery?: AgentChatContinuityRecovery;
  recoveredFromSessionId?: string;
  importedFrom?: AgentChatImportedFrom;
  /** Subdirectory or absolute path under the lane worktree used as cwd; persisted for relaunch/resume. */
  requestedCwd?: string | null;
  createdAt: string;
  lastActivityAt: string;
} & OrchestrationSessionFields;

export type AgentChatSessionSummary = {
  sessionId: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  sessionProfile?: AgentChatSessionProfile;
  title?: string | null;
  goal?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** Effective service tier reported by the Codex app-server, when known. */
  codexServiceTier?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  claudeOutputStyle?: string | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  piProfileId?: string | null;
  piProviderId?: string | null;
  piModelId?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
  /** Caller-injected MCP servers, echoed back so an embedder can confirm them. */
  mcpServers?: Record<string, AgentChatMcpServerConfig>;
  strictMcpConfig?: boolean;
  /** What the provider could actually honor. Absent when no MCP was requested. */
  mcpCapability?: AgentChatMcpCapability;
  cursorCloudAgentId?: string;
  cursorRuntime?: AgentChatRuntime;
  cursorPromotedTurnId?: string;
  /**
   * The plugin that owns this session's turns, mirrored onto the summary so a
   * client can label and route a chat without opening it. See
   * {@link AgentChatRuntimeRef}.
   */
  runtimeRef?: AgentChatRuntimeRef;
  /**
   * How the owning plugin's runtime wants to be named and drawn, resolved by
   * the host from the plugin's manifest at projection time.
   *
   * Denormalized on purpose: every client needs a label for a chat it is
   * listing, and none of them can read another machine's plugin manifests. A
   * session whose plugin has since been uninstalled keeps the last label the
   * host resolved rather than rendering as an unnamed provider.
   */
  runtimeLabel?: AgentChatRuntimeLabel;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  completion?: AgentChatCompletionReport | null;
  codexGoal?: CodexThreadGoal | null;
  claudeGoal?: ClaudeActiveGoal | null;
  codexTokenUsage?: CodexThreadTokenUsage | null;
  protocolCapabilities?: string[];
  status: AgentChatSessionStatus;
  /** Start of the currently active provider turn; null when no turn is running. */
  currentTurnStartedAt?: string | null;
  idleSinceAt?: string | null;
  startedAt: string;
  endedAt: string | null;
  archivedAt?: string | null;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  /** First tag mirrored from the backing Claude SDK session pointer. */
  claudeTag?: string | null;
  awaitingInput?: boolean;
  pendingInputItemId?: string | null;
  /** Earliest armed, unpaused schedule for this chat. */
  nextWakeAt: string | null;
  /**
   * A Claude `--bg` job this session started, when one is still recorded.
   *
   * A RECORD, not a liveness signal: it survives the job finishing and survives
   * teardown stopping it, so a reader that needs liveness has to ask the daemon.
   * Distinct from `activeBackgroundTaskCount` below, which is derived from the
   * LIVE managed runtime and therefore reads zero after a restart even while
   * the daemon job is still running — which is why settle teardown consults
   * both.
   */
  claudeBackgroundJobShort?: string | null;
  /** Authoritative provider-reported background tasks still running after the foreground turn. */
  activeBackgroundTaskCount?: number;
  /** The same live work split into working vs monitoring (`classifyBackgroundWorkKind`). */
  backgroundWork?: SessionBackgroundWork;
  /**
   * ISO instant this session's live background work began — the anchor for the
   * "Background work ×N 2h" elapsed. Omitted when the runtime cannot say
   * (nothing live, or a provider that does not track a background level), in
   * which case surfaces fall back to `lastActivityAt` as before.
   */
  backgroundWorkSince?: string | null;
  /**
   * Agent SDK processes this chat currently owns, as tracked by the subprocess
   * reaper. In-memory and host-local: empty after a restart, and never a
   * liveness claim about work that escaped ADE's process tree.
   *
   * Exists so "this chat is holding a warm agent process open" is answerable
   * from `ade session show` and the diagnostics surfaces instead of only from
   * `ps`. One entry per SDK process; each owns MCP children of its own.
   */
  runtimeProcesses?: RuntimeProcessSummary[];
  /** True when this chat's durable schedules are paused. */
  scheduledWorkPaused?: boolean;
  /** KV-backed durable schedules. This is the management source of truth. */
  scheduledWork?: AgentChatScheduledWorkItem[];
  threadId?: string;
  continuityRecovery?: AgentChatContinuityRecovery;
  recoveredFromSessionId?: string;
  importedFrom?: AgentChatImportedFrom;
  requestedCwd?: string | null;
} & OrchestrationSessionFields;

export type AgentChatTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  displayText?: string;
  timestamp: string;
  turnId?: string;
  messageId?: string;
  itemId?: string;
};

export type AgentChatSubagentSnapshot = {
  taskId: string;
  agentId?: string;
  parentAgentId?: string | null;
  agentType?: string;
  label?: string | null;
  parentToolUseId?: string | null;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  turnId?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  summary?: string;
  finalSummary?: string;
  lastToolName?: string;
  background?: boolean;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
    /** USD cost, when the runtime reports a per-subagent figure (OpenCode). */
    costUsd?: number;
  };
};

export type AgentChatSubagentListArgs = {
  sessionId: string;
};

// ── Droid AGI mission types ────────────────────────────────────────────────
// Mirror @factory/droid-sdk 0.2.0 MissionState / FeatureStatus / MissionFeature.
export type AgentChatMissionState =
  | "awaiting_input"
  | "initializing"
  | "running"
  | "paused"
  | "orchestrator_turn"
  | "completed"
  | (string & {});

export type AgentChatMissionFeatureStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | (string & {});

export type AgentChatMissionFeature = {
  id: string;
  description: string;
  status: AgentChatMissionFeatureStatus;
  skillName?: string | null;
  milestone?: string | null;
  /** Worker session currently executing this feature (maps to a subagent row). */
  currentWorkerSessionId?: string | null;
  workerSessionIds?: string[];
  completedWorkerSessionId?: string | null;
};

export type AgentChatMissionProgressEntry = {
  /** ProgressLogEntryType, e.g. "worker_started" | "worker_completed" | ... */
  type: string;
  text?: string | null;
  workerSessionId?: string | null;
  featureId?: string | null;
  timestamp?: string | null;
};

/** Args for killing an individual Droid AGI mission worker. */
export type AgentChatKillDroidWorkerArgs = {
  sessionId: string;
  workerSessionId: string;
};

export type AgentChatSessionCapabilities = {
  supportsSubagentInspection: boolean;
  supportsSubagentControl: boolean;
  supportsReviewMode: boolean;
  /**
   * Per-runtime subagent capability descriptor — the single source of truth the
   * renderer branches on (list vs takeover vs inline-drawer, which stat fields
   * to show). See `shared/subagentCapabilities.ts`.
   */
  subagent: SubagentCapability;
};

export type AgentChatSessionCapabilitiesArgs = {
  sessionId: string;
};

export type AgentChatContextUsageCategory = {
  name: string;
  tokens: number;
  percentage: number;
  color?: string;
  isDeferred?: boolean;
};

export type AgentChatContextUsage = {
  categories: AgentChatContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens?: number;
  percentage: number;
  model?: string;
  // Typed per-turn breakdown for the composer meter's hover. The `categories`
  // array is display-oriented (provider-shaped names) and drives the inline
  // `/context` card; these fields let consumers read the breakdown without
  // reparsing display strings. Present on automatic "live" Claude snapshots;
  // absent on the SDK `/context` command payload (which has different categories).
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type AgentChatContextUsageState =
  | "measured"
  | "compacting"
  | "recalculating"
  | "unknown";

export type AgentChatContextUsageArgs = {
  sessionId: string;
};

export type AgentChatRewindFilesArgs = {
  sessionId: string;
  userMessageId: string;
  dryRun?: boolean;
};

export type AgentChatRewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  dryRun: boolean;
  conversationRollback?: boolean;
  /** Links the SDK could not restore while otherwise completing the rewind. */
  skippedLinks?: number;
};

export type AgentChatClaudeSessionListArgs = {
  laneId?: string | null;
  limit?: number | null;
  offset?: number | null;
  includeWorktrees?: boolean | null;
};

export type AgentChatClaudeSessionInfoArgs = {
  sessionId: string;
  laneId?: string | null;
};

export type AgentChatClaudeSessionMessagesArgs = {
  sessionId: string;
  laneId?: string | null;
  limit?: number | null;
  offset?: number | null;
  includeSystemMessages?: boolean | null;
};

export type AgentChatClaudeSessionInfo = {
  sessionId: string;
  laneId: string | null;
  laneName: string | null;
  chatSessionId: string | null;
  summary: string;
  title: string | null;
  customTitle?: string | null;
  firstPrompt?: string | null;
  tag?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  createdAt?: string | null;
  lastModifiedAt: string | null;
  fileSize?: number | null;
};

export type AgentChatClaudeSessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  sessionId: string;
  parentToolUseId: string | null;
  parentAgentId?: string | null;
  message: unknown;
  text?: string | null;
  subagentMetadata?: AgentChatSubagentMetadata | null;
};

export type AgentChatSubagentMetadata = {
  threadId?: string | null;
  parentThreadId?: string | null;
  label?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  name?: string | null;
  preview?: string | null;
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

export type AgentChatSubagentTranscriptArgs = {
  sessionId: string;
  agentId: string;
  /** Optional task id from the legacy `system:task_*` path; the SDK keys on agentId. */
  taskId?: string | null;
  laneId?: string | null;
  limit?: number | null;
  offset?: number | null;
};

export type AgentChatMainTranscriptArgs = {
  /** ADE chat session id; the service resolves the backing Claude SDK session. */
  sessionId: string;
  limit?: number | null;
  offset?: number | null;
};

/**
 * One subagent transcript entry. Shape mirrors AgentChatClaudeSessionMessage
 * (the SDK's `SessionMessage` is identical for parent sessions and subagent
 * transcripts). Returns null for runtimes that don't surface subagent
 * transcripts (LM Studio, Droid).
 */
export type AgentChatSubagentTranscriptMessage = AgentChatClaudeSessionMessage;

export type AgentChatModelInfo = {
  id: string;
  displayName: string;
  description?: string | null;
  isDefault: boolean;
  reasoningEfforts?: Array<{ effort: string; description: string }>;
  defaultReasoningEffort?: string | null;
  serviceTiers?: string[];
  aliases?: string[];
  maxThinkingTokens?: number | null;
  // OpenCode-backed model metadata
  modelId?: ModelId;
  family?: string;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  color?: string;
  cursorAvailability?: {
    cli: boolean;
    sdk: boolean;
  };
  cursorCliVariants?: Array<{
    modelId: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }>;
};

export type AgentChatModelCatalogModel = AgentChatModelInfo & {
  /** Canonical ADE registry id used for update/create calls. */
  id: ModelId;
  /** Provider/runtime model ref ADE sends under the hood. */
  runtimeModelId: string;
  provider: AgentChatProvider;
  providerKey: string;
  groupKey: AgentChatProvider;
  isAvailable: boolean;
  connected?: boolean;
  requiresConfiguration?: boolean;
  sourceRuntime?: AgentChatProvider;
  providerId?: string;
  providerName?: string;
  stale?: boolean;
};

export type AgentChatModelCatalogSubsection = {
  key: string;
  label: string;
  models: AgentChatModelCatalogModel[];
};

export type AgentChatModelCatalogProvider = {
  key: string;
  displayName: string;
  badgeColor: string;
  modelCount: number;
  subsections: AgentChatModelCatalogSubsection[];
};

export type AgentChatModelCatalogGroup = {
  key: AgentChatProvider;
  displayName: string;
  providers: AgentChatModelCatalogProvider[];
};

export type AgentChatModelCatalog = {
  groups: AgentChatModelCatalogGroup[];
  fetchedAt: string;
  stale?: boolean;
};

export type AgentChatModelCatalogRefreshProvider =
  | "opencode"
  | "pi"
  | "cursor"
  | "droid"
  | "lmstudio"
  | "ollama";

export type AgentChatModelCatalogMode = "cached" | "refresh-stale" | "force";

/**
 * Which cursor discovery source the requesting surface needs synchronously.
 * Chat surfaces run models through the Cursor SDK ("sdk"); Work-tab CLI lane
 * drafts run the cursor-agent CLI ("cli"). "all" (default) probes both, which
 * makes the refresh wait on the slower CLI spawn — surfaces that know their
 * flavor should pass it so the other source revalidates in the background.
 */
export type AgentChatCursorModelSource = "sdk" | "cli" | "all";

export type AgentChatModelCatalogArgs = {
  mode?: AgentChatModelCatalogMode;
  refreshProvider?: AgentChatModelCatalogRefreshProvider;
  cursorSource?: AgentChatCursorModelSource;
};

/**
 * An MCP server an external embedder injects into a single chat.
 *
 * This is ADE's own provider-neutral shape, not a re-export of any one SDK's
 * type: every provider adapter translates it into that provider's native
 * config (Claude SDK `mcpServers`, Codex `config.mcp_servers`, Cursor inline
 * servers, Droid server list, OpenCode `mcp`). Keep it to the fields every
 * adapter can actually express — a field only one provider honors belongs on
 * that provider's own args, not here.
 */
export type AgentChatMcpServerConfig =
  | {
    type: "http" | "sse";
    url: string;
    headers?: Record<string, string>;
  }
  | {
    type: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };

/**
 * Honest report of what a provider did with a caller's MCP request. `level` and
 * `residual` mirror `CALLER_MCP_SUPPORT`.
 *
 * Branch on `level`, never on the presence of this object. `"enforced"` is the
 * ONLY level that means "the caller's servers plus ADE's are the whole surface";
 * `"best-effort"` means the servers were delivered but something of the user's
 * still loads, and `residual` says what. Treating any report as success
 * overpromises on four of six providers.
 *
 * `level` and `residual` describe strict mode, so they only make a claim when
 * `strictRequested` is true. Read `strictRequested` first: when it is false the
 * caller asked for delivery only, the user's own MCP config loads by design,
 * `residual` is null, and `mechanism` describes how the servers were delivered
 * rather than any enforcement — reporting a strict mechanism there would
 * describe an isolation ADE was never asked to perform.
 *
 * `delivered` means "nothing the caller asked for was dropped". It is false only
 * for a provider with no MCP surface. `createSession` refuses that combination
 * when servers were injected, rather than handing back a chat missing the tools
 * it was asked for — but a strict-mode request with NO servers is reported, not
 * refused, so a live session can carry `delivered: false` (strict mode asked of
 * a provider that has nothing to enforce it on). Check `delivered`, then branch
 * on `level`.
 */
export type AgentChatMcpCapability = {
  level: "enforced" | "best-effort" | "unsupported";
  mechanism: string;
  residual: string | null;
  delivered: boolean;
  /** Whether the caller asked ADE to withhold the user's own MCP config. */
  strictRequested: boolean;
};

export type AgentChatCreateArgs = {
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: ModelId;
  title?: string | null;
  sessionProfile?: AgentChatSessionProfile;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  claudeOutputStyle?: string | null;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  piProfileId?: string | null;
  piProviderId?: string | null;
  piModelId?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  openInUi?: boolean;
  requestedCwd?: string;
  runtimeMode?: AgentChatRuntimeMode;
  goal?: string | null;
  recoveredFromSessionId?: string;
  /**
   * Predetermined session id. Used so a Cursor Cloud Agent.create can stamp
   * ade_session_id before the ADE chat row exists.
   */
  sessionId?: string;
  // Orchestration-mode fields — set when spawning into an orchestration run.
  orchestrationRunId?: string;
  orchestrationRole?: OrchestrationRole;
  orchestrationParentSessionId?: string;
  spawnKind?: AgentChatSpawnKind;
  orchestrationTag?: string;
  orchestrationStepId?: string;
  orchestrationBundlePath?: string;
  /**
   * MCP servers injected by the caller for this chat only. Merged with (never
   * replacing) the ADE-managed servers a session already receives — the CTO and
   * orchestration leases keep working alongside them. Providers that cannot
   * accept injected servers report it through `mcpCapability` on the session
   * rather than dropping them silently.
   */
  mcpServers?: Record<string, AgentChatMcpServerConfig>;
  /**
   * Ask ADE to withhold the user's own MCP configuration from this chat.
   *
   * This is a request, not a guarantee, and it is fully honored on exactly one
   * provider. Only Claude has a real switch; everywhere else ADE applies the
   * strongest mechanism the provider exposes and something still gets through:
   *
   * | provider | strict mode | what still loads anyway                    |
   * |----------|-------------|--------------------------------------------|
   * | claude   | enforced    | nothing (MCP-wise)                         |
   * | codex    | best-effort | servers contributed by a Codex *plugin*    |
   * | cursor   | best-effort | user-layer servers                         |
   * | droid    | best-effort | tools appearing only after the first sweep |
   * | opencode | best-effort | the global OpenCode config dir (for auth)  |
   * | pi       | unsupported | n/a — no MCP surface at all                |
   *
   * Even on Claude, "enforced" scopes to MCP only: the user's rules, commands,
   * and output styles still load. That is deliberate — they are not MCP, and
   * withholding them is not what this flag asks for.
   *
   * Read `mcpCapability` on the created session for the machine-readable
   * version, including each provider's exact residual. `CALLER_MCP_SUPPORT`
   * in `shared/callerMcpServers.ts` is the source of truth this table mirrors.
   *
   * Absent means today's behavior: the user's MCP config loads as it always has,
   * except on the lightweight session profile every SDK/personal chat uses,
   * which is strict by default to stay lean. An explicit `false` is not the same
   * as absent — it overrides that default and asks for the user's MCP config,
   * which is how an embedder gets `loadUserMcpServers: true` on a personal chat.
   * Orchestration-lead sessions stay strict regardless; their isolation is a
   * policy, not a preference.
   */
  strictMcpConfig?: boolean;
};

export type AgentChatImportExternalSessionArgs = {
  provider: AgentChatImportProvider;
  externalSessionId: string;
  laneId: string;
  cwd: string | null;
  fork: boolean;
  title?: string;
  /** Catalog model id for the imported ADE chat. Cross-family values replay the transcript. */
  model?: string;
};

export type AgentChatImportExternalSessionResult = {
  chatSessionId: string;
  chatSummary: AgentChatSessionSummary;
  /**
   * The provider-native id the imported chat is actually bound to. It differs
   * from the requested external id whenever the import copied the session — a
   * Codex fork thread, or a transplanted Claude transcript — and the caller
   * needs it to record that copy as ADE-created rather than a new session to
   * import. A continue-in-place import binds to the source thread and returns
   * the requested external id, so every import can name its target: required,
   * because an unnamed fork target is a copy nothing marks as ADE-created.
   */
  providerTargetId: string;
  replayFork?: AgentChatReplayForkDisclosure;
};

/**
 * Args for headlessly launching an agent in a lane with no mounted chat pane.
 * Creates the session and fires the first turn off without awaiting it, so a
 * caller (e.g. the multi-lane Linear launch flow) can spin up N lanes that each
 * start working immediately. The kickoff text drives the first turn; optional
 * context attachments (Linear issue / orchestration annotations) are forwarded
 * to that turn the same way an interactive send would.
 */
export type AgentChatLaunchArgs = AgentChatCreateArgs & {
  kickoffText: string;
  kickoffDisplayText?: string;
  contextAttachments?: AgentChatContextAttachment[];
};

/** CLI provider profiles a headless CLI launch can target. */
export type AgentChatCliLaunchProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi";

/**
 * Launch a tracked CLI/terminal agent (not the in-process chat SDK) with one or
 * more Linear issues attached before the process spawns, so the agent inherits
 * `ADE_LINEAR_ISSUE_IDS` + `ADE_LINEAR_CONTEXT_FILE` and can read/update its
 * issue through `ade linear`. The kickoff prompt is submitted to the agent on
 * launch. Provider/model/permission build the startup command server-side.
 */
export type AgentChatLaunchCliArgs = {
  laneId: string;
  provider: AgentChatCliLaunchProvider;
  /** Runtime model ref for the provider's fresh-launch CLI flags. */
  model?: string | null;
  reasoningEffort?: string | null;
  /** Fast-mode override for runtimes that expose a fast tier. */
  fastMode?: boolean | null;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
  codexFastMode?: boolean | null;
  permissionMode?: AgentChatPermissionMode;
  /** Optional orchestration role; when present, role policy overrides the requested permission mode. */
  orchestrationRole?: OrchestrationRole | null;
  /** Prompt submitted to the CLI agent once it starts. */
  kickoffPrompt: string;
  /** Linear issues to attach to the new session before spawn. */
  linearIssues?: LaneLinearIssue[];
  title?: string;
  /** Foreground opens/focuses the session; background leaves focus alone. */
  disposition?: "foreground" | "background";
};

export type AgentChatLaunchCliResult = {
  sessionId: string;
  ptyId: string;
  pid: number | null;
  /** Identifiers of the issues attached to the launched session. */
  attachedLinearIssueIds: string[];
};

export type AgentChatRuntimeMode = "interactive" | "print";

/**
 * Providers ADE can fork into a new local chat: Claude (SDK `resume` +
 * `forkSession`), Codex (app-server `thread/fork`), OpenCode
 * (`POST /session/{id}/fork`), Droid (SDK `droid.fork_session`), and Cursor.
 *
 * Cursor is the odd one out: `@cursor/sdk` has no fork/clone surface at all and
 * a thread cannot be resumed twice, so ADE forks it at the ADE layer instead —
 * the new chat starts on a fresh Cursor agent with the source conversation
 * replayed into it verbatim (bounded by the target model's context window),
 * the same replay used when an agent rotates. Fork requires source and target
 * on the same provider; the model may still change within that provider.
 */
export const HANDOFF_FORK_PROVIDERS = ["claude", "codex", "opencode", "droid", "cursor"] as const;

export function providerSupportsHandoffFork(provider: AgentChatProvider | null | undefined): boolean {
  return provider != null && (HANDOFF_FORK_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * True when a provider's fork is an ADE-side transcript replay onto a fresh
 * provider thread rather than a native provider fork, so the UI must not
 * promise a copied provider thread. Cursor is the only one today: its SDK has
 * no fork surface and a thread cannot be resumed twice, so the forked chat
 * starts on a new agent with the whole conversation replayed into it.
 */
export function providerForkReplaysTranscript(provider: AgentChatProvider | null | undefined): boolean {
  return provider === "cursor";
}

/**
 * Droid can fork locally, but its session index is machine-local, so the
 * relocated-file resume path is not portable across ADE machines yet. Cursor's
 * fork is an ADE-side transcript replay with no transportable provider artifact
 * at all, so there is nothing to package for another machine. Derived from the
 * local set rather than restated, so adding a provider to one list cannot
 * silently leave the other behind.
 */
export const CROSS_MACHINE_HANDOFF_FORK_PROVIDERS = HANDOFF_FORK_PROVIDERS
  .filter((provider) => provider !== "droid" && !providerForkReplaysTranscript(provider));

export function providerSupportsCrossMachineHandoffFork(provider: string | null | undefined): boolean {
  return provider != null
    && (CROSS_MACHINE_HANDOFF_FORK_PROVIDERS as readonly string[]).includes(provider);
}

export type AgentChatHandoffArgs = {
  sourceSessionId: string;
  targetModelId: ModelId;
  mode?: "brief" | "fork";
  /**
   * Lane for the new chat. Brief handoffs may target any lane in the same
   * project (the renderer creates a new lane first when the user picks
   * "new lane"). Fork handoffs must stay in the source lane because provider
   * transcripts are keyed to the lane worktree; a differing value is rejected.
   */
  targetLaneId?: string | null;
  /** Optional user-authored note appended to the handoff prompt. Blank notes are ignored. */
  handoffNote?: string | null;
  /**
   * When set (including `null` for "no extra reasoning"), combined with the target
   * model to pick a valid reasoning tier. When omitted, inherits from the source
   * session the same way as a legacy handoff.
   */
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
  codexFastMode?: boolean;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  permissionMode?: AgentChatPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
};

export type AgentChatHandoffResult = {
  session: AgentChatSession;
  usedFallbackSummary: boolean;
  /**
   * Present when the fork seeded the target via full-transcript replay
   * (cross-provider, or a provider without a native fork such as Cursor) and
   * oldest turns were dropped to fit the target context window.
   */
  replayFork?: AgentChatReplayForkDisclosure;
};

export type AgentChatReplayForkDisclosure = {
  truncated: boolean;
  truncatedTurnCount: number;
  keptTurnCount: number;
};

export type AgentChatCrossMachineTargetConfig = {
  targetModelId: ModelId;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  permissionMode?: AgentChatPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
};

export type AgentChatCrossMachineHandoffCapsule = {
  version: 1;
  handoffId: string;
  createdAt: string;
  source: {
    machineName: string;
    sessionId: string;
    provider: AgentChatProvider;
    model: string;
    title: string | null;
    laneName: string;
    branchRef: string;
    headSha: string;
    originUrl: string;
  };
  target: AgentChatCrossMachineTargetConfig;
  brief: string;
  artifacts: {
    fileChanges: string[];
    commands: string[];
    errors: string[];
  };
  linearIssues: Array<{
    identifier: string;
    title: string;
    url: string | null;
  }>;
  continuationPrompt: string;
  /**
   * Absent = brief (v1 capsules). Fork capsules carry the provider-native
   * session history in `forkTransport` and the ADE transcript in
   * `transcriptEnvelopes`. Fork is only sent to destinations whose preflight
   * advertised `forkHandoffSupport.supported`, so older ADE builds never
   * silently downgrade a fork to a brief.
   */
  mode?: "brief" | "fork";
  forkTransport?: AgentChatCrossMachineForkTransport;
  transcriptEnvelopes?: {
    /** Gzipped JSONL of AgentChatEventEnvelope lines, base64-encoded. */
    contentBase64Gzip: string;
    uncompressedBytes: number;
    /** True when older events were dropped to fit the transport cap. */
    truncated: boolean;
  };
};

/** Provider-native session files shipped inside a fork-mode capsule. */
export type AgentChatCrossMachineForkTransport = {
  provider: AgentChatProvider;
  /** Source provider session/thread id the destination forks from. */
  nativeSessionId: string;
  kind: "claude-jsonl" | "codex-rollout" | "opencode-export" | "droid-jsonl";
  mainFile: {
    name: string;
    contentBase64Gzip: string;
    uncompressedBytes: number;
  };
  /** Claude subagent/tool-result sidecars, Droid settings sidecar, etc. */
  sideFiles?: Array<{
    relPath: string;
    contentBase64Gzip: string;
    uncompressedBytes: number;
  }>;
};

export type AgentChatPrepareCrossMachineHandoffArgs = AgentChatCrossMachineTargetConfig & {
  sourceSessionId: string;
  handoffId: string;
  continuationPrompt?: string | null;
  /** Absent = brief. */
  mode?: "brief" | "fork";
};

export type AgentChatPrepareCrossMachineHandoffResult = {
  capsule: AgentChatCrossMachineHandoffCapsule;
  capsuleFingerprint: string;
  usedFallbackSummary: boolean;
  sanitizedSensitiveContext: boolean;
};

export type AgentChatValidateCrossMachineSourceArgs = {
  sourceSessionId: string;
  capsule: AgentChatCrossMachineHandoffCapsule;
  capsuleFingerprint: string;
};

export type AgentChatCrossMachineDestinationPreflightArgs = {
  targetModelId: ModelId;
  sourceBranchRef: string;
  sourceHeadSha: string;
  /** Absent = brief (older sources). */
  mode?: "brief" | "fork";
  /** Source chat provider, required for fork-support evaluation. */
  sourceProvider?: AgentChatProvider;
};

export type AgentChatCrossMachineDestinationPreflightResult = {
  providerAuthorized: boolean;
  modelAvailable: boolean;
  remoteBranchHeadSha: string | null;
  existingLaneId: string | null;
  blockingErrors: string[];
  warnings: string[];
  /**
   * Absent on older ADE destinations — the source must treat that as
   * fork-unsupported ("that machine needs an ADE update").
   */
  forkHandoffSupport?: {
    supported: boolean;
    reason?: string;
  };
  /**
   * Present when the destination's existing lane is clean and a strict ancestor of the
   * source commit, so ADE can safely fast-forward it instead of blocking. Absent on older
   * destinations and whenever a fast-forward would not be safe.
   */
  laneFastForward?: {
    laneId: string;
    laneName: string;
    behindBy: number;
  };
};

export type AgentChatAcceptCrossMachineHandoffArgs = {
  capsule: AgentChatCrossMachineHandoffCapsule;
  capsuleFingerprint: string;
};

export type AgentChatAcceptCrossMachineHandoffResult = {
  handoffId: string;
  laneId: string;
  session: AgentChatSession;
  reusedLane: boolean;
  reusedSession: boolean;
};

export type AgentChatMarkCrossMachineHandoffArgs = {
  sourceSessionId: string;
  handoffId: string;
  targetMachineName: string;
  targetLaneId: string;
  targetSessionId: string;
};

/** Host-side emit of an `ade_card` transcript row. See `agentChatService.emitAdeCard`. */
export type AgentChatEmitAdeCardArgs = {
  sessionId: string;
  card: AdeCardPayload;
};

export type AgentChatListArgs = {
  laneId?: string;
  includeAutomation?: boolean;
  includeArchived?: boolean;
  /** Include identity-bound sessions for dedicated surfaces such as CTO. */
  includeIdentity?: boolean;
};

export type AgentChatSuggestLaneNameArgs = {
  /** Lane the user is launching from (worktree path for the naming model call). */
  laneId: string;
  /** User prompt for the chat launch (used to derive a short lane name prefix). */
  prompt: string;
  /** Registry model ID used to run the naming call (e.g. first selected model). */
  modelId: string;
  /**
   * Registry model ID the chat itself was launched with. Distinct from `modelId`,
   * which is the configured naming model when one is set — the naming fallback
   * chain needs the launched model even then, so it can escape a naming provider
   * that is broken at the provider level.
   */
  chatModelId?: string;
  /** Optional fallback used when model-backed naming is disabled or unavailable. */
  fallbackName?: string;
  /** Exact temporary branch created for this automatic lane. */
  temporaryBranch?: string;
  /** Bounded first-message attachment metadata; image paths use existing chat materialization. */
  attachments?: AgentChatFileRef[];
};

export type AutoLaneIdentitySuggestion = {
  laneTitle: string;
  branchFragment: string;
  source: "ai" | "deterministic";
  laneRenameOutcome: "renamed" | "kept" | "skipped" | "failed";
  branchRenameOutcome: "renamed" | "kept" | "skipped" | "failed";
  branchRef: string;
  reason?: string;
};

export type AgentChatParallelLaunchStateStatus =
  | "creating_lanes"
  | "sending"
  | "completed"
  | "cleanup_pending";

export type AgentChatParallelLaunchState = {
  parentLaneId: string;
  createdLaneIds: string[];
  sentLaneIds: string[];
  status: AgentChatParallelLaunchStateStatus;
  updatedAt: string;
  lastError?: string | null;
};

export type AgentChatParallelLaunchStateArgs = {
  projectRoot: string;
  parentLaneId: string;
};

export type AgentChatSetParallelLaunchStateArgs = AgentChatParallelLaunchStateArgs & {
  state: AgentChatParallelLaunchState | null;
};

export type AgentChatGetSummaryArgs = {
  sessionId: string;
};

export type AgentChatCloudOverrides = {
  repoUrl?: string;
  startingRef?: string | null;
  autoCreatePR?: boolean;
  workOnCurrentBranch?: boolean;
  prUrl?: string | null;
  skipReviewerRequest?: boolean;
  /** Linear identifier kept on the ADE session; not sent as cloud.metadata. */
  linearIssueId?: string | null;
  /** Project secret names to inject as cloud.envVars. Values are resolved in main. */
  secretNames?: string[];
  /** Persist secretNames as the next preselection for this lane. */
  rememberSecretNames?: boolean;
};

export type AgentChatSendArgs = {
  sessionId: string;
  text: string;
  displayText?: string;
  attachments?: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  metadata?: AgentChatEventMetadata | null | undefined;
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  interactionMode?: AgentChatInteractionMode | null;
  /** Selected runtime for this send. Omit to use the session default (cloud once promoted). */
  runtime?: AgentChatRuntime;
  /** Cloud-only launch overrides; ignored when runtime !== "cloud". */
  cloudOverrides?: AgentChatCloudOverrides;
};

export type AgentChatDispatchSteerMode = "inline" | "interrupt";

/**
 * How a message typed during a live turn reaches the agent. "queue" stages it
 * for the next turn (every provider can do that); the other two are the atomic
 * active-turn dispatch modes and map 1:1 to `AgentChatDispatchSteerMode`.
 */
export type ActiveTurnSendMode = "queue" | AgentChatDispatchSteerMode;

/**
 * THE canonical per-provider active-turn delivery matrix, in menu order (the
 * first entry is the provider's default). Every surface reads this rather than
 * restating the rules: the composer's split send button, the chat pane's
 * dispatch wiring, the main service's steer/dispatch guards, and the `ade code`
 * TUI. iOS mirrors it by hand (it cannot import TS) — keep the two in step.
 *
 * Claude folds a message into the live query, so it has all three. Cursor's SDK
 * has no mid-run message API: its interrupt cancels the run and resends on the
 * same agent thread, so it has no "inline". Everything else is queue-only.
 */
export const ACTIVE_TURN_DISPATCH_MODES: Partial<Record<AgentChatProvider, readonly ActiveTurnSendMode[]>> = {
  claude: ["inline", "queue", "interrupt"],
  cursor: ["interrupt", "queue"],
};

const QUEUE_ONLY_ACTIVE_TURN_MODES: readonly ActiveTurnSendMode[] = ["queue"];

/** Modes `provider` can honor during a live turn, in menu order. */
export function activeTurnDispatchModes(
  provider: AgentChatProvider | null | undefined,
): readonly ActiveTurnSendMode[] {
  return ACTIVE_TURN_DISPATCH_MODES[provider ?? ""] ?? QUEUE_ONLY_ACTIVE_TURN_MODES;
}

/** Pre-selected mode for a fresh session on `provider`. */
export function defaultActiveTurnDispatchMode(
  provider: AgentChatProvider | null | undefined,
): ActiveTurnSendMode {
  return activeTurnDispatchModes(provider)[0] ?? "queue";
}

/** True when `provider` accepts this atomic active-turn dispatch mode. */
export function supportsActiveTurnDispatchMode(
  provider: AgentChatProvider | null | undefined,
  mode: AgentChatDispatchSteerMode,
): boolean {
  return activeTurnDispatchModes(provider).includes(mode);
}

/**
 * True when the provider's "interrupt" cancels the live run and resends on the
 * same thread (so the turn continues from the new message) rather than folding
 * the message into the running query. Lives beside the table because it is the
 * same per-provider fact, and every surface that labels the interrupt affordance
 * needs it. iOS mirrors it by hand alongside the table.
 */
export function activeTurnInterruptContinues(provider: AgentChatProvider | null | undefined): boolean {
  return provider === "cursor";
}

/**
 * The one rejection message for a mode the provider cannot honor, templated off
 * the table so adding a provider never leaves prose behind that contradicts it.
 */
export function unsupportedActiveTurnDispatchModeMessage(
  provider: AgentChatProvider | null | undefined,
  mode: string,
): string {
  const accepted = activeTurnDispatchModes(provider).filter((entry) => entry !== "queue");
  const name = providerDisplayLabel(provider, "These");
  if (!accepted.length) {
    return `${name} sessions don't support the "${mode}" active-turn dispatch mode; it can only be staged for the next turn.`;
  }
  return `${name} sessions support only the ${
    accepted.map((entry) => `"${entry}"`).join(" and ")
  } active-turn dispatch mode${accepted.length > 1 ? "s" : ""}.`;
}

export type AgentChatSteerArgs = {
  sessionId: string;
  text: string;
  displayText?: string;
  attachments?: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  metadata?: AgentChatEventMetadata | null | undefined;
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  interactionMode?: AgentChatInteractionMode | null;
  /**
   * Atomic active-turn delivery. Omit to stage the message for the next turn.
   * Claude: "inline" maps to SDK priority "next" and "interrupt" to "now".
   * Cursor: only "interrupt" is accepted — the Cursor SDK has no mid-run
   * message API, so the redirect is cancel + resend on the same agent thread.
   * Every other provider rejects the field.
   */
  dispatchMode?: AgentChatDispatchSteerMode;
};

export type AgentChatSteerResult = {
  steerId: string;
  queued: boolean;
  reason?: "queue_full";
};

export type AgentChatMessageSessionKind =
  | "auto"
  | "queue"
  | "wake"
  | "interrupt-replace";

export type AgentChatMessageSessionArgs = {
  sessionId: string;
  text: string;
  kind?: AgentChatMessageSessionKind;
  attachments?: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  metadata?: AgentChatEventMetadata | null | undefined;
};

export type AgentChatMessageSessionResult = {
  sessionId: string;
  kind: AgentChatMessageSessionKind;
  routedAction: "sendMessage" | "steer" | "interrupt-replace";
  statusBefore: AgentChatSessionStatus;
  awaitingInputBefore: boolean;
  delivery: "sent" | "delivered" | "queued";
  steerId?: string;
  queued?: boolean;
};

export type AgentChatSetScheduledWorkPausedArgs = {
  sessionId: string;
  paused: boolean;
};

export type AgentChatSetScheduledWorkPausedResult = {
  sessionId: string;
  paused: boolean;
  nextWakeAt: string | null;
};

export type AgentChatGetScheduledWorkStateArgs = {
  sessionId: string;
};

export type AgentChatScheduledWorkState = {
  sessionId: string;
  paused: boolean;
  nextWakeAt: string | null;
  items: AgentChatScheduledWorkItem[];
};

export type AgentChatScheduledWorkItem = {
  id: string;
  sessionId: string;
  kind: "wakeup" | "cron" | "loop";
  status: "scheduled" | "paused" | "fired" | "completed" | "cancelled";
  title: string;
  prompt: string;
  reason?: string;
  cron?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  expiresAt?: string;
  createdAt: string;
  durable: boolean;
  /** True when ADE has a durable record that its management API can cancel. */
  cancellable: boolean;
  late?: boolean;
  outcomeSummary?: string;
  /**
   * Provenance for rows ADE armed itself rather than the user or the agent.
   * Additive and optional: older clients simply ignore it.
   */
  source?: "auto_resume_limit";
};

export type AgentChatListScheduledWorkArgs = {
  sessionId?: string;
  includeTerminal?: boolean;
};

type AgentChatCreateScheduledWorkBaseArgs = {
  sessionId: string;
  prompt: string;
  reason?: string;
};

export type AgentChatCreateScheduledWorkArgs = AgentChatCreateScheduledWorkBaseArgs & (
  | {
      /** Five-field cron interpreted in the ADE brain machine's local timezone. */
      cron: string;
      runAt?: never;
      delaySeconds?: never;
      recurring?: boolean;
    }
  | {
      /** Absolute one-shot time. Must be ISO 8601 with an explicit offset or Z. */
      runAt: string;
      cron?: never;
      delaySeconds?: never;
      recurring?: false;
    }
  | {
      /** Relative one-shot delay from creation time. */
      delaySeconds: number;
      cron?: never;
      runAt?: never;
      recurring?: false;
    }
);

export type AgentChatCreateScheduledWorkResult = {
  item: AgentChatScheduledWorkItem;
  /** IANA timezone of the ADE brain that resolved the schedule. */
  timeZone: string;
};

export type AgentChatCancelScheduledWorkArgs = {
  sessionId: string;
  scheduleId: string;
};

export type AgentChatCancelScheduledWorkResult = {
  schedule: AgentChatScheduledWorkItem;
  providerCancellationRequested: boolean;
  providerCancellationConfirmed: boolean;
};

export type AgentChatRecoverContinuityArgs = {
  sessionId: string;
  mode: "retry_original" | "recover_from_history" | "start_new_chat";
};

export type AgentChatContinuityRecoveryResult = {
  ok: boolean;
  mode: AgentChatRecoverContinuityArgs["mode"];
  threadId?: string;
  newSessionId?: string;
  capsulePreview?: string;
  reason?: AgentChatResumeFailureKind | "not_required" | "unsupported_provider" | "missing_original_thread" | "recovery_failed";
};

export type AgentChatCancelSteerArgs = {
  sessionId: string;
  steerId: string;
  /** Reject when the steer already left the queue instead of only clearing stale UI. */
  requireQueued?: boolean;
};

export type AgentChatEditSteerArgs = {
  sessionId: string;
  steerId: string;
  text: string;
};

export type AgentChatDispatchSteerArgs = {
  sessionId: string;
  steerId: string;
  mode: AgentChatDispatchSteerMode;
};

export type AgentChatDispatchSteerResult = {
  dispatchedAt: number | null;
};

export type AgentChatCancelDispatchedSteerArgs = {
  sessionId: string;
  steerId: string;
};

export type AgentChatCancelDispatchedSteerResult = {
  cancelled: boolean;
};

export type AgentChatStopMode = "stop_and_clear" | "stop_only";

export type AgentChatInterruptArgs = {
  sessionId: string;
  /** Defaults to stop_and_clear for backward-compatible Stop-means-stop behavior. */
  mode?: AgentChatStopMode;
};

export type AgentChatInterruptResult = {
  mode: AgentChatStopMode;
  cancelledQueuedCount: number;
  recoveryId?: string;
  recoveryExpiresAt?: string;
};

export type AgentChatRestoreCancelledQueueArgs = {
  sessionId: string;
  recoveryId: string;
};

export type AgentChatRestoreCancelledQueueResult = {
  restored: boolean;
  restoredCount: number;
};

export type AgentChatCodexRecoveryAction =
  | "wait"
  | "steer"
  | "interrupt_retry_same_thread"
  | "restart_resume_thread";

export const AGENT_CHAT_TURN_RECOVERY_ACTIONS = [
  "wait",
  "nudge",
  "retry_same_runtime",
  "restart_resume",
] as const;

export type AgentChatTurnRecoveryAction =
  (typeof AGENT_CHAT_TURN_RECOVERY_ACTIONS)[number];

export function isAgentChatTurnRecoveryAction(
  value: unknown,
): value is AgentChatTurnRecoveryAction {
  return typeof value === "string"
    && (AGENT_CHAT_TURN_RECOVERY_ACTIONS as readonly string[]).includes(value);
}

export function isUnsupportedAgentChatRecoveryActionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:unsupported|unknown)\s+(?:chat\s+)?(?:method|action|command)\b/i.test(message)
    || /\b(?:method|action|command)\s+(?:is\s+)?not supported\b/i.test(message)
    || /\b(?:recoverTurn|chat\.recoverTurn)\b.*\b(?:not supported|not available|not found)\b/i.test(message)
    || /\b(?:not supported|not available|not found)\b.*\b(?:recoverTurn|chat\.recoverTurn)\b/i.test(message)
  );
}

export type AgentChatRecoverTurnArgs = {
  sessionId: string;
  turnId: string;
  action: AgentChatTurnRecoveryAction;
};

export type AgentChatRecoverTurnResult = {
  action: AgentChatTurnRecoveryAction;
  turnId: string;
  status: "waiting" | "nudged" | "retrying" | "resumed";
};

export type AgentChatRecoverCodexTurnArgs = {
  sessionId: string;
  turnId: string;
  action: AgentChatCodexRecoveryAction;
};

export type AgentChatRecoverCodexTurnResult = {
  action: AgentChatCodexRecoveryAction;
  turnId: string;
  status: "waiting" | "nudged" | "retrying" | "resumed";
};

export type AgentChatResolveUnprocessedMessageArgs = {
  sessionId: string;
  steerId: string;
  action: "run_next" | "dismiss";
};

export type AgentChatResolveUnprocessedMessageResult = {
  steerId: string;
  action: "run_next" | "dismiss";
  status: "completed" | "already_completed";
  replacementMessageId?: string;
};

export type AgentChatCodexGetGoalArgs = {
  sessionId: string;
};

export type AgentChatCodexSetGoalArgs = {
  sessionId: string;
  objective: string;
};

export type AgentChatCodexSetGoalStatusArgs = {
  sessionId: string;
  status: Extract<CodexThreadGoalStatus, "active" | "paused" | "blocked" | "complete">;
};

export type AgentChatCodexClearGoalArgs = {
  sessionId: string;
};

export type AgentChatCodexResetMemoryArgs = {
  sessionId: string;
};

export type AgentChatCodexTerminateBackgroundTerminalArgs = {
  sessionId: string;
  processId: string;
};

export type AgentChatApproveArgs = {
  sessionId: string;
  itemId: string;
  decision: AgentChatApprovalDecision;
  responseText?: string | null;
};

export type AgentChatRespondToInputArgs = {
  sessionId: string;
  itemId: string;
  decision?: AgentChatApprovalDecision;
  answers?: Record<string, string | string[]>;
  responseText?: string | null;
};

export type AgentChatModelsArgs = {
  provider?: AgentChatProvider;
  activateRuntime?: boolean;
  cursorSource?: AgentChatCursorModelSource;
};

export type AgentChatDisposeArgs = {
  sessionId: string;
};

export type AgentChatDeleteArgs = {
  sessionId: string;
};

export type AgentChatArchiveArgs = {
  sessionId: string;
};

export type AgentChatSetSpawnKindArgs = {
  sessionId: string;
  spawnKind: AgentChatSpawnKind;
};

export type AgentChatDismissSubagentTakeoverPromptArgs = {
  sessionId: string;
};

export type AgentChatUpdateSessionArgs = {
  sessionId: string;
  title?: string | null;
  tag?: string | null;
  manuallyNamed?: boolean;
  spawnKind?: AgentChatSpawnKind;
  /** Persist that the takeover banner was shown and answered or dismissed. */
  subagentTakeoverPromptShown?: boolean;
  modelId?: ModelId;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Accepted for older renderer/IPC callers. */
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue> | null;
};

export const AGENT_CHAT_SESSION_METADATA_FIELDS = ["title", "laneName", "statusLine"] as const;
export type AgentChatSessionMetadataField = (typeof AGENT_CHAT_SESSION_METADATA_FIELDS)[number];

export function isAgentChatSessionMetadataField(value: unknown): value is AgentChatSessionMetadataField {
  return AGENT_CHAT_SESSION_METADATA_FIELDS.some((field) => field === value);
}

export function normalizeAgentChatSessionMetadataFields(
  fields?: readonly unknown[] | null,
): AgentChatSessionMetadataField[] {
  return Array.from(new Set(
    (fields ?? AGENT_CHAT_SESSION_METADATA_FIELDS).filter(isAgentChatSessionMetadataField),
  ));
}

export type AgentChatRegenerateSessionMetadataArgs = {
  sessionId: string;
  /** Defaults to all three fields when omitted. Duplicate fields are ignored. */
  fields?: AgentChatSessionMetadataField[];
};

export type AgentChatRegenerateSessionMetadataResult = {
  sessionId: string;
  applied: AgentChatSessionMetadataField[];
  skipped: AgentChatSessionMetadataField[];
  modelId: string | null;
};

/**
 * One command in the composer's slash menu.
 *
 * `source` says who owns dispatch, and the three answers behave differently:
 * `sdk` goes to the runtime as text, `local` is intercepted by the client, and
 * `plugin` is invoked as a plugin action and never reaches the model at all.
 * A client that has not grown a plugin arm must not offer `plugin` commands —
 * see `includePluginCommands` on the args below.
 */
export type AgentChatSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "local" | "plugin";
  /**
   * Present exactly when `source` is `"plugin"`. Carries the identity the
   * client needs to invoke and to attribute the row, so the menu never has to
   * parse it back out of `name` — which namespacing would break anyway.
   */
  plugin?: {
    pluginId: string;
    /** The plugin's display name, shown as the menu row's attribution. */
    displayName: string;
    /** The plugin action a selection invokes. */
    actionId: string;
  };
};

export type AgentChatSlashCommandsArgs = {
  sessionId?: string;
  laneId?: string | null;
  provider?: AgentChatProvider | null;
  projectRoot?: string | null;
  /**
   * Whether the caller can dispatch `source: "plugin"` commands.
   *
   * Opt-in rather than default-on because a client that lists a plugin command
   * it cannot invoke produces a dead menu row: selecting it sends the literal
   * `/name` to the model, which is strictly worse than the command not being
   * offered. Desktop and the hosted web client set it; the TUI and iOS leave it
   * off until they grow an invoke path.
   */
  includePluginCommands?: boolean;
};

export type AgentChatClaudeOutputStylesArgs = {
  sessionId?: string;
  laneId?: string;
};

export type AgentChatSetClaudeOutputStyleArgs = {
  sessionId: string;
  outputStyle: string;
};

export type AgentChatFileSearchArgs = {
  sessionId: string;
  query: string;
};

export type AgentChatFileSearchResult = {
  path: string;
  score?: number;
};

export type PromptStashEntry = {
  id: string;
  text: string;
  /** Absent when talking to a pre-attachment ADE runtime. */
  attachments?: AgentChatFileRef[];
  /** Includes images that exist only on the originating ADE runtime. */
  attachmentCount?: number;
  /** False when this synced runtime does not own the stash's image files. */
  attachmentsAvailable?: boolean;
  provider: string | null;
  modelId: string | null;
  createdAt: string;
};

export const MAX_PROMPT_STASHES = 20;
export const MAX_PROMPT_STASH_ATTACHMENTS = 10;

export type PromptStashCreateArgs = {
  text: string;
  attachments?: AgentChatFileRef[];
  provider?: string | null;
  modelId?: string | null;
};

export type PromptStashDeleteArgs = {
  id: string;
};

export type TurnDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  status: "A" | "M" | "D" | "R" | "C" | string;
};

export type TurnDiffSummary = {
  turnId: string;
  beforeSha: string;
  afterSha: string;
  files: TurnDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
};

export type AgentChatGetTurnFileDiffArgs = {
  sessionId: string;
  beforeSha: string;
  afterSha: string;
  filePath: string;
};

export type AgentChatTurnFileDiff = FileDiff;
