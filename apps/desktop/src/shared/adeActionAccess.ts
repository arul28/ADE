/**
 * Whether each ADE action only reads, or changes something.
 *
 * Every action in `ADE_ACTION_ALLOWLIST` (main/services/adeActions/actionPolicy)
 * is declared here, once, as `read` or `write`; `actionPolicy.test.ts` fails
 * when the two disagree, so a new action cannot ship undeclared.
 *
 * Two decisions read it. While a project tab is switching, the preload refuses
 * a write, because the project it was meant for is ambiguous, and lets a read
 * go ahead. After a dropped connection, the runtime pools run a call again only
 * when `isReplaySafeAdeAction` says so.
 *
 * Declare by what the action does, not by its name. `lane.portGetLease`
 * creates the lease it cannot find, `automations.webhookGetEndpoint` and
 * `automations.webhookList` register URLs with the relay, and
 * `ai.getCursorAgentUsage` records billed usage, so all four are writes.
 * When unsure, declare `write`: a read declared as a write only fails during a
 * switch, but a write declared as a read can land on the wrong project.
 *
 * `live` marks what only the running brain can answer (`isLiveOnlyAdeAction`):
 * `"all"` for a whole domain, or the named actions.
 */
export type AdeActionAccess = "read" | "write";

type AdeActionAccessTable = Readonly<
  Record<string, {
    readonly read: readonly string[];
    readonly write: readonly string[];
    readonly live?: "all" | readonly string[];
  }>
>;

