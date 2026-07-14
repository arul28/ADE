import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS } from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import type {
  AutomationManualTriggerRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationRuleSummary,
  AutomationScheduledCleanup,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
} from "../../../shared/types/automations";
import type { ComputerUseOwnerSnapshotArgs } from "../../../shared/types/computerUseArtifacts";
import type {
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatGetTurnFileDiffArgs,
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
  AgentChatParallelLaunchState,
  AgentChatSetParallelLaunchStateArgs,
  AgentChatTurnFileDiff,
} from "../../../shared/types/chat";
import type { AutomationRule } from "../../../shared/types/config";
import { areAutomationsEnabledForPackagedState } from "../../../shared/automationAvailability";
import type { LinearIngressStatus } from "../automations/linearIngressService";
import { buildPrAiResolutionContextKey } from "../../../shared/types";
import type {
  AiConfig,
  ApplyLaneTemplateArgs,
  DeleteLaneArgs,
  FileChangeEvent,
  FilesWatchArgs,
  LaneEnvInitConfig,
  LaneEnvInitProgress,
  LaneListSnapshot,
  LaneOverlayOverrides,
  LanePreviewInfo,
  ListLanesArgs,
  PortLease,
  PrAgentPermissionMode,
  PrAiResolutionContext,
  PrAiResolutionEventPayload,
  PrAiResolutionGetSessionResult,
  PrAiResolutionInputArgs,
  PrAiResolutionSessionInfo,
  PrAiResolutionSessionStatus,
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  ReadTranscriptTailArgs,
  PrAiResolutionStopArgs,
  ProxyStatus,
  AiFeatureKey,
  AiSettingsStatus,
  CtoRunProjectScanResult,
  CtoLinearQuickView,
  LinearConnectionStatus,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";
import { mergeAiConfig } from "../config/projectConfigService";
import { appendDiffTruncationNotice, MAX_DIFF_SIDE_TEXT_BYTES } from "../diffs/diffService";
import { runGit } from "../git/git";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import { buildLaneListSnapshots } from "../lanes/laneListSnapshotService";
import { mapPermissionModeForModelFamily } from "../prs/resolverUtils";
import { getErrorMessage, isRecord, nowIso, resolvePathWithinRoot } from "../shared/utils";
import { parseLinearGraphQLInput } from "../cto/linearGraphQLInput";
import { launchAgentChatCli } from "../chat/agentChatCliLaunch";
import { deleteTerminalSessionWithRuntimeCleanup } from "../sessions/deleteTerminalSession";
import { createOrchestrationDomainService } from "../orchestration/orchestrationDomain";

export const ADE_ACTION_DOMAIN_NAMES = [
  "lane",
  "git",
  "diff",
  "conflicts",
  "pr",
  "tests",
  "chat",
  "keybindings",
  "ai",
  "onboarding",
  "automation_planner",
  "cto_state",
  "cto_memory",
  "session",
  "operation",
  "ade_project",
  "project_config",
  "project_secret",
  "linear_credentials",
  "linear_oauth",
  "linear_issue_tracker",
  "github",
  "feedback",
  "usage",
  "analytics",
  "storage",
  "budget",
  "update",
  "file",
  "process",
  "pty",
  "terminal",
  "layout",
  "tiling_tree",
  "graph_state",
  "computer_use_artifacts",
  "ios_simulator",
  "app_control",
  "built_in_browser",
  "automations",
  "review",
  "issue",
  "orchestration",
  "search",
  "external-sessions",
] as const;

export type AdeActionDomain = (typeof ADE_ACTION_DOMAIN_NAMES)[number];

export type AdeActionRole = "cto" | "orchestrator" | "agent" | "external" | "evaluator";

/**
 * Methods that require at least `cto` role when invoked via `run_ade_action`.
 * The generic bridge has no built-in role check, so anything that mutates
 * account-level credentials, persisted policy, or drives privileged polling
 * must be listed here.
 */
export const ADE_ACTION_CTO_ONLY: Partial<Record<AdeActionDomain, readonly string[]>> = {
  // The CTO's durable memory is injected into every CTO session; only the CTO
  // itself (and the user's own UI, which connects at cto role) may rewrite it.
  cto_memory: ["updateMemory"],
  linear_credentials: [
    "setToken",
    "setOAuthToken",
    "setOAuthClientCredentials",
    "clearToken",
    "clearOAuthClientCredentials",
  ],
  linear_oauth: ["startSession"],
  github: ["setToken", "clearToken", "startAppUserDeviceAuth", "pollAppUserDeviceAuth", "clearAppUserAuth"],
  update: ["quitAndInstall"],
  // Linear webhook lifecycle mutates account-level state (registers/deletes a
  // webhook against the user's Linear organization), so it stays CTO-only;
  // status/poll/cleanup reads remain open to agents.
  // cancelScheduledCleanup can silently defeat a cleanup policy another
  // automation scheduled, so it is operator-only like the webhook lifecycle.
  automations: ["setWebhookGatewayPublicUrl", "linearIngressSetup", "linearIngressTeardown", "cancelScheduledCleanup"],
  ai: ["updateConfig", "storeApiKey", "deleteApiKey"],
  budget: ["updateConfig"],
  feedback: ["submitPreparedDraft"],
  usage: ["forceRefresh", "refreshHistory", "poll", "start", "stop"],
  analytics: ["setEnabled", "flush"],
  storage: ["cleanup"],
  search: ["rebuildIndex"],
};

const ROLE_ORDER: Record<AdeActionRole, number> = {
  external: 0,
  evaluator: 1,
  agent: 2,
  orchestrator: 3,
  cto: 4,
};

export function isCtoOnlyAdeAction(domain: AdeActionDomain, action: string): boolean {
  return (ADE_ACTION_CTO_ONLY[domain] ?? []).includes(action);
}

export function callerHasRoleAtLeast(role: AdeActionRole | undefined | null, minRole: AdeActionRole): boolean {
  if (!role) return false;
  return ROLE_ORDER[role] >= ROLE_ORDER[minRole];
}

export const ADE_ACTION_ALLOWLIST: Partial<Record<AdeActionDomain, readonly string[]>> = {
  lane: [
    "adoptAttached",
    "archive",
    "attach",
    "attachLinearIssueToSession",
    "cancelDelete",
    "create",
    "createChild",
    "createFromUnstaged",
    "deferRebaseSuggestion",
    "delete",
    "deleteTemplate",
    "detachLinearIssueFromSession",
    "diagnosticsActivateFallback",
    "diagnosticsDeactivateFallback",
    "diagnosticsGetLaneHealth",
    "diagnosticsGetStatus",
    "diagnosticsRunFullCheck",
    "diagnosticsRunHealthCheck",
    "dismissAutoRebaseStatus",
    "dismissRebaseSuggestion",
    "getChildren",
    "getDefaultTemplate",
    "getDeleteRisk",
    "getEnvStatus",
    "getOverlay",
    "getStackChain",
    "getTemplate",
    "importBranch",
    "initEnv",
    "listAutoRebaseStatuses",
    "list",
    "listDeleteProgress",
    "listSnapshots",
    "listRebaseSuggestions",
    "listTemplates",
    "listUnregisteredWorktrees",
    "listLinearIssuesForLaneSessions",
    "listLinearIssuesForSession",
    "linkLinearIssues",
    "oauthDecodeState",
    "oauthEncodeState",
    "oauthGenerateRedirectUris",
    "oauthGetStatus",
    "oauthListSessions",
    "oauthUpdateConfig",
    "portAcquire",
    "portGetLease",
    "portListConflicts",
    "portListLeases",
    "portRecoverOrphans",
    "portRelease",
    "previewBranchSwitch",
    "proxyAddRoute",
    "proxyGetPreviewInfo",
    "proxyGetStatus",
    "proxyRemoveRoute",
    "proxyStart",
    "proxyStop",
    "refreshSnapshots",
    "rebaseAbort",
    "rebasePush",
    "rebaseRollback",
    "rebaseStart",
    "rename",
    "reparent",
    "applyTemplate",
    "saveTemplate",
    "setDefaultTemplate",
    "switchBranch",
    "unarchive",
    "unlinkLinearIssues",
    "updateAppearance",
  ],
  git: [
    "abortRebase",
    "checkoutBranch",
    "cherryPickCommit",
    "commit",
    "continueRebase",
    "createTag",
    "discardFile",
    "fetch",
    "generateCommitMessage",
    "getCommit",
    "getCommitMessage",
    "isCommitInLaneHistory",
    "getConflictState",
    "getFileHistory",
    "getOpenPrForBranch",
    "getOriginRemote",
    "getUserIdentity",
    "getSyncStatus",
    "listBranches",
    "listCommitFiles",
    "listRecentCommits",
    "listStashes",
    "mergeAbort",
    "mergeContinue",
    "pull",
    "push",
    "rebaseAbort",
    "rebaseContinue",
    "redoLastHeadChange",
    "resetToCommit",
    "restoreStagedFile",
    "revertCommit",
    "stageAll",
    "stageFile",
    "stagePaths",
    "stash",
    "stashApply",
    "stashClear",
    "stashDrop",
    "stashPop",
    "stashPush",
    "sync",
    "undoLastHeadChange",
    "unstageAll",
    "unstageFile",
    "unstagePaths",
  ],
  diff: ["getChanges", "getLaneDiffStats", "listLaneDiffStats", "getFileDiff", "getFilePatch"],
  conflicts: [
    "applyProposal",
    "attachResolverSession",
    "cancelResolverSession",
    "commitExternalResolverRun",
    "finalizeResolverSession",
    "getBatchAssessment",
    "getLaneStatus",
    "getRiskMatrix",
    "listExternalResolverRuns",
    "listOverlaps",
    "listProposals",
    "prepareProposal",
    "prepareResolverSession",
    "rebaseLane",
    "requestProposal",
    "runExternalResolver",
    "runPrediction",
    "simulateMerge",
    "suggestResolverTarget",
    "undoProposal",
    "scanRebaseNeeds",
    "getRebaseNeed",
    "dismissRebase",
    "deferRebase",
  ],
  pr: [
    "addComment",
    "aiResolutionGetSession",
    "aiResolutionInput",
    "aiResolutionStart",
    "aiResolutionStop",
    "aiReviewSummary",
    "cleanupBranch",
    "cleanupIntegrationWorkflow",
    "closePr",
    "commitIntegration",
    "createFromLane",
    "createLaneFromPrBranch",
    "createIntegrationLane",
    "createIntegrationLaneForProposal",
    "createIntegrationPr",
    "createQueuePrs",
    "delete",
    "deleteIntegrationProposal",
    "dismissIntegrationCleanup",
    "draftDescription",
    "getActionRuns",
    "getActionRunsByGithub",
    "getActivity",
    "getActivityByGithub",
    "getChecks",
    "getChecksByGithub",
    "getStatusByGithub",
    "getComments",
    "getCommentsByGithub",
    "getCommits",
    "getCommitsByGithub",
    "getConflictAnalysis",
    "getDetail",
    "getDetailByGithub",
    "getDeployments",
    "getForLane",
    "getFiles",
    "getFilesByGithub",
    "getGithubSnapshot",
    "getIntegrationResolutionState",
    "getMergeContext",
    "getMergeContexts",
    "getMobileSnapshot",
    "getPrHealth",
    "getQueueState",
    "getAiSummary",
    "getReviewThreads",
    "getReviewThreadsByGithub",
    "getReviews",
    "getReviewsByGithub",
    "getStatus",
    "ingestGithubWebhook",
    "land",
    "landQueueNext",
    "landStack",
    "landStackEnhanced",
    "linkToLane",
    "listAll",
    "listQueueStates",
    "listGroupPrs",
    "listIntegrationProposals",
    "listIntegrationWorkflows",
    "listPrsByLane",
    "listOpenPullRequests",
    "listSnapshots",
    "listWithConflicts",
    "postReviewComment",
    "reactToComment",
    "recheckIntegrationStep",
    "refresh",
    "reorderQueuePrs",
    "requestReviewers",
    "resolveReviewThread",
    "retargetBase",
    "reopenPr",
    "replyToReviewThread",
    "rerunChecks",
    "regenerateAiSummary",
    "setLabels",
    "setReviewThreadResolved",
    "simulateIntegration",
    "startIntegrationResolution",
    "startQueueAutomation",
    "pauseQueueAutomation",
    "preflightCreateLaneFromPrBranch",
    "resumeQueueAutomation",
    "cancelQueueAutomation",
    "submitReview",
    "updateBody",
    "updateBranch",
    "updateComment",
    "updateDescription",
    "updateIntegrationProposal",
    "updateTitle",
  ],
  tests: ["getLogTail", "listRuns", "listSuites", "run", "stop"],
  chat: [
    "archiveSession",
    "cancelDispatchedSteer",
    "cancelSteer",
    "createSession",
    "deleteSession",
    "dispatchSteer",
    "editSteer",
    "ensureCtoSession",
    "getAvailableModels",
    "getClaudeSessionInfo",
    "getClaudeSessionMessages",
    "getChatEventHistory",
    "getChatEventHistoryPage",
    "getContextUsage",
    "getImageDataUrl",
    "getMainTranscript",
    "getSubagentTranscript",
    "setCodexGoal",
    "setCodexGoalStatus",
    "clearCodexGoal",
    "getCodexGoal",
    "listClaudeOutputStyles",
    "getSessionCapabilities",
    "getSessionSummary",
    "getSlashCommands",
    "getTurnFileDiff",
    "getParallelLaunchState",
    "interrupt",
    "recoverCodexTurn",
    "recoverContinuity",
    "killDroidWorker",
    "launchCli",
    "launchHeadless",
    "listClaudePlugins",
    "listClaudeSessions",
    "listSessions",
    "listSubagents",
    "messageSession",
    "modelCatalog",
    "approveToolUse",
    "codexFuzzyFileSearch",
    "fileSearch",
    "handoffSession",
    "prepareCrossMachineHandoff",
    "validateCrossMachineSource",
    "preflightCrossMachineDestination",
    "acceptCrossMachineHandoff",
    "markCrossMachineHandoff",
    "respondToInput",
    "reloadClaudePlugins",
    "rewindFiles",
    "saveTempAttachment",
    "sendMessage",
    "readTranscript",
    "setClaudeOutputStyle",
    "setParallelLaunchState",
    "setScheduledWorkPaused",
    "steer",
    "suggestLaneNameFromPrompt",
    "unarchiveSession",
    "updateSession",
    "warmupModel",
  ],
  keybindings: ["get", "set"],
  ai: [
    "getStatus",
    "getOpenCodeRuntimeDiagnostics",
    "isOpenCodeInstalled",
    "verifyApiKeyConnection",
    "storeApiKey",
    "deleteApiKey",
    "listApiKeys",
    "updateConfig",
    "listCursorCloudRepositories",
    "listCursorCloudAgents",
    "listCursorCloudRuns",
    "createCursorCloudRun",
    "archiveCursorCloudAgent",
    "unarchiveCursorCloudAgent",
    "deleteCursorCloudAgent",
    "getCursorCloudAgent",
    "listCursorCloudArtifacts",
    "downloadCursorCloudArtifact",
    "cursorCloudStreamRun",
    "cancelCursorCloudRun",
    "cursorCloudFollowUp",
    "openCursorCloudChat",
  ],
  onboarding: [
    "complete",
    "detectDefaults",
    "detectExistingLanes",
    "getStatus",
    "markGlossaryTermSeen",
    "setDismissed",
  ],
  automation_planner: ["parseNaturalLanguage", "saveDraft", "simulate", "validateDraft"],
  cto_state: [
    "completeOnboardingStep",
    "dismissOnboarding",
    "getIdentity",
    "getOnboardingState",
    "getSessionLogs",
    "getSnapshot",
    "previewSystemPrompt",
    "resetOnboarding",
    "runProjectScan",
    "updateIdentity",
  ],
  cto_memory: ["getSnapshot", "searchMemory", "updateMemory"],
  session: ["backfillDeltas", "deleteSession", "get", "getDelta", "list", "readTranscriptTail", "updateMeta"],
  operation: ["finish", "get", "list", "start"],
  ade_project: ["clearLocalData", "getSnapshot", "initializeOrRepair", "runIntegrityCheck"],
  project_config: ["confirmTrust", "diffAgainstDisk", "get", "save", "setPrTranscriptGists", "validate"],
  project_secret: ["list", "get", "set", "delete"],
  linear_credentials: [
    "clearOAuthClientCredentials",
    "clearToken",
    "getStatus",
    "setOAuthClientCredentials",
    "setOAuthToken",
    "setToken",
  ],
  linear_oauth: [
    "getSession",
    "startSession",
  ],
  linear_issue_tracker: [
    "addIssueLabel",
    "addLabel",
    "createComment",
    "fetchIssueById",
    "fetchIssuesByIds",
    "fetchIssueComments",
    "graphql",
    "getIssuePickerData",
    "getConnectionStatus",
    "getQuickView",
    "getStatus",
    "getWorkflowCatalog",
    "listLabels",
    "listIssues",
    "listProjects",
    "listWorkflowStates",
    "listUsers",
    "removeIssueLabel",
    "searchIssues",
    "updateComment",
    "updateIssueAssignee",
    "updateIssueState",
  ],
  github: [
    "clearToken",
    "clearAppUserAuth",
    "detectRepo",
    "getAppInstallationStatus",
    "getAppUserAuthStatus",
    "getRepoOrThrow",
    "getRemoteStatus",
    "getStatus",
    "createRepoAutolink",
    "listRepoAutolinks",
    "listRepoCollaborators",
    "listRepoLabels",
    "pollAppUserDeviceAuth",
    "publishCurrentProject",
    "setToken",
    "startAppUserDeviceAuth",
  ],
  feedback: ["list", "prepareDraft", "submitPreparedDraft"],
  usage: [
    "forceRefresh",
    "getAdeUsageStats",
    "getUsageSnapshot",
    "noteQuotaDemand",
    "refreshHistory",
    "poll",
    "start",
    "stop",
  ],
  analytics: ["capture", "getStatus", "setEnabled", "flush"],
  storage: ["cleanup", "cleanupPreview", "compressNow", "getSnapshot"],
  budget: ["checkBudget", "getConfig", "getCumulativeUsage", "recordUsage", "updateConfig"],
  update: ["checkForUpdates", "dismissInstalledNotice", "getSnapshot", "quitAndInstall"],
  file: [
    "blame",
    "createDirectory",
    "createFile",
    "deletePath",
    "listTree",
    "listTreeChildren",
    "listWorkspaces",
    "quickOpen",
    "readFile",
    "readFileRange",
    "refreshGitDecorations",
    "rename",
    "searchText",
    "stopWatching",
    "watchWorkspace",
    "writeTextAtomic",
    "writeWorkspaceText",
  ],
  process: [
    "getLogTail",
    "kill",
    "listDefinitions",
    "listRuntime",
    "restart",
    "restartGroup",
    "restartStack",
    "start",
    "startAll",
    "startGroup",
    "startStack",
    "stop",
    "stopAll",
    "stopGroup",
    "stopStack",
  ],
  pty: ["create", "dispose", "list", "resize", "resumeSession", "sendToSession", "write"],
  terminal: ["list", "read", "preview", "write", "resize", "signal", "activeForChat", "reattachChatCli"],
  layout: ["get", "set"],
  tiling_tree: ["get", "set"],
  graph_state: ["get", "set"],
  computer_use_artifacts: ["getOwnerSnapshot", "getBackendStatus", "ingest", "listArtifacts", "readArtifactPreview", "routeArtifact", "updateArtifactReview"],
  ios_simulator: ["getStatus", "claim", "listDevices", "listLaunchTargets", "launch", "attachToChatSession", "shutdown", "screenshot", "getScreenSnapshot", "getInspectorSnapshot", "inspectPoint", "getPreviewCapability", "listPreviewTargets", "resolvePreviewMatch", "ensurePreviewWorkspace", "renderCurrentPreview", "renderPreview", "openPreviewWorkspace", "startStream", "stopStream", "getStreamStatus", "tap", "typeText", "drag", "swipe", "selectPoint"],
  app_control: ["getStatus", "claim", "launch", "launchInTerminal", "connect", "stop", "focusWindow", "minimizeWindow", "screenshot", "getSnapshot", "inspectPoint", "selectPoint", "click", "typeText", "scroll", "dispatchKey", "listTargets", "attachToTarget", "readTerminal", "writeTerminal", "signalTerminal"],
  built_in_browser: [...BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS],
  automations: [
    "list",
    "get",
    "saveRule",
    "deleteRule",
    "toggleRule",
    "triggerManually",
    "getHistory",
    "listRuns",
    "getRunDetail",
    "getIngressStatus",
    "startIngress",
    "refreshWebhookGatewayStatus",
    "setWebhookGatewayPublicUrl",
    "listIngressEvents",
    "listScheduledCleanups",
    "cancelScheduledCleanup",
    "linearIngressGetStatus",
    "linearIngressSetup",
    "linearIngressTeardown",
    "linearIngressPollNow",
  ],
  review: [
    "cancelRun",
    "deleteSuppression",
    "getRunDetail",
    "listLaunchContext",
    "listRuns",
    "listSuppressions",
    "qualityReport",
    "recordFeedback",
    "rerun",
    "startRun",
  ],
  issue: [
    "addComment",
    "setLabels",
    "close",
    "reopen",
    "assign",
    "setTitle",
  ],
  orchestration: [
    "runCreate",
    "bundleRead",
    "manifestReadSection",
    "manifestPatch",
    "planAppend",
    "planWrite",
    "assetRegister",
    "claimTask",
    "releaseTask",
    "runList",
    "spawnAgent",
    "agentInject",
    "subscribe",
    "unsubscribe",
  ],
  search: ["query", "indexStatus", "rebuildIndex"],
  "external-sessions": ["list", "import"],
};

export type AdeActionInputContract = {
  description?: string;
  input?: string;
  example?: string;
};

const ADE_ACTION_INPUT_CONTRACTS: Partial<Record<AdeActionDomain, Partial<Record<string, AdeActionInputContract>>>> = {
  project_secret: {
    list: {
      description: "List ADE project secret names and metadata without revealing values.",
      input: "no input",
      example: "ade secrets list --text",
    },
    get: {
      description: "Read one ADE project secret value when the user explicitly asked for that secret.",
      input: "object { name: string }",
      example: "ade secrets get STRIPE_API_KEY --text",
    },
    set: {
      description: "Create or replace one ADE project secret.",
      input: "object { name: string, value: string }",
      example: "ade secrets set STRIPE_API_KEY --value sk_test_...",
    },
    delete: {
      description: "Delete one ADE project secret.",
      input: "object { name: string, confirmName: string }",
      example: "ade secrets delete STRIPE_API_KEY",
    },
  },
  analytics: {
    capture: {
      description: "Capture one privacy-bounded ADE product event. Event names and properties are strictly allowlisted and quota limited.",
      input: "object { event, surface, properties?, projectId?, sessionId?, clientEventId?, occurredAt?, dedupeKey?, minimumIntervalMs? }",
      example: "ade actions run analytics.capture --input-json '{\"event\":\"ade_screen_viewed\",\"surface\":\"tui\",\"properties\":{\"screen\":\"details_help\"}}'",
    },
    getStatus: {
      description: "Read anonymous product analytics configuration and local daily budget counters.",
      input: "no input",
      example: "ade actions run analytics.getStatus --text",
    },
  },
  chat: {
    createSession: {
      description: "Create a persistent ADE Work chat session.",
      input: "object { laneId?, provider?, model?/modelId?, reasoningEffort?, permissionMode?, fastMode?, title?, surface? }",
      example: "ade actions run chat.createSession --input-json '{\"laneId\":\"lane-1\",\"provider\":\"codex\",\"model\":\"openai/gpt-5.6-sol\",\"reasoningEffort\":\"xhigh\",\"permissionMode\":\"full-auto\",\"fastMode\":false}'",
    },
    getAvailableModels: {
      description: "List available chat models, optionally filtered by provider.",
      input: "object { provider?: \"claude\" | \"codex\" | \"cursor\" | \"droid\" | \"opencode\" }",
      example: "ade actions run chat.getAvailableModels --input-json '{\"provider\":\"codex\"}'",
    },
    getSessionSummary: {
      description: "Read one chat session summary.",
      input: "scalar sessionId string, positional argsList [sessionId], or object { sessionId }",
      example: "ade actions run chat.getSessionSummary --scalar chat-123",
    },
    readTranscript: {
      description: "Read recent user/assistant messages for a chat session.",
      input: "object { sessionId: string, limit?: number, since?: ISO timestamp }",
      example: "ade actions run chat.readTranscript --input-json '{\"sessionId\":\"chat-123\",\"limit\":20}'",
    },
    getChatEventHistory: {
      description: "Read the recent raw chat event stream, including scheduled work, transcript retractions, tool calls, and metadata events.",
      input: "object { sessionId: string, maxEvents?: number, maxBytes?: number } or argsList [sessionId, options?]",
      example: "ade actions run chat.getChatEventHistory --input-json '{\"sessionId\":\"chat-123\",\"maxEvents\":128}' --json",
    },
    getChatEventHistoryPage: {
      description: "Page older raw chat events before an event-history byte offset.",
      input: "object { sessionId: string, beforeOffset: number, maxBytes?: number } or argsList [sessionId, options]",
      example: "ade actions run chat.getChatEventHistoryPage --input-json '{\"sessionId\":\"chat-123\",\"beforeOffset\":4096,\"maxBytes\":65536}' --json",
    },
    sendMessage: {
      description: "Send a user message to a chat session; provider dispatch continues asynchronously.",
      input: "object { sessionId: string, text: string, attachments? }",
      example: "ade actions run chat.sendMessage --input-json '{\"sessionId\":\"chat-123\",\"text\":\"next step\"}'",
    },
    messageSession: {
      description: "Deliver a message to a chat using ADE-normalized routing: auto steers active turns, wakes idle chats, queues non-urgent context, or interrupts and replaces.",
      input: "object { sessionId: string, text: string, kind?: \"auto\" | \"queue\" | \"wake\" | \"interrupt-replace\", attachments?, contextAttachments?, metadata? }",
      example: "ade actions run chat.messageSession --input-json '{\"sessionId\":\"chat-123\",\"kind\":\"auto\",\"text\":\"use this context\"}'",
    },
    modelCatalog: {
      description: "Read the provider/model catalog, including reasoning tiers and fast service tiers.",
      input: "object { mode?: \"cached\" | \"refresh-stale\" | \"force\", refreshProvider?: string, cursorSource?: string }",
      example: "ade actions run chat.modelCatalog --input-json '{\"mode\":\"cached\"}' --json",
    },
    recoverCodexTurn: {
      description: "Recover a stalled Codex turn by waiting, nudging it, retrying on the same thread, or restarting and resuming the thread.",
      input: "object { sessionId: string, turnId: string, action: \"wait\" | \"steer\" | \"interrupt_retry_same_thread\" | \"restart_resume_thread\" }",
      example: "ade actions run chat.recoverCodexTurn --input-json '{\"sessionId\":\"chat-123\",\"turnId\":\"turn-456\",\"action\":\"wait\"}'",
    },
    recoverContinuity: {
      description: "Explicitly reconnect, reconstruct, or supersede a chat whose provider thread could not be resumed.",
      input: "object { sessionId: string, mode: \"retry_original\" | \"recover_from_history\" | \"start_new_chat\" }",
      example: "ade actions run chat.recoverContinuity --input-json '{\"sessionId\":\"chat-123\",\"mode\":\"retry_original\"}'",
    },
  },
  "external-sessions": {
    list: {
      description: "List provider-native CLI sessions found outside ADE.",
      input: "object { providers?, laneId?, cwd?, scope?: \"project\" | \"all\", limit? }",
      example: "ade actions run external-sessions.list --input-json '{\"scope\":\"project\",\"limit\":20}' --text",
    },
    import: {
      description: "Import an outside provider CLI session into an ADE lane as a CLI terminal or chat.",
      input: "object { provider, sessionId, laneId, target: \"cli\" | \"chat\", mode: \"resume\" | \"fork\", model?, permissionMode? }",
      example: "ade actions run external-sessions.import --input-json '{\"provider\":\"codex\",\"sessionId\":\"thread-id\",\"laneId\":\"lane-1\",\"target\":\"cli\",\"mode\":\"resume\"}' --text",
    },
  },
};

export function getAdeActionInputContract(
  domain: AdeActionDomain,
  action: string,
): AdeActionInputContract | undefined {
  return ADE_ACTION_INPUT_CONTRACTS[domain]?.[action];
}

type AutomationsDomainService = {
  list(): AutomationRuleSummary[];
  get(args: { id: string }): AutomationRule | null;
  saveRule(args: AutomationSaveDraftRequest): AutomationSaveDraftResult;
  deleteRule(args: { id: string }): AutomationRuleSummary[];
  toggleRule(args: { id: string; enabled: boolean }): AutomationRuleSummary[];
  triggerManually(args: AutomationManualTriggerRequest): Promise<AutomationRun>;
  getHistory(args: { id: string; limit?: number }): AutomationRun[];
  listRuns(args?: AutomationRunListArgs): AutomationRun[];
  getRunDetail(args: { runId: string }): Promise<AutomationRunDetail | null>;
  getIngressStatus(): AutomationIngressStatus;
  startIngress(): Promise<AutomationIngressStatus>;
  refreshWebhookGatewayStatus(): Promise<AutomationIngressStatus["webhookGateway"]>;
  setWebhookGatewayPublicUrl(args?: { publicUrl?: string | null }): Promise<AutomationIngressStatus["webhookGateway"]>;
  listIngressEvents(args?: { limit?: number }): AutomationIngressEventRecord[];
  listScheduledCleanups(): AutomationScheduledCleanup[];
  cancelScheduledCleanup(args: { id: string }): boolean;
  linearIngressGetStatus(): LinearIngressStatus;
  linearIngressSetup(): Promise<LinearIngressStatus>;
  linearIngressTeardown(): Promise<LinearIngressStatus>;
  linearIngressPollNow(): Promise<LinearIngressStatus>;
};

function buildAutomationsDomainService(runtime: AdeRuntime): AutomationsDomainService | null {
  const automationService = runtime.automationService;
  const plannerService = runtime.automationPlannerService;
  const projectConfigService = runtime.projectConfigService;
  if (!automationService || !plannerService || !projectConfigService) return null;
  return {
    list: () => automationService.list(),
    get: ({ id }) => {
      const trimmed = id?.trim();
      if (!trimmed) return null;
      return projectConfigService.get().effective.automations.find((r) => r.id === trimmed) ?? null;
    },
    saveRule: (args) => plannerService.saveDraft(args),
    deleteRule: ({ id }) => automationService.deleteRule({ id }),
    toggleRule: ({ id, enabled }) => automationService.toggle({ id, enabled }),
    triggerManually: (args) => automationService.triggerManually(args),
    getHistory: (args) => automationService.getHistory(args),
    listRuns: (args = {}) => automationService.listRuns(args),
    getRunDetail: ({ runId }) => automationService.getRunDetail({ runId }),
    getIngressStatus: () => automationService.getIngressStatus(),
    startIngress: async () => {
      if (!runtime.automationIngressService) throw new Error("Automation ingress service is not available.");
      await runtime.automationIngressService.start();
      return automationService.getIngressStatus();
    },
    refreshWebhookGatewayStatus: () => automationService.refreshWebhookGatewayStatus(),
    setWebhookGatewayPublicUrl: (args = {}) => automationService.setWebhookGatewayPublicUrl(args),
    listIngressEvents: (args = {}) => automationService.listIngressEvents(args.limit),
    listScheduledCleanups: () => automationService.listScheduledCleanups(),
    cancelScheduledCleanup: ({ id }) => automationService.cancelScheduledCleanup(id),
    linearIngressGetStatus: () => requireLinearIngress(runtime).getStatus(),
    linearIngressSetup: () => requireLinearIngress(runtime).setup(),
    linearIngressTeardown: () => requireLinearIngress(runtime).teardown(),
    linearIngressPollNow: async () => {
      const service = requireLinearIngress(runtime);
      await service.pollNow();
      return service.getStatus();
    },
  };
}

function requireLinearIngress(runtime: AdeRuntime): NonNullable<AdeRuntime["linearIngressService"]> {
  const service = runtime.linearIngressService;
  if (!service) throw new Error("Linear ingress is not available on this runtime.");
  return service;
}

type IssueDomainService = {
  addComment(args: { owner?: string; name?: string; number: number; body: string }): Promise<unknown>;
  setLabels(args: { owner?: string; name?: string; number: number; labels: string[] }): Promise<unknown>;
  close(args: { owner?: string; name?: string; number: number; reason?: "completed" | "not_planned" }): Promise<unknown>;
  reopen(args: { owner?: string; name?: string; number: number }): Promise<unknown>;
  assign(args: { owner?: string; name?: string; number: number; assignees: string[] }): Promise<unknown>;
  setTitle(args: { owner?: string; name?: string; number: number; title: string }): Promise<unknown>;
};

function buildIssueDomainService(runtime: AdeRuntime): IssueDomainService | null {
  const githubService = runtime.githubService;
  if (!githubService) return null;

  const resolveRepo = async (owner?: string, name?: string): Promise<{ owner: string; name: string }> => {
    if (owner && name) return { owner, name };
    const repo = await githubService.detectRepo();
    if (!repo) throw new Error("Unable to detect GitHub repo; pass owner/name explicitly.");
    return { owner: repo.owner, name: repo.name };
  };

  return {
    addComment: async ({ owner, name, number, body }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.addIssueComment(repo.owner, repo.name, number, body);
    },
    setLabels: async ({ owner, name, number, labels }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.setIssueLabels(repo.owner, repo.name, number, labels);
    },
    close: async ({ owner, name, number, reason }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.closeIssue(repo.owner, repo.name, number, reason);
    },
    reopen: async ({ owner, name, number }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.reopenIssue(repo.owner, repo.name, number);
    },
    assign: async ({ owner, name, number, assignees }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.assignIssue(repo.owner, repo.name, number, assignees);
    },
    setTitle: async ({ owner, name, number, title }) => {
      const repo = await resolveRepo(owner, name);
      return githubService.setIssueTitle(repo.owner, repo.name, number, title);
    },
  };
}

type OpaqueService = Record<string, unknown>;

function toService(value: unknown): OpaqueService | null {
  return (value ?? null) as OpaqueService | null;
}

function buildOrchestrationDomainService(runtime: AdeRuntime): OpaqueService | null {
  const orchestrationService = runtime.orchestrationService;
  const laneService = runtime.laneService;
  const agentChatService = runtime.agentChatService;
  if (!orchestrationService || !laneService || !agentChatService) return null;
  return createOrchestrationDomainService({
    orchestrationService,
    laneService: { getLaneWorktreePath: (laneId: string) => laneService.getLaneWorktreePath(laneId) },
    agentChatService,
  }) as unknown as OpaqueService;
}

const MAX_TEMP_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const FILE_SEARCH_SESSION_LANE_CACHE_MAX = 200;
// Only non-identity sessions are cached: a regular chat session's lane binding
// is immutable (updateSession exposes no laneId; handoffs create new sessions),
// but resumeSession can migrate a primary-pinned identity (CTO/worker) session
// to the canonical primary lane, so those resolve fresh every call.
const fileSearchLaneIdBySessionId = new Map<string, string>();

function agentChatParallelLaunchStateKey(projectRoot: string, parentLaneId: string): string {
  return `agent-chat-parallel-launch:${projectRoot}:${parentLaneId}`;
}

function rememberFileSearchLaneId(sessionId: string, laneId: string): void {
  if (fileSearchLaneIdBySessionId.has(sessionId)) {
    fileSearchLaneIdBySessionId.delete(sessionId);
  }
  fileSearchLaneIdBySessionId.set(sessionId, laneId);
  while (fileSearchLaneIdBySessionId.size > FILE_SEARCH_SESSION_LANE_CACHE_MAX) {
    const oldest = fileSearchLaneIdBySessionId.keys().next().value;
    if (typeof oldest !== "string") break;
    fileSearchLaneIdBySessionId.delete(oldest);
  }
}

function readSessionLaneId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const laneId = value.laneId;
  return typeof laneId === "string" && laneId.trim() ? laneId.trim() : null;
}

