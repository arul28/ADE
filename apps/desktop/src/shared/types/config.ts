// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

import type { ProviderMode, ModelId } from "./core";
import type { AgentChatModelInfo } from "./chat";
import type { LaneType } from "./lanes";
import type { MissionExecutionPolicy, MissionPermissionConfig, MissionProviderPermissions } from "./missions";
import type { ExternalMcpMissionSelection } from "./externalMcp";
import type { MissionModelConfig, ModelConfig } from "./models";
import type { LinearSyncConfig } from "./linearSync";

// Backward compatible with earlier configs that used `on_crash`.
export type ProcessRestartPolicy = "never" | "on-failure" | "always" | "on_crash";
export type StackStartOrder = "parallel" | "dependency";
export type ProcessReadinessType = "none" | "port" | "logRegex";
export type ProcessRuntimeStatus = "stopped" | "starting" | "running" | "degraded" | "stopping" | "exited" | "crashed";
export type ProcessReadinessState = "unknown" | "ready" | "not_ready";
export type StackAggregateStatus = "running" | "partial" | "stopped" | "error";
export type TestRunStatus = "running" | "passed" | "failed" | "canceled" | "timed_out";
export type TestSuiteTag = "unit" | "lint" | "integration" | "e2e" | "custom";

export type ProcessReadinessConfig =
  | { type: "none" }
  | { type: "port"; port: number }
  | { type: "logRegex"; pattern: string };

export type ConfigProcessReadiness =
  | { type?: "none" }
  | { type: "port"; port?: number }
  | { type: "logRegex"; pattern?: string };

export type ProcessDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  autostart: boolean;
  restart: ProcessRestartPolicy;
  gracefulShutdownMs: number;
  dependsOn: string[];
  readiness: ProcessReadinessConfig;
};

export type StackButtonDefinition = {
  id: string;
  name: string;
  processIds: string[];
  startOrder: StackStartOrder;
};

export type TestSuiteDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number | null;
  tags: TestSuiteTag[];
};

export type ConfigProcessDefinition = {
  id: string;
  name?: string;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  autostart?: boolean;
  restart?: ProcessRestartPolicy;
  gracefulShutdownMs?: number;
  dependsOn?: string[];
  readiness?: ConfigProcessReadiness;
};

export type ConfigStackButtonDefinition = {
  id: string;
  name?: string;
  processIds?: string[];
  startOrder?: StackStartOrder;
};

export type ConfigTestSuiteDefinition = {
  id: string;
  name?: string;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  tags?: TestSuiteTag[];
};

export type LaneOverlayMatch = {
  laneIds?: string[];
  laneTypes?: LaneType[];
  namePattern?: string;
  branchPattern?: string;
  tags?: string[];
};

export type LaneOverlayOverrides = {
  env?: Record<string, string>;
  cwd?: string;
  processIds?: string[];
  testSuiteIds?: string[];
  /** Port range override for lane (e.g. { start: 3100, end: 3199 }) */
  portRange?: { start: number; end: number };
  /** Proxy hostname override (e.g. "feat-auth.localhost") */
  proxyHostname?: string;
  /** Compute backend override */
  computeBackend?: "local" | "vps" | "daytona";
  /** Lane environment initialization config override */
  envInit?: LaneEnvInitConfig;
};

// --- Lane Environment Init types (Phase 5 W1) ---

export type LaneEnvInitStepKind = "env-files" | "docker" | "dependencies" | "mount-points" | "copy-paths";

export type LaneEnvInitStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type LaneEnvInitStep = {
  kind: LaneEnvInitStepKind;
  label: string;
  status: LaneEnvInitStepStatus;
  error?: string;
  durationMs?: number;
};

export type LaneEnvInitProgress = {
  laneId: string;
  steps: LaneEnvInitStep[];
  startedAt: string;
  completedAt?: string;
  overallStatus: "pending" | "running" | "completed" | "failed";
};

export type LaneEnvInitEvent = {
  type: "lane-env-init";
  progress: LaneEnvInitProgress;
};

export type LaneEnvFileConfig = {
  /** Source path relative to project root (e.g. ".env.template") */
  source: string;
  /** Destination path relative to worktree root (e.g. ".env") */
  dest: string;
  /** Template variables to substitute (e.g. { PORT: "{{port}}", HOSTNAME: "{{hostname}}" }) */
  vars?: Record<string, string>;
};

