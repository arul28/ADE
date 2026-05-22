import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import type {
  AutomationManualTriggerRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationRuleSummary,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
} from "../../../shared/types/automations";
import type { ComputerUseOwnerSnapshotArgs } from "../../../shared/types/computerUseArtifacts";
import type {
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatGetTurnFileDiffArgs,
  AgentChatParallelLaunchState,
  AgentChatSetParallelLaunchStateArgs,
  AgentChatTurnFileDiff,
} from "../../../shared/types/chat";
import type { AutomationRule } from "../../../shared/types/config";
import { buildPrAiResolutionContextKey } from "../../../shared/types";
import type {
  OrchestratorChatMessage,
  OrchestratorRun,
  OrchestratorRunGraph,
} from "../../../shared/types/orchestrator";
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
  LaunchPrIssueResolutionFromThreadArgs,
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
  PrIssueResolutionPromptPreviewArgs,
  PrIssueResolutionStartArgs,
  ProxyStatus,
  RebaseResolutionStartArgs,
  AiFeatureKey,
  AiSettingsStatus,
  CtoRunProjectScanResult,
  CtoLinearQuickView,
  CtoSimulateFlowRouteArgs,
  LinearConnectionStatus,
  LinearRouteDecision,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";
import { mergeAiConfig } from "../config/projectConfigService";
import { appendDiffTruncationNotice, MAX_DIFF_SIDE_TEXT_BYTES } from "../diffs/diffService";
import { runGit } from "../git/git";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import { buildLaneListSnapshots } from "../lanes/laneListSnapshotService";
import { launchPrIssueResolutionChat, previewPrIssueResolutionPrompt } from "../prs/prIssueResolver";
import { launchRebaseResolutionChat } from "../prs/prRebaseResolver";
import { mapPermissionModeForModelFamily } from "../prs/resolverUtils";
import { getErrorMessage, isRecord, nowIso } from "../shared/utils";
import { readCoordinatorCheckpoint } from "../orchestrator/missionStateDoc";

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
  "mission",
  "orchestrator",
  "orchestrator_core",
  "mission_budget",
  "cto_state",
  "worker_agent",
  "session",
  "operation",
  "ade_project",
  "project_config",
  "issue_inventory",
  "path_to_merge",
  "flow_policy",
  "linear_credentials",
  "linear_oauth",
  "linear_dispatcher",
  "linear_issue_tracker",
  "linear_sync",
  "linear_ingress",
  "linear_routing",
  "github",
  "feedback",
  "usage",
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
  "macos_vm",
  "automations",
  "review",
  "issue",
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
  path_to_merge: ["startPathToMerge", "stopPathToMerge"],
  linear_credentials: [
    "setToken",
    "setOAuthToken",
    "setOAuthClientCredentials",
    "clearToken",
    "clearOAuthClientCredentials",
  ],
  linear_oauth: ["startSession"],
  github: ["setToken", "clearToken"],
  update: ["quitAndInstall"],
  flow_policy: ["savePolicy", "rollbackRevision"],
  linear_sync: ["runSyncNow", "resolveQueueItem"],
  linear_ingress: ["ensureRelayWebhook"],
  ai: ["updateConfig", "storeApiKey", "deleteApiKey"],
  budget: ["updateConfig"],
  feedback: ["submitPreparedDraft"],
  usage: ["forceRefresh", "poll", "start", "stop"],
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
    "cancelDelete",
    "create",
    "createChild",
    "createFromUnstaged",
    "deferRebaseSuggestion",
    "delete",
    "deleteTemplate",
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
    "getCommitMessage",
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
    "getActivity",
    "getChecks",
    "getComments",
    "getCommits",
    "getConflictAnalysis",
    "getDetail",
    "getDeployments",
    "getForLane",
    "getFiles",
    "getGithubSnapshot",
    "getIntegrationResolutionState",
    "getMergeContext",
    "getMergeContexts",
    "getMobileSnapshot",
    "getPrHealth",
    "getQueueState",
    "getAiSummary",
    "getReviewThreads",
    "getReviews",
    "getStatus",
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
    "issueResolutionStart",
    "issueResolutionPreviewPrompt",
    "launchIssueResolutionFromThread",
    "rebaseResolutionStart",
    "submitReview",
    "updateBody",
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
    "ensureAgentIdentitySession",
    "ensureCtoSession",
    "getAvailableModels",
    "getClaudeSessionInfo",
    "getClaudeSessionMessages",
    "getChatEventHistory",
    "getContextUsage",
    "listClaudeOutputStyles",
    "getSessionCapabilities",
    "getSessionSummary",
    "getSlashCommands",
    "getTurnFileDiff",
    "getParallelLaunchState",
    "interrupt",
    "listClaudePlugins",
    "listClaudeSessions",
    "listSessions",
    "listSubagents",
    "modelCatalog",
    "approveToolUse",
    "codexFuzzyFileSearch",
    "fileSearch",
    "handoffSession",
    "respondToInput",
    "reloadClaudePlugins",
    "rewindFiles",
    "saveTempAttachment",
    "sendMessage",
    "setClaudeOutputStyle",
    "setParallelLaunchState",
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
    "cancelCursorCloudRun",
    "cursorCloudFollowUp",
    "openCursorCloudChat",
  ],
  onboarding: [
    "complete",
    "detectDefaults",
    "detectExistingLanes",
    "getStatus",
    "getTourProgress",
    "markGlossaryTermSeen",
    "markTourCompleted",
    "markTourDismissed",
    "markTutorialCompleted",
    "markTutorialDismissed",
    "markTutorialStarted",
    "markWizardCompleted",
    "markWizardDismissed",
    "resetTourProgress",
    "setDismissed",
    "setTutorialSilenced",
    "shouldPromptTutorial",
    "updateTourStep",
    "updateTutorialAct",
  ],
  automation_planner: ["parseNaturalLanguage", "saveDraft", "simulate", "validateDraft"],
  mission: [
    "addIntervention",
    "addArtifact",
    "archive",
    "clonePhaseProfile",
    "create",
    "delete",
    "deletePhaseItem",
    "deletePhaseProfile",
    "exportPhaseItems",
    "exportPhaseProfile",
    "get",
    "getDashboard",
    "getFullMissionView",
    "getPhaseConfiguration",
    "getRunView",
    "importPhaseItems",
    "importPhaseProfile",
    "list",
    "listPhaseItems",
    "listPhaseProfiles",
    "preflight",
    "resolveIntervention",
    "savePhaseItem",
    "savePhaseProfile",
    "update",
    "updateStep",
  ],
  orchestrator: [
    "cancelRunGracefully",
    "cleanupTeamResources",
    "finalizeRun",
    "getActiveAgents",
    "getAggregatedUsage",
    "getChat",
    "getContextCheckpoint",
    "getExecutionPlanPreview",
    "getGlobalChat",
    "getMissionLogs",
    "getMissionMetrics",
    "getMissionStateDocument",
    "getModelCapabilities",
    "getCheckpointStatus",
    "getPlanningPromptPreview",
    "getPromptInspector",
    "getRunView",
    "getTeamMembers",
    "getThreadMessages",
    "getWorkerDigest",
    "getWorkerStates",
    "exportMissionLogs",
    "listArtifacts",
    "listChatThreads",
    "listLaneDecisions",
    "listWorkerCheckpoints",
    "listWorkerDigests",
    "resumeRun",
    "sendAgentMessage",
    "sendChat",
    "sendThreadMessage",
    "setMissionMetricsConfig",
    "startMissionRun",
    "steerMission",
  ],
  orchestrator_core: [
    "addReflection",
    "addSteps",
    "appendRuntimeEvent",
    "appendTimelineEvent",
    "completeAttempt",
    "createHandoff",
    "emitRuntimeUpdate",
    "finalizeRun",
    "getLatestGateReport",
    "getRunGraph",
    "getRunState",
    "heartbeatClaims",
    "listAttempts",
    "listRetrospectivePatternStats",
    "listRetrospectiveTrends",
    "listRetrospectives",
    "listRuns",
    "listTimeline",
    "pauseRun",
    "resumeRun",
    "skipStep",
    "startAttempt",
    "startRun",
    "startReadyAutopilotAttempts",
    "supersedeStep",
    "tick",
    "updateStepDependencies",
    "updateStepMetadata",
  ],
  mission_budget: ["getMissionBudgetStatus", "getMissionBudgetTelemetry"],
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
  worker_agent: [
    "clearAgentTaskSession",
    "getBudgetSnapshot",
    "listAgents",
    "listAgentRevisions",
    "listAgentRuns",
    "listSessionLogs",
    "listAgentTaskSessions",
    "removeAgent",
    "rollbackAgentRevision",
    "saveAgent",
    "setAgentStatus",
    "triggerWakeup",
  ],
  session: ["deleteSession", "get", "getDelta", "list", "readTranscriptTail", "updateMeta"],
  operation: ["finish", "get", "list", "start"],
  ade_project: ["clearLocalData", "getSnapshot", "initializeOrRepair", "runIntegrityCheck"],
  project_config: ["confirmTrust", "diffAgainstDisk", "get", "save", "validate"],
  issue_inventory: [
    "deletePipelineSettings",
    "getConvergenceRuntime",
    "getConvergenceStatus",
    "getInventory",
    "getNewItems",
    "getPipelineSettings",
    "markDismissed",
    "markEscalated",
    "markFixed",
    "markSentToAgent",
    "reconcileConvergenceSessionExit",
    "resetConvergenceRuntime",
    "resetInventory",
    "saveConvergenceRuntime",
    "savePipelineSettings",
    "syncFromPrData",
  ],
  path_to_merge: [
    "startPathToMerge",
    "stopPathToMerge",
  ],
  flow_policy: [
    "diffPolicyPaths",
    "getPolicy",
    "listRevisions",
    "normalizePolicy",
    "rollbackRevision",
    "savePolicy",
  ],
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
  linear_dispatcher: ["dispatchIssue", "getDashboard", "listEmployees", "listQueue"],
  linear_issue_tracker: [
    "createComment",
    "fetchIssueById",
    "fetchIssuesByIds",
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
    "searchIssues",
    "updateIssueAssignee",
  ],
  linear_sync: ["getDashboard", "getRunDetail", "listQueue", "resolveQueueItem", "runSyncNow"],
  linear_ingress: ["ensureRelayWebhook", "getStatus", "listRecentEvents"],
  linear_routing: ["simulateRoute"],
  github: [
    "clearToken",
    "detectRepo",
    "getRepoOrThrow",
    "getRemoteStatus",
    "getStatus",
    "createRepoAutolink",
    "listRepoAutolinks",
    "listRepoCollaborators",
    "listRepoLabels",
    "publishCurrentProject",
    "setToken",
  ],
  feedback: ["list", "prepareDraft", "submitPreparedDraft"],
  usage: ["forceRefresh", "getUsageSnapshot", "poll", "start", "stop"],
  budget: ["checkBudget", "getConfig", "getCumulativeUsage", "recordUsage", "updateConfig"],
  update: ["checkForUpdates", "dismissInstalledNotice", "getSnapshot", "quitAndInstall"],
  file: [
    "createDirectory",
    "createFile",
    "deletePath",
    "listTree",
    "listWorkspaces",
    "quickOpen",
    "readFile",
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
  pty: ["create", "dispose", "list", "resize", "sendToSession", "write"],
  terminal: ["list", "read", "preview", "write", "resize", "signal", "activeForChat", "reattachChatCli"],
  layout: ["get", "set"],
  tiling_tree: ["get", "set"],
  graph_state: ["get", "set"],
  computer_use_artifacts: ["getOwnerSnapshot", "ingest", "listArtifacts", "readArtifactPreview", "routeArtifact", "updateArtifactReview"],
  ios_simulator: ["getStatus", "listDevices", "listLaunchTargets", "launch", "attachToChatSession", "shutdown", "screenshot", "getScreenSnapshot", "getInspectorSnapshot", "inspectPoint", "getPreviewCapability", "listPreviewTargets", "renderPreview", "openPreviewWorkspace", "startStream", "stopStream", "getStreamStatus", "tap", "typeText", "drag", "swipe", "selectPoint"],
  app_control: ["getStatus", "launch", "launchInTerminal", "connect", "stop", "screenshot", "getSnapshot", "inspectPoint", "selectPoint", "click", "typeText", "scroll", "dispatchKey", "listTargets", "attachToTarget", "readTerminal", "writeTerminal", "signalTerminal"],
  built_in_browser: ["getStatus", "showPanel", "setBounds", "navigate", "createTab", "switchTab", "closeTab", "reload", "goBack", "goForward", "stop", "startInspect", "stopInspect", "captureScreenshot", "selectPoint", "selectCurrent", "clearSelection"],
  // Note: detachLane is intentionally NOT in this allowlist — it lives on
  // laneService.detachVmLane, not on macosVmService. Wire it through a lane
  // action if/when it needs to be agent-callable.
  //
  // Note: setCredentials and getDisplaySession are intentionally NOT in this
  // allowlist either. setCredentials mutates Keychain-backed VM credentials;
  // getDisplaySession returns the live VNC password. Neither belongs on the
  // generic agent-callable surface — keep them behind the typed CLI / IPC
  // paths (`ade macos-vm set-credentials`, `ade macos-vm display-session`)
  // which run with CTO-level authentication.
  macos_vm: ["getStatus", "getStorageInfo", "provision", "start", "stop", "restart", "delete", "wipe", "installRuntime", "getCredentials", "getAgentGuide", "getSharePolicy", "focusWindow", "captureScreenshot", "click", "selectPoint", "typeText"],
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
    "listIngressEvents",
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
};

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
  listIngressEvents(args?: { limit?: number }): AutomationIngressEventRecord[];
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
    listIngressEvents: (args = {}) => automationService.listIngressEvents(args.limit),
  };
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