export const ADE_ACTION_ACCESS: AdeActionAccessTable = {
  account: {
    read: [
      "getToken",
    ],
    write: [
      "startLogin", "pollLogin", "startDeviceLogin", "pollDeviceLogin", "status", "cancelLogin",
      "signOut", "createToken",
    ],
  },
  attention: {
    live: "all",
    read: [
      "getSnapshot", "getPreferences",
    ],
    write: [
      "acknowledge", "reportPresence", "putPreferences", "putMachinePreferences",
      "sendNotification",
    ],
  },
  keep_awake: {
    live: "all",
    read: ["getSnapshot"],
    write: ["setLevel", "migrateLegacyPreference", "fixSystemSleep"],
  },
  remote_mcp: {
    read: ["getStatus", "listActivity"],
    write: ["setEnabled", "setMachineIncluded", "createToken", "updateConnection", "removeConnection"],
  },
  lane_share: {
    read: ["list", "listReceived", "moveList", "moveReceiveStatus", "movePackStatus"],
    write: [
      "create", "updateRights", "revoke", "resendInvite", "leave",
      "moveStart", "moveRespond", "moveCancel", "moveReceivePrepare", "moveReceiveBegin", "moveReceiveChunk", "moveReceiveLand", "moveReceiveCancel", "movePackStart", "movePackChunk", "movePackRelease",
    ],
  },
  lane: {
    live: [
      "proxyAddRoute", "proxyRemoveRoute", "proxyStart", "proxyStop",
      "portAcquire", "portGetLease", "portRecoverOrphans", "portRelease",
    ],
    read: [
      "checkBranchName", "cloudStartBranch", "diagnosticsGetLaneHealth", "diagnosticsGetStatus", "getBranchDrift",
      "getDefaultTemplate", "getNewLaneDefaults", "getDeleteRisk", "getDependencyStatus", "getLeftoverWorktree", "getReclaimRisk",
      "getEnvStatus", "getOverlay", "getSummary", "getTemplate",
      "list", "listDeleteProgress", "listDeletedLanes", "listSnapshots",
      "listTemplates", "listLinearIssuesForLaneSessions",
      "listLinearIssuesForSession", "listGitHubIssuesForLaneSessions",
      "listGitHubIssuesForSession", "oauthDecodeState", "oauthGenerateRedirectUris",
      "listJiraIssuesForLaneSessions", "listJiraIssuesForSession",
      "oauthGetStatus", "oauthListSessions", "portListConflicts", "portListLeases",
      "previewBranchSwitch", "proxyGetPreviewInfo", "proxyGetStatus",
    ],
    write: [
      "acknowledgeDependencyStatus", "archive", "archiveAndReclaim", "attachLinearIssueToSession", "attachGitHubIssueToSession",
      "attachJiraIssueToSession",
      "cancelDelete", "cancelGitWrite", "create", "pushCloudStartBranch",
      "delete", "deleteLeftoverWorktree", "deleteTemplate", "detachLinearIssueFromSession",
      "detachGitHubIssueFromSession", "diagnosticsActivateFallback",
      "detachJiraIssueFromSession",
      "diagnosticsDeactivateFallback", "diagnosticsRunFullCheck", "diagnosticsRunHealthCheck",
      "importBranch", "initEnv",
      "removeDeletedLane", "restoreDeletedLane",
      "linkLinearIssues", "oauthEncodeState", "oauthUpdateConfig", "portAcquire", "portGetLease",
      "portRecoverOrphans", "portRelease", "proxyAddRoute", "proxyRemoveRoute", "proxyStart",
      "proxyStop", "refreshSnapshots", "rebaseAbort", "rebasePush", "rebaseRollback",
      "rebaseStart", "rename", "renameBranch", "resolveBranchDrift", "applyTemplate", "saveTemplate",
      "setDefaultTemplate", "setNewLaneDefaults", "switchBranch", "unarchive", "unlinkLinearIssues",
      "updateAppearance",
    ],
  },
  proxy: {
    live: "all",
    read: [],
    write: [
      "ensureRunning", "setDisabled", "signIn", "signOut", "stop", "status",
    ],
  },
  git: {
    read: [
      "getCommit", "getCommitMessage", "isCommitInLaneHistory", "getConflictState",
      "getFileHistory", "getOpenPrForBranch", "getOriginRemote", "getUserIdentity",
      "getSyncStatus", "getSyncStatuses", "listBranches", "listCommitFiles", "listRecentCommits",
      "listStashes",
    ],
    write: [
      "abortRebase", "checkoutBranch", "cherryPickCommit", "commit", "continueRebase",
      "createTag", "discardFile", "fetch", "mergeAbort", "mergeBaseIn",
      "mergeContinue", "pull", "push", "rebaseAbort", "rebaseContinue", "redoLastHeadChange",
      "resetToCommit", "restoreStagedFile", "revertCommit", "stageAll", "stageFile",
      "stagePaths", "stash", "stashApply", "stashClear", "stashDrop", "stashPop", "stashPush",
      "sync", "undoLastHeadChange", "unstageAll", "unstageFile", "unstagePaths",
    ],
  },
  diff: {
    read: [
      "getChanges", "getBranchChanges", "getLaneDiffStats", "listLaneDiffStats", "getFileDiff",
      "getFilePatch",
    ],
    write: [],
  },
  conflicts: {
    read: [
      "getBatchAssessment", "getLaneStatus", "getRiskMatrix", "listOverlaps", "listProposals",
      "scanRebaseNeeds", "getRebaseNeed",
    ],
    write: [
      "applyProposal", "prepareProposal", "rebaseLane", "requestProposal", "runPrediction",
      "simulateMerge", "undoProposal",
    ],
  },
  pr: {
    read: [
      "getActionRuns", "getActionRunsByGithub", "getActivity",
      "getActivityByGithub", "getWorkflowGraph", "getCheckLog", "getChecks", "getChecksByGithub",
      "getStatusByGithub", "getComments", "getCommentsByGithub", "getCommits",
      "getCommitsByGithub", "getConflictAnalysis", "getDetail", "getDetailBundle",
      "getDetailByGithub", "getDeployments", "getForLane", "getFiles", "getFilesByGithub",
      "getGithubSnapshot", "listGithubFilterOptions", "searchGithubPrs", "listGithubStacks",
      "getMobileGithubDetail", "getMobileSnapshot",
      "getPrHealth", "getReviewThreads", "getReviewThreadsByGithub",
      "searchMentionables", "getRepoReferences",
      "getReviews", "getReviewsByGithub", "getStatus", "listAll",
      "listPrsByLane",
      "listOpenPullRequests", "listSnapshots", "listWithConflicts", "listChatSessionsForPr",
      "getStackLinkOffer", "getChatWatches", "resolveMedia",
    ],
    write: [
      "addComment", "reconcileOnFocus", "syncLanePr",
      "cleanupBranch",
      "closePr", "createFromLane", "createLaneFromPrBranch",
      "createGithubStack", "delete",
      "ingestGithubWebhook", "land", "linkToLane", "postReviewComment",
      "reactToComment", "refresh", "addGithubStackPullRequests",
      "requestReviewers", "resolveReviewThread", "retargetBase", "reopenPr", "setDraft",
      "setAutoMerge", "replyToReviewThread", "rerunChecks", "setLabels", "setAssignees",
      "setReviewThreadResolved",
      "preflightCreateLaneFromPrBranch", "submitReview", "syncGithubStacks",
      "unstackGithubStack", "linkChatSession", "unlinkChatSession", "linkChatStack",
      "setChatWatch", "updateBody", "updateBranch", "updateComment", "updateDescription",
      "updateTitle",
    ],
  },
  tests: {
    live: ["run", "stop"],
    read: [
      "getLogTail", "listRuns", "listSuites",
    ],
    write: [
      "run", "stop",
    ],
  },
  chat: {
    live: "all",
    read: [
      "getAvailableModels", "getLaunchDefaults", "getClaudeSessionInfo",
      "getClaudeSessionMessages", "getChatEventHistory", "getChatEventHistoryPage",
      "getContextUsage", "getClaudeUsage", "getImageDataUrl", "getMainTranscript", "getSubagentTranscript",
      "getCodexRealtimeState", "getCodexGoal", "listClaudeOutputStyles",
      "getSessionCapabilities", "getSessionSummary", "getTurnStatus", "listPendingInputs", "getSlashCommands",
      "getTurnFileDiff", "getParallelLaunchState", "waitFor", "listWaits", "getLaunch", "getChatEvents",
      "listLaunches", "listScheduledWork", "getScheduledWorkState", "listInterruptedChats",
      "listClaudePlugins", "listCodexPlugins", "listClaudeSessions", "listSessions",
      "listCliChildSessions", "listSubagents", "listDrafts", "getDraft", "listThreadComments",
      "getClaudePluginUi", "getMcpApp", "listMcpAppGrants",
      "modelCatalog", "codexFuzzyFileSearch", "fileSearch", "listMentionSuggestions",
      "preflightCrossMachineDestination", "getCrossMachineHandoffOptions",
      "getCrossMachineBatchMove",
      "previewCrossMachineHandoff", "resolveSmartLinkPreview", "resolveSmartLinkImage", "resolveSourceFavicons",
      "readTranscript", "readTranscriptPage", "suggestLaneNameFromPrompt",
      "generateAutoLaneIdentity", "listDeletedChats", "getDeletedChatDetail",
    ],
    write: [
      "archiveSession", "cancelDispatchedSteer", "cancelSteer", "createSession", "deleteSession",
      "reopenDeletedChat", "removeDeletedChats",
      "dispatchSteer", "editSteer", "ensureCtoSession", "moveSteer", "setCodexGoal",
      "setCodexGoalStatus", "clearCodexGoal", "startCodexRealtime", "stopCodexRealtime",
      "resetCodexMemory", "terminateCodexBackgroundTerminal", "interrupt",
      "interruptWithQueueMode", "stopTask", "messageSubagent", "controlSubagent", "restartSession", "armWait", "cancelWait", "armWebhook", "listWebhooks", "cancelWebhook",
      "holdBackgroundWork", "recoverTurn", "recoverCodexTurn", "resolveUnprocessedMessage",
      "recoverContinuity", "restoreCancelledQueue", "killDroidWorker", "launchCli",
      "launchHeadless", "startLaunch", "cancelLaunch", "retryLaunch", "startLaunchNow",
      "queueLaunchMessage", "completeLaunchClient", "createScheduledWork", "armUpdateResume", "releaseChatRuntime",
      "createDraft", "updateDraft", "deleteDraft", "claimDraft", "sendDraftNow",
      "createThreadComment", "updateThreadComment", "deleteThreadComment", "messageSession",
      "typeIntoCli", "actOnClaudePluginUi",
      "approveToolUse", "handoffSession", "startSideChat", "endSideChat", "prepareCrossMachineHandoff",
      "validateCrossMachineSource", "fastForwardCrossMachineHandoffLane",
      "acceptCrossMachineHandoff", "markCrossMachineHandoff", "startCrossMachineHandoff",
      "cancelCrossMachineHandoff", "retryCrossMachineHandoff",
      "resolveCrossMachineHandoffApproval", "acknowledgeCrossMachineHandoff", "respondToInput",
      "clearAsk",
      "startCrossMachineBatchMove", "retryCrossMachineBatchMove", "importCrossMachineHandoffLane",
      "resolveCrossMachineBatchMoveApproval",
      "dismissPendingInput", "reloadClaudePlugins", "rewindFiles", "saveTempAttachment",
      "copyTempAttachment", "createAttachmentUpload", "sendMessage", "setClaudeOutputStyle",
      "setParallelLaunchState", "cancelScheduledWork", "resumeUsageLimitNow",
      "continueUsageLimitOnAlternate", "switchAccount", "setScheduledWorkPaused", "steer",
      "unarchiveSession", "updateSession", "regenerateSessionMetadata", "setSpawnKind", "setParent",
      "dismissSubagentTakeoverPrompt", "warmupModel", "mcpAppRequest", "revokeMcpAppGrant",
    ],
  },
  keybindings: {
    read: [
      "get",
    ],
    write: [
      "set",
    ],
  },
  ai: {
    read: [
      "getStatus", "jevDecide", "jevStatus", "getContinueAfterRestart", "getMachineUpdateTrack", "getOpenCodeRuntimeDiagnostics", "isOpenCodeInstalled", "museBinaryStatus", "pinnedToolStatus", "getProviderContextInventory", "antigravitySignInStatus", "cliLoginStatus", "listApiCredentials",
      "getApiCredential", "listApiKeys", "opencodeAuthMethods", "opencodeAccounts", "listHarnessRoutes",
      "piLoginProviders", "cursorAuthStatus", "listCursorCloudRepositories",
      "listCursorCloudAgents", "listCursorCloudRuns", "getCursorCloudLaneSecretNames",
      "getCursorCloudAgent", "listCursorCloudArtifacts", "getCursorCloudFleet",
      "listCloudAgents",
    ],
    write: [
      "getCursorAgentUsage", "ensureMuseBinary", "pinnedToolDownload", "antigravitySignInStart", "antigravitySignInComplete",
      "antigravitySignInCancel", "cliLoginStart", "cliLoginSubmitCode", "cliLoginCancel",
      "museSettings", "museSettingsClose",
      "acpProviderDiagnostics", "storeApiCredential", "removeApiCredential",
      "verifyApiKeyConnection", "verifyProviderSignIn", "storeApiKey", "deleteApiKey", "updateConfig", "setContinueAfterRestart",
      "opencodeOAuthStart", "opencodeOAuthCancel", "setOpencodeProviderKey",
      "clearOpencodeProviderKey", "opencodeAccountActivate", "opencodeAccountRename",
      "opencodeAccountRemove", "opencodeCloudConnect", "refreshModelsDev", "testHarnessRoute", "harnessLaunchEnv",
      "piLoginStart", "piLoginSubmit", "piLoginCancel", "cursorAuthLogin", "cursorAuthLogout",
      "cursorAuthCancel", "createCursorCloudRun", "archiveCursorCloudAgent",
      "unarchiveCursorCloudAgent", "deleteCursorCloudAgent", "downloadCursorCloudArtifact",
      "cursorCloudStreamRun", "cancelCursorCloudRun", "cursorCloudFollowUp",
      "openCursorCloudChat", "watchCursorCloudMirror", "resolveCursorCloudAgentLane",
      "pullCursorCloudAgentIntoLane", "stopCursorCloudAgentRun", "openCloudAgent",
      "stopCloudAgent", "archiveCloudAgent", "launchCloudAgent",
    ],
  },
  onboarding: {
    read: [
      "detectDefaults", "getStatus",
    ],
    write: [
      "complete", "setDismissed",
    ],
  },
  automation_planner: {
    read: [],
    write: [
      "parseNaturalLanguage", "saveDraft", "simulate", "validateDraft",
    ],
  },
  cto_state: {
    live: "all",
    read: [
      "getAttention", "getIdentity", "getOnboardingState", "getSessionLogs", "getSnapshot",
      "getThreadHealth", "previewSystemPrompt",
    ],
    write: [
      "completeOnboardingStep", "runProjectScan", "startFreshSession", "updateIdentity",
    ],
  },
  cto_memory: {
    read: [
      "getSnapshot", "searchMemory",
    ],
    write: [
      "updateMemory", "recordDiscovery",
    ],
  },
  session: {
    live: "all",
    read: [
      "get", "getDelta", "getLifecycleSettings", "list",
      "readTranscriptTail",
    ],
    write: [
      "backfillDeltas", "clearWokeMarker", "deleteSession", "moveOnBoard",
      "reportCliTurnSignal", "requestSessionAttention", "setSessionActivity", "setSessionStatusNote",
      "setSettleOverride", "undoBoardMove", "snoozeSession", "snoozeSessions", "settleSession",
      "settleSessions", "updateLifecycleSettings", "unsettleSession", "unsettleSessions",
      "updateMeta", "wakeSession", "wakeSessions",
    ],
  },
  operation: {
    read: [
      "get", "list",
    ],
    write: [
      "finish", "start",
    ],
  },
  ade_project: {
    read: [
      "getSnapshot",
    ],
    write: [
      "clearLocalData", "initializeOrRepair", "runIntegrityCheck",
    ],
  },
  project_config: {
    read: [
      "diffAgainstDisk", "get",
    ],
    write: [
      "resolveAccountSettingNotice", "save", "setPrTranscriptGists", "validate",
    ],
  },
  project_secret: {
    read: [
      "list", "get",
    ],
    write: [
      "set", "delete", "previewEnvImport", "importEnv", "exportEnv", "pullFromAccount",
      "request", "exec",
    ],
  },
  // Passwords: agents read summaries (sites, usernames, never a value). The
  // writes and the one value read (`resolveForFill`) are the person's, and
  // `resolveForFill` only for this computer's own desktop app.
  passwords: {
    read: ["status", "activity", "code", "list", "loginsForPage"],
    write: ["saveLogin", "saveSecret", "remove", "importCsv", "sync", "resolveForFill", "setEnabled", "setCloudEnabled", "reset", "requestLogin", "signin", "recordUse"],
  },
  integration_connect: {
    read: ["status"],
    write: ["request"],
  },
  cloud: {
    read: ["access", "status", "list", "hours", "referral", "make_status", "limits", "cloud_sign_in_status", "lane_launch_status"],
    write: [
      "create", "sleep", "wake", "resize", "copy", "move", "delete", "invite_redeem",
      "update", "set_limits", "lane_launch", "lane_launch_cancel", "tier_request",
      "clear_caches",
      "cloud_sign_in_start", "cloud_sign_in_code", "cloud_sign_in_cancel", "cloud_sign_in_save_key", "cloud_sign_in_remove",
      "cloud_sign_in_keep",
    ],
    // Claude's sign-in for new machines is a terminal the brain keeps open.
    live: ["cloud_sign_in_start", "cloud_sign_in_code", "cloud_sign_in_cancel", "cloud_sign_in_keep"],
  },
  mcp_registry: {
    read: ["list", "chatStatus"],
    write: ["request", "remove"],
  },
  account_settings: {
    read: [
      "list", "deletedKeys", "get",
    ],
    write: [
      "set", "remove", "sync",
    ],
  },
  account_vault: {
    read: [
      "list", "get",
    ],
    write: [
      "set", "remove", "sync", "pendingKeys",
    ],
  },
  linear_credentials: {
    read: [
      "getStatus",
    ],
    write: [
      "clearOAuthClientCredentials", "clearToken", "setOAuthClientCredentials", "setOAuthToken",
      "setToken",
    ],
  },
  linear_oauth: {
    read: [
      "getSession",
    ],
    write: [
      "startSession",
    ],
  },
  linear_agent: {
    live: "all",
    read: [
      "getInstallSession", "getOverview",
    ],
    write: [
      "registerMember", "startInstall", "uninstall", "unregisterMember", "updateSettings",
    ],
  },
  linear_issue_tracker: {
    read: [
      "countIssues", "getIssueCreateOptions", "listProjectMilestones", "fetchIssueById",
      "fetchIssueComments", "getIssuePickerData", "getConnectionStatus", "getQuickView",
      "getStatus", "getWorkflowCatalog", "listCustomViews", "listLabels", "listIssues",
      "listNotifications", "listProjects", "listWorkflowStates", "listUsers", "searchIssues",
    ],
    write: [
      "addIssueLabel", "addLabel", "cancelIssue", "createComment", "createFollowUpIssue",
      "createIssue", "createIssueRelation", "createProjectUpdate", "uploadFile",
      "fetchIssuesByIds", "graphql", "markNotification", "removeIssueLabel", "updateComment",
      "updateIssue", "updateIssueAssignee", "updateIssuePriority", "updateIssueState",
    ],
  },
  github: {
    read: [
      "getAppInstallationStatus", "getAppUserAuthStatus", "getRepoOrThrow", "getRemoteStatus",
      "getRequestBudget", "getStatus", "isRepoStarred", "listRepoAutolinks", "listRepoCollaborators",
      "listRepoIssues", "getIssue", "getRepoIssueSummary", "listRepoIssueList",
      "getIssueWriteAccess", "listIssueTemplates", "listIssueTypes", "listRepoMilestones",
      "listIssueComments", "listRepoLabels",
    ],
    write: [
      "clearToken", "clearAppUserAuth", "detectRepo", "createRepoAutolink", "createIssue",
      "linkSubIssue", "updateIssue", "commentOnIssue", "pollAppUserDeviceAuth",
      "publishCurrentProject", "setGhAccountSharing", "setToken", "startAppUserDeviceAuth",
    ],
  },
  jira: {
    read: [
      "getConnectionStatus", "listProjects", "listIssues", "getIssue", "listComments",
      "listTransitions", "listAssignableUsers", "listLabels", "getCreateMeta",
    ],
    write: [
      "connect", "disconnect", "addComment", "updateIssue", "transitionIssue", "createIssue",
    ],
  },
  issues: {
    read: ["list", "get", "resolve"],
    write: ["comment", "setState", "create"],
  },
  usage: {
    read: [
      "getAdeUsageStats", "getCostBreakdown", "getModelCatalog", "getModelDetail", "getModelPriceOverrides",
      "getModelRoutes", "getModelSheet", "getRouterEfficiency", "getRouterShadowSummary", "getTurnUsageSummary",
      "getUsageLimits", "getUsageSnapshot",
    ],
    write: [
      "applyAccountRollups", "consumeResetCredit", "forceRefresh", "noteQuotaDemand",
      "refreshHistory", "poll", "previewModelRoute", "refreshModelRegistry",
      "setModelPriceOverride", "start", "stop",
    ],
  },
  analytics: {
    read: [
      "getStatus",
    ],
    write: [
      "capture", "setEnabled", "flush",
    ],
  },
  storage: {
    read: [
      "cleanupPreview", "deletedLaneChatsSummary", "getSnapshot", "laneBuildOutputRemoved",
    ],
    write: [
      "cleanup", "compressNow", "runMaintenanceNow",
    ],
  },
  project_health: {
    read: [
      "getReport",
    ],
    write: [
      "fix",
    ],
  },
  archive: {
    read: [
      "list", "summary",
    ],
    write: [
      "delete", "restore",
    ],
  },
  budget: {
    read: [
      "checkBudget", "getConfig", "getCumulativeUsage",
    ],
    write: [
      "recordUsage", "updateConfig",
    ],
  },
  update: {
    read: [
      "getSnapshot",
    ],
    write: [
      "checkForUpdates", "dismissInstalledNotice", "quitAndInstall",
    ],
  },
  file: {
    read: [
      "blame", "listTree", "listTreeChildren", "listWorkspaces", "quickOpen", "readFile",
      "readFileRange", "searchText",
    ],
    write: [
      "createDirectory", "createFile", "deletePath", "refreshGitDecorations", "rename",
      "stopWatching", "watchWorkspace", "writeTextAtomic", "writeWorkspaceText",
    ],
  },
  pty: {
    live: "all",
    read: [
      "list", "getShellSettings",
    ],
    write: [
      "create", "dispose", "resize", "resumeSession", "sendToSession", "write", "setDefaultShell",
    ],
  },
  terminal: {
    live: "all",
    read: [
      "list", "read", "preview", "activeForChat", "listWatches",
    ],
    write: [
      "write", "resize", "signal", "reattachChatCli", "watch", "unwatch",
    ],
  },
  layout: {
    read: [
      "get",
    ],
    write: [
      "set",
    ],
  },
  tiling_tree: {
    read: [
      "get",
    ],
    write: [
      "set",
    ],
  },
  remote_work: {
    live: "all",
    read: [
      "list",
    ],
    write: [
      "delete",
    ],
  },
  machine_stats: {
    live: "all",
    read: ["get"],
    write: [],
  },
  work_tools: {
    live: "all",
    read: [
      "getLaneState", "readObservationPreview", "listDevServers", "probePort", "noteWatching",
      "readBrowserTabFrame",
    ],
    write: [
      "setActiveTool", "show", "acknowledgeShow", "stopDevServer", "sendBrowserTabInput",
    ],
  },
  computer_use_artifacts: {
    read: [
      "getOwnerSnapshot", "getBackendStatus", "listArtifacts", "listBrokenArtifacts",
      "readArtifactPreview", "readArtifactRange",
    ],
    write: [
      "deleteArtifacts", "ingestSceneSnapshot", "pruneBrokenArtifacts", "recoverArtifact",
      "updateArtifactReview",
    ],
  },
  ios_simulator: {
    live: "all",
    read: [
      "getStatus", "listDevices", "listLaunchTargets", "deviceList", "getStreamStatus",
      "getAppState", "getForegroundApp", "getScreenSnapshot", "getInspectorSnapshot",
      "getDeviceSettings", "getEventLog", "recordList", "recordingsTotalBytes",
      "getPreviewCapability", "listPreviewTargets", "resolvePreviewMatch", "getDeviceSession",
      "runtimeList", "getPosture", "getDuoModel", "deviceLeaseStatus", "getAutoRecord",
    ],
    write: [
      "claim", "attachToChatSession", "deviceLease", "deviceLeaseRelease", "deviceCreate", "deviceAttach", "deviceStart",
      "deviceStop", "deviceDetach", "devicePromote", "deviceDelete", "deviceCleanup", "runTests", "startStream",
      "stopStream", "frame", "launch", "relaunchApp", "terminateApp", "uninstallApp", "openUrl",
      "tap", "longPress", "typeText", "pressKey", "drag", "swipe", "scroll", "pressButton", "rotate", "setPosture", "duoAppStoreScreenshots", "addDuoSkill", "attachRenderProof", "requestRender", "renderAck", "renderComplete", "selectPoint",
      "inspectPoint", "findElement", "tapElement", "fillElement", "waitForElement",
      "assertVisible", "setAppearance", "setContentSize", "setAccessibilityOption",
      "setLocation", "clearLocation", "setPermission", "sendPushNotification", "setStatusBar",
      "clearStatusBar", "startEventLog", "stopEventLog", "screenshot", "captureProofBundle",
      "recordStart", "recordStop", "recordDelete", "ensurePreviewWorkspace",
      "renderCurrentPreview", "renderPreview", "openPreviewWorkspace", "shutdown", "openDevice",
      "closeDevice", "deviceDeleteInstalled", "runtimeInstall", "runtimeInstallCancel",
      "runtimeDelete", "runtimePrune", "xcodeRunFirstLaunch", "installApp", "setAutoRecord", "windowLayout",
    ],
  },
  mac_desktop: {
    live: "all",
    read: [
      "getStatus", "listWindows", "getStreamStatus",
    ],
    write: [
      "recheckPermissions", "requestPermission", "start", "stop", "open", "claimWindow",
      "releaseWindow", "quitApp", "focusWindow", "minimizeWindow", "closeWindow",
      "requestSharedDesktop", "observe", "click", "type", "press", "scroll", "drag", "move",
      "wait", "screenshot", "startRecording", "stopRecording", "requestInputLease", "present",
      "startStream", "stopStream", "takeControl", "returnControl", "renewLease", "setupWindows",
      "takeoverWindows", "useSharedDesktop",
    ],
  },
  android_emulator: {
    live: "all",
    read: [
      "getStatus", "listDevices", "getStreamStatus",
      // P1 agent suite: reads that change nothing on the device.
      "listApps", "getScreenSnapshot", "findElement", "waitForElement", "assertVisible",
      "readLog", "recordList", "deviceLeaseStatus", "getDeviceSettings",
      // P3 fold and the Compose preview list.
      "getPosture", "listComposePreviews",
      // P1 setup: the plan and the install's progress.
      "getSdkSetupPlan", "getSdkInstallState",
      // P3: the system image list.
      "listSystemImages",
      // Rec: the lane's auto-record switch and the machine preferences.
      "getAutoRecord", "getMachinePreferences",
      // Parity: an app's state and the app in front.
      "getAppState", "getForegroundApp",
    ],
    write: [
      "createDevice", "attachDevice", "start", "stop", "setKeepRunning", "releaseDevice", "deleteDevice",
      // Extra devices: one of the lane's extras becomes its device.
      "devicePromote",
      "startStream", "stopStream", "sendTouch", "tap", "swipe", "sendKey", "sendText",
      "rotate", "screenshot",
      // P1 look.
      "setDeviceColor", "requestRender", "renderAck", "renderComplete", "attachRenderProof",
      // P1 agent suite.
      "installApp", "launchApp", "terminateApp", "uninstallApp", "openUrl", "longPress", "drag",
      "scroll", "tapElement", "fillElement", "recordStart", "recordStop", "recordDelete",
      "deviceLease", "deviceLeaseRelease", "setLocation", "setAppearance", "setPermission",
      "captureProofBundle", "setDeviceSetting",
      // P3 fold and Compose previews (a render writes images and files proof).
      "setPosture", "renderComposePreviews",
      // Rec: the lane's auto-record switch; the machine preferences (user-only).
      "setAutoRecord", "setMachinePreferences",
      // P1 setup (user-only: the licences and the SDK folder are the person's).
      "installSdk", "cancelSdkInstall", "setSdkPath",
      // P3: system images (user-only, as the SDK install) and instrumentation tests.
      "installSystemImage", "removeSystemImage", "runInstrumentationTests",
      // Parity: keys, relaunch, one frame, Inspect at a point, the cleanup pass (Apple files them under write too).
      "pressKey", "relaunchApp", "frame", "inspectPoint", "selectPoint", "deviceCleanup",
      // Parity (device track): status bar, Clear location, Play Store screenshots (files proof), windows.
      "setStatusBar", "clearStatusBar", "clearLocation", "storeScreenshots", "windowLayout",
    ],
  },
  app_control: {
    live: "all",
    read: [
      "getStatus", "getSnapshot", "listTargets", "readTerminal", "listDrivers", "getTrace",
      "getRecordingStatus", "getLatestFrame",
    ],
    write: [
      "claim", "launch", "launchInTerminal", "connect", "stop", "focusWindow", "minimizeWindow",
      "screenshot", "inspectPoint", "selectPoint", "click", "typeText", "scroll", "dispatchKey",
      "attachToTarget", "writeTerminal", "signalTerminal", "observe", "agentClick", "agentHover",
      "agentFill", "agentClear", "agentType", "agentPress", "agentScroll", "agentWait",
      "windows", "switchWindow", "startRecording", "stopRecording", "captureProof",
    ],
  },
  built_in_browser: {
    live: "all",
    read: [
      "getStatus", "getDevServers", "listSessions", "getTrace", "readText", "getNetworkLog",
      "listDownloads", "waitForDownload", "readClipboard",
    ],
    write: [
      "requestOriginAccess", "claim", "startHandoff", "waitForHandoff", "startSession",
      "endSession", "showPanel", "setBounds", "navigate", "createTab", "switchTab", "closeTab",
      "reload", "goBack", "goForward", "stop", "observe", "click", "typeText", "dispatchKey",
      "scroll", "fill", "signin", "clear", "wait", "startInspect", "stopInspect", "captureScreenshot",
      "selectPoint", "selectCurrent", "clearSelection", "setEmulation", "setZoom", "findInPage",
      "stopFindInPage", "setDevTools", "setNetworkLogging", "exportHar", "hover", "drag",
      "selectOption", "uploadFile", "dropFiles", "paste", "writeClipboard", "startRecording", "stopRecording", "noteDemoStep",
      "acknowledgeRemoteRequest", "replyRemoteCall", "attachUserBrowser", "detachUserBrowser",
    ],
  },
  automations: {
    live: [
      "saveRule", "deleteRule", "toggleRule", "setRunOn", "triggerManually", "planTest", "runTest", "cleanUpTestRun",
      "startIngress", "cancelScheduledCleanup", "linearIngressSetup", "linearIngressTeardown",
      "linearIngressPollNow", "webhookCreateEndpoint", "webhookRotateEndpoint", "webhookReplayDelivery",
      "webhookSendTest", "webhookCreateAutomation", "webhookRetire",
    ],
    read: [
      "list", "get", "getHistory", "listRuns", "getRunDetail", "getIngressStatus",
      "listIngressEvents", "listScheduledCleanups", "linearIngressGetStatus",
      "webhookListDeliveries", "webhookGetDelivery",
    ],
    write: [
      "webhookList",
      "saveRule", "deleteRule", "toggleRule", "setRunOn", "triggerManually", "planTest", "runTest",
      "cleanUpTestRun", "startIngress", "refreshWebhookGatewayStatus",
      "setWebhookGatewayPublicUrl", "cancelScheduledCleanup", "linearIngressSetup",
      "linearIngressTeardown", "linearIngressPollNow", "webhookCreateEndpoint",
      "webhookGetEndpoint", "webhookRotateEndpoint", "webhookReplayDelivery", "webhookSendTest",
      "webhookCreateAutomation", "webhookRetire",
    ],
  },
  issue: {
    read: [],
    write: [
      "addComment", "setLabels", "close", "reopen", "assign", "setTitle",
    ],
  },
  search: {
    read: [
      "query", "indexStatus",
    ],
    write: [
      "rebuildIndex",
    ],
  },
  "external-sessions": {
    read: [
      "list", "getDetail",
    ],
    write: [
      "import",
    ],
  },
  provider_instances: {
    read: [
      "list", "loginStatus", "getSettings",
    ],
    write: [
      "create", "remove", "signOut", "rename", "setDefault", "setAccent", "dismissReplaced", "loginStart",
      "loginSubmitCode", "loginCancel", "setSettings", "loginCommand", "refresh",
    ],
  },
  provider_logins: {
    read: ["status"],
    write: ["captureNow", "allowKeychain", "allowGitHubCli", "use", "setCloud", "setCloudAll", "setCloudBalance", "remove"],
  },
};

