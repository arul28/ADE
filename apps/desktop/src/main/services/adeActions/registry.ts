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

export type AdeActionDomain =
  | "lane"
  | "git"
  | "diff"
  | "conflicts"
  | "pr"
  | "tests"
  | "chat"
  | "mission"
  | "orchestrator"
  | "orchestrator_core"
  | "memory"
  | "cto_state"
  | "worker_agent"
  | "session"
  | "operation"
  | "project_config"
  | "issue_inventory"
  | "flow_policy"
  | "linear_dispatcher"
  | "linear_issue_tracker"
  | "linear_sync"
  | "linear_ingress"
  | "linear_routing"
  | "file"
  | "process"
  | "pty"
  | "computer_use_artifacts"
  | "automations"
  | "issue";

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
    "cherryPickCommit",
    "commit",
    "continueRebase",
    "fetch",
    "getCommitMessage",
    "getConflictState",
    "getFileHistory",
    "getSyncStatus",
    "listCommitFiles",
    "mergeAbort",
    "mergeContinue",
    "pull",
    "push",
    "rebaseAbort",
    "rebaseContinue",
    "revertCommit",
    "stash",
    "stagePaths",
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
  memory: ["addSharedFact", "pinMemory", "searchMemories", "writeMemory"],
  session: ["get", "readTranscriptTail"],
  operation: ["finish", "list", "start"],
  project_config: ["get", "save"],
  issue_inventory: [
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
    "savePipelineSettings",
    "syncFromPrData",
  ],
  flow_policy: ["getPolicy", "savePolicy"],
  linear_dispatcher: ["dispatchIssue", "getDashboard", "listEmployees", "listQueue"],
  linear_issue_tracker: ["getStatus", "listIssues"],
  linear_sync: ["getDashboard", "getRunDetail", "listQueue", "resolveQueueItem", "runSyncNow"],
  linear_ingress: ["ensureRelayWebhook", "getStatus", "listRecentEvents"],
  linear_routing: ["simulateRoute"],
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

export function getAdeActionDomainServices(
  runtime: AdeRuntime,
): Partial<Record<AdeActionDomain, Record<string, unknown> | null | undefined>> {
  return {
    lane: runtime.laneService as unknown as Record<string, unknown>,
    git: runtime.gitService as unknown as Record<string, unknown>,
    diff: runtime.diffService as unknown as Record<string, unknown>,
    conflicts: runtime.conflictService as unknown as Record<string, unknown>,
    pr: (runtime.prService ?? null) as unknown as Record<string, unknown> | null,
    tests: runtime.testService as unknown as Record<string, unknown>,
    chat: (runtime.agentChatService ?? null) as unknown as Record<string, unknown> | null,
    mission: runtime.missionService as unknown as Record<string, unknown>,
    orchestrator: runtime.aiOrchestratorService as unknown as Record<string, unknown>,
    orchestrator_core: runtime.orchestratorService as unknown as Record<string, unknown>,
    memory: runtime.memoryService as unknown as Record<string, unknown>,
    cto_state: runtime.ctoStateService as unknown as Record<string, unknown>,
    worker_agent: runtime.workerAgentService as unknown as Record<string, unknown>,
    session: runtime.sessionService as unknown as Record<string, unknown>,
    operation: runtime.operationService as unknown as Record<string, unknown>,
    project_config: runtime.projectConfigService as unknown as Record<string, unknown>,
    issue_inventory: runtime.issueInventoryService as unknown as Record<string, unknown>,
    flow_policy: (runtime.flowPolicyService ?? null) as unknown as Record<string, unknown> | null,
    linear_dispatcher: (runtime.linearDispatcherService ?? null) as unknown as Record<string, unknown> | null,
    linear_issue_tracker: (runtime.linearIssueTracker ?? null) as unknown as Record<string, unknown> | null,
    linear_sync: (runtime.linearSyncService ?? null) as unknown as Record<string, unknown> | null,
    linear_ingress: (runtime.linearIngressService ?? null) as unknown as Record<string, unknown> | null,
    linear_routing: (runtime.linearRoutingService ?? null) as unknown as Record<string, unknown> | null,
    file: (runtime.fileService ?? null) as unknown as Record<string, unknown> | null,
    process: (runtime.processService ?? null) as unknown as Record<string, unknown> | null,
    pty: runtime.ptyService as unknown as Record<string, unknown>,
    computer_use_artifacts: runtime.computerUseArtifactBrokerService as unknown as Record<string, unknown>,
    automations: buildAutomationsDomainService(runtime) as unknown as Record<string, unknown> | null,
    issue: buildIssueDomainService(runtime) as unknown as Record<string, unknown> | null,
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
