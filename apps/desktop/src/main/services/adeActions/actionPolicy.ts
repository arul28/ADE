import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import type { AdeActionDomain } from "./domains";

/* ──────────────────────────────────────────────────────────────────────────
   WHO MAY CALL WHAT.

   Two tables and the predicates that read them, and nothing else:
   `ADE_ACTION_ALLOWLIST` says an action is reachable through the generic action
   bus at all, and `ADE_ACTION_CTO_ONLY` says it needs `cto` role once it is.
   They live here rather than in `registry.ts` because they depend on no
   runtime, and because a security-adjacent gate reads better without 4,000
   lines of service wiring around it — which only holds if the predicates come
   with the data, so a caller asking a question about a table does not have to
   load the registry's whole service graph to get an answer.
   ────────────────────────────────────────────────────────────────────────── */

export type AdeActionRole = "cto" | "orchestrator" | "agent" | "external" | "evaluator";

/**
 * A domain's CTO-only rule, with its polarity as DATA.
 *
 * `only` names the CTO-only actions. `allExcept` inverts it: everything in the
 * domain is CTO-only except the actions named, so a method added later is
 * CTO-only by omission. One table, because two tables of opposite polarity
 * meant one silently shadowed the other — a domain with an `allExcept` rule
 * ignored anything added to its `only` list, and nothing said so.
 */
export type CtoOnlyRule =
  | { only: readonly string[] }
  | { allExcept: readonly string[] };

/**
 * Methods that require at least `cto` role when invoked via `run_ade_action`.
 * The generic bridge has no built-in role check, so anything that mutates
 * account-level credentials, persisted policy, or drives privileged polling
 * must be listed here.
 */