const accessByAction = new Map<string, AdeActionAccess>();
const liveDomains = new Set<string>();
const liveActions = new Set<string>();
for (const [domain, declared] of Object.entries(ADE_ACTION_ACCESS)) {
  for (const action of declared.read) accessByAction.set(`${domain}.${action}`, "read");
  for (const action of declared.write) accessByAction.set(`${domain}.${action}`, "write");
  if (declared.live === "all") liveDomains.add(domain);
  else for (const action of declared.live ?? []) liveActions.add(`${domain}.${action}`);
}

/** The declared access, or null for an action this table does not know. */
export function adeActionAccess(domain: string, action: string): AdeActionAccess | null {
  return accessByAction.get(`${domain}.${action}`) ?? null;
}

/**
 * Actions that only the ADE desktop app on the computer that runs them may
 * call, never a desktop driving this computer from another one: the action
 * acts on what is in front of the person (an OS keyring or a prompt on this screen).
 * Each one is also user-only (`ADE_ACTION_USER_ONLY` in actionPolicy).
 * The value is the refusal the person sees, the same in the preload and in
 * the brain.
 */
export const ADE_ACTION_THIS_DESKTOP_ONLY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  passwords: {
    resolveForFill: "Saved logins are filled by ADE on the computer whose browser shows the page.",
  },
  provider_logins: {
    allowKeychain: "Run this on that computer. ADE reads a computer's OS keyring only on the computer you are using.",
  },
};