export type LaneDockerConfig = {
  /** Path to docker-compose file relative to project root. Optional on partial overrides before merge. */
  composePath?: string;
  /** Service names to start (empty = all) */
  services?: string[];
  /** Project name prefix for isolation (lane slug appended) */
  projectPrefix?: string;
};

export type LaneDependencyInstallConfig = {
  /** Command to run (e.g. ["npm", "install"] or ["pip", "install", "-r", "requirements.txt"]) */
  command: string[];
  /** Working directory relative to worktree root */
  cwd?: string;
};

export type LaneMountPointConfig = {
  /** Source path relative to .ade/ (e.g. "agent-profiles/default.json") */
  source: string;
  /** Destination path relative to worktree root */
  dest: string;
};

export type LaneCopyPathConfig = {
  /** Source path relative to project root (e.g. ".claude", ".vscode/settings.json") */
  source: string;
  /** Destination path relative to worktree root (defaults to same as source if omitted) */
  dest?: string;
};

export type LaneEnvInitConfig = {
  /** Environment files to copy/template */
  envFiles?: LaneEnvFileConfig[];
  /** Docker Compose services to start */
  docker?: LaneDockerConfig;
  /** Dependency install commands */
  dependencies?: LaneDependencyInstallConfig[];
  /** Runtime mount points for agent profiles/context */
  mountPoints?: LaneMountPointConfig[];
  /** Files and directories to copy from project root into the worktree */
  copyPaths?: LaneCopyPathConfig[];
};

export type LaneOverlayPolicy = {
  id: string;
  name: string;
  enabled: boolean;
  match: LaneOverlayMatch;
  overrides: LaneOverlayOverrides;
};

export type ConfigLaneOverlayPolicy = {
  id: string;
  name?: string;
  enabled?: boolean;
  match?: LaneOverlayMatch;
  overrides?: LaneOverlayOverrides;
};

// --- Lane Template types (Phase 5 W2) ---

/** A reusable lane initialization recipe stored in project config (local.yaml / ade.yaml). */
export type LaneTemplate = {
  id: string;
  name: string;
  description?: string;
  /** Environment files to copy/template */
  envFiles?: LaneEnvFileConfig[];
  /** Docker Compose services to start */
  docker?: LaneDockerConfig;
  /** Dependency install commands */
  dependencies?: LaneDependencyInstallConfig[];
  /** Runtime mount points for agent profiles/context */
  mountPoints?: LaneMountPointConfig[];
  /** Files and directories to copy from project root into the worktree */
  copyPaths?: LaneCopyPathConfig[];
  /** Port range for lanes created with this template */
  portRange?: { start: number; end: number };
  /** Extra environment variables to set */
  envVars?: Record<string, string>;
};

/** Lenient version of LaneTemplate for YAML config parsing. */
export type ConfigLaneTemplate = {
  id: string;
  name?: string;
  description?: string;
  envFiles?: LaneEnvFileConfig[];
  docker?: LaneDockerConfig;
  dependencies?: LaneDependencyInstallConfig[];
  mountPoints?: LaneMountPointConfig[];
  copyPaths?: LaneCopyPathConfig[];
  portRange?: { start: number; end: number };
  envVars?: Record<string, string>;
};

/**
 * Internal config sentinel used to explicitly override an inherited shared
 * default template with "no default" in local config.
 */
export const NO_DEFAULT_LANE_TEMPLATE = "__ade_none__";

/** IPC args for listing templates */
export type ListLaneTemplatesArgs = Record<string, never>;

/** IPC args for getting a single template */
export type GetLaneTemplateArgs = { templateId: string };

/** IPC args for getting/setting default template */
export type GetDefaultLaneTemplateArgs = Record<string, never>;
export type SetDefaultLaneTemplateArgs = { templateId: string | null };

/** IPC args for applying a template to lane env init */
export type ApplyLaneTemplateArgs = { laneId: string; templateId: string };

/** IPC args for saving (create/update) a template */
export type SaveLaneTemplateArgs = { template: LaneTemplate };

/** IPC args for deleting a template */
export type DeleteLaneTemplateArgs = { templateId: string };

// --- Port Allocation & Lease types (Phase 5 W3) ---

export type PortLeaseStatus = "active" | "released" | "orphaned";

/** A port range lease assigned to a specific lane. */
export type PortLease = {
  laneId: string;
  rangeStart: number;
  rangeEnd: number;
  status: PortLeaseStatus;
  leasedAt: string;
  releasedAt?: string;
};