export const ADE_ACTION_CTO_ONLY: Partial<Record<AdeActionDomain, CtoOnlyRule>> = {
  account: {
    only: [
      "startLogin",
      "pollLogin",
      "startDeviceLogin",
      "pollDeviceLogin",
      "cancelLogin",
      "signOut",
      "getToken",
      "createToken",
      "listMachines",
      "pairMachine",
      "deleteMachine",
    ],
  },
  attention: {
    only: [
      "getSnapshot",
      "acknowledge",
      "reportPresence",
      "getPreferences",
      "putPreferences",
      "putMachinePreferences",
    ],
  },
  linear_credentials: {
    only: [
      "setToken",
      "setOAuthToken",
      "setOAuthClientCredentials",
      "clearToken",
      "clearOAuthClientCredentials",
    ],
  },
  linear_oauth: { only: ["startSession"] },
  github: { only: ["setToken", "clearToken", "startAppUserDeviceAuth", "pollAppUserDeviceAuth", "clearAppUserAuth"] },
  update: { only: ["quitAndInstall"] },
  // Linear webhook lifecycle mutates account-level state (registers/deletes a
  // webhook against the user's Linear organization), so it stays CTO-only;
  // status/poll/cleanup reads remain open to agents.
  // cancelScheduledCleanup can silently defeat a cleanup policy another
  // automation scheduled, so it is operator-only like the webhook lifecycle.
  automations: { only: ["setWebhookGatewayPublicUrl", "linearIngressSetup", "linearIngressTeardown", "cancelScheduledCleanup"] },
  ai: { only: ["updateConfig", "storeApiKey", "deleteApiKey", "opencodeOAuthStart", "opencodeOAuthCancel", "setOpencodeProviderKey", "clearOpencodeProviderKey", "refreshModelsDev", "piLoginStart", "piLoginSubmit", "piLoginCancel", "cursorAuthLogin", "cursorAuthLogout", "cursorAuthCancel"] },
  budget: { only: ["updateConfig"] },
  feedback: { only: ["submitPreparedDraft"] },
  // `applyAccountRollups` writes another machine's history into a
  // CRR-replicated table. The desktop app pushes it over the local socket
  // after its own account fan-out; no agent has any reason to call it.
  usage: { only: ["forceRefresh", "refreshHistory", "poll", "start", "stop", "applyAccountRollups"] },
  analytics: { only: ["setEnabled", "flush"] },
  storage: { only: ["cleanup", "runMaintenanceNow"] },
  search: { only: ["rebuildIndex"] },
  project_secret: { only: ["exportEnv"] },
  /*
   * Fail-closed, and that is the whole point. `cto_memory` reads and rewrites the
   * durable memory injected into every CTO session, so it is operator state, not
   * agent state. `recordDiscovery` is the one deliberate exception: it is
   * append-only into a separate, unreviewed file that the CTO distills later, so
   * a worker agent can hand something up without being able to read — or
   * rewrite — what the CTO knows. Listing the exception rather than the
   * restriction means a `cto_memory` method added later is CTO-only by default
   * and cannot be opened up by forgetting to update this file.
   *
   * `getSnapshot` and `searchMemory` are deliberately open, and stay open, for
   * backward compatibility: they were reachable by any agent before this domain
   * was inverted, and automation `ade-action` steps call them. Closing them
   * would be a silent breaking change that protects nothing — CTO memory is
   * plain markdown under `<adeDir>/cto/` inside the project, and every coding
   * agent already has file read access to it, so this gate is not the boundary.
   * `updateMemory` (the rewrite path) stays CTO-only.
   */
  cto_memory: { allExcept: ["recordDiscovery", "getSnapshot", "searchMemory"] },
  // Every settle WRITER is CTO-only on purpose. "Is this work actually done?"
  // is a subjective judgment and agents are unreliable at it, so settlement is
  // reachable only from surfaces that connect at cto role — the desktop
  // renderer's remote-runtime client and the `ade code` TUI, both of which are
  // driven by the user — plus the deterministic PR-merge policy, which never
  // goes through this bridge at all. A session-bound agent CLI authenticates as
  // `agent`/`orchestrator` and is refused here. Do not add a self-service
  // settle action back: see the note above `unsettleSession` below.
  session: {
    only: [
      "settleSession",
      "unsettleSession",
      "settleSessions",
      "unsettleSessions",
      "setSettleOverride",
      "updateLifecycleSettings",
      // A board move writes the same lifecycle columns a settle does, and then
      // tells the agent the user moved it. Both halves are the user's, so it is
      // gated with the rest of them: a session-bound agent authenticating as
      // `agent`/`orchestrator` cannot move its own card and then congratulate
      // itself on being told to.
      "moveOnBoard",
      "undoBoardMove",
    ],
  },
  // Stashes are unsent user-authored drafts. Desktop runtime clients connect
  // without a chat binding at CTO role; session-bound agents must never read
  // or mutate this private composer state through `ade actions`.
  chat: { only: ["listPromptStashes", "createPromptStash", "deletePromptStash"] },
  // ── Domain-coverage decisions (deliberately NOT added here) ──
  // The CTO gained curated tools over automation planning, review runs, search,
  // usage/budget reads, project config reads, iOS-simulator / app-control /
  // browser reads, and orchestration reads. None of those became CTO-only, and
  // each omission is a decision, not an oversight:
  //   • automation_planner.* — `automations.saveRule` already carries the same
  //     power (a rule can run commands and spawn agents) and is open to agents.
  //     Gating the planner while the rule writer stays open protects nothing and
  //     would break `ade-action` automation steps, which are filtered through
  //     `isAutomationAllowedAdeAction` and therefore cannot call CTO-only actions.
  //   • review.* — running a review on your own lane is ordinary agent work, and
  //     a review run mutates nothing outside its own tables.
  //   • ios_simulator / app_control / built_in_browser — device control IS how
  //     agents verify UI work; these are already their normal surface.
  //   • orchestration.* — leads and workers must reach it by construction.
  //   • search.query / indexStatus — reads over an index agents already build.
  //     `search.rebuildIndex` stays CTO-only above (it is a privileged rebuild).
  //   • project_config.get and project_secret.list — reads with no secret VALUES
  //     in them. `project_secret.get`/`exportEnv` remain what they were:
  //     `exportEnv` CTO-only, `get` reachable only when the user asked for that
  //     secret by name. No CTO tool calls either one.
  // Proof lifecycle and ingestion operate on project-scoped persisted bytes.
  // Session-bound agents use the dedicated RPC tools, which derive an owner
  // and filesystem jail from their authenticated chat context.
  computer_use_artifacts: {
    only: [
      "deleteArtifacts",
      "getOwnerSnapshot",
      "listArtifacts",
      "listBrokenArtifacts",
      "pruneBrokenArtifacts",
      "recoverArtifact",
      "updateArtifactReview",
    ],
  },
};