/** The refusal for a caller that is not this computer's own desktop app, or null when any user client may call it. */
export function thisDesktopOnlyRefusal(domain: string, action: string): string | null {
  return ADE_ACTION_THIS_DESKTOP_ONLY[domain]?.[action] ?? null;
}

/**
 * Actions that are this-desktop-only for some inputs: turning Copilot's GitHub
 * CLI copy on runs `gh`, which can show a keychain or keyring prompt on the
 * computer that runs it, so only that computer's desktop may turn it on.
 * Turning it off shows nothing, so any of the person's desktops may (pinned
 * to that computer). Every input that is not plainly "off" is refused.
 */
const ADE_ACTION_THIS_DESKTOP_ONLY_FOR_INPUT: Readonly<Record<string, Readonly<Record<string, { refusal: string; allows: (input: unknown) => boolean }>>>> = {
  provider_logins: {
    allowGitHubCli: {
      refusal: "Turn this on at that computer. The GitHub CLI can ask there to unlock its keychain, so ADE reads it only on the computer you are using.",
      allows: (input) => Boolean(input) && typeof input === "object" && (input as { on?: unknown }).on === false,
    },
  },
};

/**
 * `thisDesktopOnlyRefusal` for one call, with its input: also refuses the
 * inputs `ADE_ACTION_THIS_DESKTOP_ONLY_FOR_INPUT` keeps for this desktop.
 */
