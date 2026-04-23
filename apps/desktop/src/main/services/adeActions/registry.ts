import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import type {
  AutomationManualTriggerRequest,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationRuleSummary,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
} from "../../../shared/types/automations";
import type { AutomationRule } from "../../../shared/types/config";

export const ADE_ACTION_DOMAIN_NAMES = [
  "lane",
  "git",
  "diff",
  "conflicts",
  "pr",
  "tests",
  "chat",
  "keybindings",
  "onboarding",
  "automation_planner",
  "mission",
  "orchestrator",
  "orchestrator_core",
  "memory",
  "cto_state",
  "worker_agent",
  "session",
  "operation",
  "project_config",
  "issue_inventory",
  "flow_policy",
  "linear_credentials",
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
  "layout",
  "tiling_tree",
  "graph_state",
  "computer_use_artifacts",
  "automations",
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
  linear_credentials: [
    "setToken",
    "setOAuthToken",
    "setOAuthClientCredentials",
    "clearToken",
    "clearOAuthClientCredentials",
  ],
  github: ["setToken", "clearToken"],
  update: ["quitAndInstall"],
  flow_policy: ["savePolicy", "rollbackRevision"],
  linear_sync: ["runSyncNow", "resolveQueueItem"],
  linear_ingress: ["ensureRelayWebhook"],
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
    "attach",
    "create",
    "createFromUnstaged",
    "delete",
    "getChildren",
    "getStackChain",
    "importBranch",
    "list",
    "listUnregisteredWorktrees",
    "refreshSnapshots",
    "rename",
    "reparent",
    "updateAppearance",
  ],
  git: [
    "abortRebase",
    "checkoutBranch",
    "cherryPickCommit",
    "commit",
    "continueRebase",
    "discardFile",
    "fetch",
    "generateCommitMessage",
    "getCommitMessage",
    "getConflictState",
    "getFileHistory",
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
    "unstageAll",
    "unstageFile",
    "unstagePaths",
  ],
  diff: ["getChanges", "getFileDiff"],
  conflicts: ["getLaneStatus", "listOverlaps", "rebaseLane", "runPrediction"],
  pr: [
    "addComment",
    "aiReviewSummary",
    "cleanupIntegrationWorkflow",
    "createFromLane",
    "createIntegrationLane",
    "createIntegrationPr",
    "createQueuePrs",
    "dismissIntegrationCleanup",
    "draftDescription",
    "getActionRuns",
    "getChecks",
    "getComments",
    "getDetail",
    "getGithubSnapshot",
    "getIntegrationResolutionState",
    "getMobileSnapshot",
    "getPrHealth",
    "getQueueState",
    "getReviewThreads",
    "getReviews",
    "landQueueNext",
    "landStack",
    "landStackEnhanced",
    "linkToLane",
    "listAll",
    "listGroupPrs",
    "listIntegrationProposals",
    "listIntegrationWorkflows",
    "listWithConflicts",
    "postReviewComment",
    "reactToComment",
    "recheckIntegrationStep",
    "refresh",
    "reorderQueuePrs",
    "requestReviewers",
    "setLabels",
    "setReviewThreadResolved",
    "simulateIntegration",
    "startIntegrationResolution",
    "submitReview",
    "updateDescription",
    "updateIntegrationProposal",
    "updateTitle",
  ],
  tests: ["getLogTail", "listRuns", "listSuites", "run", "stop"],
  chat: [
    "createSession",
    "deleteSession",
    "getAvailableModels",
    "getSessionSummary",
    "getSlashCommands",
    "interrupt",
    "listSessions",
    "resumeSession",
    "sendMessage",
  ],
  keybindings: ["get", "set"],
  onboarding: [
    "complete",
    "detectDefaults",
    "getStatus",
    "setDismissed",
  ],
  automation_planner: ["parseNaturalLanguage", "saveDraft", "simulate", "validateDraft"],
  mission: [
    "addIntervention",
    "archive",
    "create",
    "delete",
    "get",
    "list",
    "resolveIntervention",
    "update",
  ],
  orchestrator: [
    "cancelRunGracefully",
    "finalizeRun",
    "getMissionMetrics",
    "getTeamMembers",
    "getThreadMessages",
    "getWorkerStates",
    "listChatThreads",
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
    "getRunGraph",
    "listAttempts",
    "listRetrospectivePatternStats",
    "listRetrospectiveTrends",
    "listRetrospectives",
    "listRuns",
    "listTimeline",
    "pauseRun",
    "resumeRun",
    "skipStep",
    "startReadyAutopilotAttempts",
    "supersedeStep",
    "updateStepDependencies",
    "updateStepMetadata",
  ],
  cto_state: [
    "getIdentity",
    "getSnapshot",
    "updateCoreMemory",
  ],
  worker_agent: [
    "updateCoreMemory",
  ],
  memory: ["addSharedFact", "pinMemory", "searchMemories", "writeMemory"],
  session: ["get", "readTranscriptTail"],
  operation: ["finish", "list", "start"],
  project_config: ["get", "save"],
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
  linear_dispatcher: ["dispatchIssue", "getDashboard", "listEmployees", "listQueue"],
  linear_issue_tracker: ["getStatus", "listIssues"],
  linear_sync: ["getDashboard", "getRunDetail", "listQueue", "resolveQueueItem", "runSyncNow"],
  linear_ingress: ["ensureRelayWebhook", "getStatus", "listRecentEvents"],
  linear_routing: ["simulateRoute"],
  github: ["clearToken", "getRepoOrThrow", "getStatus", "setToken"],
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
    "writeWorkspaceText",
  ],
  process: ["getLogTail", "listDefinitions", "listRuntime", "startAll", "stopAll"],
  pty: ["create", "dispose", "resize", "write"],
  layout: ["get", "set"],
  tiling_tree: ["get", "set"],
  graph_state: ["get", "set"],
  computer_use_artifacts: ["ingest", "listArtifacts"],
  automations: [
    "list",
    "get",
    "saveRule",
    "deleteRule",
    "toggleRule",
    "triggerManually",
    "listRuns",
    "getRunDetail",
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
  listRuns(args?: AutomationRunListArgs): AutomationRun[];
  getRunDetail(args: { runId: string }): Promise<AutomationRunDetail | null>;
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
    listRuns: (args = {}) => automationService.listRuns(args),
    getRunDetail: ({ runId }) => automationService.getRunDetail({ runId }),
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

export function getAdeActionDomainServices(
  runtime: AdeRuntime,
): Partial<Record<AdeActionDomain, OpaqueService | null | undefined>> {
  return {
    lane: toService(runtime.laneService),
    git: toService(runtime.gitService),
    diff: toService(runtime.diffService),
    conflicts: toService(runtime.conflictService),
    pr: toService(runtime.prService),
    tests: toService(runtime.testService),
    chat: toService(runtime.agentChatService),
    keybindings: toService(runtime.keybindingsService),
    onboarding: toService(runtime.onboardingService),
    automation_planner: toService(runtime.automationPlannerService),
    mission: toService(runtime.missionService),
    orchestrator: toService(runtime.aiOrchestratorService),
    orchestrator_core: toService(runtime.orchestratorService),
    memory: toService(runtime.memoryService),
    cto_state: toService(runtime.ctoStateService),
    worker_agent: toService(runtime.workerAgentService),
    session: toService(runtime.sessionService),
    operation: toService(runtime.operationService),
    project_config: toService(runtime.projectConfigService),
    issue_inventory: toService(runtime.issueInventoryService),
    flow_policy: toService(runtime.flowPolicyService),
    linear_credentials: toService(runtime.linearCredentialService),
    linear_dispatcher: toService(runtime.linearDispatcherService),
    linear_issue_tracker: toService(runtime.linearIssueTracker),
    linear_sync: toService(runtime.linearSyncService),
    linear_ingress: toService(runtime.linearIngressService),
    linear_routing: toService(runtime.linearRoutingService),
    github: toService(runtime.githubService),
    feedback: toService(runtime.feedbackReporterService),
    usage: toService(runtime.usageTrackingService),
    budget: toService(runtime.budgetCapService),
    update: toService(runtime.autoUpdateService),
    file: toService(runtime.fileService),
    process: toService(runtime.processService),
    pty: toService(runtime.ptyService),
    layout: toService(buildLayoutDomainService(runtime)),
    tiling_tree: toService(buildTilingTreeDomainService(runtime)),
    graph_state: toService(buildGraphStateDomainService(runtime)),
    computer_use_artifacts: toService(runtime.computerUseArtifactBrokerService),
    automations: toService(buildAutomationsDomainService(runtime)),
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