const ROLE_ORDER: Record<AdeActionRole, number> = {
  external: 0,
  evaluator: 1,
  agent: 2,
  orchestrator: 3,
  cto: 4,
};

export function isCtoOnlyAdeAction(domain: AdeActionDomain, action: string): boolean {
  const rule = ADE_ACTION_CTO_ONLY[domain];
  if (!rule) return false;
  return "allExcept" in rule ? !rule.allExcept.includes(action) : rule.only.includes(action);
}

export function callerHasRoleAtLeast(role: AdeActionRole | undefined | null, minRole: AdeActionRole): boolean {
  if (!role) return false;
  return ROLE_ORDER[role] >= ROLE_ORDER[minRole];
}

export const ADE_ACTION_ALLOWLIST: Partial<Record<AdeActionDomain, readonly string[]>> = {
  account: [
    "startLogin",
    "pollLogin",
    "startDeviceLogin",
    "pollDeviceLogin",
    "status",
    "cancelLogin",
    "signOut",
    "getToken",
    "createToken",
  ],
  attention: [
    "getSnapshot",
    "acknowledge",
    "reportPresence",
    "getPreferences",
    "putPreferences",
    "putMachinePreferences",
  ],
  lane: [
    "archive",
    "archiveAndReclaim",
    "attachLinearIssueToSession",
    "attachGitHubIssueToSession",
    "cancelDelete",
    "create",
    "createChild",
    "createFromUnstaged",
    "deferRebaseSuggestion",
    "delete",
    "deleteTemplate",
    "detachLinearIssueFromSession",
    "detachGitHubIssueFromSession",
    "diagnosticsActivateFallback",
    "diagnosticsDeactivateFallback",
    "diagnosticsGetLaneHealth",
    "diagnosticsGetStatus",
    "diagnosticsRunFullCheck",
    "diagnosticsRunHealthCheck",
    "dismissAutoRebaseStatus",
    "dismissRebaseSuggestion",
    "getBranchDrift",
    "getChildren",
    "getDefaultTemplate",
    "getDeleteRisk",
    "getReclaimRisk",
    "getEnvStatus",
    "getOverlay",
    "getStackChain",
    "getSummary",
    "getTemplate",
    "importBranch",
    "initEnv",
    "listAutoRebaseStatuses",
    "list",
    "listDeleteProgress",
    "listSnapshots",
    "listRebaseSuggestions",
    "listTemplates",
    "listLinearIssuesForLaneSessions",
    "listLinearIssuesForSession",
    "listGitHubIssuesForLaneSessions",
    "listGitHubIssuesForSession",
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
    "resolveBranchDrift",
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
    "reconcileOnFocus",
    "syncLanePr",
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
    "createGithubStack",
    "delete",
    "deleteIntegrationProposal",
    "dismissIntegrationCleanup",
    "draftDescription",
    "getActionRuns",
    "getActionRunsByGithub",
    "getActivity",
    "getActivityByGithub",
    "getWorkflowGraph",
    "getCheckLog",
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
    "listGithubStacks",
    "getIntegrationResolutionState",
    "getMergeContext",
    "getMergeContexts",
    "getMobileGithubDetail",
    "getMobileSnapshot",
    "getPrHealth",
    "getAiSummary",
    "getReviewThreads",
    "getReviewThreadsByGithub",
    "getReviews",
    "getReviewsByGithub",
    "getStatus",
    "ingestGithubWebhook",
    "land",
    "linkToLane",
    "listAll",
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
    "addGithubStackPullRequests",
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
    "preflightCreateLaneFromPrBranch",
    "submitReview",
    "syncGithubStacks",
    "unstackGithubStack",
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
    "resetCodexMemory",
    "terminateCodexBackgroundTerminal",
    "listClaudeOutputStyles",
    "getSessionCapabilities",
    "getSessionSummary",
    "getTurnStatus",
    "getSlashCommands",
    "getTurnFileDiff",
    "getParallelLaunchState",
    "interrupt",
    "interruptWithQueueMode",
    "stopTask",
    "recoverTurn",
    "recoverCodexTurn",
    "resolveUnprocessedMessage",
    "recoverContinuity",
    "restoreCancelledQueue",
    "killDroidWorker",
    "launchCli",
    "launchHeadless",
    "createScheduledWork",
    "listScheduledWork",
    "getScheduledWorkState",
    "listClaudePlugins",
    "listCodexPlugins",
    "listClaudeSessions",
    "listSessions",
    "listSubagents",
    "listPromptStashes",
    "createPromptStash",
    "deletePromptStash",
    "messageSession",
    "modelCatalog",
    "approveToolUse",
    "codexFuzzyFileSearch",
    "fileSearch",
    "listMentionSuggestions",
    "handoffSession",
    "prepareCrossMachineHandoff",
    "validateCrossMachineSource",
    "preflightCrossMachineDestination",
    "fastForwardCrossMachineHandoffLane",
    "acceptCrossMachineHandoff",
    "markCrossMachineHandoff",
    "respondToInput",
    "resolveSmartLinkPreview",
    "reloadClaudePlugins",
    "rewindFiles",
    "saveTempAttachment",
    "copyTempAttachment",
    // The paired desktop's ticket mint for the streamed HTTP upload route.
    // `remoteConnectionService.uploadChatAttachment` calls it by string over
    // `run_ade_action`, so leaving it off this list left remote-paired attach
    // failing on every machine.
    "createAttachmentUpload",
    "sendMessage",
    "readTranscript",
    "readTranscriptPage",
    "setClaudeOutputStyle",
    "setParallelLaunchState",
    "cancelScheduledWork",
    "resumeUsageLimitNow",
    "setScheduledWorkPaused",
    "steer",
    "suggestLaneNameFromPrompt",
    "generateAutoLaneIdentity",
    "unarchiveSession",
    "updateSession",
    "regenerateSessionMetadata",
    "setSpawnKind",
    "dismissSubagentTakeoverPrompt",
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
    "opencodeAuthMethods",
    "opencodeOAuthStart",
    "opencodeOAuthCancel",
    "setOpencodeProviderKey",
    "clearOpencodeProviderKey",
    "refreshModelsDev",
    "piLoginProviders",
    "piLoginStart",
    "piLoginSubmit",
    "piLoginCancel",
    "cursorAuthStatus",
    "cursorAuthLogin",
    "cursorAuthLogout",
    "cursorAuthCancel",
    "listCursorCloudRepositories",
    "listCursorCloudAgents",
    "listCursorCloudRuns",
    "createCursorCloudRun",
    "getCursorCloudLaneSecretNames",
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
    "watchCursorCloudMirror",
    "getCursorCloudFleet",
    "resolveCursorCloudAgentLane",
    "pullCursorCloudAgentIntoLane",
    "stopCursorCloudAgentRun",
  ],
  onboarding: [
    "complete",
    "detectDefaults",
    "getStatus",
    "setDismissed",
  ],
  automation_planner: ["parseNaturalLanguage", "saveDraft", "simulate", "validateDraft"],
  cto_state: [
    "completeOnboardingStep",
    "dismissOnboarding",
    "getAttention",
    "getIdentity",
    "getOnboardingState",
    "getSessionLogs",
    "getSnapshot",
    "previewSystemPrompt",
    "resetOnboarding",
    "runProjectScan",
    "updateIdentity",
  ],
  cto_memory: ["getSnapshot", "searchMemory", "updateMemory", "recordDiscovery"],
  session: [
    "backfillDeltas",
    "clearWokeMarker",
    "deleteSession",
    "get",
    "getDelta",
    "getLifecycleSettings",
    "getSettleResidue",
    "list",
    "moveOnBoard",
    "readTranscriptTail",
    "requestSessionAttention",
    "setSessionStatusNote",
    "setSettleOverride",
    "undoBoardMove",
    "snoozeSession",
    "snoozeSessions",
    "settleSession",
    "settleSessions",
    "updateLifecycleSettings",
    "unsettleSession",
    "unsettleSessions",
    "updateMeta",
    "wakeSession",
    "wakeSessions",
  ],
  operation: ["finish", "get", "list", "start"],
  ade_project: ["clearLocalData", "getSnapshot", "initializeOrRepair", "runIntegrityCheck"],
  project_config: ["confirmTrust", "diffAgainstDisk", "get", "save", "setPrTranscriptGists", "validate"],
  project_secret: ["list", "get", "set", "delete", "previewEnvImport", "importEnv", "exportEnv"],
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
    "getRequestBudget",
    "getStatus",
    "createRepoAutolink",
    "listRepoAutolinks",
    "listRepoCollaborators",
    "listRepoIssues",
    "getIssue",
    "listRepoLabels",
    "pollAppUserDeviceAuth",
    "publishCurrentProject",
    "setToken",
    "startAppUserDeviceAuth",
  ],
  feedback: ["list", "prepareDraft", "submitPreparedDraft"],
  usage: [
    "applyAccountRollups",
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
  storage: ["cleanup", "cleanupPreview", "compressNow", "getSnapshot", "runMaintenanceNow"],
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
  pty: ["create", "dispose", "list", "resize", "resumeSession", "sendToSession", "write"],
  terminal: ["list", "read", "preview", "write", "resize", "signal", "activeForChat", "reattachChatCli"],
  layout: ["get", "set"],
  tiling_tree: ["get", "set"],
  graph_state: ["get", "set"],
  // Read-only for everyone except the desktop that owns the pane:
  // `setActiveTool` is how a desktop renderer publishes which tool it has open
  // so phones and the hosted web client can mirror it.
  work_tools: ["getLaneState", "setActiveTool", "readObservationPreview"],
  // `ingest` is intentionally absent. Proof-drawer entries are created only by
  // the `ingest_computer_use_artifacts` RPC tool and the `ade proof` commands
  // that wrap it, which validate owner claims and the caller's import root.
  computer_use_artifacts: [
    "deleteArtifacts",
    "getOwnerSnapshot",
    "getBackendStatus",
    "listArtifacts",
    "listBrokenArtifacts",
    "pruneBrokenArtifacts",
    "readArtifactPreview",
    "recoverArtifact",
    "updateArtifactReview",
  ],
  ios_simulator: ["getStatus", "claim", "listDevices", "listLaunchTargets", "launch", "attachToChatSession", "shutdown", "screenshot", "getScreenSnapshot", "getInspectorSnapshot", "inspectPoint", "getPreviewCapability", "listPreviewTargets", "resolvePreviewMatch", "ensurePreviewWorkspace", "renderCurrentPreview", "renderPreview", "openPreviewWorkspace", "startStream", "stopStream", "getStreamStatus", "tap", "typeText", "drag", "swipe", "selectPoint", "openDevice", "closeDevice", "getDeviceSession", "getDeviceSettings", "setAppearance", "setContentSize", "setAccessibilityOption", "setLocation", "clearLocation", "setPermission", "sendPushNotification", "openUrl", "relaunchApp", "terminateApp", "uninstallApp", "setStatusBar", "clearStatusBar", "getAppState", "startEventLog", "stopEventLog", "getEventLog", "findElement", "tapElement", "fillElement", "waitForElement", "assertVisible", "captureProofBundle"],
  app_control: ["getStatus", "claim", "launch", "launchInTerminal", "connect", "stop", "focusWindow", "minimizeWindow", "screenshot", "getSnapshot", "inspectPoint", "selectPoint", "click", "typeText", "scroll", "dispatchKey", "listTargets", "attachToTarget", "readTerminal", "writeTerminal", "signalTerminal", "listDrivers", "observe", "agentClick", "agentHover", "agentFill", "agentClear", "agentType", "agentPress", "agentScroll", "agentWait", "getTrace", "windows", "switchWindow"],
  // `acknowledgeRemoteRequest` is not a `BuiltInBrowserService` method: it is
  // served by the runtime daemon itself, so a desktop that took a forwarded
  // `ade browser open` can tell the machine that asked. Absent on a desktop's
  // own service object, where `listAllowedAdeActionNames` filters it out.
  built_in_browser: [
    ...BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
    BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  ],
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
  // No `watchDetail`/`unwatchDetail`: live detail watching pushes updates over a
  // per-sender Electron IPC channel, which has no remote-runtime equivalent, so
  // it stays local IPC only (`IPC.externalSessions{Watch,Unwatch}Detail`).
  // Exposing them here would hand remote callers a snapshot that never updates.
  "external-sessions": ["list", "import", "getDetail"],
};