function isLaneCacheableSession(value: unknown): boolean {
  return isRecord(value) && !value.identityKey;
}

async function resolveFileSearchLaneId(agentChatService: unknown, sessionId: string): Promise<string | null> {
  const cached = fileSearchLaneIdBySessionId.get(sessionId);
  if (cached) return cached;

  const service = agentChatService as {
    getSessionSummary?: (sessionId: string) => Promise<unknown> | unknown;
    listSessions?: () => Promise<unknown> | unknown;
  };

  if (typeof service.getSessionSummary === "function") {
    try {
      const summary = await service.getSessionSummary(sessionId);
      const laneId = readSessionLaneId(summary);
      if (laneId) {
        if (isLaneCacheableSession(summary)) rememberFileSearchLaneId(sessionId, laneId);
        return laneId;
      }
    } catch {
      // Fall back to listSessions below for older or partially available runtimes.
    }
  }

  if (typeof service.listSessions !== "function") return null;
  const sessions = await service.listSessions();
  if (!Array.isArray(sessions)) return null;
  const session = sessions.find((entry) => isRecord(entry) && entry.sessionId === sessionId);
  const laneId = readSessionLaneId(session);
  if (laneId) {
    if (isLaneCacheableSession(session)) rememberFileSearchLaneId(sessionId, laneId);
  }
  return laneId;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeAgentChatParallelLaunchState(
  raw: unknown,
  parentLaneId: string,
): AgentChatParallelLaunchState | null {
  if (!isRecord(raw)) return null;
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!["creating_lanes", "sending", "completed", "cleanup_pending"].includes(status)) return null;
  return {
    parentLaneId,
    createdLaneIds: normalizeStringList(raw.createdLaneIds),
    sentLaneIds: normalizeStringList(raw.sentLaneIds),
    status: status as AgentChatParallelLaunchState["status"],
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt.trim().length
      ? raw.updatedAt
      : new Date().toISOString(),
    lastError: typeof raw.lastError === "string" && raw.lastError.trim().length ? raw.lastError.trim() : null,
  };
}