const MAX_TEMP_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function agentChatParallelLaunchStateKey(projectRoot: string, parentLaneId: string): string {
  return `agent-chat-parallel-launch:${projectRoot}:${parentLaneId}`;
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

function buildChatDomainService(runtime: AdeRuntime): OpaqueService | null {
  const agentChatService = runtime.agentChatService;
  if (!agentChatService) return null;
  const base = agentChatService as unknown as OpaqueService;
  return {
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
    ensureAgentIdentitySession: async (args?: {
      agentId?: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
    }) => {
      const agentId = requireNonEmptyString(args?.agentId, "agentId");
      const laneId = await resolvePrimaryLaneId(runtime);
      return agentChatService.ensureIdentitySession({
        identityKey: `agent:${agentId}`,
        laneId,
        modelId: args?.modelId ?? null,
        reasoningEffort: args?.reasoningEffort ?? null,
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
    modelCatalog: (args?: unknown) =>
      agentChatService.getModelCatalog(args && typeof args === "object" ? args as never : undefined),
    setParallelLaunchState: (args?: AgentChatSetParallelLaunchStateArgs) => {
      const parentLaneId = requireNonEmptyString(args?.parentLaneId, "parentLaneId");
      const key = agentChatParallelLaunchStateKey(runtime.projectRoot, parentLaneId);
      runtime.db.setJson(key, normalizeAgentChatParallelLaunchState(args?.state ?? null, parentLaneId));
    },
    fileSearch: async (args?: AgentChatFileSearchArgs): Promise<AgentChatFileSearchResult[]> => {
      const sessionId = requireNonEmptyString(args?.sessionId, "sessionId");
      const query = typeof args?.query === "string" ? args.query : "";
      const session = (await agentChatService.listSessions()).find((entry) => entry.sessionId === sessionId);
      if (!session?.laneId || !runtime.fileService) return [];
      const matches = await runtime.fileService.quickOpen({
        workspaceId: session.laneId,
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
  };
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
  };
}

function buildWorkerAgentDomainService(runtime: AdeRuntime): OpaqueService | null {
  const workerAgentService = runtime.workerAgentService;
  if (!workerAgentService) return null;
  return {
    ...(workerAgentService as unknown as OpaqueService),
    saveAgent: (args?: { agent?: unknown; actor?: string }) =>
      requireService(runtime.workerRevisionService, "Worker revision service not available.").saveAgent(
        args?.agent as never,
        args?.actor ?? "user",
      ),
    removeAgent: (args?: { agentId?: string }) => {
      workerAgentService.removeAgent(requireNonEmptyString(args?.agentId, "agentId"));
      runtime.workerHeartbeatService?.syncFromConfig();
    },
    setAgentStatus: (args?: { agentId?: string; status?: string }) => {
      workerAgentService.setAgentStatus(requireNonEmptyString(args?.agentId, "agentId"), args?.status as never);
      runtime.workerHeartbeatService?.syncFromConfig();
    },
    listAgentRevisions: (args?: { agentId?: string; limit?: number }) =>
      requireService(runtime.workerRevisionService, "Worker revision service not available.").listAgentRevisions(
        requireNonEmptyString(args?.agentId, "agentId"),
        args?.limit ?? 20,
      ),
    rollbackAgentRevision: (args?: { agentId?: string; revisionId?: string; actor?: string }) =>
      requireService(runtime.workerRevisionService, "Worker revision service not available.").rollbackAgentRevision(
        requireNonEmptyString(args?.agentId, "agentId"),
        requireNonEmptyString(args?.revisionId, "revisionId"),
        args?.actor ?? "user",
      ),
    getBudgetSnapshot: (args?: { monthKey?: string }) =>
      requireService(runtime.workerBudgetService, "Worker budget service not available.").getBudgetSnapshot(
        args?.monthKey ? { monthKey: args.monthKey } : {},
      ),
    triggerWakeup: (args?: unknown) =>
      requireService(runtime.workerHeartbeatService, "Worker heartbeat service not available.").triggerWakeup(args as never),
    listAgentRuns: (args?: unknown) =>
      requireService(runtime.workerHeartbeatService, "Worker heartbeat service not available.").listRuns(args as never),
    clearAgentTaskSession: (args?: unknown) =>
      requireService(runtime.workerTaskSessionService, "Worker task session service not available.").clearAgentTaskSession(args as never),
    listAgentTaskSessions: (args?: { agentId?: string; limit?: number }) =>
      requireService(runtime.workerTaskSessionService, "Worker task session service not available.").listAgentTaskSessions(
        requireNonEmptyString(args?.agentId, "agentId"),
        args?.limit ?? 40,
      ),
  };
}

const RUNTIME_CURSOR_DOC_REF_TRANSPORT_LIMIT = 12;
const PAYLOAD_DOC_REF_TRANSPORT_LIMIT = 12;
const RUN_GRAPH_CONTEXT_SNAPSHOT_TRANSPORT_LIMIT = 5;
const CHAT_TOOL_RESULT_STRING_LIMIT = 1_200;
const CHAT_TOOL_RESULT_ARRAY_PREVIEW_LIMIT = 5;
const CHAT_TOOL_RESULT_KEY_PREVIEW_LIMIT = 12;

function isAdeInternalDocPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\\/g, "/");
  return normalized === ".ade" || normalized.startsWith(".ade/") || normalized.includes("/.ade/");
}

function compactRuntimeCursorForTransport(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const rawDocs = Array.isArray(value.docs) ? value.docs : [];
  const docs = rawDocs
    .filter((entry) => !isAdeInternalDocPath(isRecord(entry) ? entry.path : null))
    .slice(0, RUNTIME_CURSOR_DOC_REF_TRANSPORT_LIMIT)
    .map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        path: typeof entry.path === "string" ? entry.path : "",
        bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
        truncated: entry.truncated === true,
        mode: typeof entry.mode === "string" ? entry.mode : undefined,
      };
    });
  return {
    ...value,
    docs,
    docsOmittedCount: Math.max(0, rawDocs.length - docs.length),
  };
}

function compactDocRefsArrayForTransport(rawDocs: unknown[], limit: number): unknown[] {
  return rawDocs
    .filter((entry) => !isAdeInternalDocPath(isRecord(entry) ? entry.path : null))
    .slice(0, limit);
}

function compactPayloadForTransport(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return payload;
  const next: Record<string, unknown> = { ...payload };
  if (Array.isArray(next.docsRefs)) {
    const rawDocsRefs = next.docsRefs;
    const docsRefs = compactDocRefsArrayForTransport(rawDocsRefs, PAYLOAD_DOC_REF_TRANSPORT_LIMIT);
    next.docsRefs = docsRefs;
    next.docsRefsOmittedCount = Math.max(0, rawDocsRefs.length - docsRefs.length);
  }
  return next;
}

function compactChatToolValueForTransport(value: unknown): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length <= CHAT_TOOL_RESULT_STRING_LIMIT) return value;
    return {
      preview: value.slice(0, CHAT_TOOL_RESULT_STRING_LIMIT),
      omittedChars: value.length - CHAT_TOOL_RESULT_STRING_LIMIT,
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value
        .slice(0, CHAT_TOOL_RESULT_ARRAY_PREVIEW_LIMIT)
        .map((entry) => compactChatToolValueForTransport(entry)),
      omittedItems: Math.max(0, value.length - CHAT_TOOL_RESULT_ARRAY_PREVIEW_LIMIT),
    };
  }
  if (!isRecord(value)) return value;

  const safeKeys = [
    "ok",
    "status",
    "outcome",
    "summary",
    "message",
    "error",
    "workerId",
    "stepId",
    "stepKey",
    "runId",
    "missionId",
    "filesChanged",
    "testsRun",
    "artifacts",
  ];
  const next: Record<string, unknown> = {};
  for (const key of safeKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      next[key] = compactChatToolValueForTransport(value[key]);
    }
  }
  const keys = Object.keys(value);
  next.__adeTransportCompact = true;
  next.keys = keys.slice(0, CHAT_TOOL_RESULT_KEY_PREVIEW_LIMIT);
  next.omittedKeys = Math.max(0, keys.length - CHAT_TOOL_RESULT_KEY_PREVIEW_LIMIT);
  return next;
}