/** Event payload for port allocation changes. */
export type PortAllocationEvent = {
  type: "port-lease-acquired" | "port-lease-released" | "port-conflict-detected" | "port-conflict-resolved";
  lease?: PortLease;
  conflict?: PortConflict;
};

/** Describes a port conflict between two lanes. */
export type PortConflict = {
  port: number;
  laneIdA: string;
  laneIdB: string;
  detectedAt: string;
  resolved: boolean;
  resolvedAt?: string;
};

/** Port allocation configuration. */
export type PortAllocationConfig = {
  /** Base port for range allocation (default: 3000) */
  basePort: number;
  /** Number of ports per lane (default: 100) */
  portsPerLane: number;
  /** Maximum port number allowed (default: 9999) */
  maxPort: number;
};

/** IPC args for port allocation queries. */
export type GetPortLeaseArgs = { laneId: string };
export type ListPortLeasesArgs = Record<string, never>;
export type ListPortConflictsArgs = Record<string, never>;
export type AcquirePortLeaseArgs = { laneId: string };
export type ReleasePortLeaseArgs = { laneId: string };

// --- Per-Lane Hostname Isolation & Preview types (Phase 5 W4) ---

export type ProxyRouteStatus = "active" | "inactive" | "error";

/** A proxy route mapping a hostname to a lane's dev server port. */
export type ProxyRoute = {
  laneId: string;
  hostname: string;
  targetPort: number;
  status: ProxyRouteStatus;
  createdAt: string;
};

/** Overall proxy server status. */
export type ProxyStatus = {
  running: boolean;
  proxyPort: number;
  routes: ProxyRoute[];
  startedAt?: string;
  error?: string;
};

/** Proxy configuration. */
export type ProxyConfig = {
  /** Port the reverse proxy listens on (default: 8080) */
  proxyPort: number;
  /** Hostname suffix for lane routing (default: ".localhost") */
  hostnameSuffix: string;
};

/** Preview URL info for a lane. */
export type LanePreviewInfo = {
  laneId: string;
  hostname: string;
  previewUrl: string;
  proxyPort: number;
  targetPort: number;
  active: boolean;
};

/** Event payload for proxy/preview changes. */
export type LaneProxyEvent = {
  type: "proxy-started" | "proxy-stopped" | "route-added" | "route-removed" | "route-error";
  status?: ProxyStatus;
  route?: ProxyRoute;
  error?: string;
};

/** IPC args for proxy/preview operations. */
export type AddProxyRouteArgs = { laneId: string; targetPort: number };
export type RemoveProxyRouteArgs = { laneId: string };
export type GetPreviewInfoArgs = { laneId: string };
export type OpenPreviewArgs = { laneId: string };
export type StartProxyArgs = { port?: number };

// --- OAuth Redirect Handling types (Phase 5 W5) ---

export type OAuthRoutingMode = "state-parameter" | "hostname";

export type OAuthSessionStatus = "pending" | "active" | "completed" | "failed";

/** Tracks a single OAuth callback that passed through the proxy. */
export type OAuthSession = {
  id: string;
  laneId: string;
  provider?: string;
  status: OAuthSessionStatus;
  callbackPath: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
};

/** Configuration for OAuth redirect handling. */
export type OAuthRedirectConfig = {
  /** Whether OAuth callback interception is enabled (default: true). */
  enabled: boolean;
  /** URL paths recognised as OAuth callbacks. */
  callbackPaths: string[];
  /** Primary routing strategy. */
  routingMode: OAuthRoutingMode;
};

/** Runtime status of the OAuth redirect service. */
export type OAuthRedirectStatus = {
  enabled: boolean;
  routingMode: OAuthRoutingMode;
  activeSessions: OAuthSession[];
  callbackPaths: string[];
};

/** Event payload for OAuth redirect changes. */
export type OAuthRedirectEvent = {
  type:
    | "oauth-callback-routed"
    | "oauth-session-started"
    | "oauth-session-completed"
    | "oauth-session-failed"
    | "oauth-config-changed";
  session?: OAuthSession;
  status?: OAuthRedirectStatus;
  error?: string;
};

/** Provider-specific redirect URI info for the copy-helper. */
export type RedirectUriInfo = {
  provider: string;
  uris: string[];
  instructions: string;
};

