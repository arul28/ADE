import {
  BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
  BUILT_IN_BROWSER_REPLY_REMOTE_CALL_METHOD,
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
  USER_BROWSER_RUNTIME_METHODS,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import { THREAD_COMMENT_ACTION_NAMES } from "../../../shared/threadComments";
import { CLAUDE_PLUGIN_UI_ACTION_NAMES } from "../../../shared/claudePluginUi";
import { APPLE_AGENT_ACTIONS, APPLE_USER_ONLY_ACTIONS } from "../../../shared/types/iosSimulator";
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

export type AdeActionRole = "cto" | "agent" | "external" | "evaluator";

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
 * The CTO-only actions that change one of the person's settings, each with
 * the Settings card it is changed from (null when there is none). A refused
 * agent is told where the setting is rather than that it lacks a role.
 * `ADE_ACTION_CTO_ONLY` reads these lists, so a write added here is refused.
 */
const USER_SETTING_WRITES = {
  account_settings: { actions: ["set", "remove"], entryId: null },
  provider_instances: {
    actions: [
      "create", "remove", "signOut", "rename", "setDefault", "setAccent", "dismissReplaced",
      "loginStart", "loginSubmitCode", "loginCancel", "setSettings",
    ],
    entryId: "agents.providers",
  },
  keybindings: { actions: ["set"], entryId: null },
  project_config: { actions: ["setPrTranscriptGists"], entryId: "lanes-git.pr-chat-transcripts" },
  keep_awake: { actions: ["setLevel", "migrateLegacyPreference", "fixSystemSleep"], entryId: "general.keep-awake" },
  pty: { actions: ["setDefaultShell"], entryId: "behaviour.terminal-shell" },
  budget: { actions: ["updateConfig"], entryId: "agents.budget" },
  analytics: { actions: ["setEnabled"], entryId: null },
  remote_mcp: {
    actions: ["setEnabled", "setMachineIncluded", "createToken", "updateConnection", "removeConnection"],
    entryId: "ade-mcp.server",
  },
} as const satisfies Partial<Record<AdeActionDomain, { actions: readonly string[]; entryId: string | null }>>;

/**
 * When an action changes one of the person's settings: the card it lives on
 * (`entryId` null when it has none). Null for every other action.
 */
export function userSettingWrite(domain: AdeActionDomain, action: string): { entryId: string | null } | null {
  const write: { actions: readonly string[]; entryId: string | null } | undefined =
    (USER_SETTING_WRITES as Partial<Record<AdeActionDomain, { actions: readonly string[]; entryId: string | null }>>)[domain];
  return write?.actions.includes(action) ? { entryId: write.entryId } : null;
}

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
      // `listMachines` stays CTO-only: it also reconciles this install's
      // machine trust. `showMachine` (`ade machines show`) is deliberately NOT
      // listed — it is a read-only status + recent-Activity view of one machine
      // that chat-role agents use to read a machine the user @-mentioned.
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
  // Keep-awake preferences are machine-wide power policy. The desktop, phone,
  // and direct user clients can change them; session-bound agents cannot.
  keep_awake: { only: ["getSnapshot", ...USER_SETTING_WRITES.keep_awake.actions] },
  // The machine's default shell for the user's own terminals is the user's
  // choice. Agents can read it; only user clients change it.
  pty: { only: [...USER_SETTING_WRITES.pty.actions] },
  // ADE MCP grants an outside app this machine. Every action is also user-only
  // (below), so only the desktop reaches it through the action bus.
  remote_mcp: { allExcept: [] },
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
  // Installing or removing the ADE agent, or changing who runs unrouted
  // delegations, changes a Linear workspace for everyone in it.
  linear_agent: { only: ["startInstall", "uninstall", "updateSettings"] },
  github: { only: ["setToken", "clearToken", "startAppUserDeviceAuth", "pollAppUserDeviceAuth", "clearAppUserAuth"] },
  // Jira credentials are machine-wide and never belong in an agent's hands.
  jira: { only: ["connect", "disconnect"] },
  update: { only: ["quitAndInstall"] },
  // Linear webhook lifecycle mutates account-level state (registers/deletes a
  // webhook against the user's Linear organization), so it stays CTO-only;
  // status/poll/cleanup reads remain open to agents.
  // cancelScheduledCleanup can silently defeat a cleanup policy another
  // automation scheduled, so it is operator-only like the webhook lifecycle.
  automations: { only: ["setWebhookGatewayPublicUrl", "linearIngressSetup", "linearIngressTeardown", "cancelScheduledCleanup"] },
  // Writing or destroying a provider credential is operator work.
  // `acpProviderDiagnostics` can run a provider CLI's doctor, so it is
  // operator-only.
  // `harnessLaunchEnv` returns a routed launch's environment WITH its tokens
  // (it is how `ade harness env` runs a custom provider in the user's own
  // terminal), and `testHarnessRoute` spends the user's key on a live request.
  // Both are operator work, like `project_secret.exportEnv`. `museSettings`
  // opens a Muse host on the user's credential to read or change Muse's own
  // settings, the same tier.
  ai: { only: ["harnessLaunchEnv", "testHarnessRoute", "acpProviderDiagnostics", "museSettings", "museSettingsClose", "storeApiCredential", "removeApiCredential", "updateConfig", "storeApiKey", "deleteApiKey", "opencodeOAuthStart", "opencodeOAuthCancel", "setOpencodeProviderKey", "clearOpencodeProviderKey", "opencodeAccountActivate", "opencodeAccountRename", "opencodeAccountRemove", "opencodeCloudConnect", "refreshModelsDev", "piLoginStart", "piLoginSubmit", "piLoginCancel", "cursorAuthLogin", "cursorAuthLogout", "cursorAuthCancel", "antigravitySignInStart", "antigravitySignInComplete", "antigravitySignInCancel"] },
  budget: { only: USER_SETTING_WRITES.budget.actions },
  // `applyAccountRollups` writes another machine's history into a
  // CRR-replicated table. The desktop app pushes it over the local socket
  // after its own account fan-out; no agent has any reason to call it.
  usage: { only: ["forceRefresh", "refreshHistory", "poll", "start", "stop", "applyAccountRollups", "setModelPriceOverride"] },
  analytics: { only: [...USER_SETTING_WRITES.analytics.actions, "flush"] },
  storage: { only: ["cleanup", "runMaintenanceNow"] },
  // A fix edits the project's data, git links or other tools' config: the
  // person presses it. Agents read the report and offer the fixes.
  project_health: { only: ["fix"] },
  // Restoring brings a lane's worktree and services back up — the CTO's call,
  // not any agent's. Deleting is the person's alone (ADE_ACTION_USER_ONLY).
  archive: { only: ["restore"] },
  search: { only: ["rebuildIndex"] },
  project_secret: { only: ["exportEnv"] },
  account_vault: { only: ["get", "set", "remove"] },
  // The person's settings. What an agent may and may not change is listed in
  // `shared/settingsAgentAccess.ts`; these are the writes behind the "only
  // you" list. Your account's settings (MCP servers, notifications, chat),
  // provider sign-ins, and keyboard shortcuts. Turning on PR chat transcripts
  // publishes your chats as gists. Agents reach the rest of the project config
  // through `project_config.save`, which the RPC server checks key by key
  // (`ownerOnlyProjectConfigChange`).
  account_settings: { only: USER_SETTING_WRITES.account_settings.actions },
  provider_instances: { only: USER_SETTING_WRITES.provider_instances.actions },
  keybindings: { only: USER_SETTING_WRITES.keybindings.actions },
  project_config: { only: USER_SETTING_WRITES.project_config.actions },
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
  /*
   * `startFreshSession` retires the conversation every other CTO surface is
   * talking to and starts a new one. Nothing it touches is destructive — memory,
   * identity and the retired transcript all survive — but deciding that a thread
   * is finished is the operator's call, not an agent's, and an agent that could
   * make it could quietly drop the context it was being supervised with. Listed
   * as `only` because every other method on this domain is a read the whole
   * fleet already depends on.
   */
  cto_state: { only: ["startFreshSession"] },
  // Every settle WRITER is CTO-only on purpose. "Is this work actually done?"
  // is a subjective judgment and agents are unreliable at it, so settlement is
  // reachable only from surfaces that connect at cto role — the desktop
  // renderer's remote-runtime client and the `ade code` TUI, both of which are
  // driven by the user — plus the deterministic PR-merge policy, which never
  // goes through this bridge at all. A session-bound agent CLI authenticates as
  // `agent` and is refused here. Do not add a self-service
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
      // `agent` cannot move its own card and then congratulate
      // itself on being told to.
      "moveOnBoard",
      "undoBoardMove",
    ],
  },
  // DELIBERATE BOUNDARY CHANGE (2026-10-09): drafts used to be CTO-only here.
  // Session-bound agents were denied `listDrafts`/`createDraft`/`deleteDraft`
  // because a draft was private unsent composer state. Drafts are now the
  // backing store for scheduled send, and the product decision is that an
  // agent may arm and manage them on the user's behalf: an agent that schedules
  // a send produces a message the user would otherwise have typed, and the user
  // asked for that. Consequences accepted with the decision:
  //   • an agent can read the user's unsent drafts, so never paste secrets into
  //     a draft you have not sent;
  //   • an agent-armed send is indistinguishable from one the user armed.
  // `armUpdateResume` stays CTO-only: it is machine-wide and spends a real turn
  // on every chat the desktop names. Voice is the user's microphone and a
  // session billed to their ChatGPT plan: an agent must not start, stop, or
  // watch it.
  chat: {
    only: [
      // The desktop's post-update resume arm: machine-wide, and each row it
      // creates spends a real turn. A session-bound agent must not drive it.
      "armUpdateResume",
      // Thread comments are the user's unsent review of an agent's reply. An
      // agent that could write or delete them could edit what the user is
      // about to tell it.
      ...THREAD_COMMENT_ACTION_NAMES,
      // What a mod draws is for the person at the chat. A press runs plugin
      // code on the host; an agent must not press a control on its own chat.
      ...CLAUDE_PLUGIN_UI_ACTION_NAMES,
      "startCodexRealtime",
      "stopCodexRealtime",
      "getCodexRealtimeState",
    ],
  },
  // ── Domain-coverage decisions (deliberately NOT added here) ──
  // The CTO gained curated tools over automation planning, search,
  // usage/budget reads, project config reads, iOS-simulator / app-control /
  // browser reads. None of those became CTO-only, and
  // each omission is a decision, not an oversight:
  //   • automation_planner.* — `automations.saveRule` already carries the same
  //     power (a rule can run commands and spawn agents) and is open to agents.
  //     Gating the planner while the rule writer stays open protects nothing and
  //     would break `ade-action` automation steps, which are filtered through
  //     `isAutomationAllowedAdeAction` and therefore cannot call CTO-only actions.
  //   • ios_simulator / app_control / built_in_browser — device control IS how
  //     agents verify UI work; these are already their normal surface.
  //   • search.query / indexStatus — reads over an index agents already build.
  //     `search.rebuildIndex` stays CTO-only above (it is a privileged rebuild).
  //   • project_config.get and project_secret.list — reads with no secret VALUES
  //     in them. `project_secret.get`/`exportEnv` return values, so the CTO's
  //     generic action tool refuses them (`isSecretBearingAdeAction`), and no
  //     other CTO tool calls either one.
  // Proof lifecycle and ingestion operate on project-scoped persisted bytes.
  // Session-bound agents use the dedicated RPC tools, which derive an owner
  // and filesystem jail from their authenticated chat context.
  // The stream token and the human takeover. `startStream` is the only call
  // that hands out the loopback token, and `takeControl`/`returnControl`/
  // `renewLease` model a person taking the lane's screen — both are viewing
  // clients' business (the desktop renderer, the phone, the hosted web client,
  // all of which connect at cto role), not a session-bound agent's. An agent
  // reads `getStreamStatus`, which is redacted.
  mac_desktop: {
    only: [
      "startStream",
      "stopStream",
      "takeControl",
      "returnControl",
      "renewLease",
      // A person's permission remediation. Restarting the helper and prompting
      // for a grant are the desktop renderer's business, never a session-bound
      // agent's: the agent cannot see the dialog and the prompt is a system
      // modal fired at whoever is at the Mac.
      "recheckPermissions",
      "requestPermission",
      // Windows: a person's admin prompt and their choice to take the private
      // screen from another lane. Neither is a session-bound agent's to make.
      "setupWindows",
      "takeoverWindows",
      "useSharedDesktop",
    ],
  },
  computer_use_artifacts: {
    only: [
      "deleteArtifacts",
      "getOwnerSnapshot",
      // The Proof button on a generated view, and nothing else. It files bytes
      // the desktop already wrote into this project’s artifact store; agents
      // still create proof only through the validated RPC tool.
      "ingestSceneSnapshot",
      "listArtifacts",
      "listBrokenArtifacts",
      "pruneBrokenArtifacts",
      // A paired desktop streaming a proof video. Only the user's own desktop
      // needs it; agents keep the bounded preview read.
      "readArtifactRange",
      "recoverArtifact",
      "updateArtifactReview",
    ],
  },
};