function compactChatMessageMetadataForTransport(metadata: OrchestratorChatMessage["metadata"]): OrchestratorChatMessage["metadata"] {
  if (!isRecord(metadata)) return metadata;
  const structuredStream = isRecord(metadata.structuredStream) ? metadata.structuredStream : null;
  if (!structuredStream) return metadata;
  const nextStructured = { ...structuredStream };
  if (Object.prototype.hasOwnProperty.call(nextStructured, "result")) {
    nextStructured.result = compactChatToolValueForTransport(nextStructured.result);
  }
  return {
    ...metadata,
    structuredStream: nextStructured,
  };
}

function compactChatMessageForTransport(message: OrchestratorChatMessage): OrchestratorChatMessage {
  return {
    ...message,
    metadata: compactChatMessageMetadataForTransport(message.metadata),
  };
}

function compactRunMetadataForTransport(metadata: OrchestratorRun["metadata"]): OrchestratorRun["metadata"] {
  if (!isRecord(metadata)) return metadata;
  const next: Record<string, unknown> = { ...metadata };
  if (isRecord(next.runtimeCursor)) {
    next.runtimeCursor = compactRuntimeCursorForTransport(next.runtimeCursor);
  }
  return next;
}

function compactRunForTransport(run: OrchestratorRun): OrchestratorRun {
  return {
    ...run,
    metadata: compactRunMetadataForTransport(run.metadata),
  };
}