/** IPC args for OAuth redirect operations. */
export type UpdateOAuthRedirectConfigArgs = Partial<OAuthRedirectConfig>;
export type GenerateRedirectUrisArgs = { provider?: string };
export type EncodeOAuthStateArgs = { laneId: string; originalState: string };
export type DecodeOAuthStateArgs = { encodedState: string };
export type DecodeOAuthStateResult = { laneId: string; originalState: string } | null;

// --- Runtime Diagnostics types (Phase 5 W6) ---

export type LaneHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export type LaneHealthIssue = {
  type: "process-dead" | "port-unresponsive" | "proxy-route-missing" | "port-conflict" | "env-init-failed";
  message: string;
  actionLabel?: string;
  actionType?: "reassign-port" | "restart-proxy" | "reinit-env" | "enable-fallback";
};

export type LaneHealthCheck = {
  laneId: string;
  status: LaneHealthStatus;
  processAlive: boolean;
  portResponding: boolean;
  proxyRouteActive: boolean;
  fallbackMode: boolean;
  lastCheckedAt: string;
  issues: LaneHealthIssue[];
};

export type RuntimeDiagnosticsStatus = {
  lanes: LaneHealthCheck[];
  proxyRunning: boolean;
  proxyPort: number;
  totalRoutes: number;
  activeConflicts: number;
  fallbackLanes: string[];
};

export type RuntimeDiagnosticsEvent = {
  type: "health-updated" | "fallback-activated" | "fallback-deactivated" | "diagnostics-refresh";
  laneId?: string;
  health?: LaneHealthCheck;
  status?: RuntimeDiagnosticsStatus;
};

export type GetLaneHealthArgs = { laneId: string };
export type RunHealthCheckArgs = { laneId: string };
export type ActivateFallbackArgs = { laneId: string };
export type DeactivateFallbackArgs = { laneId: string };

export const AUTOMATION_TRIGGER_TYPES = [
  "session-end",
  "commit",
  "git.commit",
  "git.push",
  "git.pr_opened",
  "git.pr_updated",
  "git.pr_merged",
  "git.pr_closed",
  "file.change",
  "lane.created",
  "lane.archived",
  "schedule",
  "manual",
  "linear.issue_created",
  "linear.issue_updated",
  "linear.issue_assigned",
  "linear.issue_status_changed",
  "github-webhook",
  "webhook",
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];
export type AutomationActionType =
  | "agent-session"
  | "launch-mission"
  | "predict-conflicts"
  | "run-tests"
  | "run-command";

export type AutomationMode = "review" | "fix" | "monitor";

export type AutomationReviewProfile =
  | "quick"
  | "incremental"
  | "full"
  | "security"
  | "release-risk"
  | "cross-repo-contract";

export type AutomationExecutorMode = "automation-bot";

export type AutomationToolFamily =
  | "repo"
  | "git"
  | "tests"
  | "github"
  | "linear"
  | "browser"
  | "memory"
  | "mission"
  | "external-mcp";

export type AutomationContextSourceType =
  | "project-memory"
  | "automation-memory"
  | "worker-memory"
  | "procedures"
  | "skills"
  | "linked-doc"
  | "linked-repo"
  | "path-rules";

export type AutomationOutputDisposition =
  | "comment-only"
  | "open-task"
  | "open-lane"
  | "prepare-patch"
  | "open-pr-draft";

export type AutomationRunQueueStatus =
  | "pending-review"
  | "actionable-findings"
  | "verification-required"
  | "completed-clean"
  | "ignored"
  | "archived";

export type AutomationActiveHours = {
  start: string;
  end: string;
  timezone: string;
};

export type AutomationTrigger = {
  type: AutomationTriggerType;
  cron?: string;
  branch?: string;
  targetBranch?: string;
  event?: string;
  author?: string;
  labels?: string[];
  paths?: string[];
  keywords?: string[];
  namePattern?: string;
  project?: string;
  team?: string;
  assignee?: string;
  stateTransition?: string;
  changedFields?: string[];
  draftState?: "draft" | "ready" | "any";
  secretRef?: string;
  activeHours?: AutomationActiveHours;
};

export type AutomationAction = {
  type: AutomationActionType;
  suiteId?: string;
  command?: string;
  cwd?: string;
  condition?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;
  retry?: number;
};

export type AutomationExecutionKind = "agent-session" | "mission" | "built-in";