const ROLE_ORDER: Record<AdeActionRole, number> = {
  external: 0,
  evaluator: 1,
  agent: 2,
  cto: 3,
};

/**
 * Actions only the person may take. Allowed on the bus so a user client can
 * call them; refused to agent callers by the RPC server and to automations.
 */
export const ADE_ACTION_USER_ONLY: Partial<Record<AdeActionDomain, readonly string[]>> = {
  ios_simulator: APPLE_USER_ONLY_ACTIONS,
  // ADE never deletes from the archive on its own, and no agent or automation
  // deletes for the person: a delete can take a lane's uncommitted work.
  archive: ["delete"],
  // An agent asking to move a chat or batch must not approve its own request.
  // Only a person's client hosts an MCP App, so only it may pass an app's call on.
  chat: [
    "resolveCrossMachineHandoffApproval",
    "resolveCrossMachineBatchMoveApproval",
    "mcpAppRequest",
    "revokeMcpAppGrant",
  ],
  // Granting an outside AI app this computer is the person's call. `ade mcp`
  // in their own terminal reaches the same service through `remoteMcp.call`.
  remote_mcp: [
    "getStatus",
    "listActivity",
    "setEnabled",
    "setMachineIncluded",
    "createToken",
    "updateConnection",
    "removeConnection",
  ],
};