function compactRunGraphForTransport(graph: OrchestratorRunGraph): OrchestratorRunGraph {
  return {
    ...graph,
    run: compactRunForTransport(graph.run),
    contextSnapshots: graph.contextSnapshots
      .slice(0, RUN_GRAPH_CONTEXT_SNAPSHOT_TRANSPORT_LIMIT)
      .map((snapshot) => ({
        ...snapshot,
        cursor: compactRuntimeCursorForTransport(snapshot.cursor) as typeof snapshot.cursor,
      })),
    handoffs: graph.handoffs.map((handoff) => ({
      ...handoff,
      payload: compactPayloadForTransport(handoff.payload) ?? {},
    })),
    timeline: graph.timeline.map((event) => ({
      ...event,
      detail: compactPayloadForTransport(event.detail),
    })),
    runtimeEvents: graph.runtimeEvents?.map((event) => ({
      ...event,
      payload: compactPayloadForTransport(event.payload),
    })),
  };
}

function buildMissionDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.missionService;
  if (!service) return null;
  return {
    ...(service as OpaqueService),
    async getFullMissionView(args?: unknown): Promise<Record<string, unknown>> {
      const request = asActionRecord(args);
      const missionId = typeof request.missionId === "string" ? request.missionId.trim() : "";
      if (!missionId) {
        return { mission: null, runGraph: null, artifacts: [], checkpoints: [], dashboard: null };
      }

      let dashboard: unknown = null;
      try {
        dashboard = service.getDashboard();
      } catch {
        // Dashboard is supplemental for this composed view.
      }

      const mission = await service.get(missionId);
      let runGraph: unknown = null;
      let artifacts: unknown[] = [];
      let checkpoints: unknown[] = [];

      const orchestratorService = requireService(runtime.orchestratorService, "Orchestrator service not available.");
      const aiOrchestratorService = requireService(runtime.aiOrchestratorService, "AI orchestrator service not available.");
      const runs = await orchestratorService.listRuns({ missionId, limit: 20 });
      const activeStatuses = new Set(["active", "bootstrapping", "queued", "paused"]);
      const preferredRun = runs.find((entry) => activeStatuses.has(entry.status)) ?? runs[0];
      if (preferredRun) {
        const [graph, arts, cps] = await Promise.all([
          Promise.resolve(orchestratorService.getRunGraph({ runId: preferredRun.id, timelineLimit: 120 })),
          Promise.resolve(aiOrchestratorService.listArtifacts({ missionId, runId: preferredRun.id })).catch(() => []),
          Promise.resolve(aiOrchestratorService.listWorkerCheckpoints({ missionId, runId: preferredRun.id })).catch(() => []),
        ]);
        runGraph = compactRunGraphForTransport(graph);
        artifacts = Array.isArray(arts) ? arts : [];
        checkpoints = Array.isArray(cps) ? cps : [];
      }

      return { mission, runGraph, artifacts, checkpoints, dashboard };
    },
    preflight(args?: unknown): Promise<unknown> {
      const missionPreflightService = requireService(runtime.missionPreflightService, "Mission preflight service not available.");
      return missionPreflightService.runPreflight(asActionRecord(args) as never);
    },
    getRunView(args?: unknown): Promise<unknown> {
      const aiOrchestratorService = requireService(runtime.aiOrchestratorService, "AI orchestrator service not available.");
      return aiOrchestratorService.getRunView(asActionRecord(args) as never);
    },
  };
}