export function thisDesktopOnlyRefusalFor(domain: string, action: string, input: unknown): string | null {
  const fixed = thisDesktopOnlyRefusal(domain, action);
  if (fixed) return fixed;
  const rule = ADE_ACTION_THIS_DESKTOP_ONLY_FOR_INPUT[domain]?.[action];
  return rule && !rule.allows(input) ? rule.refusal : null;
}

/**
 * Whether only the running brain can answer this action.
 *
 * A runtime that is not the brain (the CLI's in-process runtime when no brain
 * answers) is right for project state on disk: lanes, git, PRs, settings. It
 * is wrong for state the brain holds. Its chat service is a stub that mints
 * ids and never runs a turn; its terminals, devices, browsers and schedules
 * die with the command. So whole domains are live (chats, sessions,
 * terminals, devices), and in domains whose reads work from disk the actions
 * that change brain-held state are: scheduled automations and their ingress,
 * test runs, lane proxies and port leases.
 */
export function isLiveOnlyAdeAction(domain: string, action: string): boolean {
  return liveDomains.has(domain) || liveActions.has(`${domain}.${action}`);
}

// Writes that are idempotent, so a call whose answer was lost to a dropped
// connection may run again: they prepare or record a state that a second run
// leaves as it was.
const REPLAY_SAFE_WRITES = new Set<string>([
  "chat.prepareCrossMachineHandoff",
  "chat.validateCrossMachineSource",
  "chat.markCrossMachineHandoff",
  "file.refreshGitDecorations",
  "lane.portGetLease",
  // Single-flighted and throttled on the host; a second run is a no-op sync.
  "pr.reconcileOnFocus",
  // Clears a marker; clearing it again leaves it cleared.
  "session.clearWokeMarker",
  // Publishes which tool a desktop has open; the same publish twice is a no-op.
  "work_tools.setActiveTool",
]);