async function getTurnFileDiffFromGit(
  projectRoot: string,
  arg: AgentChatGetTurnFileDiffArgs,
): Promise<AgentChatTurnFileDiff> {
  const lang = arg.filePath.split(".").pop() ?? undefined;
  const readSide = async (spec: string): Promise<{
    exists: boolean;
    text: string;
    isTruncated?: boolean;
    isBinary?: boolean;
  }> => {
    const result = await runGit(["show", spec], {
      cwd: projectRoot,
      timeoutMs: 10_000,
      maxOutputBytes: MAX_DIFF_SIDE_TEXT_BYTES + 64 * 1024,
    });
    if (result.exitCode !== 0) return { exists: false, text: "" };
    const buf = Buffer.from(result.stdout, "utf8");
    if (buf.includes(0)) return { exists: true, text: "", isBinary: true };
    if (buf.length <= MAX_DIFF_SIDE_TEXT_BYTES) return { exists: true, text: result.stdout };
    return {
      exists: true,
      text: appendDiffTruncationNotice(buf.subarray(0, MAX_DIFF_SIDE_TEXT_BYTES).toString("utf8")),
      isTruncated: true,
    };
  };
  const origResult = await readSide(`${arg.beforeSha}:${arg.filePath}`);
  const modResult = await readSide(`${arg.afterSha}:${arg.filePath}`);
  return {
    path: arg.filePath,
    mode: "commit",
    ...(lang ? { language: lang } : {}),
    original: origResult,
    modified: modResult,
    ...(origResult.isBinary || modResult.isBinary ? { isBinary: true } : {}),
  };
}

async function saveAgentChatTempAttachment(projectRoot: string, arg: { data?: string; filename?: string }): Promise<{ path: string }> {
  const maxEncodedLength = Math.ceil(MAX_TEMP_ATTACHMENT_BYTES / 3) * 4;
  if (typeof arg.data !== "string") {
    throw new Error("Temporary attachment data is required.");
  }
  if (arg.data.length > maxEncodedLength) {
    throw new Error("Temporary attachments must be 10 MB or smaller.");
  }
  const content = Buffer.from(arg.data, "base64");
  if (content.byteLength > MAX_TEMP_ATTACHMENT_BYTES) {
    throw new Error("Temporary attachments must be 10 MB or smaller.");
  }
  const baseDir = path.join(projectRoot, ".ade", "attachments");
  await fs.promises.mkdir(baseDir, { recursive: true });
  const filename = typeof arg.filename === "string" ? arg.filename : "";
  const ext = path.extname(filename) || ".png";
  const destPath = path.join(baseDir, `${randomUUID()}${ext}`);
  await fs.promises.writeFile(destPath, content);
  return { path: destPath };
}

function resolveAgentChatImagePath(projectRoot: string, rawPath: unknown): string {
  const value = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!value) throw new Error("Image path is required.");
  try {
    return resolvePathWithinRoot(projectRoot, value);
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes root") {
      throw new Error("Image path must be inside the project.");
    }
    throw error;
  }
}

function sniffImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
    && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return "image/jpeg";
  }
  if (buffer.length >= 6
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38
    && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return "image/gif";
  }
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return "image/webp";
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return "image/bmp";
  }
  if (buffer.length >= 4
    && buffer[0] === 0x00 && buffer[1] === 0x00
    && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return "image/x-icon";
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("utf8");
  const stripped = head.replace(/^\uFEFF/, "").trimStart();
  if (/^<\?xml\b/i.test(stripped) && /<svg\b/i.test(head)) {
    return "image/svg+xml";
  }
  if (/^<svg\b/i.test(stripped)) {
    return "image/svg+xml";
  }
  return null;
}