export function isUserOnlyAdeAction(domain: AdeActionDomain, action: string): boolean {
  return ADE_ACTION_USER_ONLY[domain]?.includes(action) ?? false;
}

/**
 * Actions whose RESULT carries a secret: a credential, a token, an env file,
 * or raw artifact bytes. The CTO's generic action tool (`runMachineAction`)
 * refuses these outright, on its home machine and on any other, because the
 * result would land in the model's transcript. A person reads them in Settings.
 *
 * The table names the known ones; `SECRET_BEARING_ACTION_NAME` catches a
 * method added later under an obvious name, and fails closed.
 */
export const ADE_ACTION_SECRET_BEARING: Partial<Record<AdeActionDomain, readonly string[]>> = {
  account: ["getToken", "createToken"],
  account_vault: ["get"],
  project_secret: ["get", "exportEnv"],
  // A custom provider's launch env, tokens included.
  ai: ["harnessLaunchEnv"],
  // Raw proof bytes, streamed to the user's own desktop.
  computer_use_artifacts: ["readArtifactRange"],
  // Mints the loopback stream token.
  mac_desktop: ["startStream"],
  jira: ["connect"],
  // A token gives an outside AI app this computer.
  remote_mcp: ["createToken"],
  // The clipboard routinely holds passwords and one-time codes from a password
  // manager. Reading it is fine for the person's own agent; a read-only MCP
  // connection must not be able to pull it into a transcript.
  built_in_browser: ["readClipboard"],
};