/* ──────────────────────────────────────────────────────────────────────────
   THE PREDICATES OVER THE TABLES.

   They live with the tables rather than in `registry.ts` for the reason the
   tables do: they are pure functions of the data above, and a caller that only
   needs to ask "may this role call this action?" should not have to load the
   registry's whole service graph — every domain builder, every runtime import —
   to get an answer. The registry re-exports all four, so no call site moved.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * The subset of an account status a non-`cto` caller may see.
 *
 * Account status carries the signed-in identity, which a session-bound agent
 * has no business reading. Kept as a policy function rather than a per-surface
 * filter so the daemon, the registry and the multi-project RPC server all
 * redact the same fields.
 */
export function scopeAccountStatusForRole(
  status: unknown,
  role: AdeActionRole | undefined | null,
): unknown {
  if (callerHasRoleAtLeast(role, "cto")) return status;
  const record = status && typeof status === "object" && !Array.isArray(status)
    ? status as Record<string, unknown>
    : {};
  const source = record.source;
  // sessionState carries no identity — an agent-role caller still needs to
  // tell an expired sign-in from a signed-out machine or an unreadable store.
  const sessionState = record.sessionState;
  return {
    signedIn: record.signedIn === true,
    userId: null,
    email: null,
    name: null,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
    ...(source === "loopback" || source === "device" || source === "env-token" ? { source } : {}),
    ...(sessionState === "active" || sessionState === "signed_out" || sessionState === "expired"
      || sessionState === "unreadable"
      ? { sessionState }
      : {}),
  };
}

/**
 * The allowlisted actions a built domain service actually implements, sorted.
 *
 * Intersected rather than returned straight from the table: a domain's service
 * is assembled from whatever the runtime has, so an allowlisted method can be
 * absent (a feature gate, a missing dependency) and advertising it would hand
 * the caller a name that throws.
 */
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

/**
 * What an `ade-action` automation step may call: allowlisted AND not CTO-only.
 *
 * An automation runs unattended with no human role behind it, so it is held to
 * the agent tier — the CTO gate exists precisely to keep unattended callers out
 * of credential, policy and settle writes.
 */
export function isAutomationAllowedAdeAction(
  domain: AdeActionDomain,
  action: string,
): boolean {
  return isAllowedAdeAction(domain, action) && !isCtoOnlyAdeAction(domain, action);
}