async function getAgentChatImageDataUrl(projectRoot: string, arg: { path?: string }): Promise<{ dataUrl: string }> {
  const imagePath = resolveAgentChatImagePath(projectRoot, arg.path);
  const stat = await fs.promises.stat(imagePath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file.");
  }
  if (stat.size > MAX_TEMP_ATTACHMENT_BYTES) {
    throw new Error("Image must be 10 MB or smaller.");
  }
  const data = await fs.promises.readFile(imagePath);
  const mimeType = sniffImageMimeType(data);
  if (!mimeType) {
    throw new Error("Path is not an image.");
  }
  return { dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
}

function buildChatDomainService(runtime: AdeRuntime): OpaqueService | null {
  const agentChatService = runtime.agentChatService;
  if (!agentChatService) return null;
  const base = agentChatService as unknown as OpaqueService;
  const service: OpaqueService = {
    ...base,
    ensureCtoSession: async (args?: { modelId?: string | null; reasoningEffort?: string | null }) => {
      const laneId = await resolvePrimaryLaneId(runtime);
      return agentChatService.ensureIdentitySession({
        identityKey: "cto",
        laneId,
        modelId: args?.modelId ?? null,
        reasoningEffort: args?.reasoningEffort ?? null,
        permissionMode: "full-auto",
      });
    },
    getParallelLaunchState: (args?: { parentLaneId?: string }) => {
      const parentLaneId = requireNonEmptyString(args?.parentLaneId, "parentLaneId");
      const key = agentChatParallelLaunchStateKey(runtime.projectRoot, parentLaneId);
      return normalizeAgentChatParallelLaunchState(
        runtime.db.getJson<AgentChatParallelLaunchState | null>(key),
        parentLaneId,
      );
    },
    launchCli: async (
      args: AgentChatLaunchCliArgs,
    ): Promise<AgentChatLaunchCliResult> =>
      launchAgentChatCli(args, {
        laneService: requireService(
          runtime.laneService,
          "Lane service not available.",
        ),
        ptyService: requireService(
          runtime.ptyService,
          "Terminal service not available.",
        ),
      }),
    listSessions: (args?: unknown) => {
      const record = asActionRecord(args);
      const laneId = typeof record.laneId === "string" && record.laneId.trim()
        ? record.laneId.trim()
        : undefined;
      const options = {
        ...(typeof record.includeArchived === "boolean" ? { includeArchived: record.includeArchived } : {}),
        ...(typeof record.includeAutomation === "boolean" ? { includeAutomation: record.includeAutomation } : {}),
        ...(typeof record.includeIdentity === "boolean" ? { includeIdentity: record.includeIdentity } : {}),
      };
      return agentChatService.listSessions(
        laneId,
        Object.keys(options).length ? options : undefined,
      );
    },
    readTranscript: async (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.readTranscript");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const limitValue = record.limit;
      const parsedLimit = typeof limitValue === "number"
        ? limitValue
        : typeof limitValue === "string" && limitValue.trim()
          ? Number.parseInt(limitValue, 10)
          : undefined;
      const limit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(500, Math.floor(parsedLimit)))
        : undefined;
      const since = typeof record.since === "string" && record.since.trim()
        ? record.since.trim()
        : undefined;
      const chatService = agentChatService as {
        readTranscript?: (sessionId: string, limit?: number, since?: string) => Promise<unknown> | unknown;
        getChatTranscript?: (args: { sessionId: string; limit?: number }) => Promise<unknown> | unknown;
      };
      if (typeof chatService.readTranscript === "function") {
        return chatService.readTranscript(sessionId, limit, since);
      }
      if (typeof chatService.getChatTranscript === "function") {
        const transcript = await chatService.getChatTranscript({
          sessionId,
          ...(limit !== undefined ? { limit } : {}),
        });
        if (!since || !isRecord(transcript) || !Array.isArray(transcript.entries)) {
          return transcript;
        }
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) return transcript;
        return {
          ...transcript,
          entries: transcript.entries.filter((entry) => {
            if (!isRecord(entry) || typeof entry.timestamp !== "string") return true;
            const timestampMs = Date.parse(entry.timestamp);
            return !Number.isFinite(timestampMs) || timestampMs >= sinceMs;
          }),
        };
      }
      throw new Error("Chat transcript reads are not available in this runtime.");
    },
    sendMessage: async (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.sendMessage");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = requireNonEmptyString(record.text, "text");
      await agentChatService.sendMessage({ ...record, sessionId, text } as never);
      return {
        ok: true,
        accepted: true,
        sessionId,
        note: "Message accepted by the ADE chat service; provider dispatch continues asynchronously.",
      };
    },
    messageSession: async (args?: unknown) => {
      const record = readObjectActionArg(args, "chat.messageSession");
      const sessionId = requireNonEmptyString(record.sessionId, "sessionId");
      const text = requireNonEmptyString(record.text, "text");
      if (typeof agentChatService.messageSession !== "function") {
        throw new Error("Chat messageSession is not available in this runtime.");
      }
      return agentChatService.messageSession({ ...record, sessionId, text } as never);
    },
    setParallelLaunchState: (args?: AgentChatSetParallelLaunchStateArgs) => {
      const parentLaneId = requireNonEmptyString(args?.parentLaneId, "parentLaneId");
      const key = agentChatParallelLaunchStateKey(runtime.projectRoot, parentLaneId);
      runtime.db.setJson(key, normalizeAgentChatParallelLaunchState(args?.state ?? null, parentLaneId));
    },
    fileSearch: async (args?: AgentChatFileSearchArgs): Promise<AgentChatFileSearchResult[]> => {
      const sessionId = requireNonEmptyString(args?.sessionId, "sessionId");
      const query = typeof args?.query === "string" ? args.query : "";
      const laneId = await resolveFileSearchLaneId(agentChatService, sessionId);
      if (!laneId || !runtime.fileService) return [];
      if (!query.trim()) {
        const warmQuickOpenIndex = (runtime.fileService as {
          warmQuickOpenIndex?: (args: { workspaceId: string; includeIgnored?: boolean }) => Promise<void>;
        }).warmQuickOpenIndex;
        if (typeof warmQuickOpenIndex === "function") {
          void warmQuickOpenIndex({ workspaceId: laneId }).catch(() => undefined);
        }
        return [];
      }
      const matches = await runtime.fileService.quickOpen({
        workspaceId: laneId,
        query,
        limit: 20,
      });
      return matches.map((match) => ({
        path: match.path,
        ...(typeof match.score === "number" ? { score: match.score } : {}),
      }));
    },
    getTurnFileDiff: (args?: AgentChatGetTurnFileDiffArgs) => {
      if (!args) throw new Error("Turn file diff args are required.");
      return getTurnFileDiffFromGit(runtime.projectRoot, args);
    },
    saveTempAttachment: (args?: { data?: string; filename?: string }) =>
      saveAgentChatTempAttachment(runtime.projectRoot, args ?? {}),
    getImageDataUrl: (args?: { path?: string }) =>
      getAgentChatImageDataUrl(runtime.projectRoot, args ?? {}),
  };
  if (typeof base.createSession === "function") {
    service.createSession = (args?: unknown) =>
      agentChatService.createSession(readObjectActionArg(args, "chat.createSession") as never);
  }
  if (typeof base.getAvailableModels === "function") {
    service.getAvailableModels = (args?: unknown) =>
      agentChatService.getAvailableModels(readObjectActionArg(args, "chat.getAvailableModels") as never);
  }
  if (typeof base.getSessionSummary === "function") {
    service.getSessionSummary = (args?: unknown) =>
      agentChatService.getSessionSummary(readStringActionArg(args, "sessionId"));
  }
  if (typeof base.getChatEventHistory === "function") {
    service.getChatEventHistory = (args?: unknown) => {
      const { sessionId, options } = readChatHistoryActionArgs(args, "chat.getChatEventHistory");
      const maxEvents = readOptionalIntegerActionField(options.maxEvents, "maxEvents");
      const maxBytes = readOptionalIntegerActionField(options.maxBytes, "maxBytes");
      return agentChatService.getChatEventHistory(sessionId, {
        ...(maxEvents !== undefined ? { maxEvents } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
    };
  }
  if (typeof base.getChatEventHistoryPage === "function") {
    service.getChatEventHistoryPage = (args?: unknown) => {
      const { sessionId, options } = readChatHistoryActionArgs(args, "chat.getChatEventHistoryPage");
      const beforeOffset = readOptionalIntegerActionField(options.beforeOffset, "beforeOffset");
      if (beforeOffset === undefined) {
        throw new Error("Expected 'beforeOffset' to be a finite number.");
      }
      const maxBytes = readOptionalIntegerActionField(options.maxBytes, "maxBytes");
      return agentChatService.getChatEventHistoryPage(sessionId, {
        beforeOffset,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
    };
  }
  if (typeof agentChatService.getModelCatalog === "function") {
    service.modelCatalog = (args?: unknown) =>
      agentChatService.getModelCatalog(readObjectActionArg(args, "chat.modelCatalog") as never);
  }
  return service;
}

async function resolvePrimaryLaneId(runtime: AdeRuntime): Promise<string> {
  const laneService = requireService(runtime.laneService, "Lane service not available.");
  await laneService.ensurePrimaryLane();
  const lanes = await laneService.list();
  const primary = lanes.find((lane) => lane.laneType === "primary");
  if (!primary?.id) {
    throw new Error("No primary lane is available to host the identity chat session.");
  }
  return primary.id;
}

function buildCtoStateDomainService(runtime: AdeRuntime): OpaqueService | null {
  const ctoStateService = runtime.ctoStateService;
  if (!ctoStateService) return null;
  return {
    ...(ctoStateService as unknown as OpaqueService),
    runProjectScan: async (): Promise<CtoRunProjectScanResult> => {
      const detection = await runtime.onboardingService?.detectDefaults().catch(() => null) ?? null;
      return { detection };
    },
  };
}

function buildCtoMemoryDomainService(runtime: AdeRuntime): OpaqueService | null {
  const ctoMemoryService = runtime.ctoMemoryService;
  if (!ctoMemoryService) return null;
  return {
    getSnapshot: () => ctoMemoryService.getSnapshot(),
    updateMemory: (args?: { memory?: string }) => {
      // A missing field must not silently blank the durable memory file; only
      // an explicit string (including a deliberate "") is a valid rewrite —
      // and clearing writes archive the replaced content.
      if (typeof args?.memory !== "string") {
        throw new Error("updateMemory requires a string `memory` field.");
      }
      ctoMemoryService.writeMemory(args.memory);
      return ctoMemoryService.getSnapshot();
    },
    searchMemory: (args?: { query?: string; limit?: number }) => {
      const query = args?.query ?? "";
      const rows = ctoMemoryService.searchMemory(query, { limit: args?.limit ?? 20 });
      return { query, rows };
    },
  };
}

function buildComputerUseArtifactsDomainService(runtime: AdeRuntime): OpaqueService | null {
  const broker = runtime.computerUseArtifactBrokerService;
  if (!broker) return null;
  return {
    ...(broker as unknown as OpaqueService),
    getOwnerSnapshot: (args?: ComputerUseOwnerSnapshotArgs) => {
      if (!args?.owner) throw new Error("owner is required.");
      return buildComputerUseOwnerSnapshot({
        broker,
        owner: args.owner,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    },
  };
}

function buildSessionDomainService(runtime: AdeRuntime): OpaqueService | null {
  const sessionService = runtime.sessionService;
  if (!sessionService) return null;
  return {
    ...(sessionService as unknown as OpaqueService),
    deleteSession: (arg?: { sessionId?: string } | string) => {
      const sessionId = typeof arg === "string"
        ? requireNonEmptyString(arg, "sessionId")
        : requireNonEmptyString(arg?.sessionId, "sessionId");
      return deleteTerminalSessionWithRuntimeCleanup({
        sessionId,
        sessionService,
        ptyService: requireService(runtime.ptyService, "Terminal service not available."),
      });
    },
    readTranscriptTail: (args?: ReadTranscriptTailArgs) => {
      const sessionId = requireNonEmptyString(args?.sessionId, "sessionId");
      const maxBytes = typeof args?.maxBytes === "number" && Number.isFinite(args.maxBytes)
        ? Math.max(1024, Math.min(2_000_000, Math.floor(args.maxBytes)))
        : 160_000;
      return runtime.ptyService?.readTranscriptTail({
        sessionId,
        maxBytes,
        raw: args?.raw === true,
        alignToLineBoundary: args?.raw === true,
      }) ?? "";
    },
    getDelta: (args?: { sessionId?: string } | string) => {
      const sessionId = typeof args === "string"
        ? requireNonEmptyString(args, "sessionId")
        : requireNonEmptyString(args?.sessionId, "sessionId");
      return runtime.sessionDeltaService?.getSessionDelta(sessionId) ?? null;
    },
    backfillDeltas: (args?: { limit?: number; since?: string | null }) => {
      const limit = typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(1_000, Math.floor(args.limit)))
        : 500;
      const since = typeof args?.since === "string" && args.since.trim()
        ? args.since.trim()
        : null;
      return runtime.sessionDeltaService?.backfillMissingSessionDeltas({ limit, since }) ?? {
        scanned: 0,
        computed: 0,
        skipped: 0,
        failed: 0,
      };
    },
  };
}

function mergeLaneDockerConfig(
  current: { composePath?: string; services?: string[]; projectPrefix?: string } | undefined,
  next: { composePath?: string; services?: string[]; projectPrefix?: string } | undefined,
) {
  if (!current && !next) return undefined;
  if (!current) return next ? { ...next, ...(next.services ? { services: [...next.services] } : {}) } : undefined;
  if (!next) return { ...current, ...(current.services ? { services: [...current.services] } : {}) };
  return {
    ...current,
    ...next,
    ...(next.services != null
      ? { services: [...next.services] }
      : current.services != null
        ? { services: [...current.services] }
        : {}),
  };
}

function mergeLaneEnvInitConfig(
  current: LaneEnvInitConfig | undefined,
  next: LaneEnvInitConfig | undefined,
): LaneEnvInitConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) {
    return next
      ? {
          ...(next.envFiles ? { envFiles: [...next.envFiles] } : {}),
          ...(mergeLaneDockerConfig(undefined, next.docker) ? { docker: mergeLaneDockerConfig(undefined, next.docker) } : {}),
          ...(next.dependencies ? { dependencies: [...next.dependencies] } : {}),
          ...(next.mountPoints ? { mountPoints: [...next.mountPoints] } : {}),
          ...(next.copyPaths ? { copyPaths: [...next.copyPaths] } : {}),
        }
      : undefined;
  }
  if (!next) {
    return {
      ...(current.envFiles ? { envFiles: [...current.envFiles] } : {}),
      ...(mergeLaneDockerConfig(undefined, current.docker) ? { docker: mergeLaneDockerConfig(undefined, current.docker) } : {}),
      ...(current.dependencies ? { dependencies: [...current.dependencies] } : {}),
      ...(current.mountPoints ? { mountPoints: [...current.mountPoints] } : {}),
      ...(current.copyPaths ? { copyPaths: [...current.copyPaths] } : {}),
    };
  }
  return {
    envFiles: [...(current.envFiles ?? []), ...(next.envFiles ?? [])],
    ...(mergeLaneDockerConfig(current.docker, next.docker) ? { docker: mergeLaneDockerConfig(current.docker, next.docker) } : {}),
    dependencies: [...(current.dependencies ?? []), ...(next.dependencies ?? [])],
    mountPoints: [...(current.mountPoints ?? []), ...(next.mountPoints ?? [])],
    copyPaths: [...(current.copyPaths ?? []), ...(next.copyPaths ?? [])],
  };
}

function mergeLaneOverrides(base: LaneOverlayOverrides, next: Partial<LaneOverlayOverrides>): LaneOverlayOverrides {
  return {
    ...base,
    ...next,
    ...(base.env || next.env ? { env: { ...(base.env ?? {}), ...(next.env ?? {}) } } : {}),
    ...(base.processIds || next.processIds ? { processIds: [...(next.processIds ?? base.processIds ?? [])] } : {}),
    ...(base.testSuiteIds || next.testSuiteIds ? { testSuiteIds: [...(next.testSuiteIds ?? base.testSuiteIds ?? [])] } : {}),
    ...(mergeLaneEnvInitConfig(base.envInit, next.envInit) ? { envInit: mergeLaneEnvInitConfig(base.envInit, next.envInit) } : {}),
  };
}

function applyLeaseToOverrides(overrides: LaneOverlayOverrides, lease: PortLease | null): LaneOverlayOverrides {
  if (!lease || lease.status !== "active" || overrides.portRange) {
    return { ...overrides };
  }
  return {
    ...overrides,
    portRange: { start: lease.rangeStart, end: lease.rangeEnd },
  };
}

function requireService<T>(service: T | null | undefined, message: string): T {
  if (!service) throw new Error(message);
  return service;
}

async function resolveLane(runtime: AdeRuntime, laneId: string) {
  const lanes = await runtime.laneService.list({ includeArchived: true, includeStatus: false });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);
  return lane;
}

async function resolveActiveLaneIds(runtime: AdeRuntime): Promise<string[]> {
  const lanes = await runtime.laneService.list({ includeArchived: false, includeStatus: false });
  return lanes.map((lane) => lane.id);
}

async function resolveLaneOverlayContext(runtime: AdeRuntime, laneId: string) {
  const lane = await resolveLane(runtime, laneId);
  const config = runtime.projectConfigService.getEffective();
  const overlayOverrides = matchLaneOverlayPolicies(lane, config.laneOverlayPolicies ?? []);
  const lease = runtime.portAllocationService?.getLease(lane.id) ?? null;
  const overrides = applyLeaseToOverrides(overlayOverrides, lease);
  const envInitConfig = runtime.laneEnvironmentService?.resolveEnvInitConfig(config.laneEnvInit, overrides);
  return {
    lane,
    overrides,
    envInitConfig,
    lease,
  };
}

async function ensureLanePortLease(runtime: AdeRuntime, laneId: string): Promise<PortLease | null> {
  await resolveLane(runtime, laneId);
  const portAllocationService = runtime.portAllocationService;
  if (!portAllocationService) return null;
  return portAllocationService.getLease(laneId) ?? portAllocationService.acquire(laneId);
}

async function ensureLanePreviewInfo(runtime: AdeRuntime, laneId: string): Promise<LanePreviewInfo | null> {
  const laneProxyService = runtime.laneProxyService;
  const portAllocationService = runtime.portAllocationService;
  if (!laneProxyService || !portAllocationService) return null;

  const lane = await resolveLane(runtime, laneId).catch(() => null);
  if (!lane || lane.archivedAt != null) {
    laneProxyService.removeRoute(laneId);
    return null;
  }

  const lease = portAllocationService.getLease(laneId) ?? portAllocationService.acquire(laneId);
  if (lease.status !== "active") {
    laneProxyService.removeRoute(laneId);
    return null;
  }

  if (!laneProxyService.getStatus().running) {
    await laneProxyService.start().catch((error: unknown) => {
      runtime.logger.warn("lane_proxy.preview_start_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  if (!laneProxyService.getStatus().running) return null;

  const expectedHostname = laneProxyService.generateHostname(laneId, lane.name);
  const health = runtime.runtimeDiagnosticsService
    ? await runtime.runtimeDiagnosticsService.checkLaneHealth(laneId).catch(() => null)
    : null;
  const respondingPort = Number.isInteger(health?.respondingPort)
    && (health?.respondingPort as number) >= lease.rangeStart
    && (health?.respondingPort as number) <= lease.rangeEnd
    ? (health?.respondingPort as number)
    : null;
  const targetPort = respondingPort ?? lease.rangeStart;
  const currentRoute = laneProxyService.getRoute(laneId);
  if (
    !currentRoute ||
    currentRoute.targetPort !== targetPort ||
    currentRoute.hostname !== expectedHostname ||
    currentRoute.status !== "active"
  ) {
    laneProxyService.addRoute(laneId, targetPort, lane.name);
  }
  return laneProxyService.getPreviewInfo(laneId);
}

function buildLaneDomainService(runtime: AdeRuntime): OpaqueService {
  const laneService = runtime.laneService as unknown as OpaqueService;
  return {
    ...laneService,
    listSnapshots: async (args?: ListLanesArgs): Promise<LaneListSnapshot[]> => {
      const lanes = await runtime.laneService.list({
        includeArchived: Boolean(args?.includeArchived),
        includeStatus: args?.includeStatus !== false,
      });
      return buildLaneListSnapshots(
        {
          laneService: runtime.laneService,
          sessionService: runtime.sessionService,
          ptyService: runtime.ptyService,
          agentChatService: runtime.agentChatService ?? null,
          rebaseSuggestionService: runtime.rebaseSuggestionService ?? null,
          autoRebaseService: runtime.autoRebaseService ?? null,
          conflictService: runtime.conflictService ?? null,
          syncService: runtime.syncService ?? null,
          logger: runtime.logger,
        },
        lanes,
        {
          includeConflictStatus: args?.includeConflictStatus !== false,
          includeRebaseSuggestions: args?.includeRebaseSuggestions !== false,
          includeAutoRebaseStatus: args?.includeAutoRebaseStatus !== false,
        },
      );
    },
    listRebaseSuggestions: () => runtime.rebaseSuggestionService?.listSuggestions() ?? [],
    delete: async (args?: DeleteLaneArgs): Promise<void> => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const laneEnvironmentService = runtime.laneEnvironmentService;
      const envContext = laneEnvironmentService
        ? await resolveLaneOverlayContext(runtime, laneId).catch((error: unknown) => {
            runtime.logger.warn("lane_env_cleanup.pre_delete_context_failed", {
              laneId,
              error: getErrorMessage(error),
            });
            return null;
          })
        : null;
      const teardownEnv = laneEnvironmentService && envContext?.envInitConfig
        ? async () => {
            await laneEnvironmentService.cleanupLaneEnvironment(envContext.lane, envContext.envInitConfig);
          }
        : undefined;
      await runtime.laneService.delete({ ...(args ?? {}), laneId }, { teardownEnv });
      runtime.portAllocationService?.release(laneId);
    },
    dismissRebaseSuggestion: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await runtime.rebaseSuggestionService?.dismiss({ laneId });
    },
    deferRebaseSuggestion: async (args?: { laneId?: string; minutes?: number }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(args?.minutes ?? 60)));
      await runtime.rebaseSuggestionService?.defer({ laneId, minutes });
    },
    listAutoRebaseStatuses: () =>
      runtime.autoRebaseService?.listStatuses() ?? [],
    dismissAutoRebaseStatus: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await runtime.autoRebaseService?.dismissStatus({ laneId });
    },
    initEnv: async (args?: { laneId?: string }): Promise<LaneEnvInitProgress> => {
      const laneEnvironmentService = requireService(runtime.laneEnvironmentService, "Lane environment service not available.");
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const context = await resolveLaneOverlayContext(runtime, laneId);
      if (!context.envInitConfig) {
        const now = new Date().toISOString();
        return { laneId, steps: [], startedAt: now, completedAt: now, overallStatus: "completed" };
      }
      return laneEnvironmentService.initLaneEnvironment(context.lane, context.envInitConfig, context.overrides);
    },
    getEnvStatus: (args?: { laneId?: string }) =>
      runtime.laneEnvironmentService?.getProgress(requireNonEmptyString(args?.laneId, "laneId")) ?? null,
    getOverlay: async (args?: { laneId?: string }) => {
      const context = await resolveLaneOverlayContext(runtime, requireNonEmptyString(args?.laneId, "laneId"));
      return context.overrides;
    },
    listTemplates: () => runtime.laneTemplateService?.listTemplates() ?? [],
    getTemplate: (args?: { templateId?: string }) =>
      runtime.laneTemplateService?.getTemplate(requireNonEmptyString(args?.templateId, "templateId")) ?? null,
    getDefaultTemplate: () => runtime.laneTemplateService?.getDefaultTemplateId() ?? null,
    setDefaultTemplate: (args?: { templateId?: string | null }) => {
      requireService(runtime.laneTemplateService, "Lane template service not available.").setDefaultTemplateId(args?.templateId ?? null);
    },
    applyTemplate: async (args?: ApplyLaneTemplateArgs): Promise<LaneEnvInitProgress> => {
      const laneTemplateService = requireService(runtime.laneTemplateService, "Lane template service not available.");
      const laneEnvironmentService = requireService(runtime.laneEnvironmentService, "Lane environment service not available.");
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const templateId = requireNonEmptyString(args?.templateId, "templateId");
      const context = await resolveLaneOverlayContext(runtime, laneId);
      const template = laneTemplateService.getTemplate(templateId);
      if (!template) throw new Error(`Template not found: ${templateId}`);
      const templateEnvInit = laneTemplateService.resolveTemplateAsEnvInit(template);
      const mergedOverrides = mergeLaneOverrides(context.overrides, {
        ...(template.envVars ? { env: template.envVars } : {}),
        ...(!context.overrides.portRange && template.portRange ? { portRange: template.portRange } : {}),
        envInit: templateEnvInit,
      });
      const mergedEnvInitConfig = mergeLaneEnvInitConfig(context.envInitConfig, templateEnvInit) ?? templateEnvInit;
      return laneEnvironmentService.initLaneEnvironment(context.lane, mergedEnvInitConfig, mergedOverrides);
    },
    saveTemplate: (args?: { template?: unknown }) => {
      const template = args?.template;
      if (!template || typeof template !== "object" || Array.isArray(template)) {
        throw new Error("Lane template payload is required.");
      }
      requireService(runtime.laneTemplateService, "Lane template service not available.").saveTemplate(template as Parameters<NonNullable<AdeRuntime["laneTemplateService"]>["saveTemplate"]>[0]);
    },
    deleteTemplate: (args?: { templateId?: string }) => {
      requireService(runtime.laneTemplateService, "Lane template service not available.").deleteTemplate(requireNonEmptyString(args?.templateId, "templateId"));
    },
    portGetLease: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await ensureLanePortLease(runtime, laneId);
      return runtime.portAllocationService?.getLease(laneId) ?? null;
    },
    portListLeases: () => runtime.portAllocationService?.listLeases() ?? [],
    portAcquire: async (args?: { laneId?: string }) => {
      const lease = await ensureLanePortLease(runtime, requireNonEmptyString(args?.laneId, "laneId"));
      if (!lease) throw new Error("Port allocation service not available.");
      return lease;
    },
    portRelease: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      runtime.portAllocationService?.release(laneId);
    },
    portListConflicts: () => runtime.portAllocationService?.listConflicts() ?? [],
    portRecoverOrphans: async () => {
      if (!runtime.portAllocationService) return [];
      const validIds = new Set(await resolveActiveLaneIds(runtime));
      return runtime.portAllocationService.recoverOrphans(validIds);
    },
    proxyGetStatus: (): ProxyStatus => runtime.laneProxyService?.getStatus() ?? { running: false, proxyPort: 8080, routes: [] },
    proxyStart: (args?: { port?: number }) => requireService(runtime.laneProxyService, "Proxy service not available.").start(args?.port),
    proxyStop: async () => {
      await runtime.laneProxyService?.stop();
    },
    proxyAddRoute: async (args?: { laneId?: string; targetPort?: number }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const targetPort = args?.targetPort;
      if (!Number.isInteger(targetPort) || Number(targetPort) <= 0) {
        throw new Error("targetPort must be a positive integer.");
      }
      const lane = await resolveLane(runtime, laneId);
      return requireService(runtime.laneProxyService, "Proxy service not available.").addRoute(laneId, Number(targetPort), lane.name);
    },
    proxyRemoveRoute: (args?: { laneId?: string }) =>
      runtime.laneProxyService?.removeRoute(requireNonEmptyString(args?.laneId, "laneId")),
    proxyGetPreviewInfo: (args?: { laneId?: string }) =>
      ensureLanePreviewInfo(runtime, requireNonEmptyString(args?.laneId, "laneId")),
    oauthGetStatus: () => runtime.oauthRedirectService?.getStatus() ?? { enabled: false, routingMode: "state-parameter", activeSessions: [], callbackPaths: [] },
    oauthUpdateConfig: (args?: Record<string, unknown>) => {
      requireService(runtime.oauthRedirectService, "OAuth redirect service not available.").updateConfig(args ?? {});
    },
    oauthGenerateRedirectUris: (args?: { provider?: string }) =>
      runtime.oauthRedirectService?.generateRedirectUris(args?.provider) ?? [],
    oauthEncodeState: (args?: { laneId?: string; originalState?: string }) =>
      requireService(runtime.oauthRedirectService, "OAuth redirect service not available.").encodeState(
        requireNonEmptyString(args?.laneId, "laneId"),
        typeof args?.originalState === "string" ? args.originalState : "",
      ),
    oauthDecodeState: (args?: { encodedState?: string }) =>
      runtime.oauthRedirectService?.decodeState(requireNonEmptyString(args?.encodedState, "encodedState")) ?? null,
    oauthListSessions: () => runtime.oauthRedirectService?.listSessions() ?? [],
    diagnosticsGetStatus: async () => {
      const laneIds = await resolveActiveLaneIds(runtime);
      return runtime.runtimeDiagnosticsService?.getStatus(laneIds) ?? {
        lanes: [],
        proxyRunning: false,
        proxyPort: runtime.laneProxyService?.getStatus().proxyPort ?? 0,
        totalRoutes: 0,
        activeConflicts: 0,
        fallbackLanes: [],
      };
    },
    diagnosticsGetLaneHealth: (args?: { laneId?: string }) =>
      runtime.runtimeDiagnosticsService?.getLaneHealth(requireNonEmptyString(args?.laneId, "laneId")) ?? null,
    diagnosticsRunHealthCheck: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      return requireService(runtime.runtimeDiagnosticsService, "Runtime diagnostics service not available.").checkLaneHealth(laneId);
    },
    diagnosticsRunFullCheck: async () => {
      const laneIds = await resolveActiveLaneIds(runtime);
      return runtime.runtimeDiagnosticsService?.checkAllLanes(laneIds) ?? [];
    },
    diagnosticsActivateFallback: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      runtime.runtimeDiagnosticsService?.activateFallback(laneId);
    },
    diagnosticsDeactivateFallback: async (args?: { laneId?: string }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      await resolveLane(runtime, laneId);
      runtime.runtimeDiagnosticsService?.deactivateFallback(laneId);
    },
  };
}