export type AutomationExecution = {
  kind: AutomationExecutionKind;
  /**
   * Optional preferred lane. If omitted, the runtime falls back to the trigger
   * lane or the project's primary lane.
   */
  targetLaneId?: string | null;
  /**
   * Agent-session specific hints. Sessions launched from automations stay in
   * automation history and are intentionally hidden from the Work tab.
   */
  session?: {
    title?: string | null;
    reasoningEffort?: string | null;
  };
  /**
   * Mission-specific launch hints reused by the automation mission launcher.
   */
  mission?: {
    title?: string | null;
  };
  /**
   * Built-in deterministic tasks such as run-command and run-tests.
   */
  builtIn?: {
    actions: AutomationAction[];
  };
};

export type AutomationExecutor = {
  mode: AutomationExecutorMode;
  targetId?: string | null;
  routingHints?: {
    preferredWorkerIds?: string[];
    requiredCapabilities?: string[];
  };
};

export type AutomationContextSource = {
  type: AutomationContextSourceType;
  path?: string;
  repoId?: string;
  label?: string;
  required?: boolean;
};

export type AutomationMemoryConfig = {
  mode: "none" | "project" | "automation" | "automation-plus-project" | "automation-plus-employee";
  ruleScopeKey?: string | null;
};

export type AutomationGuardrails = {
  budgetUsd?: number;
  maxDurationMin?: number;
  activeHours?: AutomationActiveHours;
  confidenceThreshold?: number;
  maxFindings?: number;
  reserveBudget?: boolean;
};

export type AutomationOutputs = {
  disposition: AutomationOutputDisposition;
  createArtifact?: boolean;
  notificationChannel?: string | null;
};

export type AutomationVerification = {
  verifyBeforePublish: boolean;
  mode?: "intervention" | "dry-run";
};

export type AutomationRule = {
  id: string;
  name: string;
  description?: string;
  mode: AutomationMode;
  triggers: AutomationTrigger[];
  /** @deprecated Use `triggers[0]` or `legacy?.trigger`. */
  trigger: AutomationTrigger;
  execution?: AutomationExecution;
  executor: AutomationExecutor;
  modelConfig?: MissionModelConfig;
  permissionConfig?: MissionPermissionConfig;
  templateId?: string;
  prompt?: string;
  reviewProfile: AutomationReviewProfile;
  toolPalette: AutomationToolFamily[];
  contextSources: AutomationContextSource[];
  memory: AutomationMemoryConfig;
  guardrails: AutomationGuardrails;
  outputs: AutomationOutputs;
  verification: AutomationVerification;
  billingCode: string;
  queueStatus?: AutomationRunQueueStatus;
  /** @deprecated Legacy compatibility shim for action-list surfaces. */
  actions: AutomationAction[];
  legacy?: {
    trigger?: AutomationTrigger;
    actions?: AutomationAction[];
  };
  enabled: boolean;
};

export type ConfigAutomationRule = {
  id: string;
  name?: string;
  description?: string;
  mode?: AutomationMode;
  triggers?: AutomationTrigger[];
  execution?: AutomationExecution;
  executor?: AutomationExecutor;
  modelConfig?: MissionModelConfig;
  permissionConfig?: MissionPermissionConfig;
  templateId?: string;
  prompt?: string;
  reviewProfile?: AutomationReviewProfile;
  toolPalette?: AutomationToolFamily[];
  contextSources?: AutomationContextSource[];
  memory?: AutomationMemoryConfig;
  guardrails?: AutomationGuardrails;
  outputs?: AutomationOutputs;
  verification?: AutomationVerification;
  billingCode?: string;
  queueStatus?: AutomationRunQueueStatus;
  trigger?: AutomationTrigger;
  actions?: AutomationAction[];
  enabled?: boolean;
};

export type EnvironmentMapping = {
  // Branch pattern (supports simple glob "*" matching, e.g. "release/*").
  branch: string;
  // Environment label, e.g. "production", "staging".
  env: string;
  // Optional hex color used for graph badges/borders.
  color?: string;
};

export type AiTaskRoutingKey =
  | "planning"
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "memory_consolidation"
  | "narrative"
  | "pr_description"
  | "terminal_summary"
  | "mission_planning"
  | "initial_context";

export type AiTaskRoutingRule = {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
};

export type AiFeatureKey =
  | "narratives"
  | "conflict_proposals"
  | "commit_messages"
  | "pr_descriptions"
  | "terminal_summaries"
  | "memory_consolidation"
  | "mission_planning"
  | "orchestrator"
  | "initial_context";

export type AiModelDescriptor = {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  default?: boolean;
};

export type AiFeatureUsageRow = {
  feature: AiFeatureKey;
  enabled: boolean;
  dailyUsage: number;
  dailyLimit: number | null;
};