// Reads that are never run again: they wait on purpose, call a model, or walk
// a whole tree or disk. A replay repeats the whole cost, and a replayable
// remote call gets a 25s budget per attempt, less than these can need.
const UNREPLAYED_READS = new Set<string>([
  "chat.waitFor",
  "chat.suggestLaneNameFromPrompt",
  "chat.generateAutoLaneIdentity",
  "conflicts.scanRebaseNeeds",
  "file.blame",
  "storage.cleanupPreview",
  "project_health.getReport",
]);

/**
 * Writes the app sends on its own (opening a view, window focus), never because
 * a person asked: they don't wake a sleeping cloud computer or keep one awake.
 */
const BACKGROUND_WRITES = new Set<string>([
  "pr.reconcileOnFocus",
  "session.backfillDeltas",
  "session.clearWokeMarker",
  "work_tools.acknowledgeShow",
  "work_tools.setActiveTool",
]);

export function isBackgroundAdeWrite(domain: string, action: string): boolean {
  return BACKGROUND_WRITES.has(`${domain}.${action}`);
}

/**
 * May a runtime call whose connection dropped before it answered run again?
 * Declared reads may, except the costly ones above; writes may not, except the
 * idempotent ones named above. Never a `start`: a replayed start whose first
 * answer was lost runs the work twice.
 */
export function isReplaySafeAdeAction(domain: string, action: string): boolean {
  const key = `${domain}.${action}`;
  if (REPLAY_SAFE_WRITES.has(key)) return true;
  return accessByAction.get(key) === "read" && !UNREPLAYED_READS.has(key);
}