function buildAiDomainService(runtime: AdeRuntime): OpaqueService | null {
  const aiIntegrationService = runtime.aiIntegrationService;
  if (!aiIntegrationService) return null;
  return {
    getStatus: (args?: { force?: boolean; refreshOpenCodeInventory?: boolean }) =>
      buildAiSettingsStatus(aiIntegrationService, args),
    getOpenCodeRuntimeDiagnostics: async () => {
      const { getOpenCodeRuntimeSnapshot } = await import("../opencode/openCodeRuntime");
      return getOpenCodeRuntimeSnapshot();
    },
    isOpenCodeInstalled: async () => {
      const { resolveOpenCodeBinary } = await import("../opencode/openCodeBinaryManager");
      const info = resolveOpenCodeBinary();
      return { installed: Boolean(info.path), source: info.source };
    },
    verifyApiKeyConnection: (args?: { provider?: string }) =>
      aiIntegrationService.verifyApiKeyConnection(requireNonEmptyString(args?.provider, "provider")),
    storeApiKey: (args?: { provider?: string; key?: string }) =>
      aiIntegrationService.storeApiKey(
        requireNonEmptyString(args?.provider, "provider"),
        requireNonEmptyString(args?.key, "key"),
      ),
    deleteApiKey: (args?: { provider?: string }) =>
      aiIntegrationService.deleteApiKey(requireNonEmptyString(args?.provider, "provider")),
    listApiKeys: () => aiIntegrationService.listApiKeys(),
    updateConfig: (partial?: Partial<AiConfig>) => {
      const projectConfigService = requireService(runtime.projectConfigService, "Project config service not available.");
      const snapshot = projectConfigService.get();
      const currentAi = snapshot.shared?.ai ?? {};
      const merged = mergeAiConfig(currentAi, partial ?? {}) ?? {};
      projectConfigService.save({
        shared: { ...snapshot.shared, ai: merged },
        local: snapshot.local ?? {},
      });
      void runtime.agentChatService?.refreshScheduledWork();
    },
    listCursorCloudRepositories: () => aiIntegrationService.listCursorCloudRepositories(),
    listCursorCloudAgents: (args?: { includeArchived?: boolean; limit?: number; cursor?: string | null }) =>
      aiIntegrationService.listCursorCloudAgents(args ?? {}),
    listCursorCloudRuns: (args?: { agentId?: string; limit?: number; cursor?: string | null }) =>
      aiIntegrationService.listCursorCloudRuns({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        ...(args?.limit !== undefined ? { limit: args.limit } : {}),
        ...(args?.cursor !== undefined ? { cursor: args.cursor } : {}),
      }),
    createCursorCloudRun: (args: Parameters<typeof aiIntegrationService.createCursorCloudRun>[0]) =>
      aiIntegrationService.createCursorCloudRun(args),
    archiveCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.archiveCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    unarchiveCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.unarchiveCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    deleteCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.deleteCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    getCursorCloudAgent: (args?: { agentId?: string }) =>
      aiIntegrationService.getCursorCloudAgent(requireNonEmptyString(args?.agentId, "agentId")),
    listCursorCloudArtifacts: async (args?: { agentId?: string }) => {
      const items = await aiIntegrationService.listCursorCloudArtifacts(requireNonEmptyString(args?.agentId, "agentId"));
      return items.map((entry) => ({
        path: entry.path,
        ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
      }));
    },
    downloadCursorCloudArtifact: (args?: { agentId?: string; path?: string }) =>
      aiIntegrationService.downloadCursorCloudArtifact({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        path: requireNonEmptyString(args?.path, "path"),
      }),
    cursorCloudStreamRun: (args?: { agentId?: string; runId?: string }) => {
      const agentId = requireNonEmptyString(args?.agentId, "agentId");
      const runId = requireNonEmptyString(args?.runId, "runId");
      return { subscriptionId: `cursor-cloud-stream-${agentId}-${runId}` };
    },
    cancelCursorCloudRun: (args?: { agentId?: string; runId?: string }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").cancelCursorCloudRun({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        runId: requireNonEmptyString(args?.runId, "runId"),
      }),
    cursorCloudFollowUp: (args?: { agentId?: string; prompt?: string; modelId?: string | null }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").cursorCloudFollowUp({
        agentId: requireNonEmptyString(args?.agentId, "agentId"),
        prompt: requireNonEmptyString(args?.prompt, "prompt"),
        ...(args?.modelId !== undefined ? { modelId: args.modelId } : {}),
      }),
    openCursorCloudChat: (args?: { cloudAgentId?: string; laneId?: string }) =>
      requireService(runtime.agentChatService, "Agent chat service not available.").openCursorCloudChat({
        cloudAgentId: requireNonEmptyString(args?.cloudAgentId, "cloudAgentId"),
        laneId: requireNonEmptyString(args?.laneId, "laneId"),
      }),
  };
}