export type AiDetectedAuth = {
  type: "cli-subscription" | "api-key" | "openrouter" | "local";
  cli?: "claude" | "codex";
  provider?: string;
  source?: "config" | "env" | "store";
  path?: string;
  endpoint?: string;
  authenticated?: boolean;
  verified?: boolean;
};

export type AiProviderCredentialSource = "macos-keychain" | "claude-credentials-file" | "codex-auth-file";

export type AiProviderConnectionSource = {
  kind: "cli" | "local-credentials";
  detected: boolean;
  authenticated?: boolean;
  verified?: boolean;
  path?: string | null;
  source?: AiProviderCredentialSource;
  stale?: boolean;
};

export type AiProviderConnectionStatus = {
  provider: "claude" | "codex";
  authAvailable: boolean;
  runtimeDetected: boolean;
  runtimeAvailable: boolean;
  usageAvailable: boolean;
  path: string | null;
  blocker: string | null;
  lastCheckedAt: string;
  sources: AiProviderConnectionSource[];
};

export type AiProviderConnections = {
  claude: AiProviderConnectionStatus;
  codex: AiProviderConnectionStatus;
};

export type AiApiKeyVerificationResult = {
  provider: string;
  ok: boolean;
  message: string;
  source?: "config" | "env" | "store";
  endpoint?: string;
  statusCode?: number | null;
  verifiedAt: string;
};

export type AiSettingsStatus = {
  mode: "guest" | "subscription";
  availableProviders: {
    claude: boolean;
    codex: boolean;
  };
  models: {
    claude: AiModelDescriptor[];
    codex: AiModelDescriptor[];
  };
  features: AiFeatureUsageRow[];
  detectedAuth?: AiDetectedAuth[];
  providerConnections?: AiProviderConnections;
  availableModelIds?: ModelId[];
  apiKeyStore?: {
    secureStorageAvailable: boolean;
    legacyPlaintextDetected: boolean;
    decryptionFailed: boolean;
    encryptedStorePath?: string | null;
    legacyPlaintextPath?: string | null;
  };
};
export type AiFeatureToggles = Partial<Record<AiFeatureKey, boolean>>;

export type AiBudgetLimit = {
  dailyLimit?: number;
};

export type AiBudgets = Partial<Record<AiFeatureKey, AiBudgetLimit>>;

export type AiCliPermissionMode = "read-only" | "edit" | "full-auto";
export type AiCliSandboxPermissions = "read-only" | "workspace-write" | "danger-full-access";
export type AiInProcessPermissionMode = "plan" | "edit" | "full-auto";

export type AiCliPermissionSettings = {
  mode?: AiCliPermissionMode;
  sandboxPermissions?: AiCliSandboxPermissions;
  writablePaths?: string[];
  commandAllowlist?: string[];
  allowedTools?: string[];
  settingsSources?: Array<"user" | "project" | "local">;
  maxBudgetUsd?: number;
};

export type AiInProcessPermissionSettings = {
  mode?: AiInProcessPermissionMode;
};

export type AiPermissionSettings = {
  cli?: AiCliPermissionSettings;
  inProcess?: AiInProcessPermissionSettings;
  /** Per-provider permission config (preferred over cli/inProcess for missions). */
  providers?: MissionProviderPermissions;
  externalMcp?: ExternalMcpMissionSelection;
};

export type WorkerSafetyPolicy = {
  permissionLevel: "read-only" | "edit" | "full-auto";
  sandbox?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
};

export type WorkerSandboxConfig = {
  /** Regex patterns for bash commands that are always blocked */
  blockedCommands: string[];
  /** Regex patterns for bash commands that are always allowed */
  safeCommands: string[];
  /** Regex patterns for files that cannot be modified */
  protectedFiles: string[];
  /** Paths workers can access, relative to project root (default: ["./"]) */
  allowedPaths: string[];
  /** If true, commands not matching safe or blocked lists are blocked (default: false) */
  blockByDefault: boolean;
};

export type AiConflictResolutionConfig = {
  changeTarget?: "target" | "source" | "ai_decides";
  postResolution?: "unstaged" | "staged" | "commit";
  prBehavior?: "do_nothing" | "open_pr" | "add_to_existing";
  autonomy?: "propose_only" | "auto_apply";
  autoApplyThreshold?: number;
};

export type AiOrchestratorHookEvent = "TeammateIdle" | "TaskCompleted";