/**
 * `get…Token`, `export…Env`, and anything naming a secret, a password or a
 * private key. `…SecretNames` lists names only, so it stays reachable.
 */
const SECRET_BEARING_ACTION_NAME =
  /^(?:get|read|reveal|export|create|mint)\w*Tokens?$|^export\w*Env$|Secret(?!Names$)|Password|PrivateKey/;

export function isSecretBearingAdeAction(domain: string, action: string): boolean {
  const name = action.trim();
  if (ADE_ACTION_SECRET_BEARING[domain as AdeActionDomain]?.includes(name)) return true;
  return SECRET_BEARING_ACTION_NAME.test(name);
}

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
    // `ade notify`. Not CTO-only, so agents and automation steps can call it;
    // the relay caps it at 60 an hour per account.
    "sendNotification",
  ],
  keep_awake: ["getSnapshot", "setLevel", "migrateLegacyPreference", "fixSystemSleep"],
  remote_mcp: [
    "getStatus",
    "listActivity",
    "setEnabled",
    "setMachineIncluded",
    "createToken",
    "updateConnection",
    "removeConnection",
  ],
  lane: [
    "archive",
    "acknowledgeDependencyStatus",
    "archiveAndReclaim",
    "attachLinearIssueToSession",
    "attachGitHubIssueToSession",
    "attachJiraIssueToSession",
    "cancelDelete",
    "cancelGitWrite",
    "create",
    "createChild",
    "createFromUnstaged",
    "deferRebaseSuggestion",
    "delete",
    "deleteLeftoverWorktree",
    "deleteTemplate",
    "detachLinearIssueFromSession",
    "detachGitHubIssueFromSession",
    "detachJiraIssueFromSession",
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
    "getDependencyStatus",
    "getDeleteRisk",
    "getLeftoverWorktree",
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
    "listJiraIssuesForLaneSessions",
    "listJiraIssuesForSession",
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
  proxy: [
    "ensureRunning",
    "setDisabled",
    "signIn",
    "signOut",
    "stop",
    "status",
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
    "getCommit",
    "getCommitMessage",
    "isCommitInLaneHistory",
    "getConflictState",
    "getFileHistory",
    "getOpenPrForBranch",
    "getOriginRemote",
    "getUserIdentity",
    "getSyncStatus",
    "getSyncStatuses",
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
  diff: ["getChanges", "getBranchChanges", "getLaneDiffStats", "listLaneDiffStats", "getFileDiff", "getFilePatch"],
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
    "getDetailBundle",
    "getDetailByGithub",
    "getDeployments",
    "getForLane",
    "getFiles",
    "getFilesByGithub",
    "getGithubSnapshot",
    "listGithubFilterOptions",
    "searchGithubPrs",
    "listGithubStacks",
    "getIntegrationResolutionState",
    "getMergeContext",
    "getMergeContexts",
    "getMobileGithubDetail",
    "getMobileSnapshot",
    "getPrHealth",
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
    "setDraft",
    "setAutoMerge",
    "replyToReviewThread",
    "rerunChecks",
    "setLabels",
    "setAssignees",
    "setReviewThreadResolved",
    "simulateIntegration",
    "startIntegrationResolution",
    "preflightCreateLaneFromPrBranch",
    "submitReview",
    "syncGithubStacks",
    "unstackGithubStack",
    "linkChatSession",
    "unlinkChatSession",
    "linkChatStack",
    "listChatSessionsForPr",
    "getStackLinkOffer",
    "setChatWatch",
    "getChatWatches",
    "resolveMedia",
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
    // `ade chat ask --clear`: the agent takes back the hand it raised. Fenced
    // to `agent_explicit` in the service, and scoped to the caller's own chat
    // by the RPC server's chat guard, so it cannot drop a person's hand.
    "clearAsk",
    "createSession",
    "deleteSession",
    "dispatchSteer",
    "editSteer",
    "ensureCtoSession",
    "moveSteer",
    "getAvailableModels",
    "getLaunchDefaults",
    "getClaudeSessionInfo",
    "getClaudeSessionMessages",
    "getChatEventHistory",
    "getChatEventHistoryPage",
    "getContextUsage",
    "getClaudeUsage",
    "getImageDataUrl",
    "getMainTranscript",
    "getSubagentTranscript",
    "setCodexGoal",
    "setCodexGoalStatus",
    "clearCodexGoal",
    "startCodexRealtime",
    "stopCodexRealtime",
    "getCodexRealtimeState",
    "getCodexGoal",
    "resetCodexMemory",
    "terminateCodexBackgroundTerminal",
    "listClaudeOutputStyles",
    "getSessionCapabilities",
    "getSessionSummary",
    "getTurnStatus",
    // The questions/approvals a chat is blocked on, so `ade chat respond` can
    // find the item and its options (`chat.respondToInput` answers it).
    "listPendingInputs",
    "getSlashCommands",
    "getTurnFileDiff",
    "getParallelLaunchState",
    "interrupt",
    "interruptWithQueueMode",
    "stopTask",
    "messageSubagent",
    "controlSubagent",
    "restartSession",
    "waitFor",
    "armWait",
    "listWaits",
    "cancelWait",
    "holdBackgroundWork",
    "recoverTurn",
    "recoverCodexTurn",
    "resolveUnprocessedMessage",
    "recoverContinuity",
    "restoreCancelledQueue",
    "killDroidWorker",
    "launchCli",
    "launchHeadless",
    "startLaunch",
    "getLaunch",
    "listLaunches",
    "cancelLaunch",
    "retryLaunch",
    "startLaunchNow",
    "queueLaunchMessage",
    "completeLaunchClient",
    "createScheduledWork",
    "listScheduledWork",
    "getScheduledWorkState",
    // Update-install resume. The read is open; the arm is CTO-only (see
    // ADE_ACTION_CTO_ONLY.chat) because it spends real turns on every chat the
    // desktop names, and only the desktop's main process should do that.
    "listInterruptedChats",
    "armUpdateResume",
    "listClaudePlugins",
    "listCodexPlugins",
    "listClaudeSessions",
    "listSessions",
    // Tracked `--mode cli` children with their parent lineage: `ade chat list`
    // merges them so an agent can find and poll its CLI children.
    "listCliChildSessions",
    "listSubagents",
    "listDrafts",
    "getDraft",
    "createDraft",
    "updateDraft",
    "deleteDraft",
    "claimDraft",
    "sendDraftNow",
    ...THREAD_COMMENT_ACTION_NAMES,
    ...CLAUDE_PLUGIN_UI_ACTION_NAMES,
    "messageSession",
    "modelCatalog",
    "approveToolUse",
    "codexFuzzyFileSearch",
    "fileSearch",
    "listMentionSuggestions",
    "handoffSession",
    "startSideChat",
    "endSideChat",
    "prepareCrossMachineHandoff",
    "validateCrossMachineSource",
    "preflightCrossMachineDestination",
    "fastForwardCrossMachineHandoffLane",
    "acceptCrossMachineHandoff",
    "importCrossMachineHandoffLane",
    "markCrossMachineHandoff",
    // The brain-owned move. `startCrossMachineHandoff` is open to agents on
    // purpose ("move this chat to my Mac mini"); the RPC server stamps
    // `requestedBy` and relation, and strips permission fields so the move
    // keeps the chat's own settings. Self and descendant moves proceed at any
    // permission level; unrelated moves wait for approval. A batch containing
    // any unrelated chat gets one approval card on its requesting chat.
    // Approval itself is the person's: see ADE_ACTION_USER_ONLY.
    "getCrossMachineHandoffOptions",
    "previewCrossMachineHandoff",
    "startCrossMachineHandoff",
    "cancelCrossMachineHandoff",
    "retryCrossMachineHandoff",
    "resolveCrossMachineHandoffApproval",
    "startCrossMachineBatchMove",
    "getCrossMachineBatchMove",
    "retryCrossMachineBatchMove",
    "resolveCrossMachineBatchMoveApproval",
    "acknowledgeCrossMachineHandoff",
    "respondToInput",
    "dismissPendingInput",
    // MCP Apps. `getMcpApp` reads a stored page. `mcpAppRequest` is the user's
    // alone (ADE_ACTION_USER_ONLY): it runs a tool for an app in a frame, and
    // an agent has its own, permissioned way to call its MCP tools.
    "getMcpApp",
    "mcpAppRequest",
    "listMcpAppGrants",
    "revokeMcpAppGrant",
    "resolveSmartLinkPreview",
    // og:image bytes for a link's hover card; same public-host guard.
    "resolveSmartLinkImage",
    // Sources favicons: a first-party fetch of the icon of a site the chat
    // already visited, bounded and SSRF-guarded (chat/sourceFaviconService.ts).
    "resolveSourceFavicons",
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
    "continueUsageLimitOnAlternate",
    "switchAccount",
    "setScheduledWorkPaused",
    "steer",
    "suggestLaneNameFromPrompt",
    "generateAutoLaneIdentity",
    "unarchiveSession",
    "updateSession",
    "regenerateSessionMetadata",
    "setSpawnKind",
    "setParent",
    "dismissSubagentTakeoverPrompt",
    "warmupModel",
  ],
  keybindings: ["get", "set"],
  ai: [
    "getStatus",
    // The shared Jev helper: a typed question to OpenCode Zen's free decision
    // model, null on any failure. Renderer features on any machine call it.
    "jevDecide",
    "jevStatus",
    "getOpenCodeRuntimeDiagnostics",
    "isOpenCodeInstalled",
    "museBinaryStatus",
    "ensureMuseBinary",
    "pinnedToolStatus",
    "pinnedToolDownload",
    "antigravitySignInStatus",
    "antigravitySignInStart",
    "antigravitySignInComplete",
    "antigravitySignInCancel",
    "museSettings",
    "museSettingsClose",
    "acpProviderDiagnostics",
    "listApiCredentials",
    "getApiCredential",
    "storeApiCredential",
    "removeApiCredential",
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
    "opencodeAccounts",
    "opencodeAccountActivate",
    "opencodeAccountRename",
    "opencodeAccountRemove",
    "opencodeCloudConnect",
    "refreshModelsDev",
    "listHarnessRoutes",
    "testHarnessRoute",
    "harnessLaunchEnv",
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
    "getCursorAgentUsage",
    "resolveCursorCloudAgentLane",
    "pullCursorCloudAgentIntoLane",
    "stopCursorCloudAgentRun",
    "listCloudAgents",
    "openCloudAgent",
    "stopCloudAgent",
    "archiveCloudAgent",
    "launchCloudAgent",
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
    "getAttention",
    "getIdentity",
    "getOnboardingState",
    "getSessionLogs",
    "getSnapshot",
    "getThreadHealth",
    "previewSystemPrompt",
    "runProjectScan",
    "startFreshSession",
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
    "setSessionActivity",
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
  project_config: ["diffAgainstDisk", "get", "save", "setPrTranscriptGists", "validate"],
  // `request` asks the person through the private secret card; it returns the
  // outcome only, never the value, so it is not secret-bearing.
  project_secret: ["list", "get", "set", "delete", "previewEnvImport", "importEnv", "exportEnv", "pullFromAccount", "request"],
  // Reads and writes of the user's own account-scoped settings. No secret
  // values pass through here — the vault is a separate domain with its own
  // approval rules, precisely so "change my theme" and "read my API key"
  // cannot share a permission.
  account_settings: ["list", "deletedKeys", "get", "set", "remove", "sync"],
  // `list` reports names and readability, never values, which is why it sits
  // beside the harmless actions. `get` returns a credential and is gated below
  // for the same reason `project_secret.exportEnv` is.
  account_vault: ["list", "get", "set", "remove", "sync", "pendingKeys"],
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
  linear_agent: [
    "getInstallSession",
    "getOverview",
    "registerMember",
    "startInstall",
    "uninstall",
    "unregisterMember",
    "updateSettings",
  ],
  linear_issue_tracker: [
    "addIssueLabel",
    "addLabel",
    "cancelIssue",
    "countIssues",
    "createComment",
    "createFollowUpIssue",
    "createIssue",
    "createIssueRelation",
    "createProjectUpdate",
    "getIssueCreateOptions",
    "listProjectMilestones",
    "uploadFile",
    "fetchIssueById",
    "fetchIssuesByIds",
    "fetchIssueComments",
    "graphql",
    "getIssuePickerData",
    "getConnectionStatus",
    "getQuickView",
    "getStatus",
    "getWorkflowCatalog",
    "listCustomViews",
    "listLabels",
    "listIssues",
    "listNotifications",
    "listProjects",
    "markNotification",
    "listWorkflowStates",
    "listUsers",
    "removeIssueLabel",
    "searchIssues",
    "updateComment",
    "updateIssue",
    "updateIssueAssignee",
    "updateIssuePriority",
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
    "isRepoStarred",
    "createRepoAutolink",
    "listRepoAutolinks",
    "listRepoCollaborators",
    "listRepoIssues",
    "getIssue",
    "getRepoIssueSummary",
    "listRepoIssueList",
    "getIssueWriteAccess",
    "createIssue",
    "listIssueTemplates",
    "listIssueTypes",
    "linkSubIssue",
    "updateIssue",
    "commentOnIssue",
    "listRepoMilestones",
    "listIssueComments",
    "listRepoLabels",
    "pollAppUserDeviceAuth",
    "publishCurrentProject",
    "setToken",
    "startAppUserDeviceAuth",
  ],
  jira: [
    "getConnectionStatus",
    "connect",
    "disconnect",
    "listProjects",
    "listIssues",
    "getIssue",
    "listComments",
    "addComment",
    "updateIssue",
    "listTransitions",
    "transitionIssue",
    "listAssignableUsers",
    "listLabels",
    "getCreateMeta",
    "createIssue",
  ],
  issues: ["list", "get", "resolve", "comment", "setState", "create"],
  usage: [
    "applyAccountRollups",
    "consumeResetCredit",
    "forceRefresh",
    "getAdeUsageStats",
    "getCostBreakdown",
    "getModelCatalog",
    "getModelDetail",
    "getModelPriceOverrides",
    "getModelRoutes",
    "getModelSheet",
    "getRouterEfficiency",
    "getRouterShadowSummary",
    "getTurnUsageSummary",
    "getUsageLimits",
    "getUsageSnapshot",
    "noteQuotaDemand",
    "refreshHistory",
    "poll",
    "previewModelRoute",
    "refreshModelRegistry",
    "setModelPriceOverride",
    "start",
    "stop",
  ],
  analytics: ["capture", "getStatus", "setEnabled", "flush"],
  storage: ["cleanup", "cleanupPreview", "compressNow", "deletedLaneChatsSummary", "getSnapshot", "laneBuildOutputRemoved", "runMaintenanceNow"],
  project_health: ["fix", "getReport"],
  archive: ["delete", "list", "restore", "summary"],
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
  pty: [
    "create",
    "dispose",
    "getShellSettings",
    "list",
    "resize",
    "resumeSession",
    "sendToSession",
    "setDefaultShell",
    "write",
  ],
  terminal: [
    "list", "read", "preview", "write", "resize", "signal", "activeForChat", "reattachChatCli",
    // A chat's terminal watches: an agent arms one for itself (`ade terminal
    // watch`), and a person stops it from the chat's pane on any machine.
    "watch", "unwatch", "listWatches",
  ],
  layout: ["get", "set"],
  tiling_tree: ["get", "set"],
  // Read-only for everyone except the desktop that owns the pane:
  // `setActiveTool` is how a desktop renderer publishes which tool it has open
  // so phones and the hosted web client can mirror it. `show` is an agent
  // asking that desktop to put a surface of its own chat on screen, and
  // `acknowledgeShow` is the desktop's answer (user clients only).
  // `listDevServers` and `probePort` let a Browser on another machine see this
  // machine's dev servers; both only read. `stopDevServer` stops one a chat's
  // agent started, re-checked against the process on the port; an agent is
  // pinned to its own chat.
  work_tools: [
    "getLaneState",
    "setActiveTool",
    "readObservationPreview",
    "show",
    "acknowledgeShow",
    "listDevServers",
    "probePort",
    "stopDevServer",
  ],
  // `ingest` is intentionally absent. Proof-drawer entries are created only by
  // the `ingest_computer_use_artifacts` RPC tool and the `ade proof` commands
  // that wrap it, which validate owner claims and the caller's import root.
  // `ingestSceneSnapshot` is not a way around that: it is CTO-only, it takes no
  // bytes, and it accepts only a path already inside this project's artifact
  // store — the desktop Proof button's one route home in a runtime-backed
  // build, where the in-process broker does not exist.
  computer_use_artifacts: [
    "deleteArtifacts",
    "getOwnerSnapshot",
    "getBackendStatus",
    "ingestSceneSnapshot",
    "listArtifacts",
    "listBrokenArtifacts",
    "pruneBrokenArtifacts",
    "readArtifactPreview",
    "readArtifactRange",
    "recoverArtifact",
    "updateArtifactReview",
  ],
  // ONE list, in `shared/types/iosSimulator.ts`, spread here rather than
  // retyped: `getStatus().capabilities` reports it to agents and `apple.invoke`
  // gates the phone/web client on it, and three hand-kept copies is how an
  // action ships reachable on one surface and unnamed on the other two.
  ios_simulator: [...APPLE_AGENT_ACTIONS, ...APPLE_USER_ONLY_ACTIONS],
  /*
   * Mac Desktop: one private macOS screen per lane.
   *
   * Reads (no state change): `getStatus`, `listWindows`, `observe`,
   * `getStreamStatus`. `getStatus` and `getStreamStatus` are deliberately the
   * redacted halves of their service reads — this list is what lands in a
   * durable agent transcript, so an unredacted stream token would be printed
   * into one.
   *
   * Writes: `start`, `stop`, `open`, `claimWindow`, `releaseWindow`,
   * `focusWindow`, `minimizeWindow`, `closeWindow`, `requestSharedDesktop`, `click`,
   * `type`, `press`, `scroll`, `drag`, `wait`, `screenshot`, `startRecording`,
   * `stopRecording`, `requestInputLease`, `present`.
   *
   * `startStream`, `stopStream`, `takeControl`, `returnControl` and
   * `renewLease` are allowlisted but CTO-only below: `startStream` is the one
   * call that mints the loopback stream token, and the takeover/heartbeat
   * trio belongs to a viewing client, not to a session-bound agent.
   *
   * There is no `proof` action on purpose. Proof is filed through the one
   * `ingest_computer_use_artifacts` path, which `ade desktop proof` composes
   * from `screenshot` + `observe`; a `macDesktop.proof` action would be a
   * second ingestion path with no owner validation behind it.
   */
  mac_desktop: [
    "getStatus",
    "recheckPermissions",
    "requestPermission",
    "start",
    "stop",
    "listWindows",
    "open",
    "claimWindow",
    "releaseWindow",
    "quitApp",
    // Windows: a lane's own windows only (the service refuses any other).
    "focusWindow",
    "minimizeWindow",
    "closeWindow",
    // Windows: asks the user in the calling chat; their answer is the consent.
    "requestSharedDesktop",
    "observe",
    "click",
    "type",
    "press",
    "scroll",
    "drag",
    "move",
    "wait",
    "screenshot",
    "startRecording",
    "stopRecording",
    "getStreamStatus",
    "requestInputLease",
    "present",
    "startStream",
    "stopStream",
    "takeControl",
    "returnControl",
    "renewLease",
    "setupWindows",
    "takeoverWindows",
    "useSharedDesktop",
  ],
  app_control: ["getStatus", "claim", "launch", "launchInTerminal", "connect", "stop", "focusWindow", "minimizeWindow", "screenshot", "getSnapshot", "inspectPoint", "selectPoint", "click", "typeText", "scroll", "dispatchKey", "listTargets", "attachToTarget", "readTerminal", "writeTerminal", "signalTerminal", "listDrivers", "observe", "agentClick", "agentHover", "agentFill", "agentClear", "agentType", "agentPress", "agentScroll", "agentWait", "getTrace", "windows", "switchWindow", "startRecording", "stopRecording", "getRecordingStatus", "captureProof", "getLatestFrame"],
  // `acknowledgeRemoteRequest` is not a `BuiltInBrowserService` method: it is
  // served by the runtime daemon itself, so a desktop that took a forwarded
  // `ade browser open` can tell the machine that asked. Absent on a desktop's
  // own service object, where `listAllowedAdeActionNames` filters it out.
  built_in_browser: [
    ...BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
    BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD,
    // The answer to a command this machine sent to the desktop its user sits
    // at (`built_in_browser_remote_call`). Runtime-served, like the ack above.
    BUILT_IN_BROWSER_REPLY_REMOTE_CALL_METHOD,
    // `ade browser attach` / `detach`: also runtime-served, so a desktop's own
    // service object lacks them too.
    ...USER_BROWSER_RUNTIME_METHODS,
  ],
  automations: [
    "list",
    "get",
    "saveRule",
    "deleteRule",
    "toggleRule",
    "triggerManually",
    "planTest",
    "runTest",
    "cleanUpTestRun",
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
    // Webhook URLs: an agent that builds a webhook automation needs the URL to
    // hand back, and the log to check its work. `saveRule` (already open)
    // carries more power than any of these.
    "webhookCreateEndpoint",
    "webhookGetEndpoint",
    "webhookRotateEndpoint",
    "webhookListDeliveries",
    "webhookGetDelivery",
    "webhookReplayDelivery",
    "webhookSendTest",
    "webhookCreateAutomation",
    "webhookList",
    "webhookRetire",
  ],
  issue: [
    "addComment",
    "setLabels",
    "close",
    "reopen",
    "assign",
    "setTitle",
  ],
  search: ["query", "indexStatus", "rebuildIndex"],
  // No `watchDetail`/`unwatchDetail`: live detail watching pushes updates over a
  // per-sender Electron IPC channel, which has no remote-runtime equivalent, so
  // it stays local IPC only (`IPC.externalSessions{Watch,Unwatch}Detail`).
  // Exposing them here would hand remote callers a snapshot that never updates.
  "external-sessions": ["list", "import", "getDetail"],
  /*
   * Reachable on the action bus; every write is CTO-only (`USER_SETTING_WRITES`).
   *
   * A provider instance is a label plus a machine-local config DIRECTORY —
   * `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. The store never reads, writes, copies
   * or returns a token: the provider's own CLI writes its credentials inside
   * that directory, and `loginCommand` only hands back the argv and the one env
   * var that points the CLI at it.
   *
   * Agents may still see accounts and use one (`list`, `loginStatus`,
   * `loginCommand`, `refresh`, `getSettings`). Creating, removing, signing in or
   * out, renaming and re-pointing the default are the user's: sign-ins are on
   * the "only you" list (`shared/settingsAgentAccess.ts`). This reverses the
   * earlier decision that agents manage accounts end to end; the owner chose
   * the two lists on 2026-10-25.
   */
  provider_instances: [
    "list",
    "create",
    "remove",
    "signOut",
    "rename",
    "setDefault",
    "setAccent",
    "dismissReplaced",
    "loginStart",
    "loginStatus",
    "loginSubmitCode",
    "loginCancel",
    "getSettings",
    "setSettings",
    "loginCommand",
    "refresh",
  ],
  /*
   * Project notes are written by agents, on purpose and without prompts: the
   * whole point is that an agent saves what it had to work out. The caps live
   * in the service, and the user sees every note read-only in Settings, which
   * is the check on agent-written text that reaches future prompts.
   */
  project_notes: ["list", "add", "edit", "remove", "renderPromptBlock"],
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
 * What an `ade-action` automation step may call: allowlisted, not CTO-only,
 * and not user-only.
 *
 * An automation runs unattended with no human role behind it, so it is held to
 * the agent tier — the CTO gate exists precisely to keep unattended callers out
 * of credential, policy and settle writes.
 */
export function isAutomationAllowedAdeAction(
  domain: AdeActionDomain,
  action: string,
): boolean {
  return isAllowedAdeAction(domain, action)
    && !isCtoOnlyAdeAction(domain, action)
    && !isUserOnlyAdeAction(domain, action)
    // A config save writes the whole file, owner-only keys included. The RPC
    // server checks an agent's save key by key; an automation step skips that
    // check, so it may not save the config at all.
    && !(domain === "project_config" && action === "save");
}