const AI_SETTINGS_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "orchestrator",
  "initial_context",
];

async function buildAiSettingsStatus(
  aiIntegrationService: NonNullable<AdeRuntime["aiIntegrationService"]>,
  options?: { force?: boolean; refreshOpenCodeInventory?: boolean },
): Promise<AiSettingsStatus> {
  const status = await aiIntegrationService.getStatus({
    force: options?.force === true,
    refreshOpenCodeInventory: options?.refreshOpenCodeInventory === true,
  });
  const usageBatch = aiIntegrationService.getDailyUsageBatch(AI_SETTINGS_FEATURE_KEYS);
  return {
    mode: status.mode,
    availableProviders: status.availableProviders,
    models: status.models,
    detectedAuth: status.detectedAuth,
    providerConnections: status.providerConnections,
    runtimeConnections: status.runtimeConnections,
    availableModelIds: status.availableModelIds,
    opencodeBinaryInstalled: status.opencodeBinaryInstalled,
    opencodeBinarySource: status.opencodeBinarySource,
    opencodeInventoryError: status.opencodeInventoryError,
    opencodeProviders: status.opencodeProviders,
    apiKeyStore: status.apiKeyStore,
    features: AI_SETTINGS_FEATURE_KEYS.map((feature) => ({
      feature,
      enabled: aiIntegrationService.getFeatureFlag(feature),
      dailyUsage: usageBatch.get(feature) ?? 0,
      dailyLimit: aiIntegrationService.getDailyBudgetLimit(feature),
    })),
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected '${field}' to be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    throw new Error(`Expected '${field}' to be a non-empty string.`);
  }
  return trimmed;
}

function clampDockLayout(layout: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(layout)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = Math.max(0, Math.min(100, value));
  }
  return out;
}

type LayoutService = {
  get(args: { layoutId?: unknown }): unknown;
  set(args: { layoutId?: unknown; layout?: unknown }): { layoutId: string; layout: Record<string, number> };
};

function buildLayoutDomainService(runtime: AdeRuntime): LayoutService | null {
  if (!runtime.db) return null;
  return {
    get(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      return runtime.db.getJson(`dock_layout:${layoutId}`);
    },
    set(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      if (!args || !Object.prototype.hasOwnProperty.call(args, "layout")) {
        throw new Error("Missing required 'layout' object. Pass an explicit null to clear.");
      }
      const rawLayout = args.layout;
      let layout: Record<string, number>;
      if (rawLayout === null) {
        layout = {};
      } else if (rawLayout && typeof rawLayout === "object" && !Array.isArray(rawLayout)) {
        layout = clampDockLayout(rawLayout as Record<string, unknown>);
      } else {
        throw new Error("Expected 'layout' to be a plain object or null.");
      }
      runtime.db.setJson(`dock_layout:${layoutId}`, layout);
      return { layoutId, layout };
    },
  };
}

type TilingTreeService = {
  get(args: { layoutId?: unknown }): unknown;
  set(args: { layoutId?: unknown; tree?: unknown }): { layoutId: string; tree: unknown };
};

function buildTilingTreeDomainService(runtime: AdeRuntime): TilingTreeService | null {
  if (!runtime.db) return null;
  return {
    get(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      return runtime.db.getJson(`tiling_tree:${layoutId}`);
    },
    set(args) {
      const layoutId = requireNonEmptyString(args?.layoutId, "layoutId");
      if (!args || !Object.prototype.hasOwnProperty.call(args, "tree")) {
        throw new Error("Missing required 'tree'. Pass an explicit null to clear.");
      }
      const tree = args.tree;
      if (tree !== null && (typeof tree !== "object" || Array.isArray(tree))) {
        throw new Error("Expected 'tree' to be a plain object or null.");
      }
      runtime.db.setJson(`tiling_tree:${layoutId}`, tree);
      return { layoutId, tree };
    },
  };
}

type GraphStateService = {
  get(): unknown;
  set(args: { state?: unknown }): { projectId: string; state: unknown };
};

function buildGraphStateDomainService(runtime: AdeRuntime): GraphStateService | null {
  if (!runtime.db) return null;
  return {
    // graph_state is strictly scoped to the current runtime project. The caller
    // cannot override `projectId`; the field is intentionally absent from the
    // args surface to prevent cross-project reads/writes via `run_ade_action`.
    get() {
      const projectId = runtime.projectId;
      return runtime.db.getJson(`graph_state:${projectId}`);
    },
    set(args) {
      const projectId = runtime.projectId;
      if (!args || !Object.prototype.hasOwnProperty.call(args, "state")) {
        throw new Error("Missing required 'state'. Pass an explicit null to clear.");
      }
      const state = args.state;
      if (state !== null && (typeof state !== "object" || Array.isArray(state))) {
        throw new Error("Expected 'state' to be a plain object or null.");
      }
      runtime.db.setJson(`graph_state:${projectId}`, state);
      return { projectId, state };
    },
  };
}

type TerminalDomainService = {
  list(args?: unknown): unknown;
  read(args?: unknown): Promise<unknown>;
  preview(args?: unknown): Promise<unknown>;
  write(args?: unknown): Promise<unknown>;
  resize(args?: unknown): unknown;
  signal(args?: unknown): unknown;
  activeForChat(args?: unknown): unknown;
  reattachChatCli(args?: unknown): Promise<unknown>;
};

const RUNTIME_FILE_WATCH_CLIENT_ID_FIELD = "__adeRuntimeClientId";
const RUNTIME_FILE_WATCH_DEFAULT_SENDER_ID = 1;

function asActionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readObjectActionArg(value: unknown, actionName: string): Record<string, unknown> {
  if (value == null) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${actionName} expects an object input. Use --input-json '{...}' or see \`ade actions list --domain chat --text\`.`);
}