export type AiOrchestratorHookConfig = {
  command: string;
  timeoutMs?: number;
};

export type AiOrchestratorConfig = {
  teammatePlanMode?: "off" | "auto" | "required";
  maxParallelWorkers?: number;
  defaultMergePolicy?: "sequential" | "batch-at-end" | "per-step";
  defaultConflictHandoff?: "auto-resolve" | "ask-user" | "orchestrator-decides";
  workerHeartbeatIntervalMs?: number;
  workerHeartbeatTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  stepTimeoutDefaultMs?: number;
  maxRetriesPerStep?: number;
  contextPressureThreshold?: number;
  progressiveLoading?: boolean;
  maxTotalTokenBudget?: number;
  maxPerStepTokenBudget?: number;
  defaultExecutionPolicy?: Partial<MissionExecutionPolicy>;
  defaultOrchestratorModel?: ModelConfig;
  autoResolveInterventions?: boolean;
  interventionConfidenceThreshold?: number;
  hooks?: Partial<Record<AiOrchestratorHookEvent, AiOrchestratorHookConfig>>;
  maxConcurrentMissions?: number;
  laneExclusivity?: boolean;
};

/** Unified config for AI-generated titles and summaries across all session types (chat, CLI, terminal). */
export type SessionIntelligenceConfig = {
  titles?: {
    enabled?: boolean;
    modelId?: ModelId;
    /** Whether to regenerate the title when the session completes */
    refreshOnComplete?: boolean;
  };
  summaries?: {
    enabled?: boolean;
    modelId?: ModelId;
  };
};

export type AiChatConfig = {
  defaultProvider?: "codex" | "claude" | "last_used";
  defaultApprovalPolicy?: "auto" | "approve_mutations" | "approve_all";
  sendOnEnter?: boolean;
  /** @deprecated Use ai.sessionIntelligence.titles instead */
  autoTitleEnabled?: boolean;
  /** @deprecated Use ai.sessionIntelligence.titles.modelId instead */
  autoTitleModelId?: ModelId;
  /** @deprecated Use ai.sessionIntelligence.titles.refreshOnComplete instead */
  autoTitleRefreshOnComplete?: boolean;
  /** Reasoning effort for auto-title generation */
  autoTitleReasoningEffort?: string | null;
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  claudePermissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  sessionBudgetUsd?: number;
  /** Default permission mode for new unified/API-model chat sessions */
  unifiedPermissionMode?: AiInProcessPermissionMode;
};
export type AiConfig = {
  mode?: ProviderMode;
  defaultProvider?: string;
  taskRouting?: Partial<Record<AiTaskRoutingKey, AiTaskRoutingRule>>;
  features?: AiFeatureToggles;
  budgets?: AiBudgets;
  permissions?: AiPermissionSettings;
  conflictResolution?: AiConflictResolutionConfig;
  orchestrator?: AiOrchestratorConfig;
  chat?: AiChatConfig;
  // New unified fields
  defaultModel?: ModelId;
  apiKeys?: Record<string, string>;
  workerSafety?: WorkerSafetyPolicy;
  mcpServers?: Record<string, unknown>;
  /** Per-feature model overrides, e.g. { mission_planning: "claude-sonnet-4-6" } */
  featureModelOverrides?: Partial<Record<AiFeatureKey, string>>;
  /** Per-feature reasoning effort overrides */
  featureReasoningOverrides?: Partial<Record<AiFeatureKey, string | null>>;
  /** Unified title + summary intelligence config for all session types */
  sessionIntelligence?: SessionIntelligenceConfig;
};

export type AiIntegrationStatus = {
  mode: ProviderMode;
  availableProviders: {
    claude: boolean;
    codex: boolean;
  };
  models: {
    claude: AgentChatModelInfo[];
    codex: AgentChatModelInfo[];
  };
  // New unified fields
  detectedAuth?: AiDetectedAuth[];
  providerConnections?: AiProviderConnections;
  availableModelIds?: ModelId[];
};