async function waitForMissionCloseoutAfterFinalize(
  runtime: AdeRuntime,
  runId: string,
  result: unknown,
): Promise<void> {
  const finalized = asActionRecord(result).finalized === true;
  const finalStatus = String(asActionRecord(result).finalStatus ?? "");
  if (!finalized || finalStatus !== "succeeded" || !runtime.orchestratorService || !runtime.missionService) return;

  let missionId = "";
  try {
    const graph = runtime.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
    missionId = String(graph.run.missionId ?? "").trim();
  } catch {
    return;
  }
  if (!missionId) return;

  const terminalMissionStatuses = new Set(["completed", "failed", "canceled", "intervention_required"]);
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    let mission: Awaited<ReturnType<typeof runtime.missionService.get>> | null = null;
    try {
      mission = await Promise.resolve(runtime.missionService.get(missionId));
    } catch {
      return;
    }
    const status = typeof mission?.status === "string" ? mission.status : "";
    if (terminalMissionStatuses.has(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function buildOrchestratorCoreDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.orchestratorService;
  if (!service) return null;
  return {
    ...(service as OpaqueService),
    listRuns: (args?: Parameters<typeof service.listRuns>[0]) =>
      service.listRuns(args).map(compactRunForTransport),
    getRunGraph: (args: Parameters<typeof service.getRunGraph>[0]) =>
      compactRunGraphForTransport(service.getRunGraph(args)),
    startRun: (args: Parameters<typeof service.startRun>[0]) => {
      const started = service.startRun(args);
      return { ...started, run: compactRunForTransport(started.run) };
    },
    tick: (args: Parameters<typeof service.tick>[0]) =>
      compactRunForTransport(service.tick(args)),
    pauseRun: (args: Parameters<typeof service.pauseRun>[0]) =>
      compactRunForTransport(service.pauseRun(args)),
    resumeRun: (args: Parameters<typeof service.resumeRun>[0]) =>
      compactRunForTransport(service.resumeRun(args)),
    finalizeRun: async (args: Parameters<typeof service.finalizeRun>[0]) => {
      const result = await (runtime.aiOrchestratorService?.finalizeRun
        ? runtime.aiOrchestratorService.finalizeRun(args as never)
        : service.finalizeRun(args));
      await waitForMissionCloseoutAfterFinalize(runtime, args.runId, result);
      return result;
    },
  };
}

function buildAiOrchestratorDomainService(runtime: AdeRuntime): OpaqueService | null {
  const service = runtime.aiOrchestratorService;
  if (!service) return null;
  return {
    ...(service as OpaqueService),
    sendChat: async (args: Parameters<typeof service.sendChat>[0]) =>
      compactChatMessageForTransport(await service.sendChat(args)),
    getChat: (args: Parameters<typeof service.getChat>[0]) =>
      service.getChat(args).map(compactChatMessageForTransport),
    getThreadMessages: (args: Parameters<typeof service.getThreadMessages>[0]) =>
      service.getThreadMessages(args).map(compactChatMessageForTransport),
    sendThreadMessage: async (args: Parameters<typeof service.sendThreadMessage>[0]) =>
      compactChatMessageForTransport(await service.sendThreadMessage(args)),
    finalizeRun: async (args: Parameters<typeof service.finalizeRun>[0]) => {
      const result = await service.finalizeRun(args);
      await waitForMissionCloseoutAfterFinalize(runtime, args.runId, result);
      return result;
    },
    cancelRunGracefully: async (args: Parameters<typeof service.cancelRunGracefully>[0]) =>
      compactRunForTransport(await service.cancelRunGracefully(args)),
    resumeRun: async (args: Parameters<typeof service.resumeRun>[0]) =>
      compactRunForTransport(await service.resumeRun(args)),
    startMissionRun: async (args: Parameters<typeof service.startMissionRun>[0]) => {
      const result = await service.startMissionRun(args);
      return result?.started
        ? { ...result, started: { ...result.started, run: compactRunForTransport(result.started.run) } }
        : result;
    },
    getGlobalChat: (args: Parameters<typeof service.getGlobalChat>[0]) =>
      service.getGlobalChat(args).map(compactChatMessageForTransport),
    sendAgentMessage: async (args: Parameters<typeof service.sendAgentMessage>[0]) =>
      compactChatMessageForTransport(await service.sendAgentMessage(args)),
    async getCheckpointStatus(args?: unknown): Promise<Record<string, unknown> | null> {
      const runId = typeof asActionRecord(args).runId === "string"
        ? String(asActionRecord(args).runId).trim()
        : "";
      if (!runId) return null;
      const checkpoint = await readCoordinatorCheckpoint(runtime.projectRoot, runId);
      if (!checkpoint) return null;
      return {
        savedAt: checkpoint.savedAt,
        turnCount: checkpoint.turnCount,
        compactionCount: checkpoint.compactionCount,
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
      runtime.conflictService?.dismissRebase(laneId);
      await runtime.rebaseSuggestionService?.dismiss({ laneId });
    },
    deferRebaseSuggestion: async (args?: { laneId?: string; minutes?: number }) => {
      const laneId = requireNonEmptyString(args?.laneId, "laneId");
      const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(args?.minutes ?? 60)));
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      runtime.conflictService?.deferRebase(laneId, until);
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
  "mission_planning",
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

function buildIssueResolutionInstructionsFromThread(arg: LaunchPrIssueResolutionFromThreadArgs): string {
  const lines = [`Focus on review thread ${arg.threadId} on PR ${arg.prId}.`];
  if (arg.commentId) {
    lines.push(`The relevant comment id is ${arg.commentId}.`);
  }
  const fileContext = arg.fileContext;
  if (fileContext?.path) {
    const lineNumber = fileContext.startLine ?? fileContext.line ?? null;
    lines.push(
      lineNumber != null
        ? `Start by inspecting ${fileContext.path}:${lineNumber}.`
        : `Start by inspecting ${fileContext.path}.`,
    );
  }
  if (arg.additionalInstructions) {
    lines.push("", arg.additionalInstructions);
  }
  return lines.join("\n");
}

function buildPrIssueResolutionDeps(runtime: AdeRuntime) {
  return {
    prService: requireService(runtime.prService, "PR service not available."),
    laneService: runtime.laneService,
    agentChatService: requireService(runtime.agentChatService, "Agent chat service not available."),
    sessionService: runtime.sessionService,
    issueInventoryService: runtime.issueInventoryService,
    laneWorktreeLockService: runtime.laneWorktreeLockService ?? null,
  };
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

async function persistIssueResolutionRuntime(
  runtime: AdeRuntime,
  args: PrIssueResolutionStartArgs,
  result: { sessionId: string; laneId: string; href: string },
): Promise<void> {
  try {
    const status = runtime.issueInventoryService.getConvergenceStatus(args.prId);
    runtime.issueInventoryService.saveConvergenceRuntime(args.prId, {
      currentRound: status.currentRound,
      status: "running",
      pollerStatus: "idle",
      activeSessionId: result.sessionId,
      activeLaneId: result.laneId,
      activeHref: result.href,
      lastStartedAt: nowIso(),
      errorMessage: null,
      pauseReason: null,
    });
  } catch (error) {
    runtime.logger.warn("ade_actions.pr_issue_resolution_convergence_persist_failed", {
      prId: args.prId,
      sessionId: result.sessionId,
      laneId: result.laneId,
      href: result.href,
      error: getErrorMessage(error),
    });
  }
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
    async issueResolutionStart(args?: unknown) {
      const startArgs = asActionRecord(args) as unknown as PrIssueResolutionStartArgs;
      const result = await launchPrIssueResolutionChat(buildPrIssueResolutionDeps(runtime), startArgs);
      await persistIssueResolutionRuntime(runtime, startArgs, result);
      return result;
    },
    issueResolutionPreviewPrompt(args?: unknown) {
      return previewPrIssueResolutionPrompt(
        buildPrIssueResolutionDeps(runtime),
        asActionRecord(args) as unknown as PrIssueResolutionPromptPreviewArgs,
      );
    },
    rebaseResolutionStart(args?: unknown) {
      return launchRebaseResolutionChat(
        {
          laneService: runtime.laneService,
          agentChatService: requireService(runtime.agentChatService, "Agent chat service not available."),
          sessionService: runtime.sessionService,
          conflictService: runtime.conflictService,
        },
        asActionRecord(args) as unknown as RebaseResolutionStartArgs,
      );
    },
    async launchIssueResolutionFromThread(args?: unknown) {
      const threadArgs = asActionRecord(args) as unknown as LaunchPrIssueResolutionFromThreadArgs;
      if (!threadArgs.modelId) {
        throw new Error("modelId is required for launchIssueResolutionFromThread.");
      }
      const startArgs: PrIssueResolutionStartArgs = {
        prId: threadArgs.prId,
        scope: "comments",
        modelId: threadArgs.modelId,
        reasoning: threadArgs.reasoning ?? null,
        permissionMode: threadArgs.permissionMode,
        additionalInstructions: buildIssueResolutionInstructionsFromThread(threadArgs),
      };
      const result = await launchPrIssueResolutionChat(buildPrIssueResolutionDeps(runtime), startArgs);
      await persistIssueResolutionRuntime(runtime, startArgs, result);
      return result;
    },
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
      return githubService.publishCurrentProject({
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
  return {
    ...(tracker as unknown as OpaqueService),
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

function normalizeSimulatedLinearIssue(runtime: AdeRuntime, args?: CtoSimulateFlowRouteArgs): NormalizedLinearIssue {
  const issueInput = args?.issue;
  if (!issueInput?.title?.trim()) {
    throw new Error("issue.title is required.");
  }
  const policy = runtime.flowPolicyService?.getPolicy();
  const defaultProjectSlug =
    policy?.workflows.flatMap((workflow) => workflow.triggers.projectSlugs ?? []).find(Boolean)
    ?? policy?.legacyConfig?.projects?.[0]?.slug
    ?? "sim-project";
  const now = nowIso();
  return {
    id: issueInput.id ?? `sim-${randomUUID()}`,
    identifier: issueInput.identifier ?? "SIM-1",
    title: issueInput.title,
    description: issueInput.description ?? "",
    url: issueInput.url ?? null,
    projectId: issueInput.projectId ?? "sim-project",
    projectSlug: issueInput.projectSlug ?? defaultProjectSlug,
    teamId: issueInput.teamId ?? "sim-team",
    teamKey: issueInput.teamKey ?? "SIM",
    stateId: issueInput.stateId ?? "sim-state",
    stateName: issueInput.stateName ?? "Todo",
    stateType: issueInput.stateType ?? "unstarted",
    priority: Number.isFinite(Number(issueInput.priority)) ? Number(issueInput.priority) : 3,
    priorityLabel: issueInput.priorityLabel ?? "normal",
    labels: Array.isArray(issueInput.labels) ? issueInput.labels : [],
    metadataTags: Array.isArray(issueInput.metadataTags) ? issueInput.metadataTags : [],
    assigneeId: issueInput.assigneeId ?? null,
    assigneeName: issueInput.assigneeName ?? null,
    ownerId: issueInput.ownerId ?? null,
    creatorId: issueInput.creatorId ?? null,
    creatorName: issueInput.creatorName ?? null,
    blockerIssueIds: Array.isArray(issueInput.blockerIssueIds) ? issueInput.blockerIssueIds : [],
    hasOpenBlockers: Boolean(issueInput.hasOpenBlockers),
    createdAt: issueInput.createdAt ?? now,
    updatedAt: issueInput.updatedAt ?? now,
    raw: isRecord(issueInput.raw) ? issueInput.raw : {},
  };
}

function buildLinearRoutingDomainService(runtime: AdeRuntime): OpaqueService | null {
  const routingService = runtime.linearRoutingService;
  if (!routingService) return null;
  return {
    ...(routingService as unknown as OpaqueService),
    simulateRoute: (args?: CtoSimulateFlowRouteArgs): Promise<LinearRouteDecision> =>
      routingService.simulateRoute({ issue: normalizeSimulatedLinearIssue(runtime, args) }),
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

export function getAdeActionDomainServices(
  runtime: AdeRuntime,
): Partial<Record<AdeActionDomain, OpaqueService | null | undefined>> {
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
    automation_planner: toService(runtime.automationPlannerService),
    mission: toService(buildMissionDomainService(runtime)),
    orchestrator: toService(buildAiOrchestratorDomainService(runtime)),
    orchestrator_core: toService(buildOrchestratorCoreDomainService(runtime)),
    mission_budget: toService(runtime.missionBudgetService),
    cto_state: toService(buildCtoStateDomainService(runtime)),
    worker_agent: toService(buildWorkerAgentDomainService(runtime)),
    session: toService(buildSessionDomainService(runtime)),
    operation: toService(runtime.operationService),
    ade_project: toService(runtime.adeProjectService),
    project_config: toService(runtime.projectConfigService),
    issue_inventory: toService(runtime.issueInventoryService),
    path_to_merge: toService(runtime.pathToMergeOrchestrator),
    flow_policy: toService(runtime.flowPolicyService),
    linear_credentials: toService(runtime.linearCredentialService),
    linear_oauth: buildLinearOAuthDomainService(runtime),
    linear_dispatcher: toService(runtime.linearDispatcherService),
    linear_issue_tracker: toService(buildLinearIssueTrackerDomainService(runtime)),
    linear_sync: toService(runtime.linearSyncService),
    linear_ingress: toService(runtime.linearIngressService),
    linear_routing: toService(buildLinearRoutingDomainService(runtime)),
    github: buildGithubDomainService(runtime),
    feedback: toService(runtime.feedbackReporterService),
    usage: toService(runtime.usageTrackingService),
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
    macos_vm: toService(runtime.macosVmService),
    automations: toService(buildAutomationsDomainService(runtime)),
    review: toService(runtime.reviewService),
    issue: toService(buildIssueDomainService(runtime)),
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