function readOptionalIntegerActionField(value: unknown, field: string): number | undefined {
  if (value == null || value === "") return undefined;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number.parseInt(value, 10)
      : NaN;
  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected '${field}' to be a finite number.`);
  }
  return Math.floor(numeric);
}

function readChatHistoryActionArgs(
  value: unknown,
  actionName: string,
): { sessionId: string; options: Record<string, unknown> } {
  if (Array.isArray(value)) {
    return {
      sessionId: requireNonEmptyString(value[0], "sessionId"),
      options: asActionRecord(value[1]),
    };
  }
  if (typeof value === "string") {
    return {
      sessionId: requireNonEmptyString(value, "sessionId"),
      options: {},
    };
  }
  const record = readObjectActionArg(value, actionName);
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    options: record,
  };
}

function readRuntimeFileWatchSenderId(args: Record<string, unknown>): number {
  const raw = args[RUNTIME_FILE_WATCH_CLIENT_ID_FIELD];
  const numeric = typeof raw === "number"
    ? raw
    : typeof raw === "string"
      ? Number.parseInt(raw, 10)
      : NaN;
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    return numeric;
  }
  return RUNTIME_FILE_WATCH_DEFAULT_SENDER_ID;
}

function toRuntimeFileWatchArgs(args: Record<string, unknown>): FilesWatchArgs {
  const { [RUNTIME_FILE_WATCH_CLIENT_ID_FIELD]: _clientId, ...watchArgs } = args;
  return watchArgs as unknown as FilesWatchArgs;
}

function readStringActionArg(value: unknown, field: string): string {
  if (typeof value === "string") {
    return requireNonEmptyString(value, field);
  }
  return requireNonEmptyString(asActionRecord(value)[field], field);
}

type PrAiRuntimeSession = {
  sessionId: string;
  ptyId: string | null;
  runId: string;
  provider: "codex" | "claude";
  contextKey: string;
  context: PrAiResolutionContext;
  modelId: string;
  reasoning: string | null;
  permissionMode: PrAgentPermissionMode;
  pollTimer: ReturnType<typeof setInterval> | null;
  finalizing: boolean;
};

type PrAiRuntimeBridge = {
  getSession(args?: unknown): Promise<PrAiResolutionGetSessionResult>;
  start(args?: unknown): Promise<PrAiResolutionStartResult>;
  input(args?: unknown): Promise<void>;
  stop(args?: unknown): Promise<void>;
};

const prAiRuntimeBridges = new WeakMap<AdeRuntime, PrAiRuntimeBridge>();

function inferPrAiProvider(modelId: string): "codex" | "claude" {
  const descriptor = getModelById(modelId);
  return descriptor?.family === "anthropic" ? "claude" : "codex";
}

function collectPrAiSourceLaneIds(context: PrAiResolutionContext): string[] {
  const sourceLaneIds = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) sourceLaneIds.add(normalized);
  };
  for (const laneId of context.sourceLaneIds ?? []) {
    add(laneId);
  }
  add(context.sourceLaneId ?? null);
  if (context.sourceTab !== "integration") {
    add(context.laneId ?? null);
  }
  return Array.from(sourceLaneIds);
}

function mapExternalResolverStatusToPrAi(status: string): PrAiResolutionSessionStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "canceled") return "cancelled";
  return "running";
}

function buildPrAiDisplayText(context: PrAiResolutionContext): string {
  if (context.sourceTab === "rebase") return "Resolve this rebase with AI.";
  if (context.sourceTab === "queue") return "Resolve this queued PR with AI.";
  if (context.sourceTab === "integration") {
    return context.proposalId
      ? "Resolve this integration proposal with AI."
      : "Resolve this integration PR with AI.";
  }
  return "Resolve this PR with AI.";
}

function emitPrAiResolutionRuntimeEvent(runtime: AdeRuntime, payload: PrAiResolutionEventPayload): void {
  runtime.eventBuffer.push({
    timestamp: nowIso(),
    category: "runtime",
    payload: { type: "pr_ai_resolution_event", event: payload },
  });
}

function readSummaryPermissionMode(summary: unknown): PrAgentPermissionMode | null {
  const record = asActionRecord(summary);
  return typeof record.permissionMode === "string"
    ? record.permissionMode as PrAgentPermissionMode
    : null;
}

function buildPrAiSessionInfo(args: {
  context: PrAiResolutionContext;
  contextKey: string;
  sessionId: string;
  provider: "codex" | "claude";
  model: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: PrAgentPermissionMode | null;
  status: PrAiResolutionSessionStatus;
}): PrAiResolutionSessionInfo {
  return {
    contextKey: args.contextKey,
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    modelId: args.modelId,
    reasoning: args.reasoning,
    permissionMode: args.permissionMode,
    context: args.context,
    status: args.status,
  };
}

function getPrAiRuntimeBridge(runtime: AdeRuntime): PrAiRuntimeBridge {
  const existing = prAiRuntimeBridges.get(runtime);
  if (existing) return existing;

  const prAiSessions = new Map<string, PrAiRuntimeSession>();
  const prAiSessionsByContextKey = new Map<string, string>();

  const clearSession = (sessionId: string): void => {
    const session = prAiSessions.get(sessionId);
    if (!session) return;
    if (session.pollTimer) clearInterval(session.pollTimer);
    if (prAiSessionsByContextKey.get(session.contextKey) === sessionId) {
      prAiSessionsByContextKey.delete(session.contextKey);
    }
    prAiSessions.delete(sessionId);
  };

  const finalize = async (
    sessionId: string,
    opts: { forceStatus?: "cancelled" | "completed" | "failed"; message?: string } = {},
  ): Promise<void> => {
    const session = prAiSessions.get(sessionId);
    if (!session || session.finalizing) return;
    session.finalizing = true;
    try {
      const detail = runtime.sessionService.get(sessionId);
      const derivedExitCode = opts.forceStatus === "cancelled"
        ? 130
        : (detail?.exitCode ?? (detail?.status === "completed" ? 0 : 1));
      try {
        await runtime.conflictService.finalizeResolverSession({
          runId: session.runId,
          exitCode: derivedExitCode,
        });
      } catch (error) {
        runtime.logger.debug("ade_actions.prs_ai_resolution_finalize_failed", {
          sessionId,
          runId: session.runId,
          error: getErrorMessage(error),
        });
      }

      const status = opts.forceStatus
        ?? (detail?.status === "disposed"
          ? "cancelled"
          : derivedExitCode === 0
            ? "completed"
            : "failed");
      emitPrAiResolutionRuntimeEvent(runtime, {
        sessionId,
        status,
        message: opts.message ?? null,
        timestamp: nowIso(),
      });
    } finally {
      clearSession(sessionId);
    }
  };

  const bridge: PrAiRuntimeBridge = {
    async getSession(args?: unknown): Promise<PrAiResolutionGetSessionResult> {
      const context = (asActionRecord(args).context ?? {}) as PrAiResolutionContext;
      const contextKey = buildPrAiResolutionContextKey(context);
      const liveSessionId = prAiSessionsByContextKey.get(contextKey);
      const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
      const sessionSummaries = await agentChatService.listSessions();

      if (liveSessionId) {
        const liveSession = prAiSessions.get(liveSessionId);
        if (liveSession) {
          const summary = sessionSummaries.find((entry) => entry.sessionId === liveSessionId) ?? null;
          const summaryRecord = asActionRecord(summary);
          return buildPrAiSessionInfo({
            context: liveSession.context,
            contextKey,
            sessionId: liveSessionId,
            provider: liveSession.provider,
            model: typeof summaryRecord.model === "string" ? summaryRecord.model : liveSession.modelId,
            modelId: typeof summaryRecord.modelId === "string" ? summaryRecord.modelId : liveSession.modelId,
            reasoning: typeof summaryRecord.reasoningEffort === "string" ? summaryRecord.reasoningEffort : liveSession.reasoning,
            permissionMode: readSummaryPermissionMode(summary) ?? liveSession.permissionMode,
            status: "running",
          });
        }
        prAiSessionsByContextKey.delete(contextKey);
      }

      const persistedRun = runtime.conflictService
        .listExternalResolverRuns({ limit: 200 })
        .find((entry) => entry.resolverContextKey === contextKey && entry.sessionId);
      if (!persistedRun?.sessionId) return null;

      const summary = sessionSummaries.find((entry) => entry.sessionId === persistedRun.sessionId) ?? null;
      const summaryRecord = asActionRecord(summary);
      return buildPrAiSessionInfo({
        context,
        contextKey,
        sessionId: persistedRun.sessionId,
        provider: persistedRun.provider === "claude" ? "claude" : "codex",
        model: typeof summaryRecord.model === "string" ? summaryRecord.model : persistedRun.model ?? null,
        modelId: typeof summaryRecord.modelId === "string" ? summaryRecord.modelId : persistedRun.model ?? null,
        reasoning: typeof summaryRecord.reasoningEffort === "string" ? summaryRecord.reasoningEffort : persistedRun.reasoningEffort ?? null,
        permissionMode: readSummaryPermissionMode(summary) ?? persistedRun.permissionMode ?? null,
        status: mapExternalResolverStatusToPrAi(persistedRun.status),
      });
    },
    async start(args?: unknown): Promise<PrAiResolutionStartResult> {
      const startArgs = asActionRecord(args) as unknown as PrAiResolutionStartArgs;
      const context = (startArgs.context ?? {}) as PrAiResolutionContext;
      const model = typeof startArgs.model === "string" ? startArgs.model.trim() : "";
      const targetLaneId = typeof context.targetLaneId === "string" ? context.targetLaneId.trim() : "";
      const sourceLaneIds = collectPrAiSourceLaneIds(context);
      const permissionMode: PrAgentPermissionMode = startArgs.permissionMode ?? "default";
      const reasoning = typeof startArgs.reasoning === "string" && startArgs.reasoning.trim().length > 0
        ? startArgs.reasoning.trim()
        : null;
      const additionalInstructions = typeof startArgs.additionalInstructions === "string" && startArgs.additionalInstructions.trim().length > 0
        ? startArgs.additionalInstructions.trim()
        : null;
      let runId = "";

      if (!model) {
        const sessionId = randomUUID();
        const error = "Model is required to start AI resolution.";
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: error, timestamp: nowIso() });
        return { sessionId, provider: "codex", ptyId: null, status: "failed", error, context };
      }
      if (!targetLaneId) {
        const sessionId = randomUUID();
        const error = "Target lane is required to start AI resolution.";
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: error, timestamp: nowIso() });
        return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
      }
      if (sourceLaneIds.length === 0) {
        const sessionId = randomUUID();
        const error = "At least one source lane is required to start AI resolution.";
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: error, timestamp: nowIso() });
        return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
      }

      try {
        const provider = inferPrAiProvider(model);
        const modelDescriptor = getModelById(model);
        const prep = await runtime.conflictService.prepareResolverSession({
          provider,
          targetLaneId,
          sourceLaneIds,
          cwdLaneId: typeof context.integrationLaneId === "string" && context.integrationLaneId.trim().length > 0
            ? context.integrationLaneId.trim()
            : (typeof context.laneId === "string" && context.laneId.trim().length > 0 ? context.laneId.trim() : undefined),
          proposalId: typeof context.proposalId === "string" && context.proposalId.trim().length > 0
            ? context.proposalId.trim()
            : undefined,
          sourceTab: context.sourceTab,
          scenario: context.scenario ?? (sourceLaneIds.length > 1 ? "integration-merge" : "single-merge"),
          model,
          reasoningEffort: reasoning,
          permissionMode,
          additionalInstructions,
          originSurface: context.sourceTab === "integration" || context.sourceTab === "rebase" ? context.sourceTab : "manual",
        });
        runId = prep.runId;
        if (prep.status === "blocked") {
          const sessionId = randomUUID();
          const reason = prep.contextGaps.length
            ? prep.contextGaps.map((gap) => gap.message).join(", ")
            : "Resolver session blocked due to insufficient context.";
          emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message: reason, timestamp: nowIso() });
          return { sessionId, provider, ptyId: null, status: "failed", error: reason, context };
        }

        const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
        const session = await agentChatService.createSession({
          laneId: prep.cwdLaneId,
          provider,
          model: modelDescriptor?.shortId ?? model,
          ...(modelDescriptor?.id ? { modelId: modelDescriptor.id } : {}),
          ...(reasoning ? { reasoningEffort: reasoning } : {}),
          permissionMode: mapPermissionModeForModelFamily(permissionMode, modelDescriptor?.family),
        });
        const promptText = fs.readFileSync(prep.promptFilePath, "utf8");
        const runtimeContext: PrAiResolutionContext = {
          ...context,
          laneId: prep.cwdLaneId,
          targetLaneId,
          sourceLaneId: sourceLaneIds[0] ?? context.sourceLaneId ?? context.laneId ?? null,
          sourceLaneIds,
          integrationLaneId: prep.integrationLaneId ?? context.integrationLaneId ?? null,
        };
        const contextKey = buildPrAiResolutionContextKey(runtimeContext);
        const runtimeSession: PrAiRuntimeSession = {
          sessionId: session.id,
          ptyId: null,
          runId: prep.runId,
          provider,
          contextKey,
          context: runtimeContext,
          modelId: model,
          reasoning,
          permissionMode,
          pollTimer: null,
          finalizing: false,
        };
        await runtime.conflictService.attachResolverSession({
          runId: prep.runId,
          ptyId: null,
          sessionId: session.id,
          command: [],
        });
        runtimeSession.pollTimer = setInterval(() => {
          const current = prAiSessions.get(runtimeSession.sessionId);
          if (!current || current.finalizing) return;
          const detail = runtime.sessionService.get(runtimeSession.sessionId);
          if (!detail || detail.status === "running") return;
          void finalize(runtimeSession.sessionId);
        }, 1_000);
        prAiSessions.set(runtimeSession.sessionId, runtimeSession);
        prAiSessionsByContextKey.set(contextKey, runtimeSession.sessionId);
        emitPrAiResolutionRuntimeEvent(runtime, {
          sessionId: runtimeSession.sessionId,
          status: "running",
          message: null,
          timestamp: nowIso(),
        });
        void agentChatService.sendMessage({
          sessionId: runtimeSession.sessionId,
          text: promptText,
          displayText: buildPrAiDisplayText(runtimeContext),
          ...(reasoning ? { reasoningEffort: reasoning } : {}),
        }).catch(async (error: unknown) => {
          runtime.logger.warn("ade_actions.prs_ai_resolution_send_failed", {
            sessionId: runtimeSession.sessionId,
            runId: prep.runId,
            error: getErrorMessage(error),
          });
          await finalize(runtimeSession.sessionId, { forceStatus: "failed", message: getErrorMessage(error) });
        });
        return {
          sessionId: runtimeSession.sessionId,
          provider,
          ptyId: null,
          status: "started",
          error: null,
          context: runtimeContext,
        };
      } catch (error) {
        if (runId) {
          try {
            await runtime.conflictService.finalizeResolverSession({ runId, exitCode: 1 });
          } catch {
            // Preserve the original error.
          }
        }
        const sessionId = randomUUID();
        const message = getErrorMessage(error);
        emitPrAiResolutionRuntimeEvent(runtime, { sessionId, status: "failed", message, timestamp: nowIso() });
        return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error: message, context };
      }
    },
    async input(args?: unknown): Promise<void> {
      const inputArgs = asActionRecord(args) as unknown as PrAiResolutionInputArgs;
      const sessionId = typeof inputArgs.sessionId === "string" ? inputArgs.sessionId.trim() : "";
      const text = typeof inputArgs.text === "string" ? inputArgs.text : "";
      if (!sessionId || !text.length) return;
      if (!prAiSessions.has(sessionId)) throw new Error(`AI resolution session not found: ${sessionId}`);
      const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
      const sessionDetail = runtime.sessionService.get(sessionId);
      if (sessionDetail?.status === "running") {
        await agentChatService.steer({ sessionId, text });
        return;
      }
      await agentChatService.sendMessage({ sessionId, text });
    },
    async stop(args?: unknown): Promise<void> {
      const stopArgs = asActionRecord(args) as unknown as PrAiResolutionStopArgs;
      const sessionId = typeof stopArgs.sessionId === "string" ? stopArgs.sessionId.trim() : "";
      if (!sessionId) return;
      if (!prAiSessions.has(sessionId)) return;
      const agentChatService = requireService(runtime.agentChatService, "Agent chat service not available.");
      await agentChatService.interrupt({ sessionId });
      await finalize(sessionId, { forceStatus: "cancelled", message: "AI resolution stopped by user." });
    },
  };

  prAiRuntimeBridges.set(runtime, bridge);
  return bridge;
}

function buildPrDomainService(runtime: AdeRuntime): OpaqueService | null {
  const prService = runtime.prService;
  if (!prService) return null;
  const queueLandingService = runtime.queueLandingService ?? null;
  const prSummaryService = runtime.prSummaryService ?? null;

  return {
    ...(prService as unknown as OpaqueService),
    aiResolutionGetSession(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).getSession(args);
    },
    aiResolutionStart(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).start(args);
    },
    aiResolutionInput(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).input(args);
    },
    aiResolutionStop(args?: unknown) {
      return getPrAiRuntimeBridge(runtime).stop(args);
    },
    ...(queueLandingService
      ? {
          async startQueueAutomation(args?: unknown) {
            return await queueLandingService.startQueue(asActionRecord(args) as Parameters<typeof queueLandingService.startQueue>[0]);
          },
          pauseQueueAutomation(args?: unknown) {
            return queueLandingService.pauseQueue(readStringActionArg(args, "queueId"));
          },
          resumeQueueAutomation(args?: unknown) {
            return queueLandingService.resumeQueue(asActionRecord(args) as Parameters<typeof queueLandingService.resumeQueue>[0]);
          },
          cancelQueueAutomation(args?: unknown) {
            return queueLandingService.cancelQueue(readStringActionArg(args, "queueId"));
          },
          getQueueState(args?: unknown) {
            return queueLandingService.getQueueStateByGroup(readStringActionArg(args, "groupId"));
          },
          listQueueStates(args?: unknown) {
            return queueLandingService.listQueueStates(asActionRecord(args) as Parameters<typeof queueLandingService.listQueueStates>[0]);
          },
        }
      : {}),
    ...(prSummaryService
      ? {
          getAiSummary(prId: unknown) {
            return prSummaryService.getSummary(readStringActionArg(prId, "prId"));
          },
          regenerateAiSummary(prId: unknown) {
            return prSummaryService.regenerateSummary(readStringActionArg(prId, "prId"));
          },
        }
      : {}),
  };
}

function buildGithubDomainService(runtime: AdeRuntime): OpaqueService | null {
  const githubService = runtime.githubService;
  if (!githubService) return null;
  return {
    ...(githubService as unknown as OpaqueService),
    async listRepoLabels(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoLabels(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async listRepoAutolinks(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoAutolinks(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async createRepoAutolink(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.createRepoAutolink(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
        {
          keyPrefix: requireNonEmptyString(actionArgs.keyPrefix, "keyPrefix"),
          urlTemplate: requireNonEmptyString(actionArgs.urlTemplate, "urlTemplate"),
          isAlphanumeric: actionArgs.isAlphanumeric === true,
        },
      );
    },
    async getAppInstallationStatus(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.getAppInstallationStatus({
        owner: typeof actionArgs.owner === "string" ? actionArgs.owner : undefined,
        name: typeof actionArgs.name === "string" ? actionArgs.name : undefined,
        forceRefresh: actionArgs.forceRefresh === true,
      });
    },
    async listRepoCollaborators(args?: unknown) {
      const actionArgs = asActionRecord(args);
      return githubService.listRepoCollaborators(
        requireNonEmptyString(actionArgs.owner, "owner"),
        requireNonEmptyString(actionArgs.name, "name"),
      );
    },
    async publishCurrentProject(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const isPrivate = actionArgs.isPrivate;
      if (typeof isPrivate !== "boolean") {
        throw new Error("Expected 'isPrivate' to be a boolean.");
      }
      const description = typeof actionArgs.description === "string"
        ? actionArgs.description
        : undefined;
      const owner = typeof actionArgs.owner === "string"
        ? actionArgs.owner.trim()
        : undefined;
      return githubService.publishCurrentProject({
        ...(owner ? { owner } : {}),
        name: requireNonEmptyString(actionArgs.name, "name"),
        description,
        isPrivate,
      });
    },
    async setToken(args?: unknown) {
      githubService.setToken(readStringActionArg(args, "token"));
      return githubService.getStatus();
    },
    async clearToken() {
      githubService.clearToken();
      return githubService.getStatus();
    },
  };
}

function buildLinearIssueTrackerDomainService(runtime: AdeRuntime): OpaqueService | null {
  const tracker = runtime.linearIssueTracker;
  if (!tracker) return null;
  const connectionPrecheckCache: LinearConnectionPrecheckCache = {
    checkedAt: 0,
    connection: null,
  };
  return {
    ...(tracker as unknown as OpaqueService),
    async graphql(args?: unknown) {
      await requireRuntimeLinearConnection(runtime, connectionPrecheckCache);
      return tracker.runGraphQL(parseLinearGraphQLInput(asActionRecord(args)));
    },
    async getStatus() {
      return buildRuntimeLinearConnectionStatus(runtime);
    },
    async getConnectionStatus() {
      return buildRuntimeLinearConnectionStatus(runtime);
    },
    async listIssues(args?: unknown) {
      const actionArgs = asActionRecord(args);
      const issues = await tracker.fetchCandidateIssues({
        projectSlugs: asStringArray(actionArgs.projectSlugs ?? actionArgs.projectSlug ?? actionArgs.projects ?? actionArgs.project),
        stateTypes: asStringArray(actionArgs.stateTypes ?? actionArgs.stateType ?? actionArgs.states ?? actionArgs.state),
      });
      const limit = typeof actionArgs.limit === "number" && Number.isFinite(actionArgs.limit)
        ? Math.max(1, Math.min(100, Math.floor(actionArgs.limit)))
        : 20;
      return issues.slice(0, limit);
    },
    async getQuickView(connection?: LinearConnectionStatus): Promise<CtoLinearQuickView> {
      const nextConnection = connection ?? await buildRuntimeLinearConnectionStatus(runtime);
      if (!nextConnection.connected) return createEmptyLinearQuickView(nextConnection);
      try {
        return await tracker.getQuickView(nextConnection);
      } catch (error) {
        return createEmptyLinearQuickView({
          ...nextConnection,
          connected: false,
          viewerId: null,
          viewerName: null,
          checkedAt: nowIso(),
          message: getErrorMessage(error) || "Linear tracker error",
        });
      }
    },
    async getWorkflowCatalog() {
      const [users, labels, states] = await Promise.all([
        tracker.listUsers(),
        tracker.listLabels(),
        tracker.listWorkflowStates(),
      ]);
      return { users, labels, states };
    },
    async getIssuePickerData() {
      const [projects, users, states] = await Promise.all([
        tracker.listProjects().catch(() => []),
        tracker.listUsers().catch(() => []),
        tracker.listWorkflowStates().catch(() => []),
      ]);
      return { projects, users, states };
    },
  };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim().length) {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

async function buildRuntimeLinearConnectionStatus(runtime: AdeRuntime): Promise<LinearConnectionStatus> {
  const credentialStatus = runtime.linearCredentialService?.getStatus() ?? {
    tokenStored: false,
    authMode: null,
    oauthConfigured: false,
    tokenExpiresAt: null,
  };
  const tokenStored = Boolean(credentialStatus.tokenStored);
  if (!runtime.linearIssueTracker || !tokenStored) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: tokenStored ? "Linear tracker service unavailable." : "Linear token not configured.",
    };
  }
  try {
    const status = await runtime.linearIssueTracker.getConnectionStatus();
    return {
      tokenStored,
      connected: status.connected,
      viewerId: status.viewerId,
      viewerName: status.viewerName,
      organizationId: status.organizationId ?? null,
      organizationName: status.organizationName ?? null,
      organizationUrlKey: status.organizationUrlKey ?? null,
      organizationLogoUrl: status.organizationLogoUrl ?? null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: formatLinearConnectionMessage(status.message, credentialStatus.authMode),
    };
  } catch (error) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: formatLinearConnectionMessage(
        getErrorMessage(error) || "Linear connection check failed.",
        credentialStatus.authMode,
      ),
    };
  }
}

const LINEAR_CONNECTION_PRECHECK_TTL_MS = 30_000;

type LinearConnectionPrecheckCache = {
  checkedAt: number;
  connection: LinearConnectionStatus | null;
};

async function requireRuntimeLinearConnection(
  runtime: AdeRuntime,
  cache?: LinearConnectionPrecheckCache,
): Promise<LinearConnectionStatus> {
  const now = Date.now();
  if (
    cache?.connection?.connected
    && now - cache.checkedAt < LINEAR_CONNECTION_PRECHECK_TTL_MS
  ) {
    return cache.connection;
  }
  const connection = await buildRuntimeLinearConnectionStatus(runtime);
  if (connection.connected) {
    if (cache) {
      cache.connection = connection;
      cache.checkedAt = now;
    }
    return connection;
  }
  if (cache) {
    cache.connection = null;
    cache.checkedAt = 0;
  }
  const message = connection.message?.trim();
  const error = new Error(message ? `Linear is not connected: ${message}` : "Linear is not connected.");
  Object.assign(error, { code: "LINEAR_NOT_CONNECTED", connection });
  throw error;
}

function formatLinearConnectionMessage(
  message: string | null | undefined,
  authMode: "manual" | "oauth" | null | undefined,
): string | null {
  const trimmed = message?.trim();
  if (
    authMode === "manual"
    && trimmed
    && /authentication required|not authenticated/i.test(trimmed)
  ) {
    return "Linear rejected the API key. Paste a Linear personal API key from linear.app/settings/api; it should start with lin_api_.";
  }
  return trimmed || null;
}

function buildLinearOAuthDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.linearOAuthService;
  if (!service) return null;
  return {
    async startSession() {
      return service.startSession();
    },
    async getSession(args?: unknown) {
      const session = service.getSession(readStringActionArg(args, "sessionId"));
      if (session.status !== "completed") {
        return session;
      }
      return {
        ...session,
        connection: await buildRuntimeLinearConnectionStatus(runtime),
      };
    },
  };
}

function createEmptyLinearQuickView(connection: LinearConnectionStatus): CtoLinearQuickView {
  return {
    connection,
    organization: null,
    viewer: null,
    projects: [],
    teams: [],
    assignedIssues: [],
    recentIssues: [],
    fetchedAt: nowIso(),
    sdk: {
      packageName: "@linear/sdk",
      surfaces: [],
    },
  };
}

function buildFileDomainService(runtime: AdeRuntime): OpaqueService | null {
  const fileService = runtime.fileService;
  if (!fileService) return null;
  return {
    ...(fileService as unknown as OpaqueService),
    async watchWorkspace(args?: unknown): Promise<{ ok: true }> {
      const actionArgs = asActionRecord(args);
      const senderId = readRuntimeFileWatchSenderId(actionArgs);
      await fileService.watchWorkspace(
        toRuntimeFileWatchArgs(actionArgs),
        (event: FileChangeEvent) => {
          runtime.eventBuffer.push({
            timestamp: new Date().toISOString(),
            category: "runtime",
            payload: { type: "file_change", event },
          });
        },
        senderId,
      );
      return { ok: true };
    },
    stopWatching(args?: unknown): { ok: true } {
      const actionArgs = asActionRecord(args);
      const senderId = readRuntimeFileWatchSenderId(actionArgs);
      fileService.stopWatching(
        toRuntimeFileWatchArgs(actionArgs),
        senderId,
      );
      return { ok: true };
    },
  };
}

function buildTerminalDomainService(runtime: AdeRuntime): TerminalDomainService | null {
  if (!runtime.ptyService) return null;
  return {
    list(args) {
      return runtime.ptyService.listTerminals(args as Parameters<typeof runtime.ptyService.listTerminals>[0]);
    },
    read(args) {
      return runtime.ptyService.readTerminal(args as Parameters<typeof runtime.ptyService.readTerminal>[0]);
    },
    preview(args) {
      return runtime.ptyService.previewTerminal(args as Parameters<typeof runtime.ptyService.previewTerminal>[0]);
    },
    async write(args) {
      return await runtime.ptyService.writeTerminal(args as Parameters<typeof runtime.ptyService.writeTerminal>[0]);
    },
    resize(args) {
      return runtime.ptyService.resizeTerminal(args as Parameters<typeof runtime.ptyService.resizeTerminal>[0]);
    },
    signal(args) {
      return runtime.ptyService.signalTerminal(args as Parameters<typeof runtime.ptyService.signalTerminal>[0]);
    },
    activeForChat(args) {
      return runtime.ptyService.activeForChat(args as Parameters<typeof runtime.ptyService.activeForChat>[0]);
    },
    async reattachChatCli(args) {
      return await runtime.ptyService.reattachChatCli(args as Parameters<typeof runtime.ptyService.reattachChatCli>[0]);
    },
  };
}

function buildSearchDomainService(runtime: AdeRuntime): OpaqueService | null {
  const searchService = runtime.searchService;
  if (!searchService) return null;
  return {
    query(args: unknown) {
      return searchService.query((args ?? {}) as Parameters<typeof searchService.query>[0]);
    },
    indexStatus() {
      return searchService.indexStatus();
    },
    rebuildIndex() {
      return searchService.rebuildIndex();
    },
  } as OpaqueService;
}

function buildExternalSessionsDomainService(runtime: AdeRuntime): OpaqueService | null {
  const externalSessionsService = runtime.externalSessionsService;
  if (!externalSessionsService) return null;
  return {
    list(args: unknown) {
      return externalSessionsService.list((args ?? {}) as Parameters<typeof externalSessionsService.list>[0]);
    },
    import(args: unknown) {
      return externalSessionsService.importExternalSession(
        (args ?? {}) as Parameters<typeof externalSessionsService.importExternalSession>[0],
      );
    },
  } as OpaqueService;
}

function buildStorageDomainService(runtime: AdeRuntime): OpaqueService | null {
  const storageInsightsService = runtime.storageInsightsService;
  if (!storageInsightsService) return null;
  return {
    getSnapshot: (args?: { forceRefresh?: boolean }) => storageInsightsService.getSnapshot(args),
    compressNow: () => storageInsightsService.compressNow(),
    cleanupPreview: (args?: { targets?: Parameters<typeof storageInsightsService.cleanupPreview>[0] }) =>
      storageInsightsService.cleanupPreview(args?.targets ?? []),
    cleanup: (args?: {
      targets?: Parameters<typeof storageInsightsService.cleanup>[0];
      preview?: Parameters<typeof storageInsightsService.cleanup>[1]["preview"];
    }) => storageInsightsService.cleanup(args?.targets ?? [], {
      preview: args?.preview ?? { items: [], totalBytes: 0, blocked: [] },
    }),
  };
}

export function getAdeActionDomainServices(
  runtime: AdeRuntime,
): Partial<Record<AdeActionDomain, OpaqueService | null | undefined>> {
  const automationsEnabled = areAutomationsEnabledForPackagedState(Boolean(runtime.isPackaged));
  return {
    lane: toService(buildLaneDomainService(runtime)),
    git: toService(runtime.gitService),
    diff: toService(runtime.diffService),
    conflicts: toService(runtime.conflictService),
    pr: toService(buildPrDomainService(runtime)),
    tests: toService(runtime.testService),
    chat: toService(buildChatDomainService(runtime)),
    keybindings: toService(runtime.keybindingsService),
    ai: toService(buildAiDomainService(runtime)),
    onboarding: toService(runtime.onboardingService),
    automation_planner: automationsEnabled ? toService(runtime.automationPlannerService) : null,
    cto_state: toService(buildCtoStateDomainService(runtime)),
    cto_memory: toService(buildCtoMemoryDomainService(runtime)),
    session: toService(buildSessionDomainService(runtime)),
    operation: toService(runtime.operationService),
    ade_project: toService(runtime.adeProjectService),
    project_config: toService(runtime.projectConfigService),
    project_secret: toService(runtime.projectSecretService),
    linear_credentials: toService(runtime.linearCredentialService),
    linear_oauth: buildLinearOAuthDomainService(runtime),
    linear_issue_tracker: toService(buildLinearIssueTrackerDomainService(runtime)),
    github: buildGithubDomainService(runtime),
    feedback: toService(runtime.feedbackReporterService),
    usage: toService(runtime.usageTrackingService),
    analytics: toService(runtime.productAnalyticsService),
    storage: toService(buildStorageDomainService(runtime)),
    budget: toService(runtime.budgetCapService),
    update: toService(runtime.autoUpdateService),
    file: toService(buildFileDomainService(runtime)),
    process: toService(runtime.processService),
    pty: toService(runtime.ptyService),
    terminal: toService(buildTerminalDomainService(runtime)),
    layout: toService(buildLayoutDomainService(runtime)),
    tiling_tree: toService(buildTilingTreeDomainService(runtime)),
    graph_state: toService(buildGraphStateDomainService(runtime)),
    computer_use_artifacts: toService(buildComputerUseArtifactsDomainService(runtime)),
    ios_simulator: toService(runtime.iosSimulatorService),
    app_control: toService(runtime.appControlService),
    built_in_browser: toService(runtime.builtInBrowserService),
    automations: automationsEnabled ? toService(buildAutomationsDomainService(runtime)) : null,
    review: toService(runtime.reviewService),
    issue: toService(buildIssueDomainService(runtime)),
    orchestration: toService(buildOrchestrationDomainService(runtime)),
    search: toService(buildSearchDomainService(runtime)),
    "external-sessions": toService(buildExternalSessionsDomainService(runtime)),
  };
}

export function listAllowedAdeActionNames(
  domain: AdeActionDomain,
  service: Record<string, unknown>,
): string[] {
  const allowed = ADE_ACTION_ALLOWLIST[domain] ?? [];
  return allowed
    .filter((key) => typeof service[key] === "function")
    .sort((a, b) => a.localeCompare(b));
}

export function isAllowedAdeAction(domain: AdeActionDomain, action: string): boolean {
  return (ADE_ACTION_ALLOWLIST[domain] ?? []).includes(action);
}