export type ProjectConfigFile = {
  version?: number;
  processes?: ConfigProcessDefinition[];
  stackButtons?: ConfigStackButtonDefinition[];
  testSuites?: ConfigTestSuiteDefinition[];
  laneOverlayPolicies?: ConfigLaneOverlayPolicy[];
  automations?: ConfigAutomationRule[];
  environments?: EnvironmentMapping[];
  github?: {
    prPollingIntervalSeconds?: number;
  };
  git?: {
    autoRebaseOnHeadChange?: boolean;
  };
  ai?: AiConfig;
  /** Default lane environment initialization config */
  laneEnvInit?: LaneEnvInitConfig;
  /** Lane templates: reusable initialization recipes (Phase 5 W2) */
  laneTemplates?: ConfigLaneTemplate[];
  /** Default lane template ID applied to new lanes */
  defaultLaneTemplate?: string;
  providers?: Record<string, unknown>;
  linearSync?: LinearSyncConfig;
  /** Event-based checklist for context doc auto-regeneration */
  contextRefreshEvents?: import("./packs").ContextRefreshEvents;
};

export type ProjectConfigCandidate = {
  shared: ProjectConfigFile;
  local: ProjectConfigFile;
};

export type EffectiveProjectConfig = {
  version: number;
  processes: ProcessDefinition[];
  stackButtons: StackButtonDefinition[];
  testSuites: TestSuiteDefinition[];
  laneOverlayPolicies: LaneOverlayPolicy[];
  automations: AutomationRule[];
  environments?: EnvironmentMapping[];
  github?: {
    prPollingIntervalSeconds?: number;
  };
  git: {
    autoRebaseOnHeadChange: boolean;
  };
  ai?: AiConfig;
  /** Default lane environment initialization config */
  laneEnvInit?: LaneEnvInitConfig;
  /** Lane templates: reusable initialization recipes (Phase 5 W2) */
  laneTemplates?: LaneTemplate[];
  /** Default lane template ID */
  defaultLaneTemplate?: string;
  providerMode?: ProviderMode;
  providers?: Record<string, unknown>;
  linearSync?: LinearSyncConfig;
  cto?: {
    companyBudgetMonthlyCents?: number;
    budgetTelemetry?: {
      enabled?: boolean;
      codexSessionsRoot?: string;
      claudeProjectsRoot?: string;
    };
  };
};

export type ProjectConfigValidationIssue = {
  path: string;
  message: string;
};

export type ProjectConfigValidationResult = {
  ok: boolean;
  issues: ProjectConfigValidationIssue[];
};

export type ProjectConfigTrust = {
  sharedHash: string;
  localHash: string;
  approvedSharedHash: string | null;
  requiresSharedTrust: boolean;
};

export type ProjectConfigSnapshot = {
  shared: ProjectConfigFile;
  local: ProjectConfigFile;
  effective: EffectiveProjectConfig;
  validation: ProjectConfigValidationResult;
  trust: ProjectConfigTrust;
  paths: {
    sharedPath: string;
    localPath: string;
  };
};

export type ProjectConfigDiff = {
  sharedChanged: boolean;
  localChanged: boolean;
  sharedHash: string;
  localHash: string;
  approvedSharedHash: string | null;
  requiresSharedTrust: boolean;
};

export type ProcessRuntime = {
  laneId: string;
  processId: string;
  status: ProcessRuntimeStatus;
  readiness: ProcessReadinessState;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastExitCode: number | null;
  lastEndedAt: string | null;
  uptimeMs: number | null;
  ports: number[];
  logPath: string | null;
  updatedAt: string;
};

export type ProcessLogEvent = {
  type: "log";
  laneId: string;
  processId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
};

export type ProcessRuntimeEvent = {
  type: "runtime";
  runtime: ProcessRuntime;
};

export type ProcessEvent = ProcessLogEvent | ProcessRuntimeEvent;

export type TestRunSummary = {
  id: string;
  suiteId: string;
  suiteName: string;
  laneId: string | null;
  status: TestRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  logPath: string;
};

export type TestRunEvent = {
  type: "run";
  run: TestRunSummary;
};

export type TestLogEvent = {
  type: "log";
  runId: string;
  suiteId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
};

export type TestEvent = TestRunEvent | TestLogEvent;

export type ProcessActionArgs = {
  laneId: string;
  processId: string;
};

export type ProcessStackArgs = {
  laneId: string;
  stackId: string;
};

export type GetProcessLogTailArgs = {
  laneId: string;
  processId: string;
  maxBytes?: number;
};

export type RunTestSuiteArgs = {
  laneId: string;
  suiteId: string;
};

export type StopTestRunArgs = {
  runId: string;
};

export type ListTestRunsArgs = {
  laneId?: string;
  suiteId?: string;
  limit?: number;
};

export type GetTestLogTailArgs = {
  runId: string;
  maxBytes?: number;
};
